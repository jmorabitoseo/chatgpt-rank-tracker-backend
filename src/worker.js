// src/worker.js
require('dotenv').config();

const axios = require('axios');
const OpenAI = require('openai');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mgTransport = require('nodemailer-mailgun-transport');

const {
  pubsub,
  supabase,
  bright,
  pubsubSubscription,
  createOpenAI
} = require('./config');

const {
  analyzeSentiment,
  analyzeSalience,
  countBrandMatches
} = require('./utils/analysis');

// ───────────── SMTP via Mailgun transport ─────────────
const transporter = nodemailer.createTransport(
  mgTransport({
    auth: {
      api_key: process.env.MG_API_KEY,   // Mailgun HTTP API key (key-…)
      domain: process.env.MG_DOMAIN     // your Mailgun domain
    }
  })
);

// ────────────── Helpers ──────────────
function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function retryWithBackoff(fn, maxRetries = 5, label = '') {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err.status === 429 ||
        err.status >= 500 ||
        ['ECONNRESET', 'ETIMEDOUT'].includes(err.code) ||
        err.message.includes('network') ||
        err.message.includes('timeout');
      if (!retryable || i === maxRetries - 1) break;
      const wait = err.status === 429
        ? Math.min(2000 * 2 ** i, 30000)
        : Math.min(1000 * 2 ** i, 10000);
      console.warn(`${label} attempt ${i + 1} failed, retrying in ${wait}ms…`);
      await delay(wait);
    }
  }
  throw new Error(`${label} failed after ${maxRetries} retries: ${lastErr.message}`);
}

// ───────────── Pub/Sub handler ─────────────
const subscription = pubsub.subscription(pubsubSubscription);

subscription.on('message', async message => {
  const { snapshotID, openaiKey, email , openaiModel = 'gpt-4', prompts = [], isNightly = false } =
    JSON.parse(message.data.toString());

  console.log("------ Starting queue process for-----: ", snapshotID);
  // Initialize OpenAI client
  const openai = createOpenAI(openaiKey);

  try {
    // 1) Poll Bright Data snapshot endpoint until we get results (not status)
    let results;
    do {
      await delay(30000);
      const { data } = await axios.get(
        `https://api.brightdata.com/datasets/v3/snapshot/${snapshotID}?format=json`,
        { headers: { Authorization: `Bearer ${bright.key}` } }
      );
      results = data;
      console.log("------ Fetching results for queue process from Bright Data-----: ", snapshotID, results, Array.isArray(results));
      
      // Handle non-array responses (status objects)
      if (!Array.isArray(results)) {
        if (results.status === 'failed') {
          throw new Error(`Bright Data snapshot failed: ${results.message || 'Unknown error'}`);
        } else if (results.status === 'running') {
          console.log(`Snapshot ${snapshotID} still running, will retry in 30s...`);
        } else {
          console.warn(`Unexpected status from Bright Data: ${results.status}`);
        }
      }
    } while (!Array.isArray(results));


    // 3) Process each result sequentially
    for (let bres of results) {
        const job = prompts.find(p =>
          (p.trackingId && p.trackingId === bres.prompt_id) || p.text === bres.prompt
        );
        if (!job) {
          console.warn('No matching job for response:', bres);
          continue;
        }
  
        const answerText = bres.answer_text || bres.answer_text_markdown || '';
        const match = countBrandMatches(job.brandMentions, answerText);
  
        let sentiment = 0, salience = 0;
        if (match.anyMatch) {
          sentiment = await retryWithBackoff(
            () => analyzeSentiment(answerText, job.brandMentions, openai, openaiModel),
            5, `Sentiment for "${job.text}"`
          );
          await delay(300);
          salience = await retryWithBackoff(
            () => analyzeSalience(answerText, job.brandMentions, openai, openaiModel),
            5, `Salience for "${job.text}"`
          );
        }
  
        // 4) Handle tracking_results: update stub for regular jobs, create new entry for nightly jobs
        if (isNightly) {
          console.log("------ Inserting nightly tracking_results entry directly with real data-----: ", snapshotID);
  
          // Create new tracking_results entry directly with real data
          const { error: insertErr } = await supabase
            .from('tracking_results')
            .insert([{
              prompt_id: job.id,
              prompt: job.text,
              project_id: job.projectId,
              user_id: job.userId,
              snapshot_id: snapshotID,
              status: 'fulfilled',
              timestamp: Date.now(),
              is_present: match.anyMatch,
              sentiment,
              salience,
              response: JSON.stringify({answer_text: answerText}),
              brand_mentions: job.brandMentions,
              domain_mentions: job.domainMentions,
              brand_name: String(job.brandMentions),
              source: 'Bright Data (Nightly)',
              mention_count: match.totalMatches
            }]);
  
          if (insertErr) throw insertErr;
        } else {
          // Update existing tracking_results stub (regular user-initiated jobs)
          console.log("------ Updating existing tracking_results entry directly with real data-----: ", snapshotID);
  
          const { error: updateErr } = await supabase
            .from('tracking_results')
            .update({
              snapshot_id: snapshotID,
              status: 'fulfilled',
              timestamp: Date.now(),
              is_present: match.anyMatch,
              sentiment,
              salience,
              response: JSON.stringify({answer_text: answerText}),
              mention_count: match.totalMatches
            })
            .eq('id', job.trackingId);
  
          if (updateErr) throw updateErr;
        }
    }

    // 5) Acknowledge message
    message.ack();
    console.log(`Processed snapshot ${snapshotID}`);

    // 6) Send email notification (skip for nightly jobs)
    if (!isNightly) {
      // Fetch user email
      // const userId = prompts[0]?.userId;
      // const { data: { user }, error: userErr } =
      //   await supabase.auth.admin.getUserById(userId);
      // if (userErr || !user?.email) {
      //   console.warn('Could not fetch user email:', userErr);
      //   return;
      // }

      // Send Mailgun template email
      const templateVars = {
        appUrl: process.env.APP_URL,
        dashboardUrl: `${process.env.APP_URL}/projects/${prompts[0].projectId}`,
        snapshotID,
        status: 'completed',
        unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
        year: new Date().getFullYear(),
        prompts: prompts.map(p => p.text)
      };

      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: email,
        subject: `Your batch ${snapshotID} is complete`,
        template: process.env.MAILGUN_TEMPLATE_NAME,
        'h:X-Mailgun-Variables': JSON.stringify(templateVars)
      });

      console.log(`Notification sent to ${email}`);
    } else {
      console.log(`Nightly job completed for snapshot ${snapshotID} - skipping email notification`);
    }
  } catch (err) {
    console.error('Worker error:', err);

    // mark any stubs as failed (only for regular jobs, not nightly)
    if (!isNightly) {
      try {
        await supabase
          .from('tracking_results')
          .update({ status: 'failed' })
          .eq('snapshot_id', snapshotID);
      } catch (_) { }
    }

    // NACK so Pub/Sub will retry or DLQ
    message.nack();
  }
});

subscription.on('error', err =>
  console.error('Subscription error:', err)
);
