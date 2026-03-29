'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  DELEGATION FLOW — TEST SUITE (REAL E2E TESTS)
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests the "Delegate" button flow end-to-end.
 *
 * D1 — Real window.postMessage → dashboard_bridge.js → chrome.storage.local
 *       Clicks the actual Delegate button on a test harness page.
 *       Verifies the bridge content script stores pendingDelegation in storage.
 *
 * D2 — Panel auto-fill from pendingDelegation
 *       Pre-sets pendingDelegation in storage, then opens the side panel.
 *       Verifies initMainView() reads the storage and auto-fills the prompt input.
 *
 * D3 — scrape_page loop circuit breaker
 *       Configures the mock server to return scrape_page for all explore-step calls.
 *       Verifies the exploration stops after 3 consecutive scrape decisions
 *       (circuit breaker in background.js) instead of running until maxSteps.
 *
 * Run: npx playwright test 20-delegation --retries 0
 */

const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken, injectAuth } = require('../helpers/auth');

const MOCK_BASE = 'http://localhost:3099';
const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-popup-blocking',
      ],
    });
    await use(context);
    await context.close();
  },
});

/** Wait for the extension service worker. */
async function getSW(context, page) {
  for (let i = 0; i < 30; i++) {
    const sw = context.serviceWorkers().find(w => w.url().includes('background'));
    if (sw) return sw;
    await page.waitForTimeout(500);
  }
  return null;
}

/** Extract extension ID from SW URL (chrome-extension://<id>/background.js). */
function getExtensionId(sw) {
  const match = sw.url().match(/chrome-extension:\/\/([a-z]+)\//i);
  if (!match) throw new Error('Could not extract extension ID from: ' + sw.url());
  return match[1];
}

/**
 * Trigger explore_start in the service worker via content script relay.
 * (Service workers cannot send messages to themselves.)
 */
async function sendExploreStart(sw, explorePlan) {
  return sw.evaluate(async (plan) => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return { error: 'No active tab' };
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (msg) => new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (resp) => {
          resolve(resp || { error: chrome.runtime.lastError?.message });
        });
      }),
      args: [{ type: 'explore_start', data: { ...plan, tabId: activeTab.id } }],
    });
    return result?.result;
  }, explorePlan);
}

/** Poll chrome.storage.session for explorationResult. */
async function waitForExploreResult(sw, page, waitMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const result = await sw.evaluate(async () => {
      const data = await chrome.storage.session.get('explorationResult');
      return data.explorationResult || null;
    });
    if (result) return result;
    await page.waitForTimeout(300);
  }
  return null;
}

test.describe('D: Delegation flow (dashboard_bridge → sidepanel)', () => {

  test.beforeEach(async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }, MOCK_BASE).catch(() => {});
  });

  // D1 ──────────────────────────────────────────────────────────────────────────
  // Clicks the REAL Delegate button on a harness page where dashboard_bridge.js
  // is injected (global-setup patches manifest.json to include localhost:3099).
  // Verifies the REAL bridge code stores pendingDelegation in chrome.storage.local.
  test('D1: real Delegate button → bridge → chrome.storage.local', async ({ context }) => {
    const page = await context.newPage();
    // Navigate to the harness page — dashboard_bridge.js content script will inject here
    await page.goto(`${MOCK_BASE}/harness/delegate-test.html`);
    await page.waitForLoadState('domcontentloaded');
    // Give the content script time to initialize
    await page.waitForTimeout(800);

    const sw = await getSW(context, page);
    expect(sw, 'Service worker must be running').toBeTruthy();

    // Clear any pre-existing pendingDelegation from a prior test
    await sw.evaluate(async () => chrome.storage.local.remove('pendingDelegation'));

    // Click the Delegate button — this fires window.postMessage({ type: 'DELEGATE_TASK', ... })
    // The dashboard_bridge.js content script intercepts it and writes to chrome.storage.local
    await page.locator('#delegate-btn').click();

    // Poll storage for up to 4s (bridge code is async — storage write is first await)
    let stored = null;
    for (let i = 0; i < 16; i++) {
      stored = await sw.evaluate(async () => {
        const { pendingDelegation } = await chrome.storage.local.get('pendingDelegation');
        return pendingDelegation || null;
      });
      if (stored) break;
      await page.waitForTimeout(250);
    }

    expect(stored, 'pendingDelegation must be written to chrome.storage.local by dashboard_bridge.js').not.toBeNull();
    expect(stored.taskId).toBe('test-delegate-001');
    expect(stored.taskTitle).toBe('Buy a t-shirt on Amazon');
    expect(stored.priority).toBe('HIGH');

    // Cleanup
    await sw.evaluate(async () => chrome.storage.local.remove('pendingDelegation'));
  });

  // D2 ──────────────────────────────────────────────────────────────────────────
  // Pre-sets pendingDelegation in chrome.storage.local, then opens the side panel.
  // Verifies initMainView() in sidepanel.js reads it and auto-fills #prompt-input.
  test('D2: panel auto-fills from pendingDelegation on open', async ({ context }) => {
    const sw = await getSW(context, context.pages()[0] || await context.newPage());
    expect(sw, 'Service worker must be running').toBeTruthy();
    const extensionId = getExtensionId(sw);

    const TASK_TITLE = 'Buy a t-shirt on Amazon';
    const token = generateTestToken();

    // Open the side panel as a tab
    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panelPage.waitForSelector('#auth-view, #main-view', { timeout: 10_000 });

    // Inject auth AND pendingDelegation into extension storage
    await panelPage.evaluate(async ({ token, TASK_TITLE }) => {
      await chrome.storage.local.set({
        token,
        user: JSON.stringify({ id: 'test-user-001', email: 'test@enhancivity.com', name: 'Test User' }),
        pendingDelegation: {
          taskId: 'delegate-panel-test',
          taskTitle: TASK_TITLE,
          taskDescription: 'Size M, under $30, blue preferred',
          priority: 'HIGH',
          dueDate: null,
        },
      });
    }, { token, TASK_TITLE });

    // Reload the panel so initMainView() runs with the fresh storage
    await panelPage.reload();
    await panelPage.waitForSelector('#main-view', { timeout: 10_000 });
    // Give initMainView() time to finish (it has several awaits)
    await panelPage.waitForTimeout(1500);

    // Verify the prompt input was auto-filled
    const inputValue = await panelPage.locator('#prompt-input').inputValue();
    expect(inputValue, 'Prompt input must contain the delegated task title').toContain(TASK_TITLE);
    expect(inputValue, 'Prompt must end with "Please help me complete this."').toMatch(/Please help me complete this\.$/);

    // Verify pendingDelegation was consumed (removed from storage)
    const remaining = await panelPage.evaluate(async () => {
      const { pendingDelegation } = await chrome.storage.local.get('pendingDelegation');
      return pendingDelegation;
    });
    expect(remaining, 'pendingDelegation must be removed from storage after consumption').toBeUndefined();

    await panelPage.close();
  });

  // D3 ──────────────────────────────────────────────────────────────────────────
  // Configures mock server to return scrape_page for ALL explore-step calls.
  // The circuit breaker in background.js must stop the exploration after 3 consecutive
  // scrape_page decisions from the AI — NOT run until maxSteps or credit exhaustion.
  test('D3: scrape_page loop circuit breaker stops exploration after 3 consecutive scrapes', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/delegate-test.html`);
    await page.waitForLoadState('domcontentloaded');

    const sw = await getSW(context, page);
    expect(sw, 'Service worker must be running').toBeTruthy();

    // Activate scrape-loop scenario on mock server
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'scrape-loop' }),
      });
    }, MOCK_BASE);

    // Inject auth token
    const token = generateTestToken();
    await sw.evaluate(async (t) => {
      await chrome.storage.local.set({ token: t });
    }, token);

    // Clear any leftover exploration result from a prior test
    await sw.evaluate(async () => chrome.storage.session.remove('explorationResult'));

    // Start exploration — navigate first (non-scrape startAction so counter starts at 0)
    const startResult = await sendExploreStart(sw, {
      explorePlan: {
        goal: 'Test scrape_page circuit breaker',
        strategy: 'The mock server will always return scrape_page — circuit breaker must fire',
        maxSteps: 12,     // high limit — circuit breaker must fire BEFORE this
        creditBudget: 10, // high budget — circuit breaker must fire BEFORE this
        startAction: { type: 'scrape_page', description: 'Initial page observation' },
      },
      userPrompt: 'Test scrape loop',
    });

    expect(startResult?.success, 'explore_start must succeed').toBe(true);

    // Wait for explorationResult to be written (the loop must end via circuit breaker)
    const result = await waitForExploreResult(sw, page, 30000);
    expect(result, 'explorationResult must be set (exploration must end, not hang)').not.toBeNull();

    // Circuit breaker fires at 3rd consecutive scrape_page decision
    // stepsUsed must be ≤ 5 (leaves room for startAction + up to 3 loop steps)
    expect(result.stepsUsed, 'Circuit breaker must stop exploration within 5 steps').toBeLessThanOrEqual(5);

    // The step log must contain the scrape_loop_break entry
    const hasCircuitBreak = (result.stepLog || []).some(
      entry => entry.action?.type === 'scrape_loop_break'
    );
    expect(hasCircuitBreak, 'stepLog must contain a scrape_loop_break entry').toBe(true);

    // Verify the exploration did NOT succeed (goal was not complete — it was a loop)
    expect(result.success, 'Exploration must not succeed — circuit breaker stopped it').toBe(false);

    // Reset scenario
    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }, MOCK_BASE);
  });

});
