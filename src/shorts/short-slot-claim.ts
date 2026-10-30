import { NoFreeSlotError, nextFreeSlotAfter } from '../blog/blog-slots';
import { ApprovedSlot, MAX_SLOT_ATTEMPTS, Schedule, SlotQueryable, TxSource, inTransaction } from '../blog/blog-slot-claim';
import { SLOT_HOLDING_STATUSES } from './shorts.types';
import { versionClause } from './short-review';

/** Имя частичного уникального индекса из 001_shorts.sql: гонку узнаём по нему, а не по одному коду 23505. */
export const SHORT_SLOT_INDEX = 'uq_short_video_slot';

export function isShortSlotConflict(e: any): boolean {
  return e?.code === '23505' && e?.constraint === SHORT_SLOT_INDEX;
}

/** Слоты, занятые одобренными роликами, строго после `after`. `lock` — только внутри транзакции. */
export async function takenSlots(pg: SlotQueryable, after: Date, { lock = false } = {}): Promise<Date[]> {
  const r = await pg.query(
    `SELECT slot_at FROM short_video
      WHERE status = ANY($1::text[]) AND slot_at > $2
      ORDER BY slot_at${lock ? ' FOR UPDATE' : ''}`,
    [SLOT_HOLDING_STATUSES, after.toISOString()],
  );
  return r.rows.filter((row) => row.slot_at).map((row) => new Date(row.slot_at));
}

/**
 * Слот одобрения: планируемый, если он ещё впереди и свободен, иначе
 * ближайший свободный по расписанию (спека, «Одобрение занимает слот»).
 */
export function chooseApprovalSlot(now: Date, planned: Date | null, schedule: Schedule, taken: Date[]): Date {
  const busy = new Set(taken.map((t) => t.getTime()));
  if (planned && planned.getTime() > now.getTime() && !busy.has(planned.getTime())) return planned;
  return nextFreeSlotAfter(now, schedule.slotDays, schedule.slotHourMsk, taken);
}

/**
 * Одобрить ролик в слот. Запись — только из `pending_review`: двойное
 * касание «Одобрить» — два обработчика, и второй не должен переставить ролик
 * на другой слот. `approved_at` отмечает, что ролик одобрял человек: только
 * такой можно вернуть в `approved` повтором публикации (`retryTarget`).
 *
 * `version` — версия ролика из админки (`updated_at::text`, short-review.ts):
 * запись пройдёт, только если ролик с тех пор не менялся. Кнопка лички её не
 * передаёт — её сторожит «кнопка под текущим сообщением», и SQL для неё прежний.
 *
 * @returns слот — или null, если ролик успел уйти из `pending_review` или разошлась версия
 * @throws NoFreeSlotError — слот уводили MAX_SLOT_ATTEMPTS раз подряд
 */
export async function approveShortIntoSlot(
  pg: TxSource,
  id: string,
  planned: Date | null,
  schedule: Schedule,
  clock: () => Date = () => new Date(),
  version?: string | null,
): Promise<ApprovedSlot | null> {
  for (let attempt = 1; attempt <= MAX_SLOT_ATTEMPTS; attempt++) {
    try {
      return await inTransaction(pg, async (tx) => {
        const now = clock();
        const slot = chooseApprovalSlot(now, planned, schedule, await takenSlots(tx, now, { lock: true }));
        const params: any[] = [id, slot.toISOString()];
        const clause = versionClause(params, version);
        const r = await tx.query(
          `UPDATE short_video SET status = 'approved', slot_at = $2, approved_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'pending_review'${clause}`,
          params,
        );
        return r.rowCount === 0 ? null : { slot, now };
      });
    } catch (e: any) {
      if (!isShortSlotConflict(e)) throw e;
      // Слот заняли между чтением и записью — новый круг прочтёт его занятым.
    }
  }
  throw new NoFreeSlotError(`слот ${MAX_SLOT_ATTEMPTS} раз подряд занимали одновременно с нами — попробуйте ещё раз`);
}
