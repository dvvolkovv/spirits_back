/** Сцена, которую нужно снять: что и у какого ассистента спросить. */
export interface Scene {
  kind: 'chat';
  assistantId: number;
  /** Имя ассистента как в кабинете — по нему проверяется, что открыт нужный. */
  assistantName: string;
  question: string;
  /** Ответы на встречный вопрос ассистента, по порядку. Используется не больше двух. */
  followups: string[];
  /** Сценка 1 от режиссёра (ролик со сценками) — съёмка её не читает, оживление берёт сценки из сценария. */
  skit?: Skit;
}

/** Абзац ответа на высоком скриншоте, в пикселях картинки. */
export interface ImageBox {
  /** Номер с 1, сверху вниз. На него ссылаются реплики сценария. */
  n: number;
  top: number;
  height: number;
  /** Начало текста абзаца (до 120 символов) — подсказка сценаристу. */
  text: string;
}

/** Абзац ответа целиком — его пересказывает реплика сценария (сценарист бэкенда читает этот текст). */
export interface Paragraph {
  n: number;
  text: string;
}

export interface CaptureResult {
  scene: Scene;
  cabinetUrl: string;
  capturedAt: string;
  questionShot: string;
  answerShot: string;
  answerShotWidth: number;
  answerShotHeight: number;
  answerText: string;
  /** Сколько ходов ушло: 1 + ответы на встречные вопросы. */
  turns: number;
  boxes: ImageBox[];
  /** Полный текст абзацев; номера — как у boxes. */
  paragraphs: Paragraph[];
}

export type LineScene = 'hook' | 'question' | 'answer' | 'final';

export interface ScriptLine {
  id: string;
  scene: LineScene;
  text: string;
  /** Номер абзаца. Обязателен у сцены answer, у остальных запрещён. */
  box?: number;
  /** Голос SpeechKit этой реплики; по умолчанию — Script.voice. */
  voice?: string;
}

export interface Script {
  hook: string;
  /** Абзац, на котором держится смелая фраза зацепки (правило текста 10). */
  hookBox?: number;
  /** Подпись в кадре вопроса — у реального кейса. */
  badge?: string;
  /** Голос ассистента — из src/speech/voices.ts бэкенда. */
  voice: string;
  speed?: number;
  lines: ScriptLine[];
  /** Число ассистентов — из базы; его же словами произносит финальная реплика (сценарий пишет бэкенд). */
  final: { assistantsCount: number; disclaimer?: string };
  /** Сценки — у ролика формата «Сценки». Без них ролик собирается по-старому (композиция Short). */
  skits?: Record<SkitKind, SkitPlan>;
}

export interface VoicedLine extends ScriptLine {
  durationMs: number;
  /** Путь к mp3 относительно папки съёмки — для staticFile(). */
  audio: string;
}

export interface Segment {
  lineId: string;
  scene: LineScene;
  text: string;
  box?: number;
  audio: string;
  /** Кадр начала реплики от начала ролика. */
  from: number;
  /** Кадров звучания реплики, без паузы после неё. */
  duration: number;
}

export interface SceneSpan {
  from: number;
  duration: number;
}

export interface Timeline {
  segments: Segment[];
  scenes: Record<LineScene, SceneSpan>;
  totalFrames: number;
}

/** Пропсы композиции Short. Именно type, а не interface: Remotion требует Record<string, unknown>. */
export type ShortProps = {
  fps: number;
  hook: string;
  badge?: string;
  questionShot: string;
  answerShot: string;
  answerShotHeight: number;
  boxes: ImageBox[];
  timeline: Timeline;
  final: { assistantsCount: number; disclaimer?: string };
};

// ── Сценки (спека docs/superpowers/specs/2026-10-26-shorts-skits-design.md) ──

export type SkitKind = 'conflict' | 'punchline';

/** Сценки по порядку в ролике: конфликт открывает ролик, развязка идёт после ответа. */
export const SKIT_KINDS: readonly SkitKind[] = ['conflict', 'punchline'];

export interface SkitLine {
  /** id героя труппы (src/shorts/short-troupe.ts бэкенда). */
  hero: string;
  text: string;
  /** Абзац ответа, на который опирается утверждение по существу (только в развязке). */
  box?: number;
}

export interface Skit {
  cast: { hero: string; role: string }[];
  setting: string;
  /** Первый кадр — по нему рисуется кадр-эталон. */
  opening: string;
  /** Что происходит за 8 секунд — по нему Omni оживляет кадр. */
  action: string;
  lines: SkitLine[];
}

/** Сценка, готовая к оживлению: промпты и отпечатки собрал бэкенд (src/shorts/short-skit-prompts.ts, SkitPlan). */
export interface SkitPlan {
  skit: Skit;
  /** Версия листа труппы: портреты — assets/troupe/<версия>/<id>.png. */
  troupeVersion: string;
  /** Чьи портреты нужны кадру — в порядке состава. */
  heroes: string[];
  keyframePrompt: string;
  videoPrompt: string;
  /** Отпечаток кадра-эталона: кадр лежит в keyframes/<отпечаток>.<jpg|png|webp> (расширение — по типу картинки) и с тем же отпечатком не перерисовывается. */
  keyframeFingerprint: string;
  /** Отпечаток клипа (включает отпечаток кадра): клип с тем же отпечатком не переснимается. */
  fingerprint: string;
}

/** Время реплики сценки в клипе: line — номер в skit.lines с 0, время — мс от начала клипа. */
export interface SkitCue {
  line: number;
  startMs: number;
  endMs: number;
}

/** Готовая сценка. Пути — относительно папки ролика. */
export interface SkitClip {
  fingerprint: string;
  /** keyframes/<отпечаток кадра>.<jpg|png|webp> — расширение по типу картинки. */
  keyframe: string;
  /** skits/<отпечаток клипа>/clip.mp4 — громкость уже выровнена. */
  clip: string;
  durationMs: number;
  /** Что распознал SpeechKit в клипе. */
  heard: string;
  cues: SkitCue[];
  /** Номер попытки, с которой принят клип, в запуске, где его сняли; переобработка из raw.mp4 его не меняет. Оплаченные клипы считает omniSeconds. */
  attempts: number;
  /** Настройки бесплатной обработки (громкость, пороги пауз): при их смене клип переобрабатывается из raw.mp4, без Omni. */
  post: string;
}

/**
 * animation.json папки ролика — итог задания animate. Сценки — Partial:
 * частично заполненный файл — нормальное состояние (одна сценка готова,
 * другая упала). Не Animation: так называется тип DOM.
 */
export interface ShortAnimation {
  /** Секунды Omni, потраченные на ролик, со всеми попытками. */
  omniSeconds: number;
  /** Нарисовано кадров-эталонов, со всеми попытками (≈ $0,13 за кадр). */
  keyframes?: number;
  skits: Partial<Record<SkitKind, SkitClip>>;
  /** Запущенные, но ещё не скачанные генерации Omni: следующий запуск дождётся их, а не заплатит снова. */
  pending?: Partial<Record<SkitKind, { id: string; fingerprint: string }>>;
}

export interface SkitTimeline {
  segments: Segment[];
  scenes: Record<SkitKind | 'question' | 'answer' | 'final', SceneSpan>;
  totalFrames: number;
}

/** Субтитр в кадрах от начала ролика — у реплик сценок. */
export interface ClipCue {
  key: string;
  text: string;
  from: number;
  duration: number;
}

/** Пропсы композиции SkitShort. Как и ShortProps — type, а не interface. */
export type SkitShortProps = {
  fps: number;
  hook: string;
  badge?: string;
  questionShot: string;
  answerShot: string;
  answerShotHeight: number;
  boxes: ImageBox[];
  timeline: SkitTimeline;
  final: { assistantsCount: number; disclaimer?: string };
  clips: Record<SkitKind, { video: string; cues: ClipCue[] }>;
};
