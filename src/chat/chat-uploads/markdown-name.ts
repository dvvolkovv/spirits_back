/**
 * Экранирование имени файла для markdown-ссылки в истории: `\`, `[`, `]`.
 * Имена приходят из multipart и могут содержать любые символы — без экранировки
 * имя с квадратной скобкой ломало бы ссылку `📎 [имя](url)` в сохранённой строке.
 *
 * Единственная копия: ею пишет строку истории upload-and-chat
 * (chat.controller.ts) и ею же ищет ту же строку удаление загрузки
 * (ChatUploadsService.deleteForOwner). Разойдись они — replace() в
 * custom_chat_history молча не нашёл бы строку (сторож — markdown-name.spec.ts).
 */
export function markdownEscapeName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
