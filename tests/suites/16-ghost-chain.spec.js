// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

/**
 * Test: Ghost chain — old chain must be cancelled when a new request arrives.
 *
 * Scenario:
 *   1. User submits chain prompt A (e.g., "schedule google meeting then email").
 *   2. Before prompt A's chain finishes, user submits chain prompt B.
 *   3. Without the fix: both chains execute. Prompt A's sub-tasks still run
 *      AFTER prompt B has started — the user sees the wrong site open first.
 *   4. With the fix: a monotonically-increasing `currentRequestGeneration`
 *      counter is incremented for each new process_request. When the OLD
 *      chain plan finally returns, it checks `thisRequestGeneration ===
 *      currentRequestGeneration`. The mismatch causes the old chain to abort
 *      before executing any sub-tasks.
 *
 * Observable:
 *   POST /api/agent/chain/resolve-inputs is called only when a chain's
 *   sub-task 2 executes (sub-task 2 has a pendingInput that must be
 *   resolved from sub-task 1's output). Without the fix, both chains run
 *   their sub-tasks → 2 resolve-inputs calls. With the fix, only the new
 *   chain runs → exactly 1 resolve-inputs call.
 *
 * Run with: npx playwright test 16-ghost-chain
 */

test.describe('Ghost chain — concurrent request cancellation', () => {

  test('new request cancels in-flight chain before sub-tasks execute', async ({ context }) => {
    // Navigate to the harness page so the active tab is on localhost:3099.
    // The mock chain uses domain='localhost', so chain sub-task navigation
    // sees currentHost='localhost' === targetDomain='localhost' → needsNavigation=false.
    // No external tabs are opened during the test.
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/form.html');
    await page.waitForLoadState('domcontentloaded');

    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const callLog = [];
      const origFetch = globalThis.fetch;

      globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string') callLog.push(url);

        // Delay chain plan responses so request 2 always arrives BEFORE
        // either chain plan returns. This guarantees currentRequestGeneration
        // is already 2 when request 1's plan is processed — the generation
        // guard must fire to cancel the old chain.
        if (typeof url === 'string' && url.includes('/api/agent/chain/plan')) {
          await new Promise(r => setTimeout(r, 400));
        }

        try {
          return await origFetch(url, opts);
        } catch {
          return new Response(JSON.stringify({ success: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      };

      try {
        // ── Request 1: the OLD / ghost chain ──────────────────────────────
        // Fire but do NOT await. It captures thisRequestGeneration=1 and is
        // now waiting for its (delayed) chain plan.
        // @ts-ignore — handleMessage is a global in background.js
        handleMessage({
          type: 'process_request',
          data: {
            userPrompt: 'old chain __ghost_test__ first request',
            tabId: null,
            url: 'http://localhost:3099/harness/form.html',
            availableTabs: [],
            conversationHistory: [],
          },
        }, {}).catch(() => {});

        // Wait 100ms: request 1 has passed its first await and is blocked on
        // the delayed chain/plan fetch. currentRequestGeneration is still 1.
        await new Promise(r => setTimeout(r, 100));

        // ── Request 2: the NEW prompt ─────────────────────────────────────
        // This increments currentRequestGeneration to 2.
        // When request 1's plan eventually returns, the guard checks
        // thisRequestGeneration(1) !== currentRequestGeneration(2) → abort.
        // @ts-ignore
        handleMessage({
          type: 'process_request',
          data: {
            userPrompt: 'new chain __ghost_test__ second request',
            tabId: null,
            url: 'http://localhost:3099/harness/form.html',
            availableTabs: [],
            conversationHistory: [],
          },
        }, {}).catch(() => {});

        // Wait for both requests to settle:
        // plan delay (400ms) + sub-task AI calls + buffer = 3000ms is safe.
        await new Promise(r => setTimeout(r, 3000));
      } finally {
        globalThis.fetch = origFetch;
      }

      const chainPlanCalls = callLog.filter(u => u.includes('/api/agent/chain/plan')).length;
      const resolveInputsCalls = callLog.filter(u => u.includes('/api/agent/chain/resolve-inputs')).length;

      return {
        chainPlanCalls,
        resolveInputsCalls,
        // Include all API calls for failure diagnostics
        allApiCalls: callLog.filter(u => u.includes('/api/')).slice(0, 20),
      };
    }, { token });

    // Precondition: both requests must have tried to fetch a chain plan.
    // If this fails, the mock is not returning isChain:true or the requests
    // never reached the chain check.
    expect(
      result.chainPlanCalls,
      `Expected both requests to fetch a chain plan (got ${result.chainPlanCalls}).\n` +
      `API calls observed: ${JSON.stringify(result.allApiCalls)}`
    ).toBeGreaterThanOrEqual(2);

    // Primary assertion: only ONE chain must have run its sub-tasks.
    // resolve-inputs is called only when a chain sub-task with pendingInputs executes.
    // Without fix: both chains run → count = 2. With fix: count = 1.
    expect(
      result.resolveInputsCalls,
      `Ghost chain guard failed — old chain ran its sub-tasks.\n` +
      `resolve-inputs called ${result.resolveInputsCalls}x (expected exactly 1).\n` +
      `If 2: both chains executed sub-tasks — generation guard is missing.\n` +
      `If 0: neither chain ran sub-tasks — check mock server and chain plan response.\n` +
      `API calls observed: ${JSON.stringify(result.allApiCalls)}`
    ).toBe(1);
  });

});
