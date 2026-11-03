// node --test relay-agent/session-mcp-config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { sessionMcpConfigName, sweepStaleSessionMcpConfigs, LIVE_MAX_AGE_MS, ensureMcpConfigDir, removeLiveConfigs, writeSandboxSettings, removeSandboxSettings, writeSessionMcpConfig } from "./session-mcp-config.mjs";

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

// Живой — не вечный: если close у дочернего процесса так и не пришёл, файл с
// токенами не должен лежать до рестарта.
test("sweepStaleSessionMcpConfigs: живой файл старше LIVE_MAX_AGE_MS удаляется и выходит из Set", () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-mcp-sweep-"));
  try {
    const live = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    fs.writeFileSync(live, "{}");
    const oldSec = (Date.now() - LIVE_MAX_AGE_MS - 60 * 1000) / 1000;
    fs.utimesSync(live, oldSec, oldSec);
    const set = new Set([live]);
    const removed = sweepStaleSessionMcpConfigs(DIR, 30 * 60 * 1000, set);
    assert.deepEqual(removed, [path.basename(live)]);
    assert.equal(fs.existsSync(live), false);
    assert.equal(set.has(live), false);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
});

// Каталог могут снести посреди работы (rm -rf /tmp/agent-uploads/*) — без
// него каждый ход молча остался бы без инструментов до рестарта.
test("ensureMcpConfigDir: снесённый каталог создаётся заново, права — 0700 и у существующего", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "session-mcp-dir-"));
  try {
    const dir = path.join(ROOT, "mcp");
    ensureMcpConfigDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    fs.chmodSync(dir, 0o755);
    ensureMcpConfigDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    fs.rmSync(dir, { recursive: true });
    ensureMcpConfigDir(dir);
    assert.equal(fs.existsSync(dir), true);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

// Остановка процесса (pm2 restart) — process.exit без finally ходов.
test("removeLiveConfigs: удаляет все живые конфиги и чистит Set; пропавший файл не мешает", () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-mcp-sweep-"));
  try {
    const a = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    const b = path.join(DIR, sessionMcpConfigName(FS_KEY, randomUUID()));
    fs.writeFileSync(a, "{}");
    const set = new Set([a, b]);
    removeLiveConfigs(set);
    assert.equal(fs.existsSync(a), false);
    assert.equal(set.size, 0);
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
});

test("MCP и settings: общий liveSet до записи, partial write удаляется и выходит из Set", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "turn-file-lifecycle-"));
  const live = new Set();
  const failingOps = {
    ...fs,
    writeFileSync(full, data, options) {
      assert.equal(live.has(full), true, "путь должен попасть в liveSet до записи");
      fs.writeFileSync(full, "{", options);
      const err = new Error("disk full");
      err.code = "ENOSPC";
      throw err;
    },
  };
  try {
    assert.throws(() => writeSessionMcpConfig(ROOT, FS_KEY, randomUUID(), { mcpServers: {} }, live, failingOps), /disk full/);
    assert.equal(live.size, 0);
    assert.deepEqual(fs.readdirSync(ROOT), []);

    assert.throws(() => writeSandboxSettings(ROOT, FS_KEY, randomUUID(), { sandbox: {} }, live, failingOps), /disk full/);
    assert.equal(live.size, 0);
    assert.deepEqual(fs.readdirSync(ROOT), []);

    const mcp = writeSessionMcpConfig(ROOT, FS_KEY, randomUUID(), { mcpServers: {} }, live);
    const settings = writeSandboxSettings(ROOT, FS_KEY, randomUUID(), { sandbox: {} }, live);
    assert.deepEqual(new Set([mcp, settings]), live);
    removeSandboxSettings(settings, live);
    assert.equal(live.has(settings), false);
    assert.equal(live.has(mcp), true);
  } finally {
    removeLiveConfigs(live);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

test("stale sweeper: обрабатывает и MCP, и settings, чужие suffix не трогает", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "turn-file-sweep-"));
  try {
    const mcp = writeSessionMcpConfig(ROOT, FS_KEY, randomUUID(), {}, new Set());
    const settings = writeSandboxSettings(ROOT, FS_KEY, randomUUID(), {}, new Set());
    const other = path.join(ROOT, "ordinary.json");
    fs.writeFileSync(other, "{}");
    const oldSec = (Date.now() - 60 * 60 * 1000) / 1000;
    for (const full of [mcp, settings, other]) fs.utimesSync(full, oldSec, oldSec);
    const removed = sweepStaleSessionMcpConfigs(ROOT, 30 * 60 * 1000, new Set());
    assert.deepEqual(removed.sort(), [path.basename(mcp), path.basename(settings)].sort());
    assert.equal(fs.existsSync(mcp), false);
    assert.equal(fs.existsSync(settings), false);
    assert.equal(fs.existsSync(other), true);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

test("settings песочницы: уникальный файл хода вне uploads, JSON 0600, независимая очистка", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-settings-"));
  const dir = path.join(ROOT, "agent-mcp");
  let first;
  let second;
  try {
    const settings = { sandbox: { enabled: true }, permissions: { deny: ["Read(/proc/**)"] } };
    first = writeSandboxSettings(dir, FS_KEY, randomUUID(), settings);
    second = writeSandboxSettings(dir, FS_KEY, randomUUID(), settings);
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), dir);
    assert.equal(first.startsWith("/tmp/agent-uploads/"), false);
    assert.match(path.basename(first), /-session-mcp\.settings\.json$/);
    assert.ok(Buffer.byteLength(path.basename(first)) < 255);
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(first, "utf8")), settings);

    // Очистка settings не зависит от наличия sessionMcpPath: вызывается сама.
    removeSandboxSettings(first);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), true);
    assert.doesNotThrow(() => removeSandboxSettings(first));
    assert.doesNotThrow(() => removeSandboxSettings(null));
  } finally {
    removeSandboxSettings(first);
    removeSandboxSettings(second);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
