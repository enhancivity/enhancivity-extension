'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERACTION ENGINE — PART 3: INPUT STRATEGIES + VERIFICATION
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests for fillField(), fillFramework(), fillContentEditable(),
 * selectDropdown(), typeHumanLike(), handleDatePicker(),
 * verifyField(), verifyContentEditable(), and fillWithRetry().
 *
 * Each test uses real DOM elements on a fixture page — no mocked DOM.
 *
 * Run: npx playwright test 27-interaction-engine-fill --retries 0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'interaction-engine.js');
const HARNESS_URL = 'http://localhost:3099/harness/interaction-engine-fill.html';

async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  const loaded = await page.evaluate(() => !!window.__enhInteractionEngine);
  if (!loaded) throw new Error('interaction-engine.js failed to inject');
}

// ─── fillNative ─────────────────────────────────────────────────────────────

test.describe('fillNative()', () => {

  test('fills a plain text input and verifies', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-text');
      const fillResult = await fillField(el, 'Hello World');
      return { fillResult, domValue: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.domValue).toBe('Hello World');
  });

  test('fills a textarea', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-textarea');
      const fillResult = await fillField(el, 'Multi\nline\ntext');
      return { fillResult, domValue: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.domValue).toBe('Multi\nline\ntext');
  });
});

// ─── fillFramework (React controlled) ───────────────────────────────────────

test.describe('fillFramework() — React controlled', () => {

  test('fills React controlled input and syncs internal state', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('react-controlled');
      const fillResult = await fillField(el, 'Jane Smith');
      return {
        fillResult,
        domValue: window.getDomValue(),
        reactState: window.getReactState(),
      };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.domValue).toBe('Jane Smith');
    expect(result.reactState).toBe('Jane Smith');
  });

  test('overwrites existing React value', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('react-controlled');

      // Fill once
      await fillField(el, 'First Value');
      // Fill again with different value
      const fillResult = await fillField(el, 'Second Value');

      return {
        fillResult,
        domValue: window.getDomValue(),
        reactState: window.getReactState(),
      };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.domValue).toBe('Second Value');
    expect(result.reactState).toBe('Second Value');
  });
});

// ─── fillContentEditable ────────────────────────────────────────────────────

test.describe('fillContentEditable()', () => {

  test('fills generic contenteditable div', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('generic-editable');
      const fillResult = await fillField(el, 'Hello from the engine');
      const text = (el.textContent || el.innerText || '').trim();
      return { fillResult, text };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.text).toContain('Hello from the engine');
  });

  test('fills ProseMirror contenteditable', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('prosemirror-editable');
      const fillResult = await fillField(el, 'ProseMirror text');
      const text = (el.textContent || el.innerText || '').trim();
      return { fillResult, text };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.text).toContain('ProseMirror text');
  });

  test('fills DraftJS contenteditable (keyboard simulation)', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('draftjs-editable');
      const fillResult = await fillField(el, 'Draft text');
      const text = (el.textContent || el.innerText || '').trim();
      return { fillResult, text };
    });

    // DraftJS uses keyboard simulation — text should appear
    expect(result.fillResult.success).toBe(true);
    expect(result.text).toContain('Draft text');
  });
});

// ─── selectDropdown ─────────────────────────────────────────────────────────

test.describe('selectDropdown()', () => {

  test('selects option in native <select> by display text', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-select');
      const fillResult = await fillField(el, 'United States');
      return { fillResult, value: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.value).toBe('us');
  });

  test('selects option in native <select> by option value', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-select');
      const fillResult = await fillField(el, 'de');
      return { fillResult, value: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.value).toBe('de');
  });

  test('returns failure for non-existent option', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-select');
      return await fillField(el, 'Narnia');
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('option_not_found_in_native_select');
  });

  test('selects option in custom dropdown', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('custom-dropdown-trigger');
      const fillResult = await fillField(el, 'Large');
      const display = document.getElementById('dropdown-display').textContent.trim();
      const selected = el.dataset.selectedValue;
      return { fillResult, display, selected };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.display).toBe('Large');
    expect(result.selected).toBe('l');
  });
});

// ─── handleDatePicker ───────────────────────────────────────────────────────

test.describe('handleDatePicker()', () => {

  test('fills native date input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-date');
      const fillResult = await fillField(el, '2026-03-29');
      return { fillResult, value: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.value).toBe('2026-03-29');
  });

  test('fills native time input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-time');
      const fillResult = await fillField(el, '14:30');
      return { fillResult, value: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    expect(result.value).toBe('14:30');
  });
});

// ─── typeHumanLike (masked input) ───────────────────────────────────────────

test.describe('typeHumanLike() — masked input', () => {

  test('types phone number character by character', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('masked-phone');
      const fillResult = await fillField(el, '5551234567');
      return { fillResult, value: el.value };
    });

    expect(result.fillResult.success).toBe(true);
    // The value should contain the typed digits
    expect(result.value).toContain('555');
  });
});

// ─── fillField dispatcher ───────────────────────────────────────────────────

test.describe('fillField() — dispatcher', () => {

  test('hidden input returns success with skip reason', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillField } = window.__enhInteractionEngine;
      const el = document.getElementById('hidden-field');
      return await fillField(el, 'new value');
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe('hidden_or_readonly_skipped');
  });
});

// ─── verifyField ────────────────────────────────────────────────────────────

test.describe('verifyField()', () => {

  test('returns success when value matches', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { verifyField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-text');
      el.value = 'Test Value';
      return await verifyField(el, 'Test Value');
    });

    expect(result.success).toBe(true);
  });

  test('returns dom_mismatch when value differs', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { verifyField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-text');
      el.value = 'Wrong';
      return await verifyField(el, 'Expected');
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('dom_mismatch');
  });

  test('normalized comparison: formatted phone matches raw', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { verifyField } = window.__enhInteractionEngine;
      const el = document.getElementById('native-text');
      el.value = '(123) 456-7890';
      return await verifyField(el, '1234567890');
    });

    expect(result.success).toBe(true);
  });

  test('detects validation error message near field', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { verifyField } = window.__enhInteractionEngine;
      const el = document.getElementById('email-validated');
      el.value = 'not-an-email';
      // Manually show the error (simulating what blur handler does)
      document.getElementById('email-error').style.display = 'block';
      return await verifyField(el, 'not-an-email');
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('validation_error');
  });
});

// ─── fillWithRetry ──────────────────────────────────────────────────────────

test.describe('fillWithRetry()', () => {

  test('succeeds on first attempt for simple input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { fillWithRetry } = window.__enhInteractionEngine;
      const el = document.getElementById('native-text');
      return await fillWithRetry(el, 'Retry Test');
    });

    expect(result.success).toBe(true);
  });
});

// ─── verifyContentEditable ──────────────────────────────────────────────────

test.describe('verifyContentEditable()', () => {

  test('returns success when text content matches', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { verifyContentEditable } = window.__enhInteractionEngine;
      const el = document.getElementById('generic-editable');
      el.textContent = 'Expected content here';
      return await verifyContentEditable(el, 'Expected content here');
    });

    expect(result.success).toBe(true);
  });

  test('returns failure when text content mismatches', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { verifyContentEditable } = window.__enhInteractionEngine;
      const el = document.getElementById('generic-editable');
      el.textContent = 'Wrong content';
      return await verifyContentEditable(el, 'Completely different text that does not match');
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('contenteditable_mismatch');
  });
});
