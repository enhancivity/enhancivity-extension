'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERACTION ENGINE — PARTS 8-10: EXTRACTION + DATA TRANSFER
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests for extractTable(), extractCards(), toTSV(), findField().
 * Part 9 (chrome.storage persistence) is tested separately in
 * extension context — these tests cover the DOM-level functions.
 *
 * Run: npx playwright test 31-interaction-engine-extract --retries 0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'interaction-engine.js');
const HARNESS_URL = 'http://localhost:3099/harness/interaction-engine-extract.html';

async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  const loaded = await page.evaluate(() => !!window.__enhInteractionEngine);
  if (!loaded) throw new Error('interaction-engine.js failed to inject');
}

// ─── extractTable ───────────────────────────────────────────────────────────

test.describe('extractTable()', () => {

  test('extracts headers and rows from table with thead', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractTable } = window.__enhInteractionEngine;
      return extractTable(document.getElementById('product-table'));
    });

    expect(result.headers).toEqual(['Product', 'Price', 'Stock']);
    expect(result.totalRows).toBe(3);
    expect(result.rows[0]['Product'].text).toBe('Widget');
    expect(result.rows[0]['Price'].text).toBe('$9.99');
    expect(result.rows[0]['Stock'].text).toBe('142');
  });

  test('extracts href from linked cells', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractTable } = window.__enhInteractionEngine;
      return extractTable(document.getElementById('product-table'));
    });

    expect(result.rows[0]['Product'].href).toBe('https://example.com/widget');
    expect(result.rows[1]['Product'].href).toBe('https://example.com/gadget');
    expect(result.rows[2]['Product'].href).toBeNull(); // Doohickey has no link
  });

  test('handles table without thead (first row as headers)', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractTable } = window.__enhInteractionEngine;
      return extractTable(document.getElementById('simple-table'));
    });

    expect(result.headers).toEqual(['Name', 'Age']);
    expect(result.totalRows).toBe(2);
    expect(result.rows[0]['Name'].text).toBe('Alice');
    expect(result.rows[1]['Age'].text).toBe('25');
  });
});

// ─── extractCards ───────────────────────────────────────────────────────────

test.describe('extractCards()', () => {

  test('extracts data from product cards', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractCards } = window.__enhInteractionEngine;
      return extractCards('.product-card', {
        title: '.card-title',
        price: '.card-price',
        link: '.card-link',
      });
    });

    expect(result).toHaveLength(3);
    expect(result[0].title.text).toBe('Wireless Mouse');
    expect(result[0].price.text).toBe('$29.99');
    expect(result[0].link.href).toBe('https://example.com/mouse');
    expect(result[2].title.text).toBe('Monitor Stand');
  });

  test('returns null for missing fields', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractCards } = window.__enhInteractionEngine;
      return extractCards('.product-card', {
        title: '.card-title',
        rating: '.card-rating', // doesn't exist
      });
    });

    expect(result[0].title.text).toBe('Wireless Mouse');
    expect(result[0].rating).toBeNull();
  });

  test('returns empty array for non-matching selector', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractCards } = window.__enhInteractionEngine;
      return extractCards('.nonexistent-card', { title: '.title' });
    });

    expect(result).toHaveLength(0);
  });
});

// ─── toTSV ──────────────────────────────────────────────────────────────────

test.describe('toTSV()', () => {

  test('converts extracted table data to TSV string', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { extractTable, toTSV } = window.__enhInteractionEngine;
      const table = extractTable(document.getElementById('product-table'));
      return toTSV(table.rows, table.headers);
    });

    const lines = result.split('\n');
    expect(lines[0]).toBe('Product\tPrice\tStock');
    expect(lines[1]).toBe('Widget\t$9.99\t142');
    expect(lines[2]).toBe('Gadget\t$24.50\t57');
    expect(lines[3]).toBe('Doohickey\t$3.75\t890');
  });

  test('handles plain string values (not {text, href} objects)', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { toTSV } = window.__enhInteractionEngine;
      const data = [
        { Name: 'Alice', Age: '30' },
        { Name: 'Bob', Age: '25' },
      ];
      return toTSV(data, ['Name', 'Age']);
    });

    const lines = result.split('\n');
    expect(lines[0]).toBe('Name\tAge');
    expect(lines[1]).toBe('Alice\t30');
  });

  test('escapes tabs and newlines in values', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { toTSV } = window.__enhInteractionEngine;
      const data = [{ Note: 'line1\nline2\ttab' }];
      return toTSV(data, ['Note']);
    });

    // Tabs and newlines should be replaced with spaces
    expect(result).toBe('Note\nline1 line2 tab');
  });
});

// ─── findField ──────────────────────────────────────────────────────────────

test.describe('findField()', () => {

  test('finds field by label[for] text', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('Full Name');
      return el ? el.id : null;
    });

    expect(result).toBe('ff-name');
  });

  test('finds field by partial label match', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('Email');
      return el ? el.id : null;
    });

    expect(result).toBe('ff-email');
  });

  test('finds field by aria-label', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('City');
      return el ? el.id : null;
    });

    expect(result).toBe('ff-city');
  });

  test('finds field by placeholder', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('Additional notes');
      return el ? el.id : null;
    });

    expect(result).toBe('ff-notes');
  });

  test('finds field by nearby text (preceding sibling)', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('Phone Number');
      return el ? el.id : null;
    });

    expect(result).toBe('ff-phone');
  });

  test('finds field by name attribute', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('notes');
      return el ? el.id : null;
    });

    expect(result).toBe('ff-notes');
  });

  test('returns null for non-existent field', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findField } = window.__enhInteractionEngine;
      const el = findField('xyzzy_completely_unrelated_99');
      return el === null;
    });

    expect(result).toBe(true);
  });
});
