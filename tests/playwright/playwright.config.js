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
    // Basic Auth для test.linkeon.io.
    // httpCredentials НЕ работает когда nginx возвращает 401 без WWW-Authenticate
    // (Playwright ждёт challenge, которого нет). Используем extraHTTPHeaders —
    // он применяется к navigation-запросам из фикстурных страниц, но НЕ к fetch()
    // из скриптов страницы (API-запросы к /webhook/ — безопасно, там Basic Auth
    // в nginx отключён). На проде BASIC_AUTH пустой → пустой объект.
    extraHTTPHeaders: process.env.BASIC_AUTH
      ? (() => {
          const [u, ...r] = process.env.BASIC_AUTH.split(':');
          const encoded = Buffer.from(`${u}:${r.join(':')}`).toString('base64');
          return { Authorization: `Basic ${encoded}` };
        })()
      : {},
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
