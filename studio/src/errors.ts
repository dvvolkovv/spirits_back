/**
 * Ошибки студии с кодом и признаком повтора. По ним рабочий процесс решает,
 * что делать с заданием: повторить, вернуть сценарий сценаристу или сдаться
 * (studio/src/worker/db.ts, failJob). Сообщение — для владельца: оно уходит
 * в last_error ролика и в личку.
 */
export type StudioErrorCode =
  | 'login'
  | 'blocked'
  | 'wrong_assistant'
  | 'idle_timeout'
  | 'question_hidden'
  | 'answer_timeout'
  | 'answer_rejected'
  | 'no_paragraphs'
  | 'empty_frame'
  | 'script_invalid'
  | 'too_short'
  | 'too_long'
  | 'line_too_short'
  | 'frame_size'
  | 'tts'
  | 'video_invalid'
  | 'no_input'
  | 'keyframe'
  | 'omni_rejected'
  | 'omni_failed'
  | 'omni_budget'
  | 'omni_timeout'
  | 'omni_unreadable'
  | 'google_quota'
  | 'google_auth'
  | 'model_gone'
  | 'speech_mismatch'
  | 'clip_invalid'
  | 'stt'
  | 'unknown';

/**
 * Озвучка вышла за 30–60 с (у ролика со сценками — за 25–45 с), реплика
 * слишком короткая или студия отвергла сам сценарий (script_invalid) —
 * править сценаристу, а не повторять сборку: сборка с тем же сценарием
 * провалится снова.
 */
export const WRITER_FEEDBACK_CODES: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(['too_short', 'too_long', 'line_too_short', 'script_invalid']);

export class StudioError extends Error {
  readonly code: StudioErrorCode;
  readonly retryable: boolean;

  constructor(code: StudioErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Любая ошибка → StudioError. Незнакомая повторяется: чаще всего это сеть или моргнувший стенд. */
export function toStudioError(e: unknown): StudioError {
  if (e instanceof StudioError) return e;
  return new StudioError('unknown', e instanceof Error ? e.message : String(e), true);
}
