// Детерминированные примитивы живого CLI write-gate. Здесь нет обращений к
// пользовательским каталогам: вызывающий тест задаёт уникальные пути и env.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { RUN_ENV, reap } from "./proc-reaper.mjs";

const EMPTY = Buffer.alloc(0);

function errorCode(error) {
  if (typeof error?.code === "string") return error.code;
  if (typeof error?.name === "string") return error.name;
  return "Error";
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
    }).join("\n");
  }
  try { return JSON.stringify(content) || ""; } catch { return ""; }
}

class ProtocolCollector {
  constructor({ maxLineBytes, maxBufferBytes, maxFailures }) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError("invalid maxLineBytes");
    if (!Number.isInteger(maxBufferBytes) || maxBufferBytes < 1) throw new TypeError("invalid maxBufferBytes");
    if (!Number.isInteger(maxFailures) || maxFailures < 0) throw new TypeError("invalid maxFailures");
    this.maxLineBytes = maxLineBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.maxFailures = maxFailures;
    this.buffer = EMPTY;
    this.discarding = false;
    this.ended = false;
    this.failures = [];
    this.droppedFailures = 0;
    this.protocolError = false;
    this.gotResult = false;
    this.resultSuccess = false;
    this.resultError = false;
    this.apiErrorStatus = null;
  }

  addFailure(failure) {
    if (this.failures.length < this.maxFailures) this.failures.push(failure);
    else this.droppedFailures += 1;
  }

  addProtocolError(reason, bytes) {
    this.protocolError = true;
    const failure = { kind: "protocol_error", reason };
    if (Number.isInteger(bytes)) failure.bytes = bytes;
    this.addFailure(failure);
  }

  addToolResult(block) {
    const text = toolResultText(block.content);
    const erofs = /read-only file system|\bEROFS\b/i.test(text);
    if (!block.is_error && !erofs) return;
    this.addFailure({
      kind: erofs ? "EROFS" : "tool_error",
      status: block.is_error ? "error" : "detected",
      bytes: Buffer.byteLength(text),
    });
  }

  processEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      this.addProtocolError("invalid_event");
      return;
    }
    if (event.type === "result") {
      if (this.gotResult) {
        this.addProtocolError("multiple_result");
        this.resultSuccess = false;
        this.resultError = true;
        return;
      }
      this.gotResult = true;
      const hasApiError = Object.prototype.hasOwnProperty.call(event, "api_error_status");
      if (hasApiError) {
        this.apiErrorStatus = typeof event.api_error_status === "number" ? event.api_error_status : "present";
      }
      this.resultSuccess = event.subtype === "success" && event.is_error !== true && !hasApiError;
      this.resultError = !this.resultSuccess;
      return;
    }

    let blocks = [];
    if (event.type === "tool_result") {
      blocks = [event];
    } else if (event.type === "user") {
      const content = event.message?.content;
      if (content == null) return;
      if (!Array.isArray(content)) {
        this.addProtocolError("invalid_tool_content");
        return;
      }
      blocks = content;
    }
    for (const block of blocks) {
      if (block?.type === "tool_result") this.addToolResult(block);
    }
  }

  processLine(line) {
    if (line.length > this.maxLineBytes) {
      this.addProtocolError("oversized_line", line.length);
      return;
    }
    const text = line.toString("utf8");
    if (!text.trim()) return;
    let event;
    try { event = JSON.parse(text); } catch {
      this.addProtocolError("malformed_json", line.length);
      return;
    }
    this.processEvent(event);
  }

  write(chunk) {
    if (this.ended) return;
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.discarding) {
      const newline = data.indexOf(10);
      if (newline === -1) return;
      data = data.subarray(newline + 1);
      this.discarding = false;
    }
    if (data.length === 0) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : Buffer.from(data);

    let newline;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, newline);
      const rest = this.buffer.subarray(newline + 1);
      this.buffer = EMPTY;
      this.processLine(line);
      this.buffer = Buffer.from(rest);
    }

    if (this.buffer.length > this.maxBufferBytes) {
      this.addProtocolError("oversized_buffer", this.buffer.length);
      this.buffer = EMPTY;
      this.discarding = true;
    } else if (this.buffer.length > this.maxLineBytes) {
      this.addProtocolError("oversized_line", this.buffer.length);
      this.buffer = EMPTY;
      this.discarding = true;
    }
  }

  end() {
    if (this.ended) return this.snapshot();
    this.ended = true;
    if (!this.discarding && this.buffer.length) this.processLine(this.buffer);
    this.buffer = EMPTY;
    return this.snapshot();
  }

  snapshot() {
    return {
      gotResult: this.gotResult,
      resultSuccess: this.resultSuccess,
      resultError: this.resultError,
      apiErrorStatus: this.apiErrorStatus,
      protocolError: this.protocolError,
      toolFailures: this.failures.slice(),
      toolFailuresDropped: this.droppedFailures,
    };
  }
}

function processAlive(child, exitCode = null, signalCode = null) {
  if (!child) return false;
  return child.exitCode == null && child.signalCode == null && exitCode == null && signalCode == null;
}

async function cleanupProcesses({ child, tag, reapImpl, graceMs }) {
  const errors = [];
  if (processAlive(child)) {
    try { child.kill("SIGKILL"); } catch (error) {
      errors.push({ kind: "cleanup", operation: "kill", status: errorCode(error) });
    }
  }
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    if (!stream || typeof stream.destroy !== "function") continue;
    try { stream.destroy(); } catch (error) {
      errors.push({ kind: "cleanup", operation: "destroy", status: errorCode(error) });
    }
  }
  try {
    await reapImpl((candidate) => candidate === tag, { graceMs });
  } catch (error) {
    errors.push({ kind: "cleanup", operation: "reap", status: errorCode(error) });
  }
  return errors;
}

export async function cleanupLiveProbe({
  child = null, tag, scratch, output, reapImpl = reap, graceMs = 25, rmSync = fs.rmSync,
}) {
  const errors = await cleanupProcesses({ child, tag, reapImpl, graceMs });
  for (const directory of [scratch, output]) {
    try { rmSync(directory, { recursive: true, force: true }); } catch (error) {
      errors.push({ kind: "cleanup", operation: "remove", status: errorCode(error), path: directory });
    }
  }
  return errors;
}

export async function runCliProbe({
  cli,
  args,
  prompt,
  env,
  cwd = "/tmp",
  tag,
  spawnImpl = spawn,
  reapImpl = reap,
  onChild = null,
  timeoutMs = 120_000,
  killWaitMs = 100,
  reapGraceMs = 25,
  maxLineBytes = 64 * 1024,
  maxBufferBytes = 64 * 1024,
  maxFailures = 8,
}) {
  const collector = new ProtocolCollector({ maxLineBytes, maxBufferBytes, maxFailures });
  env[RUN_ENV] = tag;
  let child = null;
  let outcome = null;
  let exitCode = null;
  let signalCode = null;
  let timedOut = false;
  let spawnError = null;
  let stdinError = null;
  let stderrBytes = 0;

  try {
    outcome = await new Promise((resolve) => {
      let settled = false;
      let mainTimer = null;
      let killTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (mainTimer) clearTimeout(mainTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          code: exitCode,
          signal: signalCode,
          timedOut,
          spawnError,
          stdinError,
          stderrBytes,
          ...collector.end(),
          cleanupErrors: [],
        });
      };

      const stop = () => {
        if (settled || killTimer) return;
        if (processAlive(child, exitCode, signalCode)) {
          try { child.kill("SIGKILL"); } catch (error) {
            if (!spawnError) spawnError = errorCode(error);
          }
        }
        killTimer = setTimeout(finish, killWaitMs);
      };

      try {
        child = spawnImpl(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        if (onChild) onChild(child);
      } catch (error) {
        spawnError = errorCode(error);
        exitCode = 127;
        finish();
        return;
      }

      child.once("error", (error) => {
        spawnError = errorCode(error);
        if (exitCode == null && !child.pid) exitCode = 127;
        stop();
      });
      child.once("exit", (code, signal) => {
        exitCode = code;
        signalCode = signal;
        // exit фиксирует завершение CLI; close может бесконечно ждать fd потомка.
        // Короткая пауза даёт уже полученным stdout-событиям дойти до parser.
        stop();
      });
      child.stdout.on("data", (chunk) => {
        try { collector.write(chunk); } catch {
          collector.addProtocolError("stdout_processing");
          stop();
        }
      });
      child.stdout.once("error", (error) => {
        collector.addProtocolError("stdout_error");
        if (!spawnError) spawnError = errorCode(error);
        stop();
      });
      child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
      child.stderr.once("error", (error) => {
        collector.addProtocolError("stderr_error");
        if (!spawnError) spawnError = errorCode(error);
        stop();
      });
      child.stdin.once("error", (error) => {
        stdinError = errorCode(error);
        stop();
      });

      mainTimer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      try { child.stdin.end(prompt); } catch (error) {
        stdinError = errorCode(error);
        stop();
      }
    });
  } finally {
    const cleanupErrors = await cleanupProcesses({ child, tag, reapImpl, graceMs: reapGraceMs });
    if (outcome) outcome.cleanupErrors = cleanupErrors;
  }
  return outcome;
}

function probe(status, size = null, ok = false) {
  return { ok, status, size };
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function readExpectedProbe(root, name, expected) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const rootPath = path.resolve(root);
  const candidate = path.resolve(root, name);
  if (!contained(rootPath, candidate)) return probe("outside_root");

  let rootStat;
  try { rootStat = fs.lstatSync(rootPath); } catch (error) {
    return probe(errorCode(error) === "ENOENT" ? "missing_root" : errorCode(error));
  }
  if (rootStat.isSymbolicLink()) return probe("symlink_root");
  if (!rootStat.isDirectory()) return probe("root_not_directory");

  let fileStat;
  try { fileStat = fs.lstatSync(candidate); } catch (error) {
    return probe(errorCode(error) === "ENOENT" ? "missing" : errorCode(error));
  }
  if (fileStat.isSymbolicLink()) return probe("symlink_file");
  if (!fileStat.isFile()) return probe("not_regular");

  let rootReal;
  let fileReal;
  try {
    rootReal = fs.realpathSync(rootPath);
    fileReal = fs.realpathSync(candidate);
  } catch (error) {
    return probe(errorCode(error), fileStat.size);
  }
  if (!contained(rootReal, fileReal)) return probe("outside_root", fileStat.size);
  if (fileStat.size !== expectedBytes.length) return probe("size_mismatch", fileStat.size);

  let fd = null;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return probe("not_regular");
    if (opened.size !== expectedBytes.length) return probe("size_mismatch", opened.size);

    const bytes = Buffer.alloc(expectedBytes.length + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, total);
      if (count === 0) break;
      total += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== expectedBytes.length || total !== expectedBytes.length) {
      return probe("size_mismatch", after.size);
    }
    return bytes.subarray(0, total).equals(expectedBytes)
      ? probe("ok", total, true)
      : probe("content_mismatch", total);
  } catch (error) {
    const code = errorCode(error);
    return probe(code === "ELOOP" ? "symlink_file" : code, fileStat.size);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}
