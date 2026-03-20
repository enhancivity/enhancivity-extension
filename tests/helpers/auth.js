'use strict';

const jwt = require('jsonwebtoken');

const TEST_SECRET = 'enhancivity-test-secret-key-2026';
const TEST_USER_ID = 'test-user-001';
const TEST_EMAIL = 'test@enhancivity.com';

function generateTestToken(userId = TEST_USER_ID) {
  return jwt.sign(
    { id: userId, email: TEST_EMAIL, role: 'user' },
    TEST_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Inject auth token into extension storage so sidepanel.js treats user as logged in.
 * Must be called on a page that has extension context (e.g., the side panel page).
 */
async function injectAuth(page, token) {
  token = token || generateTestToken();
  await page.evaluate(async (t) => {
    await chrome.storage.local.set({ token: t, user: JSON.stringify({ id: 'test-user-001', email: 'test@enhancivity.com', name: 'Test User' }) });
  }, token);
  return token;
}

/**
 * Clear auth from extension storage.
 */
async function clearAuth(page) {
  await page.evaluate(async () => {
    await chrome.storage.local.remove(['token', 'user']);
  });
}

module.exports = {
  TEST_SECRET,
  TEST_USER_ID,
  TEST_EMAIL,
  generateTestToken,
  injectAuth,
  clearAuth,
};
