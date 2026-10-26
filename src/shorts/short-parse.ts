/**
 * Разбор ответов режиссёра и сценариста. Ошибки уходят в `last_error` ролика
 * и в личку владельцу, поэтому несут начало ответа: без него неясно, что
 * модель прислала вместо JSON — переспросила, извинилась или оборвалась.
 */
import { Skit, SkitLine } from './short-skit-prompts';
import { TroupeId } from './short-troupe';

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

/**
 * Телефон и почта в кадр не идут: вопрос задаётся на демо-аккаунте и попадает в ролик.
 * Телефон — по виду номера РФ и СНГ, а не по длине цифр: «120 000 000» и
 * «1 200 000 - 1 500 000» в вопросе про деньги — суммы. С «+» код оператора
 * бывает двузначным («+375 29 …», «+380 67 …»), после 8 или 7 без «+» — только
 * трёхзначный, как у номеров России и Казахстана.
 */
const PHONE = /(?:\+\d{1,3}[\s(-]*\d{2,3}|\b[78][\s(-]*\d{3})[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/;
const PII = [PHONE, /[\w.+-]+@[\w-]+\.[\w.]+/];

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

const FENCE_RE = /`{3}(?:json)?\s*([\s\S]*?)`{3}/gi;

/** Разбирает текст как JSON-объект; массив, не-объект и невалидный JSON — null. */
function parseIfObject(candidate: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Объект JSON из ответа релея: в заборах с json (берём последний, который
 * разбирается в объект — модель иногда сначала даёт пример, потом ответ) или
 * между первой { и последней } без забора. Ответ-массив — с забором или без —
 * всегда отвергается, даже если внутри один объект.
 */
export function extractJsonObject(raw: string, who: string): Record<string, any> {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error(`${who}: пустой ответ`);
  const fences = Array.from(text.matchAll(FENCE_RE));
  let parsed: Record<string, any> | null = null;
  if (fences.length) {
    for (let i = fences.length - 1; i >= 0 && !parsed; i--) {
      parsed = parseIfObject(fences[i][1].trim());
    }
  } else if (!/^\s*\[/.test(text)) {
    const candidate = sliceOuterObject(text);
    if (candidate) parsed = parseIfObject(candidate);
  }
  if (!parsed) {
    throw new Error(`${who}: не нашёл JSON в ответе; начало ответа: «${rawSnippet(text)}»`);
  }
  return parsed;
}

/**
 * Сценка из ответа модели — полями (спека сценок, «Кто пишет сценки»). Разбор
 * отвергает только то, что не назвать нарушением: не объект, кривой номер
 * абзаца. Правила 16–18 и английские поля проверяет checkSkitRules — их
 * нарушения уходят модели на переписку, а не в повтор этапа.
 */
export function parseSkit(v: unknown, who: string, field: string): Skit {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${who}: ${field} — объект {cast, setting, opening, action, lines}`);
  }
  const o = v as Record<string, any>;
  const cast = Array.isArray(o.cast) ? o.cast.map((c: any) => ({ hero: str(c?.hero) as TroupeId, role: str(c?.role) })) : [];
  const lines = Array.isArray(o.lines)
    ? o.lines.map((l: any, i: number): SkitLine => {
        const line: SkitLine = { hero: str(l?.hero) as TroupeId, text: str(l?.text) };
        if (l?.box !== null && l?.box !== undefined && l?.box !== '') {
          const box = Number(l.box);
          if (!Number.isInteger(box)) throw new Error(`${who}: ${field}, реплика ${i + 1} — box должен быть номером абзаца`);
          line.box = box;
        }
        return line;
      })
    : [];
  return { cast, setting: str(o.setting), opening: str(o.opening), action: str(o.action), lines };
}

export interface DirectorReply {
  assistantId: number;
  question: string;
  followups: string[];
  title: string;
  /** Сценка 1 (конфликт) — у ролика формата skit. */
  skit: Skit | null;
}

export function parseDirectorReply(
  raw: string,
  ctx: { assistantIds: ReadonlySet<number>; fixedAssistantId: number | null; skit?: boolean },
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
  const skit = ctx.skit ? parseSkit(o.skit, 'режиссёр', 'skit') : null;
  return { assistantId, question, followups, title: Array.from(title).slice(0, MAX_TITLE_CHARS).join(''), skit };
}

export interface WriterReply {
  needsRecapture: boolean;
  reason: string;
  hook: string;
  hookBox: number | null;
  question: string;
  lines: Array<{ box: number; text: string }>;
  captions: { telegram: string; vk: string; youtube: { title: string; description: string; tags: string[] } };
  /**
   * Сценки ролика формата skit: развязка обязательна, конфликт — только если
   * сценарист его переписал по замечанию (иначе null: остаётся прежний).
   */
  skits: { conflict: Skit | null; punchline: Skit | null };
}

const NO_SKITS: WriterReply['skits'] = { conflict: null, punchline: null };

const EMPTY_CAPTIONS: WriterReply['captions'] = { telegram: '', vk: '', youtube: { title: '', description: '', tags: [] } };

export function parseWriterReply(raw: string, opts: { skit?: boolean } = {}): WriterReply {
  const o = extractJsonObject(raw, 'сценарист');
  if (o.needsRecapture === true) {
    const reason = str(o.reason);
    if (!reason) throw new Error('сценарист: просит переснять, но не объяснил почему');
    return { needsRecapture: true, reason, hook: '', hookBox: null, question: '', lines: [], captions: EMPTY_CAPTIONS, skits: NO_SKITS };
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
  const skits = opts.skit
    ? {
        conflict: o.conflict === null || o.conflict === undefined ? null : parseSkit(o.conflict, 'сценарист', 'conflict'),
        punchline: parseSkit(o.punchline, 'сценарист', 'punchline'),
      }
    : NO_SKITS;
  return { needsRecapture: false, reason: '', hook, hookBox, question, lines, captions, skits };
}
