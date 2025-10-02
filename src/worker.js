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
  countBrandMatches,
  countDomainMatches
} = require('./utils/analysis');

const { EnhancedAnalyzer } = require('./utils/EnhancedAnalyzer');

const {
  getBatchPromptAIVolume
} = require('./utils/dataForSeoService');

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
      // console.warn(`${label} attempt ${i + 1} failed, retrying in ${wait}ms…`);
      await delay(wait);
    }
  }
  throw new Error(`${label} failed after ${maxRetries} retries: ${lastErr.message}`);
}

// ───────────── Pub/Sub handler ─────────────
const subscription = pubsub.subscription(pubsubSubscription);

subscription.on('message', async message => {
  const { 
    snapshotID, 
    openaiKey, 
    email, 
    openaiModel = 'gpt-4', 
    prompts = [], 
    isNightly = false,
    jobBatchId = null,
    batchNumber = 0,
    totalBatches = 1,
    userCountry = 'US',
    webSearch = false,
    service
  } = JSON.parse(message.data.toString());

  // Only handle brightdata messages
  if (service && service.toLowerCase() !== 'brightdata') {
    console.log('Skipping non-BrightData message on BrightData worker.');
    message.ack();
    return;
  }

  let actualSnapshotID = snapshotID;

  // console.log(`------ Starting queue process for batch ${batchNumber + 1}/${totalBatches}, job: ${jobBatchId}, snapshot: ${actualSnapshotID || 'will trigger'}`);
  
  // Initialize OpenAI client
  const openai = createOpenAI(openaiKey);

  try {
    // 1) If no snapshotID provided, trigger BrightData first
    if (!actualSnapshotID) {
      // console.log(`Triggering BrightData for batch ${batchNumber + 1}/${totalBatches}...`);
      
      const triggerBody = prompts.map(prompt => ({
        url: 'https://chatgpt.com/',
        prompt: prompt.text,
        country: userCountry,
        web_search: webSearch,
        // additional_prompt: `${webSearch ? 'Please search the web for current information about: ' + prompt.text : ''}`
      }));

      const { data } = await axios.post(
        `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${bright.dataset}`,
        triggerBody,
        { headers: { Authorization: `Bearer ${bright.key}` } }
      );
      
      actualSnapshotID = data.snapshot_id;
      console.log(`BrightData triggered successfully, snapshot: ${actualSnapshotID}`);
    }

    // 2) Poll Bright Data snapshot endpoint until we get results (not status)
    let results;
    do {
      await delay(30000);
      const { data } = await axios.get(
        `https://api.brightdata.com/datasets/v3/snapshot/${actualSnapshotID}?format=json`,
        { headers: { Authorization: `Bearer ${bright.key}` } }
      );
      results = data;
      console.log("------ Fetching results for queue process from Bright Data-----: ", actualSnapshotID);
      
      // Handle non-array responses (status objects)
      if (!Array.isArray(results)) {
        if (results.status === 'failed') {
          throw new Error(`Bright Data snapshot failed: ${results.message || 'Unknown error'}`);
        } else if (results.status === 'running' || results.status === 'building' || results.status === 'pending') {
          console.log(`Snapshot ${actualSnapshotID} still running, will retry in 30s...`);
        } else {
          console.warn(`Unexpected status from Bright Data: ${results.status}`);
        }
      }
    } while (!Array.isArray(results));

    // Validate that we have actual data, not just an empty array
    if (results.length === 0) {
      throw new Error(`BrightData returned empty results array for snapshot ${actualSnapshotID}. This usually indicates a processing failure on their end.`);
    }

    // Validate that we have expected prompts
    const expectedPromptCount = prompts.length;
    if (results.length < expectedPromptCount) {
      console.warn(`BrightData returned ${results.length} results but expected ${expectedPromptCount} prompts for snapshot ${actualSnapshotID}`);
    }

        // 3) Fetch AI volume data for all prompts in this batch (before processing individual results)
    let aiVolumeDataMap = new Map();
    try {
      console.log(`Fetching AI volume data for ${prompts.length} prompts...`);
      const promptTexts = prompts.map(p => p.text);
      const aiVolumeResults = await getBatchPromptAIVolume(promptTexts, userCountry === 'US' ? 2840 : 2840); // Default to US for now
      console.log("----- AI VOL: -------", aiVolumeResults)
      // Map AI volume results back to prompts
      prompts.forEach((prompt, index) => {
        if (aiVolumeResults[index]) {
          aiVolumeDataMap.set(prompt.trackingId, aiVolumeResults[index]);
        }
      });
      
      console.log(`AI volume data fetched for ${aiVolumeDataMap.size} out of ${prompts.length} prompts`);
    } catch (aiVolumeError) {
      console.warn('Failed to fetch AI volume data, continuing without it:', aiVolumeError.message);
      // Continue processing without AI volume data
    }

    // 4) Process each result sequentially and track which prompts were processed
    const processedPromptIds = new Set();
    
    for (let bres of results) {
        const job = prompts.find(p =>
          (p.trackingId && p.trackingId === bres.prompt_id) || p.text === bres.prompt
        );
        if (!job) {
          // console.warn('No matching job for response:', bres);
          continue;
        }

        // Mark this prompt as processed
        processedPromptIds.add(job.trackingId);

        const answerText = bres.answer_text || bres.answer_text_markdown || '';
        
        // Ensure brandMentions is always an array
        let brandMentions = job.brandMentions;
        if (typeof brandMentions === 'string') {
          // Handle case where brandMentions might be a single string
          brandMentions = [brandMentions];
        } else if (!Array.isArray(brandMentions)) {
          // Handle case where brandMentions might be null, undefined, or other type
          // console.warn('Invalid brandMentions format:', typeof brandMentions, brandMentions);
          brandMentions = [];
        }
        
        const match = countBrandMatches(brandMentions, answerText);
        const domainMatch = countDomainMatches(job.domainMentions, bres.citations);
        let sentiment = 0, salience = 0;
        if (match.anyMatch) {
          sentiment = await retryWithBackoff(
            () => analyzeSentiment(answerText, brandMentions, openai, openaiModel),
            5, `Sentiment for "${job.text}"`
          );
          await delay(300);
          salience = await retryWithBackoff(
            () => analyzeSalience(answerText, brandMentions, openai, openaiModel),
            5, `Salience for "${job.text}"`
          );
        }

        const { answer_html, response_raw, answer_section_html, ...brightDataFilterObj } = bres;
        const serpAnalyzer = new EnhancedAnalyzer();
        const analyzerResult = serpAnalyzer.analyzeResponse(brightDataFilterObj);

        // Pull out the summary
        const { summary } = analyzerResult;
        

        // Get AI volume data for this prompt
        const aiVolumeData = aiVolumeDataMap.get(job.trackingId);
  
        // 4) Handle tracking_results: update stub for regular jobs, create new entry for nightly jobs
        if (isNightly) {
  
          // Create new tracking_results entry directly with real data
          const insertData = {
            prompt_id: job.id,
            prompt: job.text,
            project_id: job.projectId,
            user_id: job.userId,
            snapshot_id: actualSnapshotID,
            status: 'fulfilled',
            timestamp: Date.now(),
            is_present: match.anyMatch,
            is_domain_present: domainMatch.anyMatch,
            sentiment,
            salience,
            response: JSON.stringify({answer_text: answerText}),
            brand_mentions: job.brandMentions,
            domain_mentions: job.domainMentions,
            brand_name: String(job.brandMentions),
            source: 'Bright Data (Nightly)',
            mention_count: match.totalMatches,
            domain_mention_count: domainMatch.totalMatches,
            web_search: webSearch,
            intent_classification: summary.intentClassification,
            lcp: summary.lcp,
            actionability: summary.actionability,
            serp: summary.serp
          };

          // Add AI volume data if available
          if (aiVolumeData) {
            insertData.ai_search_volume = aiVolumeData.current_volume;
            insertData.ai_monthly_trends = aiVolumeData.monthly_trends;
            insertData.ai_volume_fetched_at = new Date().toISOString();
            insertData.ai_volume_location_code = aiVolumeData.location_code || 2840;
          }

          const { error: insertErr } = await supabase
            .from('tracking_results')
            .insert([insertData]);
  
          if (insertErr) throw insertErr;
        } else {
          // Update existing tracking_results stub (regular user-initiated jobs)
          const updateData = {
            snapshot_id: actualSnapshotID,
            status: 'fulfilled',
            timestamp: Date.now(),
            is_present: match.anyMatch,
            is_domain_present: domainMatch.anyMatch,
            sentiment,
            salience,
            response: JSON.stringify({answer_text: answerText}),
            mention_count: match.totalMatches,
            domain_mention_count: domainMatch.totalMatches,
            web_search: webSearch,
            intent_classification: summary.intentClassification,
            lcp: summary.lcp,
            actionability: summary.actionability,
            serp: summary.serp
          };

          // Add AI volume data if available
          if (aiVolumeData) {
            updateData.ai_search_volume = aiVolumeData.current_volume;
            updateData.ai_monthly_trends = aiVolumeData.monthly_trends;
            updateData.ai_volume_fetched_at = new Date().toISOString();
            updateData.ai_volume_location_code = aiVolumeData.location_code || 2840;
          }
  
          const { error: updateErr } = await supabase
            .from('tracking_results')
            .update(updateData)
            .eq('id', job.trackingId);
  
          if (updateErr) throw updateErr;
        }
    }

    // 4) Handle any unprocessed prompts (mark them as failed)
    const unprocessedPrompts = prompts.filter(p => !processedPromptIds.has(p.trackingId));
    if (unprocessedPrompts.length > 0) {
      // console.warn(`${unprocessedPrompts.length} prompts were not processed by BrightData for snapshot ${actualSnapshotID}`);
      
      for (const unprocessedJob of unprocessedPrompts) {
        try {
          if (isNightly) {
            // Create failed tracking_results entry for nightly jobs
            const { error: insertErr } = await supabase
              .from('tracking_results')
              .insert([{
                prompt_id: unprocessedJob.id,
                prompt: unprocessedJob.text,
                project_id: unprocessedJob.projectId,
                user_id: unprocessedJob.userId,
                snapshot_id: actualSnapshotID,
                status: 'failed',
                timestamp: Date.now(),
                is_present: false,
                sentiment: 0,
                salience: 0,
                response: JSON.stringify({error: 'No response received from BrightData'}),
                brand_mentions: unprocessedJob.brandMentions,
                domain_mentions: unprocessedJob.domainMentions,
                brand_name: String(unprocessedJob.brandMentions),
                source: 'Bright Data (Nightly)',
                mention_count: 0
              }]);
              
            if (insertErr) console.error('Error inserting failed nightly result:', insertErr);
          } else {
            // Mark existing tracking_results stub as failed
            const { error: updateErr } = await supabase
              .from('tracking_results')
              .update({
                snapshot_id: actualSnapshotID,
                status: 'failed',
                timestamp: Date.now(),
                is_present: false,
                sentiment: 0,
                salience: 0,
                response: JSON.stringify({error: 'No response received from BrightData'}),
                mention_count: 0
              })
              .eq('id', unprocessedJob.trackingId);
              
            if (updateErr) console.error('Error updating failed result:', updateErr);
          }
        } catch (err) {
          console.error(`Error marking prompt ${unprocessedJob.text} as failed:`, err);
        }
      }
    }

    // 5) Update job batch progress for tracking (simplified - emails sent per batch above)
    if (!isNightly && jobBatchId) {
      try {
        // Check if this batch has already been marked as completed (prevent retry duplicates)
        const { data: existingJob } = await supabase
          .from('job_batches')
          .select('completed_batches, total_batches, failed_batches')
          .eq('id', jobBatchId)
          .single();

        // Only increment if this batch hasn't pushed us over the total
        const currentTotal = (existingJob?.completed_batches || 0) + (existingJob?.failed_batches || 0);
        if (currentTotal < (existingJob?.total_batches || 0)) {
          console.log(`Incrementing completed_batches for job ${jobBatchId} (retry-safe)`);
          await supabase.rpc('increment_completed_batches', { job_id: jobBatchId });
          
          // Update final job status when all batches complete (for tracking only)
          const newTotal = currentTotal + 1;
          if (newTotal >= (existingJob?.total_batches || 0)) {
            const finalStatus = (existingJob?.failed_batches || 0) > 0 ? 'completed_with_errors' : 'completed';
            await supabase
              .from('job_batches')
              .update({ 
                status: finalStatus,
                completed_at: new Date().toISOString()
              })
              .eq('id', jobBatchId);
            // console.log(`Job ${jobBatchId} completed with status: ${finalStatus}`);
          }
        } else {
          // console.log(`Skipping completed_batches increment for job ${jobBatchId} - already at total batches (likely a retry)`);
        }
      } catch (err) {
        // console.error('Error updating job progress:', err);
      }
    }

    // 6) Send SUCCESS email for THIS batch (with deduplication)
    if (!isNightly && actualSnapshotID) {
      try {
        // Check if we've already sent an email for this snapshot_id (prevent retry duplicates)
        const { data: existingEmail } = await supabase
          .from('tracking_results')
          .select('id')
          .eq('snapshot_id', actualSnapshotID)
          .eq('user_id', prompts[0]?.userId)
          .limit(1)
          .single();

        if (existingEmail) {
          // Use existence of tracking_results with this snapshot_id as deduplication
          // Only send email if this is the first time we're processing this snapshot
          // console.log(`Sending SUCCESS email for batch ${batchNumber + 1}/${totalBatches}, snapshot: ${actualSnapshotID}`);
          
          const templateVars = {
            appUrl: process.env.APP_URL,
            dashboardUrl: `${process.env.APP_URL}/projects/${prompts[0].projectId}`,
            snapshotID: actualSnapshotID,
            unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
            year: new Date().getFullYear(),
            prompts: prompts.map(p => p.text) // Specific prompts in this batch
          };

          await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: email,
            subject: `Batch ${batchNumber + 1}/${totalBatches} completed - ${prompts.length} prompts analyzed`,
            template: process.env.MAILGUN_TEMPLATE_NAME,
            'h:X-Mailgun-Variables': JSON.stringify(templateVars)
          });

          // console.log(`SUCCESS email sent for batch ${batchNumber + 1}/${totalBatches}, snapshot: ${actualSnapshotID}`);
        }
      } catch (emailErr) {
        // console.error('Error sending success email notification:', emailErr);
      }
    }

    // 7) Acknowledge message  
    message.ack();
    // console.log(`Processed batch ${batchNumber + 1}/${totalBatches} for job ${jobBatchId}, snapshot ${actualSnapshotID}`);
  } catch (err) {
    // console.error('Worker error:', err);

    // Determine the failure reason for user-friendly messaging
    let failureReason = 'Unknown error occurred during processing';
    if (err.message.includes('BrightData returned empty results')) {
      failureReason = 'BrightData returned no results for your prompts. This usually indicates a processing issue on their end.';
    } else if (err.message.includes('Bright Data snapshot failed')) {
      failureReason = 'BrightData reported a processing failure for your request.';
    } else if (err.message.includes('OpenAI')) {
      failureReason = 'OpenAI API error occurred during analysis.';
    } else if (err.status === 429) {
      failureReason = 'Rate limit exceeded. Please try again later.';
    }

    // Mark tracking results as failed and update job batch failure count
    if (!isNightly) {
      try {
        // Mark tracking results as failed with specific error message
        // Always update by job_batch_id and batch_number for the current batch
        if (jobBatchId && typeof batchNumber !== 'undefined') {
          // console.log(`Marking batch ${batchNumber + 1}/${totalBatches} as failed for job ${jobBatchId}`);
          await supabase
            .from('tracking_results')
            .update({ 
              status: 'failed',
              response: JSON.stringify({error: err.message, snapshot_id: actualSnapshotID})
            })
            .eq('job_batch_id', jobBatchId)
            .eq('batch_number', batchNumber);
        } else if (actualSnapshotID) {
          // Fallback: update by snapshot_id if job info not available
          // console.log(`Marking records with snapshot ${actualSnapshotID} as failed`);
          await supabase
            .from('tracking_results')
            .update({ 
              status: 'failed',
              response: JSON.stringify({error: err.message})
            })
            .eq('snapshot_id', actualSnapshotID);
        } else if (jobBatchId) {
          // Last resort: update all pending records for this job batch
          // console.log(`Marking all pending records for job ${jobBatchId} as failed`);
          await supabase
            .from('tracking_results')
            .update({ 
              status: 'failed',
              response: JSON.stringify({error: err.message})
            })
            .eq('job_batch_id', jobBatchId)
            .eq('status', 'pending');
        }

        // Update job batch failed count for tracking
        if (jobBatchId) {
          // Check if this batch has already been marked as failed (prevent retry duplicates)
          const { data: existingJob } = await supabase
            .from('job_batches')
            .select('failed_batches, total_batches, completed_batches')
            .eq('id', jobBatchId)
            .single();

          // Only increment if this batch hasn't pushed us over the total
          const currentTotal = (existingJob?.failed_batches || 0) + (existingJob?.completed_batches || 0);
          if (currentTotal < (existingJob?.total_batches || 0)) {
            // console.log(`Incrementing failed_batches for job ${jobBatchId} (retry-safe)`);
            await supabase.rpc('increment_failed_batches', { job_id: jobBatchId });
            
            // Update final job status when all batches complete (for tracking only)
            const newTotal = currentTotal + 1;
            if (newTotal >= (existingJob?.total_batches || 0)) {
              const finalStatus = (existingJob?.completed_batches || 0) > 0 ? 'completed_with_errors' : 'failed';
              await supabase
                .from('job_batches')
                .update({ 
                  status: finalStatus,
                  completed_at: new Date().toISOString(),
                  error_message: failureReason
                })
                .eq('id', jobBatchId);
              // console.log(`Job ${jobBatchId} failed with status: ${finalStatus}`);
            }
          } else {
            // console.log(`Skipping failed_batches increment for job ${jobBatchId} - already at total batches (likely a retry)`);
          }
        }

        // Send FAILURE email for THIS batch (simplified - no complex deduplication needed)
        if (!isNightly && jobBatchId && typeof batchNumber !== 'undefined') {
          try {
            // console.log(`Sending FAILURE email for batch ${batchNumber + 1}/${totalBatches}, snapshot: ${actualSnapshotID || 'N/A'}`);
            
            const templateVars = {
              appUrl: process.env.APP_URL,
              dashboardUrl: `${process.env.APP_URL}/projects/${prompts[0]?.projectId}`,
              snapshotID: actualSnapshotID || 'N/A',
              unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
              year: new Date().getFullYear(),
              prompts: prompts.map(p => p.text) // Specific prompts that failed in this batch
            };

            await transporter.sendMail({
              from: process.env.EMAIL_FROM,
              to: email,
              subject: `Batch ${batchNumber + 1}/${totalBatches} failed - ${prompts.length} prompts could not be processed`,
              template: 'batch failed',
              'h:X-Mailgun-Variables': JSON.stringify(templateVars)
            });

            // console.log(`FAILURE email sent for batch ${batchNumber + 1}/${totalBatches}, snapshot: ${actualSnapshotID || 'N/A'}`);
          } catch (emailErr) {
            // console.error('Error sending failure email notification:', emailErr);
          }
        } else {
          // console.log(`Skipping FAILURE email - missing required identifiers: jobBatchId=${!!jobBatchId}, batchNumber=${batchNumber}`);
        }

      } catch (updateErr) {
        // console.error('Error updating failure status:', updateErr);
      }
    }

    // Determine if this is a retryable error
    const isRetryableError = 
      err.status === 429 || // Rate limits
      err.status >= 500 ||  // Server errors
      err.code === 'ECONNRESET' || 
      err.code === 'ETIMEDOUT' ||
      err.message.includes('network') ||
      err.message.includes('timeout');

    if (isRetryableError) {
      console.log(`Retryable error for job ${jobBatchId}, batch ${batchNumber + 1}: ${err.message}`);
      message.nack(); // Retry
    } else {
      console.log(`Non-retryable error for job ${jobBatchId}, batch ${batchNumber + 1}: ${err.message}`);
      message.ack(); // Don't retry, mark as processed
    }
  }
});

subscription.on('error', err =>
  console.error('Subscription error:', err)
);
