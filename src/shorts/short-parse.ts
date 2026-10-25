/**
 * Разбор ответов режиссёра и сценариста. Ошибки уходят в `last_error` ролика
 * и в личку владельцу, поэтому несут начало ответа: без него неясно, что
 * модель прислала вместо JSON — переспросила, извинилась или оборвалась.
 */

/** Сколько символов сырого ответа кладём в ошибку — как RAW_SNIPPET_CHARS блога. */
export const RAW_SNIPPET_CHARS = 300;
export const MIN_QUESTION_CHARS = 20;
/**
 * Пузырь вопроса должен целиком влезть над полем ввода в кадре 360×640
 * (studio/src/capture/chat-scene.ts падает на question-hidden). 450 знаков —
 * около 13 строк пузыря.
 */
export const MAX_QUESTION_CHARS = 450;
const MAX_FOLLOWUP_CHARS = 300;
const MAX_TITLE_CHARS = 80;

/** Телефон и почта в кадр не идут: вопрос задаётся на демо-аккаунте и попадает в ролик. */
const PII = [/\+?\d[\d\s()-]{9,}\d/, /[\w.+-]+@[\w-]+\.[\w.]+/];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const len = (s: string): number => Array.from(s).length;

export function rawSnippet(text: string): string {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length <= RAW_SNIPPET_CHARS ? chars.join('') : `${chars.slice(0, RAW_SNIPPET_CHARS).join('')}…`;
}

function sliceOuterObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start < 0 || end <= start ? null : text.slice(start, end + 1);
}

/** Объект JSON из ответа релея: в заборе с json или между первой { и последней }. */
export function extractJsonObject(raw: string, who: string): Record<string, any> {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error(`${who}: пустой ответ`);
  const fenced = text.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/i);
  const candidate = fenced ? fenced[1].trim() : sliceOuterObject(text);
  let parsed: any = null;
  if (candidate) {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${who}: не нашёл JSON в ответе; начало ответа: «${rawSnippet(text)}»`);
  }
  return parsed;
}

export interface DirectorReply {
  assistantId: number;
  question: string;
  followups: string[];
  title: string;
}

export function parseDirectorReply(
  raw: string,
  ctx: { assistantIds: ReadonlySet<number>; fixedAssistantId: number | null },
): DirectorReply {
  const o = extractJsonObject(raw, 'режиссёр');
  const assistantId = Number(o.assistantId);
  if (!Number.isInteger(assistantId) || !ctx.assistantIds.has(assistantId)) {
    throw new Error(`режиссёр: ассистента ${o.assistantId} нет среди активных`);
  }
  if (ctx.fixedAssistantId && assistantId !== ctx.fixedAssistantId) {
    throw new Error(`режиссёр: выбрал ассистента ${assistantId}, а тема задана для ${ctx.fixedAssistantId}`);
  }
  const question = str(o.question);
  const n = len(question);
  if (n < MIN_QUESTION_CHARS || n > MAX_QUESTION_CHARS) {
    throw new Error(`режиссёр: длина вопроса ${n} — нужно ${MIN_QUESTION_CHARS}–${MAX_QUESTION_CHARS} знаков`);
  }
  if (PII.some((re) => re.test(question))) {
    throw new Error('режиссёр: в вопросе телефон или почта — персональные данные в кадр не идут');
  }
  const followups = Array.isArray(o.followups) ? o.followups.map(str).filter(Boolean).slice(0, 2) : [];
  if (!followups.length) throw new Error('режиссёр: нет заготовленного уточнения на встречный вопрос');
  if (followups.some((f) => len(f) > MAX_FOLLOWUP_CHARS || PII.some((re) => re.test(f)))) {
    throw new Error(`режиссёр: уточнение длиннее ${MAX_FOLLOWUP_CHARS} знаков или с персональными данными`);
  }
  const title = str(o.title);
  if (len(title) < 3) throw new Error('режиссёр: нет рабочего названия ролика');
  return { assistantId, question, followups, title: Array.from(title).slice(0, MAX_TITLE_CHARS).join('') };
}

export interface WriterReply {
  needsRecapture: boolean;
  reason: string;
  hook: string;
  hookBox: number | null;
  question: string;
  lines: Array<{ box: number; text: string }>;
  captions: { telegram: string; vk: string; youtube: { title: string; description: string; tags: string[] } };
}

const EMPTY_CAPTIONS: WriterReply['captions'] = { telegram: '', vk: '', youtube: { title: '', description: '', tags: [] } };

export function parseWriterReply(raw: string): WriterReply {
  const o = extractJsonObject(raw, 'сценарист');
  if (o.needsRecapture === true) {
    const reason = str(o.reason);
    if (!reason) throw new Error('сценарист: просит переснять, но не объяснил почему');
    return { needsRecapture: true, reason, hook: '', hookBox: null, question: '', lines: [], captions: EMPTY_CAPTIONS };
  }
  const hook = str(o.hook);
  if (!hook) throw new Error('сценарист: нет зацепки');
  const question = str(o.question);
  if (!question) throw new Error('сценарист: нет реплики вопроса');
  const lines = Array.isArray(o.lines) ? o.lines.map((l: any) => ({ box: Number(l?.box), text: str(l?.text) })) : [];
  if (!lines.length || lines.some((l) => !Number.isInteger(l.box) || !l.text)) {
    throw new Error('сценарист: реплики ответа — массив {box, text} с номером абзаца и текстом');
  }
  const rawHookBox = o.hookBox;
  const hookBox = rawHookBox === null || rawHookBox === undefined || rawHookBox === '' ? null : Number(rawHookBox);
  if (hookBox !== null && !Number.isInteger(hookBox)) throw new Error('сценарист: hookBox — номер абзаца или null');
  const c = o.captions ?? {};
  const yt = c.youtube ?? {};
  const captions = {
    telegram: str(c.telegram),
    vk: str(c.vk) || str(c.telegram),
    youtube: {
      title: str(yt.title),
      description: str(yt.description),
      tags: Array.isArray(yt.tags) ? yt.tags.map(str).filter(Boolean) : [],
    },
  };
  if (!captions.telegram) throw new Error('сценарист: нет подписи для Telegram');
  if (!captions.youtube.title) throw new Error('сценарист: нет заголовка для YouTube');
  return { needsRecapture: false, reason: '', hook, hookBox, question, lines, captions };
}
