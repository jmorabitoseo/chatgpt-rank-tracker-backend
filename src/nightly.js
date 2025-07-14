// src/nightly.js
const cron = require('node-cron');
const { supabase, pubsub } = require('./config');

cron.schedule('0 0 * * *', async () => {
  console.log('Starting nightly refresh...');
  const { data: prompts } = await supabase.from('prompts').select('id,text,project_id');
  for (let p of prompts) {
    await pubsub.topic('prompt-jobs').publish(Buffer.from(JSON.stringify({
      prompts: [p.text],
      projectId: p.project_id,
    })));
  }
  console.log('Nightly refresh enqueued.');
});
