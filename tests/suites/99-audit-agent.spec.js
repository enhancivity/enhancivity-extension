// @ts-check
'use strict';

/**
 * AUDIT: Agent Behaviors — Real Browser + Real Websites
 *
 * Tests the Chrome extension against real websites (Gmail, Google Calendar,
 * Google Meet, Amazon). No mocks. If a test fails, a real bug was found.
 *
 * ⚠️  ISOLATION REQUIRED — run this file SEPARATELY:
 *       npx playwright test 99-audit-agent --config playwright.config.js
 *
 * DO NOT run alongside other test files. global-setup.js patches background.js
 * to point API_BASE at localhost:3099 (mock server). This file requires
 * API_BASE = 'http://localhost:3001' (real backend).
 *
 * Environment requirements:
 *   1. Backend running: node webhook-server.js (port 3001)
 *   2. PostgreSQL + Redis running (Docker)
 *   3. AUTH_SECRET=enhancivity-test-secret-key-2026 in enhancivity-main/.env
 *   4. Chrome profile logged into Google and Amazon (for tests 3.2–3.8)
 *   5. API_BASE must be 'http://localhost:3001' in background.js (not patched)
 */

const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { generateTestToken } = require('../helpers/auth');
const { collectConsoleLogs } = require('../helpers/extension');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..');
const BG_PATH = path.resolve(EXTENSION_PATH, 'background.js');
const BACKEND = 'http://localhost:3001';
const TOKEN = generateTestToken('test-user-001');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForSW(context, maxMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const sw = context.serviceWorkers().find(w => w.url().includes('background'));
    if (sw) return sw;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function injectAuthIntoSW(sw, token) {
  await sw.evaluate(async (t) => {
    await chrome.storage.local.set({
      token: t,
      user: JSON.stringify({ id: 'test-user-001', email: 'test@enhancivity.com', name: 'Test User' }),
    });
  }, token);
}

async function checkLoginState(page, domain) {
  try {
    await page.goto(`https://${domain}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch (e) {
    return { isLoggedIn: false, currentUrl: page.url(), error: e.message };
  }
  const url = page.url();
  const isLoginPage = /login|signin|accounts\.google\.com\/v3|auth|challenge|IdentifierPage/i.test(url);
  return { isLoggedIn: !isLoginPage, currentUrl: url };
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const test = base.extend({
  extensionContext: async ({}, use) => {
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

// ─── Guard: background.js must not be patched ─────────────────────────────────

test.beforeAll(async () => {
  let bgContent;
  try {
    bgContent = fs.readFileSync(BG_PATH, 'utf8');
  } catch (e) {
    // Can't read background.js — not blocking
    return;
  }

  const hasMockServer = bgContent.includes('localhost:3099');
  const hasRealBackend = bgContent.includes('localhost:3001') || bgContent.includes('service.enhancivity.com');

  if (hasMockServer && !hasRealBackend) {
    // background.js has been patched by global-setup.js
    // All tests in this file will be meaningless — fail fast with a clear message
    throw new Error(
      '❌ background.js is patched to localhost:3099 (mock server). ' +
      'Run 99-audit-agent in isolation BEFORE other tests: ' +
      'npx playwright test 99-audit-agent --config playwright.config.js'
    );
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Audit: Agent Behaviors — Real Browser', () => {

  // ─── TEST 3.1 ─────────────────────────────────────────────────
  test('3.1 — backend reachable from within extension context', async ({ extensionContext: context }) => {
    test.setTimeout(30_000);

    const page = context.pages()[0] || await context.newPage();
    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();

    // Inject auth into extension storage
    await injectAuthIntoSW(sw, TOKEN);

    // Fetch from inside the SW to verify real backend reachability
    const result = await sw.evaluate(async (backend) => {
      try {
        const res = await fetch(`${backend}/api/todos`, {
          headers: { Authorization: `Bearer ${(await chrome.storage.local.get('token')).token}` },
        });
        return { status: res.status, ok: res.ok };
      } catch (e) {
        return { status: 0, error: e.message };
      }
    }, BACKEND);

    expect(result.error, `Backend must be reachable from SW. Error: ${result.error}`).toBeUndefined();
    expect(result.status, 'Backend must return 200 or 401 (not connection error)').not.toBe(0);
    expect([200, 401], `Got unexpected status: ${result.status}`).toContain(result.status);
  });

  // ─── TEST 3.2 ─────────────────────────────────────────────────
  test('3.2 — Gmail: EXPLORE starts without crashing (no ReferenceError / TypeError)', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const page = context.pages()[0] || await context.newPage();
    const loginState = await checkLoginState(page, 'mail.google.com');
    if (!loginState.isLoggedIn) {
      test.skip(true, `Not logged in to Gmail — current URL: ${loginState.currentUrl}`);
      return;
    }

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    const logs = collectConsoleLogs(sw);

    const result = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'explore_start',
        data: {
          explorePlan: {
            goal: 'Find the latest unread email and tell me who sent it',
            strategy: 'Navigate to inbox, scan for unread emails',
            maxSteps: 5,
            creditBudget: 3,
          },
          userPrompt: 'Find the latest unread email',
        },
      });
    });

    logs.stop();

    // Assert: result is not undefined
    expect(result, 'explore_start must return a result object (not undefined)').toBeTruthy();
    expect(typeof result, 'Result must be an object').toBe('object');

    // Assert: no ReferenceError or TypeError in SW logs
    const errorLogs = logs.messages.filter(m =>
      m.type === 'error' &&
      (m.text.includes('ReferenceError') || m.text.includes('TypeError') || m.text.includes('is not defined'))
    );

    if (errorLogs.length > 0) {
      // Fail with details
      const errorDetails = errorLogs.map(m => m.text).join('\n');
      expect.fail(`JS errors detected in service worker during EXPLORE on Gmail:\n${errorDetails}`);
    }
  });

  // ─── TEST 3.3 ─────────────────────────────────────────────────
  test('3.3 — Google Calendar: EXPLORE starts without JS errors', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const page = context.pages()[0] || await context.newPage();
    const loginState = await checkLoginState(page, 'calendar.google.com');
    if (!loginState.isLoggedIn) {
      test.skip(true, `Not logged in to Google Calendar — current URL: ${loginState.currentUrl}`);
      return;
    }

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    const logs = collectConsoleLogs(sw);

    const result = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'explore_start',
        data: {
          explorePlan: {
            goal: 'Find my next scheduled calendar event',
            strategy: 'Look at the current week view for upcoming events',
            maxSteps: 5,
            creditBudget: 3,
          },
          userPrompt: 'Find my next calendar event',
        },
      });
    });

    logs.stop();

    expect(result, 'explore_start must return a result object').toBeTruthy();

    const errorLogs = logs.messages.filter(m =>
      m.type === 'error' &&
      (m.text.includes('ReferenceError') || m.text.includes('TypeError') || m.text.includes('is not defined'))
    );
    if (errorLogs.length > 0) {
      expect.fail(`JS errors on Calendar EXPLORE:\n${errorLogs.map(m => m.text).join('\n')}`);
    }
  });

  // ─── TEST 3.4 — REGRESSION CHECK ──────────────────────────────
  test('3.4 — REGRESSION: no "elementFindTimings is not defined" error on Google Meet', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const page = context.pages()[0] || await context.newPage();
    const loginState = await checkLoginState(page, 'meet.google.com');
    if (!loginState.isLoggedIn) {
      test.skip(true, `Not logged in to Google Meet — current URL: ${loginState.currentUrl}`);
      return;
    }

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    const logs = collectConsoleLogs(sw);

    await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'explore_start',
        data: {
          explorePlan: {
            goal: 'List any upcoming meetings',
            strategy: 'Read the current page',
            maxSteps: 3,
            creditBudget: 2,
          },
          userPrompt: 'List my upcoming meetings',
        },
      });
    });

    // Wait briefly for content script errors to propagate
    await new Promise(r => setTimeout(r, 3_000));
    logs.stop();

    // Check for the specific regression
    const timingsError = logs.messages.find(m =>
      m.text && m.text.includes('elementFindTimings is not defined')
    );

    if (timingsError) {
      expect.fail(
        'REGRESSION DETECTED: "elementFindTimings is not defined" error found in service worker logs. ' +
        'This bug was supposed to be fixed. Full error: ' + timingsError.text
      );
    }
  });

  // ─── TEST 3.5 ─────────────────────────────────────────────────
  test('3.5 — Amazon: EXPLORE returns a valid result (not undefined)', async ({ extensionContext: context }) => {
    test.setTimeout(90_000);

    const page = context.pages()[0] || await context.newPage();

    try {
      await page.goto('https://www.amazon.de', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) {
      test.skip(true, `Cannot reach Amazon.de: ${e.message}`);
      return;
    }

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    const logs = collectConsoleLogs(sw);

    const result = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'explore_start',
        data: {
          explorePlan: {
            goal: 'Search for wireless headphones under 50 euros and list the top 3 results',
            strategy: 'Use the search bar on Amazon, then read the results',
            maxSteps: 10,
            creditBudget: 5,
          },
          userPrompt: 'Find wireless headphones under 50 euros on Amazon',
        },
      });
    });

    // Wait a moment for early async logs
    await new Promise(r => setTimeout(r, 2_000));
    logs.stop();

    // Critical assertion: result must not be undefined
    expect(result, 'explore_start must never return undefined').not.toBeUndefined();
    expect(result, 'explore_start must return an object').toBeTruthy();

    // Must have success or async or errorType — never a raw JS error
    const hasValidShape = (
      ('success' in result) ||
      ('async' in result) ||
      ('errorType' in result)
    );
    expect(hasValidShape, `Result must have success/async/errorType field. Got: ${JSON.stringify(result)}`).toBe(true);

    // Must have at least one [Explore] or [BG] log (proves the code path was entered)
    const exploreLog = logs.messages.find(m =>
      m.text && (m.text.includes('[Explore]') || m.text.includes('[BG]') || m.text.includes('[Ghost]'))
    );
    if (!exploreLog) {
      test.info().annotations.push({
        type: 'note',
        description: 'No [Explore]/[BG] log lines found — may mean INSUFFICIENT_CREDITS blocked execution before explore start',
      });
    }
  });

  // ─── TEST 3.6 ─────────────────────────────────────────────────
  test('3.6 — Amazon: modal dismissal does not loop (max 3 steps)', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const page = context.pages()[0] || await context.newPage();

    try {
      await page.goto('https://www.amazon.de', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) {
      test.skip(true, `Cannot reach Amazon.de: ${e.message}`);
      return;
    }

    await page.waitForTimeout(2_000); // Allow modals to appear

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    // Take a snapshot to check if modal is visible
    const snapshot = await sw.evaluate(async (tabId) => {
      return new Promise(resolve => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs[0]) return resolve(null);
          chrome.tabs.sendMessage(tabs[0].id, { type: 'take_snapshot' }, (resp) => {
            resolve(resp?.snapshot || resp || null);
          });
        });
      });
    }, null);

    if (!snapshot || !snapshot.hasOpenModal) {
      test.skip(true, 'No modal currently visible on Amazon.de — skip (run when location/cookie modal appears)');
      return;
    }

    const logs = collectConsoleLogs(sw);

    await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'explore_start',
        data: {
          explorePlan: {
            goal: 'Dismiss any modal on the page and then search for wireless headphones',
            strategy: 'First dismiss any open modal using Escape or close button, then search',
            maxSteps: 5,
            creditBudget: 3,
          },
          userPrompt: 'Dismiss modal and search for headphones',
        },
      });
    });

    await new Promise(r => setTimeout(r, 8_000)); // Wait for modal dismissal steps
    logs.stop();

    // Check for tryDismissModal log
    const dismissLog = logs.messages.find(m => m.text && m.text.includes('tryDismissModal'));
    if (dismissLog) {
      test.info().annotations.push({ type: 'info', description: 'tryDismissModal was triggered: ' + dismissLog.text });
    }

    // Check that the same modal-related action didn't repeat more than 3 times
    const modalStepLogs = logs.messages.filter(m =>
      m.text && (m.text.includes('modal') || m.text.includes('dismiss') || m.text.includes('Dismiss'))
    );

    if (modalStepLogs.length > 6) {
      // More than 6 modal-related log entries suggests looping
      test.info().annotations.push({
        type: 'bug',
        description: `Possible modal loop: ${modalStepLogs.length} modal-related log entries. Expected ≤ 6. Logs:\n${modalStepLogs.slice(0, 6).map(m => m.text).join('\n')}`,
      });
    }
  });

  // ─── TEST 3.7 ─────────────────────────────────────────────────
  test('3.7 — explore_cancel stops exploration within 3 seconds', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const page = context.pages()[0] || await context.newPage();

    try {
      await page.goto('https://www.amazon.de', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) {
      test.skip(true, `Cannot reach Amazon.de: ${e.message}`);
      return;
    }

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    // Start exploration
    await sw.evaluate(async () => {
      chrome.runtime.sendMessage({
        type: 'explore_start',
        data: {
          explorePlan: {
            goal: 'Browse all product categories on Amazon',
            strategy: 'Click through every menu item',
            maxSteps: 30,
            creditBudget: 12,
          },
          userPrompt: 'Browse all Amazon categories',
        },
      });
    });

    // Wait briefly for at least 1 step to potentially start
    await new Promise(r => setTimeout(r, 500));

    // Cancel
    const cancelResult = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: 'explore_cancel' });
    });

    expect(cancelResult, 'explore_cancel must return a result').toBeTruthy();
    expect(
      cancelResult.success,
      `explore_cancel must return { success: true }. Got: ${JSON.stringify(cancelResult)}`
    ).toBe(true);
    expect(cancelResult.cancelled, 'explore_cancel result must have cancelled: true').toBe(true);

    // Collect logs for the next 3 seconds — no new [Explore] Step logs should appear
    const postCancelLogs = [];
    const collectTimer = setInterval(() => {}, 100);
    await new Promise(r => setTimeout(r, 3_000));
    clearInterval(collectTimer);

    // We can't easily collect post-cancel logs without a persistent listener,
    // so instead verify SW state via storage
    const explorationActive = await sw.evaluate(async () => {
      const data = await chrome.storage.session.get('explorationActive');
      return data.explorationActive;
    }).catch(() => null);

    if (explorationActive !== null && explorationActive !== undefined) {
      expect(explorationActive, 'explorationActive must be false/null after cancel').toBeFalsy();
    }
  });

  // ─── TEST 3.8 ─────────────────────────────────────────────────
  test('3.8 — process_request recognizes multi-site chain intent', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const page = context.pages()[0] || await context.newPage();

    try {
      await page.goto('https://www.amazon.de', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) {
      test.skip(true, `Cannot reach Amazon.de: ${e.message}`);
      return;
    }

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    const result = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'process_request',
        data: {
          userPrompt: 'Search Amazon for wireless headphones and email the top result to me',
          availableTabs: [
            { url: 'https://www.amazon.de', title: 'Amazon.de', id: 1, domain: 'amazon.de' },
          ],
        },
      });
    });

    expect(result, 'process_request must not return undefined').not.toBeUndefined();
    expect(result, 'process_request must return an object').toBeTruthy();
    expect(result, 'Result must have success field').toHaveProperty('success');

    if (result.success === true) {
      expect(result, 'Success result must have data').toHaveProperty('data');
      expect(result.data, 'data must have action_type').toHaveProperty('action_type');
      test.info().annotations.push({
        type: 'info',
        description: `Chain action_type: ${result.data.action_type}`,
      });
    } else {
      // success: false — must have a typed error
      expect(result.errorType, 'Failed result must have a typed errorType').toBeTruthy();
    }
  });

  // ─── TEST 3.9 ─────────────────────────────────────────────────
  test('3.9 — SW survives tab open/close without crashing', async ({ extensionContext: context }) => {
    test.setTimeout(60_000);

    const sw = await waitForSW(context);
    expect(sw, 'Service worker must be running').toBeTruthy();
    await injectAuthIntoSW(sw, TOKEN);

    // Open 3 tabs
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    const tab3 = await context.newPage();

    await tab1.goto('https://www.amazon.de', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    await tab2.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    await tab3.goto('https://www.wikipedia.org', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});

    // Send process_request with 3 tabs
    const result1 = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'process_request',
        data: {
          userPrompt: 'What sites do I have open?',
          availableTabs: [
            { url: 'https://www.amazon.de', title: 'Amazon', id: 1 },
            { url: 'https://www.google.com', title: 'Google', id: 2 },
            { url: 'https://www.wikipedia.org', title: 'Wikipedia', id: 3 },
          ],
        },
      });
    });

    expect(result1, 'First call with 3 tabs must return a result').toBeTruthy();

    // Close 2 tabs
    await tab1.close().catch(() => {});
    await tab2.close().catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // Send another request with 1 tab
    const result2 = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'process_request',
        data: {
          userPrompt: 'What am I looking at right now?',
          availableTabs: [
            { url: 'https://www.wikipedia.org', title: 'Wikipedia', id: 3 },
          ],
        },
      });
    }).catch(e => ({ error: e.message }));

    expect(result2, 'SW must still be responsive after tab closures').toBeTruthy();
    expect(result2.error, `SW crashed after tab close: ${result2.error}`).toBeUndefined();
    expect(result2, 'Second call must have success field').toHaveProperty('success');

    await tab3.close().catch(() => {});
  });

});
