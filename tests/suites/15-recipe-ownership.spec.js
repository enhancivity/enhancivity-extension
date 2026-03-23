// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Recipe Ownership & Chaining E2E Tests
 *
 * Tests the fundamental recipe behaviors:
 * 1. User's own recipe plays even at 0% score when no community alternatives
 * 2. Community recipes are recommended and can be replayed
 * 3. Recipes can be chained across sub-tasks (multi-site)
 * 4. Recipes can be played across tabs (switch_tab segments)
 *
 * Run with: npx playwright test 15-recipe-ownership
 */

const MOCK_BASE = 'http://localhost:3099';

const test = base.extend({
  context: async ({}, use) => {
    const extPath = path.resolve(__dirname, '..', '..');
    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--no-first-run',
        '--disable-popup-blocking',
      ],
    });
    await use(ctx);
    await ctx.close();
  },
});

/** Wait for the background service worker. */
async function getServiceWorker(context) {
  let sw;
  for (let i = 0; i < 30; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes('background'));
    if (sw) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return sw;
}

/**
 * Send a message to the background SW via content script relay.
 * SW can't message itself, so we inject a relay into the active tab.
 */
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
      args: [msg],
    });
    return result?.result;
  }, message);
}

test.describe('Recipe ownership, chaining & cross-tab replay', () => {

  test('own recipe replays even with very low score (no community alternatives)', async ({ context }) => {
    const sw = await getServiceWorker(context);
    expect(sw, 'Service worker should be running').toBeTruthy();

    const formPage = await context.newPage();
    await formPage.goto(`${MOCK_BASE}/harness/form-page.html`);
    await formPage.waitForLoadState('domcontentloaded');

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const recipe = {
      id: 'own-zero-score-001',
      workflowName: 'My zero-score form recipe',
      siteDomain: 'localhost',
      startUrl: 'http://localhost:3099/harness/form-page.html',
      confidence: 0.3,
      validationCount: 0,
      status: 'CANDIDATE',
      trainedBy: 'test-user-001',
      steps: [
        { stepNumber: 1, action: { type: 'click', selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }], description: 'Click name field' } },
        { stepNumber: 2, action: { type: 'type', selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }], inputType: 'variable', variableName: 'userName', description: 'Type name' } },
        { stepNumber: 3, action: { type: 'click', selectors: [{ strategy: 'css-id', value: '#email', priority: 1 }], description: 'Click email field' } },
        { stepNumber: 4, action: { type: 'type', selectors: [{ strategy: 'css-id', value: '#email', priority: 1 }], inputType: 'variable', variableName: 'userEmail', description: 'Type email' } },
      ],
      variables: [{ name: 'userName', description: 'Name' }, { name: 'userEmail', description: 'Email' }],
    };

    // Use relay pattern — SW can't message itself
    const result = await sendToBackground(sw, {
      type: 'learning_replay_recipe',
      data: { recipe, variables: { userName: 'OwnRecipeWorks', userEmail: 'own@zero-score.com' }, originalPrompt: 'fill the form' },
    });

    expect(result, `Replay returned: ${JSON.stringify(result)}`).toBeTruthy();
    expect(result.success, `Replay failed: ${result.error || result.failReason || JSON.stringify(result)}`).toBe(true);
    expect(result.completedSteps).toBe(4);

    await expect(formPage.locator('#first-name')).toHaveValue('OwnRecipeWorks');
    await expect(formPage.locator('#email')).toHaveValue('own@zero-score.com');

    await formPage.close();
  });

  test('community recipe can be replayed on matching page', async ({ context }) => {
    // Open a page first to keep the SW alive between tests
    const warmupPage = context.pages()[0] || await context.newPage();
    await warmupPage.goto(`${MOCK_BASE}/harness/form-page.html`);
    await warmupPage.waitForLoadState('domcontentloaded');

    const sw = await getServiceWorker(context);
    expect(sw, 'Service worker should be running').toBeTruthy();

    const formPage = await context.newPage();
    await formPage.goto(`${MOCK_BASE}/harness/form-page.html`);
    await formPage.waitForLoadState('domcontentloaded');

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    const result = await sendToBackground(sw, {
      type: 'learning_replay_recipe',
      data: {
        recipe: {
          id: 'community-rec-001',
          workflowName: 'Community form fill',
          siteDomain: 'localhost',
          confidence: 0.9,
          validationCount: 10,
          status: 'PROMOTED',
          trainedBy: 'other-user-999',
          startUrl: 'http://localhost:3099/harness/form-page.html',
          steps: [
            { stepNumber: 1, action: { type: 'click', selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }], description: 'Click name field' } },
            { stepNumber: 2, action: { type: 'type', selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }], inputType: 'variable', variableName: 'userName', description: 'Type name' } },
          ],
          variables: [{ name: 'userName', description: 'Name' }],
        },
        variables: { userName: 'CommunityUser' },
      },
    });

    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(2);

    await expect(formPage.locator('#first-name')).toHaveValue('CommunityUser');

    await formPage.close();
  });

  test('recipes chain across two sub-tasks (search + compose)', async ({ context }) => {
    const sw = await getServiceWorker(context);
    expect(sw, 'Service worker should be running').toBeTruthy();

    const formPage = await context.newPage();
    await formPage.goto(`${MOCK_BASE}/harness/form-page.html`);
    await formPage.waitForLoadState('domcontentloaded');

    const token = generateTestToken();

    // Verify the chain plan endpoint returns a multi-step plan
    const chainPlan = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch('http://localhost:3099/api/agent/chain/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userRequest: 'search Amazon for a laptop and email it to john@gmail.com' }),
      });
      return res.json();
    }, { token });

    expect(chainPlan.success).toBe(true);
    expect(chainPlan.isChain).toBe(true);
    expect(chainPlan.subTasks.length).toBe(2);
    expect(chainPlan.subTasks[0].domain).toContain('amazon');
    expect(chainPlan.subTasks[0].category).toBe('search');
    expect(chainPlan.subTasks[1].domain).toContain('google');
    expect(chainPlan.subTasks[1].category).toBe('compose');

    // Verify resolve-inputs works for chained sub-tasks
    const resolveResult = await sw.evaluate(async ({ token, subTask }) => {
      const res = await fetch('http://localhost:3099/api/agent/chain/resolve-inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          subTask,
          outputStore: { 1: { product_url: 'https://amazon.com/laptop-123', product_title: 'Test Laptop' } },
        }),
      });
      return res.json();
    }, {
      token,
      subTask: chainPlan.subTasks[1],
    });

    expect(resolveResult.success).toBe(true);
    // product_url from step 1 should flow into step 2
    expect(resolveResult.resolvedInputs.product_url).toBe('https://amazon.com/laptop-123');
    expect(resolveResult.resolvedInputs.recipient).toBe('john@gmail.com');

    await formPage.close();
  });

  test('recipe replays across tabs via switch_tab action', async ({ context }) => {
    const sw = await getServiceWorker(context);
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Open both target pages
    const formPage = await context.newPage();
    await formPage.goto(`${MOCK_BASE}/harness/form-page.html`);
    await formPage.waitForLoadState('domcontentloaded');

    const settingsPage = await context.newPage();
    await settingsPage.goto(`http://127.0.0.1:3099/harness/settings-page.html`);
    await settingsPage.waitForLoadState('domcontentloaded');

    // Bring settings page to front (recipe starts on form page, switches to settings)
    await settingsPage.bringToFront();

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    // Multi-tab recipe: fill form on tab 1, switch to settings tab 2, click Usage
    const result = await sendToBackground(sw, {
      type: 'learning_replay_recipe',
      data: {
        recipe: {
          id: 'cross-tab-001',
          workflowName: 'Form fill then switch to settings',
          siteDomain: 'localhost',
          startUrl: 'http://localhost:3099/harness/form-page.html',
          steps: [
            {
              stepNumber: 1,
              action: {
                type: 'click',
                selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }],
                description: 'Click name field',
              },
            },
            {
              stepNumber: 2,
              action: {
                type: 'type',
                selectors: [{ strategy: 'css-id', value: '#first-name', priority: 1 }],
                inputType: 'variable',
                variableName: 'userName',
                description: 'Type user name',
              },
            },
            {
              stepNumber: 3,
              action: {
                type: 'switch_tab',
                targetDomain: '127.0.0.1',
                targetUrl: 'http://127.0.0.1:3099/harness/settings-page.html',
                description: 'Switch to settings page',
              },
            },
            {
              stepNumber: 4,
              action: {
                type: 'click',
                selectors: [
                  { strategy: 'css', value: '[data-tab="usage"]', priority: 1 },
                  { strategy: 'text-content', value: 'Usage', priority: 2 },
                ],
                description: 'Click Usage tab',
              },
            },
          ],
          variables: [{ name: 'userName', description: 'Name to fill' }],
        },
        variables: { userName: 'CrossTabUser' },
        taskContext: 'Fill form then check usage',
      },
    });

    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(4);
    expect(result.totalSteps).toBe(4);

    // Verify form was filled on tab 1
    await expect(formPage.locator('#first-name')).toHaveValue('CrossTabUser');

    // Verify Usage tab was clicked on tab 2
    await expect(settingsPage.locator('#panel-usage')).toHaveClass(/active/);

    await settingsPage.close();
    await formPage.close();
  });

  test('recipe match endpoint returns own recipe at low score', async ({ context }) => {
    const sw = await getServiceWorker(context);
    expect(sw, 'Service worker should be running').toBeTruthy();

    const page = await context.newPage();
    await page.goto(`${MOCK_BASE}/harness/form-page.html`);
    await page.waitForLoadState('domcontentloaded');

    const token = generateTestToken();
    await sw.evaluate(async (t) => { await chrome.storage.local.set({ token: t }); }, token);

    // Query the recipe match endpoint with the low-score-own trigger
    const matchResult = await sw.evaluate(async (t) => {
      const res = await fetch(
        `http://localhost:3099/api/recipes/match?siteDomain=localhost&task=low-score-own%20recipe%20test`,
        { headers: { Authorization: `Bearer ${t}` } }
      );
      return res.json();
    }, token);

    // The match endpoint should return the recipe (found: true)
    expect(matchResult.success).toBe(true);
    expect(matchResult.found).toBe(true);
    expect(matchResult.recipe).toBeTruthy();
    expect(matchResult.recipe.id).toBe('own-low-score-001');
    expect(matchResult.recipe.trainedBy).toBe('test-user-001');
    expect(matchResult.score).toBe(5); // Very low score — but still returned

    // Now replay this low-score recipe and verify it works
    const replayResult = await sendToBackground(sw, {
      type: 'learning_replay_recipe',
      data: { recipe: matchResult.recipe, variables: { userName: 'OwnRecipeUser' } },
    });

    expect(replayResult).toBeTruthy();
    expect(replayResult.success).toBe(true);
    expect(replayResult.completedSteps).toBe(2);

    await expect(page.locator('#first-name')).toHaveValue('OwnRecipeUser');

    await page.close();
  });
});
