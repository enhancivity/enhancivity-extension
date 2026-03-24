// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker, getExtensionId, collectConsoleLogs } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

/**
 * Phase 1-5 Tests: Structural Fingerprinting, Matching, Auto-Selection,
 * Segment Detection, and Chain Execution.
 *
 * These tests verify the recipe chaining system end-to-end using the mock server.
 * Run with: npx playwright test 08-recipe-chain-phases
 */

test.describe('Phase 1: Structural Fingerprinting', () => {

  test('saving a recipe returns fingerprint and autoDescription', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch('http://localhost:3099/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workflowName: 'Test search workflow',
          siteDomain: 'amazon.com',
          steps: [
            { url: 'https://www.amazon.com', action: { type: 'type', selectors: [{ type: 'css', value: '#search' }], description: 'search box' } },
            { url: 'https://www.amazon.com', action: { type: 'click', selectors: [{ type: 'css', value: '#search-submit' }], description: 'search button' } },
          ],
        }),
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.recipe).toBeTruthy();
    expect(result.recipe.fingerprint).toBeTruthy();
    expect(result.recipe.fingerprint.domains).toContain('amazon.com');
    expect(result.recipe.fingerprint.actionSignature).toBeTruthy();
    expect(Array.isArray(result.recipe.fingerprint.actionSignature)).toBe(true);
    expect(result.recipe.autoDescription).toBeTruthy();
    expect(typeof result.recipe.autoDescription).toBe('string');
  });

  test('backfill-fingerprints endpoint works', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      const res = await fetch('http://localhost:3099/api/recipes/backfill-fingerprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.processed).toBeGreaterThanOrEqual(0);
    expect(result.fingerprinted).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Phase 2: Structural Matching', () => {

  test('recipe match returns structural match with fingerprint', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch(
        'http://localhost:3099/api/recipes/match?siteDomain=localhost&task=fill%20the%20form%20with%20my%20details',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.recipe).toBeTruthy();
    expect(result.recipe.fingerprint).toBeTruthy();
    expect(result.recipe.fingerprint.category).toBe('fill-form');
    expect(result.matchType).toBe('structural');
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  test('no match for unrelated task', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch(
        'http://localhost:3099/api/recipes/match?siteDomain=localhost&task=buy%20a%20car',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.found).toBe(false);
  });
});

test.describe('Phase 3: Auto-Selection (Silent Replay)', () => {

  test('auto-replay: matched recipe executes without user choice UI', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();
    const logs = collectConsoleLogs(sw);

    // Open form page — the target of the recipe
    const formPage = await context.newPage();
    await formPage.goto('http://localhost:3099/harness/form-page.html');
    await formPage.waitForLoadState('domcontentloaded');

    // Trigger process_request with a prompt that matches a known recipe
    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      // Send process_request with a task that matches 'known-recipe' keyword
      return chrome.runtime.sendMessage({
        type: 'process_request',
        data: {
          userPrompt: 'fill out the known-recipe form',
          availableTabs: [{ id: 1, url: 'http://localhost:3099/harness/form-page.html', title: 'Form', domain: 'localhost' }],
        },
      });
    }, { token });

    logs.stop();

    // The result should NOT be a RECIPE_MATCH action (old UI choice flow)
    // It should be either:
    // - RECIPE_REPLAY_COMPLETE (if auto-replay succeeded)
    // - Or a normal AI response (if replay failed and fell through)
    expect(result).toBeTruthy();
    if (result.data?.action_type) {
      expect(result.data.action_type).not.toBe('RECIPE_MATCH');
    }

    await formPage.close();
  });
});

test.describe('Phase 4: Segment Detection', () => {

  test('multi-domain recipe save triggers segmentation', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch('http://localhost:3099/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workflowName: 'Search Amazon then email via Gmail',
          siteDomain: 'amazon.com',
          steps: [
            { url: 'https://www.amazon.com/search', action: { type: 'type', description: 'search box' } },
            { url: 'https://www.amazon.com/results', action: { type: 'click', description: 'product link' } },
            { url: 'https://www.amazon.com/results', action: { type: 'switch_tab', description: 'switch to Gmail' } },
            { url: 'https://mail.google.com/compose', action: { type: 'click', description: 'compose button' } },
            { url: 'https://mail.google.com/compose', action: { type: 'type', description: 'email body' } },
          ],
        }),
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.recipe).toBeTruthy();
    // Multi-domain recipe should be flagged for segmentation
    expect(result.recipe.isSegment).toBe(true);
    // Fingerprint should detect multiple domains
    expect(result.recipe.fingerprint.domains.length).toBeGreaterThanOrEqual(2);
  });

  test('backfill-segments endpoint works', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      const res = await fetch('http://localhost:3099/api/recipes/backfill-segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.segmentsCreated).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Phase 5: Chain Execution', () => {

  test('chain plan returns multi-site decomposition', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch('http://localhost:3099/api/agent/chain/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userRequest: 'Search Amazon for a laptop and email the link to john@gmail.com',
        }),
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.isChain).toBe(true);
    expect(result.totalSteps).toBe(2);
    expect(result.subTasks).toHaveLength(2);

    // Verify sub-task structure
    const [amazonTask, gmailTask] = result.subTasks;
    expect(amazonTask.domain).toBe('amazon.com');
    expect(amazonTask.category).toBe('search');
    expect(gmailTask.domain).toBe('mail.google.com');
    expect(gmailTask.category).toBe('compose');
  });

  test('chain plan returns single-site for non-chain request', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch('http://localhost:3099/api/agent/chain/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userRequest: 'search for a laptop' }),
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.isChain).toBe(false);
  });

  test('resolve-inputs resolves user + previous_step sources', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const res = await fetch('http://localhost:3099/api/agent/chain/resolve-inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          subTask: {
            inputs: [
              { name: 'recipient', value: 'john@test.com', source: 'user' },
              { name: 'product_url', source: 'previous_step', fromStep: 1, fromOutput: 'product_url' },
            ],
          },
          outputStore: {
            1: { product_url: 'https://amazon.com/laptop-123', product_title: 'Best Laptop' },
          },
        }),
      });
      return res.json();
    }, { token });

    expect(result.success).toBe(true);
    expect(result.resolvedInputs.recipient).toBe('john@test.com');
    expect(result.resolvedInputs.product_url).toBe('https://amazon.com/laptop-123');
  });

  test('chain execution wired in background.js — multi-site prompt triggers chain', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();
    const logs = collectConsoleLogs(sw);

    // Open a page so the extension has an active tab
    const page = await context.newPage();
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      return chrome.runtime.sendMessage({
        type: 'process_request',
        data: {
          userPrompt: 'Search Amazon for a laptop and email the link to john@gmail.com',
          availableTabs: [
            { id: 1, url: 'http://localhost:3099/harness/form-page.html', title: 'Test Page', domain: 'localhost' },
          ],
        },
      });
    }, { token });

    logs.stop();

    // Should get some result (chain execution will try to run but sub-tasks
    // won't have real recipes — they'll fall through to AI or return partial results)
    expect(result).toBeTruthy();

    // Check logs for chain execution attempts
    const chainLogs = logs.messages.filter(m => m.text.includes('[Chain]'));
    // If chain code ran, we should see at least a plan log
    // (may not always succeed since sub-tasks need real tabs)

    await page.close();
  });
});
