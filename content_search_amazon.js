// ============================================================
// Enhancivity — Amazon Search Results Scraper
//
// Injected on-demand into amazon.com/s?k=... search result pages.
// Extracts top product cards: title, price, rating, review count, URL.
// Returns max 8 results to keep payload small for GPT comparison.
// ============================================================

(() => {
  'use strict';

  const MAX_RESULTS = 8;

  function parsePrice(el) {
    if (!el) return null;
    const text = el.innerText || el.textContent || '';
    const match = text.match(/[\$£€]?\s*[\d,]+\.?\d*/);
    return match ? match[0].trim() : null;
  }

  function scrapeResults() {
    const items = document.querySelectorAll('[data-component-type="s-search-result"]');
    const results = [];

    for (const item of items) {
      if (results.length >= MAX_RESULTS) break;

      // Skip sponsored/ad results
      const adLabel = item.querySelector('.puis-label-popover-default, [data-component-type="sp-sponsored-result"]');
      if (adLabel) continue;

      // Title
      const titleEl = item.querySelector('h2 a span, h2 span');
      const title = titleEl?.innerText?.trim();
      if (!title) continue;

      // URL
      const linkEl = item.querySelector('h2 a');
      const href = linkEl?.getAttribute('href');
      const url = href ? new URL(href, location.origin).href : '';

      // Price
      const priceWhole = item.querySelector('.a-price .a-price-whole');
      const priceFraction = item.querySelector('.a-price .a-price-fraction');
      let price = null;
      if (priceWhole) {
        const whole = priceWhole.innerText.replace(/[,.\s]/g, '');
        const frac = priceFraction?.innerText?.trim() || '00';
        const symbol = item.querySelector('.a-price-symbol')?.innerText || '$';
        price = `${symbol}${whole}.${frac}`;
      }
      if (!price) {
        price = parsePrice(item.querySelector('.a-price .a-offscreen'));
      }

      // Rating
      const ratingEl = item.querySelector('.a-icon-alt');
      const rating = ratingEl?.innerText?.trim() || null;

      // Review count
      const reviewEl = item.querySelector('[aria-label*="stars"] + span, .a-size-base.s-underline-text');
      const reviewCount = reviewEl?.innerText?.trim()?.replace(/[()]/g, '') || null;

      // Prime badge
      const isPrime = !!item.querySelector('.s-prime, [aria-label*="Prime"]');

      // Image
      const imgEl = item.querySelector('.s-image');
      const image = imgEl?.getAttribute('src') || null;

      results.push({
        title,
        price: price || 'Price unavailable',
        rating,
        reviewCount,
        url,
        image,
        isPrime,
      });
    }

    return results;
  }

  return scrapeResults();
})();
