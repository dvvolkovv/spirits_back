// @ts-check
const { test, expect } = require('@playwright/test');
const axios = require('axios');

/**
 * Вход в форму пополнения токенов.
 *
 * 12.08.2026: пользователь с телефона жал «Пополнить» в профиле и попадал на
 * список ассистентов. Причина — модалка пополнения рендерилась внутри
 * ChatInterface, а при отсутствии выбранного ассистента ChatLayout отдаёт весь
 * экран своему сайдбару и прячет колонку с ChatInterface классом
 * `hidden md:flex`. Оверлей оказывался в поддереве с display:none: в DOM есть,
 * position:fixed и z-60 на месте, размер 0×0, на экране ничего. На телефоне
 * ловилось почти всегда, потому что признак выбранного ассистента лежит в
 * sessionStorage — он живёт только в пределах вкладки.
 *
 * Затронуты были ВСЕ входы разом: кнопка в профиле, OfferBanner,
 * SessionPaywallNudge, ссылка из видео и подсказка в /help — все ведут на
 * «/chat?view=tokens».
 *
 * Проверять ВИДИМОСТЬ обязательно: узлы в DOM были и на сломанной версии, так
 * что проверка через count() прошла бы зелёной, ничего не поймав.
 */

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
// API обычно живёт на том же хосте, что и страница, — так и в smoke. Отдельная
// переменная нужна только чтобы гонять эти тесты против локальной сборки
// фронта (vite preview отдаёт статику и никакого /webhook не знает).
const API_BASE = process.env.API_BASE || BASE;
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';

async function getJwt() {
  await axios.get(`${API_BASE}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${TEST_PHONE}`);
  const codeRes = await axios.get(`${API_BASE}/webhook/debug/sms-code/${TEST_PHONE}`);
  const loginRes = await axios.get(
    `${API_BASE}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${TEST_PHONE}/${codeRes.data.code}`,
  );
  return {
    access: loginRes.data['access-token'],
    refresh: loginRes.data['refresh-token'],
  };
}

// Basic Auth для test.linkeon.io — только там, где Authorization ещё не стоит,
// иначе перебьём Bearer у запросов самого приложения.
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

/** Логин через localStorage. withAssistant=false — свежая вкладка без выбранного ассистента. */
async function seed(page, withAssistant) {
  await applyBasicAuth(page);
  const { access, refresh } = await getJwt();
  await page.addInitScript(([a, r, sel]) => {
    localStorage.setItem('i18nextLng', 'ru');
    localStorage.setItem('jwt_access_token', a);
    localStorage.setItem('jwt_refresh_token', r);
    localStorage.setItem('authToken', a);
    localStorage.setItem('userData', JSON.stringify({ phone: '70000000000' }));
    if (sel) sessionStorage.setItem('selected_assistant', sel);
    else sessionStorage.removeItem('selected_assistant');
  }, [access, refresh,
      withAssistant ? JSON.stringify({ id: 10, name: 'Алексей', displayName: 'Алексей' }) : null]);
}

const countOverlays = (page) => page.evaluate(
  () => document.querySelectorAll('.fixed.inset-0.bg-black').length);

const PACKAGE_NAMES = /Базовый|Популярный|Профессиональный|Расширенный/;

test.describe('вход в форму пополнения токенов', () => {
  test('мобильный: профиль → «Пополнить» открывает форму, а не список ассистентов', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seed(page, false);

    await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    const topUp = page.getByText(/пополнить/i).first();
    await expect(topUp).toBeVisible({ timeout: 30000 });
    await topUp.click();

    const pkg = page.getByText(PACKAGE_NAMES).first();
    await expect(pkg, 'карточка тарифа должна быть ВИДИМА, а не просто присутствовать в DOM')
      .toBeVisible({ timeout: 20000 });

    // Центр экрана должен принадлежать оверлею: на сломанной версии там был
    // текст списка ассистентов, потому что модалка имела размер 0×0.
    const inOverlay = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return !!(el && el.closest('.fixed.inset-0'));
    });
    expect(inOverlay, 'центр экрана должен принадлежать модалке, а не списку ассистентов').toBe(true);
  });

  test('десктоп, ассистент выбран: ровно одна модалка, без дубля', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seed(page, true);
    await page.goto(`${BASE}/chat?view=tokens`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(PACKAGE_NAMES).first()).toBeVisible({ timeout: 30000 });
    expect(await countOverlays(page), 'двух модалок сразу быть не должно').toBe(1);
  });

  test('десктоп, ассистент НЕ выбран: модалка всё равно видна', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seed(page, false);
    await page.goto(`${BASE}/chat?view=tokens`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(PACKAGE_NAMES).first()).toBeVisible({ timeout: 30000 });
  });

  test('закрытие снимает ?view=tokens и модалка не возвращается', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seed(page, false);
    await page.goto(`${BASE}/chat?view=tokens`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(PACKAGE_NAMES).first()).toBeVisible({ timeout: 30000 });

    await page.evaluate(() => {
      const overlay = document.querySelector('.fixed.inset-0.bg-black');
      const btn = overlay && overlay.querySelector('button');
      if (btn) btn.click();
    });

    await expect.poll(() => countOverlays(page), { timeout: 10000 }).toBe(0);
    expect(page.url(), 'параметр должен уйти из адреса, иначе модалка вернётся').not.toContain('view=tokens');
  });
});
