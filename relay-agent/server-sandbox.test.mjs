// Реальные Express-хендлеры server.mjs с подменённым claude spawn. Все каталоги —
// отдельный mkdtemp; настоящие /tmp/agent-* и sessions.json здесь не используются.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelayApp } from "./server.mjs";
import { ensureSessionDirs, ensureListingGuard } from "./paths.mjs";

const FS_KEY = "0123456789abcdef0123456789abcdef";
const SECRET = "a".repeat(64);
const arg = (args, name) => args[args.indexOf(name) + 1];
const waitFor = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not reached");
};

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 400000 + Math.floor(Math.random() * 10000);
  child.killed = false;
  child.closed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.input = '';
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      child.input += chunk.toString();
      callback();
    },
  });
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    setImmediate(() => closeChild(child));
    return true;
  };
  return child;
}

function closeChild(child) {
  if (child.closed) return;
  child.closed = true;
  child.emit("exit", 0);
  child.emit("close", 0);
}

function finishChild(child, events = [{ type: "result", subtype: "success", result: "ok", session_id: "claude-test-session", usage: {} }]) {
  if (child.closed) return;
  for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
  child.stdout.end();
  setImmediate(() => closeChild(child));
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-server-test-"));
  const dirs = {
    uploadDir: path.join(root, "uploads"),
    outputDir: path.join(root, "output"),
    scratchRoot: path.join(root, "scratch"),
    mcpConfigDir: path.join(root, "mcp"),
    sessionTranscriptDir: path.join(root, "transcripts"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const baseMcpPath = path.join(root, "empty-mcp.json");
  fs.writeFileSync(baseMcpPath, JSON.stringify({ mcpServers: {} }));
  const sandboxModeFile = path.join(root, "sandbox-mode");
  fs.writeFileSync(sandboxModeFile, options.mode || "on");
  const sandboxCanaryFile = path.join(root, "sandbox-canary.keys");
  fs.writeFileSync(sandboxCanaryFile, options.canaryKeys || "");
  const secretsPath = path.join(root, "relay-secrets");
  const authModePath = path.join(root, "relay-auth-mode");
  fs.writeFileSync(secretsPath, SECRET + "\n", { mode: 0o600 });
  fs.writeFileSync(authModePath, "enforce\n");

  const env = {
    PATH: "/usr/bin",
    HOME: path.join(root, "legacy-home"),
    LANG: "C.UTF-8",
    CUSTOM_LEGACY_VALUE: "kept-off",
    UNRELATED_SECRET: "not-for-sandbox",
    MCP_TIMEOUT: "1",
    MCP_TOOL_TIMEOUT: "2",
    CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    API_TIMEOUT_MS: "300000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    RELAY_SECRETS_FILE: secretsPath,
    RELAY_AUTH_MODE_FILE: authModePath,
    ...(options.env || {}),
  };
  if (options.fallback) {
    env.QWEN_KEY_FILE = path.join(root, "qwen.key");
    fs.writeFileSync(env.QWEN_KEY_FILE, "test-provider-key\n", { mode: 0o600 });
  }

  const calls = [];
  const spawnImpl = (command, args, spawnOptions) => {
    const child = fakeChild();
    const call = { command, args, options: spawnOptions, child };
    calls.push(call);
    child.stdin.on("finish", () => {
      setImmediate(() => {
        if (options.onSpawn) options.onSpawn(call, calls.indexOf(call));
        else finishChild(child);
      });
    });
    return child;
  };

  const runtime = createRelayApp({
    ...dirs,
    env,
    spawnImpl,
    reapImpl: async () => [],
    baseMcpPath,
    sessionStorePath: path.join(root, "sessions.json"),
    claudeConfigDir: path.join(root, "claude-config"),
    sandboxModeFile,
    sandboxCanaryFile,
    drainPath: path.join(root, "drain"),
    retryDelayMs: 0,
    fileOps: options.fileOps,
    ensureSessionDirsImpl: options.ensureSessionDirsImpl,
    ensureListingGuardImpl: options.ensureListingGuardImpl,
  });
  const server = await new Promise((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
    for (const dir of [dirs.uploadDir, dirs.outputDir, dirs.scratchRoot]) {
      if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const request = async ({ withMcp = true, noFallback = true, ...body } = {}) => {
    const payload = {
      message: "test message",
      sessionId: "server-test-session",
      fs_key: FS_KEY,
      ...body,
    };
    if (noFallback) payload.noFallback = "1";
    if (withMcp) {
      payload.talerid_token = "test-turn-token";
      payload.talerid_mcp_url = "https://example.invalid/mcp";
    }
    const response = await fetch(baseUrl + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": SECRET },
      body: JSON.stringify(payload),
    });
    return { response, text: await response.text() };
  };
  const requestUpload = async (files, { sessionId = 'server-upload-session', fsKey = FS_KEY } = {}) => {
    const payload = new FormData();
    payload.append('message', 'test uploaded documents');
    payload.append('sessionId', sessionId);
    if (fsKey) payload.append('fs_key', fsKey);
    payload.append('noFallback', '1');
    for (const file of files) {
      payload.append('files', new Blob([file.body], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }), file.name);
    }
    const response = await fetch(baseUrl + '/chat', {
      method: 'POST',
      headers: { 'x-agent-secret': SECRET },
      body: payload,
    });
    return { response, text: await response.text() };
  };
  const turnFiles = () => fs.readdirSync(dirs.mcpConfigDir).filter((name) => /-session-mcp(?:\.settings)?\.json$/.test(name));
  return { root, dirs, env, calls, runtime, request, requestUpload, turnFiles };
}

test("server off: прежние tools/env, нет --settings, MCP очищается", async (t) => {
  const f = await fixture(t, { mode: "off" });
  const { response } = await f.request();
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  const { args, options } = f.calls[0];
  assert.equal(args.includes("--settings"), false);
  assert.ok(arg(args, "--allowedTools").includes("WebFetch(*)"));
  assert.equal(arg(args, "--disallowedTools").split(",").includes("WebFetch"), false);
  assert.equal(options.env.CUSTOM_LEGACY_VALUE, "kept-off");
  assert.equal(options.env.MCP_TIMEOUT, "120000");
  assert.equal(options.env.MCP_TOOL_TIMEOUT, "600000");
  assert.equal(options.env.PATH, "/usr/bin:/home/dv/agent-env/bin:/home/dv/.bun/bin:/home/dv/file-agent/bin");
  assert.equal(options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
  assert.deepEqual(f.turnFiles(), []);
  assert.equal(f.runtime.liveTurnFiles.size, 0);
});

test("server on: фактические argv запрещают WebFetch, env и settings изолированы", async (t) => {
  let settingsAtSpawn;
  const f = await fixture(t, {
    onSpawn(call) {
      const settingsPath = arg(call.args, "--settings");
      settingsAtSpawn = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(call.options.env.HOME.startsWith(f?.root || "/unreachable"), true);
      finishChild(call.child);
    },
  });
  // onSpawn вызывается после инициализации fixture; ссылка на f здесь безопасна.
  const { response } = await f.request();
  assert.equal(response.status, 200);
  const { args, options } = f.calls[0];
  const allowed = arg(args, "--allowedTools");
  const disallowed = arg(args, "--disallowedTools").split(",");
  assert.equal(allowed.includes("WebFetch"), false);
  assert.ok(allowed.includes("WebSearch(*)"));
  assert.ok(disallowed.includes("WebFetch"));
  assert.equal(allowed.includes("(/opt/**)"), false);
  assert.ok(allowed.includes(`/opt/linkeon-agent/**`));
  assert.equal(options.env.MCP_TIMEOUT, "120000");
  assert.equal(options.env.MCP_TOOL_TIMEOUT, "600000");
  assert.equal(options.env.API_TIMEOUT_MS, "300000");
  assert.equal(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, "test-oauth-token");
  assert.equal(options.env.UNRELATED_SECRET, undefined);
  assert.equal(options.env.CUSTOM_LEGACY_VALUE, undefined);
  assert.ok(options.env.HOME.startsWith(f.root));
  assert.ok(options.env.TMPDIR.startsWith(f.root));
  assert.ok(settingsAtSpawn.sandbox.filesystem.denyRead.includes("/tmp/agent-uploads/mcp"));
  assert.ok(settingsAtSpawn.sandbox.filesystem.denyRead.includes(f.dirs.mcpConfigDir));
  assert.ok(settingsAtSpawn.permissions.deny.includes("Read(/tmp/agent-uploads/mcp/**)"));
  assert.ok(settingsAtSpawn.sandbox.filesystem.allowWrite.includes(path.join(f.dirs.outputDir, FS_KEY)));
  assert.deepEqual(f.turnFiles(), []);
});

test("server canary: settings и запреты только у перечисленной сессии", async (t) => {
  const f = await fixture(t, { mode: "canary", canaryKeys: "listed-session\n\n" });
  await f.request({ sessionId: "listed-session" });
  await f.request({ sessionId: "ordinary-session" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].args.includes("--settings"), true);
  assert.equal(arg(f.calls[0].args, "--disallowedTools").split(",").includes("WebFetch"), true);
  assert.equal(f.calls[1].args.includes("--settings"), false);
  assert.ok(arg(f.calls[1].args, "--allowedTools").includes("WebFetch(*)"));
  assert.equal(arg(f.calls[1].args, "--disallowedTools").split(",").includes("WebFetch"), false);
});

test("server retry: один settings и один MCP на обе попытки, cleanup после успеха", async (t) => {
  const seen = [];
  const f = await fixture(t, {
    onSpawn(call, index) {
      const pair = [arg(call.args, "--settings"), arg(call.args, "--mcp-config")];
      for (const full of pair) assert.equal(fs.existsSync(full), true);
      seen.push(pair);
      finishChild(call.child, index === 0
        ? [{ type: "result", subtype: "error", is_error: true, result: "API Error: 500 Internal Server Error" }]
        : undefined);
    },
  });
  await f.request();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(f.turnFiles(), []);
});

test("server fallback: тот же settings/MCP у запасного провайдера и его env whitelist", async (t) => {
  const seen = [];
  const f = await fixture(t, {
    fallback: true,
    onSpawn(call, index) {
      const pair = [arg(call.args, "--settings"), arg(call.args, "--mcp-config")];
      for (const full of pair) assert.equal(fs.existsSync(full), true);
      seen.push(pair);
      finishChild(call.child, index === 0
        ? [{ type: "result", subtype: "success", result: "Not logged in" }]
        : undefined);
    },
  });
  await f.request({ noFallback: false });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(f.calls[1].options.env.API_TIMEOUT_MS, "300000");
  assert.equal(f.calls[1].options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(f.calls[1].options.env.UNRELATED_SECRET, undefined);
  assert.deepEqual(f.turnFiles(), []);
});

test("server setup error: неизвестная schema fail-closed, MCP удалён, spawn не вызывается", async (t) => {
  const f = await fixture(t, { env: { RELAY_SANDBOX_SCHEMA: "B" } });
  const { response } = await f.request();
  assert.equal(response.status, 500);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.turnFiles(), []);
  assert.equal(f.runtime.liveTurnFiles.size, 0);
});

test("server partial settings write: недописанный файл и MCP удаляются внешним finally", async (t) => {
  const fileOps = {
    ...fs,
    writeFileSync(full, data, options) {
      if (full.endsWith("-session-mcp.settings.json")) {
        fs.writeFileSync(full, "{", options);
        const err = new Error("disk full");
        err.code = "ENOSPC";
        throw err;
      }
      return fs.writeFileSync(full, data, options);
    },
  };
  const f = await fixture(t, { fileOps });
  const { response } = await f.request();
  assert.equal(response.status, 500);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.turnFiles(), []);
  assert.equal(f.runtime.liveTurnFiles.size, 0);
});

test("server partial MCP write: безопасный fallback на base config, частичный файл не остаётся", async (t) => {
  const fileOps = {
    ...fs,
    writeFileSync(full, data, options) {
      if (full.endsWith("-session-mcp.json")) {
        fs.writeFileSync(full, "{", options);
        const err = new Error("disk full");
        err.code = "ENOSPC";
        throw err;
      }
      return fs.writeFileSync(full, data, options);
    },
  };
  let filesAtSpawn;
  const f = await fixture(t, {
    fileOps,
    onSpawn(call) {
      filesAtSpawn = f.turnFiles();
      assert.ok(arg(call.args, "--mcp-config").endsWith("empty-mcp.json"));
      finishChild(call.child);
    },
  });
  const { response } = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(filesAtSpawn.filter((name) => name.endsWith("-session-mcp.json")), []);
  assert.deepEqual(f.turnFiles(), []);
});

test("server spawn error: settings и MCP очищаются после завершения хода", async (t) => {
  const f = await fixture(t, {
    onSpawn(call) {
      call.child.emit("error", new Error("spawn failed"));
      closeChild(call.child);
    },
  });
  await f.request();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.turnFiles(), []);
  assert.equal(f.runtime.liveTurnFiles.size, 0);
});

test("server preempt: два хода сессии не удаляют файлы друг друга", async (t) => {
  const f = await fixture(t, { onSpawn() {} });
  const firstResponse = f.request({ sessionId: "parallel-session" });
  await waitFor(() => f.calls.length === 1);
  const first = f.calls[0];
  const secondResponse = f.request({ sessionId: "parallel-session" });
  await waitFor(() => f.calls.length === 2);
  const second = f.calls[1];
  assert.equal(first.child.killed, true);
  assert.notEqual(arg(first.args, "--settings"), arg(second.args, "--settings"));
  assert.notEqual(arg(first.args, "--mcp-config"), arg(second.args, "--mcp-config"));
  await firstResponse;
  assert.equal(fs.existsSync(arg(second.args, "--settings")), true, "finally первого хода удалил settings второго");
  assert.equal(fs.existsSync(arg(second.args, "--mcp-config")), true, "finally первого хода удалил MCP второго");
  finishChild(second.child);
  await secondResponse;
  assert.deepEqual(f.turnFiles(), []);
});

test("server dirs: listing guard вызывается до session dirs, старый scratch не удаляется", async (t) => {
  const order = [];
  const f = await fixture(t, {
    ensureListingGuardImpl: async (opts) => { order.push("guard"); return ensureListingGuard(opts); },
    ensureSessionDirsImpl: async (...args) => { order.push("session"); return ensureSessionDirs(...args); },
  });
  const scratch = path.join(f.dirs.scratchRoot, FS_KEY);
  const marker = path.join(scratch, "keep.txt");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(marker, "keep");
  const old = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(scratch, old, old);
  await f.request();
  assert.deepEqual(order, ["guard", "session"]);
  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  for (const dir of [f.dirs.uploadDir, f.dirs.outputDir, f.dirs.scratchRoot]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o311);
  }
});

for (const mode of ['on', 'off']) {
  test(`server ${mode}: два DOCX доступны по точным путям и через каталог сессии`, async (t) => {
    const f = await fixture(t, { mode });
    const { response } = await f.requestUpload([
      { name: 'first.docx', body: 'first-document-body' },
      { name: 'second.docx', body: 'second-document-body' },
    ]);
    assert.equal(response.status, 200);

    const dir = path.join(f.dirs.uploadDir, FS_KEY);
    const expected = [`${FS_KEY}_first.docx`, `${FS_KEY}_second.docx`];
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.docx')).sort(), expected);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(dir, expected[0]), 'utf8'), 'first-document-body');
    assert.equal(fs.readFileSync(path.join(dir, expected[1]), 'utf8'), 'second-document-body');

    const prompt = f.calls[0].child.input;
    for (const name of expected) {
      const full = path.join(dir, name);
      assert.ok(prompt.includes(`- ${full} (name: `), full);
      assert.equal(fs.existsSync(full), true);
    }
  });
}

for (const legacyKey of ['70000000000_12_ru', 'mcp']) {
  test(`server on: legacy ${legacyKey} сохраняет плоскую схему загрузок`, async (t) => {
    const f = await fixture(t);
    const { response } = await f.requestUpload([
      { name: 'first.docx', body: 'legacy-document-body' },
    ], { sessionId: legacyKey, fsKey: null });
    assert.equal(response.status, 200);

    const flat = path.join(f.dirs.uploadDir, `${legacyKey}_first.docx`);
    assert.equal(fs.readFileSync(flat, 'utf8'), 'legacy-document-body');
    assert.equal(fs.existsSync(path.join(f.dirs.uploadDir, legacyKey)), false);
    assert.ok(f.calls[0].child.input.includes(`- ${flat} (name: `));
    assert.ok(arg(f.calls[0].args, '--allowedTools').includes(`Read(/tmp/agent-uploads/${legacyKey}_*)`));
  });
}

test("server signal и stale sweeper: оба suffix удаляются, liveSet очищается", async (t) => {
  let exitSignal = null;
  const f = await fixture(t, { onSpawn() {} });
  const pending = f.request();
  await waitFor(() => f.calls.length === 1);
  assert.equal(f.turnFiles().length, 2);
  f.runtime.handleSignal("SIGTERM", (signal) => { exitSignal = signal; });
  assert.equal(exitSignal, "SIGTERM");
  assert.deepEqual(f.turnFiles(), []);
  assert.equal(f.runtime.liveTurnFiles.size, 0);
  finishChild(f.calls[0].child);
  await pending;

  const staleMcp = path.join(f.dirs.mcpConfigDir, "stale-session-mcp.json");
  const staleSettings = path.join(f.dirs.mcpConfigDir, "stale-session-mcp.settings.json");
  const other = path.join(f.dirs.mcpConfigDir, "other.json");
  for (const full of [staleMcp, staleSettings, other]) fs.writeFileSync(full, "{}");
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (const full of [staleMcp, staleSettings, other]) fs.utimesSync(full, old, old);
  const removed = f.runtime.sweepStaleTurnFiles();
  assert.equal(removed.length, 2);
  assert.equal(fs.existsSync(staleMcp), false);
  assert.equal(fs.existsSync(staleSettings), false);
  assert.equal(fs.existsSync(other), true);
});

test('entrypoint: PM2 fork_mode распознаётся по pm_id, а не только argv[1]', () => {
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.pm_id !== undefined/);
  assert.match(source, /ProcessContainerFork\.js/);
});
