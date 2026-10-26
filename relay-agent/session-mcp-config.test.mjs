// node --test relay-agent/session-mcp-config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { sessionMcpConfigName, sweepStaleSessionMcpConfigs } from "./session-mcp-config.mjs";

const FS_KEY = "0123456789abcdef0123456789abcdef";

test("sessionMcpConfigName: разные вызовы — разные имена (не гонка за файл сессии)", () => {
  const a = sessionMcpConfigName(FS_KEY, randomUUID());
  const b = sessionMcpConfigName(FS_KEY, randomUUID());
  assert.notEqual(a, b);
  assert.match(a, new RegExp("^" + FS_KEY + "-"));
  assert.match(a, /-session-mcp\.json$/);
});

test("sessionMcpConfigName: длина заведомо меньше NAME_MAX (255 байт)", () => {
  const name = sessionMcpConfigName(FS_KEY, randomUUID());
  assert.ok(Buffer.byteLength(name, "utf8") < 255, name);
});

test("sweepStaleSessionMcpConfigs: старый файл хода удаляется, свежий — нет", () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-mcp-sweep-"));
  try {
    const stale = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    const fresh = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    fs.writeFileSync(stale, "{}");
    fs.writeFileSync(fresh, "{}");
    const oldSec = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, oldSec, oldSec);
    const removed = sweepStaleSessionMcpConfigs(DIR, 30 * 60 * 1000, new Set());
    assert.deepEqual(removed, [path.basename(stale)]);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
});

// Ревью 26.10.2026: уборка не должна трогать конфиг идущего хода — возраст
// сам по себе НЕ доказывает, что ход завершился (консультация, self-heal
// ретрай могут занять дольше порога). Полный путь — в Set живых конфигов,
// который держит server.mjs (добавляет при записи, убирает в finally).
test("sweepStaleSessionMcpConfigs: живой файл старше порога не удаляется, старый не-живой — удаляется", () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-mcp-sweep-"));
  try {
    const live = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    const stale = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    fs.writeFileSync(live, "{}");
    fs.writeFileSync(stale, "{}");
    const oldSec = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(live, oldSec, oldSec);
    fs.utimesSync(stale, oldSec, oldSec);
    const removed = sweepStaleSessionMcpConfigs(DIR, 30 * 60 * 1000, new Set([live]));
    assert.deepEqual(removed, [path.basename(stale)]);
    assert.equal(fs.existsSync(live), true, "живой конфиг удалён — это и есть баг");
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
});

test("sweepStaleSessionMcpConfigs: чужие файлы (не конфиг хода) в каталоге загрузок не трогает", () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-mcp-sweep-"));
  try {
    const other = path.join(DIR, FS_KEY + "_report.pdf");
    fs.writeFileSync(other, "x");
    const oldSec = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(other, oldSec, oldSec);
    const removed = sweepStaleSessionMcpConfigs(DIR, 30 * 60 * 1000, new Set());
    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(other), true);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
});

test("sweepStaleSessionMcpConfigs: несуществующая папка — пустой список, не бросает", () => {
  assert.deepEqual(sweepStaleSessionMcpConfigs("/tmp/does-not-exist-" + randomUUID(), 1000, new Set()), []);
});
