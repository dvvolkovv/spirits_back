import { Logger } from '@nestjs/common';

/**
 * Заголовок, по которому релей (relay-agent/server.mjs) узнаёт наш бэк.
 * Значение — RELAY_SECRET из .env; у прода и стенда свои значения, релей
 * принимает любое из своего списка. Спека:
 * docs/superpowers/specs/2026-10-26-relay-secret-design.md.
 */
export const RELAY_SECRET_HEADER = 'X-Agent-Secret';

const logger = new Logger('RelayAuth');
let warned = false;

/** Заголовки для любого запроса к релею. Секрета нет — пусто (и одно предупреждение). */
export function relayAuthHeaders(): Record<string, string> {
  const secret = (process.env.RELAY_SECRET || '').trim();
  if (!secret) {
    if (!warned) {
      warned = true;
      logger.warn('RELAY_SECRET не задан — релей в режиме enforce откажет в ходе');
    }
    return {};
  }
  return { [RELAY_SECRET_HEADER]: secret };
}
