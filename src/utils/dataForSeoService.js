// src/utils/dataForSeoService.js
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const BASE_URL = "https://api.dataforseo.com/v3";
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;

// Create Basic Auth header
const authHeader = () =>
  "Basic " +
  Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString("base64");

/**
 * Extract meaningful keywords from a prompt text
 * @param {string} prompt - The prompt text to analyze
 * @returns {string[]} - Array of extracted keywords
 */
function extractKeywordsFromPrompt(prompt) {
  if (!prompt || typeof prompt !== "string") {
    return [];
  }

  // Remove common question words and phrases
  const commonWords = [
    "what",
    "when",
    "where",
    "why",
    "how",
    "who",
    "which",
    "can",
    "could",
    "would",
    "should",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "shall",
    "should",
    "may",
    "might",
    "must",
    "ought",
    "need",
    "dare",
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "about",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "up",
    "down",
    "out",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "any",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "tell",
    "me",
    "about",
    "give",
    "show",
    "find",
    "search",
    "look",
    "recommend",
    "suggest",
    "best",
    "good",
    "great",
    "top",
    "popular",
    "recommended",
    "review",
    "reviews",
  ];

  // Clean and split the prompt
  let cleanPrompt = prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // Replace punctuation with spaces
    .replace(/\s+/g, " ") // Replace multiple spaces with single space
    .trim();

  // Split into words and filter
  let words = cleanPrompt
    .split(" ")
    .filter((word) => word.length > 2) // Remove very short words
    .filter((word) => !commonWords.includes(word)) // Remove common words
    .filter((word) => !/^\d+$/.test(word)); // Remove pure numbers

  // Remove duplicates and limit to most relevant terms
  words = [...new Set(words)];

  // Try to identify meaningful phrases (2-3 words)
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) {
    const twoWordPhrase = `${words[i]} ${words[i + 1]}`;
    phrases.push(twoWordPhrase);

    if (i < words.length - 2) {
      const threeWordPhrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      phrases.push(threeWordPhrase);
    }
  }

  // Combine individual words and phrases, prioritize phrases
  const allKeywords = [...phrases.slice(0, 3), ...words.slice(0, 5)];

  // Limit to avoid API cost explosion (max 5 keywords per prompt)
  return allKeywords.slice(0, 5);
}

/**
 * Fetch AI search volume data for keywords from DataForSEO
 * @param {string[]} keywords - Array of keywords to analyze
 * @param {number} locationCode - Location code (default: 2840 for USA)
 * @param {string} languageCode - Language code (default: 'en')
 * @returns {Promise<Object>} - AI volume data response
 */
async function fetchAIKeywordVolume(
  keywords,
  locationCode = 2840,
  languageCode = "en"
) {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error("DataForSEO credentials not configured");
  }

  if (!keywords || keywords.length === 0) {
    throw new Error("No keywords provided for AI volume analysis");
  }

  // Filter out empty keywords and limit to reasonable batch size
  const validKeywords = keywords
    .filter((keyword) => keyword && keyword.trim().length > 0)
    .slice(0, 20); // Limit batch size to control costs

  if (validKeywords.length === 0) {
    throw new Error("No valid keywords found for AI volume analysis");
  }

  const payload = [
    {
      keywords: validKeywords,
      location_code: locationCode,
      language_name: "English",
      language_code: languageCode,
    },
  ];

  try {
    const response = await axios.post(
      `${BASE_URL}/ai_optimization/ai_keyword_data/keywords_search_volume/live`,
      payload,
      {
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30 second timeout
      }
    );

    // Validate response structure
    if (
      !response.data ||
      !response.data.tasks ||
      response.data.tasks.length === 0
    ) {
      throw new Error("Invalid response structure from DataForSEO API");
    }

    const task = response.data.tasks[0];
    if (task.status_code !== 20000) {
      throw new Error(
        `DataForSEO API error: ${task.status_message || "Unknown error"}`
      );
    }

    if (!task.result || task.result.length === 0) {
      console.warn(
        "DataForSEO returned no results for keywords:",
        validKeywords
      );
      return null;
    }

    return {
      success: true,
      data: task.result[0], // First (and typically only) result
      cost: response.data.cost || 0,
      keywords: validKeywords,
      location_code: locationCode,
      language_code: languageCode,
    };
  } catch (error) {
    console.error("DataForSEO API error:", error.message);

    // Handle specific error types
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.message;

      if (status === 401) {
        throw new Error("DataForSEO authentication failed - check credentials");
      } else if (status === 402) {
        throw new Error(
          "DataForSEO insufficient credits - please top up your account"
        );
      } else if (status === 429) {
        throw new Error(
          "DataForSEO rate limit exceeded - please try again later"
        );
      } else {
        throw new Error(`DataForSEO API error (${status}): ${message}`);
      }
    }

    throw new Error(`DataForSEO request failed: ${error.message}`);
  }
}

/**
 * Process AI volume data and extract relevant metrics
 * @param {Object} volumeData - Raw data from DataForSEO API
 * @returns {Object} - Processed volume metrics
 */
function processAIVolumeData(volumeData) {
  if (!volumeData || !volumeData.items || volumeData.items.length === 0) {
    return null;
  }

  // Sum current volumes and aggregate monthly volumes per month
  let totalCurrentVolume = 0;
  const monthlyMap = new Map();
  const processedKeywords = [];

  for (const item of volumeData.items) {
    // Process ALL items, not just those with volume > 0
    totalCurrentVolume += item.ai_search_volume || 0;
    processedKeywords.push(item.keyword);
    if (Array.isArray(item.ai_monthly_searches)) {
      for (const {
        year,
        month,
        ai_search_volume,
      } of item.ai_monthly_searches) {
        const key = `${year}-${month}`;
        const existing = monthlyMap.get(key) || {
          year,
          month,
          ai_search_volume: 0,
        };
        existing.ai_search_volume += ai_search_volume || 0;
        monthlyMap.set(key, existing);
      }
    }
  }

  // Don't return null for zero volume - this means we got a successful response with zero data
  // if (totalCurrentVolume === 0) {
  //   return null;
  // }

  // Build and sort unique monthly data (newest first)
  const allMonthlyData = Array.from(monthlyMap.values())
    .sort(
      (a, b) => new Date(b.year, b.month - 1) - new Date(a.year, a.month - 1)
    )
    .slice(0, 12);

  // Calculate metrics
  const volumes = allMonthlyData.map((i) => i.ai_search_volume);
  const averageVolume = volumes.length
    ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
    : 0;
  const peakVolume = volumes.length ? Math.max(...volumes) : 0;

  return {
    current_volume: totalCurrentVolume,
    average_volume: averageVolume,
    peak_volume: peakVolume,
    monthly_trends: allMonthlyData,
    data_points: allMonthlyData.length,
    keywords: processedKeywords,
    location_code: volumeData.location_code,
    language_code: volumeData.language_code,
  };
}

/**
 * Get AI volume data for a single prompt
 * @param {string} prompt - The prompt to analyze
 * @param {number} locationCode - Location code for search volume
 * @returns {Promise<Object|null>} - Processed AI volume data or null
 */
async function getPromptAIVolume(prompt, locationCode = 2840) {
  try {
    // Extract keywords from prompt UNCOMMENT TO USE KEYWORD EXTRACTION
    // const keywords = extractKeywordsFromPrompt(prompt);

    // if (keywords.length === 0) {
    //   console.warn('No keywords extracted from prompt:', prompt);
    //   return null;
    // }
    // Use full prompt as keyword (lowercase for API consistency)
    const keywords = [prompt.toLowerCase()];

    // Fetch volume data
    const volumeResponse = await fetchAIKeywordVolume(keywords, locationCode);

    if (!volumeResponse || !volumeResponse.success) {
      return null;
    }

    // Process and return the data
    return processAIVolumeData(volumeResponse.data);
  } catch (error) {
    console.error("Error getting AI volume for prompt:", prompt, error.message);
    return null;
  }
}

/**
 * Get AI volume data for multiple prompts (batch processing)
 * @param {string[]} prompts - Array of prompts to analyze
 * @param {number} locationCode - Location code for search volume
 * @returns {Promise<Object[]>} - Array of processed AI volume data
 */
async function getBatchPromptAIVolume(prompts, locationCode = 2840) {
  if (!prompts || prompts.length === 0) {
    return [];
  }

  try {
    // Extract all keywords from all prompts
    const allKeywords = [];
    const promptKeywordMap = new Map();

    prompts.forEach((prompt, index) => {
      // UNCOMMENT TO USE KEYWORD EXTRACTION
      // const keywords = extractKeywordsFromPrompt(prompt);
      // Use full prompt as keyword (lowercase for API consistency)
      const keywords = [prompt.toLowerCase()];
      promptKeywordMap.set(index, keywords);
      // UNCOMMENT TO USE KEYWORD EXTRACTION
      // allKeywords.push(...keywords);
      allKeywords.push(prompt);
    });

    // Remove duplicates and limit total keywords
    const uniqueKeywords = [...new Set(allKeywords)].slice(0, 50);

    if (uniqueKeywords.length === 0) {
      console.warn("No keywords extracted from any prompts");
      return prompts.map(() => null);
    }

    // Fetch volume data for all keywords
    const volumeResponse = await fetchAIKeywordVolume(
      uniqueKeywords,
      locationCode
    );

    if (!volumeResponse || !volumeResponse.success) {
      return prompts.map(() => null);
    }

    // Create keyword volume lookup (case-insensitive)
    const keywordVolumeMap = new Map();
    if (volumeResponse.data.items) {
      volumeResponse.data.items.forEach((item) => {
        keywordVolumeMap.set(item.keyword, item);
      });
    }

    // Map results back to original prompts
    const results = prompts.map((prompt, index) => {
      const promptKeywords = promptKeywordMap.get(index) || [];

      // Find matching volume data for this prompt's keywords (case-insensitive)
      const matchingItems = promptKeywords
        .map((keyword) => keywordVolumeMap.get(keyword.toLowerCase()))
        .filter((item) => item !== undefined); // Include items even if ai_search_volume is 0

      // if (matchingItems.length === 0) {
      //   return null;
      // }

      // Create synthetic volume data for this prompt
      const syntheticVolumeData = {
        items: matchingItems,
        location_code: volumeResponse.data.location_code,
        language_code: volumeResponse.data.language_code,
      };

      return processAIVolumeData(syntheticVolumeData);
    });

    return results;
  } catch (error) {
    console.error("Error getting batch AI volume data:", error.message);
    return prompts.map(() => null);
  }
}

// data forSEO Scraper implementation

// Add these functions at the bottom of your existing file (before module.exports)

/**
 * Generate unique tracking ID using existing uuid package
 * @returns {string} - Unique identifier
 */
function generateBatchTrackingId() {
  return uuidv4();
}

/**
 * Convert user country code to DataForSEO country name
 * @param {string} userCountry - Country code (US, UK, CA, etc.)
 * @returns {string} - Full country name for DataForSEO
 */
function getDataForSeoCountryName(userCountry) {
  const countryMap = {
    US: "United States",
    UK: "United Kingdom",
    CA: "Canada",
    AU: "Australia",
    DE: "Germany",
    FR: "France",
    IN: "India",
    JP: "Japan",
    BR: "Brazil",
    IT: "Italy",
    ES: "Spain",
    NL: "Netherlands",
    SE: "Sweden",
    NO: "Norway",
  };
  return countryMap[userCountry] || "United States";
}

// REPLACE the submitPromptsToDataForSEO function in your src/utils/dataForSeoService.js with this CORRECTED version

/**
 * Submit prompts to DataForSEO LLM Responses API (CORRECTED VERSION - Using right endpoint)
 * @param {Array} prompts - Array of prompt strings or objects
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - Submission response
 */
async function submitPromptsToDataForSEO(prompts, options = {}) {
  const {
    userCountry = "US",
    webSearch = false,
    callbackUrl = process.env.DATAFORSEO_CALLBACK_URL ||
      `${
        process.env.BACKEND_URL || "http://localhost:3000"
      }/api/test-dataforseo/callback`,
    jobBatchId = null,
    batchNumber = 0,
    totalBatches = 1,
    email = null,
  } = options;

  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error(
      "DataForSEO credentials not configured in environment variables"
    );
  }

  if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
    throw new Error(
      "Prompts array is required and must contain at least 1 prompt"
    );
  }

  // Generate unique tracking ID for this batch
  const batchTrackingId = generateBatchTrackingId();

  console.log(
    `[DataForSEO] Submitting ${prompts.length} prompts for batch ${
      batchNumber + 1
    }/${totalBatches}`
  );

  // Convert country to location code
  const getLocationCode = (country) => {
    const locationCodes = {
      US: 2840, // United States
      UK: 2826, // United Kingdom
      CA: 2124, // Canada
      AU: 2036, // Australia
      DE: 2276, // Germany
      FR: 2250, // France
      IN: 2356, // India
      JP: 2392, // Japan
      BR: 2076, // Brazil
    };
    return locationCodes[country] || 2840; // Default to US
  };

  // Process each prompt individually (DataForSEO LLM Responses processes one at a time)
  const results = [];
  const taskIds = [];

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const promptText = typeof prompt === "string" ? prompt : prompt.text;

    // Create task for LLM Responses API - CORRECT FORMAT
    const task = [
      {
        user_prompt: promptText,
        model_name: "gpt-4o-mini", // Using available ChatGPT model
        max_output_tokens: 1000,
        temperature: 0.7,
        web_search: webSearch,
        location_code: getLocationCode(userCountry),
        language_code: "en",
        // Add custom tag for tracking
        tag: `${batchTrackingId}_${i}`,
      },
    ];

    console.log(
      `[DataForSEO] Task ${i + 1}/${prompts.length} payload:`,
      JSON.stringify(task, null, 2)
    );

    try {
      // Use the CORRECT endpoint - LLM Responses Live
      const response = await axios.post(
        `${BASE_URL}/ai_optimization/chat_gpt/llm_responses/live`,
        task,
        {
          headers: {
            Authorization: authHeader(),
            "Content-Type": "application/json",
          },
          timeout: 60000, // 60 seconds for LLM response
        }
      );

      console.log(
        `[DataForSEO] Response ${i + 1}:`,
        JSON.stringify(response.data, null, 2)
      );

      if (
        response.data &&
        response.data.tasks &&
        response.data.tasks.length > 0
      ) {
        const task = response.data.tasks[0];
        if (task.status_code === 20000) {
          taskIds.push(task.id);
          results.push({
            id: task.id,
            status_code: task.status_code,
            status_message: task.status_message,
            queued: true,
            promptIndex: i,
            result: task.result,
          });
        } else {
          results.push({
            id: task.id || `failed_${i}`,
            status_code: task.status_code,
            status_message: task.status_message,
            queued: false,
            promptIndex: i,
            error: task.status_message,
          });
        }
      }
    } catch (error) {
      console.error(
        `[DataForSEO] Error processing prompt ${i + 1}:`,
        error.message
      );
      results.push({
        id: `error_${i}`,
        status_code: 0,
        status_message: error.message,
        queued: false,
        promptIndex: i,
        error: error.message,
      });
    }

    // Add delay between requests to avoid rate limiting
    if (i < prompts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
    }
  }

  // Calculate final results
  const successfulTasks = results.filter((r) => r.queued);
  const failedTasks = results.filter((r) => !r.queued);

  console.log(
    `[DataForSEO] Final Results: ${successfulTasks.length}/${results.length} tasks completed successfully`
  );

  if (failedTasks.length > 0) {
    console.warn(
      "[DataForSEO] Failed tasks:",
      failedTasks.map((t) => ({
        id: t.id,
        status_code: t.status_code,
        message: t.status_message || t.error,
      }))
    );
  }

  if (successfulTasks.length === 0) {
    const errorDetails = failedTasks
      .map((t) => `Task ${t.promptIndex + 1}: ${t.status_message || t.error}`)
      .join(", ");
    throw new Error(
      `No tasks were successfully completed. Errors: ${errorDetails}`
    );
  }

  // For LLM Responses, we get immediate results, not callbacks
  return {
    success: true,
    service: "dataforseo",
    batchTrackingId,
    snapshotId: batchTrackingId,
    taskIds,
    taskResults: results,
    totalTasks: prompts.length,
    successfulTasks: successfulTasks.length,
    failedTasks: failedTasks.length,
    cost: results.reduce(
      (sum, r) => sum + (r.result?.[0]?.money_spent || 0),
      0
    ),
    message: `${successfulTasks.length}/${prompts.length} prompts processed successfully by DataForSEO`,
    results: successfulTasks.map((r) => ({
      promptIndex: r.promptIndex,
      taskId: r.id,
      response:
        r.result?.[0]?.items?.[0]?.sections?.[0]?.text || "No response text",
      citations: r.result?.[0]?.items?.[0]?.sections?.[0]?.annotations || [],
    })),
  };
}
/**
 * Check DataForSEO service health and account status
 */
async function checkDataForSeoHealth() {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    return {
      healthy: false,
      error: "DataForSEO credentials not configured",
      status: "misconfigured",
    };
  }

  try {
    console.log("[DataForSEO] Checking service health...");

    const response = await axios.post(
      `${BASE_URL}/user_data/info`,
      {},
      {
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    console.log(
      "[DataForSEO] Health check response:",
      JSON.stringify(response.data, null, 2)
    );

    return {
      healthy: response.status === 200,
      credits: response.data?.money || 0,
      status: "operational",
      login: DATAFORSEO_LOGIN,
      callbackUrl: process.env.DATAFORSEO_CALLBACK_URL,
      accountInfo: response.data,
    };
  } catch (error) {
    console.error("[DataForSEO] Health check failed:", error.message);

    return {
      healthy: false,
      error: error.message,
      status: "down",
      login: DATAFORSEO_LOGIN,
    };
  }
}

/**
 * Process DataForSEO callback data
 */
function processDataForSeoCallback(callbackData) {
  try {
    console.log(
      "[DataForSEO] Processing callback:",
      JSON.stringify(callbackData, null, 2)
    );

    if (!callbackData || !callbackData.id) {
      throw new Error("Invalid callback data: missing task ID");
    }

    if (!callbackData.result || callbackData.result.length === 0) {
      return {
        success: false,
        taskId: callbackData.id,
        error: "No results in callback",
      };
    }

    const tag = callbackData.tag;
    if (!tag) {
      throw new Error("No tag found in callback data");
    }

    const [batchTrackingId, promptIndex] = tag.split("_");
    const result = callbackData.result[0];
    const answerText =
      result?.answer_text || result?.answer_text_markdown || "";
    const citations = result?.citations || [];

    console.log(`[DataForSEO] Callback processed:
      - Task ID: ${callbackData.id}
      - Batch ID: ${batchTrackingId}  
      - Prompt Index: ${promptIndex}
      - Answer Length: ${answerText.length} characters
    `);

    return {
      success: true,
      taskId: callbackData.id,
      batchTrackingId,
      promptIndex: parseInt(promptIndex),
      answerText,
      citations,
      answerLength: answerText.length,
      rawResult: result,
    };
  } catch (error) {
    console.error("[DataForSEO] Error processing callback:", error.message);
    return {
      success: false,
      taskId: callbackData?.id || "unknown",
      error: error.message,
    };
  }
}

module.exports = {
  extractKeywordsFromPrompt,
  fetchAIKeywordVolume,
  processAIVolumeData,
  getPromptAIVolume,
  getBatchPromptAIVolume,
  // data for SEO Scraper exports
  // Add new exports
  generateBatchTrackingId,
  getDataForSeoCountryName,
  submitPromptsToDataForSEO,
  checkDataForSeoHealth,
  processDataForSeoCallback,
};
