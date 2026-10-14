/**
 * Экранирование для parse_mode: 'HTML' в Telegram. Telegram требует заменить
 * ровно & < >; остальное (в том числе _ * [ `, на которых ломается legacy
 * Markdown) принимается как есть.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
