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
import {
  sessionFsKey,
  turnFsKey,
  legacyTurnFsKey,
  uploadFileName,
  fallbackFileName,
  sessionOutputDir,
  ensureSessionDirs,
  ensureListingGuard,
  AGENT_SCRATCH_ROOT,
  AGENT_MCP_DIR,
} from "./paths.mjs";

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

const SID = "70000000000_12"; // как их шлёт бэкенд: <телефон>_<n>; номер — тестовый (CLAUDE.md)

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

// sid в GET /session/:sid/files приходит прямо из URL, Express сам его
// раскодирует. sessionOutputDir — единственное место, где sid превращается в
// путь на диске для этого обработчика; sid проверяется и символьно (только
// [A-Za-z0-9_.-]), и финальным сравнением итогового пути с каталогом вывода.
test("sessionOutputDir: обычный sid — путь внутри каталога вывода", () => {
  const BASE = "/tmp/agent-output";
  assert.equal(sessionOutputDir(BASE, SID), path.join(BASE, SID));
});

test("sessionOutputDir: sid вне алфавита или целиком '.'/'..' — null", () => {
  const BASE = "/tmp/agent-output";
  const evil = [
    "../..",        // составной выход
    "..",           // голый родитель
    ".",            // голый «текущий»
    "",             // пустой
    "/etc",         // абсолютный путь вместо имени
    "../",          // то, во что раскодируется "..%2F"
  ];
  for (const sid of evil) {
    assert.equal(sessionOutputDir(BASE, sid), null, "sid " + JSON.stringify(sid) + " должен быть отклонён");
  }
});

// fs_key от бэка (spirits_back src/chat/linkeon-relay-fields.ts): 32 hex от
// HMAC ключа сессии. Им называются папка хода и загрузки — без номера.
const FS_KEY = "0123456789abcdef0123456789abcdef";

test("turnFsKey: корректный fs_key от бэка — он и есть ключ папки", () => {
  assert.equal(turnFsKey(FS_KEY, SID, "x"), FS_KEY);
});

test("turnFsKey: нет fs_key — прежний ключ из sessionId", () => {
  assert.equal(turnFsKey(undefined, SID, "x"), SID);
  assert.equal(turnFsKey("", SID, "x"), SID);
});

test("turnFsKey: кривой fs_key не принимается — прежний ключ", () => {
  const bad = [FS_KEY.toUpperCase(), FS_KEY.slice(1), FS_KEY + "0", "../" + FS_KEY.slice(3), FS_KEY.slice(0, 31) + "/", ["a"], 123];
  for (const b of bad) {
    assert.equal(turnFsKey(b, SID, "x"), SID, "принят " + JSON.stringify(b));
  }
});

test("с fs_key в путях нет номера: загрузка, папка вывода, список файлов", () => {
  const key = turnFsKey(FS_KEY, SID, "x");
  const upload = uploadFileName("egrul.pdf", key);
  assert.equal(upload, FS_KEY + "_egrul.pdf");
  assert.equal(tryCreate(upload), null);
  const out = sessionOutputDir("/tmp/agent-output", key);
  assert.equal(out, path.join("/tmp/agent-output", FS_KEY));
  const phone = SID.split("_")[0];
  // Контроль: та же пара функций на ПРЕЖНЕМ ключе (без fs_key) номер
  // содержит — иначе проверка ниже была бы тавтологией (true по построению
  // FS_KEY, что бы ни стояло в SID) и не смогла бы упасть на реальном баге.
  const legacyKey = sessionFsKey(SID, "x");
  const legacyUpload = uploadFileName("egrul.pdf", legacyKey);
  assert.ok(legacyUpload.includes(phone), "подготовка теста: без fs_key номер должен быть в пути");
  assert.notEqual(upload, legacyUpload);
  for (const p of [upload, out]) assert.ok(!p.includes(phone), p);
});

// Прежняя папка хода — та, что была у сессии до перехода на fs_key: в неё
// модель может писать по памяти (путь из истории разговора).
test("legacyTurnFsKey: есть fs_key — прежний ключ = санитизированный sessionId", () => {
  assert.equal(legacyTurnFsKey(FS_KEY, SID), sessionFsKey(SID, "x"));
  assert.equal(legacyTurnFsKey(FS_KEY, "a/b"), "a_b");
});

test("legacyTurnFsKey: нет или кривой fs_key — отдельной прежней папки нет", () => {
  for (const k of [undefined, "", FS_KEY.toUpperCase(), ["a"], 123]) {
    assert.equal(legacyTurnFsKey(k, SID), null, "ключ " + JSON.stringify(k));
  }
});

test("legacyTurnFsKey: sessionId без пригодного ключа ('.', '..', пустой) — null", () => {
  for (const sid of [".", "..", ""]) assert.equal(legacyTurnFsKey(FS_KEY, sid), null, sid);
});

test("константы песочницы реэкспортируются из paths.mjs", () => {
  assert.equal(AGENT_SCRATCH_ROOT, "/tmp/agent-scratch");
  assert.equal(AGENT_MCP_DIR, "/tmp/agent-mcp");
});

test("ensureSessionDirs: создаёт scratch и output с 0700, повторный вызов не падает", async () => {
  const root = fs.mkdtempSync(path.join(DIR, "session-dirs-"));
  const scratchRoot = path.join(root, "scratch");
  const outputs = path.join(root, "output");
  const scratch = path.join(scratchRoot, FS_KEY);
  const output = path.join(outputs, FS_KEY);

  // Оба корня переданы явно: настоящие /tmp/agent-* тест не создаёт и не chmod'ит.
  assert.equal(await ensureSessionDirs(FS_KEY, { scratchRoot, outputs }), scratch);
  for (const dir of [scratch, output]) {
    const stat = fs.statSync(dir);
    assert.ok(stat.isDirectory(), dir);
    assert.equal(stat.mode & 0o777, 0o700, dir);
  }

  fs.chmodSync(scratch, 0o755);
  fs.chmodSync(output, 0o755);
  assert.equal(await ensureSessionDirs(FS_KEY, { scratchRoot, outputs }), scratch);
  for (const dir of [scratch, output]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
});

test("ensureListingGuard: закрывает листинг трёх корней и не ломает собственный scratch", async (t) => {
  const root = fs.mkdtempSync(path.join(DIR, "listing-guard-"));
  const outputs = path.join(root, "output");
  const uploads = path.join(root, "uploads");
  const scratchRoot = path.join(root, "scratch");
  const dirs = [outputs, uploads, scratchRoot];
  const scratch = path.join(scratchRoot, FS_KEY);
  const ownFile = path.join(scratch, "note.txt");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownFile, "before");
  t.after(() => {
    // rmSync при выходе должен прочитать содержимое временных каталогов.
    for (const dir of dirs) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
  });

  await ensureListingGuard({ outputs, uploads, scratchRoot });
  for (const dir of dirs) {
    const stat = fs.statSync(dir);
    assert.ok(stat.isDirectory(), dir);
    assert.equal(stat.mode & 0o777, 0o311, dir);
  }

  // Повторный вызов обязан поправить права именно переданных каталогов,
  // а не только без ошибки отработать на уже существующих путях.
  fs.chmodSync(outputs, 0o755);
  fs.chmodSync(uploads, 0o755);
  fs.chmodSync(scratchRoot, 0o755);
  await ensureListingGuard({ outputs, uploads, scratchRoot });
  for (const dir of dirs) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o311, dir);
  }

  // На корне нет права чтения, но известный путь к собственному файлу остаётся
  // доступен владельцу: execute-битов на корне и scratch достаточно для прохода.
  fs.writeFileSync(ownFile, "after");
  assert.equal(fs.readFileSync(ownFile, "utf8"), "after");
});

test("ensureSessionDirs: удаляет только свой scratch старше 7 дней, свежий и соседний сохраняет", async (t) => {
  const root = fs.mkdtempSync(path.join(DIR, "scratch-age-"));
  const scratchRoot = path.join(root, "scratch");
  const outputs = path.join(root, "output");
  const oldKey = "old-scratch";
  const freshKey = "fresh-scratch";
  const siblingKey = "sibling-scratch";
  const oldMarker = path.join(scratchRoot, oldKey, "old.txt");
  const freshMarker = path.join(scratchRoot, freshKey, "fresh.txt");
  const siblingMarker = path.join(scratchRoot, siblingKey, "sibling.txt");
  for (const marker of [oldMarker, freshMarker, siblingMarker]) {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, marker);
  }
  const now = Date.now();
  const eightDaysAgo = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(scratchRoot, oldKey), eightDaysAgo, eightDaysAgo);
  fs.utimesSync(path.join(scratchRoot, siblingKey), eightDaysAgo, eightDaysAgo);
  // Корень 0311 доказывает, что очистка идёт по известному пути без readdir.
  fs.chmodSync(scratchRoot, 0o311);
  t.after(() => fs.chmodSync(scratchRoot, 0o700));

  await ensureSessionDirs(oldKey, { scratchRoot, outputs, now });
  assert.equal(fs.existsSync(oldMarker), false, "старый scratch должен быть создан заново");
  assert.equal(fs.statSync(path.join(scratchRoot, oldKey)).mode & 0o777, 0o700);

  await ensureSessionDirs(freshKey, { scratchRoot, outputs, now });
  assert.equal(fs.readFileSync(freshMarker, "utf8"), freshMarker, "свежий scratch нельзя очищать");
  assert.equal(fs.readFileSync(siblingMarker, "utf8"), siblingMarker, "чужой старый scratch нельзя перечислять или удалять");
});
