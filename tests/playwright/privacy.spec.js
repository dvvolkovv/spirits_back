// @ts-check
const { test, expect } = require('@playwright/test');
const axios = require('axios');
const { debugHeaders } = require('../debug-secret');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TARGET_PHONE = process.env.TEST_PHONE || '70000000000';
const STRANGER_PHONE = process.env.ADMIN_PHONE || '79030169187';
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';

const PROFILE_ENTITY_KEYS = [
  'values', 'beliefs', 'desires', 'intents', 'interests', 'skills',
  'valuesRich', 'beliefsRich', 'desiresRich', 'intentsRich', 'interestsRich', 'skillsRich',
];

function basicAuthorization() {
  const auth = process.env.BASIC_AUTH;
  if (!auth) return null;
  const [user, ...rest] = auth.split(':');
  return `Basic ${Buffer.from(`${user}:${rest.join(':')}`).toString('base64')}`;
}

const BASIC_AUTHORIZATION = basicAuthorization();

// Basic и Bearer делят один Authorization. Поэтому test.linkeon.io отключает
// auth_basic для /webhook/ (scripts/provision-test.sh): Basic нужен публичным
// login/debug-запросам, а JWT в защищённых запросах нельзя им перезаписывать.
// Тот же порядок повторяет applyBasicAuth для запросов браузера.
function withBasicAuth(headers = {}) {
  const result = { ...headers };
  const hasAuthorization = Object.keys(result).some((key) => key.toLowerCase() === 'authorization');
  if (BASIC_AUTHORIZATION && !hasAuthorization) result.Authorization = BASIC_AUTHORIZATION;
  return result;
}

async function api(config) {
  return axios({
    timeout: 30000,
    ...config,
    headers: withBasicAuth(config.headers),
    validateStatus: () => true,
  });
}

async function login(phone) {
  const sms = await api({ method: 'GET', url: `${BASE}/webhook/${SMS_WH}/sms/${phone}` });
  expect(sms.status).toBe(200);

  const code = await api({
    method: 'GET',
    url: `${BASE}/webhook/debug/sms-code/${phone}`,
    headers: debugHeaders(),
  });
  expect(code.status).toBe(200);

  const auth = await api({
    method: 'GET',
    url: `${BASE}/webhook/${CHECK_WH}/check-code/${phone}/${code.data.code}`,
  });
  expect(auth.status).toBe(200);
  expect(auth.data['access-token']).toEqual(expect.any(String));
  expect(auth.data['refresh-token']).toEqual(expect.any(String));
  return { access: auth.data['access-token'], refresh: auth.data['refresh-token'] };
}

async function request(method, path, token, body) {
  return api({
    method,
    url: `${BASE}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    data: body,
  });
}

async function settings(token) {
  const response = await request('GET', '/webhook/privacy-settings', token);
  expect(response.status).toBe(200);
  expect(response.data).toEqual({
    automaticProfiling: expect.any(Boolean),
    discoverable: expect.any(Boolean),
  });
  return response.data;
}

async function update(token, patch) {
  return request('POST', '/webhook/privacy-settings', token, patch);
}

async function restore(token, original) {
  const response = await update(token, original);
  expect(response.status).toBe(200);
  expect(response.data).toEqual(original);
}

async function applyBasicAuth(page) {
  if (!BASIC_AUTHORIZATION) return;
  await page.route('**/*', async (route) => {
    const headers = route.request().headers();
    const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
    if (!hasAuthorization) {
      await route.continue({ headers: { ...headers, authorization: BASIC_AUTHORIZATION } });
    } else {
      await route.continue();
    }
  });
}

async function seedPage(page, credentials, phone) {
  await applyBasicAuth(page);
  await page.addInitScript(({ access, refresh, userPhone }) => {
    localStorage.setItem('i18nextLng', 'ru');
    localStorage.setItem('jwt_access_token', access);
    localStorage.setItem('jwt_refresh_token', refresh);
    localStorage.setItem('authToken', access);
    localStorage.setItem('userData', JSON.stringify({ phone: userPhone }));
    localStorage.setItem('linkeon_has_account', '1');
  }, { access: credentials.access, refresh: credentials.refresh, userPhone: phone });
}

test.describe('profile privacy', () => {
  test('hidden target is unavailable to a stranger and settings restore', async () => {
    const target = await login(TARGET_PHONE);
    const stranger = await login(STRANGER_PHONE);
    const original = await settings(target.access);

    try {
      const hidden = await update(target.access, { discoverable: false });
      expect(hidden.status).toBe(200);
      expect((await settings(target.access)).discoverable).toBe(false);

      const profile = await request(
        'GET', `/webhook/user-public-by-phone/${TARGET_PHONE}`, stranger.access,
      );
      expect(profile.status).toBe(404);

      const compatibility = await request(
        'POST', '/webhook/analyze-compatibility', stranger.access, { users: [TARGET_PHONE] },
      );
      expect(compatibility.status).toBe(404);

      const peer = await request('POST', '/webhook/peer/request', stranger.access, {
        toUserId: TARGET_PHONE,
        introMessage: 'privacy test',
      });
      expect(peer.status).toBe(404);
    } finally {
      await restore(target.access, original);
    }
  });

  test('paused profiling stays visible to owner and hidden from a stranger', async () => {
    const target = await login(TARGET_PHONE);
    const stranger = await login(STRANGER_PHONE);
    const original = await settings(target.access);

    try {
      const paused = await update(target.access, { automaticProfiling: false, discoverable: true });
      expect(paused.status).toBe(200);
      expect(paused.data).toMatchObject({ automaticProfiling: false, discoverable: true });

      const ownerProfile = await request('GET', '/webhook/profile', target.access);
      expect(ownerProfile.status).toBe(200);

      const publicProfile = await request(
        'GET', `/webhook/user-public-by-phone/${TARGET_PHONE}`, stranger.access,
      );
      expect(publicProfile.status).toBe(200);
      for (const key of PROFILE_ENTITY_KEYS) {
        expect(publicProfile.data[key], `${key} must be empty while profiling is paused`).toEqual([]);
      }

      const compatibility = await request(
        'POST', '/webhook/analyze-compatibility', stranger.access, { users: [TARGET_PHONE] },
      );
      expect(compatibility.status).toBe(422);
    } finally {
      await restore(target.access, original);
    }
  });

  test('deployed UI saves a real switch and restores it', async ({ page }) => {
    const target = await login(TARGET_PHONE);
    const original = await settings(target.access);
    const next = !original.automaticProfiling;

    try {
      await seedPage(page, target, TARGET_PHONE);
      await page.goto('/profile?settings=1', { waitUntil: 'domcontentloaded' });

      const toggle = page.getByRole('switch', { name: 'Автоматически пополнять мой профиль' });
      await expect(toggle).toBeVisible({ timeout: 20000 });

      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/webhook/privacy-settings' && response.request().method() === 'POST';
      }, { timeout: 20000 });
      await toggle.click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      expect((await settings(target.access)).automaticProfiling).toBe(next);
    } finally {
      await restore(target.access, original);
    }
  });
});
