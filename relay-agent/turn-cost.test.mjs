// node --test relay-agent/turn-cost.test.mjs
//
// Записи собраны так, как их пишет Claude CLI 2.1.280 в транскрипт сессии:
// реплики, ответы модели и после каждого запуска — строка cost-state с
// накопленной стоимостью всей сессии.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { lastCostState, costBaseline, runCost } from "./turn-cost.mjs";

const line = (o) => JSON.stringify(o) + "\n";
const user = (text) => line({ type: "user", message: { role: "user", content: text } });
const assistant = (text) => line({ type: "assistant", message: { id: "msg_" + text.length, content: [{ type: "text", text }] } });
const costState = (total) => line({ type: "cost-state", totalCostUSD: total, modelUsage: {}, sessionId: "s1" });

// Настоящий хвост сессии из жалобы 14.10.2026: суммы по ходам — 6.0415, 6.1218.
const TRANSCRIPT =
  user("вопрос") + assistant("ответ") + costState(6.0415184) +
  user("ещё вопрос") + assistant("ещё ответ") + costState(6.1218366);

test("база — последняя запись cost-state, а не первая", () => {
  assert.equal(lastCostState(TRANSCRIPT), 6.1218366);
});

test("ход из жалобы: 6.2087 по итогу CLI минус база 6.1218 — $0.0868, а не $6.21", () => {
  assert.equal(Number(runCost(6.2086838, lastCostState(TRANSCRIPT)).toFixed(7)), 0.0868472);
});

test("записей cost-state нет — null, без падения", () => {
  assert.equal(lastCostState(user("привет") + assistant("здравствуйте")), null);
});

test("строка, где cost-state лишь упомянуто в тексте, базой не считается", () => {
  const text = costState(1.5) + user('что такое "cost-state"?') + assistant('"cost-state" — служебная запись');
  assert.equal(lastCostState(text), 1.5);
});

test("оборванная первая строка хвоста и пустые строки не мешают", () => {
  const text = '{"type":"cost-state","totalCos' + "\n\n" + costState(0.25) + "\n";
  assert.equal(lastCostState(text), 0.25);
});

test("отрицательной стоимости не бывает: CLI начал счёт заново — ноль", () => {
  assert.equal(runCost(0.4, 6.12), 0);
});

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-cost-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, content);
  return file;
}

test("costBaseline: читает базу из файла", () => {
  assert.equal(costBaseline(tmpFile(TRANSCRIPT)), 6.1218366);
});

test("costBaseline: в файле нет cost-state — 0 (CLI начнёт счёт с нуля)", () => {
  assert.equal(costBaseline(tmpFile(user("привет") + assistant("ответ"))), 0);
});

test("costBaseline: файла нет — null, стоимость хода назвать нельзя", () => {
  assert.equal(costBaseline(path.join(os.tmpdir(), "нет-такого-транскрипта.jsonl")), null);
});

test("costBaseline: большой файл — база из хвоста", () => {
  const filler = user("x".repeat(2 * 1024 * 1024));
  assert.equal(costBaseline(tmpFile(costState(1) + filler + costState(2.5) + user("ход"))), 2.5);
});

test("costBaseline: большой файл, запись только в начале — дочитывает целиком", () => {
  const filler = user("x".repeat(2 * 1024 * 1024));
  assert.equal(costBaseline(tmpFile(costState(3.75) + filler)), 3.75);
});
