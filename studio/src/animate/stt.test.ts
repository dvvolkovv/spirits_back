import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError } from '../errors';
import { recognize } from './stt';

type Reply = { status?: number; body: unknown } | Error;

function fake(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const creds = { apiKey: 'K', folderId: 'F' };
const noSleep = async () => {};

test('распознавание: ru-RU, oggopus, каталог в адресе, ключ в заголовке, тело — звук', async () => {
  const { f, calls } = fake([{ body: { result: 'обои потерли' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }), 'обои потерли');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize');
  assert.equal(url.searchParams.get('lang'), 'ru-RU');
  assert.equal(url.searchParams.get('format'), 'oggopus');
  assert.equal(url.searchParams.get('folderId'), 'F');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Api-Key K');
  assert.deepEqual(Buffer.from(calls[0].init?.body as Uint8Array), Buffer.from('OGG'));
});

test('пустой результат — пустая строка', async () => {
  const { f } = fake([{ body: {} }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }), '');
});

test('сбой сети и 5xx повторяются здесь же', async () => {
  const { f, calls } = fake([new Error('ECONNRESET'), { status: 503, body: 'busy' }, { body: { result: 'да' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }), 'да');
  assert.equal(calls.length, 3);
});

test('три сбоя подряд — ошибка без повтора: клип уже оплачен, пересъёмка не поможет', async () => {
  const { f, calls } = fake([{ status: 503, body: 'a' }, { status: 503, body: 'b' }, { status: 503, body: 'c' }]);
  await assert.rejects(
    recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }),
    (e: unknown) => e instanceof StudioError && e.code === 'stt' && !e.retryable,
  );
  assert.equal(calls.length, 3);
});

test('4xx (ключ, права) — сразу ошибка без повтора', async () => {
  const { f, calls } = fake([{ status: 401, body: 'unauthorized' }]);
  await assert.rejects(
    recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }),
    (e: unknown) => e instanceof StudioError && e.code === 'stt' && !e.retryable && /401/.test(e.message),
  );
  assert.equal(calls.length, 1);
});
