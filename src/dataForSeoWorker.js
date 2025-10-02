require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const mgTransport = require("nodemailer-mailgun-transport");

// Custom files
const {
  pubsub,
  supabase,
  dataForSeo,
  dataForSEOSubscription,
  createOpenAI,
} = require("./config");
const { retryWithBackoff } = require("./utils/apiHelpers");

// ═══════════════════════════════════════════════════════════════
//                           CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const transporter = nodemailer.createTransport(
  mgTransport({
    auth: {
      api_key: process.env.MG_API_KEY,
      domain: process.env.MG_DOMAIN,
    },
  })
);

// ═══════════════════════════════════════════════════════════════
//                           UTILITIES
// ═══════════════════════════════════════════════════════════════

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function getDataForSeoAuth() {
  const credentials = `${dataForSeo.login}:${dataForSeo.password}`;
  return Buffer.from(credentials).toString("base64");
}

// ═══════════════════════════════════════════════════════════════
//                        DATAFORSEO API
// ═══════════════════════════════════════════════════════════════

async function fetchValidLocations() {
  const authHeader = `Basic ${getDataForSeoAuth()}`;
  const response = await axios.get(
    "https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/locations",
    { headers: { Authorization: authHeader } }
  );
  return response.data.tasks?.[0]?.result || [];
}

async function fetchValidLanguages() {
  const authHeader = `Basic ${getDataForSeoAuth()}`;
  const response = await axios.get(
    "https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/languages",
    { headers: { Authorization: authHeader } }
  );
  return response.data.tasks?.[0]?.result || [];
}

function buildLocationPayload(customData, validLocations) {
  if (customData.location_name) {
    const match = validLocations.find(
      (loc) => loc.location_name === customData.location_name
    );
    if (match) return { location_name: customData.location_name };
  }

  if (customData.location_code) {
    const match = validLocations.find(
      (loc) => loc.location_code === customData.location_code
    );
    if (match) return { location_code: customData.location_code };
  }

  if (customData.location_coordinate) {
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(customData.location_coordinate)) {
      return { location_coordinate: customData.location_coordinate };
    }
  }

  return { location_code: dataForSeo.defaultLocationCode || 2840 };
}

function buildLanguagePayload(customData, validLanguages) {
  if (customData.language_name) {
    const match = validLanguages.find(
      (lang) => lang.language_name === customData.language_name
    );
    if (match) return { language_name: customData.language_name };
  }

  if (customData.language_code) {
    const match = validLanguages.find(
      (lang) => lang.language_code === customData.language_code
    );
    if (match) return { language_code: customData.language_code };
  }

  return { language_code: dataForSeo.defaultLanguageCode || "en" };
}

function buildCallbackUrl(customData) {
  const baseUrl = process.env.DATAFORSEO_CALLBACK_URL;
  const baseParams = `user_id=${customData.user_id}&openaiModel=${
    customData?.openaiModel || "gpt-4"
  }`;

  if (customData.isNightly) {
    return `${baseUrl}/?${baseParams}&isNightly=true&promptId=${customData.promptId}&projectId=${customData.projectId}`;
  }

  return `${baseUrl}/?${baseParams}`;
}

async function submitDataForSeoTask(
  prompt,
  userCountry,
  webSearch,
  customData = {}
) {
  // console.log("customData : ", customData);
  const authHeader = `Basic ${getDataForSeoAuth()}`;

  // Fetch validation data
  const [validLocations, validLanguages] = await Promise.all([
    fetchValidLocations(),
    fetchValidLanguages(),
  ]);

  // Build payload components
  const locationPayload = buildLocationPayload(customData, validLocations);
  const languagePayload = buildLanguagePayload(customData, validLanguages);
  const callbackUrl = buildCallbackUrl(customData);

  const taskData = {
    ...locationPayload,
    ...languagePayload,
    keyword: prompt,
    force_web_search: webSearch || false,
    expand_citations: webSearch || false,
    postback_url: callbackUrl,
    postback_data: "advanced",
  };
  console.log("Submitting DataForSEO task:", taskData);
  const response = await retryWithBackoff(
    () =>
      axios.post(
        "https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_post",
        [taskData],
        {
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
        }
      ),
    5,
    "DataForSEO task_post"
  );

  if (response.data.status_code === 20000 && response.data.tasks?.[0]?.id) {
    return response.data.tasks[0].id;
  }

  throw new Error(
    `DataForSEO task submission failed: ${response.data.status_message}`
  );
}

// ═══════════════════════════════════════════════════════════════
//                         DATABASE OPERATIONS
// ═══════════════════════════════════════════════════════════════

async function updateTrackingResult(trackingId, updates) {
  const { error } = await supabase
    .from("tracking_results")
    .update({ ...updates, timestamp: Date.now() })
    .eq("id", trackingId);

  if (error) throw error;
}

async function markTrackingResultsFailed(
  jobBatchId,
  batchNumber,
  errorMessage
) {
  await supabase
    .from("tracking_results")
    .update({
      status: "failed",
      response: JSON.stringify({
        error: errorMessage,
        service: "DataForSEO",
      }),
    })
    .eq("job_batch_id", jobBatchId)
    .eq("batch_number", batchNumber);
}

async function updateJobBatchStatus(jobBatchId, status) {
  await supabase.from("job_batches").update({ status }).eq("id", jobBatchId);
}

async function handleJobBatchFailure(jobBatchId, failureReason) {
  const { data: existingJob } = await supabase
    .from("job_batches")
    .select("failed_batches, total_batches, completed_batches")
    .eq("id", jobBatchId)
    .single();

  const currentTotal =
    (existingJob?.failed_batches || 0) + (existingJob?.completed_batches || 0);

  if (currentTotal < (existingJob?.total_batches || 0)) {
    await supabase.rpc("increment_failed_batches", { job_id: jobBatchId });

    const newTotal = currentTotal + 1;
    if (newTotal >= (existingJob?.total_batches || 0)) {
      const finalStatus =
        (existingJob?.completed_batches || 0) > 0
          ? "completed_with_errors"
          : "failed";

      await supabase
        .from("job_batches")
        .update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
          error_message: failureReason,
        })
        .eq("id", jobBatchId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//                         EMAIL NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

function buildTemplateVars(prompts) {
  return {
    appUrl: process.env.APP_URL,
    dashboardUrl: `${process.env.APP_URL}/projects/${prompts[0].projectId}`,
    unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
    year: new Date().getFullYear(),
    prompts: prompts.map((p) => p.text),
  };
}

async function sendSubmissionEmail(email, batchNumber, totalBatches, prompts) {
  const templateVars = buildTemplateVars(prompts);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: `Batch ${batchNumber + 1}/${totalBatches} submitted - ${
      prompts.length
    } prompts are being analyzed`,
    template: "batch_submitted",
    "h:X-Mailgun-Variables": JSON.stringify(templateVars),
  });
}

async function sendFailureEmail(email, batchNumber, totalBatches, prompts) {
  const templateVars = buildTemplateVars(prompts);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: `Batch ${batchNumber + 1}/${totalBatches} failed - ${
      prompts.length
    } prompts could not be processed`,
    template: "batch failed",
    "h:X-Mailgun-Variables": JSON.stringify(templateVars),
  });
}

// ═══════════════════════════════════════════════════════════════
//                         PROMPT PROCESSING
// ═══════════════════════════════════════════════════════════════

async function processPrompt(prompt, config) {
  const {
    userCountry,
    webSearch,
    user_id,
    openaiKey,
    openaiModel,
    email,
    batchNumber,
    totalBatches,
    jobBatchId,
    isNightly,
  } = config;

  const customData = {
    user_id,
    openaiKey,
    openaiModel,
    email,
    userCountry,
    webSearch,
    batchNumber,
    totalBatches,
    jobBatchId,
    isNightly,
  };

  if (isNightly) {
    customData.promptId = prompt.id;
    customData.projectId = prompt.projectId;
  }

  const taskId = await submitDataForSeoTask(
    prompt.text,
    userCountry,
    webSearch,
    customData
  );

  if (isNightly) {
    console.log(`Nightly task ${taskId} created for prompt ${prompt.id}`);
  } else {
    await updateTrackingResult(prompt.trackingId, {
      snapshot_id: taskId,
      status: "processing",
    });
  }

  return { ...prompt, taskId };
}

async function handlePromptFailure(prompt, error, isNightly) {
  console.error(`Failed to submit task for prompt "${prompt.text}":`, error);

  if (!isNightly && prompt.trackingId) {
    try {
      await updateTrackingResult(prompt.trackingId, {
        status: "failed",
        response: JSON.stringify({
          error: error.message,
          service: "DataForSEO",
        }),
      });
    } catch (updateErr) {
      console.error("Error marking prompt as failed:", updateErr);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//                         ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

function getFailureReason(error) {
  if (error.message.includes("DataForSEO")) {
    return "DataForSEO API error occurred during task submission.";
  }
  if (error.message.includes("OpenAI")) {
    return "OpenAI API error occurred during validation.";
  }
  if (error.status === 429) {
    return "Rate limit exceeded. Please try again later.";
  }
  return "Unknown error occurred during processing";
}

function isRetryableError(error) {
  return (
    error.status === 429 ||
    error.status >= 500 ||
    error.code === "ECONNRESET" ||
    error.code === "ETIMEDOUT" ||
    error.message.includes("network") ||
    error.message.includes("timeout")
  );
}

// ═══════════════════════════════════════════════════════════════
//                         MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

const subscription = pubsub.subscription(dataForSEOSubscription);

subscription.on("message", async (message) => {
  const {
    openaiKey,
    email,
    openaiModel = "gpt-4",
    prompts = [],
    isNightly = false,
    jobBatchId = null,
    batchNumber = 0,
    totalBatches = 1,
    userCountry = "US",
    webSearch = false,
    user_id,
    service,
  } = JSON.parse(message.data.toString());

  // Filter for DataForSEO messages only
  if (service && service.toLowerCase() !== "dataforseo") {
    message.ack();
    return;
  }

  console.log(
    `Processing ${isNightly ? "nightly" : "regular"} batch ${
      batchNumber + 1
    }/${totalBatches} with ${prompts.length} prompts`
  );

  const openai = createOpenAI(openaiKey);
  const config = {
    userCountry,
    webSearch,
    user_id,
    openaiKey,
    openaiModel,
    email,
    batchNumber,
    totalBatches,
    jobBatchId,
    isNightly,
  };

  try {
    // Process all prompts
    const processedPrompts = [];

    for (const prompt of prompts) {
      try {
        const processedPrompt = await processPrompt(prompt, config);
        processedPrompts.push(processedPrompt);
        console.log(
          `Task ${processedPrompt.taskId} submitted for prompt: "${prompt.text}"`
        );

        // Rate limit delay
        await delay(1000);
      } catch (promptError) {
        await handlePromptFailure(prompt, promptError, isNightly);
      }
    }

    console.log(
      `Successfully submitted ${processedPrompts.length}/${prompts.length} tasks to DataForSEO`
    );

    // Update job batch status for regular jobs
    if (!isNightly && jobBatchId) {
      await updateJobBatchStatus(jobBatchId, "processing");

      // Send submission notification
      try {
        await sendSubmissionEmail(email, batchNumber, totalBatches, prompts);
        console.log(
          `Submission email sent for batch ${batchNumber + 1}/${totalBatches}`
        );
      } catch (emailErr) {
        console.error("Error sending submission email:", emailErr);
      }
    }

    message.ack();
    console.log(
      `Processed ${isNightly ? "nightly" : "regular"} batch ${
        batchNumber + 1
      }/${totalBatches} for job ${jobBatchId || "N/A"}`
    );
  } catch (err) {
    console.error("Worker error:", err);

    const failureReason = getFailureReason(err);

    // Handle failures for regular jobs only
    if (!isNightly) {
      try {
        // Mark tracking results as failed
        if (jobBatchId && typeof batchNumber !== "undefined") {
          await markTrackingResultsFailed(jobBatchId, batchNumber, err.message);
        }

        // Update job batch failure status
        if (jobBatchId) {
          await handleJobBatchFailure(jobBatchId, failureReason);
        }

        // Send failure email
        if (jobBatchId && typeof batchNumber !== "undefined") {
          try {
            await sendFailureEmail(email, batchNumber, totalBatches, prompts);
            console.log(
              `Failure email sent for batch ${batchNumber + 1}/${totalBatches}`
            );
          } catch (emailErr) {
            console.error("Error sending failure email:", emailErr);
          }
        }
      } catch (updateErr) {
        console.error("Error updating failure status:", updateErr);
      }
    } else {
      console.log(
        `Nightly job failed for batch ${batchNumber + 1}/${totalBatches}: ${
          err.message
        }`
      );
    }

    // Handle message acknowledgment based on error type
    if (isRetryableError(err)) {
      console.log(
        `Retryable error for job ${jobBatchId}, batch ${batchNumber + 1}: ${
          err.message
        }`
      );
      message.nack();
    } else {
      console.log(
        `Non-retryable error for job ${jobBatchId}, batch ${batchNumber + 1}: ${
          err.message
        }`
      );
      message.ack();
    }
  }
});

subscription.on("error", (err) => console.error("Subscription error:", err));
