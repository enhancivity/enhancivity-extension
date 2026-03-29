'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERACTION ENGINE — PART 2: ELEMENT CLASSIFICATION
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests for classifyElement(), detectEditor(), and isInsideIframe().
 * Each test injects the engine into a real page with real DOM elements
 * and verifies the classification output.
 *
 * Run: npx playwright test 26-interaction-engine-classify --retries 0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'interaction-engine.js');
const HARNESS_URL = 'http://localhost:3099/harness/interaction-engine-classify.html';

async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  const loaded = await page.evaluate(() => !!window.__enhInteractionEngine);
  if (!loaded) throw new Error('interaction-engine.js failed to inject');
}

// ─── classifyElement: NATIVE INPUTS ─────────────────────────────────────────

test.describe('classifyElement() — native inputs', () => {

  test('plain text input → native_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('plain-text'))
    );
    expect(result).toBe('native_input');
  });

  test('email input → native_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('plain-email'))
    );
    expect(result).toBe('native_input');
  });

  test('textarea → native_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('plain-textarea'))
    );
    expect(result).toBe('native_input');
  });
});

// ─── classifyElement: IGNORE ────────────────────────────────────────────────

test.describe('classifyElement() — ignore', () => {

  test('hidden input → ignore', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('hidden-input'))
    );
    expect(result).toBe('ignore');
  });

  test('readonly input (no date context) → ignore', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('readonly-input'))
    );
    expect(result).toBe('ignore');
  });
});

// ─── classifyElement: DATEPICKER ────────────────────────────────────────────

test.describe('classifyElement() — datepicker', () => {

  test('readonly input inside date-picker wrapper → datepicker', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('readonly-date'))
    );
    expect(result).toBe('datepicker');
  });

  test('native type="date" → datepicker', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('native-date'))
    );
    expect(result).toBe('datepicker');
  });

  test('native type="datetime-local" → datepicker', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('native-datetime'))
    );
    expect(result).toBe('datepicker');
  });

  test('native type="time" → datepicker', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('native-time'))
    );
    expect(result).toBe('datepicker');
  });
});

// ─── classifyElement: CONTENTEDITABLE ───────────────────────────────────────

test.describe('classifyElement() — contenteditable', () => {

  test('generic contenteditable div → contenteditable', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('generic-editable'))
    );
    expect(result).toBe('contenteditable');
  });

  test('ProseMirror contenteditable → contenteditable', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('prosemirror-editor'))
    );
    expect(result).toBe('contenteditable');
  });
});

// ─── classifyElement: DROPDOWNS ─────────────────────────────────────────────

test.describe('classifyElement() — dropdowns', () => {

  test('native <select> → custom_dropdown', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('native-select'))
    );
    expect(result).toBe('custom_dropdown');
  });

  test('div with role=combobox + aria-haspopup → custom_dropdown', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('custom-dropdown'))
    );
    expect(result).toBe('custom_dropdown');
  });
});

// ─── classifyElement: AUTOCOMPLETE ──────────────────────────────────────────

test.describe('classifyElement() — autocomplete', () => {

  test('input with role=combobox + aria-autocomplete=list → autocomplete (not dropdown)', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('autocomplete-aria'))
    );
    expect(result).toBe('autocomplete');
  });

  test('input with data-google-places → autocomplete', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('autocomplete-google'))
    );
    expect(result).toBe('autocomplete');
  });

  test('input inside autocomplete wrapper → autocomplete', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('autocomplete-class'))
    );
    expect(result).toBe('autocomplete');
  });
});

// ─── classifyElement: MASKED INPUTS ─────────────────────────────────────────

test.describe('classifyElement() — masked inputs', () => {

  test('input with data-mask → masked_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('masked-datamask'))
    );
    expect(result).toBe('masked_input');
  });

  test('input with data-inputmask → masked_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('masked-inputmask'))
    );
    expect(result).toBe('masked_input');
  });

  test('tel input with maxlength → masked_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('masked-tel'))
    );
    expect(result).toBe('masked_input');
  });

  test('input inside imask wrapper → masked_input', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('masked-imask'))
    );
    expect(result).toBe('masked_input');
  });
});

// ─── classifyElement: FRAMEWORK CONTROLLED ──────────────────────────────────

test.describe('classifyElement() — framework controlled', () => {

  test('input with React _valueTracker + __reactFiber → framework_controlled', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('react-input'))
    );
    expect(result).toBe('framework_controlled');
  });

  test('input with Vue __vue__ → framework_controlled', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('vue-input'))
    );
    expect(result).toBe('framework_controlled');
  });

  test('input inside ng-version parent → framework_controlled', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.classifyElement(document.getElementById('angular-input'))
    );
    expect(result).toBe('framework_controlled');
  });
});

// ─── detectEditor ───────────────────────────────────────────────────────────

test.describe('detectEditor()', () => {

  test('ProseMirror class → prosemirror', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.detectEditor(document.getElementById('prosemirror-editor'))
    );
    expect(result).toBe('prosemirror');
  });

  test('data-slate-editor → slate', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.detectEditor(document.getElementById('slate-editor'))
    );
    expect(result).toBe('slate');
  });

  test('inside DraftEditor-root → draftjs', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.detectEditor(document.getElementById('draftjs-editor'))
    );
    expect(result).toBe('draftjs');
  });

  test('ql-editor class → quill', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.detectEditor(document.getElementById('quill-editor'))
    );
    expect(result).toBe('quill');
  });

  test('inside data-lexical-editor → lexical', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.detectEditor(document.getElementById('lexical-editor'))
    );
    expect(result).toBe('lexical');
  });

  test('generic contenteditable → generic', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.detectEditor(document.getElementById('generic-editable'))
    );
    expect(result).toBe('generic');
  });
});

// ─── isInsideIframe ─────────────────────────────────────────────────────────

test.describe('isInsideIframe()', () => {

  test('returns false on top-level page', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);
    const result = await page.evaluate(() =>
      window.__enhInteractionEngine.isInsideIframe()
    );
    expect(result).toBe(false);
  });
});
