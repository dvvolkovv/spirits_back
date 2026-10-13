// node --test relay-agent/session-tail.test.mjs
//
// Реплики здесь собраны так же, как их собирают бэкенд и релей: служебные
// блоки бэкенда, строка языка, текст человека, напоминание релея. Служебная
// часть длиннее 2000 знаков — как в жизни; на этом и ломался прежний хвост.

import test from "node:test";
import assert from "node:assert/strict";
import { eventCallContext, userTextOfTurn, tailDialogue } from "./session-tail.mjs";

const RU_REMINDER = "\n\n[Служебное напоминание: отвечай ТОЛЬКО по-русски. Все промежуточные реплики и статусы между вызовами инструментов — тоже строго по-русски, без единой английской фразы.]";
const EN_REMINDER = "\n\n[Service reminder: Reply in English. Keep every interim message and status between tool calls in that language too.]";

// Служебные блоки бэкенда (spirits_back src/chat/chat.service.ts, contextPrefix).
const SERVICE =
  "--- ВСТРЕЧИ И ЗВОНКИ ---\n" +
  "• Сам зайти во встречу ты НЕ можешь: вход делает платформа.\n".repeat(25) +
  "\n--- ФОРМА ОТВЕТА ---\n" +
  "• Ответы держи сфокусированными, короткими и сжатыми.\n".repeat(20);

// Реплика хода целиком — как она лежит в транскрипте claude-сессии.
function wrapTurn(text, { lang = "Отвечай по-русски.", reminder = RU_REMINDER, files = "" } = {}) {
  return files +
    "Output directory for created files: /tmp/agent-output/70000000000_14_ru\n\n" +
    "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): 70000000000\n\n" +
    SERVICE + "\n\n" + lang + "\n\n" + text + reminder;
}

const usage = (read, write) => ({ input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const assistantEvent = (u, parent = null) =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "…" }], usage: u }, parent_tool_use_id: parent });

function maxContext(events) {
  let max = 0;
  for (const ev of events) {
    const c = eventCallContext(ev);
    if (c !== null && c > max) max = c;
  }
  return max;
}

test("SERVICE длиннее 2000 знаков — иначе тесты хвоста ничего не проверяют", () => {
  assert.ok(wrapTurn("x").indexOf("x\n\n[") > 2000);
});

test("ход с инструментом: контекст — самый большой запрос, а не сумма запросов", () => {
  // Два запроса к модели по ~78k; в result CLI кладёт их сумму.
  const events = [
    assistantEvent(usage(66104, 11870)),
    assistantEvent(usage(77974, 340)),
    { type: "result", usage: { input_tokens: 4, cache_read_input_tokens: 144078, cache_creation_input_tokens: 12210 } },
  ];
  assert.equal(maxContext(events), 78316);
});

test("запрос подагента не считается контекстом сессии", () => {
  const events = [assistantEvent(usage(77974, 340)), assistantEvent(usage(150000, 0), "toolu_01")];
  assert.equal(maxContext(events), 78316);
});

test("текст человека — после строки языка, без служебных блоков и напоминания", () => {
  assert.equal(userTextOfTurn(wrapTurn("Красноярский край")), "Красноярский край");
});

test("английская строка языка; её повтор в напоминании не сбивает", () => {
  const turn = wrapTurn("Krasnoyarsk Krai", { lang: "Reply in English.", reminder: EN_REMINDER });
  assert.equal(userTextOfTurn(turn), "Krasnoyarsk Krai");
});

test("абзацы в тексте человека сохраняются", () => {
  assert.equal(userTextOfTurn(wrapTurn("Первая строка.\n\nВторая строка.")), "Первая строка.\n\nВторая строка.");
});

test("хвост прошлого поворота в начале реплики не попадает в текст человека", () => {
  const prev = "Недавний диалог с этим пользователем (только контекст для непрерывности — отвечай ТОЛЬКО на последнее сообщение ниже):\n" +
    "Пользователь: " + wrapTurn("старый вопрос").slice(0, 2000) + "\nАссистент: старый ответ\n---\n\n";
  assert.equal(userTextOfTurn(prev + wrapTurn("новый вопрос")), "новый вопрос");
});

test("оборванное напоминание в старом хвосте не съедает текущий ход", () => {
  // Хвост прошлого поворота резал реплики на 2000 знаках — посреди
  // напоминания, без закрывающей скобки.
  const prev = "Недавний диалог с этим пользователем (только контекст для непрерывности — отвечай ТОЛЬКО на последнее сообщение ниже):\n" +
    "Пользователь: Отвечай по-русски.\n\nстарый вопрос\n\n[Служебное напоминание: отвечай ТОЛЬКО по-ру\n" +
    "Ассистент: старый ответ\n---\n\n";
  assert.equal(userTextOfTurn(prev + wrapTurn("новый вопрос")), "новый вопрос");
});

test("загруженные файлы перед репликой не попадают в текст человека", () => {
  const files = "User uploaded files:\n- /tmp/uploads/70000000000_14_ru_a.pdf (name: a.pdf, 10 bytes)\n\n";
  assert.equal(userTextOfTurn(wrapTurn("Посмотри файл", { files })), "Посмотри файл");
});

test("реплика без строки языка: срезаются только шапки релея", () => {
  const turn = "Output directory for created files: /tmp/agent-output/70000000000_14_ru\n\n" +
    "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): 70000000000\n\n" +
    "Текст без строки языка";
  assert.equal(userTextOfTurn(turn), "Текст без строки языка");
});

// Транскрипт claude-сессии: по строке JSON на событие.
const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const userLine = (content) => ({ type: "user", message: { role: "user", content } });
const assistantLine = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUseLine = () => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linkeon__calculate_human_design", input: {} }] } });
const toolResultLine = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] } });

test("хвост диалога хранит реплики человека, а не обёртку хода", () => {
  const tail = tailDialogue(jsonl(
    userLine(wrapTurn("Посчитай карту: 12.03.1990, 14:25, Железногорск")),
    toolUseLine(),
    toolResultLine(),
    assistantLine("Нашлось два Железногорска. В каком родился друг?"),
  ));
  assert.equal(tail,
    "Пользователь: Посчитай карту: 12.03.1990, 14:25, Железногорск\n" +
    "Ассистент: Нашлось два Железногорска. В каком родился друг?");
});

test("длинная реплика человека обрезается с начала его текста", () => {
  const long = "а".repeat(3000);
  const tail = tailDialogue(jsonl(userLine(wrapTurn(long))), 60, 2000);
  assert.equal(tail, "Пользователь: " + "а".repeat(2000));
});
