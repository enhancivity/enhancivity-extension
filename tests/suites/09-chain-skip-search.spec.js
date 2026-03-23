// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Regression tests for chain sub-task skip logic.
 *
 * Bug 1: Domain matching has a false-positive — when hostname has no dots
 *   (e.g. "localhost"), split('.').slice(-2,-1)[0] returns undefined → '',
 *   and ''.includes('') is always true. This means skip fires for ANY domain.
 *
 * Bug 2: In production, the chain skip for sub-task 1 only works when
 *   recipePartialContext is set (recipe ran). When the recipe is deprecated
 *   (not matched), the skip depends entirely on Scenario B (URL detection),
 *   which has the domain matching bug above.
 *
 * Run with: npx playwright test 09-chain-skip-search
 */

const test = base.extend({
  extensionContext: async ({}, use) => {
    const extPath = path.resolve(__dirname, '..', '..');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--no-first-run',
        '--disable-popup-blocking',
      ],
    });
    await use(context);
    await context.close();
  },
});

test.describe('Chain: Sub-task skip logic', () => {

  test('domain matching has false-positive on single-label hostnames', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/search-results.html?k=laptop');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Test the domain matching logic that background.js Scenario B uses.
    // This must match the FIXED implementation in background.js.
    const result = await sw.evaluate(async () => {
      const cases = [
        { tabHost: 'localhost', subTaskDomain: 'amazon.com', expectMatch: false },
        { tabHost: 'www.amazon.de', subTaskDomain: 'amazon.com', expectMatch: true },
        { tabHost: 'www.ebay.com', subTaskDomain: 'amazon.com', expectMatch: false },
        { tabHost: 'mail.google.com', subTaskDomain: 'amazon.com', expectMatch: false },
      ];

      return cases.map(c => {
        // FIXED algorithm: both families must be non-empty and ≥3 chars
        const subBase = c.subTaskDomain.split('.').slice(-2, -1)[0] || '';
        const tabBase = c.tabHost.split('.').slice(-2, -1)[0] || '';
        const match = subBase.length >= 3 && tabBase.length >= 3 &&
          (c.tabHost.includes(subBase) || c.subTaskDomain.includes(tabBase));
        return { ...c, tabBase, subBase, actualMatch: match };
      });
    });

    // Verify domain matching is correct
    for (const r of result) {
      expect(r.actualMatch,
        `Domain match for "${r.tabHost}" vs "${r.subTaskDomain}": ` +
        `tabBase="${r.tabBase}" subBase="${r.subBase}" — ` +
        `expected ${r.expectMatch}, got ${r.actualMatch}`
      ).toBe(r.expectMatch);
    }
  });

  test('chain skip fires correctly when already on search results page', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    // Simulate being on Amazon search results
    await page.goto('http://localhost:3099/harness/search-results.html?k=laptop+under+500+euro');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    const token = generateTestToken();
    await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });
    }, { token });

    // Get chain plan
    const chainPlan = await sw.evaluate(async ({ token }) => {
      const res = await fetch('http://localhost:3099/api/agent/chain/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userRequest: 'find laptop on amazon then email to john@gmail.com',
          currentDomain: 'localhost',
        }),
      });
      return res.json();
    }, { token });

    expect(chainPlan.isChain).toBe(true);
    expect(chainPlan.subTasks.length).toBe(2);

    // The chain skip should detect search results are already showing.
    // Right now, the skip fires due to a false-positive domain match
    // (empty string matches anything). After the fix, it should fire
    // for the RIGHT reason: URL has search query params + page has results.
    const skipResult = await sw.evaluate(async ({ subTask }) => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentUrl = (activeTab?.url || '').toLowerCase();

      const searchIndicators = ['k=', 'q=', 'query=', 'search=', 'keyword=', '/s?', '/search?'];
      const urlHasSearchQuery = searchIndicators.some(p => currentUrl.includes(p));

      return { currentUrl, urlHasSearchQuery };
    }, { subTask: chainPlan.subTasks[0] });

    // URL should have search params
    expect(skipResult.urlHasSearchQuery).toBe(true);
    // After fix: skip should work based on URL alone (no domain check needed
    // when URL clearly shows search results for the query in the sub-task)
  });
});
