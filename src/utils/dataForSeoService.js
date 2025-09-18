// src/utils/dataForSeoService.js
const axios = require('axios');

const BASE_URL = 'https://api.dataforseo.com/v3';
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;

// Create Basic Auth header
const authHeader = () => 
  'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');

/**
 * Extract meaningful keywords from a prompt text
 * @param {string} prompt - The prompt text to analyze
 * @returns {string[]} - Array of extracted keywords
 */
function extractKeywordsFromPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return [];
  }

  // Remove common question words and phrases
  const commonWords = [
    'what', 'when', 'where', 'why', 'how', 'who', 'which', 'can', 'could', 'would', 'should',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'ought', 'need', 'dare',
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'from', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'up', 'down',
    'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'tell', 'me', 'about', 'give', 'show', 'find', 'search', 'look', 'recommend', 'suggest',
    'best', 'good', 'great', 'top', 'popular', 'recommended', 'review', 'reviews'
  ];

  // Clean and split the prompt
  let cleanPrompt = prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .trim();

  // Split into words and filter
  let words = cleanPrompt.split(' ')
    .filter(word => word.length > 2) // Remove very short words
    .filter(word => !commonWords.includes(word)) // Remove common words
    .filter(word => !/^\d+$/.test(word)); // Remove pure numbers

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
async function fetchAIKeywordVolume(keywords, locationCode = 2840, languageCode = 'en') {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new Error('DataForSEO credentials not configured');
  }

  if (!keywords || keywords.length === 0) {
    throw new Error('No keywords provided for AI volume analysis');
  }

  // Filter out empty keywords and limit to reasonable batch size
  const validKeywords = keywords
    .filter(keyword => keyword && keyword.trim().length > 0)
    .slice(0, 20); // Limit batch size to control costs

  if (validKeywords.length === 0) {
    throw new Error('No valid keywords found for AI volume analysis');
  }

  const payload = [{
    keywords: validKeywords,
    location_code: locationCode,
    language_name: "English",
    language_code: languageCode
  }];

  try {
    const response = await axios.post(
      `${BASE_URL}/ai_optimization/ai_keyword_data/keywords_search_volume/live`,
      payload,
      {
        headers: {
          'Authorization': authHeader(),
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    // Validate response structure
    if (!response.data || !response.data.tasks || response.data.tasks.length === 0) {
      throw new Error('Invalid response structure from DataForSEO API');
    }

    const task = response.data.tasks[0];
    if (task.status_code !== 20000) {
      throw new Error(`DataForSEO API error: ${task.status_message || 'Unknown error'}`);
    }

    if (!task.result || task.result.length === 0) {
      console.warn('DataForSEO returned no results for keywords:', validKeywords);
      return null;
    }

    return {
      success: true,
      data: task.result[0], // First (and typically only) result
      cost: response.data.cost || 0,
      keywords: validKeywords,
      location_code: locationCode,
      language_code: languageCode
    };

  } catch (error) {
    console.error('DataForSEO API error:', error.message);
    
    // Handle specific error types
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.message;
      
      if (status === 401) {
        throw new Error('DataForSEO authentication failed - check credentials');
      } else if (status === 402) {
        throw new Error('DataForSEO insufficient credits - please top up your account');
      } else if (status === 429) {
        throw new Error('DataForSEO rate limit exceeded - please try again later');
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

  // Aggregate data from all keywords (in case multiple keywords were analyzed)
  let totalCurrentVolume = 0;
  let allMonthlyData = [];
  let processedKeywords = [];

  volumeData.items.forEach(item => {
    if (item.ai_search_volume && item.ai_search_volume > 0) {
      totalCurrentVolume += item.ai_search_volume;
      processedKeywords.push(item.keyword);
      
      if (item.ai_monthly_searches && Array.isArray(item.ai_monthly_searches)) {
        allMonthlyData.push(...item.ai_monthly_searches);
      }
    }
  });

  // If no volume data found, return null
  if (totalCurrentVolume === 0) {
    return null;
  }

  // Sort monthly data by date (newest first)
  allMonthlyData.sort((a, b) => {
    const dateA = new Date(a.year, a.month - 1);
    const dateB = new Date(b.year, b.month - 1);
    return dateB.getTime() - dateA.getTime();
  });

  // Calculate metrics
  const volumes = allMonthlyData.map(item => item.ai_search_volume);
  const averageVolume = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : 0;
  const peakVolume = volumes.length > 0 ? Math.max(...volumes) : 0;

  return {
    current_volume: totalCurrentVolume,
    average_volume: averageVolume,
    peak_volume: peakVolume,
    monthly_trends: allMonthlyData.slice(0, 12), // Keep last 12 months
    data_points: allMonthlyData.length,
    keywords: processedKeywords,
    location_code: volumeData.location_code,
    language_code: volumeData.language_code
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
    // Extract keywords from prompt
    const keywords = extractKeywordsFromPrompt(prompt);
    
    if (keywords.length === 0) {
      console.warn('No keywords extracted from prompt:', prompt);
      return null;
    }

    // Fetch volume data
    const volumeResponse = await fetchAIKeywordVolume(keywords, locationCode);
    
    if (!volumeResponse || !volumeResponse.success) {
      return null;
    }

    // Process and return the data
    return processAIVolumeData(volumeResponse.data);

  } catch (error) {
    console.error('Error getting AI volume for prompt:', prompt, error.message);
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
      const keywords = extractKeywordsFromPrompt(prompt);
      promptKeywordMap.set(index, keywords);
      allKeywords.push(...keywords);
    });

    // Remove duplicates and limit total keywords
    const uniqueKeywords = [...new Set(allKeywords)].slice(0, 50);

    if (uniqueKeywords.length === 0) {
      console.warn('No keywords extracted from any prompts');
      return prompts.map(() => null);
    }

    // Fetch volume data for all keywords
    const volumeResponse = await fetchAIKeywordVolume(uniqueKeywords, locationCode);
    
    if (!volumeResponse || !volumeResponse.success) {
      return prompts.map(() => null);
    }

    // Create keyword volume lookup
    const keywordVolumeMap = new Map();
    if (volumeResponse.data.items) {
      volumeResponse.data.items.forEach(item => {
        keywordVolumeMap.set(item.keyword, item);
      });
    }

    // Map results back to original prompts
    const results = prompts.map((prompt, index) => {
      const promptKeywords = promptKeywordMap.get(index) || [];
      
      // Find matching volume data for this prompt's keywords
      const matchingItems = promptKeywords
        .map(keyword => keywordVolumeMap.get(keyword))
        .filter(item => item && item.ai_search_volume > 0);

      if (matchingItems.length === 0) {
        return null;
      }

      // Create synthetic volume data for this prompt
      const syntheticVolumeData = {
        items: matchingItems,
        location_code: volumeResponse.data.location_code,
        language_code: volumeResponse.data.language_code
      };

      return processAIVolumeData(syntheticVolumeData);
    });

    return results;

  } catch (error) {
    console.error('Error getting batch AI volume data:', error.message);
    return prompts.map(() => null);
  }
}

module.exports = {
  extractKeywordsFromPrompt,
  fetchAIKeywordVolume,
  processAIVolumeData,
  getPromptAIVolume,
  getBatchPromptAIVolume
};

