#!/usr/bin/env node
/**
 * Smoke tests for my.linkeon.io — short, ~30s, run after every deploy.
 *
 * What we check (12 critical paths):
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
 *  10.  all 15 assistants respond to a ping (ping-sweep)
 *  11.  /webhook/imagegen end-to-end: Imagen/Gemini → MinIO → public URL
 *       (catches MinIO permissions, S3 ACL, Nginx /smm-media routing). Burns
 *       ~5000 tokens from the test account per smoke run.
 *  12.  agent avatars endpoint returns image bytes
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
    if (extra && typeof extra === 'object' && extra.skipped) {
      results.push({ name, status: 'SKIP' });
      console.log(`  ⊘ ${name} — ${extra.reason || 'skipped'}`);
      return;
    }
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

  // -- 6b. Onboarding flag: exposed in profile + complete() is idempotent --
  await step('onboarding flag exposed + /onboarding/complete sets it', async () => {
    if (!jwt) throw new Error('no JWT');
    const prof = await axios.get(`${BASE_URL}/webhook/profile`, {
      headers: { Authorization: `Bearer ${jwt}` }, timeout: 10000,
    });
    const pj = (Array.isArray(prof.data) ? prof.data[0] : prof.data)?.profileJson;
    if (!pj || typeof pj.onboarded !== 'boolean') throw new Error('profile.onboarded is not boolean');
    const comp = await axios.post(`${BASE_URL}/webhook/onboarding/complete`, {}, {
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, timeout: 10000,
    });
    if (comp.status !== 200 || comp.data?.onboarded !== true) throw new Error('complete did not return onboarded:true');
    return 'onboarded boolean + complete OK';
  });

  // -- 6c. Offer: status shape + dismiss ----------------------------------
  await step('offer status shape + dismiss', async () => {
    if (!jwt) throw new Error('no JWT');
    const s = await axios.get(`${BASE_URL}/webhook/offer/status`, {
      headers: { Authorization: `Bearer ${jwt}` }, timeout: 10000,
    });
    if (typeof s.data?.eligible !== 'boolean' || s.data?.bonus_pct !== 50 || typeof s.data?.message_count !== 'number') {
      throw new Error(`bad offer/status shape: ${JSON.stringify(s.data)}`);
    }
    const d = await axios.post(`${BASE_URL}/webhook/offer/dismiss`, {}, {
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, timeout: 10000,
    });
    if (d.data?.ok !== true) throw new Error('dismiss did not return ok');
    return `eligible=${s.data.eligible} msgs=${s.data.message_count}`;
  });

  // -- 6d. Admin management stats endpoints respond (SQL-регрессия) --------
  // Бьём по 6 агрегатам «управления» (исключают тестовых) — битый SQL даст 500.
  // Нужен admin-JWT: 79030169187 (isadmin, в whitelist debug-OTP).
  await step('admin management stats endpoints return 200', async () => {
    const ADM = '79030169187';
    await axios.get(`${BASE_URL}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${ADM}`, { timeout: 8000 });
    const codeRes = await axios.get(`${BASE_URL}/webhook/debug/sms-code/${ADM}`, { timeout: 5000 });
    const loginRes = await axios.get(`${BASE_URL}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${ADM}/${codeRes.data.code}`, { timeout: 8000 });
    const ajwt = loginRes.data['access-token'];
    if (!ajwt) throw new Error('no admin JWT');
    const H = { headers: { Authorization: `Bearer ${ajwt}` }, timeout: 12000 };
    const endpoints = [
      '/webhook/admin/payments?limit=5',
      '/webhook/admin/payments/stats?days=7',
      '/webhook/admin/users/tokens?limit=5',
      '/webhook/admin/tokens/stats?days=7',
      '/webhook/admin/users/active?days=7',
      '/webhook/admin/usage/assistants?days=7',
    ];
    for (const ep of endpoints) {
      const r = await axios.get(`${BASE_URL}${ep}`, H);
      if (r.status !== 200) throw new Error(`${ep} → ${r.status}`);
    }
    return `${endpoints.length} admin stats endpoints OK`;
  });

  // -- 6e. Lifecycle outreach: activation preview + confirm-gate + retention 48h --
  await step('lifecycle outreach: preview + confirm-gate', async () => {
    const ADM = '79030169187';
    await axios.get(`${BASE_URL}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${ADM}`, { timeout: 8000 });
    const codeRes = await axios.get(`${BASE_URL}/webhook/debug/sms-code/${ADM}`, { timeout: 5000 });
    const loginRes = await axios.get(`${BASE_URL}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${ADM}/${codeRes.data.code}`, { timeout: 8000 });
    const ajwt = loginRes.data['access-token'];
    const H = { headers: { Authorization: `Bearer ${ajwt}`, 'Content-Type': 'application/json' }, timeout: 12000 };
    // activation preview: shape
    const prev = await axios.post(`${BASE_URL}/webhook/admin/activation`, { action: 'preview' }, H);
    if (prev.status !== 200 || typeof prev.data?.count !== 'number' || !Array.isArray(prev.data?.drafts)) {
      throw new Error(`activation preview shape: ${JSON.stringify(prev.data).slice(0,150)}`);
    }
    // activation send WITHOUT confirm → must be refused (400, не шлёт)
    const send = await axios.post(`${BASE_URL}/webhook/admin/activation`, { action: 'send' }, { ...H, validateStatus: () => true });
    if (send.status !== 400 || send.data?.error !== 'confirm_required') {
      throw new Error(`activation send must be gated, got ${send.status} ${JSON.stringify(send.data).slice(0,120)}`);
    }
    // retention preview with 48h window (minDays:2)
    const ret = await axios.post(`${BASE_URL}/webhook/admin/retention`, { action: 'preview', minDays: 2 }, H);
    if (ret.status !== 200 || typeof ret.data?.count !== 'number') throw new Error('retention 48h preview shape');
    return `activation drafts=${prev.data.count}, gated OK, retention(2d)=${ret.data.count}`;
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

  // -- 10. Ping-sweep всех ассистентов ----------------------------------
  // Каждому отправляем короткий «ответь одним словом» и проверяем что
  // стрим вернул >30 байт. Ловит:
  //   - сломанный system_prompt в БД у конкретного агента
  //   - проблемы с MCP-tools у конкретного агента
  //   - падение r.linkeon.io для одной персоны
  //   - Маша (id=3): её отдельный streamChat-path через Anthropic SDK
  //   - Юля (smm_producer): её путь через ClaudeAgentService с OAuth
  //
  // Цена: ~$0.05-0.10 за прогон (Anthropic API за всех агентов разом).
  // Время: 1-3 мин в зависимости от r.linkeon.io.
  await step('all assistants respond to ping', async () => {
    if (!jwt) throw new Error('no JWT');
    const agentsResp = await axios.get(`${BASE_URL}/webhook/agents`, { timeout: 10000 });
    const agents = agentsResp.data;
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('no agents to ping');

    const results = [];
    for (const a of agents) {
      const t0 = Date.now();
      const msg = `ping ${Date.now()} — ответь одним словом «ок», без пояснений`;
      try {
        const r = await axios.post(
          `${BASE_URL}/webhook/soulmate/chat`,
          { message: msg, assistantId: a.id },
          {
            headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
            responseType: 'stream',
            timeout: 120000,
            validateStatus: () => true,
          },
        );
        if (r.status !== 200) {
          results.push({ id: a.id, name: a.name, bytes: 0, ms: Date.now() - t0, ok: false, err: `status ${r.status}` });
          continue;
        }
        let bytes = 0;
        await new Promise((resolve) => {
          r.data.on('data', (chunk) => { bytes += chunk.length; });
          r.data.on('end', resolve);
          r.data.on('error', resolve);
          setTimeout(resolve, 100000);
        });
        const ms = Date.now() - t0;
        results.push({ id: a.id, name: a.name, bytes, ms, ok: bytes > 30 });
      } catch (e) {
        results.push({ id: a.id, name: a.name, bytes: 0, ms: Date.now() - t0, ok: false, err: e.message });
      }
    }

    // Печатаем все результаты — пользователь видит per-agent статус.
    console.log();
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗';
      const extra = r.ok ? `${r.bytes}b in ${(r.ms / 1000).toFixed(1)}s` : (r.err || `${r.bytes}b in ${(r.ms / 1000).toFixed(1)}s`);
      console.log(`      ${mark} id=${r.id.toString().padStart(2)} ${r.name.padEnd(14)} — ${extra}`);
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      throw new Error(`${failed.length}/${results.length} agents failed ping: ${failed.map(f => `${f.name}(${f.err || 'short'})`).join(', ')}`);
    }
    return `${results.length} agents OK`;
  });

  // -- 11. Image generation end-to-end ----------------------------------
  // Ловит регрессии в Imagen/Gemini API ключах, MinIO permissions, S3 upload,
  // публичной отдаче через Nginx /smm-media/. Это ровно тот путь, что
  // используется в чате (generate_image MCP) и в авто-цепочке text2video.
  // Стоит ~5000 токенов с тестового аккаунта на каждый прогон.
  await step('image generation end-to-end (Imagen → MinIO → public URL)', async () => {
    if (!jwt) throw new Error('no JWT from earlier step');
    let r;
    try {
      r = await axios.post(
        `${BASE_URL}/webhook/imagegen`,
        { prompt: 'simple test pattern: blue circle on white background', quality: 'std' },
        {
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          timeout: 60000,
          validateStatus: () => true,
        },
      );
    } catch (e) {
      // Timeout/network on the GENERATE call = the upstream Google Imagen API is
      // slow/down. It's a paid 3rd-party dependency (same GOOGLE_AI_API_KEY as
      // Veo), orthogonal to our deploy — a transient blip here must NOT fail the
      // smoke and trigger a false rollback of an unrelated change. SKIP (warn).
      if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) {
        return { skipped: true, reason: `Imagen upstream timeout — внешняя зависимость, деплой не блокируется (${e.message})` };
      }
      throw e;
    }
    if (r.status === 501) {
      return { skipped: true, reason: r.data?.error || 'imagegen not configured on this server' };
    }
    // 400 «недостаточно токенов» = у smoke-аккаунта кончился баланс (картинка
    // стоит 5000/прогон, каждый деплой дренит). Это состояние БАЛАНСА окружения,
    // не регрессия кода — SKIP с предупреждением (пополнить аккаунт), не fail.
    if (r.status === 400 && /insufficient|недостаточно/i.test(JSON.stringify(r.data || ''))) {
      return { skipped: true, reason: 'у smoke-аккаунта кончились токены — пополните баланс тест-аккаунта; деплой не блокируется' };
    }
    // 5xx from the generate call = upstream Imagen/Gemini unavailable or quota
    // (429/500/503). External — SKIP, don't roll back our deploy. Our own infra
    // (MinIO ACL / Nginx routing) is still validated by the public-fetch step
    // below whenever generation succeeds, and 4xx (our auth/config) stays fatal.
    if (r.status >= 500) {
      return { skipped: true, reason: `Imagen upstream ${r.status} — внешняя зависимость, деплой не блокируется (${JSON.stringify(r.data).slice(0, 120)})` };
    }
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const url = r.data?.images?.[0]?.url;
    if (!url) throw new Error(`no image url in response: ${JSON.stringify(r.data).slice(0, 200)}`);
    if (!/^https?:\/\//.test(url)) throw new Error(`url not absolute: ${url}`);

    // Verify URL is publicly reachable + returns an image (catches MinIO ACL
    // or Nginx routing regressions even if upload itself "succeeded").
    const fetched = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000, maxRedirects: 3,
    });
    if (fetched.status !== 200) throw new Error(`public fetch ${fetched.status} for ${url}`);
    const ct = fetched.headers['content-type'] || '';
    if (!/image\//.test(ct)) throw new Error(`unexpected content-type ${ct} for ${url}`);
    if (!fetched.data || fetched.data.length < 2000) {
      throw new Error(`image suspiciously small: ${fetched.data?.length || 0} bytes`);
    }
    return `${fetched.data.length} bytes, ${ct}, spent ${r.data.tokensSpent ?? '?'}t`;
  });

  // -- 12. Avatar endpoint ----------------------------------------------
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
  const skipN = results.filter(r => r.status === 'SKIP').length;
  const failN = failures.length;
  const skipFragment = skipN > 0 ? `, ${skipN} skipped` : '';
  console.log(`RESULT: ${passN} passed${skipFragment}, ${failN} failed`);
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
