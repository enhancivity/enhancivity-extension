// @ts-check
/**
 * Test: SPA Stale SID Guard
 *
 * Verifies that when a single-page app re-renders between the moment the AI
 * decides which element to click and the moment the click executes, the agent
 * discards the stale decision and retakes a fresh snapshot instead of clicking
 * the wrong element.
 *
 * Real-world scenario reproduced here:
 *   Phase A DOM: butt-0 = "DELETE ALL DATA", butt-1 = "View Details"
 *   AI decides: click_element(butt-0)
 *   SPA navigation fires → Phase B DOM: butt-0 = "View Details", butt-1 = "Confirm"
 *   Without fix: agent clicks Phase-B butt-0 = "View Details" (wrong element)
 *   With fix:    agent discards stale decision, retakes snapshot, recovers cleanly
 */

const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

const MOCK_BASE = 'http://localhost:3099';
const HARNESS_URL = `${MOCK_BASE}/harness/spa-stale.html`;

// ── Helpers ──────────────────────────────────────────────────

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

// ── Test ─────────────────────────────────────────────────────

test.describe('SPA Stale SID Guard', () => {
  test('discards stale AI decision after SPA re-render and retakes snapshot', async ({ context }) => {
    test.setTimeout(90_000);

    // 1. Open harness page — Phase A DOM loads
    const page = context.pages()[0] || await context.newPage();
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    // Verify Phase A is showing the danger button
    await expect(page.locator('#danger-btn')).toBeVisible();
    await expect(page.locator('#danger-btn')).toHaveText('DELETE ALL DATA');

    // 2. Reset mock server and activate spa-stale scenario
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'spa-stale' }),
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

    // 4. Start exploration — startAction is scrape_page (agent is already on the harness page)
    //    The harness page polls /test/spa-stale-ready every 50ms.
    //    When explore-step is called, mock server sets spaStaleReady=true.
    //    Harness page immediately does pushState → SPA nav detected → sidsStale=true.
    //    300ms later mock server responds with "click butt-0" (Phase A SID for DELETE ALL DATA).
    //    SPA staleness guard fires → discards decision → loops back for fresh snapshot.
    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Click the primary action button on this page.',
          strategy: 'Find the most prominent button and click it.',
          maxSteps: 5,
          creditBudget: 5,
          startAction: {
            type: 'scrape_page',
            description: 'Read the current page to identify interactive elements',
          },
        },
        userPrompt: 'Click the primary action button on this page.',
      },
    });

    expect(startResult?.success, 'explore_start must succeed').toBe(true);

    // 5. Wait for exploration to complete
    const result = await waitForExploreResult(sw, page, 60_000);
    expect(result, 'Exploration should complete within 60s').toBeTruthy();

    // 6. Core assertion: "DELETE ALL DATA" was never clicked
    //    This proves the stale decision (click butt-0 = Phase A) was discarded.
    const clickLog = await page.evaluate(() => window.__clickLog || []);
    expect(
      clickLog,
      `Agent must NOT click "DELETE ALL DATA" — stale SID guard should have discarded that decision. Clicks: ${clickLog.join(', ')}`
    ).not.toContain('DELETE ALL DATA');

    // 7. Guard fired: stepLog must contain a spa_stale_guard entry
    const stepLog = result.stepLog || [];
    const staleSidGuardEntry = stepLog.find(entry => entry?.action?.type === 'spa_stale_guard');
    expect(
      staleSidGuardEntry,
      'stepLog must contain a spa_stale_guard entry — guard must have fired when sidsStale=true'
    ).toBeTruthy();
    expect(staleSidGuardEntry.result.failureReason).toBe('SPA_STALE');

    // 8. Agent recovered: exploration must eventually succeed
    expect(
      result.success,
      'Exploration must succeed after recovery — agent re-snapshotted and completed the goal'
    ).toBe(true);

    await page.close();
  });
});
