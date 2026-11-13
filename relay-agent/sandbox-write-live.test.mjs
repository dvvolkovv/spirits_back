// Живой гейт выбранного Claude CLI. По умолчанию не обращается ни к CLI, ни к
// пользовательским каталогам. Включается только явной переменной на relay-host.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildSandboxSettings, buildCliEnv } from "./sandbox-policy.mjs";
import { ensureSessionDirs } from "./paths.mjs";

const LIVE = process.env.RELAY_LIVE_CLI_WRITE_TEST === "1";
const CLI = process.env.RELAY_CLAUDE_BIN || "/opt/linkeon-agent/bin/claude";

function findNamed(root, wanted) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name === wanted) found.push(full);
    }
  }
  return found;
}

test("CLI sandbox записывает и scratch, и output", {
  skip: LIVE ? false : "живой CLI test включается только RELAY_LIVE_CLI_WRITE_TEST=1",
  timeout: 180_000,
}, async (t) => {
  const fsKey = randomUUID().replaceAll("-", "");
  const scratch = `/tmp/agent-scratch/${fsKey}`;
  const output = `/tmp/agent-output/${fsKey}`;
  const outputProbe = path.join(output, "probe.txt");
  let child;
  let finished = false;

  await ensureSessionDirs(fsKey);
  t.after(() => {
    if (child && !finished) child.kill("SIGKILL");
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  });

  const settingsPath = path.join(scratch, "probe-settings.json");
  const mcpPath = path.join(scratch, "probe-empty-mcp.json");
  fs.writeFileSync(settingsPath, JSON.stringify(buildSandboxSettings(fsKey)), { mode: 0o600 });
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });

  const childEnv = buildCliEnv({
    baseEnv: process.env,
    providerEnv: process.env,
    fsKey,
    scrub: true,
    claudeConfigDir: "/home/dv/.claude",
  });
  const command = `printf scratch-ok > "$TMPDIR/probe.txt" && printf output-ok > "${outputProbe}" && cat "$TMPDIR/probe.txt" "${outputProbe}"`;
  const prompt = `Use the Bash tool exactly once to run this command verbatim: ${command}\nDo not use another tool and do not disable or bypass the sandbox. Then reply DONE.`;
  const args = [
    "--print",
    "--model", "haiku",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "4",
    "--allowedTools", "Bash(*)",
    "--settings", settingsPath,
    "--mcp-config", mcpPath,
    "--strict-mcp-config",
    "--system-prompt-snapshot", "off",
    "--system-prompt", "Follow the user instruction exactly. Never disable or bypass the sandbox.",
  ];

  child = spawn(CLI, args, { cwd: "/tmp", env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const outcome = await new Promise((resolve) => {
    let buffer = "";
    let stderrBytes = 0;
    let timedOut = false;
    let resultError = false;
    let spawnError = null;
    let settled = false;
    const toolFailures = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, resultError, spawnError, stderrBytes, toolFailures });
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "result" && event.is_error === true) resultError = true;
        if (event.type !== "user") continue;
        for (const block of event.message?.content || []) {
          if (block.type !== "tool_result") continue;
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          if (block.is_error || /read-only file system|\bEROFS\b/i.test(text)) {
            toolFailures.push(text.slice(0, 500));
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
    child.once("error", (error) => {
      spawnError = error.code || error.name;
      finish(127);
    });
    child.once("close", (code) => finish(code ?? 1));
  });
  finished = true;

  const scratchProbes = findNamed(scratch, "probe.txt");
  const scratchContent = scratchProbes.length === 1 ? fs.readFileSync(scratchProbes[0], "utf8") : null;
  const outputContent = fs.existsSync(outputProbe) ? fs.readFileSync(outputProbe, "utf8") : null;
  const evidence = [
    `CLI=${CLI}`,
    `exit=${outcome.code}`,
    `spawnError=${outcome.spawnError}`,
    `timedOut=${outcome.timedOut}`,
    `resultError=${outcome.resultError}`,
    `stderrBytes=${outcome.stderrBytes}`,
    `scratchProbes=${scratchProbes.length}`,
    `scratchContent=${JSON.stringify(scratchContent)}`,
    `outputContent=${JSON.stringify(outputContent)}`,
    `toolFailures=${JSON.stringify(outcome.toolFailures)}`,
  ].join("; ");

  assert.equal(outcome.timedOut, false, evidence);
  assert.equal(outcome.spawnError, null, evidence);
  assert.equal(outcome.resultError, false, evidence);
  assert.equal(outcome.code, 0, evidence);
  assert.equal(scratchProbes.length, 1, evidence);
  assert.equal(scratchContent, "scratch-ok", evidence);
  assert.equal(outputContent, "output-ok", evidence);
  assert.deepEqual(outcome.toolFailures, [], evidence);
  t.diagnostic(evidence);
});
