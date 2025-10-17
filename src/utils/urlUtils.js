// Utilities for cleaning URLs/domains and normalizing citations for storage

/**
 * Clean a domain-like string to canonical hostname (e.g., "www.Example.com" -> "example.com").
 */
function cleanDomain(input) {
  try {
    if (!input) return '';
    let domain = String(input).trim();
    // If a full URL is passed, extract hostname first
    if (/^https?:\/\//i.test(domain)) {
      const u = new URL(domain);
      domain = u.hostname || domain;
    }
    return domain.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Extract a domain from a URL string and clean it (no protocol, no www, lowercase).
 */
function extractDomainFromUrl(url) {
  try {
    if (!url) return '';
    const u = new URL(url);
    return cleanDomain(u.hostname);
  } catch {
    // Fallback: strip protocol and path, then clean
    try {
      const withoutProto = String(url).replace(/^https?:\/\//i, '');
      const candidate = withoutProto.split('/')[0];
      return cleanDomain(candidate);
    } catch {
      return '';
    }
  }
}

/**
 * Clean URL while keeping the path; remove protocol, www, and query/hash params.
 * Example: https://www.example.com/path/page?utm=1#hash -> example.com/path/page
 */
function cleanUrlKeepPath(url) {
  try {
    if (!url) return '';
    const u = new URL(url);
    const host = cleanDomain(u.hostname);
    const pathname = u.pathname || '';
    // Ensure no trailing '?' or '#' and exclude search/hash entirely
    return `${host}${pathname}`;
  } catch {
    // Fallback: manual cleanup
    const str = String(url);
    const noProto = str.replace(/^https?:\/\//i, '');
    const noWww = noProto.replace(/^www\./i, '');
    const noParams = noWww.split('?')[0].split('#')[0];
    return noParams;
  }
}

/**
 * Normalize citations for DB storage: title, domain, url
 * - domain defaults to extracted domain from URL if missing
 * - url is cleaned to remove protocol/www and query/hash while keeping path
 */
function formatCitationsForDB(citations) {
  if (!Array.isArray(citations) || citations.length === 0) return [];
  return citations.map((c) => {
    const originalUrl = c?.url || '';
    const cleanedUrl = cleanUrlKeepPath(originalUrl);
    const providedDomain = c?.domain || '';
    const cleanedDomain =  extractDomainFromUrl(originalUrl);
    return {
      title: c?.title || '',
      domain: cleanedDomain,
      url: cleanedUrl,
    };
  });
}

module.exports = {
  cleanDomain,
  extractDomainFromUrl,
  cleanUrlKeepPath,
  formatCitationsForDB,
};


