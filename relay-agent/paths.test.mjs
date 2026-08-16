// node --test relay-agent/paths.test.mjs
//
// Тесты бьют по настоящей файловой системе, а не только по длине строки:
// NAME_MAX проверяется ядром, и единственный честный способ убедиться, что имя
// проходит — попробовать его создать.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { sessionFsKey, uploadFileName, fallbackFileName } from "./paths.mjs";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paths-test-"));
process.on("exit", () => fs.rmSync(DIR, { recursive: true, force: true }));

// Кладёт файл с таким именем на диск. Возвращает код ошибки или null.
function tryCreate(name) {
  const src = path.join(DIR, "src-" + randomUUID());
  fs.writeFileSync(src, "x");
  try {
    fs.renameSync(src, path.join(DIR, name));
    return null;
  } catch (e) {
    fs.unlinkSync(src);
    return e.code;
  }
}

const SID = "79093464922_12"; // как их шлёт бэкенд: <телефон>_<n>

test("кириллическая выписка на ~280 символов укладывается в NAME_MAX", () => {
  const name = "Выписка по счёту дебетовой карты за период с 29.01.2026, " +
    "приложение к договору о комплексном банковском обслуживании физического " +
    "лица номер двенадцать дробь сорок пять, включительно по текущую дату.pdf";
  assert.ok(name.length > 150, "имя должно быть длинным, иначе тест ничего не проверяет");

  const built = uploadFileName(name, sessionFsKey(SID, "x"));
  assert.equal(tryCreate(built), null);
  assert.ok(Buffer.byteLength(built) <= 255);
  assert.ok(built.endsWith(".pdf"), "расширение должно уцелеть: " + built);
});

test("длинное ASCII-расширение больше не роняет rename", () => {
  // path.extname() отдаёт всё после последней точки — тут это 300 символов.
  const name = "report." + "a".repeat(300);
  const built = uploadFileName(name, sessionFsKey(SID, "x"));
  assert.equal(tryCreate(built), null);
  assert.ok(Buffer.byteLength(built) <= 255);
});

test("запасное имя тоже укладывается в лимит при том же входе", () => {
  // Раньше запасной путь переиспользовал необрезанное расширение и падал
  // следом за основным, после чего файл молча удалялся.
  const name = "report." + "a".repeat(300);
  const built = fallbackFileName(name, sessionFsKey(SID, "x"), randomUUID());
  assert.equal(tryCreate(built), null);
});

test("не-BMP символы считаются по байтам, а не по code units", () => {
  const built = uploadFileName("🎉".repeat(200) + ".pdf", sessionFsKey(SID, "x"));
  assert.equal(tryCreate(built), null);
  assert.ok(Buffer.byteLength(built) <= 255);
});

test("гигантский sessionId не пробивает лимит", () => {
  const built = uploadFileName("ok.pdf", sessionFsKey("9".repeat(300), "x"));
  assert.equal(tryCreate(built), null);
});

test("обычный sessionId не меняется — папки вывода и /files-ссылки прежние", () => {
  assert.equal(sessionFsKey(SID, "x"), SID);
  assert.equal(sessionFsKey("70000000000_12", "x"), "70000000000_12");
});

test("sessionId не выводит путь за пределы каталога", () => {
  const BASE = "/tmp/agent-output";
  for (const evil of ["../../etc", "..", ".", "", "/etc/passwd", "a/../../b"]) {
    const resolved = path.resolve(path.join(BASE, sessionFsKey(evil, "safe-" + randomUUID())));
    assert.ok(
      resolved.startsWith(BASE + "/"),
      "sessionId " + JSON.stringify(evil) + " вышел за каталог: " + resolved,
    );
  }
});

test("имя файла не может уползти в другой каталог", () => {
  const built = uploadFileName("../../../home/dv/.ssh/authorized_keys", sessionFsKey(SID, "x"));
  assert.ok(!built.includes("/"), "в имени не должно остаться слэшей: " + built);
  assert.equal(tryCreate(built), null);
});
