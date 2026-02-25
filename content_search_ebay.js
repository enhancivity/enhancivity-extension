// ============================================================
// Enhancivity — eBay Search Results Scraper
//
// Injected on-demand into ebay.com/sch/i.html?... search result pages.
// Extracts top listing cards: title, price, shipping, condition, URL.
// Returns max 8 results to keep payload small for GPT comparison.
// ============================================================

(() => {
  'use strict';

  const MAX_RESULTS = 8;

  function scrapeResults() {
    const items = document.querySelectorAll('.s-item');
    const results = [];

    for (const item of items) {
      if (results.length >= MAX_RESULTS) break;

      // Title
      const titleEl = item.querySelector('.s-item__title span, .s-item__title');
      const title = titleEl?.innerText?.trim();
      if (!title || title === 'Shop on eBay' || title.includes('Results matching')) continue;

      // URL
      const linkEl = item.querySelector('.s-item__link');
      const url = linkEl?.getAttribute('href') || '';

      // Price
      const priceEl = item.querySelector('.s-item__price');
      const price = priceEl?.innerText?.trim() || 'Price unavailable';

      // Shipping
      const shippingEl = item.querySelector('.s-item__shipping, .s-item__freeXDays');
      const shipping = shippingEl?.innerText?.trim() || null;

      // Condition
      const conditionEl = item.querySelector('.SECONDARY_INFO');
      const condition = conditionEl?.innerText?.trim() || null;

      // Seller rating / top rated
      const topRated = !!item.querySelector('.s-item__etrs-badge, [aria-label*="Top Rated"]');

      // Image
      const imgEl = item.querySelector('.s-item__image-wrapper img');
      const image = imgEl?.getAttribute('src') || null;

      results.push({
        title,
        price,
        shipping,
        condition,
        url,
        image,
        topRated,
      });
    }

    return results;
  }

  return scrapeResults();
})();
