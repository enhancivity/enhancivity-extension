const { test, expect } = require('@playwright/test');

test('smoke: Chromium opens and mock server responds', async ({ page }) => {
  const response = await page.goto('http://localhost:3099/harness/form-page.html');
  expect(response).not.toBeNull();
  expect(response.status()).toBe(200);
});
