#!/usr/bin/env node
/**
 * Synthetic E2E runner for my.linkeon.io.
 *
 * Designed to NOT trigger SMS Aero. Bootstrap uses a long-lived
 * refresh token stored in env (SYNTHETIC_TEST_REFRESH_JWT). After
 * each successful refresh we write the rotated refresh-token back
 * to STATE_FILE so the token stays fresh forever as long as the
 * cron runs at least once per 30 days.
 *
 * Env:
 *   BASE_URL                       (default https://my.linkeon.io)
 *   SYNTHETIC_PUSH_TOKEN           (required)
 *   SYNTHETIC_TEST_REFRESH_JWT     (required — bootstrap value)
 *   SYNTHETIC_STATE_FILE           (default /var/lib/synthetic/state.json)
 *   SYNTHETIC_REFRESH_ATTEMPTS     (default 3)
 *   SYNTHETIC_RETRY_BASE_MS        (default 1500)
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TOKEN = process.env.SYNTHETIC_PUSH_TOKEN || '';
const STATE_FILE = process.env.SYNTHETIC_STATE_FILE || '/var/lib/synthetic/state.json';
const TIMEOUT_MS = 30_000;
const AGENT_UUID = '0cdacf32-7bfd-4888-b24f-3a6af3b5f99e';
const REFRESH_ATTEMPTS = Number(process.env.SYNTHETIC_REFRESH_ATTEMPTS || 3);
const RETRY_BASE_MS = Number(process.env.SYNTHETIC_RETRY_BASE_MS || 1500);
// Сценарии, которым нужен JWT. Список именно положительный: раньше здесь было
// перечисление исключений («всё, кроме agents_endpoint, agent_avatar и
// refresh_jwt»), и в него молча попадал сам refresh_jwt.
const NEEDS_JWT = ['profile_with_jwt', 'tokens_balance', 'chat_streaming'];

// Load most recent refresh token from state file (preferred) or fall back
// to env bootstrap value.
function loadRefresh() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.refreshToken) return s.refreshToken;
  } catch {}
  return process.env.SYNTHETIC_TEST_REFRESH_JWT || '';
}

function saveRefresh(refresh) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ refreshToken: refresh, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.error(`could not persist refresh: ${e.message}`);
  }
}

const fetchTimeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

async function refreshTokens() {
  const refresh = loadRefresh();
  if (!refresh) throw new Error('no refresh token configured');
  const ft = fetchTimeout(TIMEOUT_MS);
  const r = await fetch(`${BASE}/webhook/auth/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refresh}` },
    signal: ft.signal,
  });
  ft.done();
  if (!r.ok) throw new Error(`refresh HTTP ${r.status}`);
  const j = await r.json();
  const access = j['access-token'];
  const newRefresh = j['refresh-token'];
  if (!access) throw new Error('refresh returned no access-token');
  if (newRefresh && newRefresh !== refresh) saveRefresh(newRefresh);
  return access;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Инцидент 2026-08-21 10:30 UTC: одиночный исходящий коннект с node-3 подвис,
 * AbortController убил его на 30-й секунде, и раннер без единого ретрая
 * пометил красными три сценария — включая критичный chat_streaming, который
 * при этом даже не запускался. Через секунду тот же запрос прошёл за 263 мс.
 *
 * Повтор безопасен: refresh на бэке stateless (проверка подписи + выдача новой
 * пары, старый токен не отзывается — auth.service.ts refreshTokens), поэтому
 * повторная попытка не сжигает токен и не ломает следующий прогон.
 */
async function refreshWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
    try {
      return await refreshTokens();
    } catch (e) {
      lastErr = e;
      console.error(`refresh attempt ${attempt}/${REFRESH_ATTEMPTS} failed: ${e.message}`);
      if (attempt < REFRESH_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
    }
  }
  throw new Error(`${lastErr?.message || 'refresh failed'} (попыток: ${REFRESH_ATTEMPTS})`);
}

// Плейсхолдеры, которые бэк/relay отдают ЮЗЕРУ при недоступности модели.
// Байты приходят (стрим «работает»), но это не ответ AI — сбой. Инцидент
// 2026-07-10: OAuth-токен relay протух, все ответы = «временный сбой…»,
// а synthetic 8 часов рапортовал зелёным, потому что считал только байты.
const AI_ERROR_MARKERS = [
  'временный сбой связи с моделью',
  'Ответ не пришёл',
  'Ошибка запуска агента',
  'сессия была очищена',
];

async function streamFirstByte(url, body) {
  const ft = fetchTimeout(TIMEOUT_MS);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: body.auth,
    },
    body: JSON.stringify(body.payload),
    signal: ft.signal,
  });
  ft.done();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (total > 4096) break;
  }
  reader.cancel().catch(() => {});
  if (total === 0) throw new Error('stream ended empty');
  const marker = AI_ERROR_MARKERS.find((m) => text.includes(m));
  if (marker) throw new Error(`AI error placeholder in stream: «${marker}»`);
  return total;
}

const scenarios = (jwtUser) => [
  {
    key: 'agents_endpoint',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/agents`, { signal: ft.signal }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j) || j.length < 10) throw new Error(`got ${Array.isArray(j) ? j.length : 'non-array'} agents`);
      return null;
    },
  },
  {
    key: 'profile_with_jwt',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/profile`, {
        headers: { Authorization: `Bearer ${jwtUser}` }, signal: ft.signal,
      }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return null;
    },
  },
  {
    key: 'tokens_balance',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/user/tokens/`, {
        headers: { Authorization: `Bearer ${jwtUser}` }, signal: ft.signal,
      }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (typeof j?.tokens !== 'number' && typeof j !== 'number') throw new Error('no numeric tokens field');
      return null;
    },
  },
  {
    key: 'chat_streaming',
    run: async () => {
      // fresh=true: проба идёт «чистым листом», в свою одноразовую сессию.
      // Без этого 96 проб в сутки уходили в ОДНУ постоянную сессию
      // `70000000000_12`, релей резюмил её через `--resume`, и каждая
      // следующая проба перечитывала весь накопленный транскрипт: цена
      // одного «ping (synthetic)» росла с $0.26 до $0.66, а на протухшем
      // кэше доходила до $6. Одноразовая сессия стоит ровно холодный старт.
      const bytes = await streamFirstByte(`${BASE}/webhook/soulmate/chat`, {
        auth: `Bearer ${jwtUser}`,
        payload: { chatInput: 'ping (synthetic)', assistant: '12', fresh: true, freshTs: Date.now() },
      });
      return `${bytes} bytes received`;
    },
  },
  {
    key: 'agent_avatar',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/${AGENT_UUID}/agent/avatar/14`, { signal: ft.signal, redirect: 'follow' }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) throw new Error(`bad content-type ${ct}`);
      return null;
    },
  },
];

async function push(scenario, success, durationMs, message) {
  try {
    const r = await fetch(`${BASE}/webhook/monitoring/synthetic/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synthetic-token': TOKEN },
      body: JSON.stringify({ scenario, success, duration_ms: durationMs, message }),
    });
    // fetch НЕ бросает на 4xx/5xx — обязательно проверяем статус, иначе
    // отвергнутый пуш (напр. 401 при рассинхроне SYNTHETIC_PUSH_TOKEN) уходит
    // молча и мониторинг «слепнет» (инцидент 2026-05-31). Логируем + ненулевой код.
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`push REJECTED for ${scenario}: HTTP ${r.status} ${body.slice(0, 120)}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`push failed for ${scenario}: ${e.message}`);
    process.exitCode = 1;
  }
}

async function runAll() {
  // Авторизация — это и есть сценарий refresh_jwt, одна попытка на прогон.
  // Раньше их было две: bootstrap пушил refresh_jwt=false, а одноимённый
  // сценарий следом пушил true. DISTINCT ON в getOverview брал позднюю строку,
  // и дашборд показывал зелёную авторизацию рядом с красными сценариями,
  // упавшими именно из-за неё.
  const results = [];
  let jwtUser = null;
  const tAuth = Date.now();
  try {
    jwtUser = await refreshWithRetry();
    results.push({ key: 'refresh_jwt', ok: true, ms: Date.now() - tAuth, message: null });
  } catch (e) {
    console.error(`refresh failed: ${e.message}`);
    results.push({ key: 'refresh_jwt', ok: false, ms: Date.now() - tAuth, message: e?.message?.slice(0, 200) || 'refresh failed' });
  }

  const list = scenarios(jwtUser);
  const rest = await Promise.all(list.map(async (s) => {
    const t0 = Date.now();
    if (NEEDS_JWT.includes(s.key) && !jwtUser) {
      // Сценарий не выполнялся. Сообщение обязано указывать на источник, иначе
      // красный chat_streaming читается как отказ AI и уводит дежурного в релей.
      return { key: s.key, ok: false, ms: 0, message: 'не проверялся: нет JWT (причина — refresh_jwt)' };
    }
    try {
      const note = await s.run();
      return { key: s.key, ok: true, ms: Date.now() - t0, message: note || null };
    } catch (e) {
      return { key: s.key, ok: false, ms: Date.now() - t0, message: e?.message?.slice(0, 200) || 'unknown' };
    }
  }));
  results.push(...rest);

  for (const r of results) {
    await push(r.key, r.ok, r.ms, r.message);
    const flag = r.ok ? 'OK ' : 'FAIL';
    console.log(`${flag}  ${r.key.padEnd(28)} ${r.ms}ms  ${r.message || ''}`);
  }
  return results;
}

if (require.main === module) {
  if (!TOKEN) {
    console.error('SYNTHETIC_PUSH_TOKEN not set');
    process.exit(2);
  }
  runAll().catch((e) => {
    console.error(`runner crashed: ${e?.message || e}`);
    process.exitCode = 1;
  });
}

module.exports = { runAll, refreshWithRetry, refreshTokens, scenarios };
