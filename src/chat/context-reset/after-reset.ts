/**
 * «Чистый лист» — точка отсчёта памяти ассистента
 * (spec 2026-11-17-context-reset-design.md).
 *
 * Чистые функции без БД: что из прошлого ещё можно показать модели и как
 * понимать метку `freshTs` старых клиентов.
 */

/**
 * Метка старого клиента правдоподобна, только если не из будущего дальше
 * этого окна: точка из будущего стёрла бы ассистенту память навсегда (точка
 * только движется вперёд) — а ходы клиента с кривыми часами шли бы в никуда.
 *
 * Метку из ближнего будущего берём как есть, а не обрезаем до now: старый
 * клиент шлёт одну и ту же метку каждый ход; обрезанная до now точка ползла бы
 * вперёд и меняла ключ релея на каждом ходу — ассистент терял бы память каждый
 * ход.
 */
export const LEGACY_FRESH_FUTURE_SLACK_MS = 5 * 60 * 1000;

/**
 * Нижняя граница правдоподобной метки — 2024-01-01 UTC. Метка в секундах или
 * мусор вроде '100000' дала бы точку в 1970 — и под видом чистого листа
 * вернула бы всю старую историю.
 */
export const LEGACY_FRESH_MIN_MS = Date.UTC(2024, 0, 1);

/**
 * Строки, созданные строго после точки. Без точки — входной массив как есть.
 * Строка без читаемого времени при заданной точке отбрасывается: показать
 * модели старое хуже, чем недосчитаться строки.
 *
 * Фильтровать по точке — только этой функцией в JS: `now()` базы хранит
 * микросекунды, `Date` — миллисекунды; SQL-сравнение `created_at > $точка`
 * пропустило бы строку из той же миллисекунды до точки.
 */
export function afterReset<T>(
  rows: T[],
  resetAt: Date | null | undefined,
  createdAt: (row: T) => unknown,
): T[] {
  if (!resetAt) return rows;
  const edge = resetAt.getTime();
  return rows.filter((row) => {
    const raw = createdAt(row);
    if (raw === null || raw === undefined) return false;
    const t = new Date(raw as string | number | Date).getTime();
    return Number.isFinite(t) && t > edge;
  });
}

/**
 * `freshTs` старого клиента (вкладки до выката, Flutter, e2e-скрипты) → точка.
 * Формат тот же, что принимал прежний контроллер: только цифры, не меньше
 * шести; сверх того — в окне [LEGACY_FRESH_MIN_MS, now + окно].
 */
export function legacyFreshResetAt(freshTs: unknown, nowMs: number): Date | null {
  const s = freshTs === null || freshTs === undefined ? '' : String(freshTs);
  if (!/^\d{6,}$/.test(s)) return null;
  const ms = Number(s);
  if (!Number.isSafeInteger(ms) || ms < LEGACY_FRESH_MIN_MS) return null;
  if (ms > nowMs + LEGACY_FRESH_FUTURE_SLACK_MS) return null;
  return new Date(ms);
}
