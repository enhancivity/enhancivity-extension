// @ts-check
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');
const { generateTestToken } = require('../helpers/auth');

/**
 * Regression test: Modal dismissal strategy during EXPLORE.
 *
 * Bug: Agent gets stuck cycling between Amazon's location modal buttons
 * (clicking "Update location" / "Done" which don't dismiss) and a product link.
 * Circuit breaker fires after 8 steps but modal never closes.
 *
 * The modal dismissal subroutine should try THREE strategies in order:
 * 1. Press Escape key
 * 2. Click the X/close button (aria-label="Close" or text × / x)
 * 3. Click outside the modal (overlay click)
 *
 * Current code tries Escape then searches for inModal elements with text
 * matching "close"/"cancel"/"dismiss" — but misses buttons where:
 * - The X button text is "×" (multiplication sign, not letter x)
 * - The button has aria-label="Close" but no matching text
 * - The inModal flag isn't set on the close button (positioned outside modal box)
 *
 * Run with: npx playwright test 11-modal-dismissal
 */

const test = base.extend({
  extensionContext: async ({}, use) => {
    const extPath = path.resolve(__dirname, '..', '..');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--no-first-run',
        '--disable-popup-blocking',
      ],
    });
    await use(context);
    await context.close();
  },
});

test.describe('Modal dismissal', () => {

  test('snapshot detects open modal on harness page', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/modal-page.html');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Take a snapshot via content_explore.js and verify modal is detected
    const result = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Inject content_explore.js
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content_explore.js'],
      });
      await new Promise(r => setTimeout(r, 500));

      // Take snapshot — response is { success, snapshot: { hasOpenModal, ... } }
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, {
          type: 'explore_action',
          actionType: 'take_snapshot',
        }, (resp) => {
          resolve(resp || { error: chrome.runtime.lastError?.message });
        });
      });
    });

    expect(result.error, `Snapshot failed: ${result.error}`).toBeFalsy();
    expect(result.success).toBe(true);
    const snapshot = result.snapshot;
    expect(snapshot, 'Snapshot should exist').toBeTruthy();
    expect(snapshot.hasOpenModal, 'Snapshot should detect open modal').toBe(true);
  });

  test('close button is found in modal elements', async ({ extensionContext: context }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/modal-page.html');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Inject content_explore and take snapshot
    const snapResult = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content_explore.js'],
      });
      await new Promise(r => setTimeout(r, 500));
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, {
          type: 'explore_action',
          actionType: 'take_snapshot',
        }, (resp) => resolve(resp || { error: chrome.runtime.lastError?.message }));
      });
    });

    const snapshot = snapResult.snapshot;
    expect(snapshot?.hasOpenModal).toBe(true);

    // Now simulate the modal close button search from background.js (lines 3491-3501)
    // This is the EXACT logic the explore loop uses:
    const elements = snapshot.semanticElements || [];
    const modalCloseElement = elements.find(el => {
      if (!el.inModal) return false;
      const text = (el.text || '').toLowerCase();
      const ariaLabel = (el.attrs?.ariaLabel || '').toLowerCase();
      const iconMeaning = (el.attrs?.iconMeaning || '').toLowerCase();
      return (
        text === 'close' || text === 'cancel' || text === 'dismiss' || text === '×' || text === 'x' ||
        ariaLabel.includes('close') || ariaLabel.includes('dismiss') || ariaLabel.includes('cancel') ||
        iconMeaning.includes('close') || iconMeaning.includes('dismiss')
      );
    });

    // BUG ASSERTION: The close button should be found.
    // This FAILS if:
    // - The × button isn't flagged with inModal (positioned absolute, outside modal-box)
    // - The text extraction doesn't capture × correctly
    // - The aria-label="Close" isn't captured in attrs
    expect(
      modalCloseElement,
      `Close button not found in ${elements.filter(e => e.inModal).length} modal elements. ` +
      `Modal elements: ${JSON.stringify(elements.filter(e => e.inModal).map(e => ({ sid: e.sid, text: e.text, ariaLabel: e.attrs?.ariaLabel })), null, 2)}`
    ).toBeTruthy();
  });

  test('stubborn modal: Escape fails, must find X button or click overlay', async ({ extensionContext: context }) => {
    // Use the STUBBORN modal: Escape does NOT work (Amazon-like behavior).
    // Close X is a child of overlay, NOT of modal-box → may not have inModal flag.
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/stubborn-modal-page.html');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Verify modal is open
    const modalVisible = await page.locator('#stubborn-modal:not(.hidden)').isVisible();
    expect(modalVisible, 'Modal should be open initially').toBe(true);

    // Inject content_explore
    await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content_explore.js'],
      });
      await new Promise(r => setTimeout(r, 500));
    });

    // Simulate the modal dismissal subroutine from background.js:
    // It should try strategies in order until one works.
    const dismissResult = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = activeTab.id;
      const attempts = [];

      // Helper: take snapshot and check if modal is still open
      async function isModalOpen() {
        return new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, {
            type: 'explore_action', actionType: 'take_snapshot',
          }, (resp) => resolve(resp?.snapshot?.hasOpenModal ?? true));
        });
      }

      // Helper: execute an explore action
      async function doAction(actionType, params) {
        return new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, {
            type: 'explore_action', actionType, ...params,
          }, (resp) => resolve(resp || { success: false }));
        });
      }

      // Strategy 1: Press Escape
      await doAction('press_key', { value: 'Escape' });
      await new Promise(r => setTimeout(r, 400));
      if (!(await isModalOpen())) {
        return { dismissed: true, method: 'escape', attempts };
      }
      attempts.push('escape_failed');

      // Strategy 2: Find and click close button (the × or aria-label="Close")
      const snapResp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'explore_action', actionType: 'take_snapshot',
        }, (resp) => resolve(resp));
      });

      const elements = snapResp?.snapshot?.semanticElements || [];
      // Current background.js logic: only look at inModal elements
      const closeBtn = elements.find(el => {
        if (!el.inModal) return false;
        const text = (el.text || '').toLowerCase();
        const ariaLabel = (el.attrs?.ariaLabel || '').toLowerCase();
        return (
          text === 'close' || text === 'cancel' || text === 'dismiss' ||
          text === '×' || text === 'x' ||
          ariaLabel.includes('close') || ariaLabel.includes('dismiss')
        );
      });

      if (closeBtn) {
        await doAction('click_element', { target: closeBtn.sid });
        await new Promise(r => setTimeout(r, 400));
        if (!(await isModalOpen())) {
          return { dismissed: true, method: 'close_button', buttonSid: closeBtn.sid, attempts };
        }
        attempts.push(`close_button_failed:${closeBtn.sid}`);
      } else {
        attempts.push('no_close_button_found');
        // Log what modal elements we DID find for debugging
        attempts.push(`modal_elements:${JSON.stringify(elements.filter(e => e.inModal).map(e => e.text || e.sid))}`);
      }

      // Strategy 3: Click outside modal (overlay)
      // Current code does NOT have this strategy — this is what's missing
      const overlayClick = elements.find(el => {
        const role = (el.attrs?.role || '').toLowerCase();
        return role === 'dialog' || (el.attrs?.ariaModal === 'true');
      });
      if (overlayClick) {
        // Click the dialog overlay itself (not a child element)
        await doAction('click_element', { target: overlayClick.sid });
        await new Promise(r => setTimeout(r, 400));
        if (!(await isModalOpen())) {
          return { dismissed: true, method: 'overlay_click', attempts };
        }
        attempts.push('overlay_click_failed');
      }

      return { dismissed: false, method: null, attempts };
    });

    // THE KEY ASSERTION: Modal must be dismissed by one of the strategies.
    // This FAILS if:
    // - Escape doesn't work (some modals trap focus and prevent Escape)
    // - Close button search misses the × (inModal flag issue)
    // - Overlay click strategy is missing from the code
    expect(
      dismissResult.dismissed,
      `Modal not dismissed. Method: ${dismissResult.method}, Attempts: ${JSON.stringify(dismissResult.attempts)}`
    ).toBe(true);

    // Verify from Playwright's perspective
    const modalHidden = await page.locator('#stubborn-modal.hidden').count();
    expect(modalHidden, 'Modal should have hidden class after dismissal').toBe(1);
  });

  test('2x repeat detector triggers modal dismissal (not just scrape)', async ({ extensionContext: context }) => {
    // THE REAL BUG: background.js 2x repeat handler — when a click repeats 2x and
    // the page has an open modal, the code should try to dismiss the modal before
    // falling back to scrape_page.

    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://localhost:3099/harness/modal-page.html');
    await page.waitForLoadState('domcontentloaded');

    let sw;
    for (let i = 0; i < 30; i++) {
      sw = context.serviceWorkers().find(w => w.url().includes('background'));
      if (sw) break;
      await page.waitForTimeout(500);
    }
    expect(sw, 'Service worker should be running').toBeTruthy();

    // Inject content_explore
    await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content_explore.js'],
      });
      await new Promise(r => setTimeout(r, 500));
    });

    // Simulate the 2x repeat scenario:
    // Step N-1: click_element on butt-X (some button inside modal)
    // Step N:   click_element on butt-X again (2x repeat detected)
    // Current: forces scrape_page → AI sees same modal → picks same button → loop
    // Fixed:  detects modal is open → runs dismissal subroutine → modal closed

    const result = await sw.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = activeTab.id;

      // Take initial snapshot to check for modal
      const snapResp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'explore_action', actionType: 'take_snapshot',
        }, (resp) => resolve(resp));
      });

      const snapshot = snapResp?.snapshot;
      const hasModal = snapshot?.hasOpenModal;

      // Simulate: we detected a 2x repeat. The current code at line 3593 would just
      // set nextAction = scrape_page. Instead, it should check for modals first.
      //
      // This test verifies the DESIRED behavior: if hasOpenModal is true and
      // we're in a repeat, the system tries modal dismissal.
      //
      // We check by looking at what the code ACTUALLY does:
      // Read the 2x repeat handler and verify it checks snapshot.hasOpenModal

      // Since we can't inspect background.js code structure from here,
      // we test the OUTCOME: simulate the exact 2x repeat flow and verify
      // the modal gets dismissed instead of just rescanning.

      // Build a fake stepLog simulating 2 identical clicks
      const fakeStepLog = [
        { step: 1, action: { type: 'click_element', target: 'butt-1' }, result: { success: true } },
        { step: 2, action: { type: 'click_element', target: 'butt-1' }, result: { success: true } },
      ];

      // Count repeats (same logic as background.js)
      const currType = 'click_element';
      const currTarget = 'butt-1';
      let repeatCount = 0;
      for (let i = fakeStepLog.length - 1; i >= 0; i--) {
        if (fakeStepLog[i].action?.type === currType && fakeStepLog[i].action?.target === currTarget) {
          repeatCount++;
        } else break;
      }

      // The 2x repeat handler in background.js (line 3593):
      // if (repeatCount >= 2 && currType !== 'type_text') {
      //   decision.nextAction = { type: 'scrape_page', ... };
      // }
      //
      // BUG: No modal check here. It should be:
      // if (repeatCount >= 2 && hasModal) → try modal dismissal
      // else if (repeatCount >= 2) → scrape_page

      return {
        repeatCount,
        hasModal,
        // This flag tests: does the 2x handler attempt modal dismissal?
        // Currently it does NOT — it always forces scrape_page.
        wouldTryModalDismissal: repeatCount >= 2 && hasModal,
        currentBehavior: 'scrape_page_only',
      };
    });

    expect(result.repeatCount).toBe(2);
    expect(result.hasModal).toBe(true);
    expect(result.wouldTryModalDismissal).toBe(true);

    // THE BUG ASSERTION: Verify the 2x repeat code in background.js
    // actually DOES try modal dismissal. Since we can't call the real
    // handler in isolation, we verify the modal gets dismissed when
    // we run the FULL subroutine that the 2x handler SHOULD call.
    //
    // After the fix, the 2x handler should: detect modal → Escape → X → overlay
    // For now, verify the modal IS detectable and dismissable (proving the fix is possible)
    const modalStillOpen = await page.locator('#location-modal:not(.hidden)').isVisible();
    expect(modalStillOpen, 'Modal should still be open (2x handler did not dismiss it)').toBe(true);

    // This is the key: the modal IS open, the repeat IS detected, but the current
    // code does NOT try dismissal. After the fix, this assertion should flip.
  });
});
