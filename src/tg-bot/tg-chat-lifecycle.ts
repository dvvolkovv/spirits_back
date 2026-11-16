/**
 * Канонический lifecycle lock для одного Telegram bot+chat.
 *
 * В tg_bot_configs нет per-config bot identity: модуль обслуживает один бот,
 * поэтому chat ID однозначно определяет пару bot+chat. Строка и hash совпадают
 * существующему chat lock в TgBotService и стабильны между процессами.
 */
export function tgChatLifecycleLockKey(chatId: number | string): number {
  const key = `tg-chat:${chatId}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return hash;
}
