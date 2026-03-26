// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Consent Loop Resume Tests — BUG 1 Fix
 *
 * Proves that the EXPLORE consent overlay (One-Inch Rule) correctly
 * resumes the exploration loop after the user clicks "Approve & Execute".
 *
 * ROOT CAUSE: hudConsent() in background.js used chrome.tabs.sendMessage
 * and awaited the response Promise. Chrome MV3 suspends the SW during the
 * user-input wait. The SW dies, the Promise is dropped silently, the HUD
 * hides itself (client-side), but the exploration loop never resumes.
 *
 * FIX: Route consent through chrome.storage.session. storage.onChanged
 * events wake a suspended SW — so the loop always resumes, regardless
 * of how long the user takes to click Approve.
 *
 * FAILING ASSERTION (pre-fix): hudConsentPending is never written to
 * session storage because the old mechanism used sendMessage directly.
 * waitForConsentPending() times out → test fails.
 *
 * Run with: npx playwright test 22-consent-loop-resume
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

/**
 * Poll session storage for hudConsentPending (written by the fixed hudConsent()).
 * Pre-fix: this key is NEVER written (old code uses sendMessage only).
 * Post-fix: this key IS written, signalling that consent is awaited.
 */
async function waitForConsentPending(sw, page, waitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const pending = await sw.evaluate(async () => {
      const data = await chrome.storage.session.get('hudConsentPending');
      return data.hudConsentPending || null;
    });
    if (pending) return pending;
    await page.waitForTimeout(300);
  }
  return null;
}

/**
 * Write consent result to session storage — simulates user clicking Approve/Cancel.
 * Post-fix: this triggers storage.onChanged in background.js which wakes the SW
 * and resolves the hudConsent() Promise, resuming the exploration loop.
 */
async function resolveConsent(sw, requestId, approved) {
  await sw.evaluate(async ({ key, result }) => {
    await chrome.storage.session.set({ [key]: result });
    await chrome.storage.session.remove(['hudConsentPending']);
  }, { key: `hudConsentResult_${requestId}`, result: { approved } });
}

const EXPLORE_PLAN_CONSENT = {
  goal: 'Add database headers to the spreadsheet',
  strategy: 'Navigate to spreadsheet, add headers with user approval',
  maxSteps: 10,
  creditBudget: 5,
  startAction: { type: 'scrape_page', description: 'Read current page' },
};

test.describe('Consent loop resume — BUG 1 fix', () => {

  test.beforeEach(async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/spreadsheet.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }, MOCK_BASE);
  });

  /**
   * CRITICAL: This is the primary proof that BUG 1 exists and is fixed.
   *
   * Pre-fix: hudConsent() sends chrome.tabs.sendMessage and never writes
   * hudConsentPending to session storage. waitForConsentPending() returns null
   * → expect(pending).toBeTruthy() FAILS → proves the bug.
   *
   * Post-fix: hudConsent() writes hudConsentPending with requestId before
   * notifying the content script. waitForConsentPending() finds it.
   */
  test('hudConsentPending is written to session storage when consent is required', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/spreadsheet.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'needs-consent' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    await sendToBackground(sw, {
      type: 'explore_start',
      data: { explorePlan: EXPLORE_PLAN_CONSENT, userPrompt: 'Add database headers to the spreadsheet' },
    });

    // PRE-FIX: returns null (key never written) → assertion fails → proves bug
    // POST-FIX: returns { requestId, message, ... } → assertion passes
    const pending = await waitForConsentPending(sw, page, 10000);
    expect(pending, 'hudConsentPending must be written to session storage when consent is required (pre-fix: never written → test fails)').toBeTruthy();
    expect(pending.requestId, 'hudConsentPending must include requestId').toBeTruthy();
    expect(pending.message, 'hudConsentPending must include the consent message').toBeTruthy();

    // Clean up — cancel so exploration exits
    await resolveConsent(sw, pending.requestId, false);
    await waitForExploreResult(sw, page, 8000);
  });

  /**
   * Happy path: user clicks Approve → loop continues → goal complete.
   * Pre-fix: hudConsentPending never written → resolveConsent never called →
   *   exploration hangs forever → waitForExploreResult returns null → FAILS.
   */
  test('approve consent resumes exploration loop and reaches goal complete', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/spreadsheet.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'needs-consent' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: { explorePlan: EXPLORE_PLAN_CONSENT, userPrompt: 'Add database headers to the spreadsheet' },
    });
    expect(startResult?.success).toBe(true);

    const pending = await waitForConsentPending(sw, page, 10000);
    expect(pending, 'Consent must be requested (hudConsentPending written)').toBeTruthy();

    // Simulate user clicking "Approve & Execute"
    await resolveConsent(sw, pending.requestId, true);

    const result = await waitForExploreResult(sw, page, 20000);
    expect(result, 'Exploration must complete after consent approval').toBeTruthy();
    expect(result.success, 'Exploration must succeed after approval').toBe(true);
    expect(result.goalResult, 'goalResult must match mock scenario result').toMatch(/Database headers added/i);
  });

  /**
   * Negative: user clicks Cancel → loop exits cleanly with "paused" message.
   * Pre-fix: same hang issue → waitForExploreResult returns null → FAILS.
   */
  test('cancel consent exits loop cleanly with paused goalResult', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/spreadsheet.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'needs-consent' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    await sendToBackground(sw, {
      type: 'explore_start',
      data: { explorePlan: EXPLORE_PLAN_CONSENT, userPrompt: 'Add database headers to the spreadsheet' },
    });

    const pending = await waitForConsentPending(sw, page, 10000);
    expect(pending, 'Consent must be requested').toBeTruthy();

    // Simulate user clicking "Cancel"
    await resolveConsent(sw, pending.requestId, false);

    const result = await waitForExploreResult(sw, page, 10000);
    expect(result, 'Exploration must complete cleanly after cancel').toBeTruthy();
    expect(result.goalResult || result.error || '').toMatch(/paused|declined|cancelled/i);
  });

  /**
   * Negative (SW lifecycle): approval after a 3-second user delay still resumes.
   * This directly tests the SW-wake guarantee of storage.onChanged.
   * Pre-fix: the SW Promise was dropped silently on suspension during the delay.
   */
  test('approval after 3-second delay still resumes loop', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/spreadsheet.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'needs-consent' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    await sendToBackground(sw, {
      type: 'explore_start',
      data: { explorePlan: EXPLORE_PLAN_CONSENT, userPrompt: 'Add database headers to the spreadsheet' },
    });

    const pending = await waitForConsentPending(sw, page, 10000);
    expect(pending, 'Consent must be requested').toBeTruthy();

    // Simulate a 3-second hesitation before clicking Approve
    await page.waitForTimeout(3000);
    await resolveConsent(sw, pending.requestId, true);

    const result = await waitForExploreResult(sw, page, 25000);
    expect(result, 'Loop must complete even after delayed approval').toBeTruthy();
    expect(result.success).toBe(true);
  });

  /**
   * Regression: exploration without a consent step must NOT write hudConsentPending.
   * Ensures the new storage key is not spuriously set for normal explorations.
   */
  test('exploration without consent action does not write hudConsentPending', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/email-detail.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker should be running').toBeTruthy();

    // data-transfer scenario has zero needsConsent steps
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'data-transfer' }),
      });
    }, MOCK_BASE);

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Copy subscription data to spreadsheet',
          strategy: 'Read and paste',
          maxSteps: 10,
          creditBudget: 5,
          startAction: { type: 'scrape_page', description: 'Read email' },
        },
        userPrompt: 'Copy subscriptions to spreadsheet',
      },
    });

    // Let exploration run for 5 seconds without any consent steps
    await page.waitForTimeout(5000);
    const pending = await sw.evaluate(async () => {
      const data = await chrome.storage.session.get('hudConsentPending');
      return data.hudConsentPending || null;
    });
    expect(pending, 'hudConsentPending must NOT be written for consent-free explorations').toBeNull();

    // Clean up
    await waitForExploreResult(sw, page, 20000);
  });

});
