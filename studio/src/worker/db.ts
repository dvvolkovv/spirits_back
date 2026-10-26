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
/**
 * Сколько кругов сценариста выдерживает ролик из-за длины озвучки: первый
 * вариант и две переписки. Возвратов студии — на один меньше (два): API
 * прибавляет writer_rounds, когда сценарист сдаёт сценарий, и сборка с
 * writer_rounds = 3 уже не возвращает, а сдаётся (failJob).
 */
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

/**
 * retry — ждёт повтора, writer — сценарий назад сценаристу, failed — попытки
 * или круги кончились, gone — запись не нашла этот захват (задание забрал
 * другой процесс или сбор зависших увёл его в failed), ничего не записано.
 */
export type FailOutcome = 'retry' | 'writer' | 'failed' | 'gone';

/**
 * Очередь, как её видят задания (jobs.ts). Итог и сбой пишутся по заданию
 * целиком: запись привязана к его номеру захвата (attempts).
 */
export interface Queue {
  claim(kind: JobKind): Promise<Job | null>;
  /** @returns false — итог не записан: задание уже не за этим захватом */
  completeCapture(job: Job, capture: StoredCapture): Promise<boolean>;
  /** @returns false — итог не записан: задание уже не за этим захватом */
  completeRender(job: Job, out: RenderOutput): Promise<boolean>;
  fail(job: Job, err: StudioError): Promise<FailOutcome>;
  minAnswerChars(): Promise<number>;
}

/**
 * Взять одно задание: из очереди (аренда пуста или истекла — пауза повтора
 * кончилась) или брошенное упавшим процессом (в работе, аренда истекла,
 * попытки ещё есть). Попытку считает захват; переход на следующий этап её
 * сбрасывает.
 *
 * Последнюю попытку, у которой истекла аренда, повторять некуда: процесс упал
 * (OOM Chromium или Remotion, рестарт) или завис, не записав сбой. Такое
 * задание сначала уходит в failed — иначе его забирали бы каждые
 * LEASE_MINUTES без конца (у съёмки каждый круг — вход в кабинет и ответ
 * ассистента на токенах стенда), а владелец ничего бы не узнал.
 */
export async function claimJob(db: Queryable, kind: JobKind): Promise<Job | null> {
  const q = QUEUES[kind];
  await db.query(
    `UPDATE short_video
        SET status = 'failed', failed_from = status, lease_until = NULL, failure_notified = false,
            last_error = $3, updated_at = now()
      WHERE status = $1 AND attempts >= $2 AND (lease_until IS NULL OR lease_until < now())`,
    [q.running, MAX_JOB_ATTEMPTS, `${q.label}: задание не завершилось за ${LEASE_MINUTES} мин — рабочий процесс студии упал или завис`],
  );
  const r = await db.query(
    `UPDATE short_video
        SET status = $2, lease_until = now() + make_interval(mins => $3), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM short_video
         WHERE (status = $1 AND (lease_until IS NULL OR lease_until < now()))
            OR (status = $2 AND attempts < $4 AND (lease_until IS NULL OR lease_until < now()))
         ORDER BY slot_at NULLS LAST, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, attempts, writer_rounds, scene, capture, script`,
    [q.queued, q.running, LEASE_MINUTES, MAX_JOB_ATTEMPTS],
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

/*
 * Итог и сбой пишутся по статусу и номеру захвата (attempts растёт на каждом
 * захвате). Рендер дольше аренды: задание забрал другой процесс, а опоздавший
 * дописывает своё — без условия на attempts он поставил бы повтор с паузой или
 * failed поверх чужой работы. С условием опоздавший не пишет ничего (false / 'gone').
 */

/** Съёмка готова — writing. @returns false — итог не записан: задание уже не за этим захватом */
export async function completeCapture(db: Queryable, job: Job, capture: StoredCapture): Promise<boolean> {
  const r = await db.query(
    `UPDATE short_video
        SET status = 'writing', capture = $2::jsonb, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'capturing' AND attempts = $3`,
    [job.id, JSON.stringify(capture), job.attempts],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Сборка готова — pending_review. review_message_id = NULL — сигнал API прислать
 * новый вариант владельцу. @returns false — итог не записан: задание уже не за этим захватом
 */
export async function completeRender(db: Queryable, job: Job, out: RenderOutput): Promise<boolean> {
  const r = await db.query(
    `UPDATE short_video
        SET status = 'pending_review', video_key = $2, cover_key = $3, duration_ms = $4,
            review_message_id = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'rendering' AND attempts = $5`,
    [job.id, out.videoKey, out.coverKey, out.durationMs, job.attempts],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Предел last_error — по символам: .slice по UTF-16 рвал бы суррогатную пару эмодзи. */
const MAX_ERROR_CHARS = 1000;

/** Текст сбоя для last_error: у незнакомой ошибки — первая строка, дальше обычно стек или журнал вызова Playwright. */
function errorText(label: string, err: StudioError): string {
  const text = err.code === 'unknown' ? (err.message.split(/\r?\n/).find((line) => line.trim()) ?? '').trim() : err.message;
  return Array.from(`${label}: ${text}`).slice(0, MAX_ERROR_CHARS).join('');
}

/**
 * Сбой задания:
 * - озвучка вышла за 30–60 с или реплика короче 1,5 с — сценарий назад
 *   сценаристу с пояснением, пока кругов меньше MAX_WRITER_ROUNDS; круги
 *   кончились — failed с failed_from = 'writing' и тем же пояснением: «Повторить»
 *   вернёт ролик сценаристу с отзывом студии, а не пересоберёт заведомо
 *   неподходящий сценарий;
 * - повторяемый сбой, попытки есть — обратно в очередь с паузой;
 * - иначе failed: failed_from — с чего продолжит «Повторить», владельцу напишет API.
 * Каждая запись — по номеру захвата; не нашла его — 'gone', ничего не записано.
 */
export async function failJob(db: Queryable, job: Job, err: StudioError): Promise<FailOutcome> {
  const q = QUEUES[job.kind];
  const message = errorText(q.label, err);
  const write = async (sql: string, params: unknown[], outcome: FailOutcome): Promise<FailOutcome> => {
    const r = await db.query(sql, [job.id, q.running, job.attempts, ...params]);
    return (r.rowCount ?? 0) > 0 ? outcome : 'gone';
  };
  if (job.kind === 'render' && WRITER_FEEDBACK_CODES.has(err.code)) {
    const feedback = `озвучка: ${err.message}`;
    if (job.writerRounds < MAX_WRITER_ROUNDS) {
      return write(
        `UPDATE short_video
            SET status = 'writing', writer_feedback = $4, last_error = $5, attempts = 0, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND status = $2 AND attempts = $3`,
        [feedback, message],
        'writer',
      );
    }
    return write(
      `UPDATE short_video
          SET status = 'failed', failed_from = 'writing', writer_feedback = $4, lease_until = NULL, last_error = $5,
              failure_notified = false, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      [feedback, message],
      'failed',
    );
  }
  if (err.retryable && job.attempts < MAX_JOB_ATTEMPTS) {
    return write(
      `UPDATE short_video
          SET status = $4, lease_until = now() + make_interval(secs => $5), last_error = $6, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      [q.queued, RETRY_DELAY_SEC, message],
      'retry',
    );
  }
  return write(
    `UPDATE short_video
        SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $4, failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2 AND attempts = $3`,
    [message],
    'failed',
  );
}

export async function minAnswerChars(db: Queryable): Promise<number> {
  const r = await db.query('SELECT min_answer_chars FROM short_settings WHERE id = 1');
  return Number(r.rows[0]?.min_answer_chars ?? 400);
}

export function pgQueue(db: Queryable): Queue {
  return {
    claim: (kind) => claimJob(db, kind),
    completeCapture: (job, capture) => completeCapture(db, job, capture),
    completeRender: (job, out) => completeRender(db, job, out),
    fail: (job, err) => failJob(db, job, err),
    minAnswerChars: () => minAnswerChars(db),
  };
}
