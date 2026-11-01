// Инструменты Linkeon (mcp__linkeon__*: картинки, баннеры, видео, озвучка,
// рутины, календарь, бодиграф) — сервер хода из токена бэка.
//
// Пользователя инструмент узнаёт по подписи токена (spirits_back,
// src/mcp/linkeon-tool.token.ts), а не по аргументу, который пишет модель:
// номер телефона модели больше не сообщается. Нет токена — нет и сервера, и
// имён mcp__linkeon__* в --allowedTools: модель инструментов не увидит.
// Спека: spirits_back docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
// Тесты — linkeon-mcp.test.mjs.

// Имя складывается как mcp__<ключ сервера>__<имя инструмента>; ключ — linkeon.
// Список сверяется с CHAT_TOOLS бэка сторожем src/chat/relay-linkeon-guard.spec.ts.
export const LINKEON_TOOLS = [
  "mcp__linkeon__generate_image",
  "mcp__linkeon__edit_image",
  "mcp__linkeon__compose_image",
  "mcp__linkeon__upscale_image",
  "mcp__linkeon__generate_video",
  "mcp__linkeon__generate_banner",
  "mcp__linkeon__manage_routine",
  "mcp__linkeon__propose_calendar_event",
  "mcp__linkeon__generate_speech",
  "mcp__linkeon__read_calendar",
  "mcp__linkeon__calculate_human_design",
].join(",");

// Поле multipart как пришло: повторённое приходит массивом — поэтому
// проверяется тип. Общая проверка для всех трёх постояльцев
// (linkeon/talerid/products, см. server.mjs).
export function isHttpsUrl(value) {
  return typeof value === "string" && /^https:\/\//.test(value);
}

// http-сервер MCP с Bearer-токеном или null. Токен — непустая строка без
// перевода строки (иначе раздвоил бы заголовок), адрес — https. Так же
// проверяются токены talerid и products в server.mjs.
export function bearerServer(token, url) {
  if (typeof token !== "string" || token === "" || /[\r\n]/.test(token)) return null;
  if (!isHttpsUrl(url)) return null;
  return { type: "http", url, headers: { Authorization: "Bearer " + token } };
}

// Сервер linkeon для конфига хода или null.
export function linkeonServer(body) {
  return bearerServer(body && body.linkeon_token, body && body.linkeon_mcp_url);
}
