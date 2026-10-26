import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError } from '../errors';
import { CLIP_SEC, generateKeyframe, googleHttpError, KEYFRAME_MODEL, OMNI_MODEL, startClip, waitClip, type GoogleDeps } from './google';

type Reply = { status?: number; body: unknown } | Error;

/** Подделка fetch: отвечает по очереди и запоминает запросы. */
function fake(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: GoogleDeps = { apiKey: 'KEY', fetch: f, sleep: async () => {}, pollEveryMs: 1, pollTimeoutMs: 3 };
  return { deps, calls };
}

const isErr = (code: string, retryable: boolean) => (e: unknown) =>
  e instanceof StudioError && e.code === code && e.retryable === retryable;

const done = (data: Buffer) => ({
  body: { status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: 'вот' }, { type: 'video', data: data.toString('base64') }] }] },
});

test('кадр: портреты инлайном перед текстом, 9:16, ключ в заголовке, картинка из ответа', async () => {
  const png = Buffer.from('PNG');
  const { deps, calls } = fake([
    { body: { candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] } },
  ]);
  const refs = [{ data: Buffer.from('a'), mime: 'image/png' }, { data: Buffer.from('b'), mime: 'image/png' }];
  assert.deepEqual(await generateKeyframe(deps, 'промпт', refs), png);
  assert.match(calls[0].url, new RegExp(`models/${KEYFRAME_MODEL}:generateContent$`));
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], 'KEY');
  const body = JSON.parse(String(calls[0].init?.body));
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: Buffer.from('a').toString('base64') } });
  assert.equal(parts[2].text, 'промпт');
  assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } });
});

test('кадр без картинки (RECITATION приходит без ошибки) — повторяемая ошибка с причиной', async () => {
  const { deps } = fake([{ body: { candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] } }]);
  await assert.rejects(generateKeyframe(deps, 'p', []), (e: unknown) => isErr('keyframe', true)(e) && /RECITATION/.test((e as Error).message));
});

test('HTTP-ошибки Google: квота, ключ и снятая модель не повторяются', () => {
  assert.ok(isErr('google_quota', false)(googleHttpError('omni', 429, '{}')));
  assert.ok(isErr('google_quota', false)(googleHttpError('keyframe', 400, 'RESOURCE_EXHAUSTED')));
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 403, 'denied')));
  assert.ok(isErr('model_gone', false)(googleHttpError('omni', 404, 'not found')));
  assert.ok(isErr('omni_rejected', true)(googleHttpError('omni', 400, '{"error":{"status":"INVALID_ARGUMENT"}}')));
  assert.ok(isErr('omni_failed', true)(googleHttpError('omni', 503, 'unavailable')));
  assert.ok(isErr('keyframe', true)(googleHttpError('keyframe', 500, 'oops')));
});

test('запуск клипа: Omni, фоновый, кадр и текст, 9:16 720p 8 с', async () => {
  const { deps, calls } = fake([{ body: { id: 'int-1', status: 'in_progress' } }]);
  assert.equal(await startClip(deps, 'сценка', { data: Buffer.from('kf'), mime: 'image/png' }), 'int-1');
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, OMNI_MODEL);
  assert.equal(body.background, true);
  assert.deepEqual(body.input, [
    { type: 'image', data: Buffer.from('kf').toString('base64'), mime_type: 'image/png' },
    { type: 'text', text: 'сценка' },
  ]);
  assert.deepEqual(body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` });
});

test('запуск без id — повторяемая ошибка', async () => {
  const { deps } = fake([{ body: { status: 'in_progress' } }]);
  await assert.rejects(startClip(deps, 'p', { data: Buffer.from('k'), mime: 'image/png' }), isErr('omni_failed', true));
});

test('ожидание: в работе → готово, видео из шага model_output', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps, calls } = fake([{ body: { status: 'in_progress' } }, done(mp4)]);
  assert.deepEqual(await waitClip(deps, 'int-1'), mp4);
  assert.match(calls[0].url, /\/interactions\/int-1$/);
});

test('ожидание: сбой сети и 5xx при опросе не сжигают генерацию', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps } = fake([new Error('ECONNRESET'), { status: 503, body: 'x' }, done(mp4)]);
  assert.deepEqual(await waitClip(deps, 'i'), mp4);
});

test('отказ фильтра приходит массивом errors — повторяемый omni_rejected', async () => {
  const { deps } = fake([{ body: { status: 'failed', errors: [{ code: 'INVALID_ARGUMENT', message: 'There was a problem processing your request' }] } }]);
  await assert.rejects(waitClip(deps, 'i'), isErr('omni_rejected', true));
});

test('прочий провал — omni_failed; квота в провале — google_quota', async () => {
  const a = fake([{ body: { status: 'failed', errors: [{ code: 'INTERNAL', message: 'boom' }] } }]);
  await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_failed', true));
  const b = fake([{ body: { status: 'failed', errors: [{ code: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), isErr('google_quota', false));
});

test('готово, но без видео — omni_rejected с текстом модели', async () => {
  const { deps } = fake([{ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Не могу' }] }] } }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_rejected', true)(e) && /Не могу/.test((e as Error).message));
});

test('не дождались — omni_failed', async () => {
  const { deps } = fake([{ body: { status: 'in_progress' } }, { body: { status: 'in_progress' } }, { body: { status: 'in_progress' } }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_failed', true)(e) && /не дождались/.test((e as Error).message));
});
