// ============================================================
// Enhancivity — Etsy Search Results Scraper
//
// Injected on-demand into etsy.com/search?q=... search result pages.
// Extracts top listing cards: title, price, rating, shop name, URL.
// Returns max 8 results to keep payload small for GPT comparison.
// ============================================================

(() => {
  'use strict';

  const MAX_RESULTS = 8;

  function scrapeResults() {
    // Etsy uses data-listing-id on listing cards
    const items = document.querySelectorAll('[data-listing-id], .v2-listing-card');
    const results = [];

    for (const item of items) {
      if (results.length >= MAX_RESULTS) break;

      // Skip ads
      const adLabel = item.querySelector('[data-ad-label], .wt-text-caption.ad-label');
      if (adLabel) continue;

      // Title — try multiple selectors (Etsy changes markup frequently)
      const titleEl = item.querySelector(
        '.v2-listing-card__info h3, ' +
        '.wt-text-caption a[href*="/listing/"], ' +
        'h3.wt-text-caption, ' +
        'a[href*="/listing/"] .wt-text-caption'
      );
      const title = titleEl?.innerText?.trim();
      if (!title) continue;

      // URL
      const linkEl = item.querySelector('a[href*="/listing/"]');
      const href = linkEl?.getAttribute('href');
      const url = href ? new URL(href, location.origin).href : '';

      // Price
      const priceEl = item.querySelector(
        '.currency-value, ' +
        '.wt-text-title-01 .currency-value, ' +
        'span.currency-value, ' +
        '.lc-price .wt-text-title-01'
      );
      let price = priceEl?.innerText?.trim() || null;

      // Try to get the currency symbol
      if (price) {
        const symbolEl = item.querySelector('.currency-symbol');
        const symbol = symbolEl?.innerText?.trim() || '$';
        price = `${symbol}${price}`;
      } else {
        // Fallback: grab any price-like text
        const priceContainer = item.querySelector('.lc-price, .n-listing-card__price');
        price = priceContainer?.innerText?.trim()?.split('\n')[0] || 'Price unavailable';
      }

      // Rating
      const ratingEl = item.querySelector(
        '.wt-screen-reader-only, ' +
        'input[name="rating"]'
      );
      let rating = null;
      if (ratingEl) {
        const text = ratingEl.innerText || ratingEl.getAttribute('value') || '';
        const match = text.match(/([\d.]+)\s*out\s*of\s*5/i) || text.match(/([\d.]+)/);
        if (match) rating = `${match[1]} out of 5`;
      }

      // Review count
      const reviewEl = item.querySelector('.wt-text-gray .wt-text-caption, span[aria-hidden="true"]');
      const reviewText = reviewEl?.innerText?.trim() || '';
      const reviewMatch = reviewText.match(/\(?([\d,]+)\)?/);
      const reviewCount = reviewMatch ? reviewMatch[1] : null;

      // Shop name
      const shopEl = item.querySelector('.wt-text-gray.wt-text-caption, .shop-name');
      const shopName = shopEl?.innerText?.trim() || null;

      // Image
      const imgEl = item.querySelector('img');
      const image = imgEl?.getAttribute('src') || null;

      results.push({
        title,
        price,
        rating,
        reviewCount,
        url,
        image,
        shopName,
      });
    }

    return results;
  }

  return scrapeResults();
})();
