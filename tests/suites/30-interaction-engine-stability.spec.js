'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERACTION ENGINE — PART 7: PAGE STABILITY ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests for waitForPageStable() — waits for DOM to stop mutating.
 *
 * Run: npx playwright test 30-interaction-engine-stability --retries 0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'interaction-engine.js');
const HARNESS_URL = 'http://localhost:3099/harness/interaction-engine-click.html';

async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  const loaded = await page.evaluate(() => !!window.__enhInteractionEngine);
  if (!loaded) throw new Error('interaction-engine.js failed to inject');
}

test.describe('waitForPageStable()', () => {

  test('resolves stable:true on a quiet page', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('load');
    // Wait a moment for the delayed button reveal (500ms) to finish
    await page.waitForTimeout(700);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { waitForPageStable } = window.__enhInteractionEngine;
      return await waitForPageStable({ timeout: 3000, quietPeriod: 400 });
    });

    expect(result.stable).toBe(true);
  });

  test('resolves stable:true after DOM mutations stop', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('load');
    await page.waitForTimeout(700);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { waitForPageStable } = window.__enhInteractionEngine;

      // Start mutations: add elements every 100ms for 600ms
      let count = 0;
      const mutInterval = setInterval(() => {
        const div = document.createElement('div');
        div.textContent = 'mutation ' + count++;
        document.body.appendChild(div);
        if (count >= 6) clearInterval(mutInterval);
      }, 100);

      // Wait for stability — should resolve after mutations stop (~600ms + quietPeriod)
      return await waitForPageStable({ timeout: 5000, quietPeriod: 400 });
    });

    expect(result.stable).toBe(true);
  });

  test('returns stable:false on timeout when page keeps mutating', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('load');
    await page.waitForTimeout(700);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { waitForPageStable } = window.__enhInteractionEngine;

      // Continuous mutations — never stops
      const mutInterval = setInterval(() => {
        const div = document.createElement('div');
        div.textContent = 'nonstop ' + Date.now();
        document.body.appendChild(div);
      }, 50);

      const stableResult = await waitForPageStable({ timeout: 1000, quietPeriod: 400 });

      clearInterval(mutInterval);
      return stableResult;
    });

    expect(result.stable).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  test('returns structured result with waitedMs', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('load');
    await page.waitForTimeout(700);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { waitForPageStable } = window.__enhInteractionEngine;
      return await waitForPageStable({ timeout: 3000, quietPeriod: 300 });
    });

    expect(result.stable).toBe(true);
    expect(typeof result.waitedMs).toBe('number');
  });
});
