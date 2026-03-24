const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/suites',
  timeout: 60_000,
  retries: 1,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
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
