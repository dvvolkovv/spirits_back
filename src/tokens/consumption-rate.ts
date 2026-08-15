/**
 * Минимум замеров, ниже которого прогноз «хватит на N сообщений» недостоверен.
 *
 * Выдуманная цифра хуже её отсутствия: пользователь строит на ней решение,
 * а ассистент, назвавший «хватит на 20 сообщений» по двум замерам, ошибётся
 * в разы.
 */
export const MIN_SAMPLES = 5;

/**
 * Медиана расхода за ход. Медиана, а не среднее: у человека, который в
 * основном переписывается, одно сгенерированное видео за 10 000 токенов
 * перекосило бы среднее на порядок и превратило бы прогноз в бессмыслицу.
 *
 * Возвращает null, если замеров меньше MIN_SAMPLES.
 *
 * ВНИМАНИЕ: на вход идут ВЕЛИЧИНЫ, а не знаковые суммы. Неположительные
 * значения отбрасываются как мусор. Расход в token_transactions лежит
 * отрицательным числом, поэтому вызывающий обязан взять ABS в SQL — иначе
 * сюда не доедет ни один замер, прогноз исчезнет, и ни один тест не покраснеет.
 */
export function medianSpend(amounts: number[]): number | null {
  const values = (amounts || [])
    .map((a) => Number(a))
    .filter((a) => Number.isFinite(a) && a > 0)
    .sort((a, b) => a - b);

  if (values.length < MIN_SAMPLES) return null;

  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}

/** Ниже этого остатка пользователя пора предупредить. */
export const LOW_BALANCE_THRESHOLD = 10000;

/** Сколько молчим после выданного предупреждения. */
export const WARN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Что лежит в profile_data.low_balance_warned. */
export interface WarnMark {
  at: string;
  atBalance: number;
}

/**
 * Пора ли разрешить ассистенту предупредить о низком балансе.
 *
 * Чистая функция: всё состояние приходит аргументами, поэтому правило
 * проверяется без БД и без подмены системного времени.
 */
export function shouldWarn(args: {
  balance: number;
  warned: WarnMark | null;
  now: number;
  isGreeting?: boolean;
}): boolean {
  const { balance, warned, now, isGreeting } = args;

  // На приветствии шлагбаум баланса тоже пропускается (chat.service.ts:394):
  // первое сообщение новому пользователю не должно быть просьбой заплатить.
  if (isGreeting) return false;
  if (balance >= LOW_BALANCE_THRESHOLD) return false;
  if (!warned) return true;

  // Битую отметку трактуем как отсутствующую: она не должна навсегда
  // заглушить предупреждения из-за одной кривой записи.
  const at = Date.parse(warned.at);
  if (!Number.isFinite(at)) return true;

  if (now - at >= WARN_COOLDOWN_MS) return true;

  // Баланс выше, чем на момент предупреждения — значит было пополнение,
  // и это новый цикл трат, а не продолжение старого.
  const atBalance = Number(warned.atBalance);
  if (Number.isFinite(atBalance) && balance > atBalance) return true;

  return false;
}
