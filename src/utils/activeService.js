// / utils/activeService.js
const cron = require("node-cron");
const axios = require("axios");
const { bright, dataForSeo } = require("../config");

// Configuration
const BRIGHTDATA_API_KEY = bright.key;
const DATAFORSEO_LOGIN = dataForSeo.login;
const DATAFORSEO_PASSWORD = dataForSeo.password;

// Current active service and initialization state
let activeService = null;
let isInitialized = false;
let initializationPromise = null;

// Check BrightData health with proper await
async function checkBrightData() {
  try {
    console.log("🔍 Checking BrightData API health...");

    const response = await axios.get(
      "https://api.brightdata.com/network_status/all",
      {
        headers: { Authorization: `Bearer ${BRIGHTDATA_API_KEY}` },
        timeout: 10000, // Increased timeout to 10s for reliability
        validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      }
    );

    // Check for rate limiting
    if (response.status === 429) {
      console.log(
        "⚠️ BrightData rate limited (429) - treating as healthy but busy"
      );
      return true; // Service is healthy, just rate limited
    }

    const isHealthy = response.status === 200;
    console.log(
      `${isHealthy ? "✅" : "❌"} BrightData health check: ${response.status}`
    );
    return isHealthy;
  } catch (error) {
    console.log(`❌ BrightData check failed: ${error.message}`);
    return false;
  }
}

// Check DataForSEO health with proper await
async function checkDataForSEO() {
  try {
    console.log("🔍 Checking DataForSEO API health...");

    const credentials = Buffer.from(
      `${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`
    ).toString("base64");

    const response = await axios.get(
      "https://api.dataforseo.com/v3/appendix/status",
      {
        headers: { Authorization: `Basic ${credentials}` },
        timeout: 10000, // Increased timeout to 10s for reliability
        validateStatus: (status) => status < 500,
      }
    );

    // Check for rate limiting
    if (response.status === 429) {
      console.log(
        "⚠️ DataForSEO rate limited (429) - treating as healthy but busy"
      );
      return true;
    }

    const isHealthy = response.data?.status_code === 20000;
    console.log(
      `${isHealthy ? "✅" : "❌"} DataForSEO health check: ${
        response.data?.status_code || response.status
      }`
    );
    return isHealthy;
  } catch (error) {
    console.log(`❌ DataForSEO check failed: ${error.message}`);
    return false;
  }
}

// Main health check function - waits for complete API responses
async function updateActiveService() {
  try {
    const startTime = Date.now();
    
    // This will wait for the full response before continuing
    const dataForSEOHealthy = await checkDataForSEO();

    if (dataForSEOHealthy) {
      activeService = "dataforseo";
      const duration = Date.now() - startTime;
      console.log(`✅ DataForSEO selected as active service (${duration}ms)`);
      return activeService;
    }
    // Check BrightData first (preferred service)
    // This will wait for the full response before continuing
    const brightDataHealthy = await checkBrightData();

    if (brightDataHealthy) {
      activeService = "brightdata";
      const duration = Date.now() - startTime;
      console.log(`✅ BrightData selected as active service (${duration}ms)`);
      return activeService;
    }


    // Both services failed
    activeService = null;
    const duration = Date.now() - startTime;
    console.log(`❌ All services are down (${duration}ms)`);
    return activeService;
  } catch (error) {
    console.error("❌ Error during service health check:", error.message);
    activeService = null;
    return activeService;
  }
}

// Initialize services and wait for completion
async function initializeServices() {
  // Return existing initialization if already in progress
  if (initializationPromise) {
    console.log("⏳ Service initialization already in progress, waiting...");
    return await initializationPromise;
  }

  // Create new initialization promise
  initializationPromise = (async () => {
    try {
      console.log("🚀 Initializing service monitoring...");

      // Wait for updateActiveService to complete fully
      const service = await updateActiveService();

      isInitialized = true;
      console.log(
        `🎯 Service monitoring initialized. Active service: ${
          service || "NONE"
        }`
      );

      return service;
    } catch (error) {
      console.error("❌ Service initialization failed:", error);
      isInitialized = false;
      initializationPromise = null; // Reset so it can be retried
      throw error;
    }
  })();

  // Wait for initialization to complete
  return await initializationPromise;
}

// Get active service (synchronous - returns immediately)
function getActiveService() {
  if (!isInitialized) {
    console.warn("⚠️ Service monitoring not yet initialized, returning null");
  }
  return activeService;
}

// Get active service and wait for initialization if needed
async function getActiveServiceAsync() {
  // If not initialized, wait for initialization to complete
  if (!isInitialized) {
    console.log("⏳ Service not initialized, waiting for initialization...");

    try {
      // This will wait for all API calls to complete
      const service = await initializeServices();
      console.log(`✅ Service initialized: ${service || "NONE"}`);
      return service;
    } catch (error) {
      console.error("❌ Failed to initialize service:", error);
      return null;
    }
  }

  // Already initialized, return immediately
  console.log(`ℹ️ Returning cached active service: ${activeService || "NONE"}`);
  return activeService;
}

// Start monitoring with proper initialization
async function startMonitoring() {
  try {
    console.log("🚀 Starting service monitoring system...");

    // Initialize services first and wait for completion
    const initialService = await initializeServices();
    console.log(`✅ Initial service selected: ${initialService || "NONE"}`);

    // Schedule periodic health checks every minute
    // Each check will wait for API responses before continuing
    cron.schedule("* * * * *", async () => {
      console.log("⏰ Running scheduled health check...");
      try {
        await updateActiveService();
      } catch (error) {
        console.error("❌ Scheduled health check failed:", error);
      }
    });

    console.log(
      "✅ Service monitoring started with periodic health checks (every 1 minute)"
    );
    return initialService;
  } catch (error) {
    console.error("❌ Failed to start service monitoring:", error);
    throw error;
  }
}

// Force refresh the active service (waits for completion)
async function refreshActiveService() {
  console.log("🔄 Force refreshing active service...");

  try {
    const service = await updateActiveService();
    console.log(`✅ Service refreshed: ${service || "NONE"}`);
    return service;
  } catch (error) {
    console.error("❌ Failed to refresh service:", error);
    return null;
  }
}

// Get service status for debugging
function getServiceStatus() {
  return {
    activeService,
    isInitialized,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getActiveService,
  getActiveServiceAsync,
  startMonitoring,
  refreshActiveService,
  getServiceStatus,
  initializeServices,
};

// Auto-start if run directly
if (require.main === module) {
  startMonitoring()
    .then((service) => {
      console.log(
        `✅ Service monitoring started successfully with ${
          service || "NO"
        } service`
      );
    })
    .catch((error) => {
      console.error("❌ Failed to start service monitoring:", error);
      process.exit(1);
    });
}
