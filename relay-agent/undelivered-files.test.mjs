// node --test relay-agent/undelivered-files.test.mjs
//
// Файлы хода, ответ которого не дошёл до бэкенда, отдаются со следующим ходом
// той же сессии. Случай 20.10.2026: рестарт API оборвал ход, ассистент успел
// сделать справку, на «что молчишь?» ответил «файл прикреплён ниже» — а
// ссылки не было, потому что файл сделан в прошлом ходе.

import test from "node:test";
import assert from "node:assert/strict";
import { createUndelivered, withCarried } from "./undelivered-files.mjs";

const file = (name, size = 1) => ({ name, size, url: "/files/s1/" + name });

test("файлы хода без доставки отдаются следующему ходу той же сессии — один раз", () => {
  const u = createUndelivered();
  u.stash("s1", [file("spravka.docx")]);
  assert.deepEqual(u.take("s1"), [file("spravka.docx")]);
  assert.deepEqual(u.take("s1"), []);
});

test("другая сессия их не получает", () => {
  const u = createUndelivered();
  u.stash("s1", [file("spravka.docx")]);
  assert.deepEqual(u.take("s2"), []);
  assert.equal(u.take("s1").length, 1);
});

test("повторный обрыв копит файлы, а не затирает; один адрес — одна запись, свежая", () => {
  const u = createUndelivered();
  u.stash("s1", [file("a.docx", 1)]);
  u.stash("s1", [file("b.pdf"), file("a.docx", 7)]);
  assert.deepEqual(u.take("s1"), [file("a.docx", 7), file("b.pdf")]);
});

test("пустой список не заводит запись", () => {
  const u = createUndelivered();
  u.stash("s1", []);
  assert.equal(u.size(), 0);
});

test("старше срока не отдаются", () => {
  let t = 0;
  const u = createUndelivered({ ttlMs: 1000, now: () => t });
  u.stash("s1", [file("a.docx")]);
  t = 1001;
  assert.deepEqual(u.take("s1"), []);
});

test("просроченные записи других сессий вычищаются при следующем stash", () => {
  let t = 0;
  const u = createUndelivered({ ttlMs: 1000, now: () => t });
  u.stash("s1", [file("a.docx")]);
  t = 2000;
  u.stash("s2", [file("b.docx")]);
  assert.equal(u.size(), 1);
});

test("withCarried: свой файл хода главнее, повтора по адресу нет", () => {
  const out = withCarried(
    [file("a.docx", 5)],
    [file("a.docx", 3), file("b.pdf", 2)],
    () => ({ size: 9 }),
  );
  assert.deepEqual(out, [file("a.docx", 5), file("b.pdf", 9)]);
});

test("withCarried: файл, пропавший с диска, не отдаётся", () => {
  const out = withCarried([], [file("a.docx"), file("b.pdf")], (url) => (url.endsWith("b.pdf") ? null : { size: 4 }));
  assert.deepEqual(out, [file("a.docx", 4)]);
});

test("withCarried: без перенесённых — свой список как есть", () => {
  const own = [file("a.docx")];
  assert.deepEqual(withCarried(own, [], () => null), own);
});
