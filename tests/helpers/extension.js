'use strict';

/**
 * Wait for the extension's service worker to be active.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {number} timeoutMs
 * @returns {Promise<import('@playwright/test').Worker>}
 */
async function getServiceWorker(context, timeoutMs = 30_000) {
  // Check if already available
  const existing = context.serviceWorkers().find(w => w.url().includes('background.js'));
  if (existing) return existing;

  // Wait for it to appear
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service worker did not appear within ' + timeoutMs + 'ms')), timeoutMs);

    const check = (worker) => {
      if (worker.url().includes('background.js')) {
        clearTimeout(timer);
        context.off('serviceworker', check);
        resolve(worker);
      }
    };

    context.on('serviceworker', check);

    // Also poll existing (race condition: might have appeared between check and listener)
    const found = context.serviceWorkers().find(w => w.url().includes('background.js'));
    if (found) {
      clearTimeout(timer);
      context.off('serviceworker', check);
      resolve(found);
    }
  });
}

/**
 * Extract the extension ID from the service worker URL.
 * URL format: chrome-extension://<id>/background.js
 */
function getExtensionId(worker) {
  const url = worker.url();
  const match = url.match(/chrome-extension:\/\/([a-z]+)\//i);
  if (!match) throw new Error('Could not extract extension ID from: ' + url);
  return match[1];
}

/**
 * Open the side panel as a regular tab.
 * Playwright can't interact with the real side panel API, but sidepanel.js
 * works identically when loaded as a tab (all chrome.runtime.sendMessage calls still work).
 */
async function openSidePanel(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // Wait for the page to initialize (sidepanel.js runs on load)
  await page.waitForSelector('#auth-view, #main-view', { timeout: 10_000 });
  return page;
}

/**
 * Collect console messages from a service worker.
 * Returns an object with a messages array and a stop function.
 */
function collectConsoleLogs(worker) {
  const messages = [];
  const handler = (msg) => {
    messages.push({
      type: msg.type(),
      text: msg.text(),
    });
  };
  worker.on('console', handler);
  return {
    messages,
    stop: () => worker.off('console', handler),
  };
}

module.exports = {
  getServiceWorker,
  getExtensionId,
  openSidePanel,
  collectConsoleLogs,
};
