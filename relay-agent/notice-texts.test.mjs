// Тексты служебных реплик релея (notice) — по исходнику server.mjs.
//
// С 17.11.2026 (решение владельца, бэклог 85841119) ход, оборванный с
// частичным результатом, бэкенд списывает за то, что успело прийти
// (partial-billing.ts). Значит, реплики этих обрывов больше не вправе обещать
// «Токены … не списаны». Замены вида «списано за сделанное» нет: в сборке из
// магазина нельзя говорить о деньгах (Apple 3.1.1), а релей сборку не знает.
// Реплики сбоев, где человек ничего не получил (cli_fatal, transient), обещание
// сохраняют — там оно по-прежнему правда.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "server.mjs"), "utf8");

// notice("текст", "причина") — в том числе вызовы, разнесённые по строкам.
const NOTICE_RE = /notice\(\s*"([^"]*)"\s*,\s*"([a-z_]+)"/g;
const notices = [...SRC.matchAll(NOTICE_RE)].map((m) => ({ text: m[1], reason: m[2] }));
const byReason = (reason) => notices.filter((n) => n.reason === reason);

// Обрывы, после которых человек мог что-то получить и за которые теперь списываем.
const PARTIAL = ["preempted", "transient_after_partial", "max_turns"];

test("разбор находит все реплики частичных обрывов", () => {
  assert.equal(byReason("preempted").length, 1);
  assert.equal(byReason("transient_after_partial").length, 2);
  assert.equal(byReason("max_turns").length, 1);
});

for (const reason of PARTIAL) {
  test(`реплика ${reason} не обещает «не списаны»`, () => {
    const found = byReason(reason);
    assert.ok(found.length > 0, `не нашлось реплик ${reason}`);
    for (const n of found) {
      assert.doesNotMatch(n.text, /не списан/i, `${reason}: ${n.text}`);
      assert.doesNotMatch(n.text, /Токены/, `${reason}: ${n.text}`);
    }
  });
}

test("реплики частичных обрывов остаются читаемыми", () => {
  for (const n of [...byReason("preempted"), ...byReason("transient_after_partial"), ...byReason("max_turns")]) {
    // В исходнике перевод строки записан escape-последовательностью «\n».
    assert.match(n.text, /^\\n\\n_\(.+\)_$/, `${n.reason}: ${n.text}`);
    assert.doesNotMatch(n.text, /\s\)_$|—\)_$/, `${n.reason}: хвост после удаления фразы: ${n.text}`);
  }
  assert.match(byReason("preempted")[0].text, /ответ прерван: вы отправили новое сообщение/);
  for (const n of byReason("transient_after_partial")) assert.match(n.text, /повторите вопрос/);
  // Ветка поверх живого fix/visual-revisions: потолок шагов не продолжается сам —
  // человек уточняет, что осталось (в main до слияния visual-revisions — «продолжай»).
  assert.match(byReason("max_turns")[0].text, /Уточните, что осталось сделать/);
});

test("сбой без ответа (cli_fatal) по-прежнему обещает «не списаны»", () => {
  const m = SRC.match(/const fatalHint = \(raw\) => \(([\s\S]*?)\n\s*\);/);
  assert.ok(m, "не нашлось fatalHint");
  const promises = m[1].match(/не списаны/g) || [];
  assert.equal(promises.length, 2, m[1]);
});
