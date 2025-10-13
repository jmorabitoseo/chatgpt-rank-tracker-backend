// Health check functions
async function checkBrightDataHealth() {
  try {
    // Simple connectivity test - replace with actual Bright Data endpoint
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      "https://brd-customer-hl_username-zone-datacenter_proxy1.brd.superproxy.io:22225",
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Proxy-Authorization": `Basic ${Buffer.from(
            `${process.env.BRIGHTDATA_USERNAME}:${process.env.BRIGHTDATA_PASSWORD}`
          ).toString("base64")}`,
        },
      }
    );

    clearTimeout(timeoutId);
    return response.status < 500; // Accept any non-server error as healthy
  } catch (error) {
    console.error("Bright Data health check failed:", error.message);
    return false;
  }
}

async function checkDataForSEOHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://api.dataforseo.com/v3/user", {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
        ).toString("base64")}`,
      },
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    console.error("DataForSEO health check failed:", error.message);
    return false;
  }
}

async function selectHealthyService() {
  // Check Bright Data first (preferred)
  const isBrightDataHealthy = await checkBrightDataHealth();
  if (isBrightDataHealthy) {
    return "brightdata";
  }

  // Check DataForSEO as fallback
  const isDataForSEOHealthy = await checkDataForSEOHealth();
  if (isDataForSEOHealthy) {
    return "dataforseo";
  }

  // Both services are down
  throw new Error(
    "Both Bright Data and DataForSEO services are currently unavailable"
  );
}

// let check = true;
// if (check) {
//   (async () => {
//     try {
//       console.log("healthy service is: ", await selectHealthyService());
//     } catch (error) {
//       console.error("Service selection failed:", error.message);
//     }
//   })();
//   check = false;
// }
module.exports = { selectHealthyService };
