# LCP & Actionability Scoring Guide

## Overview

Our system analyzes ChatGPT responses and calculates two key metrics to help you understand content opportunities:

- **LCP (Linked Citation Potential)**: How likely your content is to get links and citations from other websites
- **Actionability Score**: How likely users are to take action after seeing the content

Both scores range from **0-100**, with higher scores indicating better opportunities.

---

## 🔗 LCP (Linked Citation Potential) - Score: 0-100

**What it measures**: The likelihood that other websites will link to or cite similar content you create.

### How We Calculate LCP

#### 1. **Domain Diversity (Main Factor)**
- **8 points per unique domain** referenced in the response
- **Maximum**: 8 domains = 64 points
- **Why it matters**: Content that references diverse, authoritative sources is more likely to be cited by others

**Example:**
- Response cites 3 different websites → 3 × 8 = 24 points
- Response cites 6 different websites → 6 × 8 = 48 points
- Response cites 10+ different websites → Capped at 8 × 8 = 64 points

#### 2. **Fresh Content Bonus (+10 points)**
- Awarded when **any source** is published within the last **90 days**
- **Logic**: Fresh, current information is more likely to be referenced and linked to

#### 3. **Content Variety Bonus (+10 points)**
- Awarded when response contains **2 or more content types**
- Content types include: text, tables, images, products, local businesses, navigation lists
- **Logic**: Diverse content formats attract more citations

#### 4. **Navigation List Bonus (+6 points)**
- Awarded when response includes structured lists with multiple links
- **Logic**: List-style content is highly shareable and linkable

### LCP Score Interpretation

| Score Range | Rating | What It Means |
|-------------|--------|---------------|
| **75-100** | 🟢 Excellent Citation Potential | High-authority content with diverse sources and fresh information |
| **50-74** | 🟡 Good Citation Potential | Solid content with good source diversity |
| **25-49** | 🟠 Limited Citation Potential | Some citation potential but limited source diversity |
| **0-24** | 🔴 Poor Citation Potential | Low likelihood of earning citations |

### Real Example
```
Response about "Best Project Management Tools 2024":
- References 6 different software company websites → 48 points
- Includes recent reviews from last month → +10 points (fresh)
- Contains comparison table + product images → +10 points (variety)
- Has structured list of tools → +6 points (navigation)
Total LCP: 74/100 (Good Citation Potential)
```

---

## ⚡ Actionability Score - Score: 0-100

**What it measures**: How likely users are to take specific actions after viewing the content.

### How We Calculate Actionability

#### 1. **Comparison Tables (+30 points)**
- **Highest bonus** because tables help users make decisions
- Examples: Price comparisons, feature matrices, pros/cons lists
- **Logic**: Users can immediately compare options and choose

#### 2. **Product Listings (+20 points)**
- When response shows specific products with details
- **Logic**: Product information directly leads to purchase decisions

#### 3. **Local Business Information (+20 points)**
- When response includes local businesses, addresses, contact info
- **Logic**: Users can immediately visit, call, or contact businesses

#### 4. **Visual Content (+10 points)**
- When response includes images, charts, or visual elements
- **Logic**: Visual content increases engagement and action-taking

#### 5. **Navigation Lists (+10 points)**
- When response provides structured lists of links or options
- **Logic**: Clear navigation guides users to take next steps

#### 6. **Content Opportunity Bonus (+10 points)**
- **Unique feature**: Awarded when all sources are older than 1 year
- **Logic**: Outdated information creates opportunity for fresh, actionable content

### Actionability Score Interpretation

| Score Range | Rating | What It Means |
|-------------|--------|---------------|
| **80-100** | 🟢 Highly Actionable | Users very likely to take immediate action |
| **60-79** | 🟡 Moderately Actionable | Good potential for user engagement and action |
| **40-59** | 🟠 Somewhat Actionable | Some action potential but limited triggers |
| **0-39** | 🔴 Low Actionability | Primarily informational, low action potential |

### Real Example
```
Response about "Best Restaurants Near Me":
- Shows comparison table of ratings/prices → +30 points
- Lists specific restaurants with details → +20 points
- Includes restaurant photos → +10 points
- Provides structured list of options → +10 points
- All reviews are from 2+ years ago → +10 points (opportunity)
Total Actionability: 80/100 (Highly Actionable)
```

---

## 🎯 How to Use These Scores

### **High LCP + High Actionability (75+ each)**
- **Golden Opportunity**: Create comprehensive, well-sourced content
- **Strategy**: Focus on getting citations while driving user actions
- **Content Type**: Ultimate guides, comparison resources, tool directories

### **High LCP + Low Actionability (LCP 75+, Action <40)**
- **Citation Magnet**: Great for building domain authority
- **Strategy**: Create authoritative, reference-worthy content
- **Content Type**: Research studies, data compilations, industry reports

### **Low LCP + High Actionability (LCP <40, Action 75+)**
- **Conversion Focus**: Great for driving immediate actions
- **Strategy**: Create action-oriented, conversion-focused content
- **Content Type**: Product reviews, local guides, how-to tutorials

### **Low LCP + Low Actionability (Both <40)**
- **Content Gap**: Opportunity to create better content
- **Strategy**: Add more sources, make content more actionable
- **Content Type**: Enhanced versions of existing basic content

---

## 📊 Score Factors Summary

### LCP Factors (Max 100 points)
- **Domain Diversity**: Up to 64 points (8 points × 8 domains max)
- **Fresh Content**: +10 points (sources within 90 days)
- **Content Variety**: +10 points (2+ content types)
- **Navigation Lists**: +6 points (structured link lists)
- **Remaining**: +10 points (buffer for edge cases)

### Actionability Factors (Max 100 points)
- **Comparison Tables**: +30 points (decision-making content)
- **Product Listings**: +20 points (purchase-ready information)
- **Local Businesses**: +20 points (visit/contact information)
- **Visual Content**: +10 points (engagement boosters)
- **Navigation Lists**: +10 points (action guidance)
- **Content Opportunity**: +10 points (outdated source opportunity)

---

## 🔍 Understanding Your Results

When you see your scores, consider:

1. **Score Trends**: Are your target keywords consistently scoring high or low?
2. **Competitive Gaps**: Where competitors score low, you can score high
3. **Content Strategy**: Use scores to decide what type of content to create
4. **Resource Allocation**: Focus efforts on high-potential opportunities

Remember: These scores help identify content opportunities, but success also depends on content quality, user experience, and execution.
