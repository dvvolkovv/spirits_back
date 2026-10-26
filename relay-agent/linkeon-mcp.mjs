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

// Сервер linkeon для конфига хода или null. Поля приходят из multipart как
// есть: повторённое поле — массив, поэтому проверяется тип; перевод строки в
// токене раздвоил бы заголовок.
export function linkeonServer(body) {
  const token = body && body.linkeon_token;
  const url = body && body.linkeon_mcp_url;
  if (typeof token !== "string" || token === "" || /[\r\n]/.test(token)) return null;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  return { type: "http", url, headers: { Authorization: "Bearer " + token } };
}
