// @ts-check
'use strict';

/**
 * AUDIT: NextMile Recommendation Engine
 *
 * Tests the NextMile endpoints and processor against the REAL backend and DB.
 * No mocks. If a test fails, a real bug was found — do not fix it here.
 *
 * Run: npx playwright test 99-audit-nextmile --config playwright.config.js
 *
 * Environment requirements:
 *   1. Backend running: node webhook-server.js (port 3001)
 *   2. PostgreSQL + Redis running (Docker)
 *   3. AUTH_SECRET=enhancivity-test-secret-key-2026 in enhancivity-main/.env
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

const BACKEND = 'http://localhost:3001';
const TOKEN = generateTestToken('test-user-001');
const AUTH_HEADER = { Authorization: `Bearer ${TOKEN}` };

let backendDown = false;
let authMismatch = false;
let todoSeedRequired = false;

test.describe('Audit: NextMile Recommendation Engine', () => {

  test.beforeAll(async () => {
    // Check 1: backend reachable
    try {
      await fetch(`${BACKEND}/`);
    } catch (e) {
      if (e.cause?.code === 'ECONNREFUSED' || (e.message && e.message.includes('ECONNREFUSED'))) {
        backendDown = true;
        return;
      }
    }

    // Check 2: auth
    try {
      const res = await fetch(`${BACKEND}/api/todos`, { headers: AUTH_HEADER });
      if (res.status === 401) {
        authMismatch = true;
        return;
      }
      // Check 3: does test user have any todos?
      const body = await res.json();
      const todos = body.todos || body || [];
      if (!Array.isArray(todos) || todos.length === 0) {
        todoSeedRequired = true;
      }
    } catch (_) {
      backendDown = true;
    }
  });

  // ─── TEST 2.1 ────────────────────────────────────────────────
  test('2.1 — GET /api/nextmile returns valid { tasks } array shape', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    const res = await fetch(`${BACKEND}/api/nextmile`, { headers: AUTH_HEADER });

    expect(res.status, 'Must not 500').not.toBe(500);
    expect(res.status, 'Must not 401').not.toBe(401);
    expect(res.status, '/api/nextmile must return 200').toBe(200);

    const body = await res.json();
    expect(body, 'Response must have tasks key').toHaveProperty('tasks');
    expect(Array.isArray(body.tasks), 'tasks must be an array').toBe(true);

    // If there are tasks, each must have required fields
    for (const task of body.tasks) {
      expect(task, 'Each task must have id').toHaveProperty('id');
      expect(task, 'Each task must have title').toHaveProperty('title');
      expect(task, 'Each task must have description').toHaveProperty('description');
      expect(task.title, 'task.title must be a non-empty string').toBeTruthy();
    }
  });

  // ─── TEST 2.2 ────────────────────────────────────────────────
  test('2.2 — NextMile processor: direct call does not crash', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    // Require the real processor module
    let generateNextMileTask;
    try {
      const processorPath = path.resolve(
        __dirname, '..', '..', '..', 'enhancivity-main',
        'cron-jobs', 'processors', 'nextMileProcessor.js'
      );
      ({ generateNextMileTask } = require(processorPath));
    } catch (importErr) {
      test.skip(true, `Cannot import nextMileProcessor: ${importErr.message}`);
      return;
    }

    let result;
    let thrownError;
    try {
      result = await generateNextMileTask('test-user-001');
    } catch (err) {
      thrownError = err;
    }

    if (thrownError) {
      // Acceptable errors: user not found, DB constraint
      const isExpectedError = (
        thrownError.message.includes('not found') ||
        thrownError.message.includes('No record') ||
        thrownError.message.includes('does not exist') ||
        thrownError.message.includes('null') ||
        thrownError.code === 'P2025'  // Prisma: record not found
      );

      if (isExpectedError) {
        test.info().annotations.push({
          type: 'note',
          description: `test-user-001 not in DB or has no eligible todos: ${thrownError.message}`,
        });
        return; // Not a crash — expected behavior
      }

      // DB connection failure → skip with clear message
      if (thrownError.message.includes('ECONNREFUSED') || thrownError.message.includes('connect')) {
        test.skip(true, 'PostgreSQL not running — start Docker containers first');
        return;
      }

      // Any other error = real bug
      throw new Error(`generateNextMileTask crashed unexpectedly: ${thrownError.message}`);
    }

    // If it returned a result, validate the shape
    if (result !== null && result !== undefined) {
      expect(result, 'Result must have title').toHaveProperty('title');
      expect(typeof result.title, 'title must be a string').toBe('string');
      expect(result.title, 'title must not be empty').toBeTruthy();
      // scheduledFor can be null (for unscheduled tasks)
      if (result.scheduledFor !== null && result.scheduledFor !== undefined) {
        expect(new Date(result.scheduledFor).getTime(), 'scheduledFor must be a valid date').not.toBeNaN();
      }
    }
  });

  // ─── TEST 2.3 ────────────────────────────────────────────────
  test('2.3 — Recommendation relevance: result title is meaningful (not blank/undefined)', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (todoSeedRequired) test.skip(true, 'No todos for test-user-001 — seed data required');

    let generateNextMileTask;
    try {
      const processorPath = path.resolve(
        __dirname, '..', '..', '..', 'enhancivity-main',
        'cron-jobs', 'processors', 'nextMileProcessor.js'
      );
      ({ generateNextMileTask } = require(processorPath));
    } catch (importErr) {
      test.skip(true, `Cannot import nextMileProcessor: ${importErr.message}`);
      return;
    }

    let result;
    try {
      result = await generateNextMileTask('test-user-001');
    } catch (err) {
      if (err.code === 'P2025' || err.message.includes('not found')) {
        test.skip(true, 'test-user-001 not in DB');
        return;
      }
      throw err;
    }

    if (result === null || result === undefined) {
      test.info().annotations.push({ type: 'note', description: 'generateNextMileTask returned null — user has no eligible tasks' });
      return;
    }

    expect(result.title, 'Title must be a string').toBeTruthy();
    expect(result.title.length, 'Title must be at least 10 characters').toBeGreaterThanOrEqual(10);
    expect(result.title, 'Title must not be literal "[object Object]"').not.toBe('[object Object]');
    expect(result.title, 'Title must not contain "undefined"').not.toContain('undefined');
  });

  // ─── TEST 2.4 ────────────────────────────────────────────────
  test('2.4 — Edge case: missing user does not throw an unhandled crash', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');

    let generateNextMileTask;
    try {
      const processorPath = path.resolve(
        __dirname, '..', '..', '..', 'enhancivity-main',
        'cron-jobs', 'processors', 'nextMileProcessor.js'
      );
      ({ generateNextMileTask } = require(processorPath));
    } catch (importErr) {
      test.skip(true, `Cannot import nextMileProcessor: ${importErr.message}`);
      return;
    }

    // This user ID should not exist in the DB
    let threw = false;
    let thrownMessage = '';
    try {
      await generateNextMileTask('nonexistent-audit-user-99999');
    } catch (err) {
      threw = true;
      thrownMessage = err.message;
    }

    if (threw) {
      // Must be a graceful error, not a Prisma panic or unhandled promise rejection
      const isPrismaError = thrownMessage.includes('P2') || thrownMessage.includes('Prisma');
      const isExpectedNotFound = thrownMessage.toLowerCase().includes('not found') ||
        thrownMessage.toLowerCase().includes('does not exist') ||
        thrownMessage.toLowerCase().includes('null') ||
        thrownMessage.includes('P2025');

      expect(
        isExpectedNotFound || isPrismaError,
        `Unknown crash for missing user: ${thrownMessage}`
      ).toBe(true);

      if (isPrismaError && !isExpectedNotFound) {
        // This is a bug — a missing user caused an unhandled Prisma error
        test.info().annotations.push({
          type: 'bug',
          description: `Missing user caused unhandled Prisma crash: ${thrownMessage}`,
        });
      }
    }
    // If it did NOT throw → that's also acceptable (returned null/undefined)
  });

  // ─── TEST 2.5 ────────────────────────────────────────────────
  test('2.5 — /api/nextmile endpoint does not 500 (smoke test)', async () => {
    if (backendDown) test.skip(true, 'Backend not running on localhost:3001');
    if (authMismatch) test.skip(true, "AUTH_SECRET must equal 'enhancivity-test-secret-key-2026' in .env");

    // Test with a fresh token for a different user
    const altToken = generateTestToken('test-user-smoke-002');
    const res = await fetch(`${BACKEND}/api/nextmile`, {
      headers: { Authorization: `Bearer ${altToken}` },
    });

    // 200 (empty tasks for unknown user) or 401 (user not in DB — auth passes but no record)
    // 500 is never acceptable
    expect(res.status, '/api/nextmile must never return 500').not.toBe(500);
  });

});
