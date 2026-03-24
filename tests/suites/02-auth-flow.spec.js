// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker, getExtensionId, openSidePanel } = require('../helpers/extension');
const { injectAuth, clearAuth } = require('../helpers/auth');

test.describe('Auth Flow', () => {

  test('fresh extension shows auth view', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);

    // Auth view should be visible (not hidden)
    await expect(page.locator('#auth-view')).toBeVisible();
    // Main view should be hidden
    await expect(page.locator('#main-view')).toBeHidden();

    await page.close();
  });

  test('login with email/password stores token and shows main view', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);

    // Fill login form
    await page.locator('#auth-email').fill('test@enhancivity.com');
    await page.locator('#auth-password').fill('testpassword123');
    await page.locator('#auth-submit').click();

    // Wait for main view to appear (login success triggers view switch)
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#auth-view')).toBeHidden();

    // Verify token was stored
    const token = await page.evaluate(async () => {
      const result = await chrome.storage.local.get(['token']);
      return result.token;
    });
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    await page.close();
  });

  test('injected auth token shows main view on load', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);

    // Open a helper page first to inject auth
    const helperPage = await context.newPage();
    await helperPage.goto(`chrome-extension://${id}/sidepanel.html`);
    await helperPage.waitForSelector('#auth-view, #main-view', { timeout: 10_000 });
    await injectAuth(helperPage);
    await helperPage.close();

    // Now open a fresh side panel — should auto-detect the stored token
    const page = await openSidePanel(context, id);

    // Give it time to check auth and switch views
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });

    await page.close();
  });

  test('sign out clears token and shows auth view', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const id = getExtensionId(sw);
    const page = await openSidePanel(context, id);

    // Inject auth so we're logged in
    await injectAuth(page);
    await page.reload();
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });

    // Click sign out
    await page.locator('#sign-out-btn').click();

    // Should show auth view
    await expect(page.locator('#auth-view')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#main-view')).toBeHidden();

    // Verify token was cleared
    const token = await page.evaluate(async () => {
      const result = await chrome.storage.local.get(['token']);
      return result.token;
    });
    expect(token).toBeFalsy();

    await page.close();
  });
});
