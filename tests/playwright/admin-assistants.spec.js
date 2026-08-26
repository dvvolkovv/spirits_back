// @ts-check
/**
 * Список ассистентов в админке должен докручиваться до последнего.
 *
 * Баг 26.08.2026: AdminAssistantsView был объявлен как h-screen, хотя живёт
 * внутри AdminPage под строкой вкладок. Вкладка занимала всю высоту окна —
 * на высоту строки вкладок больше, чем ей отведено, — и родитель обрезал
 * избыток по overflow-hidden. Низ боковой колонки уезжал за границу экрана и
 * не докручивался. Пока ассистентов было немного, это не бросалось в глаза;
 * когда появился девятнадцатый (Дмитрий), до него стало не добраться.
 *
 * Тест проверяет не CSS-класс, а наблюдаемое поведение: последний элемент
 * списка после прокрутки виден в окне целиком.
 *
 * Run: cd tests && BASE_URL=https://my.linkeon.io ADMIN_PHONE=79030169187 \
 *      npx playwright test playwright/admin-assistants.spec.js --reporter=list
 */
const { test, expect } = require('@playwright/test');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '79030169187';

async function getJwtFor(phone) {
  await axios.get(`${BASE}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${phone}`);
  const codeRes = await axios.get(`${BASE}/webhook/debug/sms-code/${phone}`);
  const loginRes = await axios.get(
    `${BASE}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${phone}/${codeRes.data.code}`,
  );
  return { access: loginRes.data['access-token'], refresh: loginRes.data['refresh-token'] };
}

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

test.describe('админка: список ассистентов', () => {
  test('последний ассистент в списке достижим прокруткой', async ({ page }) => {
    await applyBasicAuth(page);
    const { access, refresh } = await getJwtFor(ADMIN_PHONE);
    await page.addInitScript(([a, r]) => {
      localStorage.setItem('i18nextLng', 'ru');
      localStorage.setItem('jwt_access_token', a);
      localStorage.setItem('jwt_refresh_token', r);
      localStorage.setItem('authToken', a);
      localStorage.setItem('userData', JSON.stringify({ phone: '79030169187' }));
    }, [access, refresh]);

    await page.goto(`${BASE}/admin?tab=assistants`, { waitUntil: 'domcontentloaded' });

    const list = page.getByTestId('admin-assistants-list');
    await expect(list).toBeVisible({ timeout: 30000 });

    const items = list.locator('button');
    const count = await items.count();
    expect(count, 'ассистенты должны загрузиться').toBeGreaterThan(5);

    // Прокручиваем ТОЛЬКО саму колонку, до упора — это всё, что доступно
    // пользователю мышью или пальцем.
    //
    // scrollIntoViewIfNeeded здесь использовать НЕЛЬЗЯ, и на этом я уже
    // обжёгся: он прокручивает и родителей с overflow:hidden. Такой элемент
    // не прокручивается жестом, но прокручивается скриптом — Playwright
    // делал то, чего человек сделать не может, элемент «оказывался виден», и
    // тест зеленел на сборке с багом.
    const geometry = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="admin-assistants-list"]');
      const sidebar = list?.closest('.overflow-y-auto');
      if (!sidebar) return null;
      sidebar.scrollTop = sidebar.scrollHeight; // до упора, как пользователь
      const buttons = list.querySelectorAll('button');
      const last = buttons[buttons.length - 1];
      return {
        viewport: window.innerHeight,
        lastBottom: Math.round(last.getBoundingClientRect().bottom),
        lastName: last.textContent?.trim(),
      };
    });

    expect(geometry, 'колонка со списком должна найтись').not.toBeNull();
    expect(
      geometry.lastBottom,
      `после прокрутки до упора низ «${geometry.lastName}» (${geometry.lastBottom}) ` +
      `должен помещаться в окно (${geometry.viewport})`,
    ).toBeLessThanOrEqual(geometry.viewport);
  });
});
