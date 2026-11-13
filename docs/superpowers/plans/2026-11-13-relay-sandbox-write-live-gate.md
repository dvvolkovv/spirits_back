# Relay Sandbox Write Live Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать реальную запись в scratch и output обязательным гейтом relay-выкатов и смены sandbox CLI, чтобы повторение `EROFS` на CLI `2.1.322` блокировало rollout до затрагивания пользователей.

**Architecture:** Обычный relay suite остаётся изолированным и бесплатным: новый live-тест по умолчанию пропускается. На relay-host он явно включается переменной среды, запускает выбранный native CLI с настоящими sandbox-настройками и проверяет содержимое двух изолированных probe-файлов. `sandbox-write-live-lib.mjs` отделяет bounded lifecycle, строгий NDJSON-протокол, безопасное чтение probe и cleanup; 19 детерминированных regression-тестов проверяют его без Claude. Статический Jest-guard фиксирует место живого гейта после unit suite, но до первого изменения живого relay-дерева, а также передачу prompt через stdin до ожидания outcome.

**Tech Stack:** Node.js 22 `node:test`, Jest для статического deploy-guard, Claude Code CLI `haiku`, существующие `sandbox-policy.mjs`/`paths.mjs`, Bash rollout scripts.

**Spec:** `docs/superpowers/specs/2026-11-13-relay-sandbox-write-live-gate-design.md`

**Isolated worktree:** `/Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate`  
**Branch:** `feat/relay-sandbox-write-live-gate`  
**Base:** `origin/main` = `f8b0828b76fa787f164a634f70d270b142e0063e`  
**CI clone:** `dv@85.192.61.231:~/ci/spirits_back-relay-sandbox-write-gate-20261113`

**Уже проверенная база:** на точном base SHA на test-ноде `node --test relay-agent/*.test.mjs` — 198 tests, 198 pass, 0 fail, 0 skipped.

## Обязательные ограничения

- Не запускать `npm ci`, Jest или полный relay suite на Mac. Только `node --check`, чтение и лёгкие локальные команды.
- Не копировать новые test/helper в `/home/dv/file-agent` вручную. Для RED/GREEN перед выкатом передавать `sandbox-write-live.test.mjs` и `sandbox-write-live-lib.mjs` tar-потоком через SSH stdin в уникальный `/tmp`-каталог; существующие `sandbox-policy.mjs`, `paths.mjs` и `proc-reaper.mjs` подключать symlink-ами из живого каталога. Временный каталог удалять через `trap`.
- Не переключать `/opt/linkeon-agent/bin/claude-runtime`: активный runtime остаётся `2.1.280`. Сохранённый `2.1.322` вызывается только явным абсолютным путём для RED.
- Не создавать и не снимать `/tmp/linkeon-relay-drain` во время RED/GREEN. Live-тест работает напрямую с CLI на уникальном `fs_key`, не через `/chat`.
- Не менять backend Agent SDK, product-runner, модели, промпты ассистентов или sandbox-настройки.
- Коммиты и push только в `feat/relay-sandbox-write-live-gate`. Push в `main`, merge и `deploy-relay.sh` — только после отдельного свежего разрешения владельца.
- Не использовать `PROD_ONLY`, `TEST_ONLY`, smoke-skip флаги или ручной restart.

## Карта файлов

- Create: `relay-agent/sandbox-write-live.test.mjs` — тонкий opt-in живой test выбранного CLI и двух файлов.
- Create: `relay-agent/sandbox-write-live-lib.mjs` — bounded CLI lifecycle, строгий NDJSON-parser, безопасное чтение probe и независимый cleanup.
- Create: `relay-agent/sandbox-write-live-lib.test.mjs` — 19 детерминированных regression-тестов без реального Claude.
- Create: `tests/scripts/deploy-relay-write-gate.test.js` — статический regression guard обязательного места live-gate в rollout и передачи prompt в helper.
- Modify: `scripts/deploy-relay.sh` — один вызов live-gate в staging до изменения живых файлов.
- Modify: `relay-agent/README.md` — обязательная команда для будущей смены runtime до снятия drain.
- Existing, не менять: `relay-agent/sandbox-policy.mjs`, `relay-agent/paths.mjs`, `relay-agent/proc-reaper.mjs`, `relay-agent/server.mjs`.

---

### Task 1: Красный статический guard места live-gate

**Files:**
- Create: `tests/scripts/deploy-relay-write-gate.test.js`
- Read: `scripts/deploy-relay.sh:300-310`

- [ ] **Step 1: Записать failing Jest test**

Создать `tests/scripts/deploy-relay-write-gate.test.js`:

```javascript
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy-relay.sh'), 'utf8');

describe('relay CLI sandbox write gate', () => {
  it('после обычного suite и до живых файлов запускает настоящую запись', () => {
    const unit = deploy.indexOf('node --test *.test.mjs');
    const live = deploy.indexOf('RELAY_LIVE_CLI_WRITE_TEST=1 node --test sandbox-write-live.test.mjs');
    const liveFiles = deploy.indexOf('\ncd ~/file-agent', unit);

    expect(unit).toBeGreaterThan(-1);
    expect(liveFiles).toBeGreaterThan(unit);
    expect(live).toBeGreaterThan(unit);
    expect(live).toBeLessThan(liveFiles);
  });

  it('README требует тот же живой test после смены runtime и до снятия drain', () => {
    const readme = fs.readFileSync(path.join(root, 'relay-agent', 'README.md'), 'utf8');
    const section = readme.indexOf('## Обязательная проверка записи при смене sandbox runtime');
    const command = readme.indexOf('RELAY_LIVE_CLI_WRITE_TEST=1', section);
    const beforeDrain = readme.indexOf('до снятия drain', section);

    expect(section).toBeGreaterThan(-1);
    expect(command).toBeGreaterThan(section);
    expect(beforeDrain).toBeGreaterThan(section);
  });

  it('live test отправляет prompt и закрывает stdin', () => {
    const source = fs.readFileSync(path.join(root, 'relay-agent', 'sandbox-write-live-lib.mjs'), 'utf8');
    const spawned = source.indexOf('child = spawnImpl(cli, args');
    const stdinHandler = source.indexOf('child.stdin.once("error"', spawned);
    const stdinEnd = source.indexOf('child.stdin.end(prompt);', spawned);
    const outcome = source.indexOf('mainTimer = setTimeout', spawned);

    expect(spawned).toBeGreaterThan(-1);
    expect(stdinHandler).toBeGreaterThan(spawned);
    expect(stdinEnd).toBeGreaterThan(stdinHandler);
    expect(stdinEnd).toBeLessThan(outcome);
  });
});
```

- [ ] **Step 2: Закоммитить красный guard**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate add tests/scripts/deploy-relay-write-gate.test.js
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate commit -m "test(relay): гейт живой записи в rollout (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 3: Запушить ветку и поставить CI clone на точный SHA**

Run локально:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate push -u origin feat/relay-sandbox-write-live-gate
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 fetch -q origin; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 checkout -q $SHA"
```

- [ ] **Step 4: Убедиться, что guard красный по отсутствию гейта и документации**

Run:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; npx jest tests/scripts/deploy-relay-write-gate.test.js --runInBand'
```

Expected: exit non-zero, `3 failed`: первая проверка имеет `live === -1`, вторая — `section === -1`; третья падает, потому что `relay-agent/sandbox-write-live-lib.mjs` ещё отсутствует либо нарушен порядок `spawn → stdin error handler → stdin.end → ожидание`. Это RED до реализации, не основание ослабить test.

---

### Task 2: Живой test реальной записи CLI

Это первичная версия входа. Перед Task 3 обязателен Task 2A: его regression-тесты сначала воспроизводят дефекты первичной версии, затем live test переводится на hardened helper.

**Files:**
- Create: `relay-agent/sandbox-write-live.test.mjs`
- Read: `relay-agent/sandbox-policy.mjs:62-125`
- Read: `relay-agent/paths.mjs`

- [ ] **Step 1: Создать opt-in live test**

Создать `relay-agent/sandbox-write-live.test.mjs` полностью:

```javascript
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
  child.stdin.end(prompt);
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
```

- [ ] **Step 2: Проверить синтаксис локально**

Run:

```bash
node --check /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate/relay-agent/sandbox-write-live.test.mjs
```

Expected: exit 0, no output.

- [ ] **Step 3: Закоммитить live test**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate add relay-agent/sandbox-write-live.test.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate commit -m "test(relay): живая запись CLI в scratch и output" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 4: Запушить и проверить default-skip на CI без вызова CLI**

Run локально:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate push origin feat/relay-sandbox-write-live-gate
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 fetch -q origin; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 checkout -q $SHA"
```

Run на test-ноде:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; RELAY_CLAUDE_BIN=/definitely/missing node --test relay-agent/sandbox-write-live.test.mjs'
```

Expected: exit 0; `tests 1`, `pass 0`, `fail 0`, `skipped 1`. Несуществующий `RELAY_CLAUDE_BIN` доказывает, что callback не запускает CLI без opt-in.

---

### Task 2A: Детерминированный hardening live test

Task 3 запрещён до завершения этого шага. Настоящий Claude и relay-host здесь не запускаются: regression-тесты используют fake child/process и только тестовый Node-процесс с потомком для bounded timeout.

**Files:**
- Create: `relay-agent/sandbox-write-live-lib.mjs`
- Create: `relay-agent/sandbox-write-live-lib.test.mjs`
- Modify: `relay-agent/sandbox-write-live.test.mjs`
- Modify: `tests/scripts/deploy-relay-write-gate.test.js`
- Read, не менять: `relay-agent/proc-reaper.mjs`

- [ ] **Step 1: Записать 19 failing regression-тестов**

Создать `relay-agent/sandbox-write-live-lib.test.mjs` с независимыми тестами следующих классов:

1. terminal `subtype=success`, `is_error=false` принимается из финального buffer без newline;
2. `error_max_turns` с `is_error=false` отклоняется;
3. само наличие `api_error_status` отклоняет result;
4. финальный `is_error=true` без newline не теряется;
5. malformed NDJSON даёт `protocol_error` даже рядом с success;
6. отсутствие terminal result не fail-open;
7. oversized line и oversized buffer ограничены и дают `protocol_error`;
8. top-level `tool_result` классифицирует EROFS без сохранения сырого output;
9. число `toolFailures` ограничено, сохраняются только kind/status/bytes;
10. timeout с реальным потомком, удерживающим stdout, завершается bounded и завершается `reap` дерева;
11. синхронный stdin EPIPE становится красным outcome без unhandled error;
12. child error не мешает kill/reap/destroy живого процесса;
13. regular probe с точным содержимым принимается без возврата содержимого;
14. symlink probe отклоняется;
15. symlink root отклоняется;
16. oversized probe отклоняется по размеру до чтения;
17. partial setup cleanup удаляет уже созданные dirs и вызывает reap;
18. удаление output выполняется даже после ошибки удаления scratch;
19. в live test `t.after` зарегистрирован до `ensureSessionDirs`.

Для timeout-теста использовать `timeoutMs: 250`, `killWaitMs: 10`, `reapGraceMs: 1` и внешний guard 2000 ms, чтобы родитель успел запустить потомка, а regression не зависел от `close`.

Закоммитить только тест:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate add relay-agent/sandbox-write-live-lib.test.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate commit -m "test(relay): regression для hardening live CLI (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate push origin feat/relay-sandbox-write-live-gate
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 fetch -q origin feat/relay-sandbox-write-live-gate; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 checkout -q $SHA"
ssh dv@85.192.61.231 'cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; node --test relay-agent/sandbox-write-live-lib.test.mjs'
```

Expected: exit non-zero, `tests 19`, `pass 0`, `fail 19`. До helper 18 тестов падают на его отсутствии, а порядок cleanup — на текущем live test.

- [ ] **Step 2: Реализовать helper минимальным refactor**

`relay-agent/sandbox-write-live-lib.mjs` экспортирует:

```javascript
export async function runCliProbe({
  cli, args, prompt, env, cwd = "/tmp", tag,
  spawnImpl = spawn, reapImpl = reap, onChild = null,
  timeoutMs = 120_000, killWaitMs = 100, reapGraceMs = 25,
  maxLineBytes = 64 * 1024, maxBufferBytes = 64 * 1024, maxFailures = 8,
});

export async function cleanupLiveProbe({
  child = null, tag, scratch, output,
  reapImpl = reap, graceMs = 25, rmSync = fs.rmSync,
});

export function readExpectedProbe(root, name, expected);
```

Обязательные инварианты:

- `env[RUN_ENV] = tag`, где tag получен через `runTag(randomUUID())`; `reap((candidate) => candidate === tag, { graceMs })` выполняется из `finally` на всех путях;
- основное завершение фиксируется по `exit`, не по `close`; kill/timeout имеют отдельное bounded ожидание `killWaitMs`, затем stdio уничтожаются;
- stdin error handler установлен до `child.stdin.end(prompt)`; prompt отправляется до создания main timer ожидания;
- результат success только при явном `type=result`, `subtype=success`, `is_error !== true` и отсутствии собственного свойства `api_error_status`;
- финальный buffer обрабатывается без newline; malformed/oversized/missing result остаются RED;
- поддерживаются top-level и вложенные `tool_result`; failure entries ограничены и не содержат raw output;
- probe root/file проходят `lstat`, symlink отклоняются, `realpath` обязан оставаться внутри root, размер обязан совпасть до чтения; возвращаются только `{ ok, status, size }`;
- cleanup scratch/output выполняется независимо, а ошибки возвращаются как классификации без произвольных сообщений.

Заменить первичный live test на тонкую оркестрацию: cleanup регистрируется до `ensureSessionDirs`, `tag=runTag(randomUUID())`, `childEnv[RUN_ENV]=tag`, затем вызываются `runCliProbe` и два `readExpectedProbe`. Assertions точного содержимого остаются внутри `readExpectedProbe`; diagnostics содержат только статусы/размеры и не содержат `scratchContent`/`outputContent`.

Static stdin guard в Task 1 читает helper и требует порядок `spawnImpl → stdin error handler → stdin.end → mainTimer`; два deploy/README assertions не меняются.

- [ ] **Step 3: Проверить синтаксис локально**

```bash
node --check /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate/relay-agent/sandbox-write-live-lib.mjs
node --check /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate/relay-agent/sandbox-write-live-lib.test.mjs
node --check /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate/relay-agent/sandbox-write-live.test.mjs
```

Expected: каждая команда exit 0, no output.

- [ ] **Step 4: Закоммитить fix и проверить GREEN на CI**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate add relay-agent/sandbox-write-live-lib.mjs relay-agent/sandbox-write-live-lib.test.mjs relay-agent/sandbox-write-live.test.mjs tests/scripts/deploy-relay-write-gate.test.js
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate commit -m "fix(relay): hardening живого CLI write test" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate push origin feat/relay-sandbox-write-live-gate
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 fetch -q origin feat/relay-sandbox-write-live-gate; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 checkout -q $SHA"
```

Focused regression:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; node --test relay-agent/sandbox-write-live-lib.test.mjs'
```

Expected: `tests 19`, `pass 19`, `fail 0`, `skipped 0`.

Static guard:

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; npx jest tests/scripts/deploy-relay-write-gate.test.js --runInBand'
```

Expected: stdin assertion PASS; два intentional RED для Task 4 остаются, итого `2 failed, 1 passed, 3 total`.

Default-skip:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; RELAY_CLAUDE_BIN=/definitely/missing node --test relay-agent/sandbox-write-live.test.mjs'
```

Expected: `tests 1`, `pass 0`, `fail 0`, `skipped 1`.

Полный relay suite на CI:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; node --test relay-agent/*.test.mjs'
```

Expected: `tests 218`, `pass 217`, `fail 0`, `skipped 1`.

---

### Task 3: Доказать RED на 2.1.322 и GREEN на 2.1.280

**Files:**
- Test: `relay-agent/sandbox-write-live.test.mjs`
- Test: `relay-agent/sandbox-write-live-lib.mjs`
- No live project files changed; оба новых файла существуют только в уникальном `/tmp`-каталоге на время команды.

- [ ] **Step 1: Запустить RED против сохранённого 2.1.322 через stdin**

Run из корня изолированного worktree:

```bash
tar -cf - -C relay-agent sandbox-write-live-lib.mjs sandbox-write-live.test.mjs | ssh -o BatchMode=yes dv@5.101.115.184 'set -e; tmp=$(mktemp -d /tmp/relay-live-gate.XXXXXX); trap "rm -rf $tmp" EXIT; tar -xf - -C "$tmp"; for module in sandbox-policy.mjs paths.mjs proc-reaper.mjs; do ln -s "/home/dv/file-agent/$module" "$tmp/$module"; done; cd "$tmp"; RELAY_LIVE_CLI_WRITE_TEST=1 RELAY_CLAUDE_BIN=/opt/linkeon-agent/bin/claude-runtime-2.1.322 node --test sandbox-write-live.test.mjs'
```

Expected: exit non-zero; failed assertion содержит `CLI=/opt/linkeon-agent/bin/claude-runtime-2.1.322`, `scratch={"ok":false,...}` и/или `output={"ok":false,...}`, а `toolFailures` содержит классификацию `{"kind":"EROFS",...}`. Сырой tool output и содержимое файлов в diagnostics отсутствуют. Это воспроизведение исходного дефекта новым test. Не менять assertion, чтобы получить зелёный результат.

- [ ] **Step 2: Запустить GREEN против активного 2.1.280 через stdin**

Run:

```bash
tar -cf - -C relay-agent sandbox-write-live-lib.mjs sandbox-write-live.test.mjs | ssh -o BatchMode=yes dv@5.101.115.184 'set -e; tmp=$(mktemp -d /tmp/relay-live-gate.XXXXXX); trap "rm -rf $tmp" EXIT; tar -xf - -C "$tmp"; for module in sandbox-policy.mjs paths.mjs proc-reaper.mjs; do ln -s "/home/dv/file-agent/$module" "$tmp/$module"; done; cd "$tmp"; RELAY_LIVE_CLI_WRITE_TEST=1 RELAY_CLAUDE_BIN=/opt/linkeon-agent/bin/claude-runtime-2.1.280 node --test sandbox-write-live.test.mjs'
```

Expected: exit 0; `tests 1`, `pass 1`, `fail 0`, `skipped 0`; diagnostic содержит `gotResult=true`, `resultSuccess=true`, `scratch={"ok":true,"status":"ok","size":10}`, `output={"ok":true,"status":"ok","size":9}`, `toolFailures=[]` и `cleanupErrors=[]`.

- [ ] **Step 3: Убедиться, что проверки не изменили активный runtime и admission**

Run:

```bash
ssh -o BatchMode=yes dv@5.101.115.184 'set -e; test ! -e /tmp/linkeon-relay-drain; test "$(readlink /opt/linkeon-agent/bin/claude-runtime)" = "claude-runtime-2.1.280"; /opt/linkeon-agent/bin/claude-runtime --version; curl -fsS --max-time 5 http://127.0.0.1:3033/health'
```

Expected: `2.1.280 (Claude Code)`, health HTTP 200 с числовым `inflight`, drain отсутствует.

---

### Task 4: Встроить обязательный гейт в rollout и runtime-runbook

**Files:**
- Modify: `scripts/deploy-relay.sh:302-308`
- Modify: `relay-agent/README.md`
- Test: `tests/scripts/deploy-relay-write-gate.test.js`

- [ ] **Step 1: Добавить одну строку live-gate после обычного suite**

В `scripts/deploy-relay.sh` заменить:

```bash
node --test *.test.mjs

cd ~/file-agent
```

на:

```bash
node --test *.test.mjs
RELAY_LIVE_CLI_WRITE_TEST=1 node --test sandbox-write-live.test.mjs

cd ~/file-agent
```

Никаких `|| true`, skip-флага или fallback у этой строки быть не должно: `set -euo pipefail` останавливает rollout до `cd ~/file-agent` и до изменения живых файлов.

- [ ] **Step 2: Добавить обязательную команду в relay README**

Добавить в `relay-agent/README.md` после раздела «Правка и официальный выкат» новый раздел целиком:

````markdown
## Обязательная проверка записи при смене sandbox runtime

Любой rollout нового `/opt/linkeon-agent/bin/claude-runtime` обязан после атомарного переключения и **до снятия drain** запустить живой test записи:

```bash
RELAY_LIVE_CLI_WRITE_TEST=1 \
RELAY_CLAUDE_BIN=/opt/linkeon-agent/bin/claude \
node --test /home/dv/file-agent/sandbox-write-live.test.mjs
```

Тест создаёт уникальный `fs_key` и проверяет точное содержимое probe-файла и в scratch (`$TMPDIR`), и в `/tmp/agent-output/<fs_key>`. Он не использует `/chat`, поэтому работает при закрытом admission и не затрагивает пользовательские сессии.

Красный результат запрещает открывать admission: вернуть прежний сохранённый runtime, проверить его `--version` и `/health`, затем снять drain. Нельзя заменять эту проверку чтением sandbox-настроек или прогоном только unit-тестов: CLI 2.1.322 при корректных настройках возвращал `EROFS` для обоих разрешённых каталогов. Sandbox не отключать и не ослаблять.

Тот же гейт уже встроен в `scripts/deploy-relay.sh` после обычного `node --test *.test.mjs` и до изменения живых файлов. Сбой модели, авторизации или API также останавливает rollout; молча пропускать живой test нельзя.
````

- [ ] **Step 3: Проверить синтаксис deploy script**

Run:

```bash
bash -n /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate/scripts/deploy-relay.sh
```

Expected: exit 0, no output.

- [ ] **Step 4: Закоммитить rollout-gate и документацию**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate add scripts/deploy-relay.sh relay-agent/README.md
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate commit -m "test(relay): обязательная живая запись перед выкатом" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 5: Запушить и получить зелёный static guard на CI**

Run локально:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate push origin feat/relay-sandbox-write-live-gate
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 fetch -q origin; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 checkout -q $SHA"
```

Run на test-ноде:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; npx jest tests/scripts/deploy-relay-write-gate.test.js tests/scripts/deploy-relay-drain.test.js tests/scripts/deploy-relay-early-lock.test.js --runInBand'
```

Expected: все три файла PASS, `0 failed`; новый guard — `3 passed`.

---

### Task 5: Полная проверка ветки и review без выката

**Files:**
- Verify all changed files; no runtime changes.

- [ ] **Step 1: Запустить полный relay suite на точном SHA**

Push последний commit и поставить CI clone на его SHA:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate push origin feat/relay-sandbox-write-live-gate
FINAL_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 fetch -q origin; git -C ~/ci/spirits_back-relay-sandbox-write-gate-20261113 checkout -q $FINAL_SHA"
```

Затем:

```bash
ssh dv@85.192.61.231 'set -e; cd ~/ci/spirits_back-relay-sandbox-write-gate-20261113; source ~/.nvm/nvm.sh; node --test relay-agent/*.test.mjs'
```

Expected: `tests 218`, `pass 217`, `fail 0`, `skipped 1`. Единственный skip — `CLI sandbox записывает и scratch, и output` без `RELAY_LIVE_CLI_WRITE_TEST=1`; 198 baseline-тестов и 19 deterministic hardening regression-тестов остаются зелёными.

- [ ] **Step 2: Проверить diff и чистоту дерева**

Run локально:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate diff --check origin/main...HEAD
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate status --short --branch
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate diff --stat origin/main...HEAD
```

Expected: `diff --check` без вывода; worktree clean; diff содержит только `relay-agent/sandbox-write-live-lib.mjs`, `relay-agent/sandbox-write-live-lib.test.mjs`, `relay-agent/sandbox-write-live.test.mjs`, `tests/scripts/deploy-relay-write-gate.test.js`, `scripts/deploy-relay.sh`, `relay-agent/README.md`, approved spec и этот plan.

- [ ] **Step 3: Выполнить code review**

Использовать `superpowers:requesting-code-review`. Review обязано отдельно проверить:

- без opt-in невозможно случайно запустить CLI;
- завершение фиксируется по `exit`; timeout и child/stdin errors имеют bounded kill/reap/destroy на всех путях, включая потомка с унаследованными fd;
- terminal result обязан быть явным success; `error_max_turns`, `api_error_status`, malformed/oversized NDJSON и отсутствие result остаются RED;
- probe root/file не следуют symlink, regular file и точный размер проверяются до чтения, diagnostics не содержат содержимое;
- child завершается по timeout и собственные probe-каталоги удаляются даже при assertion/partial setup failure;
- `EROFS` и отсутствие любого из двух файлов делают test красным; failure count ограничен, raw tool output не сохраняется;
- deploy gate находится до первого изменения живых файлов и не имеет bypass;
- нет чтения/вывода секретов, пользовательских документов или системного промпта;
- активный runtime и sandbox-политика не изменены.

Исправить подтверждённые замечания отдельным TDD-циклом и повторить Steps 1–2.

- [ ] **Step 4: Остановиться перед интеграцией и запросить разрешение**

Сообщить владельцу RED/GREEN evidence, результаты suite/review и `FINAL_SHA`. Не выполнять merge/push в `main` и не запускать `deploy-relay.sh` без нового явного разрешения непосредственно перед этими действиями.

После отдельного разрешения интеграция выполняется из свежего `origin/main` без чужих изменений. Штатный выкат:

```bash
bash /Users/dmitry/Downloads/spirits_back/.worktrees/relay-sandbox-write-live-gate/scripts/deploy-relay.sh "$LIVE_BASE_SHA" "$TARGET_SHA"
```

`LIVE_BASE_SHA` определяется непосредственно перед выкатом по содержимому живого relay, а не копируется вслепую из этого плана. Сам выкат обязан запустить новый live-gate на активном `2.1.280`; красный результат останавливает процесс до замены живого дерева.
