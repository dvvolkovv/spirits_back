const { test, expect } = require('@playwright/test');
const fs = require('fs');

/**
 * Вход в форму пополнения токенов.
 *
 * 12.08.2026: пользователь с телефона жал «Пополнить» в профиле и попадал на
 * список ассистентов. Причина — модалка пополнения рендерилась внутри
 * ChatInterface, а при отсутствии выбранного ассистента ChatLayout отдаёт весь
 * экран своему сайдбару и прячет колонку с ChatInterface классом
 * `hidden md:flex`. Оверлей оказывался в поддереве с display:none: в DOM есть,
 * размер 0×0, на экране ничего. На телефоне ловилось почти всегда, потому что
 * признак выбранного ассистента лежит в sessionStorage — он живёт только в
 * пределах вкладки.
 *
 * Затронуты были ВСЕ входы разом: кнопка в профиле, OfferBanner,
 * SessionPaywallNudge, ссылка из видео и подсказка в /help — все ведут на
 * «/chat?view=tokens».
 *
 * Проверять видимость обязательно: count() в DOM проходил и на сломанной
 * версии, потому что узлы там были — просто нулевого размера.
 */

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const jwt = JSON.parse(fs.readFileSync(process.env.JWT_FILE, 'utf8'));

async function seed(page, withAssistant) {
  await page.addInitScript(([a, r, sel]) => {
    localStorage.setItem('i18nextLng', 'ru');
    localStorage.setItem('jwt_access_token', a);
    localStorage.setItem('jwt_refresh_token', r);
    localStorage.setItem('authToken', a);
    localStorage.setItem('userData', JSON.stringify({ phone: '70000000000' }));
    if (sel) sessionStorage.setItem('selected_assistant', sel);
    else sessionStorage.removeItem('selected_assistant');
  }, [jwt['access-token'], jwt['refresh-token'],
      withAssistant ? JSON.stringify({ id: 10, name: 'Алексей', displayName: 'Алексей' }) : null]);
}

const countOverlays = (page) => page.evaluate(
  () => document.querySelectorAll('.fixed.inset-0.bg-black').length);

test('профиль → Пополнить открывает форму пополнения, а не список ассистентов', async ({ page }) => {
  // Мобильный экран, свежая вкладка: sessionStorage пуст, ассистент НЕ выбран —
  // ровно то состояние, в котором пользователь открывает приложение с телефона.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(([a, r]) => {
    localStorage.setItem('i18nextLng', 'ru');
    localStorage.setItem('jwt_access_token', a);
    localStorage.setItem('jwt_refresh_token', r);
    localStorage.setItem('authToken', a);
    localStorage.setItem('userData', JSON.stringify({ phone: '70000000000' }));
    sessionStorage.removeItem('selected_assistant');
  }, [jwt['access-token'], jwt['refresh-token']]);

  await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const topUp = page.getByText(/пополнить/i).first();
  await expect(topUp).toBeVisible({ timeout: 20000 });
  await topUp.click();
  await page.waitForTimeout(4000);

  console.log('URL после клика:', page.url());
  const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
  console.log('ЧТО НА ЭКРАНЕ:', bodyText);

  // count() недостаточно: модалка может отрисоваться, но лежать ПОД списком
  // ассистентов и быть недоступной. Проверяем реальную видимость и то, что
  // клик в центр экрана попадает именно в неё.
  const pkg = page.getByText(/Базовый|Популярный|Профессиональный|Расширенный/).first();
  const visible = await pkg.isVisible().catch(() => false);
  console.log('карточка тарифа видима:', visible);

  const topmost = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const overlay = el && el.closest('.fixed.inset-0');
    return { tag: el && el.tagName, внутриОверлея: !!overlay };
  });
  console.log('в центре экрана:', JSON.stringify(topmost));

  expect(visible, 'карточка тарифа должна быть видима').toBe(true);
  expect(topmost.внутриОверлея, 'центр экрана должен принадлежать модалке, а не списку').toBe(true);
});

test('десктоп, ассистент выбран: ровно одна модалка, не две', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, true);
  await page.goto(`${BASE}/chat?view=tokens`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const n = await countOverlays(page);
  console.log('оверлеев на десктопе:', n);
  expect(n, 'дубля модалки быть не должно').toBe(1);
});

test('десктоп, ассистент НЕ выбран: модалка всё равно видна', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, false);
  await page.goto(`${BASE}/chat?view=tokens`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const visible = await page.getByText(/Базовый|Популярный|Профессиональный/).first().isVisible().catch(() => false);
  console.log('видима на десктопе без ассистента:', visible);
  expect(visible).toBe(true);
});

test('закрытие модалки убирает ?view=tokens и не возвращает её', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, false);
  await page.goto(`${BASE}/chat?view=tokens`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  expect(await countOverlays(page)).toBe(1);

  // Закрываем — крестик или клик по подложке.
  const closed = await page.evaluate(() => {
    const overlay = document.querySelector('.fixed.inset-0.bg-black');
    const btn = overlay && overlay.querySelector('button');
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log('нашли кнопку закрытия:', closed);
  await page.waitForTimeout(2500);
  console.log('URL после закрытия:', page.url());
  console.log('оверлеев после закрытия:', await countOverlays(page));
  expect(page.url()).not.toContain('view=tokens');
  expect(await countOverlays(page)).toBe(0);
});
