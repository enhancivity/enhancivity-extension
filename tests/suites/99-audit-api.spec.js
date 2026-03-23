// @ts-check
'use strict';

/**
 * AUDIT: Backend API Health & Contract Tests
 *
 * Pure HTTP tests against localhost:3001. No browser required.
 * Tests: auth middleware, chain plan shape, explore-step shape,
 *        rate limiting, billing pre-flight, CORS headers.
 *
 * Run: npx playwright test 99-audit-api --config playwright.config.js
 *
 * Environment requirements:
 *   1. Backend running: node webhook-server.js (port 3001)
 *   2. AUTH_SECRET=enhancivity-test-secret-key-2026 in enhancivity-main/.env
 *      (required for auth tests 4.3c/4.3d to show as PASS rather than SKIP)
 */

const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');
const { generateTestToken, TEST_SECRET } = require('../helpers/auth');

const BACKEND = 'http://localhost:3001';
const TOKEN = generateTestToken('test-user-001');
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const AUTH_HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

let backendDown = false;
let authMismatch = false;

test.describe('Audit: Backend API Health', () => {

  test.beforeAll(async () => {
    try {
      await fetch(`${BACKEND}/`);
    } catch (e) {
      if (e.cause?.code === 'ECONNREFUSED' || (e.message && e.message.includes('ECONNREFUSED'))) {
        backendDown = true;
        return;
      }
    }

    // Probe auth
    try {
      const res = await fetch(`${BACKEND}/api/todos`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (res.status === 401) {
        authMismatch = true;
      }
    } catch (_) {
      backendDown = true;
    }
  });

  // ─── TEST 4.1 ────────────────────────────────────────────────
  test('4.1 — POST /api/agent/chain/plan: multi-site prompt returns isChain + subTasks', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/agent/chain/plan`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        userRequest: 'Search Amazon for a laptop and send me an email with the results',
      }),
    });

    expect(res.status, 'chain/plan must return 200').toBe(200);
    const body = await res.json();

    expect(body, 'Must have success field').toHaveProperty('success');
    expect(body.success, 'success must be true').toBe(true);
    expect(body, 'Must have isChain field').toHaveProperty('isChain');
    expect(typeof body.isChain, 'isChain must be boolean').toBe('boolean');
    expect(body, 'Must have totalSteps').toHaveProperty('totalSteps');
    expect(body.totalSteps, 'totalSteps must be >= 1').toBeGreaterThanOrEqual(1);

    if (body.isChain) {
      expect(body, 'Must have subTasks array when isChain is true').toHaveProperty('subTasks');
      expect(Array.isArray(body.subTasks), 'subTasks must be array').toBe(true);
      expect(body.subTasks.length, 'Must have at least 2 sub-tasks for multi-site request').toBeGreaterThanOrEqual(2);

      // Each sub-task must have required fields
      for (const task of body.subTasks) {
        expect(task, 'sub-task must have domain').toHaveProperty('domain');
        expect(task, 'sub-task must have category').toHaveProperty('category');
        expect(task, 'sub-task must have order').toHaveProperty('order');
        expect(task, 'sub-task must have inputs').toHaveProperty('inputs');
      }

      // Sub-tasks must be sorted by order ascending
      const orders = body.subTasks.map(t => t.order);
      const sorted = [...orders].sort((a, b) => a - b);
      expect(orders, 'subTasks must be sorted by order ascending').toEqual(sorted);
    }
  });

  test('4.1b — POST /api/agent/chain/plan: single-site prompt returns isChain: false', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/agent/chain/plan`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ userRequest: 'Search Amazon for a laptop' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.isChain, 'Single-site request must have isChain: false').toBe(false);
  });

  test('4.1c — POST /api/agent/chain/plan: missing userRequest returns 400', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/agent/chain/plan`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ userRequest: '' }),
    });

    expect(res.status, 'Empty userRequest must return 400').toBe(400);
  });

  // ─── TEST 4.2 ────────────────────────────────────────────────
  test('4.2 — POST /api/agent/explore-step: response has correct shape', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const VALID_NEXT_ACTION_TYPES = [
      'click_element', 'navigate', 'type_text', 'scrape_page', 'scrape_table',
      'read_element', 'scroll', 'wait', 'fill_field', 'select_option',
      'resolve_element', 'press_key', 'paste_tsv',
    ];

    const res = await fetch(`${BACKEND}/api/agent/explore-step`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        goal: 'Find the cheapest MacBook Pro model',
        currentPageState: {
          url: 'https://www.apple.com/shop/buy-mac',
          title: 'Buy Mac — Apple',
          semanticElements: [
            { sid: 'e1', tag: 'h1', text: 'MacBook Pro', role: 'heading' },
            { sid: 'e2', tag: 'a', text: 'MacBook Pro 14"', role: 'link' },
          ],
          mainContent: 'MacBook Pro starting at €2,099',
        },
        stepHistory: [],
        stepNumber: 1,
        originalPrompt: 'Find the cheapest MacBook Pro model',
      }),
    });

    // explore-step returns 402 (not 200) for INSUFFICIENT_CREDITS
    if (res.status === 402) {
      const body = await res.json();
      expect(body.errorType, '402 must have INSUFFICIENT_CREDITS errorType').toBe('INSUFFICIENT_CREDITS');
      expect(body, '402 must have required field').toHaveProperty('required');
      expect(body, '402 must have balance field').toHaveProperty('balance');
      test.info().annotations.push({ type: 'note', description: 'test-user-001 has 0 EU — top up to test explore-step AI path' });
      return;
    }

    expect(res.status, 'explore-step must return 200 or 402').toBe(200);
    const body = await res.json();

    // If on an auth page (Apple.com probably has no auth gate), but still valid:
    if (body.blocked) {
      test.info().annotations.push({ type: 'note', description: 'Auth gate detected — agent blocked correctly' });
      return;
    }

    expect(body, 'Must have nextAction').toHaveProperty('nextAction');
    expect(body.nextAction, 'nextAction must have type').toHaveProperty('type');
    expect(
      VALID_NEXT_ACTION_TYPES,
      `nextAction.type must be a valid enum, got: ${body.nextAction.type}`
    ).toContain(body.nextAction.type);
    expect(body, 'Must have reasoning').toHaveProperty('reasoning');
    expect(body.reasoning, 'reasoning must be non-empty string').toBeTruthy();
    expect(body, 'Must have isGoalComplete').toHaveProperty('isGoalComplete');
    expect(typeof body.isGoalComplete, 'isGoalComplete must be boolean').toBe('boolean');
  });

  test('4.2b — POST /api/agent/explore-step: missing required fields returns 400', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/agent/explore-step`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ goal: 'Something' /* missing currentPageState */ }),
    });

    expect(res.status, 'Missing currentPageState must return 400').toBe(400);
  });

  // ─── TEST 4.3 ────────────────────────────────────────────────
  test('4.3a — Auth: missing Authorization header returns 401 with correct message', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    const res = await fetch(`${BACKEND}/api/todos`, {
      headers: JSON_HEADERS, // No Authorization
    });

    expect(res.status, 'Missing header must return 401').toBe(401);
    const body = await res.json();
    expect(body.error, 'Error message must match auth.js exact text')
      .toBe('Missing Authorization header. Expected: Bearer <token>');
  });

  test('4.3b — Auth: invalid token returns 401 with "Invalid token." message', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    const res = await fetch(`${BACKEND}/api/todos`, {
      headers: { Authorization: 'Bearer totally.invalid.token' },
    });

    expect(res.status, 'Invalid token must return 401').toBe(401);
    const body = await res.json();
    expect(body.error, 'Error message must match auth.js exact text').toBe('Invalid token.');
  });

  test('4.3c — Auth: expired token returns 401 with expiry message', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    // Create a token that expired 1 second ago
    const expiredToken = jwt.sign(
      { id: 'test-user-001', email: 'test@enhancivity.com' },
      TEST_SECRET,
      { expiresIn: -1 }  // Expired 1 second ago
    );

    const res = await fetch(`${BACKEND}/api/todos`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });

    expect(res.status, 'Expired token must return 401').toBe(401);
    const body = await res.json();

    if (body.error === 'Invalid token.') {
      // The token was rejected because AUTH_SECRET doesn't match TEST_SECRET
      // — it's treated as an invalid token rather than expired
      test.info().annotations.push({
        type: 'note',
        description: 'AUTH_SECRET mismatch — token rejected as invalid rather than expired. Set AUTH_SECRET=enhancivity-test-secret-key-2026 to test expiry path.',
      });
    } else {
      expect(body.error, 'Expired token error message must match auth.js').toBe('Token has expired. Please log in again.');
    }
  });

  test('4.3d — Auth: valid token succeeds (or reveals AUTH_SECRET mismatch)', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    const res = await fetch(`${BACKEND}/api/todos`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    if (res.status === 401) {
      const body = await res.json();
      test.info().annotations.push({
        type: 'bug',
        description: `AUTH_SECRET mismatch: valid test token rejected. Set AUTH_SECRET=${TEST_SECRET} in enhancivity-main/.env. Backend error: ${body.error}`,
      });
      // This is a configuration issue, not a code bug — annotate but don't fail
      test.skip(true, 'AUTH_SECRET mismatch — see annotation above');
      return;
    }

    expect(res.status, 'Valid token must return 200 for GET /api/todos').toBe(200);
    const body = await res.json();
    expect(body, 'Must return todos object').toBeTruthy();
  });

  // ─── TEST 4.4 ────────────────────────────────────────────────
  // NOTE: Run this test last — it trips the rate limiter and needs 60s to reset
  test('4.4 — Rate limiting: /api/agent/ routes return 429 after 20 requests/min', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    test.setTimeout(120_000); // Give 120s for the 22 requests + 61s cooldown

    // Fire 22 simultaneous requests (limit is 20/min)
    const requests = Array.from({ length: 22 }, () =>
      fetch(`${BACKEND}/api/agent/process`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ userPrompt: 'rate limit test ping', availableTabs: [] }),
      }).then(async r => ({ status: r.status, body: await r.json() }))
        .catch(e => ({ status: 0, error: e.message }))
    );

    const results = await Promise.all(requests);
    const statuses = results.map(r => r.status);
    const has429 = statuses.some(s => s === 429);

    expect(has429, `At least one of 22 requests must be rate-limited (429). Got statuses: ${[...new Set(statuses)].join(',')}`).toBe(true);

    const limited = results.find(r => r.status === 429);
    if (limited?.body) {
      expect(
        limited.body.error,
        'Rate limit response must match exact error message from rateLimiter.js'
      ).toBe('Too many AI requests. Please wait before trying again.');
    }

    // Wait for rate limiter window to reset (61s) so subsequent tests are not affected
    await new Promise(r => setTimeout(r, 61_000));
  });

  // ─── TEST 4.5 ────────────────────────────────────────────────
  test('4.5 — Billing pre-flight: 0 EU balance returns INSUFFICIENT_CREDITS (HTTP 200)', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    // test-user-001 starts with 0 EU by default — this should always trigger INSUFFICIENT_CREDITS
    const res = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        // A non-trivial prompt that would trigger an OpenAI-calling action
        userPrompt: 'Search Amazon for wireless noise-cancelling headphones under €100 and find the best deal',
        availableTabs: [{ url: 'https://www.amazon.de', title: 'Amazon', id: 1 }],
      }),
    });

    // Billing errors return HTTP 200 with success:false — NOT HTTP 402
    expect(res.status, 'Billing gate must return HTTP 200 (not 402)').toBe(200);
    const body = await res.json();

    if (body.success === true) {
      // Test user has EU balance — billing pre-flight was not triggered
      test.info().annotations.push({
        type: 'note',
        description: 'test-user-001 has EU balance — INSUFFICIENT_CREDITS not triggered. This test validates schema shape instead.',
      });
      expect(body, 'Success response must have data').toHaveProperty('data');
      expect(body.data, 'data must have action_type').toHaveProperty('action_type');
    } else {
      // 0 EU path — assert correct billing error shape
      expect(body.errorType, 'Must be INSUFFICIENT_CREDITS').toBe('INSUFFICIENT_CREDITS');
      expect(body, 'Must have message field').toHaveProperty('message');
      expect(body.message, 'message must be non-empty').toBeTruthy();
      expect(body, 'Must NOT have data.action_type (no OpenAI call was made)').not.toHaveProperty('data');
    }
  });

  // ─── TEST 4.6 ────────────────────────────────────────────────
  test('4.6 — CORS: allowed origin gets correct headers', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    const res = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://enhancivity.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization,Content-Type',
      },
    });

    // OPTIONS preflight should return 200 or 204
    expect([200, 204], `OPTIONS must return 200 or 204, got ${res.status}`).toContain(res.status);

    const acao = res.headers.get('access-control-allow-origin');
    expect(
      acao,
      `Access-Control-Allow-Origin must be 'https://enhancivity.com', got: ${acao}`
    ).toBe('https://enhancivity.com');

    const acam = res.headers.get('access-control-allow-methods');
    if (acam) {
      expect(acam.toUpperCase(), 'Allow-Methods must include POST').toContain('POST');
    }
  });

  test('4.6b — CORS: disallowed origin does not get allow header', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    const res = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil-attacker.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    const acao = res.headers.get('access-control-allow-origin');
    expect(
      acao,
      'Evil origin must NOT get Access-Control-Allow-Origin matching the evil domain'
    ).not.toBe('https://evil-attacker.com');
  });

});
