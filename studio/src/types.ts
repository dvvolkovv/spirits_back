/** Сцена, которую нужно снять: что и у какого ассистента спросить. */
export interface Scene {
  kind: 'chat';
  assistantId: number;
  /** Имя ассистента как в кабинете — по нему проверяется, что открыт нужный. */
  assistantName: string;
  question: string;
  /** Ответы на встречный вопрос ассистента, по порядку. Используется не больше двух. */
  followups: string[];
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
  /** Голос ассистента — из src/speech/voices.ts бэкенда. */
  voice: string;
  speed?: number;
  lines: ScriptLine[];
  /** Число ассистентов — из базы; его же словами произносит финальная реплика (сценарий пишет бэкенд). */
  final: { assistantsCount: number; disclaimer?: string };
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
  questionShot: string;
  answerShot: string;
  answerShotHeight: number;
  boxes: ImageBox[];
  timeline: Timeline;
  final: { assistantsCount: number; disclaimer?: string };
};
