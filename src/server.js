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
    console.error('Snapshot data fetch error:', err);
    
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
    prompts = [],
    brandMentions = [],
    domainMentions = [],
    userCity = '',
    userCountry = '',
    openaiKey,
    openaiModel = process.env.DEFAULT_OPENAI_MODEL || 'gpt-4'
  } = req.body;

  if (!project_id || !user_id || !prompts.length || !openaiKey) {
    return res.status(400).json({
      error: 'project_id, user_id, prompts (≥1) and openaiKey are required'
    });
  }

  try {

    // const { data:userRec, error:userErr } =
    // await supabase.auth.admin.getUserById(user_id)
    // 1) Validate OpenAI credentials
    const openai = createOpenAI(openaiKey);
    await validateOpenAIAccess(openai, openaiModel);

    // 2) Insert & seed prompts + tracking stubs
    const enriched = await Promise.all(prompts.map(async text => {
      const promptId = uuidv4();
      const trackingId = uuidv4();

      // a) insert into prompts table
      const { error: promptError } = await supabase.from('prompts').insert([{
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
      }]);
      
      if (promptError) throw promptError;

      // b) insert stub into tracking_results
      const { error: trackingError } = await supabase.from('tracking_results').insert([{
        id: trackingId,
        prompt_id: promptId,
        prompt: text,            // ← store the prompt text here
        project_id,
        user_id,
        snapshot_id: null,
        status: 'pending',       // new status column
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
      }]);
      
      if (trackingError) throw trackingError;

      return {
        id: promptId,
        text,
        userId: user_id,
        projectId: project_id,
        brandMentions,
        domainMentions,
        userCountry,
        trackingId
      };
    }));

    // 3) Chunk into batches
    const size = getBatchSize(enriched.length);
    const batches = chunkArray(enriched, size);

    // 4) Trigger BrightData & publish to Pub/Sub (max 5 concurrent)
    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(5);

    const snapshotIDs = await Promise.all(
      batches.map(batch => limit(async () => {
        const triggerBody = batch.map(e => ({
          url: 'https://chatgpt.com/',
          prompt: e.text,
          country: e.userCountry
        }));

        const { data } = await axios.post(
          `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${bright.dataset}`,
          triggerBody,
          { headers: { Authorization: `Bearer ${bright.key}` } }
        );
        const snapshotID = data.snapshot_id;

        // publish message with trackingIds
        await pubsub
          .topic(pubsubTopic)
          .publish(Buffer.from(JSON.stringify({
            snapshotID,
            openaiKey,
            openaiModel,
            prompts: batch   // includes trackingId on each
          })));

        return snapshotID;
      }))
    );

    // 5) Respond with all batch snapshot IDs
    res.json({ status: 'enqueued', snapshotIDs });
    // res.json({ status: 'enqueued', userRec, userErr });
  } catch (err) {
    console.error('Enqueue error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Enqueue API listening on port ${PORT}`)
);
