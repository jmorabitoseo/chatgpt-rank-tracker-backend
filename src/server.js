require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
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
const cors = require("cors");
//  utils
// const { getActiveService, startMonitoring } = require("./utils/activeService");
// utils
const {
  getActiveService,
  getActiveServiceAsync,
  startMonitoring,
  getServiceStatus,
} = require("./utils/activeService");

// routes
const dataForSEO = require("./routes/dataForSEO");
const analytics = require("./routes/analytics");
const selectHealthyService = require("./utils/brightDataUtils");
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
    throw new Error(`OpenAI validation failed : ${err.message}`);
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
app.use(
  cors({
    // origin: ["http://localhost:5173", "https://chatgptranktracker.com"],
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
// check the data Scraper service
startMonitoring();

app.use(bodyParser.json());

// test server is running with get request at root
app.get("/", async (req, res) => {
  res.send(`Server is running....`);
});

// New endpoint to fetch full BrightData response by snapshot_id and prompt
app.get("/snapshot-data/:snapshotId", async (req, res) => {
  const { snapshotId } = req.params;
  const { prompt } = req.query;

  if (!snapshotId || !prompt) {
    return res.status(400).json({
      error: "snapshotId (param) and prompt (query) are required",
    });
  }

  try {
    // Fetch the full results from BrightData
    const { data: results } = await axios.get(
      `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
      { headers: { Authorization: `Bearer ${bright.key}` } }
    );

    // Find the specific result matching the prompt
    const matchingResult = results.find((result) => result.prompt === prompt);

    if (!matchingResult) {
      return res.status(404).json({
        error: "No matching result found for the given prompt in this snapshot",
      });
    }

    // Return the full BrightData response
    res.json({
      status: "success",
      snapshot_id: snapshotId,
      prompt: prompt,
      data: matchingResult,
    });
  } catch (err) {
    // console.error('Snapshot data fetch error:', err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        error: "Snapshot not found or expired",
      });
    }

    res.status(500).json({
      error: "Failed to fetch snapshot data",
      message: err.message,
    });
  }
});
// Backend endpoint for DataForSEO HTML fetching
app.get("/dataforseo-html/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;

    // DataForSEO credentials
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;

    if (!login || !password) {
      return res.status(500).json({
        success: false,
        error: "DataForSEO credentials not configured",
      });
    }

    const credentials = Buffer.from(`${login}:${password}`).toString("base64");

    // Fetch advanced results from DataForSEO (includes markdown and structured data)
    const response = await fetch(
      `https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/${taskId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `DataForSEO API returned ${response.status}: ${response.statusText}`
      );
    }

    const data = await response.json();

    if (data.status_code === 20000 && data.tasks?.[0]?.result?.[0]) {
      const result = data.tasks[0].result[0];
      const taskData = data.tasks[0].data;

      // Extract the main content
      const markdownContent = result.markdown || "";
      const items = result.items || [];
      const sources = result.sources || [];

      // Try to fetch HTML version as well (optional, for richer display)
      let htmlContent = "";
      try {
        const htmlResponse = await fetch(
          `https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_get/html/${taskId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Basic ${credentials}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (htmlResponse.ok) {
          const htmlData = await htmlResponse.json();
          if (
            htmlData.status_code === 20000 &&
            htmlData.tasks?.[0]?.result?.[0]?.items?.[0]?.html
          ) {
            htmlContent = htmlData.tasks[0].result[0].items[0].html;
          }
        }
      } catch (htmlError) {
        console.warn(
          "Could not fetch HTML, using markdown only:",
          htmlError.message
        );
      }

      // Return structured response that matches BrightDataChatGPTDisplay expectations
      res.json({
        success: true,
        answer_text: markdownContent,
        answer_html:
          htmlContent ||
          `<div class="markdown-content">${markdownContent.replace(
            /\n/g,
            "<br>"
          )}</div>`,
        answer_text_markdown: markdownContent,
        markdown: markdownContent,
        citations: sources,
        sources: sources,
        check_url: result.check_url || "",
        items: items,
        location_code: result.location_code,
        language_code: result.language_code,
        datetime: result.datetime,
        keyword: result.keyword,
        raw_response: data,
        task_data: taskData, // Include original task data if needed
      });
    } else {
      console.error("DataForSEO response error:", data);
      res.status(404).json({
        success: false,
        error: "No data found for this task ID",
        details: data.status_message || "Task not found or failed",
        status_code: data.status_code,
      });
    }
  } catch (error) {
    console.error("Error fetching DataForSEO data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch DataForSEO data",
      message: error.message,
    });
  }
});

// route to enqueue prompts for processing with service selection
app.post("/enqueue", async (req, res) => {
  // 0) Extract and validate input
  const requestBody = req.body || {};
  const {
    project_id,
    user_id,
    email,
    prompts = [],
    brandMentions = [],
    domainMentions = [],
    userCity = "",
    userCountry = "",
    openaiKey,
    webSearch = false, // User's checkbox preference to FORCE web search
    openaiModel = process.env.DEFAULT_OPENAI_MODEL || "gpt-4",
    tags = [],
  } = requestBody;

  const service = await getActiveServiceAsync(); // Just call this function
  if (!service) {
    return res.status(503).json({
      error: "All services are currently down. Please try again later.",
      availableServices: [],
      timestamp: new Date().toISOString(),
    });
  }
  console.log("service: ", service);
  const validServices = ["brightdata", "dataforseo"];

  if (
    !project_id ||
    !user_id ||
    !Array.isArray(prompts) ||
    prompts.length === 0 ||
    !openaiKey
  ) {
    return res.status(400).json({
      error: "project_id, user_id, prompts (≥1) and openaiKey are required",
    });
  }

  if (!validServices.includes(service)) {
    return res.status(400).json({
      error: `Invalid service. Must be one of: ${validServices.join(", ")}`,
    });
  }

  // Local helpers for readability (no external behavior change)
  const determineSource = (svc) =>
    svc === "dataforseo" ? "DataForSEO" : "Bright Data";

  async function upsertTagsIfAny(tagNames, projectId, userId) {
    const tagIds = [];
    for (const rawName of tagNames) {
      const name = (rawName || "").trim();
      if (!name) continue;
      const { data: existingTag, error: findError } = await supabase
        .from("tags")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .ilike("name", name)
        .single();
      if (findError && findError.code !== "PGRST116") {
        throw new Error(`Error finding tag "${name}": ${findError.message}`);
      }
      if (existingTag) {
        tagIds.push(existingTag.id);
      } else {
        const { data: newTag, error: createError } = await supabase
          .from("tags")
          .insert([
            { name, project_id: projectId, user_id: userId, color: "#3B82F6" },
          ])
          .select("id")
          .single();
        if (createError)
          throw new Error(
            `Error creating tag "${name}": ${createError.message}`
          );
        tagIds.push(newTag.id);
      }
    }
    return tagIds;
  }

  function buildBulkData(allPrompts, batchSize, meta) {
    const {
      projectId,
      userId,
      svc,
      city,
      country,
      brands,
      domains,
      jobBatchId,
    } = meta;
    const promptsData = [];
    const trackingData = [];
    const enriched = [];
    const source = determineSource(svc);

    allPrompts.forEach((text, index) => {
      const promptId = uuidv4();
      const trackingId = uuidv4();
      const batchNumber = Math.floor(index / batchSize);

      promptsData.push({
        id: promptId,
        text,
        enabled: true,
        project_id: projectId,
        user_id: userId,
        source,
        user_city: city,
        user_country: country,
        brand_mentions: brands,
        domain_mentions: domains,
      });

      trackingData.push({
        id: trackingId,
        prompt_id: promptId,
        prompt: text,
        project_id: projectId,
        user_id: userId,
        job_batch_id: jobBatchId,
        batch_number: batchNumber,
        snapshot_id: null,
        status: "pending",
        is_present: null,
        sentiment: null,
        salience: null,
        response: null,
        brand_mentions: brands,
        domain_mentions: domains,
        brand_name: String(brands),
        timestamp: Date.now(),
        source,
        mention_count: null,
      });

      enriched.push({
        id: promptId,
        text,
        userId,
        projectId,
        brandMentions: brands,
        domainMentions: domains,
        userCountry: country,
        trackingId,
        batchNumber,
      });
    });

    return { promptsData, trackingData, enriched };
  }

  try {
    // 1) Validate OpenAI credentials
    const openai = createOpenAI(openaiKey);
    await validateOpenAIAccess(openai, openaiModel);

    // 2) Upsert tags (if any)
    const tagIds = await upsertTagsIfAny(tags, project_id, user_id);

    // 3) Batch calculations
    const batchSize = getBatchSize(prompts.length);
    const totalBatches = Math.ceil(prompts.length / batchSize);

    // 4) Create job batch
    const { data: jobBatch, error: jobError } = await supabase
      .from("job_batches")
      .insert([
        {
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
          tags,
          status: "pending",
        },
      ])
      .select("id")
      .single();
    if (jobError) throw jobError;
    const jobBatchId = jobBatch.id;

    // 5) Build bulk payloads
    const { promptsData, trackingData, enriched } = buildBulkData(
      prompts,
      batchSize,
      {
        projectId: project_id,
        userId: user_id,
        svc: service,
        city: userCity,
        country: userCountry,
        brands: brandMentions,
        domains: domainMentions,
        jobBatchId,
      }
    );

    // 6) Bulk inserts
    const { error: promptsError } = await supabase
      .from("prompts")
      .insert(promptsData);
    if (promptsError)
      throw new Error(`Failed to insert prompts: ${promptsError.message}`);

    const { error: trackingError } = await supabase
      .from("tracking_results")
      .insert(trackingData);
    if (trackingError)
      throw new Error(
        `Failed to insert tracking results: ${trackingError.message}`
      );

    // 7) Associate tags to prompts (if provided)
    if (tagIds.length > 0 && promptsData.length > 0) {
      const promptTagsData = [];
      for (const p of promptsData) {
        for (const tagId of tagIds) {
          promptTagsData.push({ prompt_id: p.id, tag_id: tagId });
        }
      }
      const { error: promptTagsError } = await supabase
        .from("prompt_tags")
        .upsert(promptTagsData, {
          onConflict: "prompt_id,tag_id",
          ignoreDuplicates: true,
        });
      if (promptTagsError)
        console.error(
          "Failed to associate tags with prompts:",
          promptTagsError
        );
    }

    console.log(
      `Bulk  inserted ${prompts.length} prompts and tracking stubs for job ${jobBatchId} using ${service}`
    );

    // 8) Queue batches for processing
    const batches = chunkArray(enriched, batchSize);
    console.log("batches: ", batches);
    await supabase
      .from("job_batches")
      .update({ status: "processing" })
      .eq("id", jobBatchId);
    const topicName = service === "dataforseo" ? dataForSEOTopic : pubsubTopic;
    const batchPromises = batches.map(async (batch, batchIndex) => {
      try {
        await pubsub.topic(topicName).publish(
          Buffer.from(
            JSON.stringify({
              openaiKey,
              openaiModel,
              email,
              jobBatchId,
              batchNumber: batchIndex,
              totalBatches,
              prompts: batch,
              userCountry,
              webSearch,
              isNightly: false,
              service,
              user_id,
            })
          )
        );
        console.log(
          `Queued batch ${
            batchIndex + 1
          }/${totalBatches} for job ${jobBatchId} using ${service}`
        );
      } catch (err) {
        console.error(
          `Failed to queue batch ${batchIndex} for ${service}:`,
          err
        );
      }
    });

    Promise.all(batchPromises).catch((err) => {
      console.error(`Some batches failed to queue for ${service}:`, err);
    });

    // 9) Response
    res.json({
      status: "enqueued",
      jobBatchId,
      totalPrompts: prompts.length,
      totalBatches,
      service,
      message: `Your ${prompts.length} prompts${
        tags.length > 0
          ? ` with ${tags.length} tag${tags.length > 1 ? "s" : ""}`
          : ""
      } are being processed in ${totalBatches} batches using ${service.toUpperCase()}. You'll receive an email when complete.`,
    });
  } catch (err) {
    console.error(`Enqueue error for ${service}:`, err);
    res.status(500).json({ error: err.message, service });
  }
});

// data for SEO test routes
app.use("/api/dataforseo", dataForSEO);
// analytics
app.use("/api/analytics", analytics);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Enqueue API listening on port ${PORT}`));
