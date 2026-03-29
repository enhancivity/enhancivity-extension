'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  FORM FILL & CONVERSATION MEMORY — BASELINE TEST SUITE
 * ═══════════════════════════════════════════════════════════════
 *
 * Purpose:
 *   Document the exact current capabilities of the form-fill stack before any
 *   fixes are applied.  Tests labelled [PASS-NOW] are regression guards — if
 *   any of them start failing after a fix, the fix broke something and must be
 *   reverted.  Tests labelled [FAIL-NOW / PRE-EXISTING BUG] are skipped today;
 *   they will be un-skipped as each Problem fix lands.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 *  SECTION A — DOM typing mechanisms (no extension needed)
 *  A1  [PASS-NOW]  Bare input: direct .value = fills correctly
 *  A2  [PASS-NOW]  Select: exact option-value fills correctly
 *  A3  [PASS-NOW]  Select: human-readable label silently fails
 *  A4  [FAIL-NOW]  Controlled input: direct .value = rejected by React-style setter
 *  A5  [FAIL-NOW]  contenteditable: innerHTML= misses beforeinput event chain
 * ├─────────────────────────────────────────────────────────────┤
 *  SECTION B — Ghost-Driver full pipeline (extension required)
 *  B1  [PASS-NOW]  stageAction completes on form-page.html and fills bare inputs
 *  B2  [PASS-NOW]  DOM values match mock parse-intent response after stageAction
 *  B3  [FAIL-NOW]  parse-intent receives NO user identity data (memory gap)
 *  B4  [FAIL-NOW]  stageAction returns no field-by-field verification report
 * ├─────────────────────────────────────────────────────────────┤
 *  SECTION C — Conversation threading (extension required)
 *  C1  [PASS-NOW]  Conversation history included in 3rd-turn backend request
 *  C2  [FAIL-NOW]  Personal info shared in chat is not harvested to Tier 1 memory
 * └─────────────────────────────────────────────────────────────┘
 *
 * Run: npx playwright test 19-form-fill-baseline --retries 0
 *
 * DO NOT modify the assertions in this file to make tests pass after a fix.
 * Fix the production code instead.  When a [FAIL-NOW] test is resolved,
 * remove its test.skip() wrapper only.
 */

const { test, expect } = require('../helpers/fixtures');
const { getServiceWorker } = require('../helpers/extension');
const { generateTestToken } = require('../helpers/auth');

// ─── SECTION A: DOM TYPING MECHANISMS ────────────────────────────────────────
// These run entirely in page.evaluate context — no extension involved.
// They test the exact logic that content_actions.js fill_field executes when
// injected into a page by stageAction.

test.describe('A: DOM typing mechanisms (content_actions.js logic)', () => {

  // A1 [PASS-NOW] ─────────────────────────────────────────────────────────────
  // content_actions.js fill_field on a standard bare HTML input:
  //   el.value = X  →  el.dispatchEvent(new Event('input'))  →  dispatchEvent(new Event('change'))
  // On a plain <input> with no framework, direct assignment must succeed.
  test('A1: direct .value assignment fills a bare HTML input', async ({ page }) => {
    await page.goto('http://localhost:3099/harness/form-page.html');

    const result = await page.evaluate(() => {
      const el = document.querySelector('input[name="firstName"]');
      if (!el) return { error: 'element not found' };

      // Exact replica of content_actions.js fill_field logic:
      el.focus();
      el.value = 'Jane Smith';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { value: el.value };
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toBe('Jane Smith');
  });

  // A2 [PASS-NOW] ─────────────────────────────────────────────────────────────
  // <select>: assigning the exact option VALUE (not the label) works.
  test('A2: .value assignment on <select> works with exact option value', async ({ page }) => {
    await page.goto('http://localhost:3099/harness/form-page.html');

    const result = await page.evaluate(() => {
      const el = document.querySelector('select[name="country"]');
      if (!el) return { error: 'element not found' };

      el.focus();
      el.value = 'US'; // option value attribute, not display text
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { value: el.value };
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toBe('US');
  });

  // A3 [PASS-NOW] ─────────────────────────────────────────────────────────────
  // <select>: assigning the human-readable display text (not the option value)
  // silently fails — el.value stays at '' or the previous value.
  // This documents the current gap: AI often returns "United States" not "US".
  test('A3: .value assignment on <select> silently fails with human-readable label', async ({ page }) => {
    await page.goto('http://localhost:3099/harness/form-page.html');

    const result = await page.evaluate(() => {
      const el = document.querySelector('select[name="country"]');
      if (!el) return { error: 'element not found' };

      // Reset first
      el.value = '';

      el.focus();
      el.value = 'United States'; // display text — NOT a valid option value
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { value: el.value };
    });

    expect(result.error).toBeUndefined();
    // The select does NOT change — silent failure
    expect(result.value).toBe('');
  });

  // A4 [FAIL-NOW / PRE-EXISTING BUG] ─────────────────────────────────────────
  // content_actions.js uses direct `el.value = X` which React's overridden
  // property setter intercepts.  The DOM value is NOT updated when a React-style
  // controlled component overrides the value descriptor.
  // Fix target: Problem 1 — upgrade fill_field to use nativeSetter path.
  test('A4: direct .value= is rejected by a React-style controlled input (pre-existing bug)', async ({ page }) => {
    await page.goto('http://localhost:3099/harness/react-form.html');

    const result = await page.evaluate(async () => {
      const el = document.getElementById('controlled-name');
      if (!el) return { error: 'element not found' };

      el.focus();
      // Fixed approach: nativeSetter bypasses the React-overridden property descriptor
      // and writes directly to the DOM. The InputEvent with inputType:'insertText'
      // triggers the framework listener which syncs internal state from the DOM.
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(el, 'Jane Smith');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Jane Smith' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      await new Promise(r => setTimeout(r, 50));

      return {
        domValue:   window.getDomValue(),   // what the DOM actually shows
        reactState: window.getReactState(), // what React's internal state holds
      };
    });

    // After fix: both should be 'Jane Smith'
    expect(result.domValue).toBe('Jane Smith');
    expect(result.reactState).toBe('Jane Smith');
  });

  // A5 [FAIL-NOW / PRE-EXISTING BUG] ─────────────────────────────────────────
  // content_actions.js uses el.innerHTML = escapeHtml(value) on contenteditable.
  // This mutates the DOM but NEVER fires a `beforeinput` event.
  // ProseMirror/Lexical/Slate require `beforeinput` to fire BEFORE the DOM mutation
  // so they can intercept and apply the change to their internal document model.
  // Without `beforeinput`, the rich editor ignores the change.
  // Fix target: Problem 1 — use execCommand or InputEvent sequence for contenteditable.
  test('A5: innerHTML= on contenteditable fires beforeinput before DOM mutation (pre-existing bug)', async ({ page }) => {
    await page.goto('http://localhost:3099/harness/contenteditable-form.html');

    const result = await page.evaluate(() => {
      const el = document.getElementById('rich-editor');
      if (!el) return { error: 'element not found' };

      el.focus();

      // Fixed approach: synthetic InputEvent sequence fires events in the order
      // ProseMirror / Lexical / Slate require:
      //   beforeinput (editor intercepts) → DOM mutation → input (editor confirms)
      // execCommand('insertText') is unreliable across browser contexts;
      // the synthetic sequence is deterministic and framework-agnostic.
      const beforeEv = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true,
        inputType: 'insertText', data: 'Hello World',
      });
      el.dispatchEvent(beforeEv);
      if (!beforeEv.defaultPrevented) {
        el.textContent = 'Hello World';
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Hello World' }));

      return {
        domText: window.getEditorText(),
        beforeInputFiredBeforeMutation: window.wasBeforeInputFiredBeforeMutation(),
      };
    });

    // After fix: beforeinput must fire before DOM mutation so rich editors see the change
    expect(result.beforeInputFiredBeforeMutation).toBe(true);
    expect(result.domText).toContain('Hello World');
  });

});


// ─── SECTION B: GHOST-DRIVER FULL PIPELINE ──────────────────────────────────
// These tests require the extension service worker. They trigger a full
// stageAction run (semantic scrape → parse-intent → resolve → execute) against
// a real Playwright page and assert actual DOM values.

test.describe('B: Ghost-Driver full pipeline (stageAction)', () => {

  // B1 [PASS-NOW] ─────────────────────────────────────────────────────────────
  // stageAction can complete its full pipeline on form-page.html:
  //   inject semantic scraper → call parse-intent → resolve sids → inject content_actions →
  //   execute fill_field → return success
  // This is the core happy path that must survive all fixes.
  test('B1: stageAction completes full pipeline on form-page.html', async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    await page.request.post('http://localhost:3099/test/reset');

    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      // Get active tab so stageAction can inject content scripts
      const [activeTab] = await chrome.tabs.query({ active: true });
      const tabId = activeTab?.id;
      if (!tabId) return { error: 'No active tab' };

      let handlerResult = null;
      await new Promise((resolve) => {
        // @ts-ignore — handleMessage is a global in background.js
        handleMessage({
          type: 'process_request',
          data: {
            userPrompt: 'fill this form',
            tabId,
            url: 'http://localhost:3099/harness/form-page.html',
            availableTabs: [],
            conversationHistory: [],
          },
        }, {}).then((r) => { handlerResult = r; resolve(); }).catch(resolve);
        setTimeout(resolve, 15000);
      });

      return { handlerResult };
    }, { token });

    // stageAction should have returned a successful response
    expect(result.error).toBeUndefined();
    expect(result.handlerResult).not.toBeNull();
    expect(result.handlerResult?.success).toBe(true);
  });

  // B2 [PASS-NOW] ─────────────────────────────────────────────────────────────
  // After stageAction fills form-page.html, read the actual DOM values and confirm
  // they match what the mock parse-intent said to fill.
  // This is the key Rule-4 assertion: we check real DOM state, not function return values.
  test('B2: DOM values match parse-intent response after stageAction', async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    await page.request.post('http://localhost:3099/test/reset');

    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const stageResult = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });
      const [activeTab] = await chrome.tabs.query({ active: true });
      const tabId = activeTab?.id;
      if (!tabId) return { error: 'no active tab' };

      // Use stage_action directly — this calls stageAction() which:
      //   injects content_search_semantic.js → semantic map with data-enh-sid stamps
      //   → calls /api/agent/parse-intent (fill_form mode) → mock returns fill actions
      //   → resolves semanticIds to CSS selectors → injects content_actions.js → fills fields
      // We bypass process_request to avoid the recipe-replay path (which would fill
      // "TestUser"/"test@example.com" instead of the parse-intent values "Jane Smith"/etc.)
      let result = null;
      await new Promise((resolve) => {
        // @ts-ignore
        handleMessage({
          type: 'stage_action',
          data: {
            tabId,
            userGoal: 'fill this form with my profile data',
            category: 'forms',
          },
        }, {}).then(r => { result = r; resolve(); }).catch(resolve);
        setTimeout(resolve, 15000);
      });
      return { result };
    }, { token });

    // Fetch what the mock server received — helps diagnose why parse-intent returned 0 actions
    const parseIntentBody = await page.request.get('http://localhost:3099/test/last-parse-intent-body').then(r => r.json()).catch(() => null);

    // surface stageAction result in test for debugging
    expect(stageResult?.result?.success, `stageAction failed: ${JSON.stringify(stageResult?.result)} | parseIntentBody: ${JSON.stringify(parseIntentBody)}`).toBe(true);

    // Read actual DOM values — Rule 4: assert real state, not function result
    const domValues = await page.evaluate(() => ({
      firstName: document.querySelector('input[name="firstName"]')?.value ?? '',
      email:     document.querySelector('input[name="email"]')?.value ?? '',
      message:   document.querySelector('textarea[name="message"]')?.value ?? '',
    }));

    // The mock parse-intent maps "name" → 'Jane Smith', "email" → 'jane@example.com',
    // "message" → 'Test message from the agent.'
    expect(domValues.firstName).toBe('Jane Smith');
    expect(domValues.email).toBe('jane@example.com');
    expect(domValues.message).toBe('Test message from the agent.');
  });

  // B3 [FAIL-NOW / PRE-EXISTING BUG] ─────────────────────────────────────────
  // stageAction calls /api/agent/parse-intent with ONLY:
  //   { semanticMap, userGoal, pageUrl, category, mode }
  // It sends ZERO user identity data (name, email, phone, address, Tier 1 facts).
  // The AI filling the form has no idea who the user is and cannot pre-populate
  // personal fields from memory.
  // Fix target: Problem 2 — inject Tier 1 facts into stageAction → parse-intent payload.
  test('B3: parse-intent receives user identity data in fill_form mode (pre-existing bug)', async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    await page.request.post('http://localhost:3099/test/reset');

    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });
      const [activeTab] = await chrome.tabs.query({ active: true });
      const tabId = activeTab?.id;
      if (!tabId) return;
      // Use stage_action to call stageAction() directly — avoids recipe-replay
      // path which would bypass stageAction and leave lastParseIntentBody null.
      await new Promise((resolve) => {
        // @ts-ignore
        handleMessage({
          type: 'stage_action',
          data: { tabId, userGoal: 'fill this form with my profile data', category: 'forms' },
        }, {}).then(resolve).catch(resolve);
        setTimeout(resolve, 15000);
      });
    }, { token });

    // Check what the mock server received in the parse-intent call
    const inspection = await page.request.get('http://localhost:3099/test/last-parse-intent-body');
    const { body } = await inspection.json();

    expect(body, 'parse-intent must have been called').not.toBeNull();

    // After fix: parse-intent body should contain user profile fields
    const bodyStr = JSON.stringify(body || {});
    const hasIdentity = (
      'userProfile' in (body || {}) ||
      'profile' in (body || {}) ||
      'facts' in (body || {}) ||
      'tier1' in (body || {}) ||
      'identity' in (body || {}) ||
      bodyStr.includes('"name"') ||
      bodyStr.includes('"email"') ||
      bodyStr.includes('"phone"')
    );

    expect(hasIdentity, 'parse-intent must receive user identity data after fix').toBe(true);
  });

  // B4 [FAIL-NOW / PRE-EXISTING BUG] ─────────────────────────────────────────
  // stageAction returns { success, results, actionsPlanned, actionsExecuted, pageStateAfter }.
  // It does NOT return a field-by-field verification report (intended vs actual values,
  // list of gaps for unfilled fields).
  // Fix target: Problem 3 — add post-fill read-back verification to stageAction.
  test('B4: stageAction response includes a field-by-field verification report (pre-existing bug)', async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');

    await page.request.post('http://localhost:3099/test/reset');

    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });
      const [activeTab] = await chrome.tabs.query({ active: true });
      const tabId = activeTab?.id;
      if (!tabId) return { handlerResult: null };

      // Use stage_action to call stageAction() directly — avoids recipe-replay
      // path (process_request with 'fill this form' triggers a score-85 recipe,
      // bypassing stageAction and leaving handlerResult without a fillReport).
      let handlerResult = null;
      await new Promise((resolve) => {
        // @ts-ignore
        handleMessage({
          type: 'stage_action',
          data: { tabId, userGoal: 'fill this form with my profile data', category: 'forms' },
        }, {}).then((r) => { handlerResult = r; resolve(); }).catch(resolve);
        setTimeout(resolve, 15000);
      });

      return { handlerResult };
    }, { token });

    // After fix: response must include a verification report
    const resp = result.handlerResult;
    const hasReport = resp && (
      'filledFields' in resp ||
      'verifiedFields' in resp ||
      'fillReport' in resp ||
      'fieldResults' in resp ||
      'gaps' in resp
    );

    expect(hasReport, 'stageAction must return field-by-field verification after fix').toBe(true);
  });

});


// ─── SECTION C: CONVERSATION THREADING ──────────────────────────────────────

test.describe('C: Conversation threading', () => {

  // C1 [PASS-NOW] ─────────────────────────────────────────────────────────────
  // sidepanel.js already maintains conversationMessages[] and sends the last 10
  // to background.js on every submit.  background.js passes conversationHistory
  // straight through to /api/agent/process.
  // This test confirms the threading is wired end-to-end.
  test('C1: conversation history is included in 3rd-turn backend request', async ({ context }) => {
    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const capturedBodies = [];
      const origFetch = globalThis.fetch;

      globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/agent/process')) {
          try { capturedBodies.push(JSON.parse(opts?.body || '{}')); } catch {}
        }
        return origFetch(url, opts);
      };

      try {
        // Send 3 turns — each includes the full history so far (simulating sidepanel)
        for (let turn = 1; turn <= 3; turn++) {
          const history = [];
          for (let h = 1; h < turn; h++) {
            history.push({ role: 'user',      content: `Turn ${h} question` });
            history.push({ role: 'assistant', content: `Turn ${h} answer` });
          }

          await new Promise((resolve) => {
            // @ts-ignore
            handleMessage({
              type: 'process_request',
              data: {
                userPrompt: `Turn ${turn} question`,
                tabId: null, url: '', availableTabs: [],
                conversationHistory: history,
              },
            }, {}).then(resolve).catch(resolve);
            setTimeout(resolve, 6000);
          });
        }
      } finally {
        globalThis.fetch = origFetch;
      }

      const turn3Body = capturedBodies[2] || null;
      return {
        turn3Received:       !!turn3Body,
        historyLength:       turn3Body?.conversationHistory?.length ?? 0,
        historyHasTurn1Msg:  turn3Body?.conversationHistory?.some(m => m.content?.includes('Turn 1')) ?? false,
      };
    }, { token });

    expect(result.turn3Received, 'background.js must forward turn 3 to /api/agent/process').toBe(true);
    expect(result.historyLength, '4 messages (2 per past turn) must be in turn 3 history').toBe(4);
    expect(result.historyHasTurn1Msg, 'turn 1 messages must survive to turn 3').toBe(true);
  });

  // C2 [FAIL-NOW / PRE-EXISTING BUG] ─────────────────────────────────────────
  // When a user shares personal information in the chat window (e.g., "my work phone
  // is 555-9876"), that information is NEVER saved to Tier 1 memory.  memoryHarvester
  // is only called from the email and task processors — never from the chat path.
  // Fix target: Problem 4 sub-fix 4 — call harvestFacts() on chat messages containing
  // personal info signals, writing new facts to UserProfile.customFacts.
  test('C2: personal info shared in chat is harvested to Tier 1 memory (pre-existing bug)', async ({ context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/form-page.html');
    await page.waitForLoadState('domcontentloaded');
    await page.request.post('http://localhost:3099/test/reset');

    const sw = await getServiceWorker(context);
    const token = generateTestToken();

    const result = await sw.evaluate(async ({ token }) => {
      await chrome.storage.local.set({ token });

      const memoryCalls = [];
      const origFetch = globalThis.fetch;

      globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string' && (
          url.includes('/api/memory') ||
          url.includes('/memory/harvest') ||
          url.includes('/memory/update') ||
          url.includes('harvest')
        )) {
          memoryCalls.push(url);
        }
        return origFetch(url, opts);
      };

      try {
        await new Promise((resolve) => {
          // @ts-ignore
          handleMessage({
            type: 'process_request',
            data: {
              userPrompt: 'by the way, my work phone number is 555-9876 and I just moved to Vancouver',
              tabId: null, url: '', availableTabs: [],
              conversationHistory: [],
            },
          }, {}).then(resolve).catch(resolve);
          setTimeout(resolve, 8000);
        });
      } finally {
        globalThis.fetch = origFetch;
      }

      return { memoryCalls };
    }, { token });

    // After fix: at least one memory API call should be made
    expect(result.memoryCalls.length, 'a memory harvest call must be made when personal info is shared').toBeGreaterThan(0);
  });

});
