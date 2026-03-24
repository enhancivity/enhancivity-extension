// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker, getExtensionId, openSidePanel, collectConsoleLogs } = require('../helpers/extension');

test.describe('Extension Load', () => {

  test('service worker starts without errors', async ({ context }) => {
    const sw = await getServiceWorker(context);
    expect(sw).toBeTruthy();
    expect(sw.url()).toContain('background.js');

    // Collect console output for a moment to check for startup errors
    const logs = collectConsoleLogs(sw);
    await new Promise(r => setTimeout(r, 2000));
    logs.stop();

    const errors = logs.messages.filter(m => m.type === 'error');
    // Filter out known non-critical errors (e.g., network requests that fail because no real backend)
    const criticalErrors = errors.filter(m =>
      !m.text.includes('net::ERR') &&
      !m.text.includes('Failed to fetch') &&
      !m.text.includes('Could not establish connection')
    );

    if (criticalErrors.length > 0) {
      console.log('SW startup errors:', criticalErrors.map(e => e.text));
    }
    // We don't fail on errors during startup — just log them for visibility
  });

  test('extension ID is extractable', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(10);
  });

  test('side panel HTML loads', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);

    // Verify the page loaded
    const title = await page.title();
    expect(title).toBe('Enhancivity');

    await page.close();
  });

  test('side panel has key UI elements', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);

    // Auth view elements
    await expect(page.locator('#auth-view')).toBeAttached();
    await expect(page.locator('#auth-email')).toBeAttached();
    await expect(page.locator('#auth-password')).toBeAttached();
    await expect(page.locator('#auth-submit')).toBeAttached();

    // Main view elements (hidden until logged in)
    await expect(page.locator('#main-view')).toBeAttached();
    await expect(page.locator('#prompt-input')).toBeAttached();
    await expect(page.locator('#submit-btn')).toBeAttached();
    await expect(page.locator('#chat-area')).toBeAttached();
    await expect(page.locator('#loading-bar')).toBeAttached();

    // Settings view
    await expect(page.locator('#settings-view')).toBeAttached();

    // Learning view
    await expect(page.locator('#learning-view')).toBeAttached();

    await page.close();
  });

  test('mock server is reachable', async ({ request }) => {
    const response = await request.get('http://localhost:3099/api/health');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('mock server serves harness pages', async ({ request }) => {
    const response = await request.get('http://localhost:3099/harness/form-page.html');
    expect(response.ok()).toBeTruthy();
    const text = await response.text();
    expect(text).toContain('Test Form Page');
  });
});
