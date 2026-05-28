// @ts-check
/**
 * E2E test for Юля (SMM Producer) creator-mode scenario editing.
 *
 * Reproduces the user-reported bug: "editing doesn't work on save".
 * Uses an existing scenario in the DB (created earlier) instead of running
 * the full wizard, since the bug is in the edit→save flow specifically.
 *
 * Run: cd tests && BASE_URL=https://my.linkeon.io TEST_PHONE=79169403771 \
 *      npx playwright test playwright/julia-creator.spec.js --reporter=list
 */
const { test, expect } = require('@playwright/test');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '79030169187';

async function getJwtFor(phone) {
  await axios.get(`${BASE}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${phone}`);
  const codeRes = await axios.get(`${BASE}/webhook/debug/sms-code/${phone}`);
  const code = codeRes.data.code;
  const loginRes = await axios.get(
    `${BASE}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${phone}/${code}`,
  );
  return {
    access: loginRes.data['access-token'],
    refresh: loginRes.data['refresh-token'],
  };
}

async function getJwt() {
  return getJwtFor(TEST_PHONE);
}

// Idempotent fixture seed for the edit-flow test. Inserts a campaign + scenario
// + chat_history row marked with `[smoke-seed]` so the ScenarioCard renders
// in TEST_PHONE's chat with Юля. Prior seed rows are cleaned up by the endpoint.
async function seedScenarioForTest() {
  const { access: adminJwt } = await getJwtFor(ADMIN_PHONE);
  const res = await axios.post(
    `${BASE}/webhook/smm/admin/seed-scenario`,
    { phone: TEST_PHONE },
    { headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' } },
  );
  return res.data;
}

async function loginAsJulia(page) {
  const { access, refresh } = await getJwt();
  // Pre-select Юля (smm_producer, id=21 — verifying below) so chat renders
  // directly without going through AssistantSelection. We'll also fall back
  // to clicking Юля in the UI if needed.
  const userData = { phone: TEST_PHONE };
  await page.addInitScript(([a, r, u]) => {
    localStorage.setItem('jwt_access_token', a);
    localStorage.setItem('jwt_refresh_token', r);
    localStorage.setItem('authToken', a);
    localStorage.setItem('userData', u);
  }, [access, refresh, JSON.stringify(userData)]);
  return { access, refresh };
}

// Использует seedScenarioForTest() для подготовки фикстуры — работает
// и на test.linkeon.io, и на my.linkeon.io. ADMIN_PHONE должен существовать
// в БД с isadmin=true (на обоих стендах: 79030169187 по умолчанию).
test.describe('Юля (SMM Producer) creator-mode E2E', () => {
  test('login → see Юля → open chat with her', async ({ page }) => {
    await loginAsJulia(page);
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });

    expect(page.url()).toContain('/chat');

    // Юля must appear somewhere on the assistants page
    const julia = page.getByText(/Юлия|Юля/).first();
    await expect(julia).toBeVisible({ timeout: 20000 });
    console.log('[OK] Юля is visible on chat page');
  });

  test('edit existing scenario → save → check toast + network → reload persistence', async ({ page }) => {
    test.setTimeout(240_000);

    // Seed: ensure a ScenarioCard exists in TEST_PHONE's chat with Юля.
    // Idempotent — replaces any prior [smoke-seed] row.
    const seeded = await seedScenarioForTest();
    console.log(`[INFO] seeded scenario: ${seeded.scenarioId} (campaign ${seeded.campaignId})`);

    // Capture console errors + network calls
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[console.error] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`[pageerror] ${err.message}`);
    });

    const patchCalls = [];
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('/webhook/smm/scenarios/') && resp.request().method() === 'PATCH') {
        let body = '';
        try { body = await resp.text(); } catch (_) {}
        patchCalls.push({
          url, status: resp.status(), body, ts: Date.now(),
        });
      }
    });

    // Login + pre-select Юля so we don't have to click through assistant list
    const { access } = await loginAsJulia(page);

    // Fetch the assistant list to find Юля's id (smm_producer)
    const agentsRes = await axios.get(`${BASE}/webhook/agents`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    const julia = agentsRes.data?.find?.((a) =>
      (a.name || '').toLowerCase().includes('smm') ||
      (a.displayName || '').toLowerCase().includes('юл'),
    );
    if (!julia) {
      throw new Error(`Юля not found in agents list: ${JSON.stringify(agentsRes.data).slice(0, 500)}`);
    }
    console.log(`[INFO] Found Юля: id=${julia.id}, name=${julia.name}, displayName=${julia.displayName}`);

    await page.addInitScript((j) => {
      sessionStorage.setItem('selected_assistant', j);
    }, JSON.stringify(julia));

    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });

    // Wait for chat to load (history fetch). The ScenarioCard from prior
    // session should render in chat history.
    await page.waitForTimeout(4000);

    // Scroll messages container to top to load history if lazy.
    // Look for an "Edit" button in any ScenarioCard
    const editBtn = page.getByRole('button', { name: /^Редактировать(?: сценарий)?$/ }).first();
    let editFound = false;
    try {
      await editBtn.waitFor({ state: 'visible', timeout: 15000 });
      editFound = true;
    } catch (_) {}

    if (!editFound) {
      // Fallback: scroll the chat to find it
      const messages = page.locator('main, [class*="overflow"]').first();
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -1000);
        await page.waitForTimeout(500);
        if (await editBtn.isVisible().catch(() => false)) { editFound = true; break; }
      }
    }

    if (!editFound) {
      // Capture screenshot for diagnostics
      await page.screenshot({ path: '/tmp/julia-no-edit-button.png', fullPage: true });
      throw new Error('Could not find «Редактировать» button on any ScenarioCard. See /tmp/julia-no-edit-button.png');
    }

    console.log('[OK] Found «Редактировать» button on a ScenarioCard');

    await editBtn.click();
    await page.waitForTimeout(500);

    // Modal: heading "Редактирование сценария"
    const modal = page.getByText('Редактирование сценария').locator('..').locator('..');
    await expect(page.getByText('Редактирование сценария')).toBeVisible({ timeout: 5000 });
    console.log('[OK] Edit modal opened');

    // Title input — first text input in modal
    const titleInput = page.locator('input[type="text"]').first();
    await expect(titleInput).toBeVisible();
    const oldTitle = await titleInput.inputValue();
    console.log(`[INFO] Old title: "${oldTitle}"`);

    const newTitle = `QA E2E ${Date.now()}`;
    await titleInput.fill(newTitle);
    console.log(`[INFO] New title set: "${newTitle}"`);

    // Click Save
    const saveBtn = page.getByRole('button', { name: 'Сохранить' });
    await saveBtn.click();
    console.log('[INFO] Clicked «Сохранить»');

    // Wait for save to complete: either toast OR modal closes
    await page.waitForTimeout(3000);

    // Check for toast — react-hot-toast renders in a portal
    const successToast = page.getByText('Сценарий обновлён');
    const errorToast = page.getByText(/Не удалось сохранить/);

    const sawSuccess = await successToast.isVisible().catch(() => false);
    const sawError = await errorToast.isVisible().catch(() => false);

    console.log(`[INFO] PATCH calls captured: ${patchCalls.length}`);
    for (const c of patchCalls) {
      console.log(`  → ${c.url} → HTTP ${c.status}`);
      console.log(`     body: ${c.body.slice(0, 300)}`);
    }

    // Check modal closed
    const modalStillOpen = await page.getByText('Редактирование сценария').isVisible().catch(() => false);
    console.log(`[INFO] sawSuccessToast=${sawSuccess}, sawErrorToast=${sawError}, modalStillOpen=${modalStillOpen}`);

    // Now check the ScenarioCard reflects the new title (without reload)
    await page.waitForTimeout(1000);
    const cardWithNewTitle = page.getByText(newTitle).first();
    const cardUpdated = await cardWithNewTitle.isVisible().catch(() => false);
    console.log(`[INFO] Card shows new title (no-reload): ${cardUpdated}`);

    // Reload and verify persistence
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // Scroll to ensure messages render
    const persistedTitle = page.getByText(newTitle).first();
    const persisted = await persistedTitle.isVisible({ timeout: 10000 }).catch(() => false);
    console.log(`[INFO] Card shows new title AFTER RELOAD: ${persisted}`);

    if (consoleErrors.length) {
      console.log('[CONSOLE ERRORS]');
      for (const e of consoleErrors) console.log(`  ${e}`);
    }

    // Final assertions
    expect(patchCalls.length, 'a PATCH call should have been made').toBeGreaterThan(0);
    expect(patchCalls[0].status, 'PATCH should return 200').toBe(200);
    expect(sawError, 'no error toast').toBe(false);
    // The key assertion the user reported failing:
    expect(sawSuccess || !modalStillOpen, 'save should have closed the modal OR shown success toast').toBe(true);
    expect(persisted, 'new title persists after reload').toBe(true);
  });
});
