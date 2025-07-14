// src/analysis.js
const OpenAI = require("openai");

/**
 * Escapes special regex characters in a string
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Counts brand mentions in the response text
 */
function countBrandMatches(brands, response) {
  const matches = {};
  let totalMatches = 0;
  let anyMatch = false;

  if (!response || !brands || brands.length === 0) {
    return { totalMatches: 0, matches: {}, anyMatch: false };
  }

  brands.forEach((brand) => {
    const pattern = new RegExp(`\\b${escapeRegExp(brand)}\\b`, "gi");
    const count = (response.match(pattern) || []).length;

    if (count > 0) {
      matches[brand] = count;
      totalMatches += count;
      anyMatch = true;
    }
  });

  return { totalMatches, matches, anyMatch };
}

/**
 * Returns a 0–100 sentiment score for the given text & brands.
 */
async function analyzeSentiment(response, brands, openai, model) {
  if (!brands.length || !response.trim()) return 0;
  
  // Check if any brands are mentioned before making OpenAI call
  const brandMatch = countBrandMatches(brands, response);
  if (!brandMatch.anyMatch) return 0;

  const brandList = brands.map(b => `"${b}"`).join(", ");
  const prompt = `Analyze brand sentiment in the following text regarding (${brandList}).

Rating Guidelines (Respond ONLY with the number):
100 = "The absolute best! Perfect in every way!"
90 = "Exceptional quality and service"
80 = "Very good, highly recommend"
70 = "Good overall with minor flaws"
60 = "Mostly positive but with reservations"
50 = Neutral/mixed/unclear sentiment
40 = "Somewhat disappointing"
30 = "Below average, not recommended"
20 = "Poor quality or service"
10 = "Extremely negative experience"
0 = "Worst ever, avoid at all costs"

Relevant Text:
"""
${response}
"""`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are a brand sentiment expert. Respond with a single number 0–100." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
    max_tokens: 3,
  });
  const num = parseInt((completion.choices[0]?.message?.content || "50").replace(/\D/g, "")) || 50;
  return Math.min(100, Math.max(0, num));
}

/**
 * Returns a 0–100 salience score for the given text & brands.
 */
async function analyzeSalience(response, brands, openai, model) {
  if (!brands.length || !response.trim()) return 0;
  
  // Check if any brands are mentioned before making OpenAI call
  const brandMatch = countBrandMatches(brands, response);
  if (!brandMatch.anyMatch) return 0;

  const brandList = brands.map(b => `"${b}"`).join(", ");
  const prompt = `Analyze how prominently these brands are discussed in the text: (${brandList}).

Rating Guidelines:
0 = Not mentioned at all
20 = Briefly mentioned in passing
40 = Mentioned with some context
60 = Discussed with details
80 = Major focus of the content
100 = Entire content is about the brand(s)

Text to analyze:
"""
${response}
"""

Provide only a single number between 0-100 as your rating.`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are an expert that rates brand prominence. Respond with a single number 0–100." },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 4,
  });
  const num = parseInt((completion.choices[0]?.message?.content.match(/\d+/) || ["0"])[0]) || 0;
  return Math.min(100, Math.max(0, num));
}

module.exports = { analyzeSentiment, analyzeSalience, countBrandMatches };