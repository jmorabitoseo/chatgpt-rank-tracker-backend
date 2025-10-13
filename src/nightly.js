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
require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const {
  pubsub,
  supabase,
  bright,
  pubsubTopic,
  createOpenAI,
  dataForSEOTopic,
} = require("./config");
const {
  getActiveService,
  getActiveServiceAsync,
} = require("./utils/activeService");

/** Quick OpenAI key/model sanity check */
async function validateOpenAIAccess(openai, model) {
  try {
    const test = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 1,
      temperature: 0,
    });
    if (!test.choices?.[0]?.message) throw new Error("Bad format");
  } catch (err) {
    if (err.status === 401) throw new Error("Invalid OpenAI key.");
    if (err.status === 429) throw new Error("OpenAI quota/rate limit.");
    if (err.status === 403)
      throw new Error(
        "OpenAI forbidden. You are not authorized to use this model of OpenAI."
      );
    if (err.status === 404)
      throw new Error(`Your OpenAI key has no access to model "${model}".`);
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

/**
 * Check if user should run based on scheduler_frequency and last_nightly_run_at
 * @param {string|null} frequency - 'daily', 'weekly', or 'monthly' (or null/undefined)
 * @param {string|null} lastRunAt - ISO timestamp or null
 * @returns {boolean} - true if should run, false if should skip
 */
function shouldRunForUser(frequency, lastRunAt) {
  // If no frequency set, skip this user (don't run)
  if (!frequency) {
    return false;
  }

  // If never run before (lastRunAt is null), always run
  if (!lastRunAt) {
    return true;
  }

  const now = new Date();
  const lastRun = new Date(lastRunAt);
  const timeDiffMs = now - lastRun;
  const dayInMs = 24 * 60 * 60 * 1000;

  switch (frequency.toLowerCase()) {
    case "daily":
      // Run if more than 1 day has passed
      return timeDiffMs >= dayInMs;

    case "weekly":
      // Run if more than 7 days have passed
      return timeDiffMs >= 7 * dayInMs;

    case "monthly":
      // Run if more than 30 days have passed (approximation)
      return timeDiffMs >= 30 * dayInMs;

    default:
      // Unknown frequency value, skip
      return false;
  }
}

/**
 * Update last_nightly_run_at timestamp for a user
 * @param {string} userId - User ID to update
 */
async function updateLastNightlyRun(userId) {
  try {
    const { error } = await supabase
      .from("user_settings")
      .update({ last_nightly_run_at: new Date().toISOString() })
      .eq("user_id", userId);

    if (error) {
      console.log(
        `⚠️  Failed to update last_nightly_run_at for user ${userId}: ${error.message}`
      );
    } else {
      console.log(`✅ Updated last_nightly_run_at for user ${userId}`);
    }
  } catch (err) {
    console.log(
      `⚠️  Error updating last_nightly_run_at for user ${userId}: ${err.message}`
    );
  }
}

// Simple topic selection function with halt logic
async function getTopicForActiveService() {
  const activeService = await getActiveServiceAsync();
  if (!activeService) {
    return null; // Return null if no active service
  }

  switch (activeService) {
    case "brightdata":
      return pubsubTopic;
    case "dataforseo":
      return dataForSEOTopic;
    default:
      return null; // Return null for unknown services
  }
}

// Global flag to prevent duplicate runs
let isRefreshRunning = false;

async function performNightlyRefresh() {
  if (isRefreshRunning) {
    console.log("⏭️  Nightly refresh skipped: a run is already in progress");
    return;
  }
  const topicName = await getTopicForActiveService();
  console.log("🔧 Using active service topic:", topicName);
  if (!topicName) {
    console.log("❌ No active service topic available. Halting nightly run.");
    return;
  }
  isRefreshRunning = true;
  const startTime = new Date().toISOString();
  console.log(`🚀 Nightly refresh started at ${startTime}`);

  // Check environment variables for testing mode
  const isTestingMode = process.env.NIGHTLY_TESTING_MODE === "true";
  const TEST_USER_ID = process.env.NIGHTLY_TEST_USER_ID;
  const TEST_PROJECT_ID = process.env.NIGHTLY_TEST_PROJECT_ID;

  if (isTestingMode) {
    if (!TEST_USER_ID || !TEST_PROJECT_ID) {
      isRefreshRunning = false;
      console.log(
        "⚠️  Testing mode enabled but NIGHTLY_TEST_USER_ID or NIGHTLY_TEST_PROJECT_ID missing. Aborting run."
      );
      return;
    }
    console.log(
      `🧪 Testing mode: user=${TEST_USER_ID}, project=${TEST_PROJECT_ID}`
    );
  } else {
    console.log(
      "🌙 Production mode: processing all users with enabled prompts"
    );
  }

  try {
    let projects, projectsError;

    if (isTestingMode) {
      // 1) Fetch specific test user's project with enabled prompts
      const result = await supabase
        .from("projects")
        .select(
          `
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
        `
        )
        .eq("id", TEST_PROJECT_ID)
        .eq("user_id", TEST_USER_ID)
        .eq("prompts.enabled", true);

      projects = result.data;
      projectsError = result.error;

      if (!projects || projects.length === 0) {
        console.log(
          `⚠️  No enabled prompts for test user=${TEST_USER_ID} project=${TEST_PROJECT_ID}. Ending run.`
        );
        return;
      }

      console.log(
        `🧪 Testing: found ${projects.length} project(s) with enabled prompts for user ${TEST_USER_ID}`
      );
    } else {
      // 1) Fetch ALL users' projects with enabled prompts
      const result = await supabase
        .from("projects")
        .select(
          `
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
        `
        )
        .eq("prompts.enabled", true);
      projects = result.data;
      projectsError = result.error;

      if (!projects || projects.length === 0) {
        console.log(
          "ℹ️  No enabled prompts found across all users. Nothing to do."
        );
        return;
      }

      const uniqueUsers = [...new Set(projects.map((p) => p.user_id))];
      console.log(
        `📦 Found ${projects.length} project(s) with enabled prompts across ${uniqueUsers.length} user(s)`
      );
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
    console.log(
      `👥 Grouped projects by user: ${Object.keys(userProjects).length} user(s)`
    );

    // 3) Process each user's projects
    for (const [userId, userProjectList] of Object.entries(userProjects)) {
      try {
        console.log(`\n—— Processing user ${userId} ——`);
        const totalPromptsForUser = userProjectList.reduce(
          (sum, proj) => sum + proj.prompts.length,
          0
        );
        console.log(
          `📂 Projects: ${userProjectList.length}, Total prompts: ${totalPromptsForUser}`
        );

        // Get user's settings including scheduler frequency and last run time
        const { data: userSettings, error: settingsError } = await supabase
          .from("user_settings")
          .select("openai_key, scheduler_frequency, last_nightly_run_at")
          .eq("user_id", userId)
          .single();

        if (settingsError || !userSettings?.openai_key) {
          console.log(`⚠️  Skipping user ${userId}: missing OpenAI key`);
          continue;
        }

        // Check if user should run based on scheduler frequency
        const shouldRun = shouldRunForUser(
          userSettings.scheduler_frequency,
          userSettings.last_nightly_run_at
        );
        
        if (!shouldRun) {
          const frequency = userSettings.scheduler_frequency || "not set";
          const lastRun = userSettings.last_nightly_run_at
            ? new Date(userSettings.last_nightly_run_at).toISOString()
            : "never";

          if (!userSettings.scheduler_frequency) {
            console.log(
              `⏭️  Skipping user ${userId}: scheduler_frequency not set`
            );
          } else {
            console.log(
              `⏭️  Skipping user ${userId}: scheduler frequency is "${frequency}", last run at ${lastRun} (not enough time passed)`
            );
          }
          continue;
        }

        const isFirstRun = !userSettings.last_nightly_run_at;
        console.log(
          `✅ User ${userId} qualifies for nightly run (frequency: ${
            userSettings.scheduler_frequency
          }, ${isFirstRun ? "first run" : "scheduled interval passed"})`
        );

        const openaiKey = userSettings.openai_key;
        const openaiModel = process.env.DEFAULT_OPENAI_MODEL || "gpt-4";

        // Validate OpenAI credentials
        const openai = createOpenAI(openaiKey);
        try {
          await validateOpenAIAccess(openai, openaiModel);
          console.log(
            `✅ OpenAI key validated for user ${userId} (model=${openaiModel})`
          );
        } catch (e) {
          console.log(
            `❌ OpenAI validation failed for user ${userId}: ${e.message}`
          );
          continue;
        }

        // 4) Process each project for this user
        let userHadSuccessfulRun = false;

        for (const project of userProjectList) {
          try {
            console.log(`📁 Project: ${project.name} (${project.id})`);

            // 5) Process each prompt in the project (NO STUBS - just prepare data for worker)
            const enrichedPrompts = project.prompts.map((prompt) => ({
              id: prompt.id,
              text: prompt.text,
              userId: userId,
              projectId: project.id,
              brandMentions: prompt.brand_mentions || [],
              domainMentions: prompt.domain_mentions || [],
              userCountry: prompt.user_country || "",
              isNightly: true, // Flag to indicate this is a nightly job
            }));
            console.log(
              `🧩 Prepared ${enrichedPrompts.length} prompt(s) for queuing`
            );

            // 6) Chunk prompts into batches
            const batchSize = getBatchSize(enrichedPrompts.length);
            const batches = chunkArray(enrichedPrompts, batchSize);
            console.log(
              `📦 Chunked into ${batches.length} batch(es) (batchSize=${batchSize})`
            );

            // 7) Process batches - queue messages for workers (aligned with new server.js pattern)
            const totalBatches = batches.length;

            // Queue each batch as a separate message (no BrightData triggering here)
            const batchPromises = batches.map(async (batch, batchIndex) => {
              try {
                // Publish message for this batch - BrightData trigger moved to worker
                await pubsub.topic(topicName).publish(
                  Buffer.from(
                    JSON.stringify({
                      openaiKey,
                      openaiModel,
                      email: null, // No email for nightly jobs
                      jobBatchId: null, // No job tracking for nightly jobs
                      batchNumber: batchIndex,
                      totalBatches,
                      prompts: batch,
                      userCountry: batch[0]?.userCountry || "US",
                      webSearch: false, // Nightly jobs don't use web search
                      isNightly: true, // Flag to skip email notifications and create tracking_results directly
                      user_id: userId,  
                    })
                  )
                );
                console.log(
                  `🛫 Queued batch ${
                    batchIndex + 1
                  }/${totalBatches} for project ${project.name}`
                );
              } catch (err) {
                console.log(
                  `⚠️  Failed to queue batch ${
                    batchIndex + 1
                  }/${totalBatches} for project ${project.name}: ${err.message}`
                );
              }
            });

            // Don't await the batch promises - let them run in background
            Promise.all(batchPromises).catch((err) => {
              console.log(
                `⚠️  Some nightly batches failed to queue for project ${project.name}: ${err.message}`
              );
            });

            console.log(
              `✅ Queued ${totalBatches} batch(es) for project ${project.name} (${enrichedPrompts.length} prompts)`
            );

            userHadSuccessfulRun = true;
          } catch (projectError) {
            console.log(
              `❌ Error processing project ${project.id}: ${projectError.message}`
            );
          }
        }

        // Update last_nightly_run_at only if at least one project was processed successfully
        if (userHadSuccessfulRun) {
          await updateLastNightlyRun(userId);
        }
      } catch (userError) {
        console.log(`❌ Error processing user ${userId}: ${userError.message}`);
      }
    }

    const endTime = new Date().toISOString();
    console.log(`🎉 Nightly refresh completed at ${endTime}`);
  } catch (error) {
    const errorTime = new Date().toISOString();
    console.log(`💥 Nightly refresh failed at ${errorTime}: ${error.message}`);
  } finally {
    isRefreshRunning = false;
    console.log("🔓 Nightly refresh lock released");
  }
}

// Schedule nightly refresh with configurable timing
const cronSchedule = process.env.NIGHTLY_CRON_SCHEDULE || "0 0 * * *";
const isTestingMode = process.env.NIGHTLY_TESTING_MODE === "true";

// Validate cron schedule format (basic check)
function validateCronSchedule(schedule) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron schedule format: "${schedule}". Expected 5 parts (minute hour day month dayOfWeek)`
    );
  }
  return true;
}

try {
  validateCronSchedule(cronSchedule);

  cron.schedule(cronSchedule, performNightlyRefresh, {
    scheduled: true,
    timezone: "UTC",
  });

  if (isTestingMode) {
    // Show next few run times for testing schedules
    if (cronSchedule.startsWith("*/")) {
      // This will run frequently for testing purposes
    }
  } else {
    if (cronSchedule !== "0 0 * * *") {
      // Using custom schedule in production mode
    }
  }
} catch (error) {
  process.exit(1);
}

// TEST FUNCTION - Call this to test immediately
// Make sure to set environment variables for testing:
// NIGHTLY_TESTING_MODE=true NIGHTLY_TEST_USER_ID=<user_id> NIGHTLY_TEST_PROJECT_ID=<project_id>
async function testNightlyRefreshNow() {
  await performNightlyRefresh();
}

// Export for testing
module.exports = { performNightlyRefresh, testNightlyRefreshNow };

// Test execution for development (commented out by default)
// let hasRunTest = false;
// if (!hasRunTest && process.env.NODE_ENV !== "production") {
//   hasRunTest = true;
//   testNightlyRefreshNow(); // Uncomment to test immediately
// }
