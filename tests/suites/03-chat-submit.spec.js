// @ts-check
const { test, expect } = require('@playwright/test');
const { getServiceWorker, getExtensionId, openSidePanel } = require('../helpers/extension');
const { injectAuth } = require('../helpers/auth');

test.describe('Chat Submit', () => {
  let page;
  let extensionId;

  test.beforeEach(async ({ context }) => {
    const sw = await getServiceWorker(context);
    extensionId = getExtensionId(sw);
    page = await openSidePanel(context, extensionId);
    await injectAuth(page);
    await page.reload();
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10_000 });
  });

  test.afterEach(async () => {
    if (page && !page.isClosed()) await page.close();
  });

  test('submit button is disabled when input is empty', async () => {
    const submitBtn = page.locator('#submit-btn');
    await expect(submitBtn).toBeDisabled();
  });

  test('submit button enables when text is entered', async () => {
    await page.locator('#prompt-input').fill('test prompt');
    const submitBtn = page.locator('#submit-btn');
    // Give the input event listener time to fire
    await page.waitForTimeout(200);
    await expect(submitBtn).toBeEnabled();
  });

  test('submitting a prompt shows loading state', async () => {
    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();

    // Loading bar should appear
    await expect(page.locator('#loading-bar')).toBeVisible({ timeout: 5000 });
  });

  test('RECOMMENDATION response renders in chat', async () => {
    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();

    // Wait for a response to appear in the results area
    await expect(page.locator('#results-area')).toBeVisible({ timeout: 15_000 });

    // The mock server returns a RECOMMENDATION with headline "Here's what I found"
    const resultsText = await page.locator('#results-area').textContent();
    expect(resultsText).toBeTruthy();
  });

  test('input is cleared after submission', async () => {
    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();

    // Wait for response
    await expect(page.locator('#results-area')).toBeVisible({ timeout: 15_000 });

    // Input should be empty after submission
    const inputValue = await page.locator('#prompt-input').inputValue();
    expect(inputValue).toBe('');
  });

  test('new chat button clears conversation', async () => {
    // Submit a prompt first
    await page.locator('#prompt-input').fill('recommend something');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#results-area')).toBeVisible({ timeout: 15_000 });

    // Click New Chat
    await page.locator('#new-chat-btn').click();

    // Greeting should reappear
    await expect(page.locator('#chat-greeting')).toBeVisible({ timeout: 5000 });
  });
});
