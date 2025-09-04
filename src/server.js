require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const {
  pubsub,
  supabase,
  bright,
  pubsubTopic,
  createOpenAI
} = require('./config');
const cors = require('cors')
/** Quick OpenAI key/model sanity check */
async function validateOpenAIAccess(openai, model) {
  try {
    const test = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 1,
      temperature: 0
    });
    if (!test.choices?.[0]?.message) throw new Error('Bad format');
  } catch (err) {
    if (err.status === 401) throw new Error('Invalid OpenAI key.');
    if (err.status === 429) throw new Error('OpenAI quota/rate limit.');
    if (err.status === 403) throw new Error('OpenAI forbidden. You are not authorized to use this model of OpenAI.');
    if (err.status === 404) throw new Error(`Your OpenAI key has no access to model "${model}".`);
    throw new Error(`OpenAI validation failed: ${err.message}`);
  }
}

/** Pick batch size: <5 ⇒ all, ≤10 ⇒ 5, else ⇒ 10 */
function getBatchSize(count) {
  if (count < 5) return count;
  if (count <= 10) return 5;
  return 10;
}

/** Simple chunking helper */
function chunkArray(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

const app = express();
// CORS policy to allow origins
app.use(cors({
  // origin: ["http://localhost:5173", "https://chatgptranktracker.com"],
  origin: "*",
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

// test server is running with get request at root
app.get('/', (req, res) => {
  res.send('Server is running....');
});


// New endpoint to fetch full BrightData response by snapshot_id and prompt
app.get('/snapshot-data/:snapshotId', async (req, res) => {
  const { snapshotId } = req.params;
  const { prompt } = req.query;

  if (!snapshotId || !prompt) {
    return res.status(400).json({
      error: 'snapshotId (param) and prompt (query) are required'
    });
  }

  try {
    // Fetch the full results from BrightData
    const { data: results } = await axios.get(
      `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
      { headers: { Authorization: `Bearer ${bright.key}` } }
    );

    // Find the specific result matching the prompt
    const matchingResult = results.find(result => 
      result.prompt === prompt
    );

    if (!matchingResult) {
      return res.status(404).json({
        error: 'No matching result found for the given prompt in this snapshot'
      });
    }

    // Return the full BrightData response
    res.json({
      status: 'success',
      snapshot_id: snapshotId,
      prompt: prompt,
      data: matchingResult
    });

  } catch (err) {
    // console.error('Snapshot data fetch error:', err);
    
    if (err.response?.status === 404) {
      return res.status(404).json({ 
        error: 'Snapshot not found or expired' 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch snapshot data',
      message: err.message 
    });
  }
});

app.post('/enqueue', async (req, res) => {
  const {
    project_id,
    user_id,
    email,
    prompts = [],
    brandMentions = [],
    domainMentions = [],
    userCity = '',
    userCountry = '',
    openaiKey,
    webSearch = false,
    openaiModel = process.env.DEFAULT_OPENAI_MODEL || 'gpt-4'
  } = req.body;

  if (!project_id || !user_id || !prompts.length || !openaiKey) {
    return res.status(400).json({
      error: 'project_id, user_id, prompts (≥1) and openaiKey are required'
    });
  }

  try {
    // 1) Validate OpenAI credentials
    const openai = createOpenAI(openaiKey);
    await validateOpenAIAccess(openai, openaiModel);

    // 2) Calculate batch info
    const size = getBatchSize(prompts.length);
    const totalBatches = Math.ceil(prompts.length / size);

    // 3) Create job_batches entry
    const { data: jobBatch, error: jobError } = await supabase
      .from('job_batches')
      .insert([{
        user_id,
        project_id,
        email,
        total_prompts: prompts.length,
        total_batches: totalBatches,
        openai_key: openaiKey,
        openai_model: openaiModel,
        web_search: webSearch,
        user_country: userCountry,
        user_city: userCity,
        brand_mentions: brandMentions,
        domain_mentions: domainMentions,
        status: 'pending'
      }])
      .select('id')
      .single();

    if (jobError) throw jobError;

    const jobBatchId = jobBatch.id;

    // 4) Prepare bulk data for prompts and tracking_results
    const promptsData = [];
    const trackingData = [];
    const enriched = [];

    prompts.forEach((text, index) => {
      const promptId = uuidv4();
      const trackingId = uuidv4();
      const batchNumber = Math.floor(index / size);

      // Prepare prompts data
      promptsData.push({
        id: promptId,
        text,
        enabled: true,
        project_id,
        user_id,
        source: 'Bright Data',
        user_city: userCity,
        user_country: userCountry,
        brand_mentions: brandMentions,
        domain_mentions: domainMentions
      });

      // Prepare tracking_results data
      trackingData.push({
        id: trackingId,
        prompt_id: promptId,
        prompt: text,
        project_id,
        user_id,
        job_batch_id: jobBatchId,
        batch_number: batchNumber,
        snapshot_id: null,
        status: 'pending',
        is_present: null,
        sentiment: null,
        salience: null,
        response: null,
        brand_mentions: brandMentions,
        domain_mentions: domainMentions,
        brand_name: String(brandMentions),
        timestamp: Date.now(),
        source: 'Bright Data',
        mention_count: null
      });

      // Prepare enriched data for batching
      enriched.push({
        id: promptId,
        text,
        userId: user_id,
        projectId: project_id,
        brandMentions,
        domainMentions,
        userCountry,
        trackingId,
        batchNumber
      });
    });

    // 5) Bulk insert prompts (all at once)
    const { error: promptsError } = await supabase
      .from('prompts')
      .insert(promptsData);
    
    if (promptsError) throw new Error(`Failed to insert prompts: ${promptsError.message}`);

    // 6) Bulk insert tracking_results (all at once)
    const { error: trackingError } = await supabase
      .from('tracking_results')
      .insert(trackingData);
    
    if (trackingError) throw new Error(`Failed to insert tracking results: ${trackingError.message}`);

    // console.log(`Bulk inserted ${prompts.length} prompts and tracking stubs for job ${jobBatchId}`);

    // 7) Chunk into batches and queue individual Pub/Sub messages
    const batches = chunkArray(enriched, size);
    
    // Update job status to processing
    await supabase
      .from('job_batches')
      .update({ status: 'processing' })
      .eq('id', jobBatchId);

    // Queue each batch as a separate message (no waiting)
    const batchPromises = batches.map(async (batch, batchIndex) => {
      try {
        // Publish message for this batch - BrightData trigger moved to worker
        await pubsub
          .topic(pubsubTopic)
          .publish(Buffer.from(JSON.stringify({
            openaiKey,
            openaiModel,
            email,
            jobBatchId,
            batchNumber: batchIndex,
            totalBatches,
            prompts: batch,
            userCountry,
            webSearch,
            isNightly: false
          })));

        // console.log(`Queued batch ${batchIndex + 1}/${totalBatches} for job ${jobBatchId}`);
      } catch (err) {
        // console.error(`Failed to queue batch ${batchIndex}:`, err);
        // Don't throw - let other batches continue
      }
    });

    // Don't await the batch promises - let them run in background
    Promise.all(batchPromises).catch(err => {
      // console.error('Some batches failed to queue:', err);
    });

    // 6) Return immediately with job info
    res.json({ 
      status: 'enqueued', 
      jobBatchId,
      totalPrompts: prompts.length,
      totalBatches,
      message: `Your ${prompts.length} prompts are being processed in ${totalBatches} batches. You'll receive an email when complete.`
    });

  } catch (err) {
    // console.error('Enqueue error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Enqueue API listening on port ${PORT}`)
);
