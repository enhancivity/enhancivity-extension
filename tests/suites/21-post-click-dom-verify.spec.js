// @ts-check
/**
 * Test: Post-Click DOM Verification
 *
 * Verifies that after click_element executes, the agent waits for the page to
 * actually respond (fingerprint changes) before taking the post-action snapshot.
 *
 * Real-world scenario reproduced here:
 *   Click fires → button gains CSS class "loading" (fingerprint IDENTICAL)
 *   waitForDomStable would exit at ~450ms — snapshot captures spinner state
 *   1500ms later: "FINAL CONTENT LOADED" appears (fingerprint CHANGES)
 *   With fix: waitForDomChange polls until fingerprint shifts → snapshot captures real content
 *
 * The core assertion: the mainContent the AI received at step 2 CONTAINS
 * "FINAL CONTENT LOADED" — proving the fix waited for the real loaded state.
 */

const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

const MOCK_BASE = 'http://localhost:3099';
const HARNESS_URL = `${MOCK_BASE}/harness/dom-verify.html`;

// ── Helpers ───────────────────────────────────────────────────

async function sendToBackground(sw, message) {
  return sw.evaluate(async (msg) => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (messageToSend) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(messageToSend, (response) => {
            resolve(response || { error: chrome.runtime.lastError?.message });
          });
        });
      },
      args: [{ ...msg, data: { ...msg.data, tabId: activeTab.id } }],
    });
    return result?.result;
  }, message);
}

async function waitForExploreResult(sw, page, waitMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    const result = await sw.evaluate(async () => {
      const { explorationResult } = await chrome.storage.session.get('explorationResult');
      return explorationResult || null;
    });
    if (result) return result;
    await page.waitForTimeout(500);
  }
  return null;
}

// ── Test ──────────────────────────────────────────────────────

test.describe('Post-Click DOM Verification', () => {
  test('snapshot after click contains loaded content, not spinner state', async ({ context }) => {
    test.setTimeout(90_000);

    // 1. Open harness page
    const page = context.pages()[0] || await context.newPage();
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    // Verify initial state — result div empty, button visible
    await expect(page.locator('#load-btn')).toBeVisible();
    await expect(page.locator('#result')).toHaveText('');

    // 2. Reset mock server and activate dom-verify scenario
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'dom-verify' }),
      });
    }, MOCK_BASE);

    // 3. Get service worker and inject auth token
    const sw = await getServiceWorker(context, 60_000);
    expect(sw, 'Service worker should be running').toBeTruthy();

    const token = generateTestToken();
    await sw.evaluate(async (authToken) => {
      await chrome.storage.local.set({ token: authToken });
      await chrome.storage.session.remove(['explorationResult', 'sessionActionHistory']);
    }, token);

    // 4. Start exploration
    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Click the Load Content button and wait for content to appear.',
          strategy: 'Find the button, click it, then observe the result.',
          maxSteps: 5,
          creditBudget: 5,
          startAction: {
            type: 'scrape_page',
            description: 'Read the current page to identify interactive elements',
          },
        },
        userPrompt: 'Click the Load Content button and wait for content to appear.',
      },
    });

    expect(startResult?.success, 'explore_start must succeed').toBe(true);

    // 5. Wait for exploration to complete
    const result = await waitForExploreResult(sw, page, 60_000);
    expect(result, 'Exploration should complete within 60s').toBeTruthy();

    // 6. Core assertion: the AI's step-2 snapshot CONTAINS "FINAL CONTENT LOADED"
    //    This proves waitForDomChange waited for the 1500ms content load before snapshotting.
    //    Without the fix, the snapshot captures the spinner state (result div still empty).
    const step2Content = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/test/dom-verify-step2-snapshot`);
      const data = await res.json();
      return data.content || '';
    }, MOCK_BASE);

    expect(
      step2Content,
      `Agent's step-2 snapshot must contain "FINAL CONTENT LOADED". Got: "${step2Content.slice(0, 200)}"`
    ).toContain('FINAL CONTENT LOADED');

    // 7. No false hang: exploration completed successfully within the timeout
    //    If waitForDomChange hung on CSS-only changes, the loop would time out here.
    expect(
      result.success,
      'Exploration must succeed — waitForDomChange must not hang on CSS-only clicks'
    ).toBe(true);

    // 8. Regression guard: correct button was clicked exactly once
    const clickLog = await page.evaluate(() => window.__clickLog || []);
    expect(
      clickLog,
      `Agent must click "Load Content" exactly once. Clicks: ${clickLog.join(', ')}`
    ).toEqual(['Load Content']);

    await page.close();
  });
});
