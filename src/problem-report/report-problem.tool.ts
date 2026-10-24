/**
 * Инструмент report_problem — ассистент сам сообщает команде о поломке.
 * Живёт на защищённой точке /webhook/mcp/products (products-mcp.controller.ts):
 * пользователь и канал берутся из подписи токена сессии, аргумента userId нет.
 *
 * Полное имя у модели — mcp__products__report_problem: ключ сервера
 * `products` общий с manage_product и find_files (relay-agent/server.mjs:
 * PRODUCTS_TOOLS; products-cli-tool.ts: REPORT_PROBLEM_CLI_TOOL_NAME).
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 */
export const REPORT_PROBLEM_TOOL_NAME = 'report_problem';

export const REPORT_PROBLEM_TOOL = {
  name: REPORT_PROBLEM_TOOL_NAME,
  description:
    'Сообщить команде Linkeon о поломке, которую ты сам не можешь исправить. Сообщение сразу уходит в рабочий чат поддержки.\n' +
    'Зови, когда не можешь выполнить просьбу пользователя из-за поломки:\n' +
    '• kind="my_failure" — сломалось у тебя: программа или конвертация падает раз за разом, файл не обрабатывается из-за ошибки окружения, нужного модуля нет, инструмент вернул бессмыслицу;\n' +
    '• kind="user_report" — пользователь говорит, что в Linkeon что-то не работает: оплата, кнопка, экран, не пришло видео.\n' +
    'НЕ зови: если инструмент Linkeon вернул ошибку с supportNotified=true — команда уже знает; при нехватке токенов; ' +
    'если ошибся сам пользователь; при отказе по соображениям безопасности; повторно о той же проблеме в этом разговоре.\n' +
    'summary — 1–3 предложения своими словами: что сломалось и что ты уже пробовал. Без имени, телефона, почты и адресов ' +
    'пользователя и без пересказа разговора.\n' +
    'Ответ несёт поле say — что сказать пользователю; следуй ему. Срок починки не обещай.\n' +
    'userId и телефон не передавай: сервер уже знает, чей это разговор.',
  input_schema: {
    type: 'object' as const,
    properties: {
      assistant: { type: 'string', description: 'Твоё имя как ассистента, например «Кира».' },
      kind: {
        type: 'string',
        enum: ['my_failure', 'user_report'],
        description: 'my_failure — сломалось у тебя; user_report — пользователь говорит, что в Linkeon что-то не работает.',
      },
      summary: {
        type: 'string',
        maxLength: 500,
        description: 'Что сломалось и что ты пробовал: 1–3 предложения, без личных данных пользователя.',
      },
    },
    required: ['assistant', 'kind', 'summary'],
    additionalProperties: false,
  },
};
