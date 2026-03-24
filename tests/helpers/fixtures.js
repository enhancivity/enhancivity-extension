'use strict';

/**
 * Custom Playwright fixtures for Chrome extension tests.
 *
 * Overrides the built-in `context` fixture with `launchPersistentContext`,
 * which is required for MV3 service workers to be accessible.
 * Regular browser.newContext() creates OTR contexts where extension
 * service workers never appear.
 */

const { test: base, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

exports.test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-popup-blocking',
        '--disable-component-extensions-with-background-pages',
      ],
    });
    await use(context);
    await context.close();
  },
});

exports.expect = base.expect;
