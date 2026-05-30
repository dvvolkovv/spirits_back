#!/usr/bin/env node
/**
 * Synthetic E2E runner for my.linkeon.io.
 *
 * Runs a fixed set of canary scenarios against the live prod URL and
 * pushes per-scenario results to /webhook/monitoring/synthetic/push
 * authenticated with SYNTHETIC_PUSH_TOKEN.
 *
 * Intended to be executed by cron on node-3 every ~5 minutes.
 *
 * Env:
 *   BASE_URL              (default https://my.linkeon.io)
 *   SYNTHETIC_PUSH_TOKEN  (required)
 *   TEST_PHONE            (default 70000000000)
 *   ADMIN_PHONE           (default 79030169187)
 */

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TOKEN = process.env.SYNTHETIC_PUSH_TOKEN || '';
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '79030169187';
const TIMEOUT_MS = 30_000;

const SMS_UUID   = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_UUID = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const AGENT_UUID = '0cdacf32-7bfd-4888-b24f-3a6af3b5f99e';

if (!TOKEN) {
  console.error('SYNTHETIC_PUSH_TOKEN not set');
  process.exit(2);
}

const fetchTimeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

async function signIn(phone) {
  // Initiate + read code from Redis via debug endpoint + complete login.
  const ft1 = fetchTimeout(TIMEOUT_MS);
  await fetch(`${BASE}/webhook/${SMS_UUID}/sms/${phone}`, { signal: ft1.signal }); ft1.done();
  const ft2 = fetchTimeout(TIMEOUT_MS);
  const codeRes = await fetch(`${BASE}/webhook/debug/sms-code/${phone}`, { signal: ft2.signal }); ft2.done();
  const codeJson = await codeRes.json().catch(() => ({}));
  const code = codeJson?.code;
  if (!code) throw new Error('no debug code (DEBUG_SMS_CODES off?)');
  const ft3 = fetchTimeout(TIMEOUT_MS);
  const loginRes = await fetch(`${BASE}/webhook/${CHECK_UUID}/check-code/${phone}/${code}`, { signal: ft3.signal }); ft3.done();
  const loginJson = await loginRes.json();
  if (!loginJson['access-token']) throw new Error('no access-token in check-code response');
  return loginJson['access-token'];
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
  // Read up to ~1 KB to confirm we got streamed content.
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

const scenarios = (jwtUser, jwtAdmin) => [
  {
    key: 'agents_endpoint',
    label: 'GET /agents — ≥ 10',
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
    key: 'auth_flow_sms',
    label: 'SMS → OTP → JWT',
    run: async () => { await signIn(TEST_PHONE); return null; },
  },
  {
    key: 'profile_with_jwt',
    label: 'GET /profile',
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
    label: 'GET /user/tokens',
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
    label: 'POST /soulmate/chat — stream',
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
    label: 'GET agent avatar (Райя=14)',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/${AGENT_UUID}/agent/avatar/14`, { signal: ft.signal, redirect: 'follow' }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) throw new Error(`bad content-type ${ct}`);
      return null;
    },
  },
  {
    key: 'admin_monitoring_overview',
    label: 'GET /admin/monitoring/tech/overview',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/admin/monitoring/tech/overview`, {
        headers: { Authorization: `Bearer ${jwtAdmin}` }, signal: ft.signal,
      }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j?.nodes) || j.nodes.length === 0) throw new Error('no nodes in response');
      return null;
    },
  },
  {
    key: 'funnel_endpoint',
    label: 'GET /admin/monitoring/funnel',
    run: async () => {
      const ft = fetchTimeout(TIMEOUT_MS);
      const r = await fetch(`${BASE}/webhook/admin/monitoring/funnel`, {
        headers: { Authorization: `Bearer ${jwtAdmin}` }, signal: ft.signal,
      }); ft.done();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return null;
    },
  },
];

async function push(scenario, success, durationMs, message) {
  try {
    await fetch(`${BASE}/webhook/monitoring/synthetic/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-synthetic-token': TOKEN,
      },
      body: JSON.stringify({ scenario, success, duration_ms: durationMs, message }),
    });
  } catch (e) {
    console.error(`push failed for ${scenario}: ${e.message}`);
  }
}

(async () => {
  let jwtUser, jwtAdmin;
  try { jwtUser = await signIn(TEST_PHONE); } catch (e) {
    console.error(`bootstrap user sign-in failed: ${e.message}`);
  }
  try { jwtAdmin = await signIn(ADMIN_PHONE); } catch (e) {
    console.error(`bootstrap admin sign-in failed: ${e.message}`);
  }

  const list = scenarios(jwtUser, jwtAdmin);
  const results = await Promise.all(list.map(async (s) => {
    const t0 = Date.now();
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
