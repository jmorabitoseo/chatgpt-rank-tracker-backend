// src/nightly.js
//
// Nightly Refresh System for ChatGPT Rank Tracker
//
// Environment Variables for Testing Mode:
// - NIGHTLY_TESTING_MODE=true          : Enable testing mode (defaults to false)
// - NIGHTLY_TEST_USER_ID=<user_id>     : Target specific user ID in testing mode
// - NIGHTLY_TEST_PROJECT_ID=<proj_id>  : Target specific project ID in testing mode
// - NIGHTLY_CRON_SCHEDULE=<schedule>   : Custom cron schedule (defaults to '0 0 * * *' for midnight daily)
//
// Usage Examples:
// Testing Mode (10 min):  NIGHTLY_TESTING_MODE=true NIGHTLY_TEST_USER_ID=user123 NIGHTLY_TEST_PROJECT_ID=proj456 NIGHTLY_CRON_SCHEDULE="*/10 * * * *" node src/nightly.js
// Testing Mode (daily):   NIGHTLY_TESTING_MODE=true NIGHTLY_TEST_USER_ID=user123 NIGHTLY_TEST_PROJECT_ID=proj456 node src/nightly.js
// Production:             node src/nightly.js (or just let the cron job run)
//
require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const {
  pubsub,
  supabase,
  bright,
  pubsubTopic,
  createOpenAI
} = require('./config');

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

// Global flag to prevent duplicate runs
let isRefreshRunning = false;

async function performNightlyRefresh() {
  if (isRefreshRunning) {
    // console.log('⚠️  Nightly refresh already running, skipping duplicate call...');
    return;
  }
  
  isRefreshRunning = true;
  const startTime = new Date().toISOString();
  
  // Check environment variables for testing mode
  const isTestingMode = process.env.NIGHTLY_TESTING_MODE === 'true';
  const TEST_USER_ID = process.env.NIGHTLY_TEST_USER_ID;
  const TEST_PROJECT_ID = process.env.NIGHTLY_TEST_PROJECT_ID;
  
  if (isTestingMode) {
    if (!TEST_USER_ID || !TEST_PROJECT_ID) {
      // console.error('❌ Testing mode enabled but NIGHTLY_TEST_USER_ID or NIGHTLY_TEST_PROJECT_ID not provided');
      isRefreshRunning = false;
      return;
    }
    // console.log(`🧪 Starting nightly refresh (TESTING MODE - User: ${TEST_USER_ID}, Project: ${TEST_PROJECT_ID}) at ${startTime}...`);
  } else {
    // console.log(`🚀 Starting nightly refresh (PRODUCTION MODE - All Users) at ${startTime}...`);
  }
  
  try {
    let projects, projectsError;
    
    if (isTestingMode) {
      // 1) Fetch specific test user's project with enabled prompts
      const result = await supabase
        .from('projects')
        .select(`
          id,
          user_id,
          name,
          prompts!inner(
            id,
            text,
            enabled,
            brand_mentions,
            domain_mentions,
            user_city,
            user_country
          )
        `)
        .eq('id', TEST_PROJECT_ID)
        .eq('user_id', TEST_USER_ID)
        .eq('prompts.enabled', true);
      
      projects = result.data;
      projectsError = result.error;
      
      if (!projects || projects.length === 0) {
        // console.log(`No enabled prompts found for test user ${TEST_USER_ID} in project ${TEST_PROJECT_ID}.`);
        return;
      }
      
      // console.log(`🧪 TESTING MODE: Found ${projects.length} project(s) with enabled prompts for user ${TEST_USER_ID}`);
    } else {
      // 1) Fetch ALL users' projects with enabled prompts
      const result = await supabase
        .from('projects')
        .select(`
          id,
          user_id,
          name,
          prompts!inner(
            id,
            text,
            enabled,
            brand_mentions,
            domain_mentions,
            user_city,
            user_country
          )
        `)
        .eq('prompts.enabled', true);
      
      projects = result.data;
      projectsError = result.error;
      
      if (!projects || projects.length === 0) {
        // console.log('No enabled prompts found across all users.');
        return;
      }
      
      const uniqueUsers = [...new Set(projects.map(p => p.user_id))];
      // console.log(`🚀 PRODUCTION MODE: Found ${projects.length} project(s) with enabled prompts across ${uniqueUsers.length} users`);
    }

    if (projectsError) {
      throw new Error(`Failed to fetch projects: ${projectsError.message}`);
    }

    // 2) Group by user to process each user's data
    const userProjects = projects.reduce((acc, project) => {
      if (!acc[project.user_id]) {
        acc[project.user_id] = [];
      }
      acc[project.user_id].push(project);
      return acc;
    }, {});

    // 3) Process each user's projects
    for (const [userId, userProjectList] of Object.entries(userProjects)) {
      try {
        const totalPromptsForUser = userProjectList.reduce((sum, proj) => sum + proj.prompts.length, 0);
        // console.log(`📂 Processing user ${userId} with ${userProjectList.length} projects (${totalPromptsForUser} total prompts)`);

        // Get user's OpenAI key
        const { data: userSettings, error: settingsError } = await supabase
          .from('user_settings')
          .select('openai_key')
          .eq('user_id', userId)
          .single();

        if (settingsError || !userSettings?.openai_key) {
          // console.warn(`Skipping user ${userId}: No OpenAI key found`);
          continue;
        }

        const openaiKey = userSettings.openai_key;
        const openaiModel = process.env.DEFAULT_OPENAI_MODEL || 'gpt-4';

        // Validate OpenAI credentials
        const openai = createOpenAI(openaiKey);
        await validateOpenAIAccess(openai, openaiModel);

        // 4) Process each project for this user
        for (const project of userProjectList) {
          try {
            // console.log(`Processing project ${project.name} (${project.id}) for user ${userId}`);

            // 5) Process each prompt in the project (NO STUBS - just prepare data for worker)
            const enrichedPrompts = project.prompts.map(prompt => ({
              id: prompt.id,
              text: prompt.text,
              userId: userId,
              projectId: project.id,
              brandMentions: prompt.brand_mentions || [],
              domainMentions: prompt.domain_mentions || [],
              userCountry: prompt.user_country || '',
              isNightly: true // Flag to indicate this is a nightly job
            }));

            // 6) Chunk prompts into batches
            const batchSize = getBatchSize(enrichedPrompts.length);
            const batches = chunkArray(enrichedPrompts, batchSize);

            // 7) Process batches - queue messages for workers (aligned with new server.js pattern)
            const totalBatches = batches.length;

            // Queue each batch as a separate message (no BrightData triggering here)
            const batchPromises = batches.map(async (batch, batchIndex) => {
              try {
                // Publish message for this batch - BrightData trigger moved to worker
                await pubsub
                  .topic(pubsubTopic)
                  .publish(Buffer.from(JSON.stringify({
                    openaiKey,
                    openaiModel,
                    email: null, // No email for nightly jobs
                    jobBatchId: null, // No job tracking for nightly jobs
                    batchNumber: batchIndex,
                    totalBatches,
                    prompts: batch,
                    userCountry: batch[0]?.userCountry || 'US',
                    webSearch: false, // Nightly jobs don't use web search
                    isNightly: true // Flag to skip email notifications and create tracking_results directly
                  })));

                // console.log(`Nightly batch ${batchIndex + 1}/${totalBatches} queued for project ${project.name}`);
              } catch (err) {
                // console.error(`Failed to queue nightly batch ${batchIndex}:`, err);
                // Don't throw - let other batches continue
              }
            });

            // Don't await the batch promises - let them run in background
            Promise.all(batchPromises).catch(err => {
              // console.error('Some nightly batches failed to queue:', err);
            });

            // console.log(`✅ Queued ${totalBatches} nightly batches for project ${project.name} (${enrichedPrompts.length} prompts)`);

          } catch (projectError) {
            // console.error(`Error processing project ${project.id}:`, projectError);
            // Continue with next project
          }
        }

      } catch (userError) {
        // console.error(`Error processing user ${userId}:`, userError);
        // Continue with next user
      }
    }

    const endTime = new Date().toISOString();
    // console.log(`✅ Nightly refresh enqueued successfully at ${endTime}`);

  } catch (error) {
    const errorTime = new Date().toISOString();
    // console.error(`❌ Nightly refresh failed at ${errorTime}:`, error);
  } finally {
    isRefreshRunning = false;
    // console.log('🔓 Nightly refresh lock released');
  }
}

// Schedule nightly refresh with configurable timing
const cronSchedule = process.env.NIGHTLY_CRON_SCHEDULE || '0 0 * * *';
const isTestingMode = process.env.NIGHTLY_TESTING_MODE === 'true';

// Validate cron schedule format (basic check)
function validateCronSchedule(schedule) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron schedule format: "${schedule}". Expected 5 parts (minute hour day month dayOfWeek)`);
  }
  return true;
}

try {
  validateCronSchedule(cronSchedule);
  
  cron.schedule(cronSchedule, performNightlyRefresh, {
    scheduled: true,
    timezone: "UTC"
  });

  if (isTestingMode) {
    // console.log(`🧪 TESTING MODE: Nightly refresh cron job scheduled with custom interval: "${cronSchedule}" (UTC)`);
    // console.log(`   Target User: ${process.env.NIGHTLY_TEST_USER_ID}`);
    // console.log(`   Target Project: ${process.env.NIGHTLY_TEST_PROJECT_ID}`);
    
    // Show next few run times for testing schedules
    if (cronSchedule.startsWith('*/')) {
      // console.log('   ⏰ This will run frequently for testing purposes');
    }
  } else {
    // console.log(`🚀 PRODUCTION MODE: Nightly refresh cron job scheduled for: "${cronSchedule}" (UTC)`);
    if (cronSchedule !== '0 0 * * *') {
      // console.log('   ⚠️  Using custom schedule in production mode');
    }
  }
} catch (error) {
  // console.error('❌ Failed to schedule nightly refresh:', error.message);
  process.exit(1);
}

// TEST FUNCTION - Call this to test immediately
// Make sure to set environment variables for testing:
// NIGHTLY_TESTING_MODE=true NIGHTLY_TEST_USER_ID=<user_id> NIGHTLY_TEST_PROJECT_ID=<project_id>
async function testNightlyRefreshNow() {
  // console.log('\n🧪 TESTING NIGHTLY REFRESH IMMEDIATELY...\n');
  // console.log('Environment variables:');
  // console.log(`- NIGHTLY_TESTING_MODE: ${process.env.NIGHTLY_TESTING_MODE}`);
  // console.log(`- NIGHTLY_TEST_USER_ID: ${process.env.NIGHTLY_TEST_USER_ID}`);
  // console.log(`- NIGHTLY_TEST_PROJECT_ID: ${process.env.NIGHTLY_TEST_PROJECT_ID}\n`);
  await performNightlyRefresh();
}

// Export for testing
module.exports = { performNightlyRefresh, testNightlyRefreshNow };

// Optional: For testing, you can uncomment the line below to run immediately
// testNightlyRefreshNow();
