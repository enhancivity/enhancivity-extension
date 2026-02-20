// ============================================================
// Enhancivity Amazon Content Script
// Lies dormant until the background script sends a message.
// On trigger: extracts product title, price, rating, or search query.
// ============================================================

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type !== 'scrape_amazon') return;

  try {
    // Product detail page
    const productTitleEl = document.querySelector('#productTitle');
    const productTitle = productTitleEl ? productTitleEl.innerText.trim() : '';

    // Price — Amazon uses several containers; try in order of reliability
    const priceEl =
      document.querySelector('.priceToPay .a-offscreen') ||
      document.querySelector('#priceblock_ourprice') ||
      document.querySelector('#priceblock_dealprice') ||
      document.querySelector('.a-price .a-offscreen');
    const price = priceEl ? priceEl.innerText.trim() : '';

    // Star rating
    const ratingEl = document.querySelector('#acrPopover');
    const rating = ratingEl ? ratingEl.getAttribute('title')?.trim() : '';

    // Search results page — get the query from the search box
    const searchEl = document.querySelector('#twotabsearchtextbox');
    const searchQuery = searchEl ? searchEl.value.trim() : '';

    sendResponse({ productTitle, price, rating, searchQuery });
  } catch (e) {
    console.warn('Enhancivity: Amazon scrape failed', e.message);
    sendResponse({ productTitle: '', price: '', rating: '', searchQuery: '' });
  }

  return true;
});
