/**
 * Инструмент find_files — для модели. Живёт на защищённой точке
 * /webhook/mcp/products (products-mcp.controller.ts): владелец берётся из
 * подписи токена сессии, поэтому аргумента userId здесь нет и быть не должно.
 * На общую точку /mcp этот инструмент не добавляется.
 *
 * Полное имя у модели — mcp__products__find_files: ключ сервера `products`
 * общий с manage_product (relay-agent/server.mjs: PRODUCTS_TOOLS;
 * products-cli-tool.ts: FIND_FILES_CLI_TOOL_NAME).
 */
export const FIND_FILES_TOOL_NAME = 'find_files';

export const FIND_FILES_TOOL = {
  name: FIND_FILES_TOOL_NAME,
  description:
    'Найти файлы, которые ассистенты Linkeon уже создавали этому пользователю: документы, картинки, видео, озвучку — ' +
    'во всех его разговорах с ассистентами, включая «Чистый лист». Ты видишь только файлы этого пользователя.\n' +
    'Зови, когда пользователь ищет или просит снова прислать файл из прошлого разговора («найди договор», ' +
    '«пришли ту презентацию», «где картинка, что делал Роман»).\n' +
    '• query — слова для поиска в имени файла и в тексте ответа, где он появился. Пустой query — просто последние файлы.\n' +
    '• kind — image | video | document | audio | any.\n' +
    '• assistant — имя ассистента, в переписке с которым искать.\n' +
    '• days — только за последние N дней. • limit — сколько вернуть: по умолчанию 10, не больше 30.\n' +
    'Ответ: files[] с полями name, kind, date, assistant, url, stored, note (строка из того ответа).\n' +
    'Отдавай найденное пользователю markdown-ссылкой [name](url) — адрес как есть. Если stored=false, url нет: ' +
    'честно скажи, что этот файл не сохранился. Если ничего не нашлось — попробуй синонимы, транслит или ' +
    'английский вариант слова, либо kind и days без слов. По url файл можно скачать и работать с ним дальше.\n' +
    'userId и телефон не передавай: сервер уже знает, чей это разговор.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Слова для поиска в имени файла и в тексте ответа. Пусто — последние файлы.' },
      kind: { type: 'string', enum: ['image', 'video', 'document', 'audio', 'any'], description: 'Вид файла.' },
      assistant: { type: 'string', description: 'Имя ассистента, в переписке с которым искать.' },
      days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Только за последние N дней.' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Сколько вернуть; по умолчанию 10.' },
    },
    additionalProperties: false,
  },
};
