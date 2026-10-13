// Поворот сессии: размер контекста запроса и хвост диалога для новой сессии.
//
// Вынесено из server.mjs по той же причине, что paths.mjs: эту логику можно
// проверить без запуска сервера и без живой claude-сессии. Тесты — в
// session-tail.test.mjs.

// Размер контекста одного запроса к модели по его usage: сколько токенов ушло
// в промпт. Запись в кэш разделена по TTL не во всех версиях CLI — без
// разбивки берём общий cache_creation.
export function callContextTokens(u) {
  const n = (x) => (typeof x === "number" ? x : 0);
  const usage = u || {};
  const cc = usage.cache_creation || {};
  const w5 = n(cc.ephemeral_5m_input_tokens);
  const w1 = n(cc.ephemeral_1h_input_tokens);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) +
    (w5 || w1 ? w5 + w1 : n(usage.cache_creation_input_tokens));
}

// Контекст запроса из события stream-json или null, если событие не о нём.
//
// Берём usage события assistant: это один запрос к модели. В result CLI кладёт
// сумму по всем запросам хода — ход с инструментом (два запроса по ~78k у Райи)
// давал ~156k > порога, и сессия поворачивалась на каждом ходе (13.10.2026).
// Запросы подагента (parent_tool_use_id) пропускаем: у них свой контекст, о
// размере сессии он ничего не говорит.
export function eventCallContext(ev) {
  if (!ev || ev.type !== "assistant" || !ev.message || !ev.message.usage) return null;
  if (ev.parent_tool_use_id) return null;
  return callContextTokens(ev.message.usage);
}

// Строки языка, которыми бэкенд заканчивает служебную часть реплики
// (spirits_back src/common/services/language.service.ts, LANGUAGE_REPLY_LINE):
// сразу после строки и пустой строки идёт текст человека. Поменяли строки
// там — поменять и здесь.
export const LANGUAGE_REPLY_LINES = [
  "Отвечай по-русски.", "Reply in English.", "Responde en español.", "Antworte auf Deutsch.",
  "Réponds en français.", "Responde em português de Portugal.", "请用简体中文回复。",
];

// Напоминание о языке, которое релей дописывает в конец реплики. Внутри него
// нет ни «[», ни «]» — иначе совпадение начиналось бы с оборванного
// напоминания в хвосте прошлого поворота и съедало весь текущий ход.
const REMINDER_RE = /\n*\[(?:Служебное напоминание|Service reminder):[^[\]]*\]\s*$/;
const OUTPUT_DIR_MARK = "Output directory for created files: ";

// Текст человека из реплики хода. В транскрипте реплика — вся обёртка хода:
// шапки релея, служебные блоки бэкенда (2–3 тысячи знаков), строка языка,
// сам текст и напоминание. Раньше хвост брал первые 2000 знаков — то есть
// одну обёртку, и после поворота ассистент не видел, что писал человек.
export function userTextOfTurn(text) {
  const t = String(text || "").replace(REMINDER_RE, "");
  let cut = -1;
  for (const line of LANGUAGE_REPLY_LINES) {
    const i = t.lastIndexOf(line + "\n\n");
    if (i >= 0) cut = Math.max(cut, i + line.length + 2);
  }
  if (cut >= 0) return t.slice(cut).trim();
  // Строки языка нет (служебные ходы релея): срезаем только шапки релея.
  const i = t.lastIndexOf(OUTPUT_DIR_MARK);
  if (i < 0) return t.trim();
  return t.slice(i)
    .replace(/^Output directory for created files: [^\n]*\n\n/, "")
    .replace(/^Current user phone [^\n]*\n\n/, "")
    .trim();
}

// Хвост диалога из транскрипта claude-сессии (JSONL): последние maxMsgs
// текстовых реплик, каждая не длиннее maxCharsPerMsg.
export function tailDialogue(jsonlText, maxMsgs = 60, maxCharsPerMsg = 2000) {
  const lines = String(jsonlText || "").split("\n");
  const msgs = [];
  for (let i = lines.length - 1; i >= 0 && msgs.length < maxMsgs; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "user" && ev.type !== "assistant") continue;
    const m = ev.message;
    if (!m) continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ");
    }
    text = ev.type === "user" ? userTextOfTurn(text) : (text || "").trim();
    if (!text) continue; // tool_result / tool_use-only строки
    msgs.push((ev.type === "user" ? "Пользователь: " : "Ассистент: ") + text.slice(0, maxCharsPerMsg));
  }
  return msgs.reverse().join("\n");
}
