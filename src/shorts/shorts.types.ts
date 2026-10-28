/**
 * Короткие ролики: типы, машина состояний и контракт со студией.
 *
 * Спека: docs/superpowers/specs/2026-10-24-promo-shorts-design.md.
 *
 * Поля jsonb (`scene`, `capture`, `script`, `animation`) пишут две стороны:
 * API — сцену и сценарий, студия (`studio/`) — съёмку и оживление. Их форма —
 * зеркало `studio/src/types.ts` и `studio/src/worker/db.ts`. Импортировать
 * оттуда нельзя: студия — отдельный ESM-пакет вне сборки API. Совпадение имён
 * полей сторожит shorts.contract.spec.ts.
 *
 * Сценки: docs/superpowers/specs/2026-10-26-shorts-skits-design.md.
 */
import type { Skit, SkitKind, SkitPlan } from './short-skit-prompts';

export type ShortRubric = 'assistant' | 'feature' | 'news' | 'case';
export type ShortAngle = 'uncomfortable' | 'roast' | 'myth' | 'calm';
export type ShortSource = 'catalog' | 'git' | 'manual';
export type ShortStatus =
  | 'idea' | 'directing' | 'capture_queued' | 'capturing' | 'writing'
  | 'animate_queued' | 'animating'
  | 'render_queued' | 'rendering' | 'pending_review' | 'approved'
  | 'publishing' | 'published' | 'rejected' | 'failed';
/**
 * Формат ролика: `skit` — сценки с героями вокруг настоящего ответа, `chat` —
 * только съёмка чата (запасной, если Google снимет Omni). Ролик запоминает
 * формат при запуске, чтобы переключение настройки посреди работы его не ломало.
 */
export type ShortFormat = 'skit' | 'chat';
export type ShortPlatform = 'telegram' | 'vk' | 'youtube';
export type PublicationStatus =
  | 'pending' | 'publishing' | 'published' | 'failed' | 'manual_pending' | 'manual_done';
/** Режим YouTube (003): manual — набор владельцу, unlisted — «по ссылке», public — «публично». */
export type YoutubeMode = 'manual' | 'unlisted' | 'public';
export const YOUTUBE_MODES: readonly YoutubeMode[] = ['manual', 'unlisted', 'public'];

export const RUBRICS: readonly ShortRubric[] = ['assistant', 'feature', 'news', 'case'];
export const ANGLES: readonly ShortAngle[] = ['uncomfortable', 'roast', 'myth', 'calm'];
export const FORMATS: readonly ShortFormat[] = ['skit', 'chat'];
/** Провокационные подачи: два ролика из любых трёх подряд (спека, «Подача»; ритм — `nextAngle` в short-rhythm.ts). */
export const PROVOCATIVE_ANGLES: readonly ShortAngle[] = ['uncomfortable', 'roast', 'myth'];

export const RUBRIC_TITLES: Record<ShortRubric, string> = {
  assistant: 'Ассистент за работой',
  feature: 'Возможность Linkeon',
  news: 'Новинка',
  case: 'Реальный кейс',
};

export const ANGLE_TITLES: Record<ShortAngle, string> = {
  uncomfortable: 'Неудобный вопрос',
  roast: 'Разнос',
  myth: 'ИИ против мифа',
  calm: 'Как это работает',
};

/** Ролик в работе: предназначен своему слоту и считается в предел MAX_IN_WORK. */
export const IN_WORK_STATUSES: readonly ShortStatus[] = [
  'directing', 'capture_queued', 'capturing', 'writing', 'animate_queued', 'animating', 'render_queued', 'rendering', 'pending_review',
];

/** Слот держат ровно эти статусы — предикат uq_short_video_slot (сверяет shorts-schema.spec.ts). */
export const SLOT_HOLDING_STATUSES: readonly ShortStatus[] = ['approved', 'publishing'];

/** Больше стольких роликов в работе крон одновременно не запускает (спека, «Расписание»). */
export const MAX_IN_WORK = 2;

/**
 * Допустимые переходы. Главное, что здесь закрыто: в `publishing` ведёт только
 * `approved`, а в `approved` — кнопка «Одобрить» (`pending_review`), возврат
 * сорвавшейся отправки (`publishing`, ролик уже одобрен) и повтор публикации
 * из `failed`. Последний дополнительно требует `approved_at` (`retryTarget`):
 * ролик, упавший на съёмке, одобрения не получал, и путь «failed → approved»
 * открыл бы ему канал мимо человека.
 *
 * Возвраты на ту же стадию (`capturing → capture_queued`,
 * `animating → animate_queued`, `rendering → render_queued`) — повтор задания
 * студии после сбоя. Сценарист отдаёт ролик формата `skit` на оживление
 * (`writing → animate_queued`), формата `chat` — сразу на сборку.
 * `rendering → writing` — озвучка вышла за 30–60 с или реплика ответа короче
 * 1,5 с: сценарий уходит на переписку с пояснением. `writing → directing` —
 * сценарист просит другую сцену.
 */
export const ALLOWED_TRANSITIONS: Record<ShortStatus, ShortStatus[]> = {
  idea:           ['directing', 'rejected'],
  directing:      ['capture_queued', 'failed'],
  capture_queued: ['capturing'],
  capturing:      ['writing', 'capture_queued', 'failed'],
  writing:        ['animate_queued', 'render_queued', 'directing', 'failed'],
  animate_queued: ['animating'],
  animating:      ['render_queued', 'animate_queued', 'failed'],
  render_queued:  ['rendering'],
  rendering:      ['pending_review', 'render_queued', 'writing', 'failed'],
  pending_review: ['approved', 'writing', 'directing', 'rejected'],
  approved:       ['publishing', 'directing', 'rejected'],
  publishing:     ['published', 'approved', 'failed'],
  published:      [],
  rejected:       [],
  failed:         ['directing', 'capture_queued', 'writing', 'animate_queued', 'render_queued', 'approved', 'rejected'],
};

export function canTransition(from: ShortStatus, to: ShortStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/** С какого статуса продолжить упавший ролик — по этапу, на котором он упал. */
const RESUME_FROM: Partial<Record<ShortStatus, ShortStatus>> = {
  directing: 'directing',
  capturing: 'capture_queued',
  writing: 'writing',
  // Готовые кадры и клипы задание возьмёт по отпечатку, запущенную генерацию — дождётся.
  animating: 'animate_queued',
  rendering: 'render_queued',
};

/**
 * Куда вернуть упавший ролик кнопкой «Повторить». null — повторять нечего.
 * Публикация повторяется только у ролика, который владелец одобрял.
 */
export function retryTarget(v: Pick<ShortVideo, 'status' | 'failedFrom' | 'approvedAt'>): ShortStatus | null {
  if (v.status !== 'failed' || !v.failedFrom) return null;
  if (v.failedFrom === 'publishing') return v.approvedAt ? 'approved' : null;
  return RESUME_FROM[v.failedFrom] ?? null;
}

/** Сколько приглашений к замечанию и к ссылке YouTube помним на ролике (как MAX_NOTE_PROMPTS блога). */
export const MAX_NOTE_PROMPTS = 20;

/** Предел накопленных замечаний: они уходят сценаристу и режиссёру целиком. */
export const MAX_OWNER_NOTE_CHARS = 2000;

/**
 * Замечание в конец накопленных, отдельной строкой. Второе замечание не
 * отменяет первое — как у блога (`appendEditorNote`). Сверх предела целиком
 * уходит самая старая строка, а не середина текста: иначе режиссёр и
 * сценарист получают обрывок чужой фразы вместо всей своей.
 */
export function appendOwnerNote(prev: string | null, note: string): string {
  const fresh = Array.from(String(note ?? '').trim()).slice(0, MAX_OWNER_NOTE_CHARS).join('');
  const prevLines = String(prev ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const lines = fresh ? [...prevLines, fresh] : prevLines;
  while (lines.length > 1 && Array.from(lines.join('\n')).length > MAX_OWNER_NOTE_CHARS) {
    lines.shift();
  }
  return lines.join('\n');
}

/** Общий бакет видео (спека, «Что переиспользуем»); ролики — с префиксом shorts/. */
export function shortsBucket(env: Record<string, string | undefined> = process.env): string {
  return env.MINIO_BUCKET_VIDEOS || 'linkeon-smm-videos';
}

// ── Контракт со студией (зеркало studio/src/types.ts) ──────────────────────

/** Сцена чата: что и у какого ассистента спросить. */
export interface ShortScene {
  kind: 'chat';
  assistantId: number;
  /** Имя как в кабинете (agents.name): по нему студия проверяет, что открыт нужный ассистент. */
  assistantName: string;
  question: string;
  /** Ответы на встречный вопрос ассистента, по порядку; используется не больше двух. */
  followups: string[];
  /** Сценка 1 (конфликт) от режиссёра — у ролика формата `skit`. Съёмка её не читает. */
  skit?: Skit;
}

export interface ShortBox {
  n: number;
  top: number;
  height: number;
  text: string;
}

/** Абзац ответа целиком — его пересказывает реплика сценария. */
export interface ShortParagraph {
  n: number;
  text: string;
}

/** Съёмка, как её пишет студия (studio/src/worker/db.ts, StoredCapture). */
export interface ShortCapture {
  scene: ShortScene;
  cabinetUrl: string;
  capturedAt: string;
  questionShotKey: string;
  answerShotKey: string;
  answerShotWidth: number;
  answerShotHeight: number;
  answerText: string;
  turns: number;
  boxes: ShortBox[];
  paragraphs: ShortParagraph[];
}

export type ShortLineScene = 'hook' | 'question' | 'answer' | 'final';

export interface ShortScriptLine {
  id: string;
  scene: ShortLineScene;
  text: string;
  box?: number;
  voice?: string;
}

export interface ShortScript {
  hook: string;
  /** Абзац, на котором держится смелая фраза зацепки (правило 10). */
  hookBox?: number;
  /** Подпись в кадре вопроса — у реального кейса. */
  badge?: string;
  voice: string;
  speed: number;
  lines: ShortScriptLine[];
  final: { assistantsCount: number; disclaimer?: string };
  /** Сценки с готовыми промптами и отпечатками — у ролика формата `skit` (planSkits). */
  skits?: Record<SkitKind, SkitPlan>;
}

/** Готовая сценка, как её пишет задание animate (зеркало SkitClip в studio/src/types.ts). Пути — относительно `shorts/<id>/`. */
export interface ShortSkitClip {
  fingerprint: string;
  keyframe: string;
  clip: string;
  durationMs: number;
  heard: string;
  cues: { line: number; startMs: number; endMs: number }[];
  attempts: number;
  post: string;
}

/**
 * Итог задания animate (зеркало ShortAnimation в studio/src/types.ts): секунды
 * Omni и кадры — счёт денег ролика со всеми попытками, сценки — частично
 * заполненные, `pending` — запущенные, но не скачанные генерации.
 */
export interface ShortAnimation {
  omniSeconds: number;
  keyframes?: number;
  skits: Partial<Record<SkitKind, ShortSkitClip>>;
  pending?: Partial<Record<SkitKind, { id: string; fingerprint: string }>>;
}

/** Подписи площадок — уже со ссылками и пометкой о синтезированном голосе. */
export interface ShortCaptions {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

// ── Строки таблиц ──────────────────────────────────────────────────────────

export interface ShortVideo {
  id: string;
  rubric: ShortRubric;
  angle: ShortAngle;
  angleLocked: boolean;
  source: ShortSource;
  sourceRef: string | null;
  topicKey: string;
  topicHint: string | null;
  title: string | null;
  assistantId: number | null;
  slug: string | null;
  lang: string;
  format: ShortFormat;
  scene: ShortScene | null;
  capture: ShortCapture | null;
  script: ShortScript | null;
  captions: ShortCaptions | null;
  animation: ShortAnimation | null;
  videoKey: string | null;
  coverKey: string | null;
  durationMs: number | null;
  status: ShortStatus;
  /** До одобрения — планируемый слот, после — занятый. */
  slotAt: Date | null;
  approvedAt: Date | null;
  ownerNote: string | null;
  writerFeedback: string | null;
  writerRounds: number;
  reviewChatId: number | null;
  reviewMessageId: number | null;
  notePromptIds: number[];
  ytPromptIds: number[];
  leaseUntil: Date | null;
  attempts: number;
  lastError: string | null;
  failedFrom: ShortStatus | null;
  failureNotified: boolean;
  publishedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ShortPublication {
  shortId: string;
  platform: ShortPlatform;
  status: PublicationStatus;
  externalId: string | null;
  url: string | null;
  /**
   * Монотонный счётчик захватов этой строки площадки и жетон попытки (см. platform() в
   * shorts-publisher.service.ts). retry его не обнуляет намеренно: обнулённый, он совпал бы
   * с жетоном зависшей прежней попытки. В выдаче админки — накопительный.
   */
  attempts: number;
  lastError: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
}

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: any): Date | null => (v ? new Date(v) : null);
// bigint[] node-pg отдаёт строками поэлементно; сравнение '13' === 13 молча ложно.
const ids = (v: any): number[] => (Array.isArray(v) ? v.map(Number) : []);

export function rowToShort(row: any): ShortVideo {
  return {
    id: row.id,
    rubric: row.rubric,
    angle: row.angle,
    angleLocked: row.angle_locked === true,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    topicKey: row.topic_key,
    topicHint: row.topic_hint ?? null,
    title: row.title ?? null,
    assistantId: num(row.assistant_id),
    slug: row.slug ?? null,
    lang: row.lang ?? 'ru',
    // В базе формат есть у каждой строки (002); без поля — поведение плана 2, chat.
    format: row.format === 'skit' ? 'skit' : 'chat',
    scene: row.scene ?? null,
    capture: row.capture ?? null,
    script: row.script ?? null,
    captions: row.captions ?? null,
    animation: row.animation ?? null,
    videoKey: row.video_key ?? null,
    coverKey: row.cover_key ?? null,
    durationMs: num(row.duration_ms),
    status: row.status,
    slotAt: date(row.slot_at),
    approvedAt: date(row.approved_at),
    ownerNote: row.owner_note ?? null,
    writerFeedback: row.writer_feedback ?? null,
    writerRounds: Number(row.writer_rounds || 0),
    reviewChatId: num(row.review_chat_id),
    reviewMessageId: num(row.review_message_id),
    notePromptIds: ids(row.note_prompt_ids),
    ytPromptIds: ids(row.yt_prompt_ids),
    leaseUntil: date(row.lease_until),
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ?? null,
    failedFrom: row.failed_from ?? null,
    failureNotified: row.failure_notified === true,
    publishedAt: date(row.published_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function rowToPublication(row: any): ShortPublication {
  return {
    shortId: row.short_id,
    platform: row.platform,
    status: row.status,
    externalId: row.external_id ?? null,
    url: row.url ?? null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ?? null,
    publishedAt: date(row.published_at),
    updatedAt: date(row.updated_at),
  };
}
