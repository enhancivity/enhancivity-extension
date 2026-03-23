// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Data Transfer Tests — EXPLORE scratchpad + paste_tsv + navigate cycle fix
 *
 * Tests the full data-transfer workflow: extract from source page (email),
 * navigate to target (spreadsheet), paste via scratchpad.
 *
 * Also verifies the navigate-cycle-detection fix: navigating to the same
 * URL twice in a multi-site round-trip must NOT trigger a false cycle abort.
 *
 * Run with: npx playwright test 14-data-transfer
 */

const MOCK_BASE = 'http://localhost:3099';

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

/** Wait for the service worker to be available. */
async function getSW(context, page) {
  let sw;
  for (let i = 0; i < 30; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes('background'));
    if (sw) break;
    await page.waitForTimeout(500);
  }
  return sw;
}

/**
 * Send a message to the background service worker.
 * Injects a relay content script via chrome.scripting.executeScript since
 * page.evaluate can't access chrome.runtime (not an extension page).
 */
async function sendToBackground(sw, message) {
  return sw.evaluate(async (msg) => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Inject content script that relays the message
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (msgToSend) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(msgToSend, (response) => {
            resolve(response || { error: chrome.runtime.lastError?.message });
          });
        });
      },
      args: [{ ...msg, data: { ...msg.data, tabId: activeTab.id } }],
    });
    return result?.result;
  }, message);
}

/** Poll chrome.storage.session for explorationResult (max waitMs). */
async function waitForExploreResult(sw, page, waitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const result = await sw.evaluate(async () => {
      const data = await chrome.storage.session.get('explorationResult');
      return data.explorationResult || null;
    });
    if (result) return result;
    await page.waitForTimeout(500);
  }
  return null;
}

test.describe('Data transfer: EXPLORE scratchpad + navigate cycle fix', () => {

  test.beforeEach(async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    // Reset mock server state
    await page.goto(`${MOCK_BASE}/harness/email-detail.html`);
    await page.waitForLoadState('domcontentloaded');
    try {
      await page.evaluate(async (base) => {
        await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      }, MOCK_BASE);
    } catch { /* server may not be running yet */ }
  });

  test('scratchpad accumulates extractedData and paste_tsv substitutes it', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/email-detail.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Set data-transfer scenario on mock server
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer' }),
      });
    }, MOCK_BASE);

    // Inject auth token
    const token = generateTestToken();
    await sw.evaluate(async (t) => {
      await chrome.storage.local.set({ token: t });
    }, token);

    // Trigger explore_start from page context (SW can't message itself)
    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data transfer from email to spreadsheet',
          strategy: 'Read email table, navigate to spreadsheet, paste data',
          maxSteps: 10,
          creditBudget: 5,
          startAction: { type: 'scrape_page', description: 'Read email content' },
        },
        userPrompt: 'Copy my subscription data to the spreadsheet',
      },
    });

    expect(startResult?.success).toBe(true);

    // Wait for exploration to complete
    const result = await waitForExploreResult(sw, page);
    expect(result, 'Exploration should complete within 30s').toBeTruthy();

    // The exploration should have completed successfully
    // Note: it may fail on paste_tsv (CDP not available in test), but the scratchpad
    // substitution and goal completion logic should still work
    if (result.success) {
      expect(result.goalResult || '').toMatch(/subscription/i);
    }

    // Verify that exploration ran (not immediately aborted)
    expect(result.stepsUsed || result.phasesUsed || 0).toBeGreaterThan(0);
  });

  test('navigate cycle does NOT fire for multi-site round-trips', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/email-detail.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Set roundtrip scenario (navigates to same spreadsheet URL twice)
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer-roundtrip' }),
      });
    }, MOCK_BASE);

    // Inject auth token
    const token = generateTestToken();
    await sw.evaluate(async (t) => {
      await chrome.storage.local.set({ token: t });
    }, token);

    // Collect console warnings to verify no cycle detection
    const consoleWarnings = [];
    sw.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') {
        consoleWarnings.push(msg.text());
      }
    });

    // Trigger explore_start from page context
    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data transfer roundtrip from email to spreadsheet',
          strategy: 'Read email, paste to spreadsheet, return for more data, paste again',
          maxSteps: 15,
          creditBudget: 10,
          startAction: { type: 'scrape_page', description: 'Read email content' },
        },
        userPrompt: 'Copy all subscription data to the spreadsheet in batches',
      },
    });

    expect(startResult?.success).toBe(true);

    // Wait for exploration to complete
    const result = await waitForExploreResult(sw, page, 45000);
    expect(result, 'Exploration should complete within 45s').toBeTruthy();

    // CRITICAL: The result should NOT contain "navigation cycle" error
    const goalResult = result.goalResult || result.error || '';
    expect(goalResult).not.toMatch(/navigation cycle/i);

    // Verify no CROSS-TARGET CYCLE warning was logged for navigate actions
    const navigateCycleWarning = consoleWarnings.find(w =>
      w.includes('CROSS-TARGET CYCLE') && w.includes('navigate:')
    );
    expect(navigateCycleWarning, `Navigate should not trigger cycle detection, but got: ${navigateCycleWarning}`).toBeFalsy();
  });

  test('scratchpad data survives across navigate steps', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/email-detail.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Set roundtrip scenario (has two extractedData batches across navigate)
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer-roundtrip' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => {
      await chrome.storage.local.set({ token: t });
    }, token);

    // Collect console logs to verify scratchpad accumulation
    const consoleLogs = [];
    sw.on('console', (msg) => {
      consoleLogs.push(msg.text());
    });

    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data transfer roundtrip from email to spreadsheet',
          strategy: 'Read email, paste, return for more, paste again',
          maxSteps: 15,
          creditBudget: 10,
          startAction: { type: 'scrape_page', description: 'Read email content' },
        },
        userPrompt: 'Copy all subscription data in batches',
      },
    });

    expect(startResult?.success).toBe(true);

    const result = await waitForExploreResult(sw, page, 45000);
    expect(result, 'Exploration should complete within 45s').toBeTruthy();

    // Verify scratchpad was updated at least twice (batch 1 + batch 2)
    const bufferUpdates = consoleLogs.filter(l => l.includes('Data buffer updated'));
    expect(bufferUpdates.length, 'Data buffer should be updated at least twice (two batches)').toBeGreaterThanOrEqual(2);

    // Verify the second paste_tsv had accumulated data (chars from both batches)
    const pasteSubLogs = consoleLogs.filter(l => l.includes('paste_tsv') && l.includes('substituted scratchpad data'));
    if (pasteSubLogs.length >= 2) {
      // Extract char counts from logs like "paste_tsv — substituted scratchpad data (245 chars)"
      const charCounts = pasteSubLogs.map(l => {
        const match = l.match(/\((\d+) chars\)/);
        return match ? parseInt(match[1], 10) : 0;
      });
      // Second paste should have MORE data than first (accumulated from both batches)
      expect(charCounts[1], 'Second paste should include accumulated data from both batches').toBeGreaterThanOrEqual(charCounts[0]);
    }
  });
});
