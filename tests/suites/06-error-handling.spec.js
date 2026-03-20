// @ts-check
const { test, expect } = require('@playwright/test');
const { getServiceWorker, getExtensionId, openSidePanel } = require('../helpers/extension');
const { injectAuth } = require('../helpers/auth');

test.describe('Error Handling', () => {

  test.afterEach(async () => {
    // Reset mock server error mode after each test
    try {
      await fetch('http://localhost:3099/test/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      // Ignore if mock server is down
    }
  });

  test('server 500 shows error in UI', async ({ context }) => {
    // Set mock server to return 500
    await fetch('http://localhost:3099/test/set-error-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: '500' }),
    });

    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);
    await injectAuth(page);
    await page.reload();
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });

    // Submit a prompt
    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();

    // Should show an error state (error message, not a successful response)
    // Wait for either error message or results
    await page.waitForTimeout(5000);

    // Check for error indicators
    const mainError = page.locator('#main-error');
    const chatArea = page.locator('#chat-area');
    const chatText = await chatArea.textContent();

    // The UI should indicate something went wrong
    const hasErrorIndicator =
      (await mainError.isVisible() && (await mainError.textContent())?.length > 0) ||
      chatText?.toLowerCase().includes('error') ||
      chatText?.toLowerCase().includes('failed') ||
      chatText?.toLowerCase().includes('try again') ||
      chatText?.toLowerCase().includes('something went wrong');

    expect(hasErrorIndicator).toBeTruthy();

    await page.close();
  });

  test('server 401 prompts re-authentication', async ({ context }) => {
    await fetch('http://localhost:3099/test/set-error-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: '401' }),
    });

    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);
    await injectAuth(page);
    await page.reload();
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });

    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();

    // On 401, the extension should either:
    // 1. Show auth view (forced re-login)
    // 2. Show an error about authentication
    await page.waitForTimeout(5000);

    const authVisible = await page.locator('#auth-view').isVisible();
    const chatText = await page.locator('#chat-area').textContent();
    const hasAuthError =
      authVisible ||
      chatText?.toLowerCase().includes('auth') ||
      chatText?.toLowerCase().includes('sign in') ||
      chatText?.toLowerCase().includes('token') ||
      chatText?.toLowerCase().includes('unauthorized');

    expect(hasAuthError).toBeTruthy();

    await page.close();
  });

  test('network error shows appropriate message', async ({ context }) => {
    // Set timeout mode — server never responds
    await fetch('http://localhost:3099/test/set-error-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'timeout' }),
    });

    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);
    await injectAuth(page);
    await page.reload();
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });

    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();

    // Wait for the timeout to trigger (the extension has a 20s timeout)
    // We check after 25s to allow for the timeout + error rendering
    await page.waitForTimeout(25_000);

    const chatText = await page.locator('#chat-area').textContent();
    const hasTimeoutError =
      chatText?.toLowerCase().includes('timeout') ||
      chatText?.toLowerCase().includes('error') ||
      chatText?.toLowerCase().includes('try again') ||
      chatText?.toLowerCase().includes('network') ||
      chatText?.toLowerCase().includes('could not');

    expect(hasTimeoutError).toBeTruthy();

    await page.close();
  });
});
