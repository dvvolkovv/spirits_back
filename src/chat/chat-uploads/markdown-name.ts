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

/**
 * Строка истории о сохранённой загрузке: `📎 [имя](url)` — скрепка U+1F4CE
 * без вариационного селектора, один пробел, имя через markdownEscapeName.
 *
 * Единственный шаблон по той же причине, что и экранирование: строку пишет
 * upload-and-chat, а удаление загрузки ищет её посимвольно и заменяет на
 * deletedUploadLine. Контроллер собирает строку только этой функцией —
 * рукописный `📎 [${…}](…)` в нём ловит markdown-name.spec.ts.
 */
export function uploadHistoryLink(name: string, url: string): string {
  return `📎 [${markdownEscapeName(name)}](${url})`;
}
