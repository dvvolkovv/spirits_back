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
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TOKEN = process.env.SYNTHETIC_PUSH_TOKEN || '';
const STATE_FILE = process.env.SYNTHETIC_STATE_FILE || '/var/lib/synthetic/state.json';
const TIMEOUT_MS = 30_000;
const AGENT_UUID = '0cdacf32-7bfd-4888-b24f-3a6af3b5f99e';

if (!TOKEN) {
  console.error('SYNTHETIC_PUSH_TOKEN not set');
  process.exit(2);
}

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
  let total = 0;
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 1024) break;
  }
  reader.cancel().catch(() => {});
  if (total === 0) throw new Error('stream ended empty');
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
    key: 'refresh_jwt',
    run: async () => {
      // Whole refresh flow is the auth scenario (no SMS involved).
      // Bootstrap loadRefresh already happened; we re-run to verify.
      const access = await refreshTokens();
      if (!access) throw new Error('no access-token from refresh');
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
      const bytes = await streamFirstByte(`${BASE}/webhook/soulmate/chat`, {
        auth: `Bearer ${jwtUser}`,
        payload: { chatInput: 'ping (synthetic)', assistant: '12' },
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
    await fetch(`${BASE}/webhook/monitoring/synthetic/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synthetic-token': TOKEN },
      body: JSON.stringify({ scenario, success, duration_ms: durationMs, message }),
    });
  } catch (e) {
    console.error(`push failed for ${scenario}: ${e.message}`);
  }
}

(async () => {
  let jwtUser = null;
  try {
    jwtUser = await refreshTokens();
  } catch (e) {
    console.error(`bootstrap refresh failed: ${e.message}`);
    // Report bootstrap as a failed scenario so the UI surfaces it.
    await push('refresh_jwt', false, 0, e.message?.slice(0, 200) || 'refresh failed');
  }

  const list = scenarios(jwtUser);
  const results = await Promise.all(list.map(async (s) => {
    const t0 = Date.now();
    if (s.key !== 'agents_endpoint' && s.key !== 'agent_avatar' && s.key !== 'refresh_jwt' && !jwtUser) {
      return { key: s.key, ok: false, ms: 0, message: 'no JWT (refresh failed)' };
    }
    try {
      const note = await s.run();
      return { key: s.key, ok: true, ms: Date.now() - t0, message: note || null };
    } catch (e) {
      return { key: s.key, ok: false, ms: Date.now() - t0, message: e?.message?.slice(0, 200) || 'unknown' };
    }
  }));

  for (const r of results) {
    await push(r.key, r.ok, r.ms, r.message);
    const flag = r.ok ? 'OK ' : 'FAIL';
    console.log(`${flag}  ${r.key.padEnd(28)} ${r.ms}ms  ${r.message || ''}`);
  }
})();
