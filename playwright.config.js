const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests/suites',
  timeout: 60_000,
  retries: 1,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    headless: false,
    channel: 'chromium',
    launchOptions: {
      args: [
        `--disable-extensions-except=${path.resolve(__dirname)}`,
        `--load-extension=${path.resolve(__dirname)}`,
        '--no-first-run',
        '--disable-popup-blocking',
        '--disable-component-extensions-with-background-pages',
      ],
    },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: {
    command: 'node tests/mock-server/index.js',
    port: 3099,
    reuseExistingServer: true,
    timeout: 10_000,
  },

  globalSetup: './tests/helpers/global-setup.js',
  globalTeardown: './tests/helpers/global-teardown.js',
});
