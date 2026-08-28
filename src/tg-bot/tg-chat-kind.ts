import type { TgBotConfigRow } from './tg-config.service';

/**
 * Личный чат или групповой. Telegram гарантирует знак: id личного чата
 * положительный, группы/супергруппы/канала — отрицательный.
 *
 * Отдельной колонки в tg_bot_configs намеренно нет: она потребовала бы
 * миграции, а они на проде накатываются ненадёжно. Знак — свойство самого
 * Telegram, оно не зависит от нашей схемы и не может разъехаться с данными.
 *
 * tg_chat_id = null бывает у pending-конфигов (созданы в вебе, но ещё не
 * привязаны к чату) — они не приватные.
 */
export function isPrivateConfig(cfg: Pick<TgBotConfigRow, 'tg_chat_id'>): boolean {
  if (!cfg.tg_chat_id) return false;
  return Number(cfg.tg_chat_id) > 0;
}
