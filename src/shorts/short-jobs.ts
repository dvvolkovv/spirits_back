import { ShortVideo, rowToShort } from './shorts.types';

export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Этапы, которые ведёт сам API. Съёмку и сборку забирает студия (studio/src/worker/db.ts). */
export type ApiStage = 'directing' | 'writing';

/** Ролик, захваченный на этапе API. */
export type StageVideo = ShortVideo & { status: ApiStage };

/** Подпись этапа в last_error и в сообщении владельцу. */
export const STAGE_LABELS: Record<ApiStage, string> = { directing: 'режиссёр', writing: 'сценарист' };

/**
 * Аренда этапа: пока она идёт, ролик не заберёт другой процесс, а упавший
 * посреди работы процесс отдаст ролик, когда она истечёт. 20 минут — с запасом
 * на сценариста: до трёх обращений к релею подряд (переписка по правилам), каждое
 * — минуты. Длиннее не нужно: на столько же задержится ролик упавшего процесса.
 *
 * Своего предела у вызова релея нет: BlogRelayClient читает ответ потоком, а
 * таймаут axios перестаёт действовать, как только пришли заголовки, — дальше
 * поток ждёт конца сколько угодно. Поэтому runStage (shorts.cron.ts) обрывает
 * этап через STAGE_DEADLINE_MINUTES: на 2 минуты раньше аренды, чтобы сбой
 * успел записаться, пока ролик ещё за этим процессом.
 */
export const STAGE_LEASE_MINUTES = 20;
export const STAGE_DEADLINE_MINUTES = STAGE_LEASE_MINUTES - 2;
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
 * Срок этапа. Обрывает только ожидание: сам запрос к релею идёт дальше, и его
 * поздний ответ никто не прочтёт. Чтобы опоздавший процесс не записал этап
 * поверх того, кто забрал ролик после него, записи этапа привязаны к номеру
 * захвата (attempts).
 */
export async function withStageDeadline<T>(run: () => Promise<T>, ms: number = STAGE_DEADLINE_MINUTES * 60_000): Promise<T> {
  const work = run();
  // Поздний отказ после срока уже некому разбирать — без обработчика он стал бы unhandled rejection.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    const span = ms >= 60_000 ? `${Math.round(ms / 60_000)} мин` : `${ms} мс`;
    timer = setTimeout(() => reject(new Error(`этап не уложился в ${span}: релей не ответил`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Взять один ролик этапа, свободный по аренде. Попытку считает захват, поэтому
 * счётчик переживает рестарт; переход на следующий этап его сбрасывает.
 *
 * Последнюю попытку, у которой истекла аренда, повторять некуда: процесс упал
 * или завис, не записав сбой. Такой ролик сначала уходит в failed — иначе он
 * висел бы на этапе вечно, а владелец ничего бы не узнал.
 */
export async function claimStage(pg: Queryable, status: ApiStage): Promise<StageVideo | null> {
  await pg.query(
    `UPDATE short_video
        SET status = 'failed', failed_from = status, lease_until = NULL, failure_notified = false,
            last_error = $3, updated_at = now()
      WHERE status = $1 AND attempts >= $2 AND (lease_until IS NULL OR lease_until < now())`,
    [status, MAX_STAGE_ATTEMPTS, `${STAGE_LABELS[status]}: этап не завершился за аренду — процесс упал или релей завис`],
  );
  const r = await pg.query(
    `UPDATE short_video
        SET lease_until = now() + make_interval(mins => $2), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM short_video
         WHERE status = $1 AND attempts < $3 AND (lease_until IS NULL OR lease_until < now())
         ORDER BY slot_at NULLS LAST, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [status, STAGE_LEASE_MINUTES, MAX_STAGE_ATTEMPTS],
  );
  return r.rows[0] ? (rowToShort(r.rows[0]) as StageVideo) : null;
}

/** retry — ждёт повтора, failed — попытки кончились, gone — запись не нашла этот захват. */
export type StageOutcome = 'retry' | 'failed' | 'gone';

/**
 * Сбой этапа. Пока попытки есть — ролик остаётся на этапе, а аренда
 * становится паузой до повтора. Попытки кончились или сбой фатальный —
 * `failed`, `failed_from` (с чего продолжит «Повторить»), и
 * `failure_notified = false`: владельцу напишет следующий тик.
 *
 * Обе записи — по статусу и номеру захвата (attempts растёт на каждом захвате).
 * Из directing и writing ролик не отклонить, условие страхует от второго
 * процесса: если аренда истекла и ролик забрали снова, опоздавший ничего не
 * пишет — 'gone'.
 */
export async function stageFailed(pg: Queryable, v: StageVideo, label: string, e: any): Promise<StageOutcome> {
  const raw = String(e?.message ?? e);
  const full = raw.startsWith(`${label}:`) ? raw : `${label}: ${raw}`;
  const message = Array.from(full).slice(0, 1000).join('');
  if (!(e instanceof StageFatalError) && v.attempts < MAX_STAGE_ATTEMPTS) {
    const delay = STAGE_RETRY_DELAYS_SEC[Math.min(Math.max(v.attempts, 1), STAGE_RETRY_DELAYS_SEC.length) - 1];
    const r = await pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(secs => $3), last_error = $4, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $5`,
      [v.id, v.status, delay, message, v.attempts],
    );
    return r.rowCount === 0 ? 'gone' : 'retry';
  }
  const r = await pg.query(
    `UPDATE short_video SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3,
            failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2 AND attempts = $4`,
    [v.id, v.status, message, v.attempts],
  );
  return r.rowCount === 0 ? 'gone' : 'failed';
}
