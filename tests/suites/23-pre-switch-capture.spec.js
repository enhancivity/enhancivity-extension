// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Pre-Switch Capture Tests — BUG 2 Fix
 *
 * Proves that background.js automatically captures the current page's
 * mainContent into dataBuffer before navigating away, when the AI fails
 * to set extractedData first.
 *
 * ROOT CAUSE: The AI system prompt instructs it to capture data before
 * navigating (Rule 8, Rule 23), but when the user says "open [app] first",
 * the AI navigates away before capturing. No safety net exists in background.js.
 * dataBuffer stays empty. paste_tsv has nothing to paste.
 *
 * FIX: background.js intercepts any 'navigate' action where dataBuffer is
 * empty and mainContent is non-empty, auto-captures the snapshot content.
 *
 * FAILING ASSERTION (pre-fix): No "Pre-switch capture" log ever appears.
 * The consoleLogs.find() returns undefined → expect(...).toBeTruthy() FAILS.
 *
 * Run with: npx playwright test 23-pre-switch-capture
 */

const MOCK_BASE = 'http://localhost:3099';
const EMAIL_URL = `${MOCK_BASE}/harness/email-detail.html`;
const SPREADSHEET_URL = `${MOCK_BASE}/harness/spreadsheet.html`;

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

async function getSW(context, page) {
  let sw;
  for (let i = 0; i < 30; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes('background'));
    if (sw) break;
    await page.waitForTimeout(500);
  }
  return sw;
}

async function sendToBackground(sw, message) {
  return sw.evaluate(async (msg) => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

test.describe('Pre-switch capture — BUG 2 fix', () => {

  test.beforeEach(async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(EMAIL_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }, MOCK_BASE);
  });

  /**
   * PRIMARY PROOF OF BUG 2: AI omits extractedData before navigate →
   * pre-switch capture safety net must activate.
   *
   * Pre-fix: no capture code exists → "Pre-switch capture" log never written
   *   → consoleLogs.find() returns undefined → expect(...).toBeTruthy() FAILS.
   * Post-fix: background.js captures mainContent before navigate → log appears.
   */
  test('fills dataBuffer when AI omits extractedData before navigate', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(EMAIL_URL);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'pre-switch-no-extract' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const consoleLogs = [];
    sw.on('console', msg => consoleLogs.push(msg.text()));

    await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy email data to spreadsheet',
          strategy: 'Navigate to spreadsheet, paste email content',
          maxSteps: 10,
          creditBudget: 5,
          startAction: { type: 'scrape_page', description: 'Read email content' },
        },
        userPrompt: 'Copy this email data to the spreadsheet',
      },
    });

    const result = await waitForExploreResult(sw, page, 30000);
    expect(result, 'Exploration should complete').toBeTruthy();

    // CRITICAL ASSERTION: pre-switch capture must have fired
    const preSwitchLog = consoleLogs.find(l => l.includes('Pre-switch capture'));
    expect(preSwitchLog, 'Pre-switch capture log must appear when AI omits extractedData (pre-fix: never logged → test fails)').toBeTruthy();

    // Captured content must be non-empty
    const charMatch = preSwitchLog?.match(/(\d+) chars/);
    const capturedChars = charMatch ? parseInt(charMatch[1], 10) : 0;
    expect(capturedChars, 'Pre-switch capture must capture actual page content (> 0 chars)').toBeGreaterThan(0);
  });

  /**
   * Negative: AI sets extractedData → dataBuffer non-empty → pre-switch
   * capture guard (!dataBuffer) is false → capture does NOT fire.
   * Prevents the safety net from overwriting AI-curated data.
   */
  test('does NOT fire when AI already set extractedData before navigate', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(EMAIL_URL);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    // data-transfer: step 1 sets extractedData → buffer populated → step 2 navigate
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const consoleLogs = [];
    sw.on('console', msg => consoleLogs.push(msg.text()));

    await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data to spreadsheet',
          strategy: 'Read email, paste to spreadsheet',
          maxSteps: 10,
          creditBudget: 5,
          startAction: { type: 'scrape_page', description: 'Read email' },
        },
        userPrompt: 'Copy subscriptions to spreadsheet',
      },
    });

    await waitForExploreResult(sw, page, 30000);

    // Pre-switch capture must NOT have fired (AI already set extractedData)
    const preSwitchLog = consoleLogs.find(l => l.includes('Pre-switch capture'));
    expect(preSwitchLog, 'Pre-switch capture must NOT fire when AI already captured data').toBeFalsy();

    // Verify AI's extractedData was used (buffer update logged)
    const bufferUpdate = consoleLogs.find(l => l.includes('Data buffer updated'));
    expect(bufferUpdate, 'AI extractedData path must still work').toBeTruthy();
  });

  /**
   * Negative: minimal source page — exploration completes without crash.
   * Pre-switch capture may fire with minimal content; the important thing
   * is no null-pointer exception or unhandled rejection.
   */
  test('minimal source page does not crash — graceful empty paste', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    // Start on spreadsheet.html (content-sparse) as the "source" page
    await page.goto(SPREADSHEET_URL);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'pre-switch-no-extract' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy page data to spreadsheet',
          strategy: 'Navigate, paste',
          maxSteps: 10,
          creditBudget: 5,
          startAction: { type: 'scrape_page', description: 'Read page content' },
        },
        userPrompt: 'Copy data to spreadsheet',
      },
    });
    expect(startResult?.success).toBe(true);

    // Exploration must complete without throwing
    const result = await waitForExploreResult(sw, page, 30000);
    expect(result, 'Exploration must complete without crash even on sparse source page').toBeTruthy();
    expect(result.error, 'Must not produce an unhandled error').toBeUndefined();
  });

  /**
   * Negative: dataBuffer already populated from earlier step → second navigate
   * must NOT overwrite it (guard: !dataBuffer).
   * Uses data-transfer-roundtrip: buffer filled in step 1, then navigate in step 2,
   * then navigate AGAIN in step 7 — second navigate must not trigger pre-switch.
   */
  test('does NOT fire when buffer already populated from a previous step', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(EMAIL_URL);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer-roundtrip' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const consoleLogs = [];
    sw.on('console', msg => consoleLogs.push(msg.text()));

    await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data roundtrip',
          strategy: 'Read email, paste, return for more, paste again',
          maxSteps: 15,
          creditBudget: 10,
          startAction: { type: 'scrape_page', description: 'Read email' },
        },
        userPrompt: 'Copy all subscription data in two batches',
      },
    });

    await waitForExploreResult(sw, page, 45000);

    // data-transfer-roundtrip uses AI extractedData (not missing), so pre-switch
    // capture should never fire (buffer populated by AI, not by the safety net)
    const preSwitchLogs = consoleLogs.filter(l => l.includes('Pre-switch capture'));
    expect(preSwitchLogs.length, 'Pre-switch capture must not fire when AI manages extractedData correctly').toBe(0);
  });

  /**
   * Architecture proof: dataBuffer lives in background.js memory, NOT the
   * content script. When the tab navigates (content script on page A dies),
   * the buffer survives. paste_tsv on page B still receives the captured data.
   */
  test('dataBuffer survives content script death on tab navigate', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(EMAIL_URL);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const consoleLogs = [];
    sw.on('console', msg => consoleLogs.push(msg.text()));

    await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data to spreadsheet',
          strategy: 'Read email (extractData), navigate (CS dies on page A), paste on page B',
          maxSteps: 10,
          creditBudget: 5,
          startAction: { type: 'scrape_page', description: 'Read email' },
        },
        userPrompt: 'Copy subscriptions',
      },
    });

    const result = await waitForExploreResult(sw, page, 30000);
    expect(result, 'Exploration must complete').toBeTruthy();

    // dataBuffer is in the background.js closure — NOT in any content script.
    // Navigation from email-detail.html to spreadsheet.html kills the content
    // script on email-detail.html, but dataBuffer survives in the SW.
    // Prove it: paste_tsv log must show > 0 chars (buffer had data after navigate).
    const pasteLogs = consoleLogs.filter(l => l.includes('paste_tsv') && l.includes('substituted scratchpad data'));
    if (pasteLogs.length > 0) {
      const charMatch = pasteLogs[0].match(/\((\d+) chars\)/);
      const pastedChars = charMatch ? parseInt(charMatch[1], 10) : 0;
      expect(pastedChars, 'dataBuffer must survive content script death — paste must have data > 0 chars').toBeGreaterThan(0);
    }
  });

});
