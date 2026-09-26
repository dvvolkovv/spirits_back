import { BlogPost, rowToPost } from './blog.types';
import { SLOT_HOLDING_STATUSES, SlotQueryable, TxSource, inTransaction } from './blog-slot-claim';
import { formatSlotWhen } from './blog-slot-format';

/**
 * Очередь без дыр — решение владельца.
 *
 * Одобренный пост ушёл из очереди раньше своего слота — каждый следующий
 * одобренный встаёт на слот предыдущего. Кира в понедельник, Продукты в
 * среду; Киру выпустили сейчас — Продукты переезжают на понедельник, а не
 * ждут среды при пустом понедельнике.
 *
 * Поводов уйти из очереди три: опубликован сейчас, отправлен в мусор,
 * отправлен на переработку. Путей больше — админка, кнопки в личке, крон, — и
 * все они уходят через `leaveQueue`: правило, разнесённое по местам,
 * разошлось бы при первой же правке.
 *
 * Ручной перенос (`reschedule`) сюда НЕ ходит: это осознанный выбор слота
 * владельцем, и очередь он не двигает.
 */

/** Один переезд в очереди: пост встал из слота `from` в слот `to`. */
export interface QueueShift {
  id: string;
  title: string | null;
  from: Date;
  to: Date;
}

export interface LeaveOutcome {
  /** Пост, каким он был под блокировкой до записи; null — такого поста нет. */
  before: BlogPost | null;
  /** Запись ухода прошла (`apply` вернул true). */
  applied: boolean;
  /** Переезды очереди по порядку — пусто, если слот не освободился или уже наступил. */
  shifted: QueueShift[];
}

/**
 * Закрыть дыру в слоте `freed`, который только что освободил ушедший пост.
 * Только внутри транзакции, в которой пост и ушёл.
 *
 * Правила:
 *
 *  - только в будущее. Освободился слот, который уже наступил (публикация
 *    сорвалась в своём слоте и ждёт ретрая), — никто не двигается: иначе
 *    следующий пост встал бы в прошлое и вышел бы ближайшим тиком
 *    `publishDue`, мимо расписания. «Сейчас» — это `now()` базы, тот же, по
 *    которому `publishDue` решает, что слот наступил;
 *  - двигаются только `approved` со слотом позже `freed`, по возрастанию:
 *    первый встаёт на `freed`, второй — на бывший слот первого, и так далее.
 *    Пост в `publishing` не трогаем — он прямо сейчас уходит в канал, и его
 *    слот не цель ни для кого;
 *  - записи — по возрастанию. Каждый шаг целится в слот, который только что
 *    освободил предыдущий шаг ЭТОЙ ЖЕ транзакции, поэтому неотложенный
 *    уникальный индекс (004_one_post_per_slot.sql) не спотыкается. В обратном
 *    порядке первая же запись упёрлась бы в соседа, который ещё держит слот.
 *
 * Сдвигаемые посты берутся под блокировку (FOR UPDATE) до конца транзакции.
 * В READ COMMITTED строка, которую конкурент успел изменить, приходит свежей
 * версией, но место в ORDER BY у неё — по старой, поэтому порядок
 * пересобирается здесь, по тому, что пришло.
 */
export async function shiftQueueAfter(tx: SlotQueryable, freed: Date): Promise<QueueShift[]> {
  const r = await tx.query(
    `SELECT id, title, slot_at FROM blog_post
      WHERE status = 'approved' AND slot_at > $1 AND $1::timestamptz > now()
      ORDER BY slot_at
      FOR UPDATE`,
    [freed.toISOString()],
  );
  const queue = r.rows
    .map((row) => ({ id: String(row.id), title: row.title ?? null, slotAt: new Date(row.slot_at) }))
    .sort((a, b) => a.slotAt.getTime() - b.slotAt.getTime());

  const shifted: QueueShift[] = [];
  let target = freed;
  for (const post of queue) {
    // updated_at — это правка поста: вкладка админки со старым слотом должна
    // получить 409 на переносе, а не молча перенести пост по устаревшей картине.
    await tx.query(
      `UPDATE blog_post SET slot_at = $2, updated_at = now() WHERE id = $1`,
      [post.id, target.toISOString()],
    );
    shifted.push({ id: post.id, title: post.title, from: post.slotAt, to: target });
    target = post.slotAt;
  }
  return shifted;
}

/**
 * Пост уходит из очереди: одна транзакция на уход и сдвиг.
 *
 * Пост берётся под блокировку, `apply` пишет уход (статус, слот — что нужно
 * пути) и возвращает, прошла ли запись. Если пост был `approved`, держал слот
 * и после записи его больше не держит — очередь сдвигается от этого слота
 * (`shiftQueueAfter`) в той же транзакции. Ошибка где угодно — откат всего,
 * включая уход.
 *
 * Блокировка поста — ещё и перепроверка: `apply` видит пост таким, какой он
 * есть сейчас, а не каким его прочли до нажатия кнопки. Решение «можно ли
 * отсюда уйти» (машина состояний, версия) принимается в `apply` по нему;
 * брошенное там исключение откатывает транзакцию и уходит наверх как есть.
 *
 * Гонки:
 *
 *  - с `publishDue`: тик берёт только пост, чей слот наступил (и паблишер
 *    сам требует `slot_at <= now()`), а сдвиг двигает только посты со
 *    слотом в будущем и только в будущее — их множества не пересекаются.
 *    Ушедший пост тик мог захватить раньше нас — тогда под блокировкой он
 *    уже в `publishing`, и `apply` откажет по машине состояний; или позже —
 *    тогда захват упрётся в нашу блокировку и после коммита не найдёт
 *    `approved`;
 *  - с одобрением: `approveIntoFreeSlot` читает очередь под блокировкой и
 *    упирается в пост, который держит сдвиг, — и читает очередь уже
 *    сдвинутой. Обратно: сдвиг цепляет только слоты, которые освобождают
 *    строки под его же блокировкой, так что одобрение, выбравшее свободный
 *    слот, с ним не сталкивается;
 *  - два ухода сразу: каждый блокирует свой пост и затем очередь после своего
 *    слота по возрастанию. Второй дожидается первого на общей строке и видит
 *    её свежей; ждать друг друга по кругу им не на чем.
 */
export async function leaveQueue(
  pg: TxSource,
  postId: string,
  apply: (tx: SlotQueryable, post: BlogPost) => Promise<boolean>,
): Promise<LeaveOutcome> {
  return inTransaction(pg, async (tx) => {
    const r = await tx.query(`SELECT * FROM blog_post WHERE id = $1 FOR UPDATE`, [postId]);
    if (!r.rows.length) return { before: null, applied: false, shifted: [] };

    const before = rowToPost(r.rows[0]);
    const applied = await apply(tx, before);
    if (!applied || before.status !== 'approved' || !before.slotAt) return { before, applied, shifted: [] };

    // Держит ли пост свой слот после записи. Уход в другой статус освобождает
    // его, как и новый слот у publish_now; правка, не тронувшая слот, — нет.
    const freed = new Date(before.slotAt);
    const after = (await tx.query(`SELECT status, slot_at FROM blog_post WHERE id = $1`, [postId])).rows[0];
    const stillHolds = after
      && SLOT_HOLDING_STATUSES.includes(after.status)
      && after.slot_at
      && new Date(after.slot_at).getTime() === freed.getTime();
    if (stillHolds) return { before, applied, shifted: [] };

    return { before, applied, shifted: await shiftQueueAfter(tx, freed) };
  });
}

/**
 * Несколько уходов подряд — одна сводка: где каждый пост оказался в итоге,
 * а не цепочка промежуточных переездов. Посты из `left` сами ушли из очереди,
 * их переезды не в счёт. Порядок — по новому слоту.
 */
export function mergeShifts(lists: QueueShift[][], left: Iterable<string> = []): QueueShift[] {
  const gone = new Set(left);
  const byId = new Map<string, QueueShift>();
  for (const list of lists) {
    for (const s of list) {
      const seen = byId.get(s.id);
      byId.set(s.id, seen ? { ...seen, title: s.title, to: s.to } : { ...s });
    }
  }
  return [...byId.values()]
    .filter((s) => !gone.has(s.id) && s.from.getTime() !== s.to.getTime())
    .sort((a, b) => a.to.getTime() - b.to.getTime());
}

/**
 * Сообщение владельцу о сдвиге: в личке остались устаревшие «Опубликую в
 * среду…». Все переезды — одним сообщением; без переездов — null.
 */
export function formatQueueShift(shifted: QueueShift[], now: Date): string | null {
  if (!shifted.length) return null;
  const line = (s: QueueShift) => {
    const title = (s.title || '').trim();
    return `${title ? `«${title}»` : 'пост без заголовка'} — теперь ${formatSlotWhen(s.to, now)}`;
  };
  if (shifted.length === 1) return `Очередь сдвинулась: ${line(shifted[0])}.`;
  return `Очередь сдвинулась:\n${shifted.map(line).join(';\n')}.`;
}

/** Сдвиг в ответе админки — контракт с фронтом: время строкой ISO. */
export function shiftToJson(s: QueueShift): { id: string; title: string | null; from: string; to: string } {
  return { id: s.id, title: s.title, from: s.from.toISOString(), to: s.to.toISOString() };
}
