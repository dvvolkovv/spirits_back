// Живой гейт выбранного Claude CLI. По умолчанию не обращается ни к CLI, ни к
// пользовательским каталогам. Включается только явной переменной на relay-host.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildSandboxSettings, buildCliEnv } from "./sandbox-policy.mjs";
import { ensureSessionDirs } from "./paths.mjs";
import { RUN_ENV, runTag } from "./proc-reaper.mjs";
import { runCliProbe, readExpectedProbe, cleanupLiveProbe } from "./sandbox-write-live-lib.mjs";

const LIVE = process.env.RELAY_LIVE_CLI_WRITE_TEST === "1";
const CLI = process.env.RELAY_CLAUDE_BIN || "/opt/linkeon-agent/bin/claude";

test("CLI sandbox записывает и scratch, и output", {
  skip: LIVE ? false : "живой CLI test включается только RELAY_LIVE_CLI_WRITE_TEST=1",
  timeout: 180_000,
}, async (t) => {
  const fsKey = randomUUID().replaceAll("-", "");
  const tag = runTag(randomUUID());
  const scratch = `/tmp/agent-scratch/${fsKey}`;
  const output = `/tmp/agent-output/${fsKey}`;
  const outputProbe = path.join(output, "probe.txt");
  let child = null;

  t.after(async () => {
    const errors = await cleanupLiveProbe({ child, tag, scratch, output, graceMs: 25 });
    assert.deepEqual(errors, [], `cleanup=${JSON.stringify(errors)}`);
  });

  await ensureSessionDirs(fsKey);
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
  childEnv[RUN_ENV] = tag;
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

  const outcome = await runCliProbe({
    cli: CLI,
    args,
    prompt,
    env: childEnv,
    tag,
    onChild: (spawned) => { child = spawned; },
    timeoutMs: 120_000,
    killWaitMs: 100,
    reapGraceMs: 25,
  });
  const scratchProbe = readExpectedProbe(scratch, "probe.txt", "scratch-ok");
  const outputResult = readExpectedProbe(output, "probe.txt", "output-ok");
  const evidence = [
    `CLI=${CLI}`,
    `exit=${outcome.code}`,
    `signal=${outcome.signal}`,
    `spawnError=${outcome.spawnError}`,
    `stdinError=${outcome.stdinError}`,
    `timedOut=${outcome.timedOut}`,
    `gotResult=${outcome.gotResult}`,
    `resultSuccess=${outcome.resultSuccess}`,
    `resultError=${outcome.resultError}`,
    `apiErrorStatus=${outcome.apiErrorStatus}`,
    `protocolError=${outcome.protocolError}`,
    `stderrBytes=${outcome.stderrBytes}`,
    `scratch=${JSON.stringify(scratchProbe)}`,
    `output=${JSON.stringify(outputResult)}`,
    `toolFailures=${JSON.stringify(outcome.toolFailures)}`,
    `toolFailuresDropped=${outcome.toolFailuresDropped}`,
    `cleanupErrors=${JSON.stringify(outcome.cleanupErrors)}`,
  ].join("; ");

  assert.equal(outcome.timedOut, false, evidence);
  assert.equal(outcome.spawnError, null, evidence);
  assert.equal(outcome.stdinError, null, evidence);
  assert.equal(outcome.gotResult, true, evidence);
  assert.equal(outcome.resultSuccess, true, evidence);
  assert.equal(outcome.resultError, false, evidence);
  assert.equal(outcome.apiErrorStatus, null, evidence);
  assert.equal(outcome.protocolError, false, evidence);
  assert.equal(outcome.code, 0, evidence);
  assert.equal(scratchProbe.ok, true, evidence);
  assert.equal(outputResult.ok, true, evidence);
  assert.deepEqual(outcome.toolFailures, [], evidence);
  assert.equal(outcome.toolFailuresDropped, 0, evidence);
  assert.deepEqual(outcome.cleanupErrors, [], evidence);
  t.diagnostic(evidence);
});
