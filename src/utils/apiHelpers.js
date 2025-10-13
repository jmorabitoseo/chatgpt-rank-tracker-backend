const retryWithBackoff = async (fn, maxRetries = 5, label = "") => {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err.status === 429 ||
        err.status >= 500 ||
        ["ECONNRESET", "ETIMEDOUT"].includes(err.code) ||
        err.message.includes("network") ||
        err.message.includes("timeout");
      if (!retryable || i === maxRetries - 1) break;
      const wait =
        err.status === 429
          ? Math.min(2000 * 2 ** i, 30000)
          : Math.min(1000 * 2 ** i, 10000);
      console.warn(`${label} attempt ${i + 1} failed, retrying in ${wait}ms…`);
      await delay(wait);
    }
  }
  throw new Error(
    `${label} failed after ${maxRetries} retries: ${lastErr.message}`
  );
};

// add delay helper
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = { retryWithBackoff, delay };
