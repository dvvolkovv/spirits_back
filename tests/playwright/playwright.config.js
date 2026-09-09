// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Тестовый стенд втрое медленнее прода на одной и той же работе. Замер
// 09.09.2026: 12 аватарок ассистентов параллельно — 10с на my.linkeon.io против
// 34с на test.linkeon.io, при идентичных заголовках, размерах и содержимом.
// Отдаёт их Node-API, а не nginx, поэтому упирается в бэкенд стенда.
//
// Из-за этого браузерный слой падал на test при ЛЮБОМ коде, а deploy.sh печатал
// «real regression, not a flake» и не пускал на прод. 09.09.2026 это трижды
// подряд заблокировало здоровый фронт, и выкат пришлось делать в обход гейта.
//
// Прод остаётся строгим: там 90с — настоящий сигнал, что страница отвечает
// медленно. Поднимаем потолок только для стенда, а не глобально, иначе гейт
// перестанет ловить реальные просадки прода.
const IS_TEST_STAND = /test\.linkeon\.io/.test(process.env.BASE_URL || '');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: IS_TEST_STAND ? 240000 : 90000,
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
    // Язык интерфейса теперь зависит от языка браузера: i18next определяет его
    // как ['localStorage', 'navigator']. Без явной локали Playwright ходит как
    // en-US, и все проверки по русскому тексту падают — что и случилось.
    locale: 'ru-RU',
    headless: true,
    actionTimeout: 15000,
    // Стенду не хватает 45с даже на 'domcontentloaded': бандлы index-*.js и
    // main-*.js там отдаются по 12–16с каждый, а два браузерных контекста
    // конкурируют за один Node-процесс. Прод укладывается с запасом — потолок
    // поднят только для стенда, чтобы гейт по проду остался честным.
    navigationTimeout: IS_TEST_STAND ? 120000 : 45000,
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
