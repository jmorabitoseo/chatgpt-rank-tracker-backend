class EnhancedAnalyzer {
  constructor() {
    this.startTime = performance.now();
    this.features = {
      chat_gpt_text: { detected: false, count: 0, weight: 15 },
      chat_gpt_table: { detected: false, count: 0, weight: 20 },
      chat_gpt_navigation_list: { detected: false, count: 0, weight: 18 },
      chat_gpt_images: { detected: false, count: 0, weight: 12 },
      chat_gpt_local_businesses: { detected: false, count: 0, weight: 16 },
      chat_gpt_products: { detected: false, count: 0, weight: 25 }
    };
  }

  // Calculate Linked Citation Potential (LCP) score (0-100) based on client specification
  calculateLCPScore(responseData, provider) {
    try {
      let lcp = 0;
      let distinctDomains = new Set();
      let sources = [];
      let itemTypes = [];
      let bonusDetails = [];

      if (provider === 'brightdata') {
        // Extract domains from links_attached
        if (responseData.links_attached?.length > 0) {
          responseData.links_attached.forEach(link => {
            if (link.url) {
              try {
                const domain = new URL(link.url).hostname;
                distinctDomains.add(domain);
              } catch (e) {
                // Invalid URL, skip
              }
            }
          });
        }

        // Extract domains from citations
        if (responseData.citations?.length > 0) {
          responseData.citations.forEach(citation => {
            if (citation.url) {
              try {
                const domain = new URL(citation.url).hostname;
                distinctDomains.add(domain);
                sources.push({
                  url: citation.url,
                  title: citation.title,
                  cited: citation.cited
                });
              } catch (e) {
                // Invalid URL, skip
              }
            }
          });
        }

        // Detect item types from content structure
        itemTypes = this.detectItemTypesFromBrightData(responseData);

      } else if (provider === 'dataforseo') {
        const result = responseData.tasks?.[0]?.result?.[0];
        if (result) {
          // Extract domains from sources
          if (result.sources?.length > 0) {
            result.sources.forEach(source => {
              if (source.url) {
                try {
                  const domain = new URL(source.url).hostname;
                  distinctDomains.add(domain);
                  sources.push({
                    url: source.url,
                    title: source.title,
                    date_published: source.date_published
                  });
                } catch (e) {
                  // Invalid URL, skip
                }
              }
            });
          }

          // Extract domains from search results
          if (result.search_results?.length > 0) {
            result.search_results.forEach(item => {
              if (item.url) {
                try {
                  const domain = new URL(item.url).hostname;
                  distinctDomains.add(domain);
                } catch (e) {
                  // Invalid URL, skip
                }
              }
            });
          }

          // Get item types directly from DataForSEO
          itemTypes = result.item_types || [];
          if (result.items) {
            result.items.forEach(item => {
              if (item.type && !itemTypes.includes(item.type)) {
                itemTypes.push(item.type);
              }
            });
          }
        }
      }

      // Base Score from Distinct Domains (8 points each, max 8 domains)
      const domainCount = Math.min(distinctDomains.size, 8);
      lcp = domainCount * 8;
      if (domainCount > 0) {
        bonusDetails.push(`${domainCount} distinct domains (${domainCount * 8} points)`);
      }

      // Freshness Bonus (+10 if any source is within 90 days)
      const fresh = this.hasFreshContent(sources, 90);
      if (fresh) {
        lcp += 10;
        bonusDetails.push('Fresh content bonus (+10)');
      }

      // Multiple Item Types Bonus (+10 if 2+ distinct types)
      const uniqueItemTypes = new Set(itemTypes).size;
      if (uniqueItemTypes >= 2) {
        lcp += 10;
        bonusDetails.push(`Multiple content types bonus (+10, ${uniqueItemTypes} types)`);
      }

      // Navigation List Bonus (+6 if navigation list present)
      if (itemTypes.includes('chat_gpt_navigation_list')) {
        lcp += 6;
        bonusDetails.push('Navigation list bonus (+6)');
      }

      // Clamp between 0 and 100
      lcp = Math.max(0, Math.min(100, lcp));

      // Calculate score distribution
      const distribution = {
        domainScore: domainCount * 8,
        freshnessBonus: fresh ? 10 : 0,
        multipleTypesBonus: uniqueItemTypes >= 2 ? 10 : 0,
        navigationBonus: itemTypes.includes('chat_gpt_navigation_list') ? 6 : 0,
        total: lcp
      };
      
      return {
        score: lcp,
        distribution: distribution,
        distinctDomains: distinctDomains.size,
        itemTypes: itemTypes,
        sources: sources.length,
        bonusBreakdown: bonusDetails.join(', ') || 'No bonuses applied',
        rating: this.getLCPRating(lcp)
      };
    } catch (error) {
      return {
        score: 0,
        distinctDomains: 0,
        itemTypes: [],
        sources: 0,
        bonusBreakdown: 'Error analyzing LCP',
        rating: { rating: 'Error', color: '⚠️' },
        error: error.message
      };
    }
  }

  getLCPRating(score) {
    if (score >= 75) return { rating: 'Excellent Citation Potential', color: '🟢' };
    if (score >= 50) return { rating: 'Good Citation Potential', color: '🟡' };
    if (score >= 25) return { rating: 'Limited Citation Potential', color: '�' };
    return { rating: 'Poor Citation Potential', color: '🔴' };
  }

  // Calculate Actionability Score (0-100) based on client specification
  calculateActionabilityScore(responseData, provider) {
    try {
      let actionability = 0;
      let itemTypes = [];
      let sources = [];
      let bonusDetails = [];

      if (provider === 'brightdata') {
        // Detect item types from content structure
        itemTypes = this.detectItemTypesFromBrightData(responseData);

        // Get sources for freshness analysis
        if (responseData.citations?.length > 0) {
          responseData.citations.forEach(citation => {
            if (citation.url) {
              sources.push({
                url: citation.url,
                title: citation.title,
                cited: citation.cited
              });
            }
          });
        }

      } else if (provider === 'dataforseo') {
        const result = responseData.tasks?.[0]?.result?.[0];
        if (result) {
          // Get item types directly from DataForSEO
          itemTypes = result.item_types || [];
          if (result.items) {
            result.items.forEach(item => {
              if (item.type && !itemTypes.includes(item.type)) {
                itemTypes.push(item.type);
              }
            });
          }

          // Get sources for freshness analysis
          if (result.sources?.length > 0) {
            result.sources.forEach(source => {
              sources.push({
                url: source.url,
                title: source.title,
                date_published: source.date_published
              });
            });
          }
        }
      }

      // Table Presence Bonus (+30)
      if (itemTypes.includes('chat_gpt_table')) {
        actionability += 30;
        bonusDetails.push('Table presence (+30)');
      }

      // Product Presence Bonus (+20)
      if (itemTypes.includes('chat_gpt_products')) {
        actionability += 20;
        bonusDetails.push('Products presence (+20)');
      }

      // Local Business Presence Bonus (+20)
      if (itemTypes.includes('chat_gpt_local_businesses')) {
        actionability += 20;
        bonusDetails.push('Local businesses presence (+20)');
      }

      // Image Presence Bonus (+10)
      if (itemTypes.includes('chat_gpt_images')) {
        actionability += 10;
        bonusDetails.push('Images presence (+10)');
      }

      // Navigation List Presence Bonus (+10)
      if (itemTypes.includes('chat_gpt_navigation_list')) {
        actionability += 10;
        bonusDetails.push('Navigation list presence (+10)');
      }

      // Staleness Bonus (+10 if freshest source is older than 365 days)
      const stale = this.isContentStale(sources, 365);
      if (stale) {
        actionability += 10;
        bonusDetails.push('Stale content opportunity (+10)');
      }

      console.log('========== ACTIONABILITY: =========', actionability, itemTypes);
      // Clamp between 0 and 100
      actionability = Math.max(0, Math.min(100, actionability));

      // Calculate score distribution
      const distribution = {
       tableBonus: itemTypes.includes('chat_gpt_table') ? 30 : 0,
       productBonus: itemTypes.includes('chat_gpt_products') ? 20 : 0,
       localBusinessBonus: itemTypes.includes('chat_gpt_local_businesses') ? 20 : 0,
       imageBonus: itemTypes.includes('chat_gpt_images') ? 10 : 0,
       navigationBonus: itemTypes.includes('chat_gpt_navigation_list') ? 10 : 0,
       stalenessBonus: stale ? 10 : 0,
       total: actionability
      };
      return {
        score: actionability,
        distribution: distribution,
        itemTypes: itemTypes,
        sources: sources.length,
        bonusBreakdown: bonusDetails.join(', ') || 'No bonuses applied',
        rating: this.getActionabilityRating(actionability)
      };
    } catch (error) {
      return {
        score: 0,
        itemTypes: [],
        sources: 0,
        bonusBreakdown: 'Error analyzing actionability',
        rating: { rating: 'Error', color: '⚠️' },
        error: error.message
      };
    }
  }

  // Helper: Check if content has fresh sources within specified days
  hasFreshContent(sources, daysThreshold) {
    if (!sources || sources.length === 0) return false;
    
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - daysThreshold);
    
    return sources.some(source => {
      if (source.date_published) {
        const publishDate = new Date(source.date_published);
        return publishDate > threshold;
      }
      return false; // No date means not fresh
    });
  }

  // Helper: Check if content is stale (all sources older than specified days)
  isContentStale(sources, daysThreshold) {
    if (!sources || sources.length === 0) return false;
    
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - daysThreshold);
    
    // Find the freshest source
    let freshestDate = null;
    sources.forEach(source => {
      if (source.date_published) {
        const publishDate = new Date(source.date_published);
        if (!freshestDate || publishDate > freshestDate) {
          freshestDate = publishDate;
        }
      }
    });
    
    // If we found a freshest date and it's older than threshold, it's stale
    return freshestDate && freshestDate < threshold;
  }

  // Helper: Detect item types from BrightData response structure
  detectItemTypesFromBrightData(responseData) {
    const itemTypes = [];
    
    // Always has text if there's an answer
    if (responseData.answer_text_markdown?.length > 0) {
      itemTypes.push('chat_gpt_text');
    }

    // Check for products/shopping
    if (responseData.shopping_visible && responseData.shopping?.length > 0) {
      itemTypes.push('chat_gpt_products');
    }

    // Check for images in markdown
    const imageMatches = responseData.answer_text_markdown?.match(/!\[.*?\]\(.*?\)/g) || [];
    if (imageMatches.length > 0) {
      itemTypes.push('chat_gpt_images');
    }

    // Check for tables (look for markdown table syntax)
    const tableMatches = responseData.answer_text_markdown?.match(/\|.*\|/g) || [];
    if (tableMatches.length > 2) { // At least header + separator + data row
      itemTypes.push('chat_gpt_table');
    }

    // Check for navigation lists (multiple structured links)
    if (responseData.links_attached?.length > 3) {
      itemTypes.push('chat_gpt_navigation_list');
    }

    // Check for local businesses (if map is present)
    if (responseData.is_map) {
      itemTypes.push('chat_gpt_local_businesses');
    }

    return itemTypes;
  }

  getActionabilityRating(score) {
    if (score >= 80) return { rating: 'Highly Actionable', color: '🟢' };
    if (score >= 60) return { rating: 'Moderately Actionable', color: '🟡' };
    if (score >= 40) return { rating: 'Somewhat Actionable', color: '🟠' };
    return { rating: 'Low Actionability', color: '🔴' };
  }

  // Calculate Intent Classification (informational, transactional, navigational)
  calculateIntentClassification(responseData, provider) {
    try {
      let scores = {
        informational: 0,
        commercial: 0,
        transactional: 0,
        local: 0,
        navigational: 0
      };

      let itemTypes = [];
      let content = '';
      let sources = [];

      if (provider === 'brightdata') {
        itemTypes = this.detectItemTypesFromBrightData(responseData);
        content = responseData.answer_text_markdown || '';
        if (responseData.citations?.length > 0) {
          responseData.citations.forEach(citation => {
            sources.push({
              url: citation.url,
              title: citation.title
            });
          });
        }
      } else if (provider === 'dataforseo') {
        const result = responseData.tasks?.[0]?.result?.[0];
        if (result) {
          itemTypes = result.item_types || [];
          content = result.text || '';
          if (result.sources?.length > 0) {
            result.sources.forEach(source => {
              sources.push({
                url: source.url,
                title: source.title
              });
            });
          }
        }
      }

      // Commercial signals (product-focused, comparison, reviews)
      if (itemTypes.includes('chat_gpt_products')) {
        scores.commercial += 45;
      }
      if (itemTypes.includes('chat_gpt_table') && this.hasCommercialTableContent(content)) {
        scores.commercial += 25;
      }

      // Check for commercial keywords in content
      const commercialKeywords = [
        'compare', 'review', 'rating', 'best', 'top', 'price', 'cost', 'features',
        'vs', 'versus', 'pros', 'cons', 'recommendation', 'brand', 'model'
      ];
      const commercialMatches = this.countKeywordMatches(content, commercialKeywords);
      scores.commercial += Math.min(commercialMatches * 3, 25);

      // Local signals (location-based, business listings)
      if (itemTypes.includes('chat_gpt_local_businesses')) {
        scores.local += 50;
      }

      // Check for local keywords in content
      const localKeywords = [
        'near me', 'nearby', 'local', 'address', 'location', 'directions', 'hours',
        'map', 'restaurant', 'store', 'business', 'service area', 'city', 'town'
      ];
      const localMatches = this.countKeywordMatches(content, localKeywords);
      scores.local += Math.min(localMatches * 4, 30);

      // Transactional signals (direct purchase intent)
      if (itemTypes.includes('chat_gpt_products') && this.hasTransactionalContent(content)) {
        scores.transactional += 35;
      }
      if (itemTypes.includes('chat_gpt_local_businesses') && this.hasBookingContent(content)) {
        scores.transactional += 30;
      }

      // Check for transactional keywords in content
      const transactionalKeywords = [
        'buy', 'purchase', 'order', 'booking', 'reservation', 'hire', 'contact',
        'call', 'quote', 'estimate', 'appointment', 'schedule', 'book now'
      ];
      const transactionalMatches = this.countKeywordMatches(content, transactionalKeywords);
      scores.transactional += Math.min(transactionalMatches * 3, 25);

      // Navigational signals
      if (itemTypes.includes('chat_gpt_navigation_list')) {
        scores.navigational += 35;
      }
      if (sources.length > 5) {
        scores.navigational += 20;
      }

      // Check for navigational keywords
      const navigationalKeywords = [
        'website', 'homepage', 'official site', 'main page', 'portal', 'directory',
        'login', 'sign in', 'dashboard', 'menu', 'navigation', 'sitemap'
      ];
      const navigationalMatches = this.countKeywordMatches(content, navigationalKeywords);
      scores.navigational += Math.min(navigationalMatches * 4, 25);

      // Informational signals (default baseline)
      scores.informational += 20; // Base score for having content

      if (itemTypes.includes('chat_gpt_text')) {
        scores.informational += 25;
      }
      if (itemTypes.includes('chat_gpt_images')) {
        scores.informational += 15;
      }
      if (itemTypes.includes('chat_gpt_table') && !this.hasCommercialTableContent(content)) {
        scores.informational += 20;
      }

      // Check for informational keywords
      const informationalKeywords = [
        'what', 'why', 'how', 'when', 'where', 'definition', 'meaning', 'explain',
        'guide', 'tutorial', 'learn', 'understand', 'compare', 'difference', 'overview'
      ];
      const informationalMatches = this.countKeywordMatches(content, informationalKeywords);
      scores.informational += Math.min(informationalMatches * 2, 20);

      // Determine primary intent (highest score)
      const maxScore = Math.max(
        scores.informational, 
        scores.commercial, 
        scores.transactional, 
        scores.local, 
        scores.navigational
      );
      let primaryIntent = 'informational'; // default

      if (scores.commercial === maxScore) {
        primaryIntent = 'commercial';
      } else if (scores.transactional === maxScore) {
        primaryIntent = 'transactional';
      } else if (scores.local === maxScore) {
        primaryIntent = 'local';
      } else if (scores.navigational === maxScore) {
        primaryIntent = 'navigational';
      }

      // Calculate confidence (difference between top two scores)
      const sortedScores = Object.values(scores).sort((a, b) => b - a);
      const confidence = sortedScores[0] > 0 ? 
        Math.min(((sortedScores[0] - sortedScores[1]) / sortedScores[0]) * 100, 100) : 0;

      return {
        primaryIntent,
        confidence: Math.round(confidence),
        scores: scores,
        itemTypes: itemTypes,
        reasoning: this.generateIntentReasoning(scores, itemTypes, primaryIntent)
      };
    } catch (error) {
      return {
        primaryIntent: 'informational',
        confidence: 0,
        scores: { informational: 0, commercial: 0, transactional: 0, local: 0, navigational: 0 },
        itemTypes: [],
        reasoning: 'Error analyzing intent',
        error: error.message
      };
    }
  }

  // Helper: Check if table content is commercial
  hasCommercialTableContent(content) {
    const commercialIndicators = ['price', 'cost', '$', 'buy', 'purchase', 'rating', 'review', 'compare'];
    return commercialIndicators.some(indicator => content.toLowerCase().includes(indicator));
  }

  // Helper: Check if content has transactional intent
  hasTransactionalContent(content) {
    const transactionalIndicators = ['buy now', 'add to cart', 'purchase', 'order now', 'shop now', 'checkout'];
    return transactionalIndicators.some(indicator => content.toLowerCase().includes(indicator));
  }

  // Helper: Check if content has booking/appointment intent
  hasBookingContent(content) {
    const bookingIndicators = ['book now', 'schedule', 'appointment', 'reservation', 'book appointment', 'call now'];
    return bookingIndicators.some(indicator => content.toLowerCase().includes(indicator));
  }

  // Helper: Count keyword matches in content
  countKeywordMatches(content, keywords) {
    if (!content) return 0;
    const lowerContent = content.toLowerCase();
    return keywords.filter(keyword => lowerContent.includes(keyword.toLowerCase())).length;
  }

  // Helper: Generate intent reasoning
  generateIntentReasoning(scores, itemTypes, primaryIntent) {
    const reasons = [];

    if (primaryIntent === 'commercial') {
      if (itemTypes.includes('chat_gpt_products')) reasons.push('Product listings present');
      if (scores.commercial > 40) reasons.push('Strong commercial/comparison signals');
    } else if (primaryIntent === 'local') {
      if (itemTypes.includes('chat_gpt_local_businesses')) reasons.push('Local business listings');
      if (scores.local > 30) reasons.push('Strong local search signals');
    } else if (primaryIntent === 'transactional') {
      if (scores.transactional > 30) reasons.push('Direct purchase/booking intent');
    } else if (primaryIntent === 'navigational') {
      if (itemTypes.includes('chat_gpt_navigation_list')) reasons.push('Navigation list structure');
      if (scores.navigational > 40) reasons.push('Multiple navigation signals');
    } else {
      if (itemTypes.includes('chat_gpt_text')) reasons.push('Primarily text-based content');
      if (scores.informational > 40) reasons.push('Educational/explanatory content');
    }

    return reasons.join(', ') || `Classified as ${primaryIntent} based on content analysis`;
  }

  // Helper: Identify commerce domains
  isCommerceDomain(url) {
    const commerceDomains = [
      'amazon.', 'walmart.', 'target.', 'ebay.', 'etsy.', 'shopify.',
      'stripe.', 'paypal.', 'shop.', 'store.', 'buy.', 'cart.',
      'checkout.', 'order.', 'payment.', 'commerce.'
    ];
    return commerceDomains.some(domain => url.includes(domain));
  }

  // Helper: Identify business/service domains
  isBusinessDomain(url) {
    const businessDomains = [
      'yelp.', 'yellowpages.', 'foursquare.', 'tripadvisor.',
      'opentable.', 'booking.', 'hotels.', 'airbnb.',
      'groupon.', 'thumbtack.', 'angi.', 'homeadvisor.'
    ];
    return businessDomains.some(domain => url.includes(domain));
  }

  // Helper: Check for business intent in link text
  hasBusinessIntent(text) {
    const businessKeywords = [
      'contact', 'call', 'phone', 'book', 'schedule', 'appointment',
      'reserve', 'hire', 'service', 'quote', 'estimate', 'consultation'
    ];
    return businessKeywords.some(keyword => text.includes(keyword));
  }

  // Helper: Identify actionable informational content
  isActionableInfo(url, text) {
    const actionableIndicators = [
      'how-to', 'tutorial', 'guide', 'download', 'signup', 'register',
      'apply', 'form', 'tool', 'calculator', 'template', 'resource'
    ];
    const combined = (url + ' ' + text).toLowerCase();
    return actionableIndicators.some(indicator => combined.includes(indicator));
  }

  // Enhanced text analysis for actionability
  analyzeTextActionability(text) {
    let score = 0;
    let actions = [];
    let transactional = 0;
    let local = 0;

    // High-value transactional phrases (weighted by intent strength)
    const transactionalPatterns = [
      { regex: /\b(buy now|purchase|add to cart|order now|shop now)\b/gi, weight: 20, label: 'direct purchase' },
      { regex: /\$\d+(?:\.\d{2})?(?:\s*-\s*\$\d+(?:\.\d{2})?)?/g, weight: 15, label: 'pricing' },
      { regex: /\b(free shipping|discount|sale|offer|deal|coupon|promo)\b/gi, weight: 12, label: 'offers' },
      { regex: /\b(buy|purchase|shop|order)\b/gi, weight: 10, label: 'shopping intent' }
    ];

    transactionalPatterns.forEach(pattern => {
      const matches = text.match(pattern.regex) || [];
      if (matches.length > 0) {
        const patternScore = Math.min(matches.length * pattern.weight, pattern.weight * 3);
        score += patternScore;
        transactional += patternScore;
        actions.push(`${matches.length} ${pattern.label} terms`);
      }
    });

    // Local/business intent patterns
    const localPatterns = [
      { regex: /\b(near me|nearby|local|address|phone|hours|directions)\b/gi, weight: 15, label: 'local search' },
      { regex: /\b(visit|location|store|restaurant|business|service)\b/gi, weight: 8, label: 'business visit' },
      { regex: /\b(book|schedule|appointment|reservation|call)\b/gi, weight: 12, label: 'booking intent' }
    ];

    localPatterns.forEach(pattern => {
      const matches = text.match(pattern.regex) || [];
      if (matches.length > 0) {
        const patternScore = Math.min(matches.length * pattern.weight, pattern.weight * 2);
        score += patternScore;
        local += patternScore;
        actions.push(`${matches.length} ${pattern.label} terms`);
      }
    });

    // CTA and engagement patterns
    const ctaPatterns = [
      { regex: /\b(learn more|get started|try now|sign up|subscribe|download|apply)\b/gi, weight: 8, label: 'engagement CTA' },
      { regex: /\b(contact|email|call|message|reach out)\b/gi, weight: 10, label: 'contact CTA' }
    ];

    ctaPatterns.forEach(pattern => {
      const matches = text.match(pattern.regex) || [];
      if (matches.length > 0) {
        const patternScore = Math.min(matches.length * pattern.weight, pattern.weight * 2);
        score += patternScore;
        actions.push(`${matches.length} ${pattern.label} terms`);
      }
    });

    return {
      score,
      actions,
      transactional,
      local
    };
  }

  // Enhanced feature detection
  detectSERPFeatures(responseData, provider) {
    // Reset features
    Object.keys(this.features).forEach(key => {
      this.features[key].detected = false;
      this.features[key].count = 0;
    });

    try {
      if (provider === 'brightdata') {
        this.detectBrightDataFeatures(responseData);
      } else if (provider === 'dataforseo') {
        this.detectDataForSEOFeatures(responseData);
      }

      return this.features;
    } catch (error) {
      console.error('Feature detection error:', error);
      return this.features;
    }
  }

  detectBrightDataFeatures(data) {
    // Map BrightData features to ChatGPT categories
    
    // Text content
    if (data.answer_text_markdown?.length > 0) {
      this.features.chat_gpt_text.detected = true;
      this.features.chat_gpt_text.count = 1;
    }

    // Products/Shopping
    if (data.shopping_visible && data.shopping?.length > 0) {
      this.features.chat_gpt_products.detected = true;
      this.features.chat_gpt_products.count = data.shopping.length;
    }

    // Images
    const imageMatches = data.answer_text_markdown?.match(/!\[.*?\]\(.*?\)/g) || [];
    if (imageMatches.length > 0) {
      this.features.chat_gpt_images.detected = true;
      this.features.chat_gpt_images.count = imageMatches.length;
    }

    // Tables (look for markdown table syntax)
    const tableMatches = data.answer_text_markdown?.match(/\|.*\|/g) || [];
    if (tableMatches.length > 2) { // At least header + separator + data row
      this.features.chat_gpt_table.detected = true;
      this.features.chat_gpt_table.count = 1;
    }

    // Navigation lists (structured lists with links)
    const linkMatches = data.links_attached || [];
    if (linkMatches.length > 3) {
      this.features.chat_gpt_navigation_list.detected = true;
      this.features.chat_gpt_navigation_list.count = 1;
    }

    // Local businesses (if map is present, assume local context)
    if (data.is_map) {
      this.features.chat_gpt_local_businesses.detected = true;
      this.features.chat_gpt_local_businesses.count = 1;
    }
  }

  detectDataForSEOFeatures(data) {
    const result = data.tasks?.[0]?.result?.[0];
    if (!result) return;

    // Use the item_types array if available (most accurate)
    if (result.item_types && Array.isArray(result.item_types)) {
      result.item_types.forEach(type => {
        if (this.features[type]) {
          this.features[type].detected = true;
          this.features[type].count = 1; // Will be updated below with actual counts
        }
      });
    }

    // Count actual items by type
    if (result.items && Array.isArray(result.items)) {
      const typeCounts = {};
      
      result.items.forEach(item => {
        const type = item.type;
        if (this.features[type]) {
          typeCounts[type] = (typeCounts[type] || 0) + 1;
          
          // For products and local businesses, count nested items
          if (type === 'chat_gpt_products' && item.items) {
            this.features[type].count = item.items.length;
          } else if (type === 'chat_gpt_local_businesses' && item.items) {
            this.features[type].count = item.items.length;
          } else if (type === 'chat_gpt_images' && item.items) {
            this.features[type].count = item.items.length;
          } else {
            this.features[type].count = typeCounts[type];
          }
          this.features[type].detected = true;
        }
      });
    }

    // Additional counts from other sources
    if (result.search_results?.length > 0) {
      // Search results don't have their own type in ChatGPT, but indicate text content
      if (!this.features.chat_gpt_text.detected) {
        this.features.chat_gpt_text.detected = true;
        this.features.chat_gpt_text.count = 1;
      }
    }

    if (result.sources?.length > 0) {
      // Sources typically indicate navigation lists
      if (!this.features.chat_gpt_navigation_list.detected) {
        this.features.chat_gpt_navigation_list.detected = true;
        this.features.chat_gpt_navigation_list.count = 1;
      }
    }
  }

  generateFeatureDisplay() {
    const detected = Object.entries(this.features)
      .filter(([_, feature]) => feature.detected)
      .map(([name, feature]) => `${name.replace('chat_gpt_', '')} (${feature.count})`)
      .join(' | ');

    return detected || 'No special features detected';
  }

  // Main analysis method
  analyzeResponse(responseData, provider = 'auto') {
    try {
      // Auto-detect provider
      if (provider === 'auto') {
        provider = responseData.tasks ? 'dataforseo' : 'brightdata';
      }

      const lcp = this.calculateLCPScore(responseData, provider); // Linked Citation Potential
      const actionability = this.calculateActionabilityScore(responseData, provider);
      const features = this.detectSERPFeatures(responseData, provider);
      const featureDisplay = this.generateFeatureDisplay();
      const intentClassification = this.calculateIntentClassification(responseData, provider);

      return {
        provider,
        timestamp: new Date().toISOString(),
        metrics: {
          lcp: {
            ...lcp,
            // Backward compatibility fields
            totalLinks: lcp.distinctDomains,
            citationLinks: lcp.sources,
            markdownLinks: 0,
            linkBreakdown: lcp.bonusBreakdown,
            description: 'Linked Citation Potential - measures domain diversity and content freshness'
          },
          actionability: {
            ...actionability,
            // Backward compatibility
            breakdown: actionability.bonusBreakdown
          },
          intentClassification: intentClassification,
          features: {
            detected: features,
            display: featureDisplay,
            count: Object.values(features).filter(f => f.detected).length
          }
        },
        summary: {
          lcp: lcp.score,
          actionability: actionability.score,
          intentClassification: intentClassification.primaryIntent,
          serp: Object.entries(features)
            .filter(([_, feature]) => feature.detected)
            .reduce((acc, [name, feature]) => {
              acc[name] = feature.count;
              return acc;
            }, {})
        }
      };
    } catch (error) {
      return {
        error: error.message,
        provider: provider || 'unknown',
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = { EnhancedAnalyzer };