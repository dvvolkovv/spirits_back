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

    const last = items.nth(count - 1);
    await last.scrollIntoViewIfNeeded();

    // Ключевая проверка: после прокрутки нижняя граница последнего элемента
    // помещается в окно. При h-screen она уходила ниже видимой области, и
    // никакая прокрутка её не поднимала — прокручивать было уже нечего.
    const box = await last.boundingBox();
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(box, 'последний элемент должен иметь геометрию').not.toBeNull();
    expect(
      box.y + box.height,
      `низ последнего элемента (${Math.round(box.y + box.height)}) должен быть внутри окна (${viewportHeight})`,
    ).toBeLessThanOrEqual(viewportHeight);

    // И он должен быть кликабельным — то есть не перекрыт и не за границей.
    await last.click();
    await expect(page.getByTestId('admin-assistants-list')).toBeVisible();
  });
});
