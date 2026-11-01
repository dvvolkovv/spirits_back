/**
 * Текст ответа ИИ-поддержки из сообщений модели за ход.
 *
 * Модель пишет и до вызова инструмента («Я передам твой вопрос в команду»), и
 * после него («Твой вопрос передан команде»). Раньше весь текст склеивался
 * подряд, без пробела, и человек получал оба: «…подробный ответ.Твой вопрос
 * передан команде» (прогон 01.11.2026). Показываем только текст после
 * последнего вызова инструмента; если после него модель промолчала — последний
 * текст перед ним, чтобы готовый ответ не подменился заглушкой.
 *
 * `messages` — content-блоки assistant-сообщений в порядке потока.
 */
export function supportReplyText(messages: any[][]): string {
  let afterLastTool = '';
  let beforeLastTool = '';
  for (const content of messages) {
    for (const block of content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const part = block.text.trim();
        if (part) afterLastTool = afterLastTool ? `${afterLastTool}\n\n${part}` : part;
      } else if (block?.type === 'tool_use') {
        if (afterLastTool) beforeLastTool = afterLastTool;
        afterLastTool = '';
      }
    }
  }
  return afterLastTool || beforeLastTool;
}
