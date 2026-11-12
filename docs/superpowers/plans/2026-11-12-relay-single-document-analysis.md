# Единый анализ документов в релее Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Исключить параллельный повторный анализ вложений и ожидание субагентов через `sleep`, сохранив полный последовательный разбор документа основной моделью.

**Architecture:** Реальный Express-хендлер `relay-agent/server.mjs` после успешного принятия файла добавляет `Agent` в `--disallowedTools` и дополняет системный промпт правилами одного анализа. Общие правила против дублирования и восстановления после `Unknown skill` применяются ко всем ходам; текстовые задачи без новых вложений сохраняют доступ к `Agent`.

**Tech Stack:** Node.js 22, Express, Multer, Claude Code CLI 2.1.280, `node:test`, production probe через локальный HTTP релея и синтетический PDF ReportLab.

---

## Карта файлов

- `relay-agent/server.mjs` — единственная production-правка: общие правила анализа, upload-правила, список `--disallowedTools`, injectable `renameSync` для проверки неуспешного принятия файла.
- `relay-agent/server-sandbox.test.mjs` — integration-тесты реального хендлера с подменённым `spawn`: upload/text, retry/fallback, MCP-reset, неуспешное переименование.
- `docs/superpowers/specs/2026-11-12-relay-single-document-analysis-design.md` — одобренная спецификация; менять только при изменении самого дизайна.
- `docs/superpowers/plans/2026-11-12-relay-single-document-analysis.md` — этот план и фактические отметки выполнения.

Новых production-модулей, фронтенд-правок, миграций и изменений API нет.

## Команды прогонов на тестовой ноде

Во всех задачах используется один и тот же порядок. Команда выполняется из `/Users/dmitry/Downloads/spirits_back`, если другой каталог не указан явно.

```bash
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Ожидаемый CI-клон — `~/ci/spirits_back`, никогда не `~/spirits_back`. Каждый прогон ставится на конкретный `SHA` текущего коммита. Для полного набора последняя команда заменяется на `node --test *.test.mjs`.

### Task 0: Зафиксировать зелёную базу

**Files:**
- Test: `relay-agent/server-sandbox.test.mjs` — без правок в этой задаче
- Test: `relay-agent/*.test.mjs` — полный baseline

- [ ] **Step 1: Проверить исходную ветку и состав изменений**

```bash
git status --short --branch
git log -3 --oneline
```

Expected: ветка `fix/relay-single-document-analysis`; среди последних коммитов спецификация `5fca85e5` и коммит этого плана; untracked/изменённых production-файлов нет.

- [ ] **Step 2: Отправить точный baseline на ноду и прогнать все relay-тесты**

```bash
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npm ci && cd ~/ci/spirits_back/relay-agent && node --test *.test.mjs"
```

Expected: `fail 0`. Записать в журнал выполнения `pass`, `fail` и длительность как baseline; любой уже существующий красный тест остановить и разобрать отдельно, не маскируя его новой правкой.

### Task 1: Красные тесты upload/text политики

**Files:**
- Test: `relay-agent/server-sandbox.test.mjs:404-459`

- [ ] **Step 1: Добавить красный тест запрета `Agent` на ходе с вложением**

Добавить после существующих upload-тестов:

```js
for (const mode of ['on', 'off']) {
  test(`server ${mode}: новое вложение запрещает Agent и задаёт один последовательный анализ`, async (t) => {
    const f = await fixture(t, { mode });
    const { response } = await f.requestUpload([
      { name: 'policy.pdf', body: 'synthetic-pdf-body' },
    ]);
    assert.equal(response.status, 200);
    assert.equal(f.calls.length, 1);

    const denied = arg(f.calls[0].args, '--disallowedTools').split(',');
    assert.ok(denied.includes('Agent'));
    assert.equal(denied.includes('WebFetch'), mode === 'on', 'прежнее sandbox-правило WebFetch не изменилось');
    assert.equal(arg(f.calls[0].args, '--system-prompt-snapshot'), 'off');

    const prompt = arg(f.calls[0].args, '--system-prompt');
    assert.match(prompt, /Agent недоступен: весь запрошенный анализ выполняет основная модель/);
    assert.match(prompt, /для полного разбора читай документ последовательно частями/i);
    assert.match(prompt, /25 000 токенов/);
    assert.match(prompt, /Не используй Bash sleep для ожидания субагентов/);
  });
}
```

- [ ] **Step 2: Добавить красный тест общего промпта без глобального запрета `Agent`**

Добавить рядом:

```js
test('server off: текстовый ход сохраняет Agent и получает общие правила без дублирования', async (t) => {
  const f = await fixture(t, { mode: 'off' });
  const { response } = await f.request();
  assert.equal(response.status, 200);

  const denied = arg(f.calls[0].args, '--disallowedTools').split(',');
  assert.equal(denied.includes('Agent'), false);
  assert.ok(denied.includes('ToolSearch'));
  assert.equal(denied.includes('WebFetch'), false);

  const prompt = arg(f.calls[0].args, '--system-prompt');
  assert.match(prompt, /Не поручай Agent повторный анализ документа/);
  assert.match(prompt, /Не используй Bash sleep для ожидания субагентов/);
  assert.match(prompt, /Unknown skill/);
  assert.match(prompt, /не перебирай другие skills/);
});
```

- [ ] **Step 3: Закоммитить только тесты и доказать красный результат на точном SHA**

```bash
git add relay-agent/server-sandbox.test.mjs
git commit -m "test(relay): один анализатор вложений (красный)" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: FAIL в трёх новых тестах. В upload on/off `denied.includes('Agent')` сейчас false; в text-тесте общие фразы отсутствуют. Существующие тесты не должны стать причиной нового красного результата.

### Task 2: Минимальная production-реализация

**Files:**
- Modify: `relay-agent/server.mjs:167-169`
- Modify: `relay-agent/server.mjs:570-595`
- Modify: `relay-agent/server.mjs:633-711`
- Modify: `relay-agent/server.mjs:748-769`
- Test: `relay-agent/server-sandbox.test.mjs`

- [ ] **Step 1: Добавить две константы правил после `SYSTEM_PROMPT`**

Вставить сразу после закрывающего шаблон `SYSTEM_PROMPT` и перед `const sessionMap = new Map();`:

```js
const DOCUMENT_ANALYSIS_RULES = `
ДОКУМЕНТЫ И СУБАГЕНТЫ. Не поручай Agent повторный анализ документа, который основная модель уже анализирует или собирается анализировать в этом ходе. Не запускай два параллельных полных разбора одного документа. Не используй Bash sleep для ожидания субагентов.
UNKNOWN SKILL. Если Skill вернул Unknown skill, продолжай задачу доступными Read/Bash: не повторяй тот же вызов, не перебирай другие skills и не перепланируй уже доступную работу.
`;

const UPLOAD_ANALYSIS_RULES = `
АНАЛИЗ НОВОГО ВЛОЖЕНИЯ. Agent недоступен: весь запрошенный анализ выполняет основная модель. Для полного разбора читай документ последовательно частями до покрытия всего документа. Для точечного вопроса сначала определи необходимые разделы, без автоматического полного повторного чтения. Если Read отклонил порцию из-за лимита 25 000 токенов, уменьши размер порции и не повторяй тот же объём. Не используй Bash sleep для ожидания субагентов.
`;
```

- [ ] **Step 2: Ввести `hasNewUploads` после фактического принятия файлов**

Непосредственно перед `let prompt = "";` добавить:

```js
const hasNewUploads = renamedFiles.length > 0;
```

Заменить следующий `if (renamedFiles.length > 0) {` на:

```js
if (hasNewUploads) {
```

- [ ] **Step 3: Сохранять общие правила и при MCP-fallback**

Заменить инициализацию `systemPrompt`:

```js
const baseSystemPrompt = () => applySandboxPrompt(
  `${SYSTEM_PROMPT}\n\n${DOCUMENT_ANALYSIS_RULES}`,
  sbxOn,
);
let systemPrompt = baseSystemPrompt();
```

В catch восстановления базового MCP заменить `systemPrompt = applySandboxPrompt(SYSTEM_PROMPT, sbxOn);` на:

```js
systemPrompt = baseSystemPrompt();
```

- [ ] **Step 4: Добавить upload-правила и собрать запрещённые инструменты списком**

Сразу после `if (reqSystemPrompt) systemPrompt += "\n\n" + reqSystemPrompt;` вставить:

```js
if (hasNewUploads) systemPrompt += `\n\n${UPLOAD_ANALYSIS_RULES}`;
const disallowedTools = [
  'mcp__plugin_telegram_telegram__reply',
  'mcp__plugin_telegram_telegram__react',
  'mcp__plugin_telegram_telegram__edit_message',
  'mcp__plugin_telegram_telegram__download_attachment',
  'ToolSearch',
  ...(sbxOn ? ['WebFetch'] : []),
  ...(hasNewUploads ? ['Agent'] : []),
].join(',');
```

В `args` заменить всю прежнюю строку `"--disallowedTools", "mcp__..." + ...` на:

```js
"--disallowedTools", disallowedTools,
```

- [ ] **Step 5: Прогнать два новых теста и весь integration-файл**

```bash
git add relay-agent/server.mjs
git commit -m "fix(relay): один анализатор для новых вложений" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: `fail 0`; upload on/off и text-тест PASS. Если MCP-reset теряет общие правила, не добавлять вторую копию константы в catch — использовать только `baseSystemPrompt()` из Step 3.

### Task 3: Доказать, что непринятый файл не включает ограничение

**Files:**
- Modify: `relay-agent/server.mjs:570-585`
- Test: `relay-agent/server-sandbox.test.mjs`

- [ ] **Step 1: Добавить красный тест неуспешного `renameSync`**

```js
test('server on: непринятый файл не включает запрет Agent', async (t) => {
  const fileOps = {
    ...fs,
    renameSync() {
      const err = new Error('rename denied by test');
      err.code = 'EACCES';
      throw err;
    },
  };
  const f = await fixture(t, { mode: 'on', fileOps });
  const { response } = await f.requestUpload([
    { name: 'not-accepted.pdf', body: 'synthetic-body' },
  ]);
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);

  const denied = arg(f.calls[0].args, '--disallowedTools').split(',');
  assert.equal(denied.includes('Agent'), false);
  assert.equal(f.calls[0].child.input.includes('User uploaded files:'), false);
});
```

- [ ] **Step 2: Закоммитить тест и доказать красный результат**

```bash
git add relay-agent/server-sandbox.test.mjs
git commit -m "test(relay): непринятый файл не меняет политику (красный)" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: новый тест FAIL: production вызывает глобальный `fs.renameSync`, поэтому файл принимается, `Agent` запрещён и `User uploaded files:` присутствует. Это доказывает, что тест действительно различает ветку `renamedFiles.length === 0`.

- [ ] **Step 3: Перевести только upload-переименования на существующий `fileOps`**

В двух местах хендлера заменить:

```js
fs.renameSync(f.path, newPath);
```

и

```js
fs.renameSync(f.path, fallback);
```

на:

```js
fileOps.renameSync(f.path, newPath);
```

и соответственно:

```js
fileOps.renameSync(f.path, fallback);
```

Не менять `fs.renameSync(tmp, SESSION_STORE_PATH)` в персисте сессий: тестируется только принятие вложений.

- [ ] **Step 4: Прогнать integration-тесты и закоммитить минимальную правку**

```bash
git add relay-agent/server.mjs
git commit -m "fix(relay): не включать запрет для непринятых файлов" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: `fail 0`; исходный Multer-temp по-прежнему удаляется существующим `finally`, а запрет включается только после успешного `renameSync`.

### Task 4: Защитить retry, fallback и MCP-reset

**Files:**
- Test: `relay-agent/server-sandbox.test.mjs:165-184`
- Test: `relay-agent/server-sandbox.test.mjs:254-350`

- [ ] **Step 1: Разрешить upload-fixture выбирать fallback**

Заменить сигнатуру и начало `requestUpload` на:

```js
const requestUpload = async (
  files,
  { sessionId = 'server-upload-session', fsKey = FS_KEY, noFallback = true } = {},
) => {
  const payload = new FormData();
  payload.append('message', 'test uploaded documents');
  payload.append('sessionId', sessionId);
  if (fsKey) payload.append('fs_key', fsKey);
  if (noFallback) payload.append('noFallback', '1');
```

Остаток helper (добавление файлов, `fetch`, возврат `{ response, text }`) оставить без изменений.

- [ ] **Step 2: Добавить guard transient-retry для upload**

```js
test('server retry: upload-политика одинакова на обеих попытках', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    onSpawn(call, index) {
      seen.push({
        denied: arg(call.args, '--disallowedTools'),
        prompt: arg(call.args, '--system-prompt'),
      });
      finishChild(call.child, index === 0
        ? [{ type: 'result', subtype: 'error', is_error: true, result: 'API Error: 500 Internal Server Error' }]
        : undefined);
    },
  });
  const { response } = await f.requestUpload([
    { name: 'retry.pdf', body: 'synthetic-retry-body' },
  ]);
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.ok(seen[0].denied.split(',').includes('Agent'));
});
```

- [ ] **Step 3: Добавить guard запасного провайдера для upload**

```js
test('server fallback: upload-политика сохраняется у запасного провайдера', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    fallback: true,
    onSpawn(call, index) {
      seen.push({
        denied: arg(call.args, '--disallowedTools'),
        prompt: arg(call.args, '--system-prompt'),
      });
      finishChild(call.child, index === 0
        ? [{ type: 'result', subtype: 'success', result: 'Not logged in' }]
        : undefined);
    },
  });
  const { response } = await f.requestUpload([
    { name: 'fallback.pdf', body: 'synthetic-fallback-body' },
  ], { noFallback: false });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.ok(seen[0].denied.split(',').includes('Agent'));
});
```

- [ ] **Step 4: Добавить guard canary-upload**

```js
test('server canary: перечисленная upload-сессия получает тот же запрет Agent', async (t) => {
  const f = await fixture(t, {
    mode: 'canary',
    canaryKeys: 'server-upload-session\n',
  });
  const { response } = await f.requestUpload([
    { name: 'canary.pdf', body: 'synthetic-canary-body' },
  ]);
  assert.equal(response.status, 200);
  const denied = arg(f.calls[0].args, '--disallowedTools').split(',');
  assert.ok(denied.includes('Agent'));
  assert.ok(denied.includes('WebFetch'));
});
```

- [ ] **Step 5: Усилить существующий MCP partial-write тест**

В `server partial MCP write: безопасный fallback на base config` внутри `onSpawn` после проверки `empty-mcp.json` добавить:

```js
const prompt = arg(call.args, '--system-prompt');
assert.match(prompt, /Не поручай Agent повторный анализ документа/);
assert.match(prompt, /Unknown skill/);
```

- [ ] **Step 6: Прогнать guard-тесты и закоммитить**

```bash
git add relay-agent/server-sandbox.test.mjs
git commit -m "test(relay): политика вложений на повторах и fallback" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: `fail 0`. Production-правка в этой задаче не нужна: она уже обеспечивает одинаковые `--disallowedTools` и `--system-prompt`; существующий `--model` продолжает зависеть от провайдера.

### Task 5: Полный прогон и проверка состава ветки

**Files:**
- Test: `relay-agent/*.test.mjs`
- Docs: `docs/superpowers/plans/2026-11-12-relay-single-document-analysis.md`

- [ ] **Step 1: Проверить syntax и diff перед полным прогоном**

```bash
node --check relay-agent/server.mjs
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: syntax-check без вывода; `diff --check` без ошибок. Изменены только `relay-agent/server.mjs`, `relay-agent/server-sandbox.test.mjs` и два документа этой задачи (spec/plan).

- [ ] **Step 2: Прогнать все relay-тесты на ноде**

```bash
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test *.test.mjs"
```

Expected: `fail 0`; число passed не ниже baseline плюс добавленные тесты. Сохранить в журнале выполнения точные `pass`, `fail`, `duration_ms` и `SHA`.

- [ ] **Step 3: Проверить чистоту ветки и отсутствие выката**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: рабочее дерево чистое; коммиты относятся только к spec/plan и этой правке. Никаких `deploy-relay.sh`, `pm2 restart`, `ssh`-правок живого релея на этом этапе не выполнялось.

### Task 6: Живой probe — только после нового явного OK владельца и официального выката

**Gate:** не выполнять вместе с реализацией. Сначала владелец отдельно согласует выкат; выкат выполняется только `scripts/deploy-relay.sh` с фактическим BASE живого дерева и TARGET этой ветки. После успешного `/health` выполнить probe ниже.

**Files:**
- Create во временном каталоге релея: `synthetic-49.pdf` — без персональных данных
- Read only: `/home/dv/file-agent/sessions.json` и транскрипт изолированной probe-сессии

- [ ] **Step 1: Создать 49-страничный PDF, выполнить ход и проверить результат**

Команда не печатает секрет и не выводит содержимое ответа. Она проверяет HTTP, `done.failed`, отсутствие `Agent`, отсутствие ожидательных `sleep`, наличие всех контрольных кодов и выводит только operational metadata.

```bash
ssh root@5.101.115.184 'set -euo pipefail
WORK=$(mktemp -d /tmp/relay-document-probe.XXXXXX)
SESSION_ID="relay-document-probe-$(date +%s)"
FS_KEY=$(openssl rand -hex 16)
export WORK SESSION_ID FS_KEY
/opt/linkeon-agent/venv/bin/python - <<"PY"
import os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

full = os.path.join(os.environ["WORK"], "synthetic-49.pdf")
pdf = canvas.Canvas(full, pagesize=A4)
for number in range(1, 50):
    pdf.drawString(72, 800, f"Synthetic document - page {number} of 49")
    pdf.drawString(72, 770, f"Control code CHECK-{number:02d}")
    pdf.drawString(72, 740, f"Page-specific synthetic marker: {number * 17}")
    pdf.showPage()
pdf.save()
PY
node --input-type=module <<"NODE"
import fs from "node:fs";

const startedAt = Date.now();
const secret = fs.readFileSync("/home/dv/file-agent/relay-secrets", "utf8")
  .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
if (!secret) throw new Error("relay secret is empty");

const form = new FormData();
const pdf = fs.readFileSync(`${process.env.WORK}/synthetic-49.pdf`);
form.append("files", new Blob([pdf], { type: "application/pdf" }), "synthetic-49.pdf");
form.append("message", "Прочитай все 49 страниц полностью. Для каждой страницы выпиши её контрольный код CHECK-NN и синтетический маркер. Не пропускай страницы. Не запускай других агентов или фоновых помощников.");
form.append("sessionId", process.env.SESSION_ID);
form.append("fs_key", process.env.FS_KEY);
form.append("noFallback", "1");

const response = await fetch("http://127.0.0.1:3033/chat", {
  method: "POST",
  headers: { "x-agent-secret": secret },
  body: form,
});
const raw = await response.text();
const durationMs = Date.now() - startedAt;
const events = raw.split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
  try { return [JSON.parse(line.slice(6))]; } catch { return []; }
});
const toolEvents = events.filter((event) => event.type === "tool");
const toolCounts = {};
for (const event of toolEvents) toolCounts[event.tool] = (toolCounts[event.tool] || 0) + 1;
const agentCalls = toolEvents.filter((event) => event.tool === "Agent");
const sleepWaits = toolEvents.filter((event) => {
  if (event.tool !== "Bash") return false;
  let input = {};
  try { input = JSON.parse(event.input || "{}"); } catch {}
  const command = String(input.command || "");
  return /^\s*sleep\s+/.test(command) && !/^\s*sleep\s+4(?:\.0)?\s*$/.test(command);
});
const done = events.filter((event) => event.type === "done").at(-1);
const answer = events.filter((event) => event.type === "result").map((event) => String(event.text || "")).join("\n");
const missingCodes = Array.from({ length: 49 }, (_, index) => `CHECK-${String(index + 1).padStart(2, "0")}`)
  .filter((code) => !answer.includes(code));

await new Promise((resolve) => setTimeout(resolve, 2200));
const sessions = JSON.parse(fs.readFileSync("/home/dv/file-agent/sessions.json", "utf8"));
const claudeSid = sessions[process.env.SESSION_ID];
let modelCalls = 0;
let maxContext = 0;
if (claudeSid) {
  const transcript = `/home/dv/.claude/projects/-tmp/${claudeSid}.jsonl`;
  const messageIds = new Set();
  for (const line of fs.readFileSync(transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (Date.parse(event.timestamp || 0) < startedAt || event.type !== "assistant" || !event.message) continue;
    messageIds.add(event.message.id || event.uuid);
    const usage = event.message.usage || {};
    const context = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    if (context > maxContext) maxContext = context;
  }
  modelCalls = messageIds.size;
}

const report = {
  httpStatus: response.status,
  durationMs,
  doneFailed: done?.failed === true,
  failReason: done?.failReason || null,
  toolCounts,
  agentCallCount: agentCalls.length,
  waitingSleepCount: sleepWaits.length,
  missingCodes,
  modelCalls,
  maxContext,
};
console.log(JSON.stringify(report, null, 2));
if (!response.ok || !done || done.failed === true || agentCalls.length || sleepWaits.length || missingCodes.length) process.exit(1);
NODE
rm -rf -- "$WORK" "/tmp/agent-uploads/$FS_KEY" "/tmp/agent-output/$FS_KEY" "/tmp/agent-scratch/$FS_KEY"
'
```

Expected PASS: `httpStatus: 200`, `doneFailed: false`, `agentCallCount: 0`, `waitingSleepCount: 0`, `missingCodes: []`. `durationMs`, `modelCalls`, `maxContext` записать в итоговый отчёт. Удаляются только случайные probe-каталоги; транскрипт остаётся для аудита.

- [ ] **Step 2: Проверить текстовый ход без глобального запрета**

Интеграционный тест Task 1 уже доказывает отсутствие глобального запрета. На живом релее выполнить обычный текстовый ход без файла; специально `Agent` не провоцировать.

```bash
ssh root@5.101.115.184 'set -euo pipefail
SESSION_ID="relay-text-probe-$(date +%s)"
FS_KEY=$(openssl rand -hex 16)
export SESSION_ID FS_KEY
node --input-type=module <<"NODE"
import fs from "node:fs";

const startedAt = Date.now();
const secret = fs.readFileSync("/home/dv/file-agent/relay-secrets", "utf8")
  .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
if (!secret) throw new Error("relay secret is empty");
const response = await fetch("http://127.0.0.1:3033/chat", {
  method: "POST",
  headers: { "content-type": "application/json", "x-agent-secret": secret },
  body: JSON.stringify({
    message: "Ответь коротко: текстовый канал работает.",
    sessionId: process.env.SESSION_ID,
    fs_key: process.env.FS_KEY,
    noFallback: "1",
  }),
});
const raw = await response.text();
const events = raw.split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
  try { return [JSON.parse(line.slice(6))]; } catch { return []; }
});
const done = events.filter((event) => event.type === "done").at(-1);
const answerChars = events.filter((event) => event.type === "result")
  .reduce((total, event) => total + String(event.text || "").length, 0);
const agentCalls = events.filter((event) => event.type === "tool" && event.tool === "Agent").length;
console.log(JSON.stringify({
  httpStatus: response.status,
  durationMs: Date.now() - startedAt,
  doneFailed: done?.failed === true,
  failReason: done?.failReason || null,
  answerChars,
  agentCalls,
}, null, 2));
if (!response.ok || !done || done.failed === true || answerChars === 0) process.exit(1);
NODE
rm -rf -- "/tmp/agent-uploads/$FS_KEY" "/tmp/agent-output/$FS_KEY" "/tmp/agent-scratch/$FS_KEY"
'
```

Expected: HTTP 200, `doneFailed: false`, `answerChars > 0`, `agentCalls: 0` для этого простого ответа, никаких новых ошибок политики. В итоговом отчёте зафиксировать длительность и SHA выкаченного релея.

- [ ] **Step 3: Отчитаться без содержимого документа**

Указать: TARGET SHA, официальный выкат завершён, `/health` успешен, результаты обоих probe, `durationMs`, `modelCalls`, `maxContext`, отсутствие `Agent` и ожидательных `sleep`. Не утверждать ускорение без фактического сравнения с исходными 599 550 мс и не публиковать содержимое ответа.
