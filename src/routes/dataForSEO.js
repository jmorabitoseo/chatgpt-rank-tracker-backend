const express = require("express");
const { supabase, createOpenAI } = require("../config");
const {
  countBrandMatches,
  countDomainMatches,
  analyzeSentimentAndSalience,
} = require("../utils/analysis");
const { getBatchPromptAIVolume } = require("../utils/dataForSeoService");
const nodemailer = require("nodemailer");
const mgTransport = require("nodemailer-mailgun-transport");
const { sanitizeText } = require("../utils/textSanitizer");
const { retryWithBackoff } = require("../utils/apiHelpers");
const { EnhancedAnalyzer } = require("../utils/EnhancedAnalyzer");

const router = express.Router();
const {
  cleanDomain,
  extractDomainFromUrl,
  cleanUrlKeepPath,
  formatCitationsForDB
} = require('../utils/urlUtils');

// ───────────── CONFIGURATION ─────────────

// ───────────── SMTP via Mailgun transport ─────────────
const transporter = nodemailer.createTransport(
  mgTransport({
    auth: {
      api_key: process.env.MG_API_KEY,
      domain: process.env.MG_DOMAIN,
    },
  })
);

// ───────────── UTILITY FUNCTIONS ─────────────

/**
 * Extract citations from DataForSEO response
 */
function extractCitations(dataForSeoResponse) {
  const citations = [];

  // Extract from sources
  if (dataForSeoResponse?.tasks[0]?.result[0]?.sources) {
    dataForSeoResponse.tasks[0].result[0].sources.forEach((source) => {
      if (source.url) {
        citations.push({
          url: source.url,
          title: source.title || "",
          domain: source.domain || "",
          snippet: source.snippet || "",
        });
      }
    });
  }

  // Extract from search results
  if (dataForSeoResponse.result?.[0]?.search_results) {
    dataForSeoResponse.result[0].search_results.forEach((result) => {
      if (result.url) {
        citations.push({
          url: result.url,
          title: result.title || "",
          domain: result.domain || "",
          snippet: result.description || "",
        });
      }
    });
  }

  return citations;
}

/**
 * Format citations for database storage (only title, domain, and url)
 */
// Use shared formatCitationsForDB from utils/urlUtils

/**
 * Extract query parameters from request
 */
function extractQueryParameters(req) {
  try {
    const userId = req.query.userId || req.query.user_id;
    const openaiModel = req.query.model || req.query.openaiModel || "gpt-4";
    const isNightly =
      req.query.isNightly === "true" || req.query.is_nightly === "true";
    const promptId = req.query.promptId || req.query.prompt_id;
    const projectId = req.query.projectId || req.query.project_id;

    return { userId, openaiModel, isNightly, promptId, projectId };
  } catch (error) {
    console.warn("[DataForSEO] Failed to parse query parameters:", error.message);
    return {
      userId: null,
      openaiModel: "gpt-4",
      isNightly: false,
      promptId: null,
      projectId: null,
    };
  }
}

/**
 * Fetch OpenAI key for user
 */
async function fetchUserOpenAIKey(userId) {
  if (!userId) {
    console.warn("[DataForSEO] No user_id provided in callback URL");
    return null;
  }

  try {
    const { data: userSettings, error } = await supabase
      .from("user_settings")
      .select("openai_key")
      .eq("user_id", userId)
      .single();

    if (error) {
      console.error(`[DataForSEO] Error fetching user settings for user ${userId}:`, error.message);
      return null;
    }

    if (!userSettings?.openai_key) {
      console.warn(`[DataForSEO] No OpenAI key found for user ${userId}`);
      return null;
    }

    return userSettings.openai_key;
  } catch (error) {
    console.error(`[DataForSEO] Unexpected error fetching OpenAI key for user ${userId}:`, error.message);
    return null;
  }
}

/**
 * Extract user country from task data
 */
function extractUserCountry(task) {
  try {
    if (task.data?.location_name) {
      return task.data.location_name;
    }
    return null;
  } catch (error) {
    console.warn("[DataForSEO] Failed to extract userCountry:", error.message);
    return null;
  }
}

/**
 * Detect if actual web search occurred from DataForSEO response
 * This checks the actual response data, not just the requested flag from the checkbox.
 * The presence of sources or search_results indicates the AI performed web retrieval.
 */
function detectActualWebSearch(dataForSeoResponse) {
  try {
    const task = dataForSeoResponse.tasks?.[0];
    // Check if user requested a forced web search; treated as actual retrieval
    // const forceRequested = Boolean(task?.data?.force_web_search);
    const result = task?.result?.[0];
    if (!result && !forceRequested) {
      return false;
    }
    // Check if sources/citations exist (indicates web retrieval occurred)
    const hasSources = Array.isArray(result?.sources) && result.sources.length > 0;
    const hasSearchResults = Array.isArray(result?.search_results) && result.search_results.length > 0;
    // Determine if web search occurred
    const occurred = hasSources || hasSearchResults;
    return Boolean(occurred);
  } catch (error) {
    console.warn("[DataForSEO] Failed to detect actual web search:", error.message);
    return false;
  }
}

/**
 * Normalize brand mentions to array format
 */
function normalizeBrandMentions(brandMentions) {
  if (typeof brandMentions === "string") {
    return [brandMentions];
  }
  if (!Array.isArray(brandMentions)) {
    return [];
  }
  return brandMentions;
}

/**
 * Perform sentiment analysis if conditions are met
 */
async function performSentimentAnalysis(
  shouldAnalyze,
  openaiKey,
  answerText,
  brandMentions,
  openaiModel,
  taskId
) {
  if (!shouldAnalyze || !openaiKey) {
    if (shouldAnalyze && !openaiKey) {
      console.warn(`[DataForSEO] Brand mentioned but no OpenAI key available for sentiment analysis (task: ${taskId})`);
    }
    return { sentiment: 0, salience: 0 };
  }

  try {
    const openai = createOpenAI(openaiKey);
    const analysisResult = await retryWithBackoff(
      () =>
        analyzeSentimentAndSalience(
          answerText,
          brandMentions,
          openai,
          openaiModel
        ),
      5,
      `Sentiment analysis for task "${taskId}"`
    );

    return {
      sentiment: analysisResult.sentiment,
      salience: analysisResult.salience,
    };
  } catch (error) {
    console.error(`[DataForSEO] Analysis failed for task ${taskId}:`, error.message);
    return { sentiment: 0, salience: 0 };
  }
}

/**
 * Fetch AI volume data for prompt
 */
async function fetchAIVolumeData(promptText, taskId) {
  try {
    const promptTexts = [promptText];
    const aiVolumeResults = await getBatchPromptAIVolume(promptTexts, 2840);

    if (aiVolumeResults && aiVolumeResults.length > 0) {
      return aiVolumeResults[0];
    }
    return null;
  } catch (error) {
    console.warn(`[DataForSEO] AI volume fetch failed for task ${taskId}:`, error.message);
    return null;
  }
}

// ───────────── JOB BATCH MANAGEMENT ─────────────

/**
 * Handle job batch progress and completion for regular (non-nightly) jobs
 */
async function handleJobBatchProgress(trackingResult) {
  if (
    !trackingResult.job_batch_id ||
    trackingResult.source?.includes("Nightly")
  ) {
    return;
  }

  try {
    // Get job batch info
    const { data: jobBatch, error } = await supabase
      .from("job_batches")
      .select("completed_batches, total_batches, failed_batches, email")
      .eq("id", trackingResult.job_batch_id)
      .single();

    if (error || !jobBatch) {
      return;
    }

    // Increment completed batches
    const currentTotal =
      (jobBatch.completed_batches || 0) + (jobBatch.failed_batches || 0);
    if (currentTotal < (jobBatch.total_batches || 0)) {
      await supabase.rpc("increment_completed_batches", {
        job_id: trackingResult.job_batch_id,
      });

      const newTotal = currentTotal + 1;

      // Check if job is complete
      if (newTotal >= (jobBatch.total_batches || 0)) {
        const finalStatus =
          (jobBatch.failed_batches || 0) > 0
            ? "completed_with_errors"
            : "completed";

        await supabase
          .from("job_batches")
          .update({
            status: finalStatus,
            completed_at: new Date().toISOString(),
          })
          .eq("id", trackingResult.job_batch_id);

        // Send completion email
        await sendCompletionEmail(jobBatch.email, trackingResult);
      }
    }
  } catch (error) {
    console.error("[DataForSEO] Error updating job batch progress:", error.message);
  }
}

/**
 * Handle failed job batch progress for regular (non-nightly) jobs
 */
async function handleFailedJobBatch(trackingResult, task) {
  if (
    !trackingResult.job_batch_id ||
    trackingResult.source?.includes("Nightly")
  ) {
    return;
  }

  try {
    const { data: jobBatch } = await supabase
      .from("job_batches")
      .select("failed_batches, total_batches, completed_batches")
      .eq("id", trackingResult.job_batch_id)
      .single();

    if (!jobBatch) {
      return;
    }

    const currentTotal =
      (jobBatch.failed_batches || 0) + (jobBatch.completed_batches || 0);
    if (currentTotal < (jobBatch.total_batches || 0)) {
      await supabase.rpc("increment_failed_batches", {
        job_id: trackingResult.job_batch_id,
      });

      const newTotal = currentTotal + 1;
      if (newTotal >= (jobBatch.total_batches || 0)) {
        const finalStatus =
          (jobBatch.completed_batches || 0) > 0
            ? "completed_with_errors"
            : "failed";

        await supabase
          .from("job_batches")
          .update({
            status: finalStatus,
            completed_at: new Date().toISOString(),
            error_message:
              task.status_message || "DataForSEO processing failed",
          })
          .eq("id", trackingResult.job_batch_id);
      }
    }
  } catch (error) {
    console.error("[DataForSEO] Error updating job batch failure:", error.message);
  }
}

/**
 * Send completion email for regular (non-nightly) jobs
 */
async function sendCompletionEmail(email, trackingResult) {
  if (!email) {
    return;
  }

  try {
    const templateVars = {
      appUrl: process.env.APP_URL,
      dashboardUrl: `${process.env.APP_URL}/projects/${trackingResult.project_id}`,
      taskID: trackingResult.id,
      unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
      year: new Date().getFullYear(),
    };

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: `Analysis completed - Job ${trackingResult.job_batch_id}`,
      template: process.env.MAILGUN_TEMPLATE_NAME,
      "h:X-Mailgun-Variables": JSON.stringify(templateVars),
    });
  } catch (error) {
    console.error("[DataForSEO] Error sending completion email:", error.message);
  }
}

// ───────────── ERROR HANDLING ─────────────

/**
 * Handle error by updating tracking result to failed state
 * Only for regular (non-nightly) jobs since nightly jobs don't have existing tracking results
 */
async function handleTrackingResultError(error, trackingResult) {
  if (!trackingResult) {
    console.warn("[DataForSEO] Cannot handle error: missing trackingResult");
    return;
  }

  try {
    const errorResponse = {
      error: error.message || "Unknown error occurred during processing"
    };

    const updateData = {
      status: "failed",
      response: JSON.stringify(errorResponse),
      timestamp: Date.now(),
    };

    const { error: updateError } = await supabase
      .from("tracking_results")
      .update(updateData)
      .eq("id", trackingResult.id);

    if (updateError) {
      console.error(`[DataForSEO] Error updating tracking result ${trackingResult.id} to failed state:`, updateError.message);
    }
  } catch (handleError) {
    console.error(`[DataForSEO] Error in handleTrackingResultError for tracking result ${trackingResult.id}:`, handleError.message);
  }
}

/**
 * Handle database update errors by forcing tracking result to failed state
 * This is a critical fallback to prevent tracking results from staying in processing state
 */
async function handleDatabaseUpdateError(updateError, trackingResult) {
  if (!trackingResult) {
    console.warn("[DataForSEO] Cannot handle database update error: missing trackingResult");
    return;
  }

  try {
    const errorResponse = {
      error: `Database update failed: ${updateError.message || "Unknown database error"}`
    };

    const fallbackUpdateData = {
      status: "failed",
      response: JSON.stringify(errorResponse),
      timestamp: Date.now(),
    };

    // Force update with minimal data to ensure status is set to failed
    const { error: fallbackError } = await supabase
      .from("tracking_results")
      .update(fallbackUpdateData)
      .eq("id", trackingResult.id);

    if (fallbackError) {
      console.error(`[DataForSEO] CRITICAL: Failed to update tracking result ${trackingResult.id} to failed state even with fallback:`, fallbackError.message);
      // At this point, we've exhausted all options to update the record
      // The tracking result may remain in processing state, but we've logged the issue
    }
  } catch (criticalError) {
    console.error(`[DataForSEO] CRITICAL: Error in handleDatabaseUpdateError for tracking result ${trackingResult.id}:`, criticalError.message);
  }
}

// ───────────── NIGHTLY JOB MANAGEMENT ─────────────

/**
 * Create new tracking result for nightly jobs
 */
async function createNightlyTrackingResult(
  promptData,
  taskId,
  userId,
  answerText,
  citations,
  match,
  domainMatch,
  sentiment,
  salience,
  aiVolumeData,
  summary,
  webSearch
) {
  try {
    // Format citations for database storage
    const formattedCitations = formatCitationsForDB(citations);
    
    const insertData = {
      prompt_id: promptData.promptId,
      prompt: promptData.prompt,
      project_id: promptData.projectId,
      user_id: userId,
      snapshot_id: taskId,
      status: "fulfilled",
      timestamp: Date.now(),
      is_present: match.anyMatch,
      is_domain_present: domainMatch.anyMatch,
      sentiment,
      salience,
      response: JSON.stringify({
        answer_text: answerText,
      }),
      citations: formattedCitations, // Store formatted citations in dedicated field
      brand_mentions: promptData.brandMentions,
      domain_mentions: promptData.domainMentions,
      brand_name: String(promptData.brandMentions),
      source: "DataForSEO (Nightly)",
      mention_count: match.totalMatches,
      domain_mention_count: domainMatch.totalMatches,
      serp: summary.serp,
      intent_classification: summary.intentClassification,
      lcp: summary.lcp,
      actionability: summary.actionability,
      web_search: webSearch, // This is now actualWebSearchOccurred passed from caller
    };

    // Add AI volume data if available
    if (aiVolumeData) {
      insertData.ai_search_volume = aiVolumeData.current_volume;
      insertData.ai_monthly_trends = aiVolumeData.monthly_trends;
      insertData.ai_volume_fetched_at = new Date().toISOString();
      insertData.ai_volume_location_code = aiVolumeData.location_code || 2840;
    }

    const { error: insertErr } = await supabase
      .from("tracking_results")
      .insert([insertData]);

    if (insertErr) {
      console.error(`[DataForSEO] Error creating nightly tracking result for task ${taskId}:`, insertErr.message);
      console.error(`[DataForSEO] CRITICAL: Failed to create nightly tracking result for task ${taskId}. This may result in lost data.`);
      throw insertErr;
    }
    return insertData;
  } catch (error) {
    console.error(`[DataForSEO] Failed to create nightly tracking result for task ${taskId}:`, error.message);
    throw error;
  }
}


// ───────────── MAIN CALLBACK ROUTE ─────────────

router.post("/callback", async (req, res) => {
  let taskId = null;
  let isNightly = false;
  let trackingResult = null;
  let promptData = null;

  try {
    const dataForSeoResponse = req.body;
    // Validate callback data
    if (!dataForSeoResponse?.tasks?.length) {
      console.error("[DataForSEO] Invalid callback data");
      return res.status(400).json({ error: "Invalid callback data" });
    }

    const task = dataForSeoResponse.tasks[0];
    taskId = task.id;
    const status = task.status_code;

    // Extract parameters
    const { userId, openaiModel, isNightly: isNightlyParam, promptId, projectId } =
      extractQueryParameters(req);
    isNightly = isNightlyParam;
    const openaiKey = await fetchUserOpenAIKey(userId);
    const userCountry = extractUserCountry(task);
    const actualWebSearchOccurred = detectActualWebSearch(dataForSeoResponse);

    // For nightly jobs, we need to get prompt data differently since there's no existing tracking_result
    if (isNightly) {
      // For nightly jobs, get prompt data from the prompts table
      if (!promptId) {
        console.error(`[DataForSEO] Nightly job missing promptId for task ${taskId}`);
        return res.status(400).json({ error: "Missing promptId for nightly job" });
      }

      const { data: prompt, error: promptError } = await supabase
        .from("prompts")
        .select("*")
        .eq("id", promptId)
        .single();

      if (promptError || !prompt) {
        console.error(`[DataForSEO] Error fetching prompt ${promptId} for nightly job:`, promptError?.message);
        return res.status(404).json({ error: "Prompt not found for nightly job" });
      }

      promptData = {
        promptId: prompt.id,
        prompt: prompt.text,
        projectId: prompt.project_id,
        brandMentions: prompt.brand_mentions || [],
        domainMentions: prompt.domain_mentions || [],
      };
    } else {
      // For regular jobs, find existing tracking result
      const { data: trackingResults, error: findError } = await supabase
        .from("tracking_results")
        .select("*")
        .eq("snapshot_id", taskId);

      if (findError) {
        console.error("[DataForSEO] Error finding tracking result:", findError.message);
        return res.status(500).json({ error: "Database error" });
      }

      if (!trackingResults?.length) {
        console.warn(`[DataForSEO] No tracking result found for task ${taskId}`);
        return res.status(404).json({ error: "Tracking result not found" });
      }

      trackingResult = trackingResults[0];
    }

    // Handle successful completion
    if (status === 20000 && task.result?.length > 0) {
      try {
        const result = task.result[0];
        const answerText = sanitizeText(result.markdown || "");
        const citations = extractCitations(dataForSeoResponse);

        // Get brand mentions from appropriate source
        const brandMentions = normalizeBrandMentions(
          isNightly ? promptData.brandMentions : trackingResult.brand_mentions
        );

        // Get domain mentions from appropriate source
        const domainMentions = isNightly
          ? promptData.domainMentions
          : trackingResult.domain_mentions;

        // Count matches
        const match = countBrandMatches(brandMentions, answerText);
        const domainMatch = countDomainMatches(domainMentions, citations);

        // Perform sentiment analysis
        const { sentiment, salience } = await performSentimentAnalysis(
          match.anyMatch,
          openaiKey,
          answerText,
          brandMentions,
          openaiModel,
          taskId
        );
        const serpAnalyzer = new EnhancedAnalyzer();
        const analyzerResult = serpAnalyzer.analyzeResponse(dataForSeoResponse);

        // Pull out the summary
        const { summary } = analyzerResult;

        // Fetch AI volume data
        const promptText = isNightly ? promptData.prompt : trackingResult.prompt;
        const aiVolumeData = await fetchAIVolumeData(promptText, taskId);

      if (isNightly) {
        // Create new tracking result for nightly job
        await createNightlyTrackingResult(
          promptData,
          taskId,
          userId,
          answerText,
          citations,
          match,
          domainMatch,
          sentiment,
          salience,
          aiVolumeData,
          summary,
          actualWebSearchOccurred
        );
      } else {
        // Format citations for database storage
        const formattedCitations = formatCitationsForDB(citations);
        
        // Update existing tracking result for regular job
        const updateData = {
          status: "fulfilled",
          timestamp: Date.now(),
          is_present: match.anyMatch,
          is_domain_present: domainMatch.anyMatch,
          sentiment,
          salience,
          response: JSON.stringify({
            answer_text: answerText,
            raw_response: result,
          }),
          citations: formattedCitations, // Store formatted citations in dedicated field
          mention_count: match.totalMatches,
          domain_mention_count: domainMatch.totalMatches,
          source: "DataForSEO",
          user_id: userId,
          intent_classification: summary.intentClassification,
          lcp: summary.lcp,
          actionability: summary.actionability,
          serp: summary.serp,
          web_search: actualWebSearchOccurred,
        };

        // Add AI volume data if available
        if (aiVolumeData) {
          updateData.ai_search_volume = aiVolumeData.current_volume;
          updateData.ai_monthly_trends = aiVolumeData.monthly_trends;
          updateData.ai_volume_fetched_at = new Date().toISOString();
          updateData.ai_volume_location_code =
            aiVolumeData.location_code || 2840;
        }

        // Update tracking result
        const { error: updateError } = await supabase
          .from("tracking_results")
          .update(updateData)
          .eq("id", trackingResult.id);

        if (updateError) {
          console.error(`[DataForSEO] Error updating tracking result ${trackingResult.id}:`, updateError.message);
          
          // Critical: Update tracking result to failed state even if database update fails
          await handleDatabaseUpdateError(updateError, trackingResult);
          
          return res.status(500).json({ error: "Failed to update tracking result" });
        }
        // Handle job batch progress (only for regular jobs)
        await handleJobBatchProgress(trackingResult);
      }
      } catch (processingError) {
        console.error(`[DataForSEO] Error processing successful task ${taskId}:`, processingError.message);
        
        // Handle error by updating tracking result to failed state
        // Only for regular (non-nightly) jobs since nightly jobs don't have existing tracking results
        if (!isNightly && trackingResult) {
          await handleTrackingResultError(processingError, trackingResult);
        }
        
        return res.status(500).json({
          error: "Error processing task result",
          message: processingError.message,
        });
      }
    } else {
      // Handle all non-success cases (status !== 20000 or no results)
      // CRITICAL: Any error condition must update status to "failed"
      
      let errorMessage = "";
      
      if (status === 20000 && (!task.result || task.result.length === 0)) {
        errorMessage = "Task completed successfully but no results returned";
        console.error(`[DataForSEO] Task ${taskId} completed successfully but no results returned`);
      } else if (typeof status === "number" && status < 40000 && status !== 20000) {
        errorMessage = `Task ${taskId} failed during processing with status ${status}`;
        console.error(`[DataForSEO] Task ${taskId} failed during processing with status ${status}`);
      } else {
        errorMessage = task.status_message || `DataForSEO task failed with status ${status}`;
        console.error(`[DataForSEO] Task ${taskId} failed with status ${status}`);
      }

      if (isNightly) {
        // For nightly jobs, do not create any tracking result on failure
        console.log(`[DataForSEO] Nightly job ${taskId} failed - no tracking result created`);
      } else {
        // Handle regular job failure - update existing tracking result
        // Check current status to avoid downgrading fulfilled records
        const { data: current, error: currentErr } = await supabase
          .from("tracking_results")
          .select("status")
          .eq("id", trackingResult.id)
          .single();

        if (!currentErr && current?.status === "fulfilled") {
          console.warn(`[DataForSEO] Received failure for already fulfilled tracking ${trackingResult.id}. Ignoring.`);
          return res.status(200).json({
            status: "success",
            message: `Task ${taskId} already fulfilled; ignoring late failure`,
          });
        }

        // Update as failed - CRITICAL: Always update status to failed for any error
        const updateData = {
          status: "failed",
          timestamp: Date.now(),
          is_present: false,
          sentiment: 0,
          salience: 0,
          response: JSON.stringify({
            error: errorMessage,
            task_status: status,
            raw_response: task,
          }),
          mention_count: 0,
          domain_mention_count: 0,
          user_id: userId,
        };

        const { error: updateError } = await supabase
          .from("tracking_results")
          .update(updateData)
          .eq("id", trackingResult.id);

        if (updateError) {
          console.error(`[DataForSEO] Error updating failed tracking result ${trackingResult.id}:`, updateError.message);
          
          // Critical: Update tracking result to failed state even if database update fails
          await handleDatabaseUpdateError(updateError, trackingResult);
          
          return res.status(500).json({ error: "Failed to update tracking result" });
        }

        // Handle failed job batch (only for regular jobs)
        await handleFailedJobBatch(trackingResult, task);
      }

      return res.status(200).json({
        status: "success",
        message: `Task ${taskId} processed with error: ${errorMessage}`,
        task_status: status,
      });
    }

    // Return success response
    res.status(200).json({
      status: "success",
      message: `Task ${taskId} processed successfully`,
      userId,
      userCountry,
      hasOpenAIKey: !!openaiKey,
      isNightly,
    });
  } catch (error) {
    console.error("[DataForSEO] Unexpected error:", error.message);
    
    // Handle error by updating tracking result to failed state
    // Only for regular (non-nightly) jobs since nightly jobs don't have existing tracking results
    if (!isNightly && trackingResult) {
      await handleTrackingResultError(error, trackingResult);
    }
    
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
});

module.exports = router;
