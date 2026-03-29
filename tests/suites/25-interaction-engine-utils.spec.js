'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERACTION ENGINE — PART 1: UTILITIES
 * ═══════════════════════════════════════════════════════════════
 *
 * Tests for the foundational utility functions that all other
 * parts of the interaction engine depend on.
 *
 * These run entirely in page.evaluate context — no extension needed.
 * The interaction-engine.js script is injected via addScriptTag.
 *
 * Run: npx playwright test 25-interaction-engine-utils --retries 0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', '..', 'interaction-engine.js');
const HARNESS_URL = 'http://localhost:3099/harness/interaction-engine-test.html';

// ─── Helper: inject the engine into the page ────────────────────────────────
async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  // Verify injection
  const loaded = await page.evaluate(() => !!window.__enhInteractionEngine);
  if (!loaded) throw new Error('interaction-engine.js failed to inject');
}

// ─── NORMALIZE ──────────────────────────────────────────────────────────────

test.describe('normalize()', () => {

  test('strips formatting from phone number: (123) 456-7890 → 1234567890', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { normalize } = window.__enhInteractionEngine;
      return {
        formatted: normalize('(123) 456-7890'),
        raw: normalize('1234567890'),
        match: normalize('(123) 456-7890') === normalize('1234567890'),
      };
    });

    expect(result.formatted).toBe('1234567890');
    expect(result.raw).toBe('1234567890');
    expect(result.match).toBe(true);
  });

  test('strips whitespace, dashes, commas, dots', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { normalize } = window.__enhInteractionEngine;
      return {
        price: normalize('$1,234.56'),
        date: normalize('2026-03-29'),
        spaced: normalize('  hello   world  '),
      };
    });

    expect(result.price).toBe('$123456');
    expect(result.date).toBe('20260329');
    expect(result.spaced).toBe('helloworld');
  });

  test('handles null, undefined, empty string', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { normalize } = window.__enhInteractionEngine;
      return {
        nullVal: normalize(null),
        undefinedVal: normalize(undefined),
        empty: normalize(''),
      };
    });

    expect(result.nullVal).toBe('');
    expect(result.undefinedVal).toBe('');
    expect(result.empty).toBe('');
  });

  test('lowercases for case-insensitive comparison', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { normalize } = window.__enhInteractionEngine;
      return normalize('Hello World') === normalize('hello world');
    });

    expect(result).toBe(true);
  });
});

// ─── GET KEY CODE ───────────────────────────────────────────────────────────

test.describe('getKeyCode()', () => {

  test('returns correct codes for letters', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getKeyCode } = window.__enhInteractionEngine;
      return {
        a: getKeyCode('a'),
        Z: getKeyCode('Z'),
      };
    });

    expect(result.a).toEqual({ key: 'a', code: 'KeyA' });
    expect(result.Z).toEqual({ key: 'Z', code: 'KeyZ' });
  });

  test('returns correct codes for digits', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getKeyCode } = window.__enhInteractionEngine;
      return {
        zero: getKeyCode('0'),
        nine: getKeyCode('9'),
      };
    });

    expect(result.zero).toEqual({ key: '0', code: 'Digit0' });
    expect(result.nine).toEqual({ key: '9', code: 'Digit9' });
  });

  test('returns correct codes for common symbols', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getKeyCode } = window.__enhInteractionEngine;
      return {
        at: getKeyCode('@'),
        dot: getKeyCode('.'),
        dash: getKeyCode('-'),
        slash: getKeyCode('/'),
        bang: getKeyCode('!'),
      };
    });

    expect(result.at).toEqual({ key: '@', code: 'Digit2' });
    expect(result.dot).toEqual({ key: '.', code: 'Period' });
    expect(result.dash).toEqual({ key: '-', code: 'Minus' });
    expect(result.slash).toEqual({ key: '/', code: 'Slash' });
    expect(result.bang).toEqual({ key: '!', code: 'Digit1' });
  });

  test('returns correct codes for whitespace and control keys', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getKeyCode } = window.__enhInteractionEngine;
      return {
        space: getKeyCode(' '),
        tab: getKeyCode('\t'),
        enter: getKeyCode('\n'),
        cr: getKeyCode('\r'),
      };
    });

    expect(result.space).toEqual({ key: ' ', code: 'Space' });
    expect(result.tab).toEqual({ key: 'Tab', code: 'Tab' });
    expect(result.enter).toEqual({ key: 'Enter', code: 'Enter' });
    expect(result.cr).toEqual({ key: 'Enter', code: 'Enter' });
  });

  test('returns Unidentified for unknown characters', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { getKeyCode } = window.__enhInteractionEngine;
      return getKeyCode('™');
    });

    expect(result.key).toBe('™');
    expect(result.code).toBe('Unidentified');
  });
});

// ─── FIND BEST MATCH ───────────────────────────────────────────────────────

test.describe('findBestMatch()', () => {

  test('exact match returns immediately', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const items = document.querySelectorAll('#match-list li');
      const match = findBestMatch(items, 'Email Address');
      return match ? match.textContent.trim() : null;
    });

    expect(result).toBe('Email Address');
  });

  test('fuzzy matches "Email" to "Email Address"', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const items = document.querySelectorAll('#match-list li');
      const match = findBestMatch(items, 'Email');
      return match ? match.textContent.trim() : null;
    });

    expect(result).toBe('Email Address');
  });

  test('fuzzy matches "Name" to "Full Name"', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const items = document.querySelectorAll('#match-list li');
      const match = findBestMatch(items, 'Name');
      return match ? match.textContent.trim() : null;
    });

    expect(result).toBe('Full Name');
  });

  test('fuzzy matches "ZIP" to "ZIP / Postal Code"', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const items = document.querySelectorAll('#match-list li');
      const match = findBestMatch(items, 'ZIP');
      return match ? match.textContent.trim() : null;
    });

    expect(result).toBe('ZIP / Postal Code');
  });

  test('returns null for empty options list', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      return findBestMatch([], 'anything');
    });

    expect(result).toBeNull();
  });

  test('returns null for null options', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      return findBestMatch(null, 'anything');
    });

    expect(result).toBeNull();
  });

  test('returns null when no match exceeds threshold', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const items = document.querySelectorAll('#match-list li');
      const match = findBestMatch(items, 'xyzzy_completely_unrelated_text');
      return match;
    });

    expect(result).toBeNull();
  });

  test('matches select options by display text', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const options = document.querySelectorAll('#match-select option');
      const match = findBestMatch(options, 'United States');
      return match ? match.value : null;
    });

    expect(result).toBe('us');
  });

  test('partial word match: "Kingdom" matches "United Kingdom"', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(() => {
      const { findBestMatch } = window.__enhInteractionEngine;
      const options = document.querySelectorAll('#match-select option');
      const match = findBestMatch(options, 'Kingdom');
      return match ? match.textContent.trim() : null;
    });

    expect(result).toBe('United Kingdom');
  });
});

// ─── ENSURE ELEMENT IN VIEW ────────────────────────────────────────────────

test.describe('ensureElementInView()', () => {

  test('scrolls off-screen element into viewport', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { ensureElementInView } = window.__enhInteractionEngine;
      const target = document.getElementById('scroll-target');
      const container = document.getElementById('scroll-container');

      // Verify it starts off-screen (below the fold of its scroll container)
      const beforeRect = target.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const wasBelow = beforeRect.top > containerRect.bottom;

      // Scroll it into view
      const scrollResult = await ensureElementInView(target);

      // Check position after scroll
      const afterRect = target.getBoundingClientRect();
      const isNowVisible = afterRect.top >= 0 && afterRect.bottom <= window.innerHeight;

      return { wasBelow, isNowVisible, success: scrollResult.success };
    });

    expect(result.wasBelow).toBe(true);
    expect(result.isNowVisible).toBe(true);
    expect(result.success).toBe(true);
  });

  test('returns { success: true }', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { ensureElementInView } = window.__enhInteractionEngine;
      const target = document.getElementById('scroll-target');
      return await ensureElementInView(target);
    });

    expect(result).toEqual({ success: true });
  });
});

// ─── SLEEP ──────────────────────────────────────────────────────────────────

test.describe('sleep()', () => {

  test('resolves after specified delay', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    const result = await page.evaluate(async () => {
      const { sleep } = window.__enhInteractionEngine;
      const start = Date.now();
      await sleep(200);
      const elapsed = Date.now() - start;
      return { elapsed };
    });

    // Should be at least 180ms (allowing for timer imprecision)
    expect(result.elapsed).toBeGreaterThanOrEqual(180);
    // And not too much more than 200ms
    expect(result.elapsed).toBeLessThan(500);
  });
});

// ─── LOG ────────────────────────────────────────────────────────────────────

test.describe('log()', () => {

  test('does not throw and prefixes with [InteractionEngine]', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    // Capture console.debug output
    const logs = [];
    page.on('console', msg => {
      if (msg.type() === 'debug') {
        logs.push(msg.text());
      }
    });

    await page.evaluate(() => {
      const { log } = window.__enhInteractionEngine;
      log('testAction', { key: 'value' });
      log('anotherAction', 'simple string');
    });

    // Wait a tick for console messages to propagate
    await page.waitForTimeout(100);

    const engineLogs = logs.filter(l => l.includes('[InteractionEngine]'));
    expect(engineLogs.length).toBeGreaterThanOrEqual(2);
    expect(engineLogs[0]).toContain('testAction');
  });
});

// ─── DOUBLE INJECTION GUARD ────────────────────────────────────────────────

test.describe('double injection guard', () => {

  test('second injection does not overwrite the first', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await injectEngine(page);

    // Add a marker to the current engine instance
    await page.evaluate(() => {
      window.__enhInteractionEngine._testMarker = 'first';
    });

    // Inject again
    await page.addScriptTag({ path: ENGINE_PATH });

    const result = await page.evaluate(() => {
      return window.__enhInteractionEngine._testMarker;
    });

    // The marker should still be 'first' — second injection was no-op
    expect(result).toBe('first');
  });
});
