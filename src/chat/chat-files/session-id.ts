/**
 * Ключ переписки в custom_chat_history — ровно как у истории
 * (ChatController.getHistory): «Чистый лист» живёт отдельной сессией.
 * userId всегда из JWT, никогда из запроса.
 */
export function chatSessionId(userId: string, assistantId: string, freshTs?: string | null): string {
  return freshTs && /^\d{6,}$/.test(freshTs)
    ? `${userId}_${assistantId}_fresh_${freshTs}`
    : `${userId}_${assistantId}`;
}
