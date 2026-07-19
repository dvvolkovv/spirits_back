#!/usr/bin/env node
/**
 * Smoke test for /webhook/calendar/* (Task 5 — HTTP endpoints for CalendarService).
 *
 * Style follows tests/smoke/smoke.js (standalone script, step()/pass()/fail()
 * helpers) and reuses the SMS-OTP login helper from tests/e2e.test.js.
 *
 * What we check:
 *   1. GET  /webhook/calendar/status   → 200 {connected:false} for a clean test account
 *   2. POST /webhook/calendar/connect  with an obviously-wrong password → {ok:false}
 *   3. Double-prefix guard: /webhook/webhook/calendar/status must NOT 200
 *      (proves the controller is @Controller('calendar'), not
 *      @Controller('webhook/calendar') — see main.ts setGlobalPrefix('webhook'))
 *
 * NOTE: this runs against a LIVE test/prod environment (Task 7 deploy time).
 * It cannot run locally — there's no server here. Verify syntax with:
 *   node --check tests/calendar-smoke.test.js
 *
 * Environment:
 *   BASE_URL     default https://my.linkeon.io (or https://test.linkeon.io in CI)
 *   TEST_PHONE   default 70000000000 (clean test account — no calendar connected)
 */
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://my.linkeon.io';
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  validateStatus: () => true,
});

// -- auth helper (reused pattern from tests/e2e.test.js loginWithOtp) --------
async function loginWithOtp(phone) {
  await http.get(`/webhook/${SMS_WH}/sms/${phone}`);
  await new Promise((r) => setTimeout(r, 1000));
  const codeResp = await http.get(`/webhook/debug/sms-code/${phone}`);
  if (!codeResp.data?.code) throw new Error(`no OTP code: ${JSON.stringify(codeResp.data)}`);
  const resp = await http.get(`/webhook/${CHECK_WH}/check-code/${phone}/${codeResp.data.code}`);
  if (!resp.data?.['access-token']) throw new Error(`login failed: ${JSON.stringify(resp.data)}`);
  return resp.data['access-token'];
}

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
  console.log(`CALENDAR SMOKE — ${BASE_URL}`);
  console.log(`Test account: ${TEST_PHONE}`);
  console.log('═'.repeat(70));
  console.log();

  let jwt = null;

  await step('login via test phone (SMS OTP) returns JWT', async () => {
    jwt = await loginWithOtp(TEST_PHONE);
    if (jwt.split('.').length !== 3) throw new Error('access-token is not a JWT');
    return 'access-token acquired';
  });

  await step('GET /webhook/calendar/status → 200 {connected:false} for clean account', async () => {
    if (!jwt) throw new Error('no JWT from login step');
    const r = await http.get('/webhook/calendar/status', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    if (r.data?.connected !== false) {
      throw new Error(`expected {connected:false} for clean test account, got ${JSON.stringify(r.data)}`);
    }
    return 'connected=false';
  });

  await step('POST /webhook/calendar/connect with wrong password → {ok:false}', async () => {
    if (!jwt) throw new Error('no JWT from login step');
    const r = await http.post(
      '/webhook/calendar/connect',
      { provider: 'yandex', username: 'smoke-test-user', appPassword: 'obviously-wrong-password' },
      { headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } },
    );
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    if (r.data?.ok !== false) throw new Error(`expected {ok:false}, got ${JSON.stringify(r.data)}`);
    return 'ok=false as expected (bad creds rejected)';
  });

  await step('single-prefix guard: /webhook/webhook/calendar/status does NOT 200', async () => {
    if (!jwt) throw new Error('no JWT from login step');
    const r = await http.get('/webhook/webhook/calendar/status', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (r.status === 200) {
      throw new Error('double-prefixed path answered 200 — controller is likely @Controller(\'webhook/calendar\')');
    }
    return `status ${r.status} (not 200, as expected)`;
  });

  console.log();
  console.log('─'.repeat(70));
  const passN = results.filter((r) => r.status === 'PASS').length;
  const failN = failures.length;
  console.log(`RESULT: ${passN} passed, ${failN} failed`);
  if (failN > 0) {
    console.log();
    console.log('Failures:');
    for (const f of failures) console.log(`  • ${f.name}: ${f.error}`);
    process.exit(1);
  } else {
    console.log('═'.repeat(70));
    console.log('  ✓ calendar smoke green');
    console.log('═'.repeat(70));
    process.exit(0);
  }
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message || e);
  process.exit(2);
});
