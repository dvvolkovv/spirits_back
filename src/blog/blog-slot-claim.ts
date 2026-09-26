import { BlogStatus } from './blog.types';
import { NoFreeSlotError, nextFreeSlotAfter } from './blog-slots';

/**
 * Имя частичного уникального индекса из 004_one_post_per_slot.sql.
 *
 * Гонку за слот узнаём по нему, а не по одному коду 23505: уникальный
 * конфликт по чему-то другому новым слотом не лечится, и ретрай крутился бы
 * вхолостую до исчерпания попыток.
 */
export const SLOT_INDEX = 'uq_blog_post_slot';

/**
 * Статусы, которые держат слот, — ровно предикат индекса (сверяет
 * blog-slot-claim.spec.ts). Опубликованный, отклонённый и сорвавшийся посты
 * слот не держат.
 */
export const SLOT_HOLDING_STATUSES: readonly BlogStatus[] = ['approved', 'publishing'];

/**
 * Сколько раз одобрение пробует занять свободный слот, проигрывая гонку.
 *
 * Каждый проигрыш значит, что ровно между нашим чтением и записью кто-то занял
 * именно тот слот, который мы выбрали. Панелей управления две, процессов API —
 * столько, сколько в cluster_mode; пять проигрышей подряд — это уже не гонка
 * двух нажатий, а что-то сломанное, и честнее отказать.
 */
export const MAX_SLOT_ATTEMPTS = 5;

export interface SlotQueryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Выделенное соединение под транзакцию — то, что отдаёт PgService.getClient(). */
export interface TxClient extends SlotQueryable {
  release(err?: any): void;
}

export interface TxSource {
  getClient(): Promise<TxClient>;
}

/**
 * Выполнить `work` в одной транзакции на выделенном соединении.
 *
 * Именно на выделенном: BEGIN через пул (`pg.query('BEGIN')`) уехал бы на
 * одно соединение, а записи — на другие, и «откат» ничего бы не откатывал.
 * Ошибка внутри — ROLLBACK и та же ошибка наверх. Соединение, на котором не
 * прошёл даже ROLLBACK, в пул не возвращается: состояние его сессии
 * неизвестно.
 */
export async function inTransaction<T>(pg: TxSource, work: (tx: SlotQueryable) => Promise<T>): Promise<T> {
  const client = await pg.getClient();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    broken = await client.query('ROLLBACK').then(() => false, () => true);
    throw e;
  } finally {
    client.release(broken);
  }
}

/** Пост, который держит слот. */
export interface SlotHolder {
  id: string;
  title: string | null;
  slotAt: Date;
}

export interface Schedule {
  slotDays: number[];
  slotHourMsk: number;
}

export function isSlotConflict(e: any): boolean {
  return e?.code === '23505' && e?.constraint === SLOT_INDEX;
}

const toHolder = (row: any): SlotHolder => ({ id: row.id, title: row.title ?? null, slotAt: new Date(row.slot_at) });

/**
 * Посты, которые держат слоты строго после `after`, по порядку слотов.
 *
 * `lock` — взять их под блокировку до конца транзакции (только внутри
 * `inTransaction`). Так одобрение не читает очередь, которую прямо сейчас
 * сдвигают: см. `approveIntoFreeSlot`.
 */
export async function slotHolders(pg: SlotQueryable, after: Date, { lock = false } = {}): Promise<SlotHolder[]> {
  const r = await pg.query(
    `SELECT id, title, slot_at FROM blog_post
      WHERE status = ANY($1::text[]) AND slot_at > $2
      ORDER BY slot_at${lock ? ' FOR UPDATE' : ''}`,
    [SLOT_HOLDING_STATUSES, after.toISOString()],
  );
  return r.rows.filter((row) => row.slot_at).map(toHolder);
}

/** Пост, который держит ровно этот слот, — или null. */
export async function slotHolderAt(pg: SlotQueryable, slot: Date): Promise<SlotHolder | null> {
  const r = await pg.query(
    `SELECT id, title, slot_at FROM blog_post
      WHERE status = ANY($1::text[]) AND slot_at = $2
      LIMIT 1`,
    [SLOT_HOLDING_STATUSES, slot.toISOString()],
  );
  return r.rows[0] ? toHolder(r.rows[0]) : null;
}

export interface ApprovedSlot {
  slot: Date;
  /** Момент, от которого слот считался: от него же строится «сегодня/завтра» в ответе владельцу. */
  now: Date;
}

/**
 * Одобрить пост в ближайший свободный слот.
 *
 * Свободный слот выбирает код, но гарантирует его индекс: между чтением
 * занятых слотов и записью другой процесс или вторая панель могли занять тот
 * же слот. Тогда запись получает 23505, и мы читаем занятость заново — уже с
 * чужим постом — и берём следующий свободный.
 *
 * Запись идёт с условием на статус, в котором пост одобряли. Двойное касание
 * «Опубликовать» — это два обработчика, прочитавших пост на проверке; второй
 * увидел бы слот занятым этим же постом и переставил бы его на следующий, а
 * владельцу пришли бы две разные даты. С условием его запись не проходит.
 *
 * Очередь читается под блокировкой (FOR UPDATE), в одной транзакции с
 * записью. Это против гонки со сдвигом очереди (`leaveQueue`): без блокировки
 * одобрение прочло бы очередь до коммита сдвига — «понедельник у Киры, среда у
 * Продуктов, свободна пятница» — и встало бы в пятницу, а сдвиг тем временем
 * перенёс бы Продукты на понедельник: среда осталась бы дырой. С блокировкой
 * одобрение упирается в пост, который сдвиг уже держит, дожидается его
 * коммита и читает очередь уже сдвинутой. Слот, который сейчас свободен,
 * блокировкой строк не удержать — его по-прежнему держит уникальный индекс.
 *
 * @returns слот — или null, если пост успел уйти из `fromStatus` (его
 *          одобрили или изменили в другом месте)
 * @throws NoFreeSlotError — свободного слота нет или его увели
 *         `MAX_SLOT_ATTEMPTS` раз подряд
 */
export async function approveIntoFreeSlot(
  pg: TxSource,
  postId: string,
  fromStatus: BlogStatus,
  schedule: Schedule,
  clock: () => Date = () => new Date(),
): Promise<ApprovedSlot | null> {
  for (let attempt = 1; attempt <= MAX_SLOT_ATTEMPTS; attempt++) {
    try {
      return await inTransaction(pg, async (tx) => {
        const now = clock();
        const taken = (await slotHolders(tx, now, { lock: true })).map((h) => h.slotAt);
        const slot = nextFreeSlotAfter(now, schedule.slotDays, schedule.slotHourMsk, taken);
        const r = await tx.query(
          `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now()
            WHERE id = $1 AND status = $3`,
          [postId, slot.toISOString(), fromStatus],
        );
        return r.rowCount === 0 ? null : { slot, now };
      });
    } catch (e: any) {
      if (!isSlotConflict(e)) throw e;
      // Слот заняли между чтением и записью — следующий круг, уже новой
      // транзакцией, прочтёт его занятым.
    }
  }
  throw new NoFreeSlotError(`слот ${MAX_SLOT_ATTEMPTS} раз подряд занимали одновременно с нами — попробуйте ещё раз`);
}
