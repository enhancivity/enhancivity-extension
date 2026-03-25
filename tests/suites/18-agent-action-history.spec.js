// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

const MOCK_BASE = 'http://localhost:3099';

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

async function waitForExploreResult(sw, page, waitMs = 30000) {
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

async function readBackgroundActionHistory(sw) {
  return sw.evaluate(async () => {
    const { sessionActionHistory = [] } = await chrome.storage.session.get('sessionActionHistory');
    return sessionActionHistory;
  });
}

async function readContentActionHistory(sw) {
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return [];

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_explore.js'],
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'explore_action',
        actionType: 'history_get',
      }, (resp) => resolve(resp?.entries || []));
    });
  });
}

test.describe('Agent Action History', () => {
  test('after 3 explore steps, history contains 3 entries', async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/settings-page.html`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(async (base) => {
      await fetch(`${base}/test/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      await fetch(`${base}/test/set-scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'action-history' }),
      });
    }, MOCK_BASE);

    const sw = await getServiceWorker(context, 60_000);
    expect(sw, 'Service worker should be running').toBeTruthy();

    const token = generateTestToken();
    await sw.evaluate(async (authToken) => {
      await chrome.storage.local.set({ token: authToken });
      await chrome.storage.session.remove(['explorationResult', 'sessionActionHistory']);
    }, token);

    const startResult = await sendToBackground(sw, {
      type: 'explore_start',
      data: {
        explorePlan: {
          goal: 'Review the General, Usage, and Billing settings tabs.',
          strategy: 'Open each tab once, then stop.',
          maxSteps: 5,
          creditBudget: 5,
          startAction: { type: 'take_snapshot', description: 'Observe the current settings page' },
        },
        userPrompt: 'Review the General, Usage, and Billing settings tabs.',
      },
    });

    expect(startResult?.success).toBe(true);

    const result = await waitForExploreResult(sw, page, 45_000);
    expect(result, 'Exploration should finish within 45s').toBeTruthy();
    expect(result?.success).toBe(true);

    await expect.poll(async () => {
      const history = await readBackgroundActionHistory(sw);
      return history.length;
    }, { timeout: 10_000 }).toBe(3);

    const backgroundHistory = await readBackgroundActionHistory(sw);
    expect(backgroundHistory).toHaveLength(3);
    expect(backgroundHistory.map(entry => entry.action)).toEqual([
      'click_element',
      'click_element',
      'click_element',
    ]);
    expect(backgroundHistory.map(entry => entry.step)).toEqual([1, 2, 3]);
    expect(backgroundHistory.every(entry => typeof entry.target === 'string' && entry.target.length > 0)).toBe(true);
    expect(new Set(backgroundHistory.map(entry => entry.target)).size).toBe(3);
    expect(backgroundHistory.every(entry => entry.result === 'success')).toBe(true);
    expect(backgroundHistory.every(entry => (entry.pageUrl || '').includes('/harness/settings-page.html'))).toBe(true);

    const contentHistory = await readContentActionHistory(sw);
    expect(contentHistory).toHaveLength(3);
    expect(contentHistory.map(entry => entry.step)).toEqual([1, 2, 3]);
    expect(contentHistory.every(entry => typeof entry.target === 'string' && entry.target.length > 0)).toBe(true);

    await expect(page.locator('#panel-general')).toHaveClass(/active/);
  });
});
