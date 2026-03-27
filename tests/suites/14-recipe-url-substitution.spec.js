// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

/**
 * Regression tests for two recipe auto-replay bugs:
 *
 * Bug 1 — Navigate URL not parameterized:
 *   When a recipe is recorded with e.g. "tshirt" as the search query, the navigate
 *   step URL has "?k=tshirt" baked in. On replay with __search_query="summer shoes",
 *   the navigate step must use the new value, not the recorded one.
 *
 * Bug 2 — Low-score recipe auto-replays:
 *   Any recipe returned by the backend fires automatically, even at score=27/100.
 *   Recipes below score=50 should fall through to AI without touching the page.
 *
 * Protocol:
 *   1. Run BEFORE applying fixes → both tests must FAIL (proves bugs exist)
 *   2. Apply fixes to content_replay.js and background.js
 *   3. Run AFTER fixes → both tests must PASS (proves fixes work)
 *   4. Run full suite → no regressions
 */

test.describe('Bug 1: navigate URL is parameterized with current __search_query', () => {

  test('recipe replays with substituted search query in navigate URL, not recorded value', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    // Open the harness page — this is the tab the recipe will replay on.
    // The recipe has a navigate step hardcoded to ?k=tshirt (the OLD recorded URL).
    // After fix, the navigate URL uses __search_query = "summer shoes" → ?k=summer+shoes.
    const searchPage = await context.newPage();
    await searchPage.goto('http://localhost:3099/harness/search-results.html');
    await searchPage.waitForLoadState('domcontentloaded');
    await searchPage.bringToFront(); // Ensure this is the active tab Chrome sees

    // Direct injection approach (mirrors 04-recipe-replay.spec.js pattern).
    // This tests content_replay.js's executeNavigate() directly — no background.js tab-query
    // reliability concerns. The navigate step will kill the content script on execution, so
    // we fire-and-forget the sendMessage and watch the page URL change instead.
    await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { success: false, error: 'No active tab found' };

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content_replay.js'],
        });
      } catch (e) {
        return { success: false, error: 'Injection failed: ' + e.message };
      }

      await new Promise(r => setTimeout(r, 300));

      // Fire-and-forget: navigate step reloads the page, so the response never returns.
      chrome.tabs.sendMessage(tab.id, {
        type: 'replay_recipe',
        recipe: {
          id: 'url-sub-test-001',
          workflowName: 'URL substitution test recipe',
          siteDomain: 'localhost',
          steps: [
            {
              stepNumber: 1,
              action: {
                type: 'navigate',
                url: 'http://localhost:3099/harness/search-results.html?k=tshirt',
                description: 'Navigate to search results (HARDCODED from recording)',
              },
            },
          ],
        },
        variables: { __search_query: 'summer shoes' },
      }).catch(() => {});

      return { success: true };
    }, { token });

    // Wait for the page to navigate to a URL that contains "summer".
    //
    // BEFORE FIX: executeNavigate ignores variables → uses ?k=tshirt → URL never has "summer"
    //             → waitForURL times out → test FAILS  ✓ (proves bug)
    //
    // AFTER FIX:  executeNavigate substitutes __search_query → ?k=summer+shoes → "summer" present
    //             → waitForURL resolves → test PASSES ✓ (proves fix)
    await searchPage.waitForURL(/summer/i, { timeout: 15000 });

    const finalUrl = searchPage.url();
    expect(finalUrl, 'navigate URL must NOT contain the old recorded value "tshirt"').not.toContain('tshirt');
    expect(finalUrl.toLowerCase(), 'navigate URL must contain the current search query "summer"').toContain('summer');

    await searchPage.close();
  });

});

test.describe('Bug 2: recipe below score threshold falls through to AI without navigating', () => {

  test('recipe with score=27 does not execute and page stays on original URL', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    // Open form-page as the starting point (NOT search-results).
    // The mock recipe (keyword: "low-score-test") has score=27 and a navigate step
    // pointing to search-results.html.
    //
    // BEFORE FIX: recipe fires → page navigates to search-results.html
    // AFTER FIX:  score gate blocks it → page stays on form-page.html
    const testPage = await context.newPage();
    await testPage.goto('http://localhost:3099/harness/form-page.html');
    await testPage.waitForLoadState('domcontentloaded');
    await testPage.bringToFront(); // Make this the active tab so chrome.tabs.query finds it

    // Trigger process_request with the low-score recipe keyword.
    // The full round-trip completes (with or without recipe execution)
    // before sw.evaluate resolves, so the URL check after is accurate.
    await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });
      chrome.runtime.sendMessage({
        type: 'process_request',
        data: {
          userPrompt: 'low-score-test do something',
          url: 'http://localhost:3099/harness/form-page.html',
          availableTabs: [{
            id: 1,
            url: 'http://localhost:3099/harness/form-page.html',
            title: 'Form Page',
            domain: 'localhost',
          }],
        },
      }).catch(() => {});
    }, { token });

    // Allow time for the recipe to execute (if it fires) or for the AI fallback.
    // 4 seconds is enough for a navigate step + content script injection + response,
    // while keeping the test fast when the recipe is correctly skipped.
    await testPage.waitForTimeout(4000);

    // BEFORE FIX: page is now at search-results.html → assertion fails  ✓ (proves bug)
    // AFTER FIX:  page is still at form-page.html   → assertion passes  ✓ (proves fix)
    const currentUrl = testPage.url();
    expect(currentUrl, 'page must stay on form-page — low-score recipe must not navigate away').toContain('form-page.html');
    expect(currentUrl, 'page must NOT have navigated to search-results').not.toContain('search-results');

    await testPage.close();
  });

});
