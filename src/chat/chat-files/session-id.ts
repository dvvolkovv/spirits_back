/**
 * Ключ переписки в custom_chat_history — ровно как у истории
 * (ChatController.getHistory). Лента одна (spec 2026-11-17-context-reset):
 * «Чистый лист» — точка отсчёта памяти ассистента, а не отдельная сессия.
 * userId всегда из JWT, никогда из запроса.
 */
export function chatSessionId(userId: string, assistantId: string): string {
  return `${userId}_${assistantId}`;
}
