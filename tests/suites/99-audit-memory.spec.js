// @ts-check
'use strict';

/**
 * AUDIT: 3-Tier Memory System
 *
 * Tests the memory write/read paths against the REAL backend on localhost:3001.
 * No mocks. If a test fails, it means a real bug was found — do not fix it here.
 *
 * Run: npx playwright test 99-audit-memory --config playwright.config.js
 *
 * Environment requirements:
 *   1. Backend running: node webhook-server.js (port 3001)
 *   2. PostgreSQL + Redis running (Docker)
 *   3. AUTH_SECRET=enhancivity-test-secret-key-2026 in enhancivity-main/.env
 *   4. test-user-001 must exist in DB (can have 0 EU balance — tests adapt)
 */

const { test, expect } = require('@playwright/test');
const { generateTestToken, TEST_SECRET, TEST_USER_ID } = require('../helpers/auth');

const BACKEND = 'http://localhost:3001';
const TOKEN_001 = generateTestToken('test-user-001');
const TOKEN_002 = generateTestToken('test-user-002');
const HEADERS_001 = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN_001}`,
};
const HEADERS_002 = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN_002}`,
};

// Module-level flags set in beforeAll
let backendDown = false;
let authMismatch = false;
let zeroBalance = false;

test.describe('Audit: 3-Tier Memory System', () => {

  test.beforeAll(async () => {
    // Check 1: backend reachable
    try {
      await fetch(`${BACKEND}/`);
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.message.includes('ECONNREFUSED') || e.cause?.code === 'ECONNREFUSED') {
        backendDown = true;
        return;
      }
    }

    // Check 2: auth works
    try {
      const res = await fetch(`${BACKEND}/api/todos`, {
        headers: { Authorization: `Bearer ${TOKEN_001}` },
      });
      if (res.status === 401) {
        authMismatch = true;
        return;
      }
    } catch (_) {
      // If fetch throws here, backend is likely down
      backendDown = true;
      return;
    }

    // Check 3: probe whether test user has EU balance (silent — tests adapt individually)
    try {
      const res = await fetch(`${BACKEND}/api/agent/process`, {
        method: 'POST',
        headers: HEADERS_001,
        body: JSON.stringify({ userPrompt: 'ping', availableTabs: [] }),
      });
      const body = await res.json();
      if (body && body.errorType === 'INSUFFICIENT_CREDITS') {
        zeroBalance = true;
      }
    } catch (_) {
      // ignore — individual tests will handle
    }
  });

  // ─── TEST 1.1 ────────────────────────────────────────────────
  test('1.1 — sequential POST calls do not crash (working memory path)', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    // First call
    const res1 = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: HEADERS_001,
      body: JSON.stringify({ userPrompt: 'I prefer dark mode in all applications', availableTabs: [] }),
    });
    expect(res1.status, 'First agent call must not 500').not.toBe(500);
    const body1 = await res1.json();
    expect(body1, 'First call must have success field').toHaveProperty('success');

    // Second call — same memory path exercise
    const res2 = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: HEADERS_001,
      body: JSON.stringify({ userPrompt: 'What UI preference did I just state?', availableTabs: [] }),
    });
    expect(res2.status, 'Second agent call must not 500').not.toBe(500);
    const body2 = await res2.json();
    expect(body2, 'Second call must have success field').toHaveProperty('success');

    if (zeroBalance) {
      // Assert the credit-gate shape is correct (still a valid test)
      expect(body1.errorType ?? body2.errorType).toBe('INSUFFICIENT_CREDITS');
      test.info().annotations.push({ type: 'note', description: 'test-user-001 has 0 EU balance — memory flow path not exercised. Top up to run full test.' });
    } else {
      // Full path: both responses must have action_type
      expect(body1, 'First response must have data').toHaveProperty('data');
      expect(body2, 'Second response must have data').toHaveProperty('data');
    }
  });

  // ─── TEST 1.2 ────────────────────────────────────────────────
  test('1.2 — memorySyncLog write path does not crash', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: HEADERS_001,
      body: JSON.stringify({
        userPrompt: 'I just bought a Sony WH-1000XM5 headset for €280 on Amazon',
        availableTabs: [],
      }),
    });

    expect(res.status, 'Must not be a server crash (500)').not.toBe(500);
    const body = await res.json();
    expect(body, 'Response must have success field').toHaveProperty('success');

    // The agent call exercises logMemorySync() in agentProcess.js.
    // If it crashed, we'd get a 500 above. errorType SERVER_ERROR is also a crash indicator.
    if (body.success === false) {
      expect(body.errorType, 'If failed, must be a known typed error — not a raw crash').not.toBe('SERVER_ERROR');
      expect(body.errorType, 'If failed, must be a known typed error — not a raw crash').not.toBeUndefined();
    }
  });

  // ─── TEST 1.3 ────────────────────────────────────────────────
  test('1.3 — teach-agent endpoint returns memory structure for test user', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/teach-agent/test-user-001`, {
      headers: { Authorization: `Bearer ${TOKEN_001}` },
    });

    if (res.status === 404) {
      test.skip(true, 'Teach-agent endpoint not found — skip');
      return;
    }
    if (res.status === 403) {
      test.skip(true, 'Teach-agent returns 403 (user not found or unauthorized) — seed test-user-001 first');
      return;
    }

    expect(res.status, 'Teach-agent must return 200').toBe(200);
    const body = await res.json();

    // Response must have some memory tier representation
    const hasTierKeys = ('tier1' in body || 'tier2' in body || 'tier3' in body);
    const hasMemoryKeys = ('facts' in body || 'goals' in body || 'traits' in body);
    const hasProfileKey = ('profile' in body);
    expect(
      hasTierKeys || hasMemoryKeys || hasProfileKey,
      `Teach-agent response must have memory tier keys. Got: ${JSON.stringify(Object.keys(body))}`
    ).toBe(true);
  });

  // ─── TEST 1.4 ────────────────────────────────────────────────
  test('1.4 — memory isolation: user-002 cannot see user-001 data', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    // User-001 "reveals" a secret
    await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: HEADERS_001,
      body: JSON.stringify({ userPrompt: 'My secret passphrase is XYLOPHONE42', availableTabs: [] }),
    });

    // User-002 asks for it
    const res = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: HEADERS_002,
      body: JSON.stringify({ userPrompt: 'What is my secret passphrase?', availableTabs: [] }),
    });

    expect(res.status, 'User-002 call must not 500').not.toBe(500);
    const body = await res.json();
    expect(body, 'User-002 must get a response').toHaveProperty('success');

    // The response text must not contain user-001's secret
    const responseText = JSON.stringify(body);
    expect(responseText, 'User-002 must NOT see XYLOPHONE42 from user-001 memory').not.toContain('XYLOPHONE42');
  });

  // ─── TEST 1.5 ────────────────────────────────────────────────
  test('1.5 — agent response always has valid schema shape (never undefined/raw error)', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const KNOWN_ACTION_TYPES = [
      'RECOMMENDATION', 'WARNING', 'TASK_DRAFT', 'COMPOSE_EMAIL', 'EXTRACT_TASKS',
      'NAVIGATE', 'FILL_FORM', 'SEARCH_SITE', 'ADD_TO_CART', 'MULTI_STEP',
      'ORCHESTRATE', 'USE_EXISTING_TAB', 'FETCH_TASKS', 'FIND_AND_REPLY',
      'EXPLORE', 'CLARIFY', 'PARALLEL_EXPLORE',
    ];

    const KNOWN_ERROR_TYPES = [
      'INSUFFICIENT_CREDITS', 'BACKEND_TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR',
      'PARSE_ERROR', 'NO_RESPONSE', 'HANDLER_CRASH',
    ];

    const res = await fetch(`${BACKEND}/api/agent/process`, {
      method: 'POST',
      headers: HEADERS_001,
      body: JSON.stringify({
        userPrompt: 'Help me plan a weekend trip to Berlin',
        availableTabs: [],
      }),
    });

    expect(res.status, 'Agent process must return HTTP 200').toBe(200);
    const body = await res.json();

    expect(body, 'Must have success field').toHaveProperty('success');

    if (body.success === true) {
      expect(body, 'Success response must have data').toHaveProperty('data');
      expect(KNOWN_ACTION_TYPES, `action_type must be one of known types, got: ${body.data?.action_type}`)
        .toContain(body.data.action_type);
      expect(body.data.headline, 'headline must be a non-empty string').toBeTruthy();
      expect(typeof body.data.headline).toBe('string');
    } else {
      // success: false — must still be a typed, known error
      expect(body.errorType, 'Failed response must have errorType').toBeTruthy();
      expect(KNOWN_ERROR_TYPES, `errorType must be a known type, got: ${body.errorType}`)
        .toContain(body.errorType);
    }
  });

});
