import { StudioError, type StudioErrorCode } from '../errors';

/**
 * Google Generative Language API: кадр-эталон (Nano Banana Pro) и клип сценки
 * (Gemini Omni Flash, Interactions API). Формы запросов сняты живыми вызовами
 * 24–26.10.2026 — см. src/misc/veo.service.ts бэкенда. Ключ — только в
 * заголовке; в сообщения ошибок он не попадает, даже если Google повторил его
 * в ответе.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const KEYFRAME_MODEL = 'gemini-3-pro-image-preview';
export const OMNI_MODEL = 'gemini-omni-1.1-flash';
/** Длина клипа сценки, секунды: сценки по 8 с, без продления (спека). */
export const CLIP_SEC = 8;
/** Цены для отчёта о тратах (прайс Google на 26.10.2026): секунда Omni при 720p и кадр Nano Banana Pro. */
export const OMNI_USD_PER_SEC = 0.1;
export const KEYFRAME_USD = 0.13;

/** Таймаут одного запроса: кадр рисуется до пары минут, запуск и опрос — быстрые. */
const KEYFRAME_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Поминутный лимит пережидается на месте, не сжигая попытку: до двух раз, каждый — не дольше полутора минут. */
const RATE_RETRIES = 2;
const MAX_RATE_WAIT_MS = 90_000;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** 404 опроса подряд, после которых генерация считается потерянной: свежую Google иногда не показывает опросу секунды. */
const POLL_NOT_FOUND_LIMIT = 3;

export interface GoogleDeps {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Опрос Omni: шаг и срок на одну генерацию — по часам, а не по числу опросов. */
  pollEveryMs?: number;
  pollTimeoutMs?: number;
}

export interface ImageInput {
  data: Buffer;
  mime: string;
}

/**
 * Отказы Google при запуске клипа (startClip), после которых он точно не
 * запущен — секунды Omni можно вернуть. После прочих сбоев запуска (5xx,
 * потерянный ответ) генерация могла начаться и будет оплачена.
 */
export const CLEAR_REFUSALS: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(['google_quota', 'google_auth', 'model_gone', 'omni_rejected']);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const headers = (d: GoogleDeps) => ({ 'x-goog-api-key': d.apiKey, 'Content-Type': 'application/json' });
/**
 * Ключи Google начинаются с «AIza»; Google повторяет ключ, например, в 403
 * «Consumer … suspended». Свой ключ вырезается ещё и буквально — формат
 * может смениться. Вырезать — до обрезки текста: обрезанный ключ уже не узнать.
 */
const redact = (s: string, key = ''): string => {
  const out = s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '<ключ>');
  return key.length >= 8 ? out.split(key).join('<ключ>') : out;
};
const errText = (e: unknown, key = ''): string => redact(e instanceof Error ? e.message : String(e), key);
/** Массив или пусто: форма ответа Google может смениться, и TypeError на готовом клипе обернулся бы пересъёмкой. */
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** Тип картинки по сигнатуре: Nano Banana Pro отдаёт JPEG, хотя кадры принято звать .png. */
export function imageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

interface GoogleError {
  code?: number;
  status?: string;
  message?: string;
  details?: unknown;
}
interface ErrorDetail {
  reason?: string;
  retryDelay?: string;
  violations?: unknown;
}

function parseError(body: string): GoogleError | undefined {
  try {
    const err = (JSON.parse(body) as { error?: unknown } | null)?.error;
    return err && typeof err === 'object' ? (err as GoogleError) : undefined;
  } catch {
    return undefined;
  }
}

const errMessage = (err: GoogleError | undefined): string => (typeof err?.message === 'string' ? err.message : '');
const quotaIds = (err: GoogleError | undefined): string[] =>
  arr<ErrorDetail>(err?.details).flatMap((x) => arr<{ quotaId?: unknown }>(x?.violations)).map((v) => String(v?.quotaId ?? ''));
/** Суточная или нулевая квота за минуту не пройдёт, даже если Google приложил RetryInfo. */
const quotaForTheDay = (err: GoogleError | undefined): boolean =>
  quotaIds(err).some((q) => /PerDay|Daily/i.test(q)) || /limit: 0\b/.test(errMessage(err));

/** Пауза, которую стоит выждать при поминутном лимите; null — лимит не поминутный (суточный, нулевой, долгий). */
export function rateLimitDelayMs(body: string): number | null {
  const err = parseError(body);
  if (quotaForTheDay(err)) return null;
  const retry = arr<ErrorDetail>(err?.details).find((x) => typeof x?.retryDelay === 'string')?.retryDelay;
  const sec = parseFloat(retry ?? '');
  if (Number.isFinite(sec) && sec > 0) return sec * 1000 <= MAX_RATE_WAIT_MS ? Math.ceil(sec * 1000) : null;
  const perMinute = quotaIds(err).some((q) => /PerMinute/i.test(q)) || /per ?minute/i.test(errMessage(err));
  return perMinute ? 60_000 : null;
}

/**
 * HTTP-ошибка Google → StudioError. Квота, ключ и снятая модель повтором не
 * лечатся: каждая лишняя попытка Omni стоит денег.
 */
export function googleHttpError(what: 'keyframe' | 'omni', status: number, body: string, key = ''): StudioError {
  const err = parseError(body);
  const said = redact(errMessage(err) || body, key).slice(0, 300);
  const reasons = arr<ErrorDetail>(err?.details)
    .map((x) => x?.reason)
    .filter(Boolean)
    .join(', ');
  if (status === 429 || err?.status === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(body)) {
    const why = /limit: 0\b/.test(errMessage(err) || body)
      ? 'квота ключа нулевая — проверить биллинг в Google AI Studio'
      : rateLimitDelayMs(body) != null
        ? 'поминутный лимит — повторить через пару минут'
        : quotaForTheDay(err)
          ? 'суточная квота — обновляется ≈ в 11:00 МСК'
          : 'вид лимита Google не указал — повторить через несколько минут; не пройдёт — суточная квота, ≈ в 11:00 МСК';
    return new StudioError('google_quota', `${what}: лимит Google исчерпан (HTTP ${status}), ${why}: ${said}`, false);
  }
  if (status === 401 || status === 403 || reasons.includes('API_KEY_INVALID') || /API key not valid/i.test(body)) {
    return new StudioError('google_auth', `${what}: Google отклонил ключ GOOGLE_AI_API_KEY (HTTP ${status}${reasons ? `, ${reasons}` : ''}): ${said}`, false);
  }
  if (err?.status === 'FAILED_PRECONDITION') {
    return new StudioError('google_auth', `${what}: Google не принимает запросы ключа (HTTP ${status}, FAILED_PRECONDITION) — биллинг или регион: ${said}`, false);
  }
  if (status === 404) {
    return new StudioError('model_gone', `${what}: модель недоступна (HTTP 404) — Google её снял; переключите формат на «Только чат» и повторите ролик с from=writing (или directing). ${said}`, false);
  }
  if (what === 'omni' && status === 400 && (err?.status === 'INVALID_ARGUMENT' || /INVALID_ARGUMENT/.test(body))) {
    return new StudioError('omni_rejected', `omni: Google отклонил запрос (фильтр контента или промпт): ${said}`, true);
  }
  return new StudioError(what === 'omni' ? 'omni_failed' : 'keyframe', `${what}: Google ответил HTTP ${status}: ${said}`, true);
}

/**
 * Запрос с таймаутом; поминутный 429 пережидается здесь же (до rateRetries раз).
 * Сбой сети выходит наружу как есть.
 */
async function request(
  d: GoogleDeps,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  rateRetries = RATE_RETRIES,
): Promise<{ status: number; ok: boolean; raw: string }> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? realSleep;
  for (let i = 0; ; i++) {
    const resp = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const raw = await resp.text();
    if (resp.status === 429 && i < rateRetries) {
      const wait = rateLimitDelayMs(raw);
      if (wait != null) {
        await sleep(wait);
        continue;
      }
    }
    return { status: resp.status, ok: resp.ok, raw };
  }
}

interface KeyframeReply {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
}

export async function generateKeyframe(d: GoogleDeps, prompt: string, refs: ImageInput[]): Promise<ImageInput> {
  const body = {
    contents: [{ parts: [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data.toString('base64') } })), { text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
  };
  let r: { status: number; ok: boolean; raw: string };
  try {
    r = await request(d, `${API}/models/${KEYFRAME_MODEL}:generateContent`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) }, KEYFRAME_TIMEOUT_MS);
  } catch (e) {
    throw new StudioError('keyframe', `keyframe: запрос не прошёл — ${errText(e, d.apiKey)}`, true);
  }
  if (!r.ok) throw googleHttpError('keyframe', r.status, r.raw, d.apiKey);
  let reply: KeyframeReply;
  try {
    reply = (JSON.parse(r.raw) ?? {}) as KeyframeReply;
  } catch {
    throw new StudioError('keyframe', `keyframe: ответ не JSON: ${redact(r.raw, d.apiKey).slice(0, 200)}`, true);
  }
  // Заблокированный промпт не пройдёт и со второго раза — не тратим попытки.
  const blocked = reply.promptFeedback?.blockReason;
  if (blocked) throw new StudioError('keyframe', `keyframe: Nano Banana заблокировал промпт (${blocked})`, false);
  const cand = arr<NonNullable<KeyframeReply['candidates']>[number]>(reply.candidates)[0];
  const part = arr<{ inlineData?: { mimeType?: string; data?: string } }>(cand?.content?.parts).find((p) => typeof p?.inlineData?.data === 'string' && p.inlineData.data);
  // RECITATION и прочие отказы приходят без ошибки HTTP — просто без картинки.
  if (!part?.inlineData?.data) throw new StudioError('keyframe', `keyframe: Nano Banana не вернул картинку (${cand?.finishReason ?? 'без причины'})`, true);
  const data = Buffer.from(part.inlineData.data, 'base64');
  return { data, mime: part.inlineData.mimeType || imageMime(data) };
}

export async function startClip(d: GoogleDeps, prompt: string, image: ImageInput): Promise<string> {
  const body = {
    model: OMNI_MODEL,
    background: true,
    input: [
      { type: 'image', data: image.data.toString('base64'), mime_type: image.mime },
      { type: 'text', text: prompt },
    ],
    response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` },
  };
  let r: { status: number; ok: boolean; raw: string };
  try {
    r = await request(d, `${API}/interactions`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) }, START_TIMEOUT_MS);
  } catch (e) {
    throw new StudioError('omni_failed', `omni: запуск — ответ потерян, генерация могла начаться: ${errText(e, d.apiKey)}`, true);
  }
  if (!r.ok) {
    const err = googleHttpError('omni', r.status, r.raw, d.apiKey);
    // Прочие 4xx при запуске (413, 400 не про фильтр) — тоже явный отказ: генерация не начиналась, секунды вернутся.
    if (err.code === 'omni_failed' && r.status >= 400 && r.status < 500 && r.status !== 408) throw new StudioError('omni_rejected', err.message, true);
    throw err;
  }
  let id: unknown;
  try {
    id = (JSON.parse(r.raw) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || !id) {
    throw new StudioError('omni_failed', `omni: запуск — в ответе нет id, генерация могла начаться: ${redact(r.raw, d.apiKey).slice(0, 200)}`, true);
  }
  return id;
}

interface Interaction {
  status?: string;
  errors?: Array<{ code?: string | number; status?: string; message?: string }>;
  error?: { code?: string | number; status?: string; message?: string };
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; uri?: string; text?: string }> }>;
}

function interactionFailure(st: Interaction, key: string): StudioError {
  // Провал приходит массивом errors: [{ code, message }] (живой ответ 24.10.2026).
  const errs = Array.isArray(st.errors) ? st.errors : st.error && typeof st.error === 'object' ? [st.error] : [];
  const first = errs.find((e) => e?.message) ?? errs[0];
  const msg = redact(String(first?.message ?? `взаимодействие ${st.status}`), key).slice(0, 300);
  const code = String(first?.code ?? '');
  if (code === 'INVALID_ARGUMENT' || code === '3' || first?.status === 'INVALID_ARGUMENT') {
    return new StudioError('omni_rejected', `omni: отказ фильтра — ${msg}`, true);
  }
  return new StudioError('omni_failed', `omni: ${msg}`, true);
}

/**
 * Генерация оплачена, но студия не может её забрать: ответ незнакомой формы,
 * опрос отвергнут, ссылка не отдаёт файл. Без повтора — нужна правка студии; id
 * остаётся в animation.json, и запуск после правки заберёт клип, а не заплатит снова.
 */
const unreadable = (id: string, why: string): StudioError =>
  new StudioError('omni_unreadable', `omni: генерацию ${id} не забрать — ${why}; id сохранён, запуск после правки студии заберёт её без новой оплаты`, false);

/**
 * Готовый клип ссылкой (Files API), одна попытка. null — временный сбой
 * (сеть, 5xx, 408, 429): опрос продолжится в своём сроке, и следующий виток
 * скачает снова, а не запустит новую генерацию. 404 и 410 — файла больше нет,
 * новая генерация оправданна. Ключ — только хосту Google и только по https:
 * адрес пришёл в ответе.
 */
async function downloadOnce(d: GoogleDeps, id: string, uri: string, timeoutMs: number): Promise<Buffer | null> {
  const f = d.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw unreadable(id, `ссылка на клип неверна: ${redact(uri, d.apiKey).slice(0, 200)}`);
  }
  const host = url.hostname;
  const google = url.protocol === 'https:' && (host === 'googleapis.com' || host.endsWith('.googleapis.com'));
  let resp: Response;
  try {
    resp = await f(uri, { headers: google ? { 'x-goog-api-key': d.apiKey } : {}, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (resp.status >= 500 || resp.status === 408 || resp.status === 429) return null;
  if (resp.status === 404 || resp.status === 410) throw new StudioError('omni_failed', `omni: клип готов, но файла по ссылке уже нет (HTTP ${resp.status})`, false);
  if (!resp.ok) throw unreadable(id, `клип по ссылке не отдаётся: HTTP ${resp.status}`);
  let buf: Buffer;
  try {
    buf = Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
  if (buf.length > MAX_VIDEO_BYTES) throw unreadable(id, `клип ссылкой больше ${MAX_VIDEO_BYTES >> 20} МБ`);
  return buf;
}

/**
 * Ждёт клип. Генерация уже оплачена, поэтому сбой опроса (сеть, таймаут,
 * обрыв тела, не-JSON, 5xx, 408, 429) — не повод её бросать: опрос
 * продолжается, поминутный лимит пережидается в пределах срока. Ошибка —
 * только явный провал взаимодействия или срок (omni_timeout: генерация может
 * ещё закончиться, и её стоит дождаться, а не запускать новую).
 */
export async function waitClip(d: GoogleDeps, id: string): Promise<Buffer> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const every = d.pollEveryMs ?? 10_000;
  const limit = d.pollTimeoutMs ?? 6 * 60_000;
  const deadline = now() + limit;
  // Сон и таймауты запросов обрезаются остатком срока: иначе опрос выходил за срок на минуты.
  const left = (): number => Math.max(1000, deadline - now());
  // Последний увиденный статус — в тексте срока: незнакомый конечный статус иначе выглядел бы как «долго».
  let lastStatus = 'ответа не было';
  let notFound = 0;
  while (now() < deadline) {
    await sleep(Math.min(every, Math.max(0, deadline - now())));
    let st: Interaction;
    try {
      const r = await request(d, `${API}/interactions/${id}`, { headers: { 'x-goog-api-key': d.apiKey } }, Math.min(POLL_TIMEOUT_MS, left()), 0);
      if (!r.ok) {
        if (r.status === 429) {
          await sleep(Math.min(rateLimitDelayMs(r.raw) ?? 0, Math.max(0, deadline - now())));
          continue;
        }
        if (r.status >= 500 || r.status === 408) continue;
        if (r.status === 404) {
          // Новая оплата — только после нескольких 404 подряд: одиночный бывает и у живой генерации.
          if (++notFound < POLL_NOT_FOUND_LIMIT) continue;
          throw new StudioError('omni_failed', `omni: взаимодействие ${id} не найдено (HTTP 404, ${POLL_NOT_FOUND_LIMIT} раза подряд)`, true);
        }
        const err = googleHttpError('omni', r.status, r.raw, d.apiKey);
        // Отказ на опросе своей генерации — не фильтр, а сбой API или студии: генерация может быть оплачена.
        throw err.code === 'google_auth' || err.code === 'google_quota' ? err : unreadable(id, `опрос отвергнут — ${err.message}`);
      }
      st = (JSON.parse(r.raw) ?? {}) as Interaction;
      notFound = 0;
      lastStatus = typeof st.status === 'string' && st.status ? st.status : 'пустой';
    } catch (e) {
      if (e instanceof StudioError) throw e;
      continue;
    }
    if (st.status === 'completed') {
      const parts = arr<NonNullable<Interaction['steps']>[number]>(st.steps)
        .filter((s) => s?.type === 'model_output')
        .flatMap((s) => arr<NonNullable<NonNullable<Interaction['steps']>[number]['content']>[number]>(s.content));
      const video = parts.filter((c) => c?.type === 'video').pop();
      if (typeof video?.data === 'string' && video.data) return Buffer.from(video.data, 'base64');
      if (typeof video?.uri === 'string' && video.uri) {
        const got = await downloadOnce(d, id, video.uri, Math.min(DOWNLOAD_TIMEOUT_MS, left()));
        if (got) return got;
        continue;
      }
      if (video) throw unreadable(id, `у видео в ответе нет data и uri (поля: ${Object.keys(video).join(', ')})`);
      const said = parts
        .filter((c) => c?.type === 'text' && c.text)
        .map((c) => c.text)
        .join(' ')
        .trim();
      // Отказ модели — это текст без видео; ответ без того и другого — незнакомая форма, а не отказ.
      if (!said) throw unreadable(id, 'в готовом ответе нет ни видео, ни текста модели');
      throw new StudioError('omni_rejected', `omni: видео нет — модель ответила: ${redact(said, d.apiKey).slice(0, 300)}`, true);
    }
    if (st.status === 'failed' || st.status === 'cancelled') throw interactionFailure(st, d.apiKey);
    // in_progress, queued, пустой или незнакомый статус — ждём дальше.
  }
  throw new StudioError('omni_timeout', `omni: не дождались клипа за ${Math.round(limit / 60_000)} мин (последний статус: ${lastStatus}) — генерация может ещё закончиться`, true);
}
