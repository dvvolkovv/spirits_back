import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runTag, reap, taggedProcesses } from "./proc-reaper.mjs";

const SUCCESS = '{"type":"result","subtype":"success","is_error":false}';
const loadLib = () => import("./sandbox-write-live-lib.mjs");
const immediate = () => new Promise((resolve) => setImmediate(resolve));

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

async function runChunks(runCliProbe, chunks, options = {}) {
  const child = fakeChild();
  const running = runCliProbe({
    cli: "/fake/claude",
    args: [],
    prompt: "PROMPT",
    env: {},
    tag: "test:fake",
    spawnImpl: () => child,
    reapImpl: async () => [],
    timeoutMs: 1000,
    killWaitMs: 1,
    reapGraceMs: 0,
    ...options,
  });
  await immediate();
  for (const chunk of chunks) child.stdout.write(chunk);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  return { outcome: await running, child };
}

test("terminal success принимается из финального buffer без newline", async () => {
  const { runCliProbe } = await loadLib();
  const { outcome } = await runChunks(runCliProbe, [SUCCESS]);
  assert.equal(outcome.gotResult, true);
  assert.equal(outcome.resultSuccess, true);
  assert.equal(outcome.resultError, false);
  assert.equal(outcome.protocolError, false);
});

test("error_max_turns с is_error=false не считается success", async () => {
  const { runCliProbe } = await loadLib();
  const event = '{"type":"result","subtype":"error_max_turns","is_error":false}\n';
  const { outcome } = await runChunks(runCliProbe, [event]);
  assert.equal(outcome.gotResult, true);
  assert.equal(outcome.resultSuccess, false);
  assert.equal(outcome.resultError, true);
});

test("api_error_status делает terminal result красным", async () => {
  const { runCliProbe } = await loadLib();
  const event = '{"type":"result","subtype":"success","is_error":false,"api_error_status":429}\n';
  const { outcome } = await runChunks(runCliProbe, [event]);
  assert.equal(outcome.resultSuccess, false);
  assert.equal(outcome.resultError, true);
  assert.equal(outcome.apiErrorStatus, 429);
});

test("финальный is_error без newline не теряется", async () => {
  const { runCliProbe } = await loadLib();
  const event = '{"type":"result","subtype":"success","is_error":true}';
  const { outcome } = await runChunks(runCliProbe, [event]);
  assert.equal(outcome.gotResult, true);
  assert.equal(outcome.resultSuccess, false);
  assert.equal(outcome.resultError, true);
  assert.equal(outcome.protocolError, false);
});

test("malformed NDJSON остаётся RED даже рядом с success", async () => {
  const { runCliProbe } = await loadLib();
  const { outcome } = await runChunks(runCliProbe, [`{not json}\n${SUCCESS}\n`]);
  assert.equal(outcome.protocolError, true);
  assert.ok(outcome.toolFailures.some((failure) => failure.kind === "protocol_error" && failure.reason === "malformed_json"));
});

test("отсутствие terminal result не fail-open", async () => {
  const { runCliProbe } = await loadLib();
  const event = '{"type":"assistant","message":{"content":[]}}\n';
  const { outcome } = await runChunks(runCliProbe, [event]);
  assert.equal(outcome.gotResult, false);
  assert.equal(outcome.resultSuccess, false);
});

test("oversized line и buffer ограничены и дают protocol_error", async () => {
  const { runCliProbe } = await loadLib();
  const options = { maxLineBytes: 32, maxBufferBytes: 32 };
  const line = await runChunks(runCliProbe, [`${"x".repeat(128)}\n${SUCCESS}\n`], options);
  assert.equal(line.outcome.protocolError, true);
  assert.ok(line.outcome.toolFailures.some((failure) => failure.reason === "oversized_line"));

  const buffer = await runChunks(runCliProbe, [`{"type":"result"${" ".repeat(128)}`], options);
  assert.equal(buffer.outcome.protocolError, true);
  assert.equal(buffer.outcome.gotResult, false);
  assert.ok(buffer.outcome.toolFailures.some((failure) => failure.reason === "oversized_buffer"));
});

test("top-level tool_result классифицирует EROFS без сырого output", async () => {
  const { runCliProbe } = await loadLib();
  const event = '{"type":"tool_result","is_error":false,"content":"Read-only file system"}\n';
  const { outcome } = await runChunks(runCliProbe, [`${event}${SUCCESS}\n`]);
  assert.deepEqual(outcome.toolFailures, [{ kind: "EROFS", status: "detected", bytes: 21 }]);
  assert.equal(JSON.stringify(outcome).includes("Read-only file system"), false);
});

test("toolFailures ограничены и содержат только классификации", async () => {
  const { runCliProbe } = await loadLib();
  const events = Array.from({ length: 6 }, (_, index) => JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: `SECRET_OUTPUT_${index}` }] },
  }));
  const { outcome } = await runChunks(runCliProbe, [`${events.join("\n")}\n${SUCCESS}\n`], { maxFailures: 3 });
  assert.equal(outcome.toolFailures.length, 3);
  assert.equal(outcome.toolFailuresDropped, 3);
  assert.ok(outcome.toolFailures.every((failure) => failure.kind === "tool_error"));
  assert.equal(JSON.stringify(outcome).includes("SECRET_OUTPUT"), false);
});

test("timeout завершается bounded, пока потомок держит stdout, и reap гасит дерево", { timeout: 5000 }, async () => {
  const { runCliProbe } = await loadLib();
  const tag = runTag(randomUUID());
  const parentScript = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "inherit"], env: process.env
    });
    console.error("DESCENDANT=" + descendant.pid);
    descendant.unref();
    setInterval(() => {}, 1000);
  `;
  let child;
  let descendantPid = null;
  const started = Date.now();
  try {
    const running = runCliProbe({
      cli: "/fake/claude",
      args: [],
      prompt: "PROMPT",
      env: { PATH: process.env.PATH },
      tag,
      timeoutMs: 250,
      killWaitMs: 10,
      reapGraceMs: 1,
      spawnImpl: (_cli, _args, { env }) => {
        child = spawn(process.execPath, ["-e", parentScript], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr.on("data", (chunk) => {
          const match = /DESCENDANT=(\d+)/.exec(chunk.toString());
          if (match) descendantPid = Number(match[1]);
        });
        return child;
      },
      reapImpl: reap,
    });
    let guard;
    const outcome = await Promise.race([
      running,
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("runner did not settle")), 2000); }),
    ]).finally(() => clearTimeout(guard));
    assert.equal(outcome.timedOut, true);
    assert.ok(Date.now() - started < 2500, "нельзя ждать close унаследованных fd");
    assert.ok(descendantPid > 0, "потомок действительно запущен с унаследованным stdout");
    assert.equal(child.stdout.destroyed, true);
    assert.deepEqual((await taggedProcesses()).filter((entry) => entry.tag === tag), []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    await reap((candidate) => candidate === tag, { graceMs: 1 });
  }
});

test("stdin EPIPE становится outcome и не уходит в unhandled error", async () => {
  const { runCliProbe } = await loadLib();
  const child = fakeChild();
  child.stdin.end = () => {
    const error = new Error("EPIPE");
    error.code = "EPIPE";
    child.stdin.emit("error", error);
  };
  let reaped = 0;
  const outcome = await runCliProbe({
    cli: "/fake/claude",
    args: [],
    prompt: "PROMPT",
    env: {},
    tag: "test:epipe",
    spawnImpl: () => child,
    reapImpl: async () => { reaped += 1; return []; },
    timeoutMs: 1000,
    killWaitMs: 1,
    reapGraceMs: 0,
  });
  assert.equal(outcome.stdinError, "EPIPE");
  assert.ok(child.killCalls.includes("SIGKILL"));
  assert.equal(reaped, 1);
  assert.equal(child.stdout.destroyed, true);
});

test("child error не завершает lifecycle без kill/reap/destroy", async () => {
  const { runCliProbe } = await loadLib();
  const child = fakeChild();
  let reaped = 0;
  const running = runCliProbe({
    cli: "/fake/claude",
    args: [],
    prompt: "PROMPT",
    env: {},
    tag: "test:child-error",
    spawnImpl: () => child,
    reapImpl: async () => { reaped += 1; return []; },
    timeoutMs: 1000,
    killWaitMs: 1,
    reapGraceMs: 0,
  });
  await immediate();
  const error = new Error("spawn failure");
  error.code = "ENOENT";
  child.emit("error", error);
  const outcome = await running;
  assert.equal(outcome.spawnError, "ENOENT");
  assert.ok(child.killCalls.includes("SIGKILL"));
  assert.equal(reaped, 1);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("regular probe с точным содержимым принимается без вывода содержимого", async () => {
  const { readExpectedProbe } = await loadLib();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-probe-ok-"));
  try {
    fs.writeFileSync(path.join(root, "probe.txt"), "scratch-ok");
    const probe = readExpectedProbe(root, "probe.txt", "scratch-ok");
    assert.deepEqual(probe, { ok: true, status: "ok", size: 10 });
    assert.equal(JSON.stringify(probe).includes("scratch-ok"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symlink probe отклоняется даже при правильном содержимом target", async () => {
  const { readExpectedProbe } = await loadLib();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "live-probe-symlink-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside.txt");
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "scratch-ok");
    fs.symlinkSync(outside, path.join(root, "probe.txt"));
    const probe = readExpectedProbe(root, "probe.txt", "scratch-ok");
    assert.equal(probe.ok, false);
    assert.equal(probe.status, "symlink_file");
    assert.equal(JSON.stringify(probe).includes("scratch-ok"), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("symlink root отклоняется до чтения probe", async () => {
  const { readExpectedProbe } = await loadLib();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "live-probe-root-link-"));
  const real = path.join(base, "real");
  const link = path.join(base, "link");
  try {
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "probe.txt"), "scratch-ok");
    fs.symlinkSync(real, link, "dir");
    const probe = readExpectedProbe(link, "probe.txt", "scratch-ok");
    assert.deepEqual(probe, { ok: false, status: "symlink_root", size: null });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("oversized probe отклоняется по размеру без сохранения содержимого", async () => {
  const { readExpectedProbe } = await loadLib();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-probe-large-"));
  try {
    fs.writeFileSync(path.join(root, "probe.txt"), "x".repeat(1024));
    const probe = readExpectedProbe(root, "probe.txt", "scratch-ok");
    assert.deepEqual(probe, { ok: false, status: "size_mismatch", size: 1024 });
    assert.equal(JSON.stringify(probe).includes("xxx"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("partial setup cleanup удаляет созданные dirs и всё равно вызывает reap", async () => {
  const { cleanupLiveProbe } = await loadLib();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "live-probe-partial-"));
  const scratch = path.join(base, "scratch");
  const output = path.join(base, "output");
  let reaped = 0;
  try {
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, "partial"), "x");
    const errors = await cleanupLiveProbe({
      child: null,
      tag: "test:partial",
      scratch,
      output,
      reapImpl: async () => { reaped += 1; return []; },
      graceMs: 0,
    });
    assert.deepEqual(errors, []);
    assert.equal(reaped, 1);
    assert.equal(fs.existsSync(scratch), false);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup пробует output, даже если удаление scratch упало", async () => {
  const { cleanupLiveProbe } = await loadLib();
  const calls = [];
  const scratch = "/unique/scratch";
  const output = "/unique/output";
  const errors = await cleanupLiveProbe({
    child: null,
    tag: "test:cleanup",
    scratch,
    output,
    reapImpl: async () => [],
    graceMs: 0,
    rmSync: (directory) => {
      calls.push(directory);
      if (directory === scratch) {
        const error = new Error("private cleanup detail");
        error.code = "EACCES";
        throw error;
      }
    },
  });
  assert.deepEqual(calls, [scratch, output]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, "EACCES");
  assert.equal(JSON.stringify(errors).includes("private cleanup detail"), false);
});

test("live test регистрирует cleanup до ensureSessionDirs", () => {
  const source = fs.readFileSync(new URL("./sandbox-write-live.test.mjs", import.meta.url), "utf8");
  const cleanup = source.indexOf("t.after(");
  const setup = source.indexOf("await ensureSessionDirs");
  assert.ok(cleanup > -1);
  assert.ok(setup > cleanup, "partial setup не должен оставаться без cleanup");
});
