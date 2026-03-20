// @ts-check
const { test, expect } = require('@playwright/test');
const { getServiceWorker, getExtensionId, openSidePanel } = require('../helpers/extension');
const { injectAuth } = require('../helpers/auth');

test.describe('Orchestration Filters', () => {
  test('keeps desktop intent, removes laptop drift, and enforces budget on mock products', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const extensionId = getExtensionId(sw);
    const page = await openSidePanel(context, extensionId);

    await injectAuth(page);
    await page.reload();
    await expect(page.locator('#main-view')).toBeVisible({ timeout: 10000 });

    await page.locator('#prompt-input').fill('please search me a desktop in amazon under 800 euro and pick one for me');
    await page.locator('#submit-btn').click();

    await expect(page.locator('#results-area')).toContainText('Budget Desktop Tower', { timeout: 30000 });
    await expect(page.locator('#results-area')).toContainText('€699,00');

    const resultsText = await page.locator('#results-area').textContent();
    expect(resultsText).toContain('Budget Desktop Tower');
    expect(resultsText).not.toContain('Laptop');
    expect(resultsText).not.toContain('€1.299,00');
    expect(resultsText).not.toContain('€1.499,00');

    await page.close();
  });
});
