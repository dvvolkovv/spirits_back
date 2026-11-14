import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, loadCodexAuth } from './bridge.mjs';

const TEXT_SSE = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1","usage":{"input_tokens":9}}}',
  '',
  'event: response.content_part.added',
  'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"OK"}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message"}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":1}}}',
  '',
  '',
].join('\n');

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function makeAuthFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { access_token: 'fake-access', account_id: 'acct_42', refresh_token: 'fake-refresh' },
  }), { mode: 0o600 });
  return authPath;
}

function post(origin, target, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target, origin);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

// Тело — сырой строкой (для проверок malformed JSON и content-type)
function postRaw(origin, target, bodyText, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target, origin);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(bodyText);
  });
}

async function startPair(t, upstreamHandler, bridgeOptions = {}) {
  const records = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      records.push(record);
      upstreamHandler(record, req, res);
    });
  });
  const upstreamOrigin = await listen(upstream);
  t.after(() => close(upstream));
  const authPath = makeAuthFile(t);
  const bridge = createBridge({ upstream: upstreamOrigin, authPath, ...bridgeOptions });
  const bridgeOrigin = await listen(bridge);
  t.after(() => close(bridge));
  return { records, bridgeOrigin, upstreamOrigin, authPath };
}

test('loadCodexAuth reads tokens and returns null when absent', (t) => {
  const authPath = makeAuthFile(t);
  assert.deepEqual(loadCodexAuth(authPath), { accessToken: 'fake-access', accountId: 'acct_42' });
  assert.equal(loadCodexAuth(path.join(path.dirname(authPath), 'nope.json')), null);
});

test('messages flow: anthropic request → responses upstream → anthropic SSE back', async (t) => {
  const { records, bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(TEXT_SSE);
  });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra',
    max_tokens: 64,
    stream: true,
    system: 'You are helpful',
    messages: [{ role: 'user', content: 'Скажи OK' }],
  });
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /text\/event-stream/);
  assert.match(result.text, /event: message_start/);
  assert.match(result.text, /"text_delta","text":"OK"|text_delta/);
  assert.match(result.text, /event: message_delta\ndata: \{.*"stop_reason":"end_turn"/);
  assert.match(result.text, /event: message_stop/);
  assert.equal(records.length, 1);
  assert.equal(records[0].url, '/responses');
  const upstreamBody = JSON.parse(records[0].body);
  assert.equal(upstreamBody.model, 'gpt-6-astra');
  assert.equal(upstreamBody.instructions, 'You are helpful');
  assert.equal(upstreamBody.stream, true);
  assert.equal(upstreamBody.store, false);
  assert.equal(records[0].headers.authorization, 'Bearer fake-access');
  assert.equal(records[0].headers['chatgpt-account-id'], 'acct_42');
  assert.equal(records[0].headers['openai-beta'], 'responses=experimental');
  assert.equal(records[0].headers.originator, 'codex_cli_rs');
  assert.match(records[0].headers['user-agent'], /codex_cli_rs/);
  assert.ok(records[0].headers.session_id);
});

test('stream:false returns one assembled JSON message', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(TEXT_SSE);
  });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra',
    max_tokens: 64,
    stream: false,
    messages: [{ role: 'user', content: 'Скажи OK' }],
  });
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /application\/json/);
  const message = JSON.parse(result.text);
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [{ type: 'text', text: 'OK' }]);
  assert.deepEqual(message.usage, { input_tokens: 9, output_tokens: 1 });
});

test('missing auth yields 401 with Codex guidance and no upstream call', async (t) => {
  const upstream = http.createServer((_req, res) => res.end('{}'));
  const upstreamOrigin = await listen(upstream);
  t.after(() => close(upstream));
  const bridge = createBridge({ upstream: upstreamOrigin, authPath: '/nonexistent/auth.json' });
  const bridgeOrigin = await listen(bridge);
  t.after(() => close(bridge));
  const result = await post(bridgeOrigin, '/v1/messages', { model: 'gpt-6-astra', messages: [] });
  assert.equal(result.status, 401);
  assert.match(result.text, /codex_auth_missing/);
  assert.match(result.text, /[Cc]odex/);
});

test('upstream 401 is reframed as token-expired guidance', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid token' } }));
  });
  const result = await post(bridgeOrigin, '/v1/messages', { model: 'gpt-6-astra', messages: [] });
  assert.equal(result.status, 401);
  assert.match(result.text, /refresh|Codex/);
});

test('upstream 429 passes through status with message', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  const result = await post(bridgeOrigin, '/v1/messages', { model: 'gpt-6-astra', messages: [] });
  assert.equal(result.status, 429);
  assert.match(result.text, /rate limited/);
});

test('count_tokens estimates without upstream call', async (t) => {
  const { records, bridgeOrigin } = await startPair(t, (_r, _req, res) => res.end('{}'));
  const body = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'x'.repeat(100) }] };
  const result = await post(bridgeOrigin, '/v1/messages/count_tokens', body);
  assert.equal(result.status, 200);
  const parsed = JSON.parse(result.text);
  assert.ok(parsed.input_tokens > 20 && parsed.input_tokens < 200);
  assert.equal(records.length, 0);
});

test('healthz, host check, method and content-type guards', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => res.end('{}'));
  const health = await new Promise((resolve) => {
    http.get(`${bridgeOrigin}/healthz`, (res) => resolve({ status: res.statusCode, body: res.resume() })).on('error', resolve);
  });
  assert.equal(health.status, 200);

  const wrongHost = await post(bridgeOrigin, '/v1/messages', { model: 'x' }, { host: 'evil.example' });
  assert.equal(wrongHost.status, 421);

  const wrongPath = await post(bridgeOrigin, '/v1/other', { model: 'x' });
  assert.equal(wrongPath.status, 404);

  const wrongType = await new Promise((resolve, reject) => {
    const req = http.request(`${bridgeOrigin}/v1/messages`, { method: 'POST', headers: { 'content-type': 'text/plain' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('hi');
  });
  assert.equal(wrongType, 415);
});

test('log file never contains message text or tokens', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'bridge.log');
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(TEXT_SSE);
  });
  const upstreamOrigin = await listen(upstream);
  t.after(() => close(upstream));
  const authPath = makeAuthFile(t);
  const { createFileLogger } = await import('./bridge.mjs');
  const log = createFileLogger(logPath);
  const bridge = createBridge({ upstream: upstreamOrigin, authPath, log });
  const bridgeOrigin = await listen(bridge);
  t.after(() => close(bridge));
  await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: 'СЕКРЕТНАЯ_ФРАЗА_12345' }],
  });
  log.close();
  const logged = fs.readFileSync(logPath, 'utf8');
  assert.ok(logged.length > 0);
  assert.ok(!logged.includes('СЕКРЕТНАЯ_ФРАЗА'));
  assert.ok(!logged.includes('fake-access'));
  assert.ok(!logged.includes('fake-refresh'));
});

test('early client disconnect aborts the upstream request before it answers', async (t) => {
  // Регрессия Issue 1: клиент рвёт соединение между upstreamRequest.end() и
  // заголовками upstream — мост обязан уничтожить upstream-запрос, иначе
  // генерация на chatgpt.com продолжает жечь квоту, хотя её никто не ждёт.
  let answered = false;
  let resolveReceived;
  const received = new Promise((r) => { resolveReceived = r; });
  let resolveClosedEarly;
  const closedEarly = new Promise((r) => { resolveClosedEarly = r; });
  let resolveAnswered;
  const answeredSignal = new Promise((r) => { resolveAnswered = r; });

  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    resolveReceived();
    const timer = setTimeout(() => {
      answered = true;
      resolveAnswered();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(TEXT_SSE);
    }, 2000);
    // 'close' на незавершённом ServerResponse срабатывает только при обрыве соединения
    res.on('close', () => {
      if (!answered) {
        clearTimeout(timer);
        resolveClosedEarly();
      }
    });
  });

  const req = http.request(new URL('/v1/messages', bridgeOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  req.on('error', () => {}); // ECONNRESET после destroy — ожидаемо
  req.end(JSON.stringify({ model: 'gpt-6-astra', stream: true, messages: [{ role: 'user', content: 'hi' }] }));

  await received; // мост уже отправил запрос в upstream
  req.destroy();  // клиент отключается до прихода заголовков upstream

  const outcome = await Promise.race([
    closedEarly.then(() => 'closed'),
    answeredSignal.then(() => 'answered'),
  ]);
  assert.equal(outcome, 'closed');
  assert.equal(answered, false);
});

test('mid-stream client disconnect logs client_disconnect 499, not upstream_stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'bridge.log');
  const { createFileLogger } = await import('./bridge.mjs');
  const fileLog = createFileLogger(logPath);
  let resolveOutcome;
  const outcome = new Promise((r) => { resolveOutcome = r; });
  const log = (ev) => {
    fileLog(ev);
    if (ev.error === 'client_disconnect' || ev.error === 'upstream_stream') resolveOutcome(ev.error);
  };

  // upstream начинает SSE и не закрывает поток; клиент обрывается mid-stream (Esc в Claude Code)
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","usage":{"input_tokens":1}}}\n\n');
    res.write('event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n');
  }, { log });

  await new Promise((resolve) => {
    const req = http.request(new URL('/v1/messages', bridgeOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let seen = '';
      res.on('data', (c) => {
        seen += c;
        if (seen.includes('event: message_start')) req.destroy();
      });
      res.on('error', () => {});
      res.on('close', resolve);
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ model: 'gpt-6-astra', stream: true, messages: [] }));
  });

  let timeoutHandle;
  const winner = await Promise.race([
    outcome,
    new Promise((r) => { timeoutHandle = setTimeout(() => r('timeout'), 3000); }),
  ]);
  clearTimeout(timeoutHandle);
  assert.equal(winner, 'client_disconnect');

  fileLog.close();
  const logged = fs.readFileSync(logPath, 'utf8');
  assert.match(logged, /"error":"client_disconnect"/);
  assert.match(logged, /"status":499/);
  assert.ok(!logged.includes('upstream_stream'));
});

test('malformed JSON yields 400 invalid_json, array body yields invalid_request', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => res.end('{}'));
  const broken = await postRaw(bridgeOrigin, '/v1/messages', '{broken');
  assert.equal(broken.status, 400);
  assert.match(broken.text, /invalid_json/);
  const arrayBody = await postRaw(bridgeOrigin, '/v1/messages', '[]');
  assert.equal(arrayBody.status, 400);
  assert.match(arrayBody.text, /invalid_request/);
});

test('oversized body yields 413 body_too_large', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => res.end('{}'), { bodyLimit: 10 });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: 'x'.repeat(50) }],
  });
  assert.equal(result.status, 413);
  assert.match(result.text, /body_too_large/);
});

test('cross-site origin and sec-fetch-site yield 403 forbidden_origin', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => res.end('{}'));
  const badOrigin = await post(bridgeOrigin, '/v1/messages', { model: 'x' }, { origin: 'http://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.match(badOrigin.text, /forbidden_origin/);
  const crossSite = await post(bridgeOrigin, '/v1/messages', { model: 'x' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.text, /forbidden_origin/);
});

test('HEAD /api/hello returns 200', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => res.end('{}'));
  const status = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/hello', bridgeOrigin), { method: 'HEAD' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
});

test('upstream socket death mid-stream failOpens with an error event', async (t) => {
  const { bridgeOrigin } = await startPair(t, (_r, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","usage":{"input_tokens":1}}}\n\n');
    // убиваем сокет без graceful end — мост обязан failOpen и закрыть клиентский ответ (без hang)
    const timer = setTimeout(() => res.destroy(), 100);
    res.on('close', () => clearTimeout(timer));
  });
  const result = await post(bridgeOrigin, '/v1/messages', { model: 'gpt-6-astra', stream: true, messages: [] });
  assert.equal(result.status, 200);
  assert.match(result.text, /event: message_start/);
  assert.match(result.text, /event: error/);
});

test('upstream 401 message reaches the client but never the log file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'bridge.log');
  const { createFileLogger } = await import('./bridge.mjs');
  const fileLog = createFileLogger(logPath);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'УНИКАЛЬНЫЙ_ТЕКСТ_ОШИБКИ_987' } }));
  });
  const upstreamOrigin = await listen(upstream);
  t.after(() => close(upstream));
  const authPath = makeAuthFile(t);
  const bridge = createBridge({ upstream: upstreamOrigin, authPath, log: fileLog });
  const bridgeOrigin = await listen(bridge);
  t.after(() => close(bridge));
  const result = await post(bridgeOrigin, '/v1/messages', { model: 'gpt-6-astra', messages: [] });
  assert.equal(result.status, 401);
  // перекадровка 401 сохраняет текст upstream в ответе клиенту, но не в логе
  assert.match(result.text, /УНИКАЛЬНЫЙ_ТЕКСТ_ОШИБКИ_987/);
  assert.match(result.text, /refresh|Codex/);
  fileLog.close();
  const logged = fs.readFileSync(logPath, 'utf8');
  assert.ok(logged.length > 0);
  assert.ok(!logged.includes('УНИКАЛЬНЫЙ_ТЕКСТ_ОШИБКИ'));
});
