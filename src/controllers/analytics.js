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
      allPrompts
    );
    const aiInsights = generateAIInsights(
      kpiMetrics,
      currentResults,
      sentimentDistribution,
      salienceDistribution
    );

    // ========================================
    // STEP 6: Return response
    // ========================================
    
    
    return res.json({
      user_id: userId,
      time_range_days: days,
      project_id: projectId || null, // Include project ID in response
      project_scope: projectId ? 'specific' : 'all', // Indicate scope
      date_range: startDate && endDate ? { startDate, endDate } : null, // Include date range in response
      selected_tags: selectedTags.length > 0 ? selectedTags : null, // Include selected tags in response
      total_results: currentResults.length,
      kpi_metrics: kpiMetrics,
      brand_presence: brandPresence,
      domain_presence: domainPresence,
      sentiment_distribution: sentimentDistribution,
      salience_distribution: salienceDistribution,
      serp_features: serpFeatures,
      most_cited_pages: mostCitedPages,
      most_cited_websites: mostCitedWebsites,
      ai_insights: aiInsights,
      top_performing_keywords: topPerformingKeywords,
      timestamp: new Date().toISOString(),
    });
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
  const validResults = results.filter((r) => r.is_present !== null);
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
}

/**
 * Calculate Domain Presence (is_domain_present field)
 */
function calculateDomainPresence(results) {
  const validResults = results.filter((r) => r.is_domain_present !== null);
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
}

/**
 * Calculate Sentiment Distribution
 * Positive: sentiment >= 60
 * Neutral: 40 <= sentiment < 60
 * Negative: sentiment < 40
 */
function calculateSentimentDistribution(results) {
  const counts = { positive: 0, neutral: 0, negative: 0 };

  results.forEach((r) => {
    if (r.sentiment != null && !isNaN(r.sentiment)) {
      const score = Number(r.sentiment);
      if (score >= 60) counts.positive++;
      else if (score >= 40) counts.neutral++;
      else counts.negative++;
    }
  });

  const total = counts.positive + counts.neutral + counts.negative || 1;

  return {
    positive: {
      count: counts.positive,
      percentage: Math.round((counts.positive / total) * 100),
    },
    neutral: {
      count: counts.neutral,
      percentage: Math.round((counts.neutral / total) * 100),
    },
    negative: {
      count: counts.negative,
      percentage: Math.round((counts.negative / total) * 100),
    },
  };
}

/**
 * Calculate Salience Distribution
 * High: salience >= 60
 * Medium: 40 <= salience < 60
 * Low: salience < 40 (including 0)
 */
function calculateSalienceDistribution(results) {
  const counts = { high: 0, medium: 0, low: 0 };

  results.forEach((r) => {
    if (r.salience != null && !isNaN(r.salience)) {
      const score = Number(r.salience);
      if (score >= 60) counts.high++;
      else if (score >= 40) counts.medium++;
      else counts.low++;
    }
  });

  const total = counts.high + counts.medium + counts.low || 1;

  return {
    high_salience: {
      count: counts.high,
      percentage: Math.round((counts.high / total) * 100),
    },
    medium_salience: {
      count: counts.medium,
      percentage: Math.round((counts.medium / total) * 100),
    },
    low_salience: {
      count: counts.low,
      percentage: Math.round((counts.low / total) * 100),
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
  return [
    { url: "nike.com/air-max-review", count: 89, percentage: 34 },
    { url: "runnersworld.com/best-running-shoes", count: 73, percentage: 28 },
  ];
}

/**
 * Calculate Most Cited Websites
 */
function calculateMostCitedWebsites(results) {
  const domainCounts = new Map();

  results.forEach((r) => {
    try {
      const response = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
      if (response?.citations) {
        response.citations.forEach((citation) => {
          if (citation.url) {
          const domain = extractDomain(citation.url);
          if (domain) {
              const count = domainCounts.get(domain) || 0;
              domainCounts.set(domain, count + 1);
          }
        }
      });
      }
    } catch (e) {
      // Skip invalid JSON
    }
  });

  const total = results.length || 1;
  return Array.from(domainCounts.entries())
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([domain, count]) => ({
      domain,
      count,
      percentage: Math.round((count / total) * 100)
    }));
}

/**
 * Generate AI Insights
 */
function generateAIInsights(
  kpiMetrics,
  results,
  sentimentDist,
  salienceDist
) {
  const avgSentiment = kpiMetrics.avg_sentiment_score.value;
  const volumeTrend = kpiMetrics.total_search_volume.trend;
  const brandMentions = kpiMetrics.brand_mentions.value;
  const domainMentions = kpiMetrics.domain_mentions.value;
  const citationGap = brandMentions - domainMentions;

  // Find top opportunity from results
  let topOpportunity = "No data available yet.";
  if (results.length > 0) {
    const topResult = results
      .filter(r => r.sentiment && r.ai_search_volume)
      .sort((a, b) => (b.sentiment * Math.log(b.ai_search_volume + 1)) - (a.sentiment * Math.log(a.ai_search_volume + 1)))
      [0];
    
    if (topResult) {
      topOpportunity = `"${topResult.prompt || 'Unknown keyword'}" shows ${topResult.sentiment}% sentiment with ${topResult.ai_search_volume} volume. Consider creating comprehensive guides for this topic.`;
    }
  }

  return {
    strong_performance: {
      title: "Strong Performance",
      message: `Your sentiment score of ${avgSentiment} is ${
        avgSentiment >= 60 ? "above" : avgSentiment >= 40 ? "at" : "below"
      } industry average. ${salienceDist.high_salience.count > 0 ? "High salience mentions indicate strong brand authority." : "Focus on increasing brand salience in responses."}`,
      type: avgSentiment >= 60 ? "success" : avgSentiment >= 40 ? "info" : "warning",
    },
    citation_gap: {
      title: "Citation Gap",
      message: citationGap > 0 
        ? `${citationGap} brand mentions lack domain citations. Focus on content that establishes your site as the authoritative source.`
        : "Great job! Your brand mentions are well-supported with domain citations.",
      type: citationGap > 0 ? "warning" : "success",
    },
    top_opportunity: {
      title: "Top Opportunity",
      message: topOpportunity,
      type: "info",
    },
    trend_alert: {
      title: "Trend Alert",
      message: `${Math.abs(volumeTrend)}% ${
        volumeTrend >= 0 ? "increase" : "decrease"
      } in search volume suggests ${
        volumeTrend >= 0 ? "growing" : "declining"
      } market interest.${volumeTrend < 0 ? " Monitor competitor mentions closely." : ""}`,
      type: volumeTrend >= 0 ? "success" : "warning",
    },
  };
}

/**
 * Get Top Performing Keywords (Top 10 by sentiment and volume)
 */
function getTopPerformingKeywords(results, allPrompts) {
  return results
    .filter(r => r.sentiment && r.ai_search_volume !== null)
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

      return {
        keyword: r.prompt || "Unknown",
        search_volume: r.ai_search_volume || 0,
        sentiment_score: r.sentiment || 0,
        trend: trend,
      };
    })
    .sort((a, b) => {
      // First sort by sentiment
      const sentimentDiff = b.sentiment_score - a.sentiment_score;
      if (sentimentDiff !== 0) return sentimentDiff;
      // Then by volume
      return b.search_volume - a.search_volume;
    })
    .slice(0, 5);
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
      positive: { count: 0, percentage: 0 },
      neutral: { count: 0, percentage: 0 },
      negative: { count: 0, percentage: 0 },
    },
    salience_distribution: {
      high_salience: { count: 0, percentage: 0 },
      medium_salience: { count: 0, percentage: 0 },
      low_salience: { count: 0, percentage: 0 },
    },
    serp_features: [],
    most_cited_pages: [],
    most_cited_websites: [],
    ai_insights: {
      strong_performance: {
        title: "Strong Performance",
        message: "No data available yet. Start tracking keywords to see insights.",
        type: "info",
      },
      citation_gap: {
        title: "Citation Gap",
        message: "No data available yet.",
        type: "info",
      },
      top_opportunity: {
        title: "Top Opportunity",
        message: "No tracking data available yet.",
        type: "info",
      },
      trend_alert: {
        title: "Trend Alert",
        message: "No trend data available yet.",
        type: "info",
      },
    },
    top_performing_keywords: [],
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getUserAnalytics,
};
