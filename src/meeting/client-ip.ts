import type { Request } from 'express';

/** Ключом Redis это становится, так что длина ограничена. */
const MAX_LEN = 64;

function firstValue(v: unknown): string {
  if (Array.isArray(v)) return String(v[0] ?? '');
  return typeof v === 'string' ? v : '';
}

/**
 * Адрес клиента для ограничения частоты.
 *
 * `req.ip` здесь бесполезен: в `main.ts` не включён `trust proxy`, а мы стоим
 * за nginx — значит Express отдаёт адрес nginx, ОДИНАКОВЫЙ для всех запросов.
 * С ним ограничение считало бы весь трафик в одно ведро и после шестидесяти
 * обращений блокировало бы всех сразу.
 *
 * Поэтому берём заголовки, которые ставит наш nginx (`X-Real-IP`, а следом
 * `X-Forwarded-For`). Включать `trust proxy` глобально не стали: это меняет
 * поведение `req.ip` во всём приложении, а не только здесь.
 *
 * ⚠️ Точность всё равно ограничена: РФ-трафик приходит через Selectel-прокси
 * `92.53.64.147`, и для этих пользователей адрес будет общим. То есть
 * ограничение работает как грубая защита от перебора, а не как учёт по
 * человеку — рассчитывать на него как на точный нельзя.
 */
export function clientIp(req: Request | undefined): string {
  if (!req?.headers) return req?.ip || 'unknown';

  const real = firstValue(req.headers['x-real-ip']).trim();
  if (real) return real.slice(0, MAX_LEN);

  // Первый адрес в цепочке — исходный клиент, остальные дописаны прокси.
  const forwarded = firstValue(req.headers['x-forwarded-for']).split(',')[0]?.trim();
  if (forwarded) return forwarded.slice(0, MAX_LEN);

  return (req.ip || 'unknown').slice(0, MAX_LEN);
}
