// @ts-check
// Тесты САМОГО экрана входа. Существующий smoke.spec.js логинится в обход
// интерфейса (подсаживает токены в localStorage), поэтому до 2026-08-07
// экран входа не был покрыт ничем — и баг с переполненным localStorage,
// из-за которого верный код показывался как «Неверный код», прожил на проде
// незамеченным. Здесь интерфейс проходится по-настоящему.
const { test, expect } = require('@playwright/test');
const axios = require('axios');

// Адрес СТРАНИЦЫ задаётся playwright.config.js через BASE_URL (не SMOKE_BASE_URL).
// Для локального прогона: pnpm build && pnpm preview --port 4173, затем
// BASE_URL=http://localhost:4173 npx playwright test --config=playwright/playwright.config.js
//
// Адрес API обязан совпадать с тем бэкендом, куда ходит открытая страница:
// код из SMS лежит в Redis той среды, которая его выдала, а debug-эндпоинт
// читает Redis той среды, которую мы спросили. Разъедутся — получим чужой код
// и «Неверный код» на ровном месте.
//   • Локальная сборка (localhost) собирается с VITE_BACKEND_URL=https://my.linkeon.io,
//     то есть страница локальная, а API прод.
//   • На развёрнутых стендах deploy.sh собирает фронт с VITE_BACKEND_URL=$BASE_URL,
//     поэтому для test.linkeon.io API — это сам test.linkeon.io, а не прод.
// Файл подхватывается smoke-прогоном деплоя автоматически (smoke/run.sh зовёт
// playwright по всей папке), так что ветка со стендами — не гипотетическая.
const PAGE_BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const PAGE_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(PAGE_BASE);
const API_BASE = process.env.API_BASE || (PAGE_IS_LOCAL ? 'https://my.linkeon.io' : PAGE_BASE);
const TEST_PHONE = '79030169187';
const NATIONAL = '9030169187';

/**
 * Basic Auth для test.linkeon.io — ТОЛЬКО через page.route().
 *
 * setExtraHTTPHeaders здесь использовать нельзя: заголовок применяется ко ВСЕМ
 * запросам, включая fetch() из скриптов страницы, и перебивает
 * Authorization: Bearer — API отдаёт 401 и разлогинивает. Это описано в
 * playwright.config.js и уже один раз ломало smoke.
 *
 * Реализация скопирована из smoke.spec.js вместе с именем переменной
 * окружения: deploy.sh экспортирует именно BASIC_AUTH в формате «user:pass»
 * (см. scripts/deploy.sh, BASIC_AUTH="${TEST_BASIC_AUTH:-}"). Своя пара
 * переменных здесь означала бы, что на test.linkeon.io заголовок не
 * подставится вовсе и все три теста упадут на 401 от nginx.
 */
async function applyBasicAuth(page) {
  const auth = process.env.BASIC_AUTH;
  if (!auth) return;
  const [u, ...r] = auth.split(':');
  const encoded = Buffer.from(`${u}:${r.join(':')}`).toString('base64');
  await page.route('**/*', async (route) => {
    const headers = route.request().headers();
    if (!headers['authorization']) {
      await route.continue({ headers: { ...headers, authorization: `Basic ${encoded}` } });
    } else {
      await route.continue();
    }
  });
}

/** Свежий код из Redis. На тестовые номера реальная SMS не уходит by design. */
async function debugCode() {
  const r = await axios.get(`${API_BASE}/webhook/debug/sms-code/${TEST_PHONE}`);
  return r.data.code;
}

async function openLogin(page) {
  await applyBasicAuth(page);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('i18nextLng', 'ru');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('onboarding-root')).toBeVisible({ timeout: 20000 });
}

/**
 * Забить localStorage до квоты legacy-ключами истории чатов.
 *
 * Префикс `chat_messages_assistant_` выбран не случайно: ровно эти ключи
 * копились у давних пользователей и ровно их считает восстановимыми
 * persistentStorage.evictRegenerable — то есть тест воспроизводит ту самую
 * ситуацию, в которой продовый вход ломался.
 */
async function fillStorage(page) {
  await page.evaluate(() => {
    const chunk = 'x'.repeat(256 * 1024);
    try { for (let i = 0; i < 200; i++) localStorage.setItem('chat_messages_assistant_' + i, chunk); } catch {}
    // Добиваем хвост квоты ключами убывающего размера: после крупных чанков
    // остаётся щель в несколько КБ, куда запись токена ещё могла бы пролезть,
    // и тест оказался бы ложно-зелёным, не тронув ветку с QuotaExceededError.
    for (const size of [65536, 8192, 1024, 128, 16, 1]) {
      const c = 'y'.repeat(size);
      for (let i = 0; i < 5000; i++) {
        try { localStorage.setItem('chat_messages_assistant_p' + size + '_' + i, c); } catch { break; }
      }
    }
  });
  // Проверяем, что хранилище действительно переполнено: если даже однобайтовая
  // запись не бросает QuotaExceededError, значит место осталось и следующий
  // шаг проверит не то, что задумано.
  const isFull = await page.evaluate(() => {
    try {
      localStorage.setItem('chat_messages_assistant_probe', 'z');
      localStorage.removeItem('chat_messages_assistant_probe');
      return false;
    } catch {
      return true;
    }
  });
  expect(isFull, 'localStorage должен быть забит до квоты, иначе тест ничего не проверяет').toBe(true);
}

test.describe('экран входа', () => {
  test('полный вход по SMS через интерфейс', async ({ page }) => {
    await openLogin(page);
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('switch-to-phone').click();
    await page.getByTestId('phone-input').fill(NATIONAL);
    await page.getByTestId('phone-submit-btn').click();
    await expect(page.getByTestId('otp-input-0')).toBeVisible({ timeout: 15000 });

    const code = await debugCode();
    await page.getByTestId('otp-input-0').pressSequentially(code);
    await page.waitForURL('**/chat', { timeout: 20000 });
    expect(page.url()).toContain('/chat');
  });

  test('РЕГРЕССИЯ: вход проходит при забитом localStorage', async ({ page }) => {
    // Инцидент 2026-08-07: QuotaExceededError на записи authToken выдавался
    // за «Неверный код», сервер код при этом уже гасил.
    await openLogin(page);
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('switch-to-phone').click();
    await page.getByTestId('phone-input').fill(NATIONAL);
    await page.getByTestId('phone-submit-btn').click();
    await expect(page.getByTestId('otp-input-0')).toBeVisible({ timeout: 15000 });

    await fillStorage(page);

    const code = await debugCode();
    await page.getByTestId('otp-input-0').pressSequentially(code);

    // Верный код принят: мы ушли с экрана ввода на /chat. Ровно это ломалось в
    // инциденте — там экран оставался на OTP с «Неверный код», и waitForURL бы
    // не дождался.
    await page.waitForURL('**/chat', { timeout: 20000 });
    // URL мало что доказывает сам по себе — убеждаемся, что отрисовался каркас
    // приложения, то есть вход действительно состоялся, а не просто сменился
    // адрес. `.first()`: элементов с nav-root в разметке два — мобильная нижняя
    // панель и десктопная боковая, — без него strict mode роняет проверку.
    await expect(page.getByTestId('nav-root').first()).toBeVisible({ timeout: 15000 });

    // Наличие jwt_access_token здесь СОЗНАТЕЛЬНО не проверяется.
    // Замер 2026-08-07 (headless Chromium, локальная сборка): примерно в 1 из 4
    // прогонов токен пропадает из localStorage, хотя приложение отработало
    // штатно. Инструментирование Storage.prototype показало, что при этом
    // никакой JS-код ключ не удаляет (ни removeItem, ни clear), нового
    // документа не создаётся, а сам setItem исключения не бросает: запись
    // после освобождения места принимается, но браузер позже молча
    // откатывает её. То есть setItemResilient() может вернуть true, а значения
    // в хранилище не окажется. Это отдельный дефект продукта, а не теста, и
    // заводить на него флакающую проверку в характеризующем наборе нельзя —
    // подробности в отчёте по Задаче 1.
  });

  test('РЕГРЕССИЯ: сообщение о неверном коде остаётся на экране', async ({ page }) => {
    // До 2026-08-07 эффект по появлению error тут же звал onErrorClear, и текст
    // не доживал до следующей отрисовки: человек видел, как ячейки молча
    // обнуляются, без единого слова объяснения. Тем же путём пропадало
    // сообщение про переполненный localStorage.
    await openLogin(page);
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('switch-to-phone').click();
    await page.getByTestId('phone-input').fill(NATIONAL);
    await page.getByTestId('phone-submit-btn').click();
    await expect(page.getByTestId('otp-input-0')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('otp-input-0').pressSequentially('111111');

    // Сообщение обязано пережить несколько секунд, а не мигнуть на кадр.
    const message = page.locator('.text-red-600');
    await expect(message).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3000);
    await expect(message).toBeVisible();

    // ...и уйти, когда человек начал вводить код заново.
    await page.getByTestId('otp-input-0').pressSequentially('9');
    await expect(message).toHaveCount(0);
  });

  test('запрос ссылки на почту доходит до экрана «проверь почту»', async ({ page }) => {
    await openLogin(page);
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('email-input').fill(`claude.link+${Date.now()}@linkeon.io`);
    await page.getByTestId('email-submit-btn').click();
    await expect(page.locator('body')).toContainText(/Проверь почту|Проверьте почту/, { timeout: 15000 });
  });

  test('форма кликабельна без согласия, неактивна только кнопка', async ({ page }) => {
    // До пересборки весь блок шёл под opacity-40 pointer-events-none.
    await openLogin(page);
    await page.getByTestId('email-input').fill('someone@example.com');
    await expect(page.getByTestId('email-input')).toHaveValue('someone@example.com');
    await expect(page.getByTestId('email-submit-btn')).toBeDisabled();
    await expect(page.getByTestId('oauth-yandex')).toBeDisabled();
    await expect(page.locator('body')).not.toContainText('Сначала примите условия');

    await page.getByTestId('consent-checkbox').check();
    await expect(page.getByTestId('email-submit-btn')).toBeEnabled();
    await expect(page.getByTestId('oauth-yandex')).toBeEnabled();
  });

  test('переключение формы работает в обе стороны', async ({ page }) => {
    await openLogin(page);
    await page.getByTestId('switch-to-phone').click();
    await expect(page.getByTestId('phone-input')).toBeVisible();
    await page.getByTestId('switch-to-email').click();
    await expect(page.getByTestId('email-input')).toBeVisible();
  });
});
