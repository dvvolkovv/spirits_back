// @ts-check
const { test, expect } = require('@playwright/test');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');
const { debugHeaders } = require('../debug-secret');
const smokeDbPsql = require('../smoke/db-psql');

const BASE = (process.env.BASE_URL || 'https://my.linkeon.io').replace(/\/+$/, '');
const ADMIN_PHONE = process.env.ADMIN_PHONE || '79030169187';
const NATIONAL = ADMIN_PHONE.slice(1);
const SSH_TARGET = process.env.SSH_TARGET;
const BACK_PATH = process.env.BACK_PATH;
const SHOTS = process.env.AGENT_VERSION_UX_SCREENSHOTS || path.resolve(__dirname, '../test-results/agent-version-ux');
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const AGENT_ID = 991;
const AGENT_NAME = 'agent_version_e2e';
const ORIGINAL_DESCRIPTION = 'Temporary UX assistant — original';
const CHANGED_DESCRIPTION = 'Temporary UX assistant — changed';
const ORIGINAL_PROMPT = 'You are a temporary UX assistant. Reply with exactly AGENT_VERSION_ORIGINAL_OK.';
const CHANGED_PROMPT = 'You are a temporary UX assistant. Reply with exactly AGENT_VERSION_DRAFT_OK.';

let mayCleanup = false;

async function getJwtFor(phone) {
  await axios.get(`${BASE}/webhook/${SMS_WH}/sms/${phone}?nosms=1`);
  const codeRes = await axios.get(`${BASE}/webhook/debug/sms-code/${phone}`, { headers: debugHeaders() });
  const loginRes = await axios.get(`${BASE}/webhook/${CHECK_WH}/check-code/${phone}/${codeRes.data.code}`);
  return loginRes.data['access-token'];
}

async function applyBasicAuth(page) {
  const auth = process.env.BASIC_AUTH;
  if (!auth) return;
  const encoded = Buffer.from(auth).toString('base64');
  await page.route('**/*', async (route) => {
    const headers = route.request().headers();
    if (headers.authorization) await route.continue();
    else await route.continue({ headers: { ...headers, authorization: `Basic ${encoded}` } });
  });
}

async function debugCode() {
  const response = await axios.get(`${BASE}/webhook/debug/sms-code/${ADMIN_PHONE}`, { headers: debugHeaders() });
  return response.data.code;
}

async function loginThroughUi(page) {
  await applyBasicAuth(page);
  await page.route(/^https?:\/\/([a-z0-9-]+\.)*(yandex\.ru|mail\.ru)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route(/\/minio\/linkeon-assets\/avatars\/agents\/\d+\.jpg(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
    }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('agent_version_ux_initialized')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('i18nextLng', 'ru');
    localStorage.setItem('linkeon_has_account', '1');
    sessionStorage.setItem('agent_version_ux_initialized', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('onboarding-root')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('consent-checkbox').check();
  await page.getByTestId('switch-to-phone').click();
  await page.getByTestId('phone-input').fill(NATIONAL);
  await page.getByTestId('phone-submit-btn').click();
  await expect(page.getByTestId('otp-input-0')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('otp-input-0').pressSequentially(await debugCode());
  await page.waitForURL('**/chat', { timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 });
}

async function cleanup() {
  if (!mayCleanup) return;
  if (!SSH_TARGET || !BACK_PATH) throw new Error('SSH_TARGET and BACK_PATH are required for cleanup');
  await smokeDbPsql.sshPsql(
    `BEGIN;
     DELETE FROM agent_versions
       WHERE agent_id = ${AGENT_ID}
         AND EXISTS (SELECT 1 FROM agents WHERE id = ${AGENT_ID} AND name = '${AGENT_NAME}');
     DELETE FROM agents WHERE id = ${AGENT_ID} AND name = '${AGENT_NAME}';
     COMMIT;`,
    { target: SSH_TARGET, backPath: BACK_PATH },
  );
  mayCleanup = false;
}

test.skip(process.env.AGENT_VERSION_UX !== '1', 'Opt-in manual UX verification (AGENT_VERSION_UX=1)');

test.describe('versioned assistants browser UX', () => {
  test.use({ serviceWorkers: 'block' });
  test.setTimeout(700000);

  test.beforeEach(async () => {
    if (!SSH_TARGET || !BACK_PATH) throw new Error('SSH_TARGET and BACK_PATH are required');
    const collisions = Number(await smokeDbPsql.sshPsql(
      `SELECT
         (SELECT count(*) FROM agents WHERE id = ${AGENT_ID} OR name = '${AGENT_NAME}') +
         (SELECT count(*) FROM agent_versions WHERE agent_id = ${AGENT_ID});`,
      { target: SSH_TARGET, backPath: BACK_PATH },
    ));
    expect(collisions, 'temporary agent id/name must be free').toBe(0);
    mayCleanup = true;
    fs.mkdirSync(SHOTS, { recursive: true });
    const token = await getJwtFor(ADMIN_PHONE);
    await axios.post(`${BASE}/webhook/agent`, {
      'agent-id': AGENT_ID,
      name: AGENT_NAME,
      description: ORIGINAL_DESCRIPTION,
      system_prompt: ORIGINAL_PROMPT,
    }, { headers: { Authorization: `Bearer ${token}` } });
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test('draft, diff, isolated test, publish and rollback', async ({ page }) => {
    const consoleErrors = [];
    const environmentErrors = [];
    let adminReady = false;
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const url = message.location().url;
      if (/(yandex\.ru|mail\.ru)/.test(url) || /\/avatars\/agents\//.test(url) ||
          /Error fetching avatar .*404/.test(text)) {
        environmentErrors.push(text);
        return;
      }
      if (!adminReady && /Failed to fetch|Failed to load resource|bad HTTP response code/.test(text)) {
        environmentErrors.push(text);
        return;
      }
      consoleErrors.push(text);
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      console.log('[ux-request-failed]', request.url(), request.failure()?.errorText);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) console.log('[ux-http]', response.status(), response.url());
    });

    await loginThroughUi(page);
    await page.goto(`${BASE}/admin?tab=assistants`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('admin-root')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('admin-assistants-list')).toBeVisible({ timeout: 30000 });
    adminReady = true;
    await page.getByTestId('admin-assistants-list').getByRole('button', { name: new RegExp(AGENT_NAME) }).click();
    await expect(page.locator(`#agent-prompt-${AGENT_ID}`)).toHaveValue(ORIGINAL_PROMPT, { timeout: 30000 });

    await page.locator(`#agent-description-${AGENT_ID}`).fill(CHANGED_DESCRIPTION);
    await page.locator(`#agent-prompt-${AGENT_ID}`).fill(CHANGED_PROMPT);
    await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Черновик сохранён. Опубликованная версия не изменилась.');
    await expect(page.locator(`#agent-description-${AGENT_ID}`)).toHaveValue(CHANGED_DESCRIPTION);
    await page.screenshot({ path: path.join(SHOTS, '01-editor-draft.png'), fullPage: true });

    await page.getByRole('button', { name: 'Опубликовано', exact: true }).click();
    await expect(page.locator(`#agent-description-${AGENT_ID}`)).toHaveValue(ORIGINAL_DESCRIPTION);
    await expect(page.locator(`#agent-prompt-${AGENT_ID}`)).toHaveValue(ORIGINAL_PROMPT);
    await page.getByRole('button', { name: 'Черновик', exact: true }).click();
    await expect(page.locator(`#agent-description-${AGENT_ID}`)).toHaveValue(CHANGED_DESCRIPTION);
    await expect(page.locator(`#agent-prompt-${AGENT_ID}`)).toHaveValue(CHANGED_PROMPT);

    await page.getByRole('button', { name: 'Показать diff', exact: true }).click();
    await expect(page.locator('.added').first()).toContainText('AGENT_VERSION_DRAFT_OK');
    await expect(page.locator('.removed').first()).toContainText('AGENT_VERSION_ORIGINAL_OK');
    await page.locator('.added').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, '02-diff.png'), fullPage: true });

    await page.getByTestId('agent-test-input').fill('Follow your system instruction.');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    const chatLog = page.getByRole('log');
    await expect(chatLog).toContainText('AGENT_VERSION_DRAFT_OK', { timeout: 240000 });
    await expect(chatLog).toContainText(/Токены: [1-9][0-9]*/);
    await page.screenshot({ path: path.join(SHOTS, '03-test-chat.png'), fullPage: true });

    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Версия опубликована.');
    await expect(page.getByText('Версия 2 · Опубликована', { exact: false })).toBeVisible();
    await expect(page.locator(`#agent-description-${AGENT_ID}`)).toHaveValue(CHANGED_DESCRIPTION);
    await expect(page.locator(`#agent-prompt-${AGENT_ID}`)).toHaveValue(CHANGED_PROMPT);

    await page.getByRole('button', { name: 'История', exact: true }).click();
    let versions = page.locator('article');
    await expect(versions).toHaveCount(2);
    await expect(versions.nth(0)).toContainText('Версия 2 · Опубликована');
    await expect(versions.nth(1)).toContainText('Версия 1 · Заменена');
    await page.screenshot({ path: path.join(SHOTS, '04-history-before-rollback.png'), fullPage: true });

    await versions.nth(1).getByRole('button', { name: 'Создать черновик из версии', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Черновик создан из версии 1.');
    await expect(page.getByText('Версия 3 · Черновик', { exact: false })).toBeVisible();
    await expect(page.locator(`#agent-description-${AGENT_ID}`)).toHaveValue(ORIGINAL_DESCRIPTION);
    await expect(page.locator(`#agent-prompt-${AGENT_ID}`)).toHaveValue(ORIGINAL_PROMPT);
    await page.getByRole('button', { name: 'Показать diff', exact: true }).click();
    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Версия опубликована.');
    await expect(page.getByText('Версия 3 · Опубликована', { exact: false })).toBeVisible();
    await expect(page.locator(`#agent-description-${AGENT_ID}`)).toHaveValue(ORIGINAL_DESCRIPTION);
    await expect(page.locator(`#agent-prompt-${AGENT_ID}`)).toHaveValue(ORIGINAL_PROMPT);

    await page.getByRole('button', { name: 'История', exact: true }).click();
    versions = page.locator('article');
    await expect(versions).toHaveCount(3);
    await expect(versions.nth(0)).toContainText('Версия 3 · Опубликована');
    await expect(versions.nth(1)).toContainText('Версия 2 · Заменена');
    await expect(versions.nth(2)).toContainText('Версия 1 · Заменена');
    await page.screenshot({ path: path.join(SHOTS, '05-history-after-rollback.png'), fullPage: true });

    console.log('[ux-environment-console-errors]', environmentErrors.length);
    expect(consoleErrors, 'browser console/page errors after admin ready').toEqual([]);
  });
});
