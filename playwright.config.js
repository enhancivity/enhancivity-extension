const { defineConfig } = require('@playwright/test');
const runRealAuditSuite = process.env.PLAYWRIGHT_RUN_REAL_AUDIT === '1';

module.exports = defineConfig({
  testDir: './tests/suites',
  testIgnore: runRealAuditSuite ? [] : ['**/99-audit-agent.spec.js'],
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
