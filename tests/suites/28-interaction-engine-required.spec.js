'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERACTION ENGINE — PART 5: REQUIRED FIELD DETECTION
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests for getRequiredEmptyFields() — scans a form page for
 * required fields that are still empty before submission.
 *
 * Run: npx playwright test 28-interaction-engine-required --retries 0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'interaction-engine.js');
const HARNESS_URL = 'http://localhost:3099/harness/interaction-engine-required.html';

async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  const loaded = await page.evaluate(() => !!window.__enhInteractionEngine);
  if (!loaded) throw new Error('interaction-engine.js failed to inject');
}

// ─── getRequiredEmptyFields ─────────────────────────────────────────────────

test.describe('getRequiredEmptyFields()', () => {

  test('finds all empty required fields on initial page load', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      const fields = getRequiredEmptyFields();
      return fields.map(f => ({ name: f.name, label: f.label, type: f.type }));
    });

    // Should find: name, email, country, terms, plan (radio), message, phone (aria-required)
    // Should NOT find: optional, hidden, invisible, pre-filled city
    const names = result.map(f => f.name);
    expect(names).toContain('name');
    expect(names).toContain('email');
    expect(names).toContain('country');
    expect(names).toContain('terms');
    expect(names).toContain('plan');
    expect(names).toContain('message');
    expect(names).toContain('phone');

    // Exclusions
    expect(names).not.toContain('nickname');  // not required
    expect(names).not.toContain('token');     // hidden
    expect(names).not.toContain('tracking');  // invisible
    expect(names).not.toContain('city');      // pre-filled
  });

  test('excludes fields that have been filled', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      // Fill some fields
      document.getElementById('req-name').value = 'Jane';
      document.getElementById('req-email').value = 'jane@test.com';

      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      const fields = getRequiredEmptyFields();
      return fields.map(f => f.name);
    });

    expect(result).not.toContain('name');
    expect(result).not.toContain('email');
    // These should still be empty
    expect(result).toContain('country');
    expect(result).toContain('message');
  });

  test('excludes checkbox when checked', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      document.getElementById('req-terms').checked = true;

      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      const fields = getRequiredEmptyFields();
      return fields.map(f => f.name);
    });

    expect(result).not.toContain('terms');
  });

  test('excludes radio group when one option is selected', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      document.querySelector('input[name="plan"][value="pro"]').checked = true;

      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      const fields = getRequiredEmptyFields();
      return fields.map(f => f.name);
    });

    expect(result).not.toContain('plan');
  });

  test('returns empty array when all required fields are filled', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      document.getElementById('req-name').value = 'Jane';
      document.getElementById('req-email').value = 'jane@test.com';
      document.getElementById('req-country').value = 'us';
      document.getElementById('req-terms').checked = true;
      document.querySelector('input[name="plan"][value="free"]').checked = true;
      document.getElementById('req-message').value = 'Hello';
      document.getElementById('req-aria').value = '555-1234';

      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      return getRequiredEmptyFields();
    });

    expect(result).toHaveLength(0);
  });

  test('returns correct labels from label[for], placeholder, aria-label', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      const fields = getRequiredEmptyFields();
      const byName = {};
      fields.forEach(f => { byName[f.name] = f.label; });
      return byName;
    });

    // label[for="req-name"] → "Name *"
    expect(result.name).toBe('Name *');
    // label[for="req-email"] → "Email *"
    expect(result.email).toBe('Email *');
    // label[for="req-aria"] → "Phone *"
    expect(result.phone).toBe('Phone *');
  });

  test('returns classification type for each field', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getRequiredEmptyFields } = window.__enhInteractionEngine;
      const fields = getRequiredEmptyFields();
      const byName = {};
      fields.forEach(f => { byName[f.name] = f.type; });
      return byName;
    });

    expect(result.name).toBe('native_input');
    expect(result.email).toBe('native_input');
    expect(result.country).toBe('custom_dropdown');
    expect(result.message).toBe('native_input');
  });
});
