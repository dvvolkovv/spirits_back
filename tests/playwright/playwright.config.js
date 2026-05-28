// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,        // smoke is sequential, cleaner output
  retries: 2,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://my.linkeon.io',
    // Basic Auth для test.linkeon.io. send:'always' — шлём credentials проактивно,
    // т.к. nginx отвечает 401 без WWW-Authenticate challenge (Playwright без этой опции
    // не ретраит запрос с credentials). На проде BASIC_AUTH пустой → undefined.
    httpCredentials: process.env.BASIC_AUTH
      ? (() => {
          const [username, ...rest] = process.env.BASIC_AUTH.split(':');
          return { username, password: rest.join(':'), send: 'always' };
        })()
      : undefined,
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 45000,
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
