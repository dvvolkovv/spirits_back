import axios from 'axios';

/**
 * Единая точка отправки алертов мониторинга в Telegram.
 *
 * TELEGRAM_CHAT_ID поддерживает НЕСКОЛЬКО чатов через запятую — алерт уходит во
 * все (личка владельца + дев-чат команды и т.п.). Раньше каждый health-сервис
 * читал одну переменную и слал в один чат; добавление бота в новый чат само по
 * себе ничего не включало — нужно добавить chat_id сюда.
 *
 * fire-and-forget: сетевые/Telegram-ошибки по отдельному чату не валят остальные
 * и не роняют вызывающий код (как и было в inline-вызовах).
 */
export function telegramChatIds(): string[] {
  return (process.env.TELEGRAM_CHAT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function telegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && telegramChatIds().length > 0;
}

export async function sendTelegramAlert(
  text: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  return sendTelegramPayload({ parse_mode: 'HTML', ...extra, text });
}

/**
 * Фанаут готового sendMessage-payload по всем chat_id. Любой переданный chat_id
 * в payload игнорируется — адресаты берутся из TELEGRAM_CHAT_ID. Позволяет
 * перевести существующие inline-вызовы на мульти-чат без переписывания текстов.
 */
export async function sendTelegramPayload(
  payload: Record<string, unknown>,
  // Игнорируется. Принимаем второй аргумент, чтобы заменить inline
  // axios.post(url, payload, { timeout }) одним приёмом, не трогая хвост вызова.
  _opts?: unknown,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chats = telegramChatIds();
  if (!token || chats.length === 0) return;
  const { chat_id: _ignored, ...rest } = payload as Record<string, unknown>;
  await Promise.all(
    chats.map((chat_id) =>
      axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id, ...rest },
        { timeout: 8000 },
      ).catch(() => { /* один чат недоступен — остальные всё равно получат */ }),
    ),
  );
}
