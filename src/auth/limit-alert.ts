/**
 * Сообщить о закрытом общем лимите один раз за его окно.
 *
 * Пока общий счётчик заполнен, о нём «узнаёт» каждый отказ — при накрутке это
 * сотни запросов в минуту. В лог, события и Telegram владельцу должен уйти
 * один сигнал на окно, а не по одному на отказ.
 */

/** Тот метод RedisService, который нужен отметке. */
export interface OnceStore {
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
}

/**
 * true — этот вызов первый в окне и должен сообщить. Отметка живёт ровно
 * остаток окна: в следующем окне сработавший снова лимит снова будет слышен.
 * SET NX PX — одна атомарная команда: отметки без срока, которая заглушила
 * бы лимит навсегда, не бывает.
 */
export async function firstInWindow(store: OnceStore, key: string, windowLeftMs: number): Promise<boolean> {
  return store.setNx(key, '1', Math.max(1, Math.ceil(windowLeftMs)));
}

/** Когда окно откроется: «14:35 МСК» — владелец читает алерт по московскому времени. */
export function opensAtMsk(windowLeftMs: number, now: number = Date.now()): string {
  const at = new Date(now + windowLeftMs).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${at} МСК`;
}

/** Остаток окна для человека: «47 мин» или «5 ч 12 мин». */
export function humanLeft(windowLeftMs: number): string {
  const min = Math.max(1, Math.ceil(windowLeftMs / 60000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
