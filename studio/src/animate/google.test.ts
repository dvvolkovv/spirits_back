import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError } from '../errors';
import {
  CLEAR_REFUSALS,
  CLIP_SEC,
  generateKeyframe,
  googleHttpError,
  imageMime,
  KEYFRAME_MODEL,
  OMNI_MODEL,
  rateLimitDelayMs,
  startClip,
  waitClip,
  type GoogleDeps,
} from './google';

type Reply = { status?: number; body: unknown } | Error | (() => Response);

/** Подделка fetch с виртуальными часами: пауза двигает время, каждый запрос — на costMs. */
function fake(replies: Reply[], costMs = 0) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let t = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    t += costMs;
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r();
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: GoogleDeps = {
    apiKey: 'AIzaSyTESTKEY0123456789abcdefghij',
    fetch: f,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    pollEveryMs: 1,
    pollTimeoutMs: 3,
  };
  return { deps, calls };
}

const isErr = (code: string, retryable: boolean) => (e: unknown) =>
  e instanceof StudioError && e.code === code && e.retryable === retryable;

const done = (data: Buffer) => ({
  body: { status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: 'вот' }, { type: 'video', data: data.toString('base64') }] }] },
});
const inProgress = { body: { status: 'in_progress' } };
const torn = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"completed","steps":[{"type":"model_output","content":[{"type":"video","data":"AAAA'));
        c.error(new TypeError('terminated'));
      },
    }),
    { status: 200 },
  );
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test('кадр: портреты инлайном перед текстом, 9:16, ключ в заголовке, картинка с её типом', async () => {
  const { deps, calls } = fake([
    { body: { candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/jpeg', data: JPEG.toString('base64') } }] } }] } },
  ]);
  const refs = [{ data: Buffer.from('a'), mime: 'image/png' }, { data: Buffer.from('b'), mime: 'image/png' }];
  assert.deepEqual(await generateKeyframe(deps, 'промпт', refs), { data: JPEG, mime: 'image/jpeg' });
  assert.match(calls[0].url, new RegExp(`models/${KEYFRAME_MODEL}:generateContent$`));
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], deps.apiKey);
  assert.ok(calls[0].init?.signal, 'у запроса нет таймаута');
  const body = JSON.parse(String(calls[0].init?.body));
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: Buffer.from('a').toString('base64') } });
  assert.equal(parts[2].text, 'промпт');
  assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } });
});

test('тип картинки без mimeType — по сигнатуре', async () => {
  assert.equal(imageMime(JPEG), 'image/jpeg');
  assert.equal(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  const { deps } = fake([{ body: { candidates: [{ content: { parts: [{ inlineData: { data: JPEG.toString('base64') } }] } }] } }]);
  assert.equal((await generateKeyframe(deps, 'p', [])).mime, 'image/jpeg');
});

test('кадр без картинки: RECITATION — повторяемая ошибка, заблокированный промпт — без повтора', async () => {
  const a = fake([{ body: { candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] } }]);
  await assert.rejects(generateKeyframe(a.deps, 'p', []), (e: unknown) => isErr('keyframe', true)(e) && /RECITATION/.test((e as Error).message));
  const b = fake([{ body: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }]);
  await assert.rejects(generateKeyframe(b.deps, 'p', []), (e: unknown) => isErr('keyframe', false)(e) && /PROHIBITED_CONTENT/.test((e as Error).message));
});

test('HTTP-ошибки Google: квота, ключ и снятая модель не повторяются', () => {
  assert.ok(isErr('google_quota', false)(googleHttpError('omni', 429, '{}')));
  assert.ok(isErr('google_quota', false)(googleHttpError('keyframe', 400, 'RESOURCE_EXHAUSTED')));
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 403, 'denied')));
  const badKey = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } });
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 400, badKey)));
  assert.ok(isErr('model_gone', false)(googleHttpError('omni', 404, 'not found')));
  assert.ok(isErr('omni_rejected', true)(googleHttpError('omni', 400, '{"error":{"status":"INVALID_ARGUMENT"}}')));
  assert.ok(isErr('omni_failed', true)(googleHttpError('omni', 503, 'unavailable')));
  assert.ok(isErr('keyframe', true)(googleHttpError('keyframe', 500, 'oops')));
});

test('свой ключ любого формата вырезается из текста ошибки буквально', async () => {
  const key = 'k-live-0123456789-not-an-aiza-key';
  const { deps } = fake([{ status: 403, body: JSON.stringify({ error: { code: 403, message: `Consumer 'api_key:${key}' has been suspended.` } }) }]);
  deps.apiKey = key;
  await assert.rejects(generateKeyframe(deps, 'p', []), (e: unknown) => e instanceof StudioError && !e.message.includes(key) && /<ключ>/.test(e.message));
});

test('429 без вида лимита — не «жди до утра», а повтор через несколько минут', () => {
  assert.match(googleHttpError('omni', 429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Resource has been exhausted (e.g. check quota)."}}').message, /вид лимита Google не указал/);
});

test('ключ из ответа Google в сообщение не попадает — и на границе обрезки', () => {
  const body = JSON.stringify({ error: { code: 403, message: "Consumer 'api_key:AIzaSyTESTKEY0123456789abcdefghij' has been suspended." } });
  assert.doesNotMatch(googleHttpError('omni', 403, body).message, /AIzaSyTESTKEY/);
  const edge = JSON.stringify({ error: { code: 500, message: `${'x'.repeat(290)} AIzaSyTESTKEY0123456789abcdefghij` } });
  assert.doesNotMatch(googleHttpError('omni', 500, edge).message, /AIzaSy/);
});

test('поминутный лимит пережидается на месте и не сжигает попытку; не дольше двух раз', async () => {
  const perMinute = { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ retryDelay: '7s' }] } } };
  assert.equal(rateLimitDelayMs(JSON.stringify(perMinute.body)), 7000);
  const { deps, calls } = fake([perMinute, { body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } }] } }]);
  assert.equal((await generateKeyframe(deps, 'p', [])).mime, 'image/png');
  assert.equal(calls.length, 2);
  const stuck = fake([perMinute, perMinute, perMinute]);
  await assert.rejects(generateKeyframe(stuck.deps, 'p', []), (e: unknown) => isErr('google_quota', false)(e) && /поминутный/.test((e as Error).message));
  assert.equal(stuck.calls.length, 3);
});

test('суточная квота — даже с RetryInfo — и нулевая квота не пережидаются; долгая пауза — тоже', () => {
  const daily = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded',
      details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '41s' }],
    },
  });
  assert.equal(rateLimitDelayMs(daily), null);
  assert.match(googleHttpError('keyframe', 429, daily).message, /суточная/);
  const zero = JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0' } });
  assert.equal(rateLimitDelayMs(zero), null);
  assert.match(googleHttpError('keyframe', 429, zero).message, /нулевая — проверить биллинг/);
  assert.equal(rateLimitDelayMs(JSON.stringify({ error: { details: [{ retryDelay: '120s' }] } })), null);
});

test('биллинг или регион (FAILED_PRECONDITION) — ключ, без повтора; прочие 4xx при запуске — явный отказ', async () => {
  const pre = JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported' } });
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 400, pre)));
  const big = fake([{ status: 413, body: 'too large' }]);
  await assert.rejects(startClip(big.deps, 'p', { data: JPEG, mime: 'image/jpeg' }), (e: unknown) => {
    assert.ok(isErr('omni_rejected', true)(e));
    assert.ok(CLEAR_REFUSALS.has((e as StudioError).code));
    return true;
  });
});

test('запуск клипа: Omni, фоновый, кадр с его типом и текст, 9:16 720p 8 с', async () => {
  const { deps, calls } = fake([{ body: { id: 'int-1', status: 'in_progress' } }]);
  assert.equal(await startClip(deps, 'сценка', { data: JPEG, mime: 'image/jpeg' }), 'int-1');
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  assert.ok(calls[0].init?.signal, 'у запуска нет таймаута');
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], deps.apiKey);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, OMNI_MODEL);
  assert.equal(body.background, true);
  assert.deepEqual(body.input, [
    { type: 'image', data: JPEG.toString('base64'), mime_type: 'image/jpeg' },
    { type: 'text', text: 'сценка' },
  ]);
  assert.deepEqual(body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` });
});

test('запуск: ответ потерян или без id — повторяемая ошибка «могла начаться», секунды не возвращаются', async () => {
  const a = fake([new TypeError('fetch failed')]);
  await assert.rejects(startClip(a.deps, 'p', { data: JPEG, mime: 'image/jpeg' }), (e: unknown) => isErr('omni_failed', true)(e) && /могла начаться/.test((e as Error).message));
  const b = fake([{ body: '<html>' }]);
  await assert.rejects(startClip(b.deps, 'p', { data: JPEG, mime: 'image/jpeg' }), isErr('omni_failed', true));
  assert.equal(CLEAR_REFUSALS.has('omni_failed'), false);
  assert.equal(CLEAR_REFUSALS.has('omni_rejected'), true);
  assert.equal(CLEAR_REFUSALS.has('google_quota'), true);
});

test('ожидание: в работе → готово, видео из шага model_output', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps, calls } = fake([inProgress, done(mp4)]);
  assert.deepEqual(await waitClip(deps, 'int-1'), mp4);
  assert.match(calls[0].url, /\/interactions\/int-1$/);
  assert.ok(calls[0].init?.signal, 'у опроса нет таймаута');
});

test('ожидание: сбой сети, обрыв тела, не-JSON, 5xx, 408, 429 и незнакомый статус не бросают оплаченную генерацию', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps } = fake([new Error('ECONNRESET'), torn, { body: '<html>' }, { status: 503, body: 'x' }, { status: 408, body: '{}' }, { status: 429, body: '{}' }, { body: { status: 'queued' } }, { body: {} }, done(mp4)]);
  deps.pollTimeoutMs = 100;
  assert.deepEqual(await waitClip(deps, 'i'), mp4);
});

const byLink = (uri: string) => ({ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri }] }] } });
const GOOGLE_FILE = 'https://generativelanguage.googleapis.com/v1beta/files/abc:download';

test('ожидание: готовый клип ссылкой скачивается; ключ уходит только хосту Google', async () => {
  const { deps, calls } = fake([byLink(GOOGLE_FILE), () => new Response(new Uint8Array(Buffer.from('MP4')), { status: 200 })]);
  assert.deepEqual(await waitClip(deps, 'i'), Buffer.from('MP4'));
  assert.equal(calls[1].url, GOOGLE_FILE);
  assert.equal((calls[1].init?.headers as Record<string, string>)['x-goog-api-key'], deps.apiKey);
  assert.ok(calls[1].init?.signal, 'у скачивания нет таймаута');
  const evil = fake([byLink('https://evil.example/clip.mp4'), () => new Response(new Uint8Array(Buffer.from('MP4')), { status: 200 })]);
  await waitClip(evil.deps, 'i');
  assert.equal((evil.calls[1].init?.headers as Record<string, string>)['x-goog-api-key'], undefined);
});

test('скачивание: сбой сети — следующий опрос, а не новая генерация; 4xx — понятная ошибка без повтора', async () => {
  const mp4 = Buffer.from('MP4');
  const a = fake([byLink(GOOGLE_FILE), new TypeError('fetch failed'), done(mp4)]);
  a.deps.pollTimeoutMs = 100;
  assert.deepEqual(await waitClip(a.deps, 'i'), mp4);
  // 401/403 — студия не может забрать оплаченный клип: id сохраняется (omni_unreadable), новой генерации нет.
  const b = fake([byLink(GOOGLE_FILE), { status: 403, body: 'forbidden' }]);
  await assert.rejects(waitClip(b.deps, 'i'), (e: unknown) => isErr('omni_unreadable', false)(e) && /по ссылке не отдаётся: HTTP 403/.test((e as Error).message));
  // 404/410 — файла больше нет: новая генерация оправданна.
  const c = fake([byLink(GOOGLE_FILE), { status: 404, body: 'gone' }]);
  await assert.rejects(waitClip(c.deps, 'i'), (e: unknown) => isErr('omni_failed', false)(e) && /файла по ссылке уже нет/.test((e as Error).message));
  const bad = fake([byLink('not a url')]);
  await assert.rejects(waitClip(bad.deps, 'i'), (e: unknown) => isErr('omni_unreadable', false)(e) && /ссылка на клип неверна/.test((e as Error).message));
});

test('скачивание: ключ уходит только по https', async () => {
  const plain = fake([byLink('http://generativelanguage.googleapis.com/v1beta/files/abc:download'), () => new Response(new Uint8Array(Buffer.from('MP4')), { status: 200 })]);
  await waitClip(plain.deps, 'i');
  assert.equal((plain.calls[1].init?.headers as Record<string, string>)['x-goog-api-key'], undefined);
});

test('готовый ответ неожиданной формы — omni_unreadable без повтора: генерация оплачена, её надо забрать, а не снимать заново', async () => {
  const a = fake([{ body: { status: 'completed', steps: { type: 'model_output' } } }]);
  await assert.rejects(waitClip(a.deps, 'int-7'), (e: unknown) => isErr('omni_unreadable', false)(e) && /int-7/.test((e as Error).message) && /нет ни видео, ни текста/.test((e as Error).message));
  const b = fake([{ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', file_uri: 'x' }] }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), (e: unknown) => isErr('omni_unreadable', false)(e) && /поля: type, file_uri/.test((e as Error).message));
});

test('опрос своей генерации отвергнут (400) — не фильтр контента, а omni_unreadable', async () => {
  const { deps } = fake([{ status: 400, body: '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"bad name"}}' }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_unreadable', false)(e) && /опрос отвергнут/.test((e as Error).message));
});

test('опрос не выходит за срок: сон обрезается остатком', async () => {
  const { deps } = fake([inProgress, inProgress, inProgress]);
  deps.pollEveryMs = 70;
  deps.pollTimeoutMs = 100;
  await assert.rejects(waitClip(deps, 'i'), isErr('omni_timeout', true));
  assert.equal(deps.now!(), 100);
});

test('отказ фильтра приходит массивом errors — повторяемый omni_rejected, и с числовым кодом 3', async () => {
  const a = fake([{ body: { status: 'failed', errors: [{ code: 'INVALID_ARGUMENT', message: 'There was a problem processing your request' }] } }]);
  await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_rejected', true));
  const b = fake([{ body: { status: 'failed', errors: [{ code: 3, status: 'INVALID_ARGUMENT', message: 'problem' }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), isErr('omni_rejected', true));
});

test('прочий провал и нехватка мощностей после приёма — omni_failed с повтором; 404 опроса — не «модель снята»', async () => {
  const a = fake([{ body: { status: 'failed', errors: [{ code: 'INTERNAL', message: 'boom' }] } }]);
  await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_failed', true));
  const b = fake([{ body: { status: 'failed', errors: [{ code: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), isErr('omni_failed', true));
  const c = fake([{ status: 404, body: '{"error":{"message":"Interaction not found"}}' }]);
  await assert.rejects(waitClip(c.deps, 'i'), isErr('omni_failed', true));
});

test('готово, но без видео — omni_rejected с текстом модели', async () => {
  const { deps } = fake([{ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Не могу' }] }] } }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_rejected', true)(e) && /Не могу/.test((e as Error).message));
});

test('не дождались — omni_timeout: генерация может ещё закончиться; срок — по часам, а не по числу опросов', async () => {
  const a = fake([inProgress, inProgress, inProgress]);
  await assert.rejects(waitClip(a.deps, 'i'), (e: unknown) => isErr('omni_timeout', true)(e) && /не дождались/.test((e as Error).message));
  const slow = fake(Array.from({ length: 10 }, () => inProgress), 40);
  slow.deps.pollTimeoutMs = 100;
  await assert.rejects(waitClip(slow.deps, 'i'), isErr('omni_timeout', true));
  assert.ok(slow.calls.length <= 3, `опросов ${slow.calls.length} — срок не считает время запросов`);
});

test('поминутный лимит при опросе пережидается в пределах срока', async () => {
  const limit = { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ retryDelay: '90s' }] } } };
  const { deps, calls } = fake([limit, inProgress, inProgress]);
  deps.pollTimeoutMs = 100;
  await assert.rejects(waitClip(deps, 'i'), isErr('omni_timeout', true));
  assert.equal(calls.length, 1, 'после паузы до конца срока опросов быть не должно');
});
