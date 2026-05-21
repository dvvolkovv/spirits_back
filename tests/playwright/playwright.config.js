// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,        // smoke is sequential, cleaner output
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://my.linkeon.io',
    // Basic Auth для test.linkeon.io. На проде BASIC_AUTH пустой → undefined → ничего не меняется.
    httpCredentials: process.env.BASIC_AUTH
      ? (() => {
          const [username, ...rest] = process.env.BASIC_AUTH.split(':');
          return { username, password: rest.join(':') };
        })()
      : undefined,
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
