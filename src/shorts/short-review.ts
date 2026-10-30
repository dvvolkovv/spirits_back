import type { SlotQueryable } from '../blog/blog-slot-claim';
import { ShortStatus, ShortVideo, appendOwnerNote, rowToShort } from './shorts.types';

/**
 * Решения по готовому ролику — общие для кнопок в личке (ShortsApprovalService)
 * и админки (ShortsController, экран «Блог» → «Ролики»): «Переснять»,
 * «Отклонить», замечание. Одобрение со слотом — approveShortIntoSlot
 * (short-slot-claim.ts), версию оно берёт отсюда же (versionClause).
 *
 * Спека: docs/superpowers/specs/2026-10-30-admin-shorts-in-blog-design.md.
 *
 * Версия — `updated_at::text` из list/get админки, с микросекундами: через Date
 * JS они теряются, и сверка `updated_at = $версия` не сошлась бы никогда (так же
 * устроен токен аренды отправки в личку, `lease_until::text`). С версией запись
 * проходит, только если ролик с тех пор не менялся: файл пересобранного ролика
 * лежит по тому же адресу, и без версии админка одобрила бы видео, которого
 * владелец не видел. Кнопки лички версию не передают — их сторожит «кнопка под
 * текущим сообщением» (review_message_id), — и для них условие записи и параметры
 * прежние (к обеим записям добавлен только RETURNING *).
 */

/**
 * Ролик уже вышел хоть на одной площадке: пост в канале есть или набор YouTube
 * ушёл владельцу. Между попытками публикации такой ролик лежит в approved.
 * Им же сторожит `reject` упавшего ролика в админке (shorts.controller.ts).
 */
export const RELEASED_SQL =
  `EXISTS (SELECT 1 FROM short_publication p WHERE p.short_id = short_video.id AND p.status IN ('published', 'manual_pending', 'manual_done'))`;

/** Откуда готовый ролик можно «Переснять» и «Отклонить». */
export const LEAVE_FROM: readonly ShortStatus[] = ['pending_review', 'approved'];

export type ReviewRefusal = 'not_found' | 'released' | 'status' | 'stale';

export type ReviewResult =
  | { ok: true; short: ShortVideo }
  | { ok: false; reason: ReviewRefusal; status: ShortStatus | null };

/**
 * Условие версии к записи — только если версия передана: без неё SQL и
 * параметры прежние (на этом держатся тесты лички). Параметр дописывается в
 * `params` — вызывать до запроса, а не внутри его шаблонной строки.
 * Один вызов на массив параметров. Версия — только строка `updated_at::text`,
 * полученная от сервера (list/get).
 */
export function versionClause(params: any[], version?: string | null): string {
  if (version == null) return '';
  params.push(version);
  return ` AND updated_at = $${params.length}::timestamptz`;
}

/**
 * Почему запись не прошла — чтением после неё. «Уже вышел» важнее статуса,
 * как у кнопок лички: между попытками публикации вышедший ролик лежит в
 * approved, из которого «Переснять» в остальном разрешён. Статус подходящий и
 * ролик не вышел — значит, разошлась версия.
 */
export async function explainRefusal(
  pg: SlotQueryable,
  id: string,
  allowed: readonly ShortStatus[],
): Promise<{ reason: ReviewRefusal; status: ShortStatus | null }> {
  const r = await pg.query(`SELECT status, ${RELEASED_SQL} AS released FROM short_video WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { reason: 'not_found', status: null };
  if (row.released) return { reason: 'released', status: row.status };
  if (!allowed.includes(row.status)) return { reason: 'status', status: row.status };
  return { reason: 'stale', status: row.status };
}

/**
 * «Переснять» (`directing`) или «Отклонить» (`rejected`) готового ролика — из
 * pending_review или approved, если он нигде не вышел. Одобренный теряет
 * одобрение (`approved_at = NULL`): новую версию человек ещё не видел.
 * Условие на статус и «не вышел» — в самой записи, а не чтением перед ней:
 * пока решали, ролик мог уйти в публикацию. «Переснять» вышедшего отправил бы
 * новую версию только в YouTube, «Отклонить» — сделал бы rejected ролик с
 * живым постом.
 */
export async function leaveReview(
  pg: SlotQueryable,
  id: string,
  target: 'directing' | 'rejected',
  version?: string | null,
): Promise<ReviewResult> {
  const params: any[] = [id, target, LEAVE_FROM];
  const clause = versionClause(params, version);
  const r = await pg.query(
    `UPDATE short_video SET status = $2, approved_at = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = ANY($3::text[])
        AND NOT ${RELEASED_SQL}${clause}
      RETURNING *`,
    params,
  );
  if (r.rows.length) return { ok: true, short: rowToShort(r.rows[0]) };
  return { ok: false, ...(await explainRefusal(pg, id, LEAVE_FROM)) };
}

/**
 * Замечание к ролику на проверке: дописывается к прежним (appendOwnerNote) и
 * уводит ролик к сценаристу. writer_rounds = 0 — новый круг владельца, счётчик
 * автоматических переписок студии заново.
 */
export async function noteForReview(
  pg: SlotQueryable,
  short: ShortVideo,
  text: string,
  version?: string | null,
): Promise<ReviewResult> {
  const params: any[] = [short.id, appendOwnerNote(short.ownerNote, text)];
  const clause = versionClause(params, version);
  const r = await pg.query(
    `UPDATE short_video
        SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0,
            lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending_review'${clause}
      RETURNING *`,
    params,
  );
  if (r.rows.length) return { ok: true, short: rowToShort(r.rows[0]) };
  return { ok: false, ...(await explainRefusal(pg, short.id, ['pending_review'])) };
}
