require('dotenv').config();
const { PubSub } = require('@google-cloud/pubsub');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

module.exports = {
  pubsub: new PubSub({ projectId: process.env.PUBSUB_PROJECT_ID }),
  supabase: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY),
  bright: {
    key: process.env.BRIGHTDATA_KEY,
    dataset: process.env.BRIGHTDATA_DATASET_ID,
  },
  pubsubTopic: process.env.PUBSUB_TOPIC,
  pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION,
  createOpenAI: (apiKey) => new OpenAI({ apiKey })
};