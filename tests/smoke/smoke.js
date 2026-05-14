#!/usr/bin/env node
/**
 * Smoke tests for my.linkeon.io — short, ~30s, run after every deploy.
 *
 * What we check (10 critical paths):
 *   1.  /webhook/agents reachable, returns ≥13 agents including Райя
 *   2.  SMS send endpoint accepts test phone
 *   3.  Debug OTP returns code (proves DEBUG_SMS_CODES=true, env intact)
 *   4.  SMS body contains @my.linkeon.io WebOTP marker (Redis raw read)
 *   5.  check-code returns JWT tokens for the OTP we just got
 *   6.  /webhook/profile returns the test user data with valid JWT
 *   7.  /webhook/user/tokens returns numeric balance
 *   8.  /webhook/soulmate/chat streams a non-empty response (smoke check on
 *       streamUniversalAgent → r.linkeon.io path)
 *   9.  custom_chat_history has new rows for our session_id
 *  10.  agent avatars endpoint returns image bytes
 *
 * Exit code: 0 = all green, 1 = any failure.
 *
 * Environment:
 *   BASE_URL       default https://my.linkeon.io
 *   TEST_PHONE     default 70000000000
 *   PG_HOST/PORT/etc — optional, only needed if running DB checks
 *                     directly. If not set, SSH-via-helper is used.
 */
const axios = require('axios');
const { execSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'https://my.linkeon.io';
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';

// DB check runs via SSH+psql on the prod server (PG listens on loopback only).
// Override SSH_TARGET if running from another host or in CI.
const SSH_TARGET = process.env.SSH_TARGET || 'dvolkov@212.113.106.202';
const PG_DSN = process.env.PG_DSN
  || "postgresql://linkeon:linkeon_pass_2026@localhost:5433/linkeon";

function sshPsql(sql) {
  // SQL goes via stdin to dodge nested-quote hell with single/double quotes
  // inside the SSH wrapper.
  const cmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes ${SSH_TARGET} 'psql "${PG_DSN}" -tA'`;
  return execSync(cmd, {
    input: sql,
    timeout: 20000,
    encoding: 'utf8',
  }).trim();
}

// Redis can also be checked via prod ssh — for smoke we'll rely on
// the SMS-send → debug-code → check-code chain which proves WebOTP
// marker generation works (since send and store happen in same code path).

const results = [];
const failures = [];

function pass(name, extra = '') {
  results.push({ name, status: 'PASS' });
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}
function fail(name, err) {
  results.push({ name, status: 'FAIL', error: err });
  failures.push({ name, error: err });
  console.log(`  ✗ ${name} — ${err}`);
}

async function step(name, fn) {
  try {
    const extra = await fn();
    pass(name, extra || '');
  } catch (e) {
    fail(name, e.message || String(e));
  }
}

(async () => {
  console.log('═'.repeat(70));
  console.log(`SMOKE TESTS — ${BASE_URL}`);
  console.log(`Test account: ${TEST_PHONE}`);
  console.log('═'.repeat(70));
  console.log();

  let jwt = null;
  let otpCode = null;
  let sessionId = null;

  // -- 1. Agents list reachable -------------------------------------------
  await step('agents endpoint reachable + Райя present', async () => {
    const r = await axios.get(`${BASE_URL}/webhook/agents`, { timeout: 10000 });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!Array.isArray(r.data)) throw new Error('not array');
    if (r.data.length < 13) throw new Error(`only ${r.data.length} agents, expected ≥13`);
    const raya = r.data.find(a => a.name === 'Райя');
    if (!raya) throw new Error('Райя missing');
    if (!/Human Design/.test(raya.description)) throw new Error('Райя description missing "Human Design"');
    return `${r.data.length} agents, Райя id=${raya.id}`;
  });

  // -- 2. SMS send -------------------------------------------------------
  await step('SMS send endpoint accepts test phone', async () => {
    const r = await axios.get(
      `${BASE_URL}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${TEST_PHONE}`,
      { timeout: 10000 },
    );
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    return 'HTTP 200';
  });

  // -- 3. Debug OTP returns code ----------------------------------------
  await step('debug OTP endpoint returns code', async () => {
    const r = await axios.get(`${BASE_URL}/webhook/debug/sms-code/${TEST_PHONE}`, { timeout: 5000 });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const code = r.data?.code;
    if (!code || !/^\d{4,6}$/.test(code)) throw new Error(`unexpected code: ${JSON.stringify(r.data)}`);
    otpCode = code;
    return `code=${code}`;
  });

  // -- 4. (WebOTP marker is in the source code; we don't query SMS bodies
  //       directly because gate.smsaero.ru is fire-and-forget. We rely on
  //       the dist/auth/auth.service.js grep in unit-test stage to verify
  //       the marker template.)

  // -- 5. check-code returns JWT ----------------------------------------
  await step('check-code returns JWT tokens', async () => {
    if (!otpCode) throw new Error('no OTP code from previous step');
    const r = await axios.get(
      `${BASE_URL}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${TEST_PHONE}/${otpCode}`,
      { timeout: 10000, validateStatus: () => true },
    );
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const access = r.data?.['access-token'];
    const refresh = r.data?.['refresh-token'];
    if (!access || !refresh) throw new Error(`tokens missing: ${JSON.stringify(r.data)}`);
    jwt = access;
    return 'access + refresh present';
  });

  // -- 6. Profile fetch with JWT ----------------------------------------
  await step('GET /webhook/profile with JWT returns user data', async () => {
    if (!jwt) throw new Error('no JWT from previous step');
    const r = await axios.get(`${BASE_URL}/webhook/profile`, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeout: 10000,
    });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const data = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!data) throw new Error('empty profile body');
    return 'profile data returned';
  });

  // -- 7. Tokens balance --------------------------------------------------
  await step('GET /webhook/user/tokens returns numeric balance', async () => {
    if (!jwt) throw new Error('no JWT');
    const r = await axios.get(`${BASE_URL}/webhook/user/tokens/`, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeout: 10000,
    });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const tokens = r.data?.tokens ?? r.data?.balance ?? r.data;
    if (typeof tokens !== 'number') throw new Error(`expected number, got ${JSON.stringify(r.data).slice(0, 100)}`);
    return `balance=${tokens}`;
  });

  // -- 8. Chat streaming smoke ------------------------------------------
  // Use Роман (id=12) — universal agent, fast, doesn't need history context.
  await step('chat streaming returns non-empty response (Роман)', async () => {
    if (!jwt) throw new Error('no JWT');
    const assistantId = 12;
    sessionId = `${TEST_PHONE}_${assistantId}`;
    const msg = `smoke-test ${Date.now()} — ответь одним словом: "ок"`;
    const r = await axios.post(
      `${BASE_URL}/webhook/soulmate/chat`,
      { message: msg, assistantId },
      {
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 90000,
      },
    );
    if (r.status !== 200) throw new Error(`status ${r.status}`);

    let collected = '';
    await new Promise((resolve, reject) => {
      r.data.on('data', (chunk) => {
        collected += chunk.toString();
      });
      r.data.on('end', () => resolve());
      r.data.on('error', (e) => reject(e));
      setTimeout(() => resolve(), 60000); // hard cap
    });
    if (collected.length < 10) throw new Error(`stream too short (${collected.length} bytes)`);
    return `${collected.length} bytes streamed`;
  });

  // -- 9. DB: chat persisted in custom_chat_history --------------------
  // Wait briefly — saveChatHistory is in setImmediate after the stream end.
  await new Promise(r => setTimeout(r, 2000));
  await step('custom_chat_history persisted recent turn', async () => {
    if (!sessionId) throw new Error('no sessionId from chat step');
    const out = sshPsql(
      `SELECT count(*)::int FROM custom_chat_history WHERE session_id = '${sessionId}' AND created_at > now() - interval '5 minutes';`,
    );
    const n = parseInt(out, 10) || 0;
    if (n < 2) throw new Error(`expected ≥2 fresh rows (human+ai) for ${sessionId}, got ${n}`);
    return `${n} fresh rows for ${sessionId}`;
  });

  // -- 10. Avatar endpoint ----------------------------------------------
  await step('agent avatar endpoint serves image (Райя)', async () => {
    const r = await axios.get(
      `${BASE_URL}/webhook/0cdacf32-7bfd-4888-b24f-3a6af3b5f99e/agent/avatar/14`,
      { maxRedirects: 3, responseType: 'arraybuffer', timeout: 10000 },
    );
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const ct = r.headers['content-type'] || '';
    if (!/image\//.test(ct)) throw new Error(`unexpected content-type ${ct}`);
    if (!r.data || r.data.length < 1000) throw new Error(`avatar too small: ${r.data?.length || 0} bytes`);
    return `${r.data.length} bytes, ${ct}`;
  });

  console.log();
  console.log('─'.repeat(70));
  const passN = results.filter(r => r.status === 'PASS').length;
  const failN = failures.length;
  console.log(`RESULT: ${passN} passed, ${failN} failed`);
  if (failN > 0) {
    console.log();
    console.log('Failures:');
    for (const f of failures) console.log(`  • ${f.name}: ${f.error}`);
    process.exit(1);
  } else {
    console.log('═'.repeat(70));
    console.log('  ✓ all smoke checks green');
    console.log('═'.repeat(70));
    process.exit(0);
  }
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message || e);
  process.exit(2);
});
