import { StudioError } from '../errors';

/**
 * Google Generative Language API: кадр-эталон (Nano Banana Pro) и клип сценки
 * (Gemini Omni Flash, Interactions API). Формы запросов сняты живыми вызовами
 * 24–26.10.2026 — см. src/misc/veo.service.ts бэкенда. В ошибки не попадают
 * ни ключ, ни картинки.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const KEYFRAME_MODEL = 'gemini-3-pro-image-preview';
export const OMNI_MODEL = 'gemini-omni-1.1-flash';
/** Длина клипа сценки, секунды: сценки по 8 с, без продления (спека). */
export const CLIP_SEC = 8;

export interface GoogleDeps {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Опрос Omni: шаг и предел на одну генерацию. */
  pollEveryMs?: number;
  pollTimeoutMs?: number;
}

export interface ImageInput {
  data: Buffer;
  mime: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const headers = (d: GoogleDeps) => ({ 'x-goog-api-key': d.apiKey, 'Content-Type': 'application/json' });

/**
 * HTTP-ошибка Google → StudioError. Квота, ключ и снятая модель повтором не
 * лечатся: каждая лишняя попытка Omni стоит денег.
 */
export function googleHttpError(what: 'keyframe' | 'omni', status: number, body: string): StudioError {
  const text = body.slice(0, 300);
  if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(body)) {
    return new StudioError('google_quota', `${what}: квота Google на сегодня исчерпана — повторить после ≈ 11:00 МСК (HTTP ${status})`, false);
  }
  if (status === 401 || status === 403) return new StudioError('google_auth', `${what}: Google отклонил ключ GOOGLE_AI_API_KEY (HTTP ${status})`, false);
  if (status === 404) {
    return new StudioError('model_gone', `${what}: модель недоступна (HTTP 404) — Google её снял; переключите формат на «Только чат». ${text}`, false);
  }
  if (what === 'omni' && status === 400 && /INVALID_ARGUMENT/.test(body)) {
    return new StudioError('omni_rejected', `omni: Google отклонил запрос (фильтр контента или промпт): ${text}`, true);
  }
  return new StudioError(what === 'omni' ? 'omni_failed' : 'keyframe', `${what}: Google ответил HTTP ${status}: ${text}`, true);
}

export async function generateKeyframe(d: GoogleDeps, prompt: string, refs: ImageInput[]): Promise<Buffer> {
  const f = d.fetch ?? fetch;
  const body = {
    contents: [{ parts: [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data.toString('base64') } })), { text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
  };
  const resp = await f(`${API}/models/${KEYFRAME_MODEL}:generateContent`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) });
  const raw = await resp.text();
  if (!resp.ok) throw googleHttpError('keyframe', resp.status, raw);
  const cand = (JSON.parse(raw) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> })
    .candidates?.[0];
  const img = (cand?.content?.parts ?? []).find((p) => p?.inlineData?.data);
  // RECITATION и прочие отказы приходят без ошибки HTTP — просто без картинки.
  if (!img?.inlineData?.data) throw new StudioError('keyframe', `keyframe: Nano Banana не вернул картинку (${cand?.finishReason ?? 'без причины'})`, true);
  return Buffer.from(img.inlineData.data, 'base64');
}

export async function startClip(d: GoogleDeps, prompt: string, image: ImageInput): Promise<string> {
  const f = d.fetch ?? fetch;
  const body = {
    model: OMNI_MODEL,
    background: true,
    input: [
      { type: 'image', data: image.data.toString('base64'), mime_type: image.mime },
      { type: 'text', text: prompt },
    ],
    response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` },
  };
  const resp = await f(`${API}/interactions`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) });
  const raw = await resp.text();
  if (!resp.ok) throw googleHttpError('omni', resp.status, raw);
  const id = (JSON.parse(raw) as { id?: string }).id;
  if (!id) throw new StudioError('omni_failed', `omni: в ответе нет id взаимодействия: ${raw.slice(0, 200)}`, true);
  return id;
}

interface Interaction {
  status?: string;
  errors?: Array<{ code?: string; message?: string }>;
  error?: { code?: string; message?: string };
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; text?: string }> }>;
}

/** Ждёт клип. Сбой сети и 5xx при опросе — не повод бросать оплаченную генерацию: опрос продолжается. */
export async function waitClip(d: GoogleDeps, id: string): Promise<Buffer> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? realSleep;
  const every = d.pollEveryMs ?? 10_000;
  const limit = d.pollTimeoutMs ?? 6 * 60_000;
  for (let waited = 0; waited < limit; waited += every) {
    await sleep(every);
    let resp: Response;
    try {
      resp = await f(`${API}/interactions/${id}`, { headers: { 'x-goog-api-key': d.apiKey } });
    } catch {
      continue;
    }
    const raw = await resp.text();
    if (!resp.ok) {
      if (resp.status >= 500) continue;
      throw googleHttpError('omni', resp.status, raw);
    }
    const st = JSON.parse(raw) as Interaction;
    if (st.status === 'in_progress') continue;
    if (st.status !== 'completed') {
      // Провал приходит массивом errors: [{ code, message }] (живой ответ 24.10.2026).
      const errs = Array.isArray(st.errors) ? st.errors : st.error ? [st.error] : [];
      const first = errs.find((e) => e?.message) ?? errs[0];
      const msg = first?.message ?? `взаимодействие ${st.status ?? 'без статуса'}`;
      if (first?.code === 'INVALID_ARGUMENT') throw new StudioError('omni_rejected', `omni: отказ фильтра — ${msg}`, true);
      if (first?.code === 'RESOURCE_EXHAUSTED' || /quota/i.test(msg)) {
        throw new StudioError('google_quota', `omni: квота Google на сегодня исчерпана — повторить после ≈ 11:00 МСК (${msg})`, false);
      }
      throw new StudioError('omni_failed', `omni: ${msg}`, true);
    }
    const parts = (st.steps ?? []).filter((s) => s?.type === 'model_output').flatMap((s) => s.content ?? []);
    const video = parts.filter((c) => c?.type === 'video').pop();
    if (video?.data) return Buffer.from(video.data, 'base64');
    const said = parts
      .filter((c) => c?.type === 'text' && c.text)
      .map((c) => c.text)
      .join(' ')
      .trim();
    throw new StudioError('omni_rejected', `omni: видео нет${said ? ` — модель ответила: ${said.slice(0, 300)}` : ''}`, true);
  }
  throw new StudioError('omni_failed', `omni: не дождались клипа за ${Math.round(limit / 60_000)} мин`, true);
}
