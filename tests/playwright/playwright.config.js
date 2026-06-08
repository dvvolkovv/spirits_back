// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,        // smoke is sequential, cleaner output
  // 2 retries: browser smoke runs right after a deploy when cold paths
  // (LLM / r.linkeon.io / Neo4j reconnect) can throw a one-off "Failed to
  // fetch". Per-test retry clears those without failing the whole smoke (which
  // would falsely roll back a good deploy). The deploy script adds a second
  // outer retry on top of this for the non-browser layers.
  retries: 2,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://my.linkeon.io',
    // Basic Auth для test.linkeon.io обрабатывается через page.route() в applyBasicAuth().
    // extraHTTPHeaders намеренно убран: он применяется ко ВСЕМ запросам включая fetch() из
    // скриптов страницы, переопределяет Authorization: Bearer → API получает 401 и разлогинивает.
    // page.route() добавляет Basic только если Authorization не установлен — Bearer-запросы не трогает.
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
