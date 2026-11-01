/**
 * Живой E2E версионной публикации ассистента. Запускать только после выката
 * feature-ветки на test-стенд; один тестовый AI-ход списывает токены админа.
 *
 *   BASE_URL=https://test.linkeon.io TEST_PHONE=79656445804 DEBUG_SECRET=… \
 *   SSH_TARGET=dv@85.192.61.231 BACK_PATH=/home/dv/spirits_back \
 *   node tests/agent-versions.e2e.mjs
 *
 * DEBUG_SECRET, JWT и OTP не печатаются. SSH_TARGET/BACK_PATH обязательны, чтобы
 * DB-проверка и транзакционная чистка не могли молча уйти в продовый default.
 */
import assert from 'node:assert/strict';
import debugSecret from './debug-secret.js';
import smokeDbPsql from './smoke/db-psql.js';

const { sshPsql } = smokeDbPsql;
const need = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`задай ${key}`);
  return value;
};
const BASE = need('BASE_URL').replace(/\/+$/, '');
const PHONE = process.env.TEST_PHONE || '79656445804';
const SSH_TARGET = need('SSH_TARGET');
const BACK_PATH = need('BACK_PATH');
debugSecret.debugSecret();

const AGENT_ID = 991;
const AGENT_NAME = 'agent_version_e2e';
const ORIGINAL_DESCRIPTION = 'Temporary agent for versioned publishing E2E — original';
const CHANGED_DESCRIPTION = 'Temporary agent for versioned publishing E2E — changed';
const ORIGINAL_PROMPT = 'You are a temporary E2E assistant. Reply with exactly AGENT_VERSION_ORIGINAL_OK.';
const CHANGED_PROMPT = 'You are a temporary E2E assistant. Reply with exactly AGENT_VERSION_DRAFT_OK and nothing else.';
const STALE_PROMPT = 'You are a temporary E2E assistant. This draft must never be published.';
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const CALL_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 700_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (message) => console.log(`✓ ${message}`);
const dbOptions = { target: SSH_TARGET, backPath: BACK_PATH };

async function request(method, path, { token, body, headers = {}, timeout = CALL_TIMEOUT_MS } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (response.ok) throw new Error(`${method} ${path}: ответ не JSON`);
    }
  }
  return { status: response.status, body: payload };
}

async function ok(method, path, options = {}) {
  const response = await request(method, path, options);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${method} ${path}: HTTP ${response.status}`,
  );
  return response.body;
}

async function login() {
  for (let attempt = 1; ; attempt++) {
    try {
      await ok('GET', `/webhook/${SMS_WH}/sms/${PHONE}?nosms=1`);
      await sleep(1200);
      const codeResponse = await ok('GET', `/webhook/debug/sms-code/${PHONE}`, {
        headers: debugSecret.debugHeaders(),
      });
      assert.ok(codeResponse?.code, 'debug-код не выдан');
      const auth = await ok('GET', `/webhook/${CHECK_WH}/check-code/${PHONE}/${codeResponse.code}`);
      assert.ok(auth?.['access-token'], 'вход не прошёл');
      return auth['access-token'];
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(5000);
    }
  }
}

async function liveAgent(token) {
  const agents = await ok('GET', '/webhook/agent-details', { token });
  const agent = agents.find((item) => item.id === AGENT_ID && item.name === AGENT_NAME);
  assert.ok(agent, 'временный ассистент не найден в /webhook/agent-details');
  return agent;
}

function assertLive(agent, description, prompt) {
  assert.equal(agent.description, description);
  assert.equal(agent.system_prompt, prompt);
}

function assertVersionMetadata(version, number, status) {
  assert.equal(version.agent_id, AGENT_ID);
  assert.equal(version.version, number);
  assert.equal(version.status, status);
  assert.equal(version.created_by, PHONE);
  assert.ok(!Number.isNaN(Date.parse(version.created_at)), 'created_at не дата');
  if (status === 'published') {
    assert.equal(version.published_by, PHONE);
    assert.ok(version.published_at && !Number.isNaN(Date.parse(version.published_at)), 'published_at не дата');
  }
}

async function createDraft(token, baseVersionId, description, prompt) {
  return ok('POST', `/webhook/admin/agents/${AGENT_ID}/drafts`, {
    token,
    body: { description, system_prompt: prompt, base_version_id: baseVersionId },
  });
}

async function publish(token, versionId, expectedPublishedVersionId) {
  return ok('POST', `/webhook/admin/agents/${AGENT_ID}/versions/${versionId}/publish`, {
    token,
    body: { expected_published_version_id: expectedPublishedVersionId },
  });
}

async function history(token) {
  const versions = await ok('GET', `/webhook/admin/agents/${AGENT_ID}/versions?limit=50`, { token });
  assert.deepEqual(
    versions.map((version) => version.version),
    [...versions.map((version) => version.version)].sort((a, b) => b - a),
    'история не отсортирована от новых к старым',
  );
  return versions;
}

let mayCleanup = false;

async function run() {
  const collisions = Number(await sshPsql(
    `SELECT
       (SELECT count(*) FROM agents WHERE id = ${AGENT_ID} OR name = '${AGENT_NAME}') +
       (SELECT count(*) FROM agent_versions WHERE agent_id = ${AGENT_ID});`,
    dbOptions,
  ));
  assert.equal(collisions, 0, `id ${AGENT_ID} или name ${AGENT_NAME} уже заняты — чужие данные не трогаю`);
  mayCleanup = true;

  const token = await login();
  const profile = await ok('GET', '/webhook/profile', { token });
  assert.equal(profile?.[0]?.profileJson?.isadmin, true, 'TEST_PHONE должен принадлежать админу');
  pass('админ авторизован, временный id/name свободны');

  await ok('POST', '/webhook/agent', {
    token,
    body: {
      'agent-id': AGENT_ID,
      name: AGENT_NAME,
      description: ORIGINAL_DESCRIPTION,
      system_prompt: ORIGINAL_PROMPT,
    },
  });
  const initialState = await ok('GET', `/webhook/admin/agents/${AGENT_ID}/state`, { token });
  const original = initialState.published;
  assert.ok(original, 'legacy POST не создал действующую версию');
  assert.equal(initialState.draft, null);
  assertVersionMetadata(original, 1, 'published');
  assert.equal(original.base_version_id, null);
  assertLive(original, ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  assertLive(await liveAgent(token), ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  pass('legacy POST создал ассистента и опубликованную версию 1');

  const changed = await createDraft(token, original.id, CHANGED_DESCRIPTION, CHANGED_PROMPT);
  assertVersionMetadata(changed, 2, 'draft');
  assert.equal(changed.base_version_id, original.id);
  assertLive(changed, CHANGED_DESCRIPTION, CHANGED_PROMPT);
  assert.equal(changed.published_at, null);
  assert.equal(changed.published_by, null);
  const draftState = await ok('GET', `/webhook/admin/agents/${AGENT_ID}/state`, { token });
  assert.equal(draftState.published.id, original.id);
  assert.equal(draftState.draft.id, changed.id);
  assertLive(await liveAgent(token), ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  pass('черновик 2 сохранён, действующее содержимое не изменилось');

  const tested = await ok('POST', `/webhook/admin/agents/${AGENT_ID}/test`, {
    token,
    body: { version_id: changed.id, message: 'Follow your system instruction.' },
    timeout: TEST_TIMEOUT_MS,
  });
  assert.ok(typeof tested.text === 'string' && tested.text.includes('AGENT_VERSION_DRAFT_OK'), 'тест не использовал промпт черновика');
  assert.ok(typeof tested.session_id === 'string' && /^agent_test_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(tested.session_id), 'некорректная изолированная session_id');
  assert.ok(Number.isFinite(tested.tokens) && tested.tokens > 0, 'стоимость теста не возвращена');
  await sleep(2000);
  const historyRows = Number(await sshPsql(
    `SELECT count(*) FROM custom_chat_history WHERE session_id = '${tested.session_id}';`,
    dbOptions,
  ));
  assert.equal(historyRows, 0, 'тестовый диалог попал в custom_chat_history');
  pass('тест черновика ответил, сессия изолирована, стоимость возвращена, история чатов пуста');

  const publishedChanged = await publish(token, changed.id, original.id);
  assertVersionMetadata(publishedChanged, 2, 'published');
  assertLive(await liveAgent(token), CHANGED_DESCRIPTION, CHANGED_PROMPT);
  const afterPublish = await history(token);
  assert.equal(afterPublish.length, 2);
  assert.equal(afterPublish[0].id, changed.id);
  assert.equal(afterPublish[0].status, 'published');
  assert.equal(afterPublish[1].id, original.id);
  assert.equal(afterPublish[1].status, 'superseded');
  assert.equal(afterPublish[0].base_version_id, original.id);
  pass('публикация сменила live-контент и статусы версий 1–2');

  const rollback = await createDraft(token, publishedChanged.id, ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  assertVersionMetadata(rollback, 3, 'draft');
  assert.equal(rollback.base_version_id, publishedChanged.id);
  const publishedRollback = await publish(token, rollback.id, publishedChanged.id);
  assertVersionMetadata(publishedRollback, 3, 'published');
  assertLive(await liveAgent(token), ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  const afterRollback = await history(token);
  assert.equal(afterRollback.length, 3);
  assert.deepEqual(afterRollback.map((version) => version.status), ['published', 'superseded', 'superseded']);
  assert.equal(afterRollback[0].base_version_id, publishedChanged.id);
  assertLive(afterRollback[0], ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  pass('откат восстановил содержимое новой опубликованной версией 3');

  const staleBase = await request('POST', `/webhook/admin/agents/${AGENT_ID}/drafts`, {
    token,
    body: {
      description: CHANGED_DESCRIPTION,
      system_prompt: CHANGED_PROMPT,
      base_version_id: original.id,
    },
  });
  assert.equal(staleBase.status, 409, 'устаревшая база черновика не дала HTTP 409');
  assert.equal((await history(token)).length, 3);
  assertLive(await liveAgent(token), ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  pass('создание черновика от устаревшей базы отклонено с HTTP 409');

  const staleDraft = await createDraft(token, publishedRollback.id, CHANGED_DESCRIPTION, STALE_PROMPT);
  assertVersionMetadata(staleDraft, 4, 'draft');
  const stalePublish = await request('POST', `/webhook/admin/agents/${AGENT_ID}/versions/${staleDraft.id}/publish`, {
    token,
    body: { expected_published_version_id: original.id },
  });
  assert.equal(stalePublish.status, 409, 'устаревшая действующая версия не дала HTTP 409');
  assertLive(await liveAgent(token), ORIGINAL_DESCRIPTION, ORIGINAL_PROMPT);
  const conflictState = await ok('GET', `/webhook/admin/agents/${AGENT_ID}/state`, { token });
  assert.equal(conflictState.published.id, publishedRollback.id);
  assert.equal(conflictState.draft.id, staleDraft.id);
  assert.equal(conflictState.draft.status, 'draft');
  pass('публикация со stale expected id отклонена с HTTP 409, live не изменился');
}

async function cleanup() {
  if (!mayCleanup) return;
  await sshPsql(
    `BEGIN;
     DELETE FROM agent_versions
       WHERE agent_id = ${AGENT_ID}
         AND EXISTS (SELECT 1 FROM agents WHERE id = ${AGENT_ID} AND name = '${AGENT_NAME}');
     DELETE FROM agents WHERE id = ${AGENT_ID} AND name = '${AGENT_NAME}';
     COMMIT;`,
    dbOptions,
  );
  pass('временный ассистент и его версии удалены одной DB-транзакцией');
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
  console.error(`✗ ${error?.message || error}`);
} finally {
  try {
    await cleanup();
  } catch (error) {
    failure ||= error;
    console.error(`✗ чистка: ${error?.message || error}`);
  }
}

if (failure) process.exitCode = 1;
else console.log('✓ все проверки версионной публикации зелёные');
