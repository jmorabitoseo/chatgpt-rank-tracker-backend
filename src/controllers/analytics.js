// controllers/analyticsController.js

const { supabase } = require("../config");

/**
 * Helper: Calculate percentage change between two values with safeguards
 */
const calculatePercentageChange = (current, previous) => {
  // Handle edge cases
  if (!previous || previous === 0) {
    return current > 0 ? 100 : 0; // If no previous data but current exists, show 100% growth
  }
  
  if (!current || current === 0) {
    return -100; // Complete decline
  }
  
  const percentChange = ((current - previous) / previous) * 100;
  
  // Cap extreme values for better UX (optional - you can remove this if you want raw values)
  const cappedChange = Math.max(-100, Math.min(999, percentChange));
  
  return Math.round(cappedChange * 10) / 10;
};

/**
 * Helper: Filter tracking results by time range in days
 */
const filterByTimeRange = (results, startDaysAgo, endDaysAgo = 0) => {
  if (!results || !Array.isArray(results)) return [];
  const now = Date.now();
  const startTime = now - startDaysAgo * 24 * 60 * 60 * 1000;
  const endTime = now - endDaysAgo * 24 * 60 * 60 * 1000;
  
  return results.filter((r) => {
    if (!r.timestamp) return false;
    const timestamp = r.timestamp;
    return timestamp >= startTime && timestamp <= endTime;
  });
};

/**
 * Helper: Filter tracking results by custom date range
 */
const filterByCustomDateRange = (results, startDate, endDate) => {
  if (!results || !Array.isArray(results)) return [];
  if (!startDate || !endDate) return results;
  
  const startTime = new Date(startDate).getTime();
  const endTime = new Date(endDate).getTime();
  
  // Add one day to endTime to include the entire end date
  const endTimeInclusive = endTime + (24 * 60 * 60 * 1000) - 1;
  
  const filteredResults = results.filter((r) => {
    if (!r.timestamp) return false;
    
    // Handle both timestamp formats (number and string)
    let timestamp;
    if (typeof r.timestamp === 'string') {
      timestamp = new Date(r.timestamp).getTime();
    } else {
      timestamp = Number(r.timestamp);
    }
    
    if (isNaN(timestamp)) return false;
    
    return timestamp >= startTime && timestamp <= endTimeInclusive;
  });
  
  return filteredResults;
};

/**
 * Helper: Parse SERP JSON field safely
 */
const parseSerpData = (serp) => {
  if (!serp) return null;
  if (typeof serp === "object") return serp;
  try {
    return JSON.parse(serp);
  } catch (e) {
    return null;
  }
};

/**
 * Helper: Extract domain from URL
 */
const extractDomain = (url) => {
  try {
    const domain = new URL(url).hostname;
    return domain.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
};



/**
 * Helper: Filter prompts by tags
 */
const filterPromptsByTags = async (projectId, selectedTags) => {
  if (!selectedTags || selectedTags.length === 0) {
    return null; // No filtering needed
  }

  const { data: promptsWithTags, error } = await supabase
    .from("prompts")
    .select(`
      id, 
      enabled, 
      created_at,
      prompt_tags!inner(
        tag_id,
        tags!inner(
          name
        )
      )
    `)
    .eq("project_id", projectId)
    .in("prompt_tags.tags.name", selectedTags);

  if (error) {
    throw new Error(`Failed to fetch prompts with tags: ${error.message}`);
  }

  // Flatten and deduplicate
  const uniquePrompts = new Map();
  promptsWithTags?.forEach(prompt => {
    if (!uniquePrompts.has(prompt.id)) {
      uniquePrompts.set(prompt.id, {
        id: prompt.id,
        enabled: prompt.enabled,
        created_at: prompt.created_at
      });
    }
  });
  
  return Array.from(uniquePrompts.values());
};

/**
 * Main Controller: Get User Analytics
 */
const getUserAnalytics = async (req, res) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days) || 90;
    const projectId = req.query.projectId; // Optional project ID for project-specific analytics
    const startDate = req.query.startDate; // Optional start date
    const endDate = req.query.endDate; // Optional end date
    const selectedTags = req.query.tags ? req.query.tags.split(',') : []; // Optional tag filtering

    if (!userId) {
      return res.status(400).json({
        error: "userId is required in URL params",
        example: "/api/analytics/:userId?days=90&projectId=optional&startDate=2024-01-01&endDate=2024-01-31",
      });
    }


    // ========================================
    // STEP 1: Fetch projects for the user (specific or all)
    // ========================================
    let projectIds = [];
    
    if (projectId) {
      // Fetch specific project and verify it belongs to the user
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id")
        .eq("id", projectId)
        .eq("user_id", userId)
        .single();

      if (projectError) {
        throw new Error(`Failed to fetch project: ${projectError.message}`);
      }

      if (!project) {
        return res.status(404).json({
          error: "Project not found or does not belong to user",
          projectId: projectId
        });
      }

      projectIds = [projectId];
    } else {
      // Fetch all projects for the user
      const { data: projects, error: projectsError } = await supabase
        .from("projects")
        .select("id")
        .eq("user_id", userId);

      if (projectsError) {
        throw new Error(`Failed to fetch projects: ${projectsError.message}`);
      }

      if (!projects || projects.length === 0) {
        return res.json(getEmptyAnalytics(userId, days));
      }

      projectIds = projects.map((p) => p.id);
    }

    // ========================================
    // STEP 2: Fetch prompts (with tag filtering if specified)
    // ========================================
    let allPrompts;
    
    if (selectedTags.length > 0 && projectId) {
      // Filter prompts by tags for specific project
      allPrompts = await filterPromptsByTags(projectId, selectedTags);
    } else {
      // Fetch all prompts without tag filtering
      const { data: prompts, error: promptsError } = await supabase
        .from("prompts")
        .select("id, enabled, created_at")
        .in("project_id", projectIds);

      if (promptsError) {
        throw new Error(`Failed to fetch prompts: ${promptsError.message}`);
      }
      
      allPrompts = prompts;
    }


    // ========================================
    // STEP 3: Fetch tracking results (filtered by prompts if tags are selected)
    // ========================================
    let allTrackingResults;
    
    if (selectedTags.length > 0 && projectId && allPrompts && allPrompts.length > 0) {
      // If tags are selected, only fetch tracking results for the filtered prompts
      const promptIds = allPrompts.map(p => p.id);
      const { data: trackingResults, error: trackingError } = await supabase
        .from("tracking_results")
        .select("*")
        .eq("project_id", projectId)
        .in("prompt_id", promptIds);

      if (trackingError) {
        throw new Error(
          `Failed to fetch tracking results for tagged prompts: ${trackingError.message}`
        );
      }
      
      allTrackingResults = trackingResults || [];
    } else {
      // Fetch all tracking results without tag filtering
      const { data: trackingResults, error: trackingError } = await supabase
        .from("tracking_results")
        .select("*")
        .in("project_id", projectIds);

      if (trackingError) {
        throw new Error(
          `Failed to fetch tracking results: ${trackingError.message}`
        );
      }
      
      allTrackingResults = trackingResults || [];
    }


    // ========================================
    // STEP 4: Filter results by time periods (FIXED LOGIC)
    // ========================================
    let currentResults, previousResults;
    
    if (startDate && endDate) {
      // Use custom date range
      currentResults = filterByCustomDateRange(allTrackingResults, startDate, endDate);
      // For previous period, calculate a period of the same length before the start date
      const rangeLength = new Date(endDate).getTime() - new Date(startDate).getTime();
      const previousEndDate = new Date(new Date(startDate).getTime() - 1);
      const previousStartDate = new Date(previousEndDate.getTime() - rangeLength);
      previousResults = filterByCustomDateRange(allTrackingResults, previousStartDate.toISOString(), previousEndDate.toISOString());
    } else {
      // Use days-based filtering (default behavior)
      currentResults = filterByTimeRange(allTrackingResults, days, 0);
      previousResults = filterByTimeRange(allTrackingResults, days * 2, days);
    }


    // Get prompts that were actually used in tracking results for the current period
    // This is more accurate than filtering by prompt creation date
    const currentPromptIds = new Set(currentResults.map(r => r.prompt_id).filter(Boolean));
    const previousPromptIds = new Set(previousResults.map(r => r.prompt_id).filter(Boolean));
    
    const currentPrompts = allPrompts.filter(p => p.enabled && currentPromptIds.has(p.id));
    const previousPrompts = allPrompts.filter(p => p.enabled && previousPromptIds.has(p.id));

    // ========================================
    // STEP 5: Calculate all metrics
    // ========================================
    const kpiMetrics = calculateKPIMetrics(
      currentResults,
      previousResults,
      currentPrompts,
      previousPrompts,
      allPrompts,
      days
    );

    const brandPresence = calculateBrandPresence(currentResults);
    const domainPresence = calculateDomainPresence(currentResults);
    const sentimentDistribution = calculateSentimentDistribution(currentResults);
    const salienceDistribution = calculateSalienceDistribution(currentResults);
    const serpFeatures = calculateSerpFeatures(currentResults);
    const mostCitedPages = calculateMostCitedPages(currentResults);
    const mostCitedWebsites = calculateMostCitedWebsites(currentResults);
    const topPerformingKeywords = getTopPerformingKeywords(
      currentResults,
      allPrompts,
      projectId
    );
    // AI insights removed - using frontend-generated fallback insights only


    // ========================================
    // STEP 6: Return response with safety checks
    // ========================================
    
    // Ensure all calculated values are valid and have proper structure
    const safeResponse = {
      user_id: userId,
      time_range_days: days,
      project_id: projectId || null,
      project_scope: projectId ? 'specific' : 'all',
      date_range: startDate && endDate ? { startDate, endDate } : null,
      selected_tags: selectedTags.length > 0 ? selectedTags : null,
      total_results: currentResults ? currentResults.length : 0,
      kpi_metrics: kpiMetrics || {},
      brand_presence: brandPresence || { mentioned: { count: 0, percentage: 0 }, not_mentioned: { count: 0, percentage: 0 } },
      domain_presence: domainPresence || { cited: { count: 0, percentage: 0 }, not_cited: { count: 0, percentage: 0 } },
      sentiment_distribution: sentimentDistribution || {
        very_positive: { count: 0, percentage: 0 },
        positive: { count: 0, percentage: 0 },
        neutral: { count: 0, percentage: 0 },
        slightly_neutral: { count: 0, percentage: 0 },
        negative: { count: 0, percentage: 0 },
        not_mentions: { count: 0, percentage: 0 }
      },
      salience_distribution: salienceDistribution || {
        primary_focus: { count: 0, percentage: 0 },
        major_focus: { count: 0, percentage: 0 },
        moderate_focus: { count: 0, percentage: 0 },
        minor_focus: { count: 0, percentage: 0 },
        low: { count: 0, percentage: 0 },
        not_mentions: { count: 0, percentage: 0 }
      },
      serp_features: serpFeatures || [],
      most_cited_pages: mostCitedPages || [],
      most_cited_websites: mostCitedWebsites || [],
      top_performing_keywords: topPerformingKeywords || []
    };

    return res.json(safeResponse);
  } catch (error) {
    console.error("Analytics API Error:", error);
    return res.status(500).json({
      error: "Failed to fetch analytics",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// ========================================
// CALCULATION FUNCTIONS
// ========================================

/**
 * Calculate KPI Metrics with trends (FIXED TREND LOGIC)
 */
function calculateKPIMetrics(
  currentResults,
  previousResults,
  currentPrompts,
  previousPrompts,
  allPrompts,
  days
) {
  // 1. Total Keywords (enabled prompts count)
  const totalKeywords = allPrompts.filter((p) => p.enabled).length;
  const currentKeywordsCount = currentPrompts.length;
  const previousKeywordsCount = previousPrompts.length;
  
  // Use the actual prompt counts from the filtered results
  const keywordsAtCurrentPeriodEnd = currentKeywordsCount;
  const keywordsAtPreviousPeriodEnd = previousKeywordsCount;

  // 2. Average Sentiment Score
  const currentSentiments = currentResults
    .filter((r) => r.sentiment != null && !isNaN(r.sentiment))
    .map((r) => Number(r.sentiment));
  const avgSentiment =
    currentSentiments.length > 0
      ? currentSentiments.reduce((a, b) => a + b, 0) / currentSentiments.length
      : 0;


  const prevSentiments = previousResults
    .filter((r) => r.sentiment != null && !isNaN(r.sentiment))
    .map((r) => Number(r.sentiment));
  const prevAvgSentiment =
    prevSentiments.length > 0
      ? prevSentiments.reduce((a, b) => a + b, 0) / prevSentiments.length
      : 0;

  // 3. Total Search Volume
  const totalSearchVolume = currentResults.reduce(
    (sum, r) => sum + (r.ai_search_volume ? Number(r.ai_search_volume) : 0),
    0
  );
  const prevSearchVolume = previousResults.reduce(
    (sum, r) => sum + (r.ai_search_volume ? Number(r.ai_search_volume) : 0),
    0
  );

  // 4. Brand Mentions (sum of mention_count)
  const brandMentions = currentResults.reduce(
    (sum, r) => sum + (r.mention_count ? Number(r.mention_count) : 0),
    0
  );
  const prevBrandMentions = previousResults.reduce(
    (sum, r) => sum + (r.mention_count ? Number(r.mention_count) : 0),
    0
  );

  // 5. Domain Mentions (sum of domain_mention_count)
  const domainMentions = currentResults.reduce(
    (sum, r) => sum + (r.domain_mention_count ? Number(r.domain_mention_count) : 0),
    0
  );
  const prevDomainMentions = previousResults.reduce(
    (sum, r) => sum + (r.domain_mention_count ? Number(r.domain_mention_count) : 0),
    0
  );

  // 6. Brand Presence % (is_present = true, excluding null)
  const currentWithPresence = currentResults.filter(
    (r) => r.is_present !== null
  );
  const brandPresentCount = currentWithPresence.filter(
    (r) => r.is_present === true
  ).length;
  const brandPresencePercent =
    currentWithPresence.length > 0
      ? (brandPresentCount / currentWithPresence.length) * 100
      : 0;

  const prevWithPresence = previousResults.filter((r) => r.is_present !== null);
  const prevBrandPresentCount = prevWithPresence.filter(
    (r) => r.is_present === true
  ).length;
  const prevBrandPresencePercent =
    prevWithPresence.length > 0
      ? (prevBrandPresentCount / prevWithPresence.length) * 100
      : 0;

  // 7. Domain Presence % (is_domain_present = true, excluding null)
  const currentWithDomainPresence = currentResults.filter(
    (r) => r.is_domain_present !== null
  );
  const domainPresentCount = currentWithDomainPresence.filter(
    (r) => r.is_domain_present === true
  ).length;
  const domainPresencePercent =
    currentWithDomainPresence.length > 0
      ? (domainPresentCount / currentWithDomainPresence.length) * 100
      : 0;

  const prevWithDomainPresence = previousResults.filter(
    (r) => r.is_domain_present !== null
  );
  const prevDomainPresentCount = prevWithDomainPresence.filter(
    (r) => r.is_domain_present === true
  ).length;
  const prevDomainPresencePercent =
    prevWithDomainPresence.length > 0
      ? (prevDomainPresentCount / prevWithDomainPresence.length) * 100
      : 0;

  // 8. Citation Opportunities (brand mentions without domain citations)
  const citationOpportunities = brandMentions - domainMentions;
  const prevCitationOpportunities = prevBrandMentions - prevDomainMentions;


  return {
    total_keywords: {
      value: currentKeywordsCount,
      label: "Total Keywords",
      subtitle: "Active in selected period",
      trend: calculatePercentageChange(
        keywordsAtCurrentPeriodEnd,
        keywordsAtPreviousPeriodEnd
      ),
    },
    avg_sentiment_score: {
      value: Math.round(avgSentiment * 10) / 10,
      label: "Avg Sentiment Score",
      subtitle: "Positive responses",
      trend: calculatePercentageChange(avgSentiment, prevAvgSentiment),
    },
    total_search_volume: {
      value: totalSearchVolume,
      label: "Total Search Volume",
      subtitle: "Combined monthly search volume",
      trend: calculatePercentageChange(totalSearchVolume, prevSearchVolume),
    },
    brand_mentions: {
      value: brandMentions,
      label: "Brand Mentions",
      subtitle: "Total mentions found",
      trend: calculatePercentageChange(brandMentions, prevBrandMentions),
    },
    domain_mentions: {
      value: domainMentions,
      label: "Domain Mentions",
      subtitle: "Total citations found",
      trend: calculatePercentageChange(domainMentions, prevDomainMentions),
    },
    brand_presence: {
      value: Math.round(brandPresencePercent * 10) / 10,
      label: "Brand Presence",
      subtitle: "Mentioned in responses",
      trend: calculatePercentageChange(
        brandPresencePercent,
        prevBrandPresencePercent
      ),
    },
    domain_presence: {
      value: Math.round(domainPresencePercent * 10) / 10,
      label: "Domain Presence",
      subtitle: "Domain cited",
      trend: calculatePercentageChange(
        domainPresencePercent,
        prevDomainPresencePercent
      ),
    },
    citation_opportunities: {
      value: Math.max(0, citationOpportunities),
      label: "Citation Opportunities",
      subtitle: "Uncited mentions",
      trend: calculatePercentageChange(
        citationOpportunities,
        prevCitationOpportunities
      ),
    },
  };
}

/**
 * Calculate Brand Presence (is_present field)
 */
function calculateBrandPresence(results) {
  try {
    if (!results || !Array.isArray(results)) {
      return {
        mentioned: { count: 0, percentage: 0 },
        not_mentioned: { count: 0, percentage: 0 }
      };
    }

    const validResults = results.filter((r) => r && r.is_present !== null);
    const mentioned = validResults.filter((r) => r.is_present === true).length;
    const notMentioned = validResults.length - mentioned;
    const total = validResults.length || 1;

    return {
      mentioned: {
        count: mentioned,
        percentage: Math.round((mentioned / total) * 100),
      },
      not_mentioned: {
        count: notMentioned,
        percentage: Math.round((notMentioned / total) * 100),
      },
    };
  } catch (error) {
    console.warn('Error calculating brand presence:', error);
    return {
      mentioned: { count: 0, percentage: 0 },
      not_mentioned: { count: 0, percentage: 0 }
    };
  }
}

/**
 * Calculate Domain Presence (is_domain_present field)
 */
function calculateDomainPresence(results) {
  try {
    if (!results || !Array.isArray(results)) {
      return {
        cited: { count: 0, percentage: 0 },
        not_cited: { count: 0, percentage: 0 }
      };
    }

    const validResults = results.filter((r) => r && r.is_domain_present !== null);
    const cited = validResults.filter((r) => r.is_domain_present === true).length;
    const notCited = validResults.length - cited;
    const total = validResults.length || 1;

    return {
      cited: {
        count: cited,
        percentage: Math.round((cited / total) * 100),
      },
      not_cited: {
        count: notCited,
        percentage: Math.round((notCited / total) * 100),
      },
    };
  } catch (error) {
    console.warn('Error calculating domain presence:', error);
    return {
      cited: { count: 0, percentage: 0 },
      not_cited: { count: 0, percentage: 0 }
    };
  }
}

/**
 * Calculate Sentiment Distribution
 * Very Positive: sentiment >= 81
 * Positive: sentiment >= 61
 * Neutral: sentiment >= 41
 * Slightly Neutral: sentiment >= 21
 * Negative: sentiment >= 1
 * Not available: sentiment < 1
 */
function calculateSentimentDistribution(results) {
  // Initialize with safe defaults
  const counts = { 
    very_positive: 0, 
    positive: 0, 
    neutral: 0, 
    slightly_neutral: 0, 
    negative: 0, 
    not_mentions: 0 
  };

  // Handle null/undefined results
  if (!results || !Array.isArray(results)) {
    return {
      very_positive: { count: 0, percentage: 0 },
      positive: { count: 0, percentage: 0 },
      neutral: { count: 0, percentage: 0 },
      slightly_neutral: { count: 0, percentage: 0 },
      negative: { count: 0, percentage: 0 },
      not_mentions: { count: 0, percentage: 0 }
    };
  }

  results.forEach((r) => {
    try {
      if (r && r.sentiment != null && !isNaN(r.sentiment)) {
        const score = Number(r.sentiment);
        if (score >= 81) counts.very_positive++;
        else if (score >= 61) counts.positive++;
        else if (score >= 41) counts.neutral++;
        else if (score >= 21) counts.slightly_neutral++;
        else if (score >= 1) counts.negative++;
        else counts.not_mentions++;
      } else {
        counts.not_mentions++;
      }
    } catch (error) {
      console.warn('Error processing sentiment data:', error);
      counts.not_mentions++;
    }
  });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0) || 1;

  return {
    very_positive: {
      count: counts.very_positive,
      percentage: Math.round((counts.very_positive / total) * 100),
    },
    positive: {
      count: counts.positive,
      percentage: Math.round((counts.positive / total) * 100),
    },
    neutral: {
      count: counts.neutral,
      percentage: Math.round((counts.neutral / total) * 100),
    },
    slightly_neutral: {
      count: counts.slightly_neutral,
      percentage: Math.round((counts.slightly_neutral / total) * 100),
    },
    negative: {
      count: counts.negative,
      percentage: Math.round((counts.negative / total) * 100),
    },
    not_mentions: {
      count: counts.not_mentions,
      percentage: Math.round((counts.not_mentions / total) * 100),
    },
  };
}

/**
 * Calculate Salience Distribution
 * Primary Focus: salience >= 81
 * Major Focus: salience >= 61
 * Moderate Focus: salience >= 41
 * Minor Focus: salience >= 11
 * Low: salience >= 1
 * Not available: salience < 1
 */
function calculateSalienceDistribution(results) {
  // Initialize with safe defaults
  const counts = { 
    primary_focus: 0, 
    major_focus: 0, 
    moderate_focus: 0, 
    minor_focus: 0, 
    low: 0, 
    not_mentions: 0 
  };

  // Handle null/undefined results
  if (!results || !Array.isArray(results)) {
    return {
      primary_focus: { count: 0, percentage: 0 },
      major_focus: { count: 0, percentage: 0 },
      moderate_focus: { count: 0, percentage: 0 },
      minor_focus: { count: 0, percentage: 0 },
      low: { count: 0, percentage: 0 },
      not_mentions: { count: 0, percentage: 0 }
    };
  }

  results.forEach((r) => {
    try {
      if (r && r.salience != null && !isNaN(r.salience)) {
        const score = Number(r.salience);
        if (score >= 81) counts.primary_focus++;
        else if (score >= 61) counts.major_focus++;
        else if (score >= 41) counts.moderate_focus++;
        else if (score >= 11) counts.minor_focus++;
        else if (score >= 1) counts.low++;
        else counts.not_mentions++;
      } else {
        counts.not_mentions++;
      }
    } catch (error) {
      console.warn('Error processing salience data:', error);
      counts.not_mentions++;
    }
  });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0) || 1;

  return {
    primary_focus: {
      count: counts.primary_focus,
      percentage: Math.round((counts.primary_focus / total) * 100),
    },
    major_focus: {
      count: counts.major_focus,
      percentage: Math.round((counts.major_focus / total) * 100),
    },
    moderate_focus: {
      count: counts.moderate_focus,
      percentage: Math.round((counts.moderate_focus / total) * 100),
    },
    minor_focus: {
      count: counts.minor_focus,
      percentage: Math.round((counts.minor_focus / total) * 100),
    },
    low: {
      count: counts.low,
      percentage: Math.round((counts.low / total) * 100),
    },
    not_mentions: {
      count: counts.not_mentions,
      percentage: Math.round((counts.not_mentions / total) * 100),
    },
  };
}

/**
 * Calculate SERP Features (only those defined in EnhancedAnalyzer)
 */
function calculateSerpFeatures(results) {
  const features = {
    chat_gpt_text: 0,
    chat_gpt_table: 0,
    chat_gpt_navigation_list: 0,
    chat_gpt_images: 0,
    chat_gpt_local_businesses: 0,
    chat_gpt_products: 0,
  };

  results.forEach((r) => {
    const serp = parseSerpData(r.serp);
    if (serp) {
      // Only check for features defined in EnhancedAnalyzer
      if (serp.chat_gpt_text) features.chat_gpt_text++;
      if (serp.chat_gpt_table) features.chat_gpt_table++;
      if (serp.chat_gpt_navigation_list) features.chat_gpt_navigation_list++;
      if (serp.chat_gpt_images) features.chat_gpt_images++;
      if (serp.chat_gpt_local_businesses) features.chat_gpt_local_businesses++;
      if (serp.chat_gpt_products) features.chat_gpt_products++;
    }
  });

  const total = results.length || 1;

  return Object.entries(features).map(([feature, count]) => ({
    feature: feature
      .replace(/^chat_gpt_/, '') // Remove 'chat_gpt_' prefix
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
    count: count,
    percentage: Math.round((count / total) * 100),
  }));
}

/**
 * Calculate Most Cited Pages
 */
function calculateMostCitedPages(results) {
  const urlCounts = new Map();

  results.forEach((r) => {
    try {
      // Parse citations from the citations field (array of citation objects)
      let citations = [];
      
      if (r.citations && Array.isArray(r.citations)) {
        // Citations is already an array of objects
        citations = r.citations;
      } else if (r.citations && typeof r.citations === 'string') {
        // Citations is a JSON string, parse it
        citations = JSON.parse(r.citations);
      }

      // Count each URL
      citations.forEach((citation) => {
        if (citation.url) {
          const url = citation.url;
          const count = urlCounts.get(url) || 0;
          urlCounts.set(url, count + 1);
        }
      });
    } catch (e) {
      // Skip invalid citations data
      console.warn('Error parsing citations for most cited pages:', e.message);
    }
  });

  // Calculate total citations for percentage calculation
  const totalCitations = Array.from(urlCounts.values()).reduce((sum, count) => sum + count, 0);
  const total = totalCitations || 1;
  
  return Array.from(urlCounts.entries())
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10) // Return top 10 most cited pages
    .map(([url, count]) => ({
      url,
      count,
      percentage: Math.round((count / total) * 100)
    }));
}

/**
 * Calculate Most Cited Websites
 */
function calculateMostCitedWebsites(results) {
  const domainCounts = new Map();

  results.forEach((r) => {
    try {
      // Parse citations from the citations field (array of citation objects)
      let citations = [];
      
      if (r.citations && Array.isArray(r.citations)) {
        // Citations is already an array of objects
        citations = r.citations;
      } else if (r.citations && typeof r.citations === 'string') {
        // Citations is a JSON string, parse it
        citations = JSON.parse(r.citations);
      }

      // Count each domain from citations
      citations.forEach((citation) => {
        if (citation.domain) {
          // Use the domain field directly if available
          const domain = citation.domain.replace(/^www\./, ''); // Remove www. prefix
          const count = domainCounts.get(domain) || 0;
          domainCounts.set(domain, count + 1);
        } else if (citation.url) {
          // Fallback: extract domain from URL if domain field is not available
          const domain = extractDomain(citation.url);
          if (domain) {
            const count = domainCounts.get(domain) || 0;
            domainCounts.set(domain, count + 1);
          }
        }
      });
    } catch (e) {
      // Skip invalid citations data
      console.warn('Error parsing citations for most cited websites:', e.message);
    }
  });

  // Calculate total citations for percentage calculation
  const totalCitations = Array.from(domainCounts.values()).reduce((sum, count) => sum + count, 0);
  const total = totalCitations || 1;
  
  return Array.from(domainCounts.entries())
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10) // Return top 10 most cited websites
    .map(([domain, count]) => ({
      domain,
      count,
      percentage: Math.round((count / total) * 100)
    }));
}

/**
 * Generate AI Insights
 */
// generateAIInsights function removed - using frontend-generated fallback insights only

/**
 * Get Top Performing Keywords (Top 5 by sentiment and volume)
 */
function getTopPerformingKeywords(results, allPrompts, projectId) {
  try {
    // Add safety checks
    if (!results || !Array.isArray(results)) {
      console.warn('Invalid results data for getTopPerformingKeywords');
      return [];
    }
    
    if (!allPrompts || !Array.isArray(allPrompts)) {
      console.warn('Invalid allPrompts data for getTopPerformingKeywords');
      return [];
    }

    // Create a map of prompt_id to prompt data for quick lookup
    const promptMap = new Map(allPrompts.map((p) => [p.id, p]));

  // Filter results to only include those from the current project if projectId is specified
  const filteredResults = projectId 
    ? results.filter(r => r.project_id === projectId)
    : results;

  return filteredResults
    .filter(r => {
      // Must have valid sentiment (not null and not 0) OR valid search volume (not null and > 0)
      const hasValidSentiment = r.sentiment !== null && r.sentiment !== 0;
      const hasValidSearchVolume = r.ai_search_volume !== null && r.ai_search_volume > 0;
      
      // Include only if at least one of sentiment or search volume is meaningful
      return hasValidSentiment || hasValidSearchVolume;
    })
    .map((r) => {
      const trends = r.ai_monthly_trends;
      let trend = "Unknown";

      if (trends && Array.isArray(trends) && trends.length >= 2) {
        const latest = trends[trends.length - 1];
        const previous = trends[trends.length - 2];
        if (latest > previous) trend = "Rising";
        else if (latest < previous) trend = "Declining";
        else trend = "Stable";
      }

      // Get prompt data for additional context
      const promptData = promptMap.get(r.prompt_id);

      return {
        // Core keyword data
        keyword: r.prompt || "Unknown",
        search_volume: r.ai_search_volume || 0,
        sentiment_score: r.sentiment || 0,
        trend: trend,
        
        // Additional dynamic data for complete tracking result
        id: r.id,
        prompt_id: r.prompt_id,
        project_id: r.project_id,
        user_id: r.user_id,
        timestamp: r.timestamp,
        
        // Brand and domain presence
        is_present: r.is_present,
        is_domain_present: r.is_domain_present,
        mention_count: r.mention_count || 0,
        domain_mention_count: r.domain_mention_count || 0,
        
        // Analysis data
        salience: r.salience || 0,
        lcp: r.lcp || 0,
        actionability: r.actionability || 0,
        web_search: r.web_search || false,
        intent_classification: r.intent_classification || 'informational',
        
        // Response and mentions
        response: r.response || '',
        brand_mentions: r.brand_mentions || [],
        domain_mentions: r.domain_mentions || [],
        
        // SERP features
        serp: r.serp,
        serp_features: r.serp_features || [],
        
        // Status and metadata
        status: r.status || 'fulfilled',
        source: r.source || 'analytics',
        
        // Snapshot and HTML content fields
        snapshot_id: r.snapshot_id,
        html_content: r.html_content,
        html_content_fetched_at: r.html_content_fetched_at,
        
        // AI volume trends
        ai_monthly_trends: r.ai_monthly_trends || [],
        ai_volume_fetched_at: r.ai_volume_fetched_at,
        ai_volume_location_code: r.ai_volume_location_code,
        
        // Additional tracking fields
        created_at: r.created_at,
        updated_at: r.updated_at,
        error_message: r.error_message,
        retry_count: r.retry_count,
        
        // Prompt metadata
        prompt_enabled: promptData ? promptData.enabled : true,
        prompt_created_at: promptData ? promptData.created_at : null,
      };
    })
    .sort((a, b) => {
      // First, prioritize keywords with both sentiment and volume > 0
      const aHasBoth = (a.sentiment_score > 0) && (a.search_volume > 0);
      const bHasBoth = (b.sentiment_score > 0) && (b.search_volume > 0);
      
      if (aHasBoth && !bHasBoth) return -1;
      if (!aHasBoth && bHasBoth) return 1;
      
      // If both have the same "completeness", sort by sentiment score (higher is better)
      const sentimentDiff = b.sentiment_score - a.sentiment_score;
      if (sentimentDiff !== 0) return sentimentDiff;
      
      // Then by search volume (higher is better)
      const volumeDiff = b.search_volume - a.search_volume;
      if (volumeDiff !== 0) return volumeDiff;
      
      // Finally by salience (higher is better)
      return (b.salience || 0) - (a.salience || 0);
    })
    .slice(0, 5); // Return top 5 keywords
  } catch (error) {
    console.warn('Error getting top performing keywords:', error);
    return [];
  }
}

/**
 * Return Empty Analytics Structure
 */
function getEmptyAnalytics(userId, days) {
  return {
    user_id: userId,
    time_range_days: days,
    total_results: 0,
    kpi_metrics: {
      total_keywords: {
        value: 0,
        label: "Total Keywords",
        subtitle: "Active in selected period",
        trend: 0,
      },
      avg_sentiment_score: {
        value: 0,
        label: "Avg Sentiment Score",
        subtitle: "Positive responses",
        trend: 0,
      },
      total_search_volume: {
        value: 0,
        label: "Total Search Volume",
        subtitle: "Combined monthly search volume",
        trend: 0,
      },
      brand_mentions: {
        value: 0,
        label: "Brand Mentions",
        subtitle: "Total mentions found",
        trend: 0,
      },
      domain_mentions: {
        value: 0,
        label: "Domain Mentions",
        subtitle: "Total citations found",
        trend: 0,
      },
      brand_presence: {
        value: 0,
        label: "Brand Presence",
        subtitle: "Mentioned in responses",
        trend: 0,
      },
      domain_presence: {
        value: 0,
        label: "Domain Presence",
        subtitle: "Domain cited",
        trend: 0,
      },
      citation_opportunities: {
        value: 0,
        label: "Citation Opportunities",
        subtitle: "Uncited mentions",
        trend: 0,
      },
    },
    brand_presence: {
      mentioned: { count: 0, percentage: 0 },
      not_mentioned: { count: 0, percentage: 0 },
    },
    domain_presence: {
      cited: { count: 0, percentage: 0 },
      not_cited: { count: 0, percentage: 0 },
    },
    sentiment_distribution: {
      very_positive: { count: 0, percentage: 0 },
      positive: { count: 0, percentage: 0 },
      neutral: { count: 0, percentage: 0 },
      slightly_neutral: { count: 0, percentage: 0 },
      negative: { count: 0, percentage: 0 },
      not_mentions: { count: 0, percentage: 0 },
    },
    salience_distribution: {
      primary_focus: { count: 0, percentage: 0 },
      major_focus: { count: 0, percentage: 0 },
      moderate_focus: { count: 0, percentage: 0 },
      minor_focus: { count: 0, percentage: 0 },
      low: { count: 0, percentage: 0 },
      not_mentions: { count: 0, percentage: 0 },
    },
    serp_features: [],
    most_cited_pages: [],
    most_cited_websites: [],
    top_performing_keywords: [],
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getUserAnalytics,
};
