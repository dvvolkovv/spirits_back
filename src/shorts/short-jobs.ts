import { ShortVideo, rowToShort } from './shorts.types';

export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Этапы, которые ведёт сам API. Съёмку и сборку забирает студия (studio/src/worker/db.ts). */
export type ApiStage = 'directing' | 'writing';

/**
 * Аренда этапа. Сценарист — до трёх обращений к релею подряд (переписка по
 * правилам), каждое до 5 минут (таймаут BlogRelayClient). 20 минут хватает с
 * запасом, а упавший посреди работы процесс отдаст ролик через 20 минут.
 */
export const STAGE_LEASE_MINUTES = 20;
export const MAX_STAGE_ATTEMPTS = 3;
/** Паузы перед повторами: 1 и 10 минут (спека, «Обработка отказов»). */
export const STAGE_RETRY_DELAYS_SEC = [60, 600];

/** Сбой, который повтором не лечится: ролик сразу уходит в failed. */
export class StageFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageFatalError';
  }
}

/**
 * Взять один ролик этапа, свободный по аренде. Попытку считает захват, поэтому
 * счётчик переживает рестарт; переход на следующий этап его сбрасывает.
 */
export async function claimStage(pg: Queryable, status: ApiStage): Promise<ShortVideo | null> {
  const r = await pg.query(
    `UPDATE short_video
        SET lease_until = now() + make_interval(mins => $2), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM short_video
         WHERE status = $1 AND (lease_until IS NULL OR lease_until < now())
         ORDER BY slot_at NULLS LAST, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [status, STAGE_LEASE_MINUTES],
  );
  return r.rows[0] ? rowToShort(r.rows[0]) : null;
}

export type StageOutcome = 'retry' | 'failed';

/**
 * Сбой этапа. Пока попытки есть — ролик остаётся на этапе, а аренда
 * становится паузой до повтора. Попытки кончились или сбой фатальный —
 * `failed`, `failed_from` (с чего продолжит «Повторить»), и
 * `failure_notified = false`: владельцу напишет следующий тик.
 * Обе записи — с условием на статус: ролик могли отклонить, пока шёл этап.
 */
export async function stageFailed(pg: Queryable, v: ShortVideo, label: string, e: any): Promise<StageOutcome> {
  const message = `${label}: ${String(e?.message ?? e)}`.slice(0, 1000);
  if (!(e instanceof StageFatalError) && v.attempts < MAX_STAGE_ATTEMPTS) {
    const delay = STAGE_RETRY_DELAYS_SEC[Math.min(Math.max(v.attempts, 1), STAGE_RETRY_DELAYS_SEC.length) - 1];
    await pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(secs => $3), last_error = $4, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [v.id, v.status, delay, message],
    );
    return 'retry';
  }
  await pg.query(
    `UPDATE short_video SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3,
            failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2`,
    [v.id, v.status, message],
  );
  return 'failed';
}
