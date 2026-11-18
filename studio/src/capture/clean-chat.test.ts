import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import type { Session } from './login';
import { assertEmptyFeed, prepareCleanChat } from './clean-chat';

const TOKEN = 'access-token-do-not-leak';
const cfg = { apiUrl: 'https://api.test', demoPhone: '79030000001' } as unknown as StudioConfig;
const session: Session = { accessToken: TOKEN, refreshToken: 'refresh', userData: {} };
const FAR = 24 * 60_000;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

/**
 * Подменённые fetch, часы и пауза. reply отвечает на каждый вызов (Response
 * или ошибка сети); log — общий порядок запросов и пауз, часы идут только
 * паузами.
 */
function rig(reply: (c: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const log: string[] = [];
  let t = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body };
    calls.push(c);
    log.push(`${c.method} ${new URL(c.url).pathname.replace('/webhook/chat/', '')}`);
    const r = reply(c, calls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    log.push(`sleep ${ms}`);
    t += ms;
  };
  return { deps: { fetchImpl, sleep, now: () => t }, calls, log };
}

/** Прежнего хода нет, лента и точка — 200. */
const ok = (c: Call) =>
  c.url.includes('/active-turn')
    ? json({ active: false, startedMsAgo: 0 })
    : c.method === 'DELETE'
      ? json({ success: true })
      : json({ resetAt: '2026-11-17T10:00:00.000Z' });

const isErr = (code: string, retryable: boolean) => (e: unknown) =>
  e instanceof StudioError && e.code === code && e.retryable === retryable && !e.message.includes(TOKEN);
const blocked = isErr('blocked', true);

test('прежний ход: true → true → false — три опроса, пауза на запись ответа, потом DELETE и POST', async () => {
  let turn = 0;
  const { deps, calls, log } = rig((c) => (c.url.includes('/active-turn') ? json({ active: ++turn < 3, startedMsAgo: 1000 }) : ok(c)));
  await prepareCleanChat(cfg, session, 7, FAR, deps);
  assert.deepEqual(log, [
    'GET active-turn',
    'sleep 5000',
    'GET active-turn',
    'sleep 5000',
    'GET active-turn',
    'sleep 8000',
    'DELETE history',
    'POST reset-context',
  ]);
  for (const c of calls) assert.equal(c.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(calls[0].url, 'https://api.test/webhook/chat/active-turn?assistantId=7');

  // Без очистки ленты прошлые сцены остались бы в высоком кадре над чертой.
  assert.equal(calls[3].url, 'https://api.test/webhook/chat/history?assistantId=7');

  // Без точки не сменится ключ релея: ассистент помнил бы прошлые сцены.
  assert.equal(calls[4].url, 'https://api.test/webhook/chat/reset-context');
  assert.equal(calls[4].headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(calls[4].body)), { assistantId: 7 });
});

test('хода нет сразу — один опрос и та же пауза: метка могла сняться за миг до опроса', async () => {
  const { deps, log } = rig(ok);
  await prepareCleanChat(cfg, session, 7, FAR, deps);
  assert.deepEqual(log, ['GET active-turn', 'sleep 8000', 'DELETE history', 'POST reset-context']);
});

test('прежний ход не кончился к сроку съёмки — idle_timeout с повтором, ленту не трогаем', async () => {
  const { deps, log } = rig((c) => (c.url.includes('/active-turn') ? json({ active: true, startedMsAgo: 60_000 }) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, 12_000, deps), isErr('idle_timeout', true));
  assert.ok(!log.some((l) => l.startsWith('DELETE') || l.startsWith('POST')), log.join(', '));
  assert.ok(log.filter((l) => l === 'GET active-turn').length >= 3, log.join(', '));
});

test('active-turn ответил не 2xx — blocked с повтором, ленту не трогаем', async () => {
  const { deps, log } = rig((c) => (c.url.includes('/active-turn') ? json({ error: 'boom' }, 500) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, deps), (e: unknown) => blocked(e) && /500/.test((e as Error).message));
  assert.deepEqual(log, ['GET active-turn']);
});

test('active-turn: сбой сети или ответ без active — blocked с повтором, текст ошибки fetch не попадает', async () => {
  const net = rig((c) => (c.url.includes('/active-turn') ? new TypeError(`fetch failed: Bearer ${TOKEN}`) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, net.deps), blocked);
  assert.deepEqual(net.log, ['GET active-turn']);
  const odd = rig((c) => (c.url.includes('/active-turn') ? json({}) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, odd.deps), blocked);
  assert.deepEqual(odd.log, ['GET active-turn']);
});

test('DELETE ленты ответил не 2xx — blocked с повтором, точку не ставим', async () => {
  const { deps, log } = rig((c) => (c.method === 'DELETE' ? json({ error: 'boom' }, 500) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, deps), (e: unknown) => blocked(e) && /500/.test((e as Error).message));
  assert.ok(!log.includes('POST reset-context'));
});

test('POST точки ответил 503 — blocked с повтором', async () => {
  const { deps } = rig((c) => (c.method === 'POST' ? json({ error: 'context reset unavailable' }, 503) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, deps), (e: unknown) => blocked(e) && /503/.test((e as Error).message));
});

for (const status of [404, 400]) {
  test(`POST точки ответил ${status} — no_input без повтора: бэкенд без reset-context, доктор это не лечит`, async () => {
    const { deps } = rig((c) => (c.method === 'POST' ? json({ error: 'x' }, status) : ok(c)));
    await assert.rejects(
      prepareCleanChat(cfg, session, 7, FAR, deps),
      (e: unknown) => isErr('no_input', false)(e) && /\/webhook\/chat\/reset-context/.test((e as Error).message),
    );
  });
}

test('сбой сети на DELETE и на POST — blocked с повтором', async () => {
  const del = rig((c) => (c.method === 'DELETE' ? new TypeError(`fetch failed: Bearer ${TOKEN}`) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, del.deps), blocked);
  assert.ok(!del.log.includes('POST reset-context'));
  const post = rig((c) => (c.method === 'POST' ? new TypeError(`fetch failed: Bearer ${TOKEN}`) : ok(c)));
  await assert.rejects(prepareCleanChat(cfg, session, 7, FAR, post.deps), blocked);
});

test('номер не демо-аккаунта — no_input без повтора и ни одного запроса; номера в тексте нет', async () => {
  const { deps, calls } = rig(ok);
  const live = { ...cfg, demoPhone: '79161234567' } as StudioConfig;
  await assert.rejects(
    prepareCleanChat(live, session, 7, FAR, deps),
    (e: unknown) => isErr('no_input', false)(e) && !(e as Error).message.includes('79161234567'),
  );
  assert.equal(calls.length, 0);
});

test('страховка перед вопросом: пустая лента — дальше, запрос GET history с limit=1 и токеном', async () => {
  const { deps, calls } = rig(() => json({ messages: [], hasMore: false, contextResetAt: null }));
  await assertEmptyFeed(cfg, session, 7, deps.fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.test/webhook/chat/history?assistantId=7&limit=1');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${TOKEN}`);
});

test('страховка перед вопросом: в ленте сирота прежнего хода — blocked с повтором', async () => {
  const { deps } = rig(() => json({ messages: [{ id: 1, role: 'assistant', content: 'ответ прежнего хода' }], hasMore: false }));
  await assert.rejects(
    assertEmptyFeed(cfg, session, 7, deps.fetchImpl),
    (e: unknown) => blocked(e) && (e as Error).message === 'capture: лента не пуста перед вопросом',
  );
});

test('страховка перед вопросом: не 2xx, сбой сети, ответ без messages — blocked с повтором', async () => {
  for (const r of [json({ error: 'boom' }, 500), new TypeError(`fetch failed: Bearer ${TOKEN}`), json({})]) {
    const { deps } = rig(() => r);
    await assert.rejects(assertEmptyFeed(cfg, session, 7, deps.fetchImpl), blocked);
  }
});

test('chat-scene: fresh_ts_ нет; подготовка — до браузера, со сроком съёмки и не в пробе; страховка — перед вопросом', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-scene.ts'), 'utf8');
  assert.ok(!src.includes('fresh_ts_'), 'в chat-scene.ts остался ключ fresh_ts_');
  assert.ok(!src.includes('freshTs'), 'в chat-scene.ts остался freshTs');

  const prepare = src.indexOf('prepareCleanChat(');
  assert.ok(prepare >= 0, 'подготовка не вызвана');
  assert.ok(prepare < src.indexOf('chromium.launch('), 'подготовка должна идти до запуска браузера');
  assert.match(src.slice(0, prepare).split('\n').slice(-3).join('\n'), /probeOnly/, 'подготовка не под проверкой пробы');
  assert.match(src.slice(prepare, src.indexOf('\n', prepare)), /deadline/, 'подготовке не передан срок съёмки');

  const guard = src.indexOf('assertEmptyFeed(');
  assert.ok(guard >= 0, 'страховка перед вопросом не вызвана');
  assert.ok(guard > src.lastIndexOf('probeOnly'), 'страховка должна идти после выхода пробы');
  assert.ok(guard < src.indexOf('send(page, scene.question'), 'страховка должна идти до отправки вопроса');
});
