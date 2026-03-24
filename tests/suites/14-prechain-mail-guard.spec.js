// @ts-check
const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

/**
 * Test: Pre-chain recipe match guard for mail domains.
 *
 * When a multi-site chain prompt arrives and the user is currently on a mail
 * domain (Gmail, Outlook, etc.), the pre-chain recipe match must NOT fire.
 *
 * Without this guard (the bug):
 *   - Pre-chain recipe match fires on mail.google.com
 *   - Gmail compose recipe replays immediately (sub-task 2 runs FIRST)
 *   - Chain then runs sub-task 1 (Google Meet/Calendar) SECOND
 *   - Result: wrong execution order — email before the meeting
 *
 * With this guard (the fix):
 *   - Pre-chain recipe match is skipped entirely for mail domains + multi-site prompts
 *   - Chain handles everything in the correct order (Meet first, Gmail second)
 *
 * Run with: npx playwright test 14-prechain-mail-guard
 */

test.describe('Pre-chain mail domain guard', () => {

  test('recipe match is NOT called when on mail domain + multi-site prompt', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      // Track every fetch URL called during request processing.
      // We patch globalThis.fetch so all fetch() calls in background.js
      // are intercepted — the identifier resolves at call time from global scope.
      const calledUrls = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string') calledUrls.push(url);
        try {
          return await origFetch(url, opts);
        } catch {
          // Return a minimal success response to avoid blocking the code path.
          return new Response(JSON.stringify({ success: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      };

      try {
        // Start the request — do NOT await. We only need to observe which
        // API calls happen in the pre-chain window (first ~2s).
        // Prompt: clearly multi-site (sequential "then" + 2 action verbs).
        // URL: mail.google.com — the LAST sub-task's domain, not the first.
        // @ts-ignore — handleMessage is a global in background.js
        handleMessage({
          type: 'process_request',
          data: {
            userPrompt: 'schedule google meeting then email someone about it',
            tabId: null,
            url: 'https://mail.google.com/mail/u/0',
            availableTabs: [],
            conversationHistory: [],
          },
        }, {}).catch(() => {});

        // Wait for the pre-chain recipe check to execute.
        // It fires right after the memory fetch — well within 2s.
        await new Promise(r => setTimeout(r, 2000));
      } finally {
        globalThis.fetch = origFetch;
      }

      const recipeMatchForGmail = calledUrls.filter(u =>
        typeof u === 'string' &&
        u.includes('/api/recipes/match') &&
        u.includes('mail.google.com')
      );

      return {
        recipeMatchCallCount: recipeMatchForGmail.length,
        // Include all API calls for failure diagnostics
        apiCallsMade: calledUrls.filter(u => typeof u === 'string' && u.includes('/api/')).slice(0, 10),
      };
    }, { token });

    expect(
      result.recipeMatchCallCount,
      `Pre-chain recipe match must NOT fire for mail.google.com when prompt is multi-site.\n` +
      `If > 0, the guard is missing — Gmail compose would execute before Google Meet.\n` +
      `API calls observed: ${JSON.stringify(result.apiCallsMade)}`
    ).toBe(0);
  });

  test('recipe match IS called when on mail domain + single-site prompt (regression guard)', async ({ context }) => {
    // Single-site Gmail prompts ("compose an email to John") must still trigger
    // the pre-chain recipe match so existing Gmail recipes auto-replay.
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const calledUrls = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string') calledUrls.push(url);
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
        // Single-site prompt — isMultiSitePrompt should be false for this.
        // No "then", no sequential language, no second site keyword.
        // @ts-ignore
        handleMessage({
          type: 'process_request',
          data: {
            userPrompt: 'compose an email to John',
            tabId: null,
            url: 'https://mail.google.com/mail/u/0',
            availableTabs: [],
            conversationHistory: [],
          },
        }, {}).catch(() => {});

        await new Promise(r => setTimeout(r, 2000));
      } finally {
        globalThis.fetch = origFetch;
      }

      const recipeMatchForGmail = calledUrls.filter(u =>
        typeof u === 'string' &&
        u.includes('/api/recipes/match') &&
        u.includes('mail.google.com')
      );

      return {
        recipeMatchCallCount: recipeMatchForGmail.length,
        apiCallsMade: calledUrls.filter(u => typeof u === 'string' && u.includes('/api/')).slice(0, 10),
      };
    }, { token });

    expect(
      result.recipeMatchCallCount,
      `Pre-chain recipe match MUST fire for single-site Gmail prompts — existing recipes must auto-replay.\n` +
      `API calls observed: ${JSON.stringify(result.apiCallsMade)}`
    ).toBeGreaterThanOrEqual(1);
  });

});
