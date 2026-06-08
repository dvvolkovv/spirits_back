// @ts-check
/**
 * Browser smoke tests for my.linkeon.io.
 * Logs in via the debug-OTP backdoor (DEBUG_SMS_CODES=true) — no real SMS.
 *
 * Run: cd tests && BASE_URL=https://my.linkeon.io npx playwright test playwright/
 */
const { test, expect } = require('@playwright/test');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';

async function getJwt() {
  await axios.get(`${BASE}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${TEST_PHONE}`);
  const codeRes = await axios.get(`${BASE}/webhook/debug/sms-code/${TEST_PHONE}`);
  const code = codeRes.data.code;
  const loginRes = await axios.get(
    `${BASE}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${TEST_PHONE}/${code}`,
  );
  return {
    access: loginRes.data['access-token'],
    refresh: loginRes.data['refresh-token'],
  };
}

// Добавляет Basic Auth через page.route() — единственный надёжный способ когда nginx
// не шлёт WWW-Authenticate challenge. Interceptor добавляет Authorization: Basic только
// если заголовок ещё не установлен (Bearer-токены из React-app не затрагиваются).
async function applyBasicAuth(page) {
  const auth = process.env.BASIC_AUTH;
  console.log('[applyBasicAuth] BASIC_AUTH:', auth ? `set (${auth.length} chars)` : 'NOT SET — skipping');
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

async function loginViaStorage(page) {
  await applyBasicAuth(page);
  const { access, refresh } = await getJwt();
  // AuthContext requires BOTH `authToken` and `userData` to consider the
  // user logged in (see AuthContext.tsx initAuth). tokenManager reads
  // jwt_access_token / jwt_refresh_token for apiClient calls.
  const userData = { phone: TEST_PHONE };
  await page.addInitScript(([a, r, u]) => {
    localStorage.setItem('jwt_access_token', a);
    localStorage.setItem('jwt_refresh_token', r);
    localStorage.setItem('authToken', a);
    localStorage.setItem('userData', u);
  }, [access, refresh, JSON.stringify(userData)]);
  await page.goto('/chat', { waitUntil: 'domcontentloaded' });
}

test.describe('my.linkeon.io smoke', () => {
  test('login → /chat → assistants visible', async ({ page }) => {
    await loginViaStorage(page);
    await page.waitForLoadState('domcontentloaded');
    // The page should render — wait for any assistant card/button
    // (selectors vary; we just check the page didn't redirect to /onboarding)
    expect(page.url()).toContain('/chat');
    // Page should contain at least one assistant name we expect
    await expect(page.locator('body')).toContainText(/Роман|Райя|Миша|Маша/, { timeout: 20000 });
  });

  test('chat interface renders for a logged-in user with selected assistant', async ({ page }) => {
    // Pre-select Роман in sessionStorage so the chat-interface renders
    // directly (skipping AssistantSelection welcome card). We're just
    // smoke-testing that the UI shows the chat layout, not the actual
    // streaming — that's already covered by the API smoke.
    await applyBasicAuth(page);
    const { access, refresh } = await getJwt();
    const userData = { phone: TEST_PHONE };
    const assistant = { id: 12, name: 'Роман', description: 'Помогаю делать все' };
    await page.addInitScript(([a, r, u, s]) => {
      localStorage.setItem('jwt_access_token', a);
      localStorage.setItem('jwt_refresh_token', r);
      localStorage.setItem('authToken', a);
      localStorage.setItem('userData', u);
      sessionStorage.setItem('selected_assistant', s);
    }, [access, refresh, JSON.stringify(userData), JSON.stringify(assistant)]);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    // The chat textarea/input should be rendered now
    const input = page.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 20000 });
    await expect(input).toBeVisible();
  });

  test('onboarding match: reopen → pick theme → lands in chat', async ({ page }) => {
    // Flag-independent: открываем match-экран всегда-доступной кнопкой
    // «Подобрать специалиста» (работает и для уже onboarded-пользователей).
    const { access, refresh } = await getJwt();
    const userData = { phone: TEST_PHONE };
    const assistant = { id: 12, name: 'Роман', description: 'Помогаю делать все' };
    await page.addInitScript(([a, r, u, s]) => {
      localStorage.setItem('jwt_access_token', a);
      localStorage.setItem('jwt_refresh_token', r);
      localStorage.setItem('authToken', a);
      localStorage.setItem('userData', u);
      sessionStorage.setItem('selected_assistant', s);
    }, [access, refresh, JSON.stringify(userData), JSON.stringify(assistant)]);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    const reopen = page.getByTestId('reopen-match');
    await reopen.waitFor({ state: 'visible', timeout: 20000 });
    await reopen.click();

    const themes = page.getByTestId('onboarding-theme');
    await expect(themes.first()).toBeVisible({ timeout: 10000 });
    await themes.first().click();

    // вернулись в чат — поле ввода видно
    const input = page.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 20000 });
    await expect(input).toBeVisible();
  });

  test('offer banner: does not break chat; dismissable if shown', async ({ page }) => {
    // Eligibility зависит от данных (≥15 сообщений + не платил + не в cooldown),
    // поэтому толерантно: чат-инпут обязан рендериться (значит OfferBanner не
    // ломает чат); если баннер показан — «×» его убирает.
    const { access, refresh } = await getJwt();
    const userData = { phone: TEST_PHONE };
    const assistant = { id: 12, name: 'Роман', description: 'Помогаю делать все' };
    await page.addInitScript(([a, r, u, s]) => {
      localStorage.setItem('jwt_access_token', a);
      localStorage.setItem('jwt_refresh_token', r);
      localStorage.setItem('authToken', a);
      localStorage.setItem('userData', u);
      sessionStorage.setItem('selected_assistant', s);
    }, [access, refresh, JSON.stringify(userData), JSON.stringify(assistant)]);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    const input = page.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 20000 });
    await expect(input).toBeVisible();

    const banner = page.getByTestId('offer-banner');
    if (await banner.isVisible().catch(() => false)) {
      await page.getByTestId('offer-dismiss').click();
      await expect(banner).toBeHidden({ timeout: 5000 });
    }
  });

  test('per-tab independence: two contexts hold different assistants', async ({ browser }) => {
    // Open two isolated browser contexts (= two browser windows with separate sessionStorage).
    // Basic Auth через page.route() в loginViaStorage → applyBasicAuth().
    // extraHTTPHeaders не используем: переопределяет Bearer → API 401.
    const ctxOpts = {};
    const c1 = await browser.newContext(ctxOpts);
    const c2 = await browser.newContext(ctxOpts);
    const p1 = await c1.newPage();
    const p2 = await c2.newPage();
    try {
      await loginViaStorage(p1);
      await loginViaStorage(p2);
      await p1.waitForLoadState('domcontentloaded');
      await p2.waitForLoadState('domcontentloaded');

      // Set different assistants in sessionStorage on each
      await p1.evaluate(() => {
        sessionStorage.setItem('selected_assistant', JSON.stringify({ id: 12, name: 'Роман', description: 'Помогаю делать все' }));
      });
      await p2.evaluate(() => {
        sessionStorage.setItem('selected_assistant', JSON.stringify({ id: 14, name: 'Райя', description: 'Human Design ридер' }));
      });

      // Reload to re-init React state from sessionStorage
      await p1.reload();
      await p2.reload();
      await p1.waitForLoadState('domcontentloaded');
      await p2.waitForLoadState('domcontentloaded');

      // Each context's sessionStorage stays independent
      const a1 = await p1.evaluate(() => JSON.parse(sessionStorage.getItem('selected_assistant') || 'null'));
      const a2 = await p2.evaluate(() => JSON.parse(sessionStorage.getItem('selected_assistant') || 'null'));
      expect(a1?.id).toBe(12);
      expect(a2?.id).toBe(14);

      // And there's no leakage in localStorage (the old bug used localStorage)
      const ls1 = await p1.evaluate(() => localStorage.getItem('selected_assistant'));
      expect(ls1).toBeFalsy();
    } finally {
      await c1.close();
      await c2.close();
    }
  });
});
