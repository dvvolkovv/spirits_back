import { WRITER_FEEDBACK_CODES, type StudioError } from '../errors';
import type { CaptureResult, Scene, Script } from '../types';

/** То, что нужно от pg.Pool, — чтобы в тестах рабочего процесса его можно было заменить. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export type JobKind = 'capture' | 'render';

interface QueueSpec {
  queued: string;
  running: string;
  /** Этап в last_error и в сообщении владельцу. */
  label: string;
}

/** Очереди студии в short_video. Статусы и колонки — контракт с src/shorts/shorts.types.ts бэкенда. */
export const QUEUES: Record<JobKind, QueueSpec> = {
  capture: { queued: 'capture_queued', running: 'capturing', label: 'съёмка' },
  render: { queued: 'render_queued', running: 'rendering', label: 'сборка' },
};

/**
 * Аренда задания. Съёмка с двумя уточнениями ждёт ответа до 5 минут на каждый
 * ход, сборка с озвучкой — минуты. Упавший процесс отдаёт задание через столько.
 */
export const LEASE_MINUTES = 30;
/** Пересъёмка «до двух раз», SpeechKit и рендер — «до трёх попыток» (спека): три попытки задания. */
export const MAX_JOB_ATTEMPTS = 3;
/** Пауза перед повтором: стенд или кабинет могли моргнуть. */
export const RETRY_DELAY_SEC = 120;
/** Сколько раз подряд сценарий может вернуться сценаристу из-за длины озвучки. */
export const MAX_WRITER_ROUNDS = 3;

/** Съёмка, как она лежит в базе: файлы — ключами MinIO. Зеркало ShortCapture бэкенда. */
export type StoredCapture = Omit<CaptureResult, 'questionShot' | 'answerShot'> & {
  questionShotKey: string;
  answerShotKey: string;
};

export interface Job {
  id: string;
  kind: JobKind;
  attempts: number;
  writerRounds: number;
  scene: Scene | null;
  capture: StoredCapture | null;
  script: Script | null;
}

export interface RenderOutput {
  videoKey: string;
  coverKey: string;
  durationMs: number;
}

export type FailOutcome = 'retry' | 'writer' | 'failed';

/** Очередь, как её видят задания (jobs.ts). */
export interface Queue {
  claim(kind: JobKind): Promise<Job | null>;
  completeCapture(id: string, capture: StoredCapture): Promise<boolean>;
  completeRender(id: string, out: RenderOutput): Promise<boolean>;
  fail(job: Job, err: StudioError): Promise<FailOutcome>;
  minAnswerChars(): Promise<number>;
}

/**
 * Взять одно задание: из очереди (аренда пуста или истекла — пауза повтора
 * кончилась) или брошенное упавшим процессом (в работе, аренда истекла).
 * Попытку считает захват.
 */
export async function claimJob(db: Queryable, kind: JobKind): Promise<Job | null> {
  const q = QUEUES[kind];
  const r = await db.query(
    `UPDATE short_video
        SET status = $2, lease_until = now() + make_interval(mins => $3), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM short_video
         WHERE (status = $1 AND (lease_until IS NULL OR lease_until < now()))
            OR (status = $2 AND lease_until < now())
         ORDER BY slot_at NULLS LAST, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, attempts, writer_rounds, scene, capture, script`,
    [q.queued, q.running, LEASE_MINUTES],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind,
    attempts: Number(row.attempts),
    writerRounds: Number(row.writer_rounds ?? 0),
    scene: row.scene ?? null,
    capture: row.capture ?? null,
    script: row.script ?? null,
  };
}

/** @returns false — ролик ушёл из capturing, пока шла съёмка (его отклонили), результат не записан */
export async function completeCapture(db: Queryable, id: string, capture: StoredCapture): Promise<boolean> {
  const r = await db.query(
    `UPDATE short_video
        SET status = 'writing', capture = $2::jsonb, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'capturing'`,
    [id, JSON.stringify(capture)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** review_message_id = NULL — сигнал API прислать новый вариант владельцу. */
export async function completeRender(db: Queryable, id: string, out: RenderOutput): Promise<boolean> {
  const r = await db.query(
    `UPDATE short_video
        SET status = 'pending_review', video_key = $2, cover_key = $3, duration_ms = $4,
            review_message_id = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'rendering'`,
    [id, out.videoKey, out.coverKey, out.durationMs],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Сбой задания:
 * - озвучка вышла за 30–60 с или реплика короче 1,5 с — сценарий назад
 *   сценаристу с пояснением, не больше MAX_WRITER_ROUNDS кругов;
 * - повторяемый сбой, попытки есть — обратно в очередь с паузой;
 * - иначе failed: failed_from — с чего продолжит «Повторить», владельцу напишет API.
 */
export async function failJob(db: Queryable, job: Job, err: StudioError): Promise<FailOutcome> {
  const q = QUEUES[job.kind];
  const message = `${q.label}: ${err.message}`.slice(0, 1000);
  if (job.kind === 'render' && WRITER_FEEDBACK_CODES.has(err.code) && job.writerRounds < MAX_WRITER_ROUNDS) {
    await db.query(
      `UPDATE short_video
          SET status = 'writing', writer_feedback = $3, last_error = $4, attempts = 0, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [job.id, q.running, `озвучка: ${err.message}`, message],
    );
    return 'writer';
  }
  if (err.retryable && job.attempts < MAX_JOB_ATTEMPTS) {
    await db.query(
      `UPDATE short_video
          SET status = $3, lease_until = now() + make_interval(secs => $4), last_error = $5, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [job.id, q.running, q.queued, RETRY_DELAY_SEC, message],
    );
    return 'retry';
  }
  await db.query(
    `UPDATE short_video
        SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3, failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2`,
    [job.id, q.running, message],
  );
  return 'failed';
}

export async function minAnswerChars(db: Queryable): Promise<number> {
  const r = await db.query('SELECT min_answer_chars FROM short_settings WHERE id = 1');
  return Number(r.rows[0]?.min_answer_chars ?? 400);
}

export function pgQueue(db: Queryable): Queue {
  return {
    claim: (kind) => claimJob(db, kind),
    completeCapture: (id, capture) => completeCapture(db, id, capture),
    completeRender: (id, out) => completeRender(db, id, out),
    fail: (job, err) => failJob(db, job, err),
    minAnswerChars: () => minAnswerChars(db),
  };
}
