import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import type { Session } from './login';
import { prepareCleanChat } from './clean-chat';

const TOKEN = 'access-token-do-not-leak';
const cfg = { apiUrl: 'https://api.test', demoPhone: '79030000001' } as unknown as StudioConfig;
const session: Session = { accessToken: TOKEN, refreshToken: 'refresh', userData: {} };

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Подменённый fetch: пишет вызовы и отвечает по очереди из replies (Response или ошибка сети). */
function fakeFetch(replies: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    const r = replies[calls.length - 1] ?? new Response('{}', { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { impl, calls };
}

const blocked = (e: unknown) =>
  e instanceof StudioError && e.code === 'blocked' && e.retryable === true && !e.message.includes(TOKEN);

test('чистый лист: сначала DELETE ленты, потом POST точки — с токеном демо-аккаунта', async () => {
  const { impl, calls } = fakeFetch([
    new Response(JSON.stringify({ success: true }), { status: 200 }),
    new Response(JSON.stringify({ resetAt: '2026-11-17T10:00:00.000Z' }), { status: 200 }),
  ]);
  await prepareCleanChat(cfg, session, 7, impl);
  assert.equal(calls.length, 2);

  // Без очистки ленты прошлые сцены остались бы в высоком кадре над чертой.
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.test/webhook/chat/history?assistantId=7');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${TOKEN}`);

  // Без точки не сменится ключ релея: ассистент помнил бы прошлые сцены.
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://api.test/webhook/chat/reset-context');
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(calls[1].headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(calls[1].body)), { assistantId: 7 });
});

test('DELETE ленты ответил не 2xx — blocked с повтором, точку не ставим, токена в тексте нет', async () => {
  const { impl, calls } = fakeFetch([new Response('{"error":"boom"}', { status: 500 })]);
  await assert.rejects(prepareCleanChat(cfg, session, 7, impl), (e: unknown) => blocked(e) && /500/.test((e as Error).message));
  assert.equal(calls.length, 1);
});

test('POST точки ответил не 2xx — blocked с повтором, токена в тексте нет', async () => {
  const { impl, calls } = fakeFetch([
    new Response('{"success":true}', { status: 200 }),
    new Response('{"error":"context reset unavailable"}', { status: 503 }),
  ]);
  await assert.rejects(prepareCleanChat(cfg, session, 7, impl), (e: unknown) => blocked(e) && /503/.test((e as Error).message));
  assert.equal(calls.length, 2);
});

test('сбой сети на DELETE — blocked с повтором; текст ошибки fetch в сообщение не попадает', async () => {
  const { impl, calls } = fakeFetch([new TypeError(`fetch failed: Bearer ${TOKEN}`)]);
  await assert.rejects(prepareCleanChat(cfg, session, 7, impl), blocked);
  assert.equal(calls.length, 1);
});

test('сбой сети на POST точки — blocked с повтором', async () => {
  const { impl, calls } = fakeFetch([new Response('{"success":true}', { status: 200 }), new TypeError(`fetch failed: Bearer ${TOKEN}`)]);
  await assert.rejects(prepareCleanChat(cfg, session, 7, impl), blocked);
  assert.equal(calls.length, 2);
});

test('номер не демо-аккаунта — ни одного запроса: ленту живого человека студия не чистит', async () => {
  const { impl, calls } = fakeFetch([]);
  const live = { ...cfg, demoPhone: '79161234567' } as StudioConfig;
  await assert.rejects(prepareCleanChat(live, session, 7, impl));
  assert.equal(calls.length, 0);
});

test('chat-scene: метки fresh_ts_ больше нет, подготовка — до запуска браузера и не в пробе', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-scene.ts'), 'utf8');
  assert.ok(!src.includes('fresh_ts_'), 'в chat-scene.ts остался ключ fresh_ts_');
  assert.ok(!src.includes('freshTs'), 'в chat-scene.ts остался freshTs');
  const prepare = src.search(/if \(!opts\.probeOnly\) await prepareCleanChat\(cfg, session, scene\.assistantId\);/);
  assert.ok(prepare >= 0, 'подготовка не вызвана или вызвана и в пробе');
  assert.ok(prepare < src.indexOf('chromium.launch('), 'подготовка должна идти до запуска браузера');
});
