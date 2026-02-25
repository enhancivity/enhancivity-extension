// ============================================================
// Enhancivity — Generic Search Results Scraper (Semantic)
//
// Injected on-demand into any search/listing page where no
// site-specific scraper exists (travel sites, Google Shopping, etc.)
//
// Uses heuristics to find product/listing cards:
//   1. Finds price patterns ($xx.xx, €xx, £xx)
//   2. Associates prices with nearby titles (h2/h3/a near price)
//   3. Extracts URLs from parent links
//
// Returns max 8 results to keep payload small for GPT comparison.
// ============================================================

(() => {
  'use strict';

  const MAX_RESULTS = 8;

  // Price patterns: $29.99, €29,99, £29.99, 29.99 USD, etc.
  const PRICE_REGEX = /(?:[\$£€¥₹]|USD|EUR|GBP)\s*[\d,]+\.?\d{0,2}|[\d,]+\.?\d{0,2}\s*(?:USD|EUR|GBP|[\$£€¥₹])/i;

  // Elements likely to be product/listing containers
  const CARD_SELECTORS = [
    '[class*="product"]',
    '[class*="listing"]',
    '[class*="result"]',
    '[class*="item"]',
    '[class*="card"]',
    '[data-testid*="result"]',
    '[data-testid*="listing"]',
    'li[class]',
  ].join(', ');

  // Elements to skip (nav, footer, sidebar, etc.)
  const SKIP_PATTERN = /nav|footer|sidebar|header|cookie|banner|popup|modal|overlay|advert|promo|menu|breadcrumb/i;

  function shouldSkip(el) {
    const cls = el.className;
    const id = el.id;
    if (typeof cls === 'string' && SKIP_PATTERN.test(cls)) return true;
    if (id && SKIP_PATTERN.test(id)) return true;
    return false;
  }

  function findPrice(el) {
    const text = el.innerText || '';
    const match = text.match(PRICE_REGEX);
    return match ? match[0].trim() : null;
  }

  function findTitle(el) {
    // Look for heading or prominent link text near the element
    const heading = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="name"]');
    if (heading) {
      const text = heading.innerText?.trim();
      if (text && text.length > 5 && text.length < 300) return text;
    }

    // Fallback: first link with substantial text
    const links = el.querySelectorAll('a');
    for (const link of links) {
      const text = link.innerText?.trim();
      if (text && text.length > 10 && text.length < 300 && !PRICE_REGEX.test(text)) {
        return text;
      }
    }

    return null;
  }

  function findUrl(el) {
    const link = el.querySelector('a[href]');
    if (!link) return null;
    const href = link.getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:')) return null;
    try {
      return new URL(href, location.origin).href;
    } catch {
      return null;
    }
  }

  function findDescription(el) {
    const descEl = el.querySelector(
      '[class*="description"], [class*="snippet"], [class*="subtitle"], p'
    );
    const text = descEl?.innerText?.trim();
    if (text && text.length > 10 && text.length < 500) return text;
    return null;
  }

  function findRating(el) {
    const ratingEl = el.querySelector(
      '[class*="rating"], [class*="stars"], [aria-label*="star"], [aria-label*="rating"]'
    );
    if (!ratingEl) return null;
    const ariaLabel = ratingEl.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    const text = ratingEl.innerText?.trim();
    if (text && /\d/.test(text)) return text;
    return null;
  }

  function scrapeResults() {
    const candidates = document.querySelectorAll(CARD_SELECTORS);
    const results = [];
    const seenTitles = new Set();

    for (const el of candidates) {
      if (results.length >= MAX_RESULTS) break;
      if (shouldSkip(el)) continue;

      // Must have either a price or a link to be a useful result
      const price = findPrice(el);
      const title = findTitle(el);
      const url = findUrl(el);

      if (!title || !url) continue;

      // Deduplicate by title
      const titleKey = title.toLowerCase().slice(0, 50);
      if (seenTitles.has(titleKey)) continue;
      seenTitles.add(titleKey);

      const description = findDescription(el);
      const rating = findRating(el);

      results.push({
        title,
        price: price || 'Price unavailable',
        url,
        description,
        rating,
        confidence: price ? 'high' : 'medium',
      });
    }

    return results;
  }

  return scrapeResults();
})();
