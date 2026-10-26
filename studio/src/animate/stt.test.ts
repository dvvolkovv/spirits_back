import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import { recognize, speechAudio } from './stt';

type Reply = { status?: number; body: unknown } | Error | (() => Response);

function fake(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const pauses: number[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r();
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    pauses.push(ms);
  };
  return { f, calls, pauses, sleep };
}

const creds = { apiKey: 'SECRET-SPEECH-KEY', folderId: 'F' };
const sttFailed = (e: unknown) => e instanceof StudioError && e.code === 'stt' && !e.retryable;

/** Тело обрывается посреди чтения — так рвётся соединение. */
const torn = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"result":"обои'));
        c.error(new TypeError('terminated'));
      },
    }),
    { status: 200 },
  );

test('распознавание: ru-RU, oggopus, числа словами, каталог в адресе, ключ в заголовке, тело — звук', async () => {
  const { f, calls, sleep } = fake([{ body: { result: 'обои потерли' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), 'обои потерли');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize');
  assert.equal(url.searchParams.get('lang'), 'ru-RU');
  assert.equal(url.searchParams.get('format'), 'oggopus');
  assert.equal(url.searchParams.get('rawResults'), 'true');
  assert.equal(url.searchParams.get('folderId'), 'F');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Api-Key SECRET-SPEECH-KEY');
  assert.deepEqual(Buffer.from(calls[0].init?.body as Uint8Array), Buffer.from('OGG'));
  assert.ok(calls[0].init?.signal, 'у запроса нет таймаута');
});

test('тишина — пустая строка; ответ без текста — повтор, а не пустая строка', async () => {
  const a = fake([{ body: { result: '' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: a.f, sleep: a.sleep }), '');
  const b = fake([{ body: {} }, { body: { result: 'ладно' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: b.f, sleep: b.sleep }), 'ладно');
});

test('сбой сети, обрыв тела, не-JSON, 5xx и 429 повторяются здесь же, с нарастающими паузами', async () => {
  const { f, calls, pauses, sleep } = fake([new Error('ECONNRESET'), torn, { body: '<html>' }, { status: 429, body: 'quota' }, { body: { result: 'да' } }]);
  await assert.rejects(recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), sttFailed);
  assert.equal(calls.length, 4);
  assert.deepEqual(pauses, [2000, 10000, 30000]);
  const second = fake([{ status: 503, body: 'busy' }, { body: { result: 'да' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: second.f, sleep: second.sleep }), 'да');
});

test('все попытки неудачны — ошибка stt без повтора: клип уже оплачен, пересъёмка не поможет', async () => {
  const { f, calls, sleep } = fake([{ status: 503, body: 'a' }, { status: 503, body: 'b' }, { status: 503, body: 'c' }, { status: 503, body: 'd' }]);
  await assert.rejects(recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), sttFailed);
  assert.equal(calls.length, 4);
});

test('4xx (ключ, права) — сразу ошибка без повтора, ключ из текста ответа вырезан, даже на границе обрезки', async () => {
  const { f, calls, sleep } = fake([{ status: 401, body: `${'x'.repeat(190)} SECRET-SPEECH-KEY` }]);
  await assert.rejects(
    recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }),
    (e: unknown) => sttFailed(e) && /401/.test((e as Error).message) && !(e as Error).message.includes('SECRET-SP'),
  );
  assert.equal(calls.length, 1);
});

test('ответ 200 с ошибкой вместо текста — повтор, а не пустая строка', async () => {
  const { f, sleep } = fake([{ body: { error_code: 'BAD_REQUEST', error_message: 'x' } }, { body: { result: 'ладно' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), 'ладно');
});

test('звук клипа — ogg/opus, один канал, 48 кГц', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stt-'));
  const clip = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  return speechAudio(clip, path.join(dir, 'speech.webm')).then((out) => {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString());
    assert.equal(probe.format.format_name, 'ogg');
    assert.equal(probe.streams[0].codec_name, 'opus');
    assert.equal(probe.streams[0].channels, 1);
    assert.equal(probe.streams[0].sample_rate, '48000');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
