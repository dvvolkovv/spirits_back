# Единый анализ документов в релее Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Исключить параллельный повторный анализ вложений и ожидание субагентов через `sleep`, сохранив полный последовательный разбор документа основной моделью.

**Architecture:** Реальный Express-хендлер `relay-agent/server.mjs` после успешного принятия файла добавляет `Agent` в `--disallowedTools` и дополняет системный промпт правилами одного анализа. Общие правила против дублирования и восстановления после `Unknown skill` применяются ко всем ходам; текстовые задачи без новых вложений сохраняют доступ к `Agent`.

**Tech Stack:** Node.js 22, Express, Multer, Claude Code CLI 2.1.280, `node:test`, production probe через локальный HTTP релея и синтетический PDF ReportLab.

---

## Карта файлов

- `relay-agent/server.mjs` — production-правка хендлера: выбор append-файла по `hasNewUploads`, список `--disallowedTools`, injectable `renameSync` для проверки неуспешного принятия файла.
- `relay-agent/document-analysis-rules.txt` — статические общие правила, подключаемые через `--append-system-prompt-file`.
- `relay-agent/document-analysis-rules-upload.txt` — полный базовый блок плюс upload-правила; tracked static file, не per-turn временный файл.
- `relay-agent/server-sandbox.test.mjs` — integration-тесты реального хендлера с подменённым `spawn`: upload/text, retry/fallback, MCP-reset, неуспешное переименование и граница argv.
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

- [x] **Step 1: Проверить исходную ветку и состав изменений**

```bash
git status --short --branch
git log -3 --oneline
```

Expected: ветка `fix/relay-single-document-analysis`; среди последних коммитов спецификация `5fca85e5` и коммит этого плана; untracked/изменённых production-файлов нет.

- [x] **Step 2: Отправить точный baseline на ноду и прогнать все relay-тесты**

```bash
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npm ci && cd ~/ci/spirits_back/relay-agent && node --test *.test.mjs"
```

Expected: `fail 0`. Записать в журнал выполнения `pass`, `fail` и длительность как baseline; любой уже существующий красный тест остановить и разобрать отдельно, не маскируя его новой правкой.

### Task 1: Красные тесты upload/text политики

**Files:**
- Test: `relay-agent/server-sandbox.test.mjs:404-459`

- [x] **Step 1: Добавить красный тест запрета `Agent` на ходе с вложением**

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

- [x] **Step 2: Добавить красный тест общего промпта без глобального запрета `Agent`**

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

- [x] **Step 3: Закоммитить только тесты и доказать красный результат на точном SHA**

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

- [x] **Step 1: Добавить две константы правил после `SYSTEM_PROMPT`**

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

- [x] **Step 2: Ввести `hasNewUploads` после фактического принятия файлов**

Непосредственно перед `let prompt = "";` добавить:

```js
const hasNewUploads = renamedFiles.length > 0;
```

Заменить следующий `if (renamedFiles.length > 0) {` на:

```js
if (hasNewUploads) {
```

- [x] **Step 3: Сохранять общие правила и при MCP-fallback**

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

- [x] **Step 4: Добавить upload-правила и собрать запрещённые инструменты списком**

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

- [x] **Step 5: Прогнать два новых теста и весь integration-файл**

```bash
git add relay-agent/server.mjs
git commit -m "fix(relay): один анализатор для новых вложений" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: `fail 0`; upload on/off и text-тест PASS. Если MCP-reset теряет общие правила, не добавлять вторую копию константы в catch — использовать только `baseSystemPrompt()` из Step 3.

### Task 2A: Обязательное исправление quality review — правила через static append-file

**Почему изменился механизм:** первоначальные inline-шаги Task 2 дали 24/24, но quality reviewer нашёл `E2BIG` у верхней границы argv. Красный boundary-коммит `0a2f8321` подтвердил 131 826 байт вместо допустимых 131 071. Выполненный финальный вариант ниже заменяет inline-константы `DOCUMENT_ANALYSIS_RULES`/`UPLOAD_ANALYSIS_RULES` и `baseSystemPrompt()` из первоначальных шагов Task 2. Остальные требования Task 2 не изменились.

**Files:**
- Create: `relay-agent/document-analysis-rules.txt`
- Create: `relay-agent/document-analysis-rules-upload.txt`
- Modify: `relay-agent/server.mjs`
- Test: `relay-agent/server-sandbox.test.mjs`

- [x] **Step 1: Сохранить общие правила в статический базовый файл**

`document-analysis-rules.txt` содержит две строки общих правил (без JS-обёртки):

```text
ДОКУМЕНТЫ И СУБАГЕНТЫ. Не поручай Agent повторный анализ документа, который основная модель уже анализирует или собирается анализировать в этом ходе. Не запускай два параллельных полных разбора одного документа. Не используй Bash sleep для ожидания субагентов.
UNKNOWN SKILL. Если Skill вернул Unknown skill, продолжай задачу доступными Read/Bash: не повторяй тот же вызов, не перебирай другие skills и не перепланируй уже доступную работу.
```

- [x] **Step 2: Собрать upload-файл без расхождения базового блока**

`document-analysis-rules-upload.txt` начинается с полного содержимого базового файла и добавляет:

```text
АНАЛИЗ НОВОГО ВЛОЖЕНИЯ. Agent недоступен: весь запрошенный анализ выполняет основная модель. Для полного разбора читай документ последовательно частями до покрытия всего документа. Для точечного вопроса сначала определи необходимые разделы, без автоматического полного повторного чтения. Если Read отклонил порцию из-за лимита 25 000 токенов, уменьши размер порции и не повторяй тот же объём. Не используй Bash sleep для ожидания субагентов.
```

Тест читает оба файла и требует `upload.startsWith(base)`.

- [x] **Step 3: Вернуть прежний inline-промпт и выбрать append-файл**

В `server.mjs` восстановлены `applySandboxPrompt(SYSTEM_PROMPT, sbxOn)` при инициализации и в MCP catch. В `args` после `"--system-prompt", systemPrompt` добавлено:

```js
"--append-system-prompt-file", path.join(
  HERE,
  hasNewUploads ? "document-analysis-rules-upload.txt" : "document-analysis-rules.txt",
),
```

Временных per-turn prompt-файлов нет. `hasNewUploads`, `--disallowedTools` и `--system-prompt-snapshot off` сохранены.

- [x] **Step 4: Проверить границу реальным OS spawn и повторить integration-прогон**

Boundary-тест измеряет baseline `--system-prompt`, затем подставляет `reqSystemPrompt` так, чтобы прежний inline-аргумент был ровно 131 071 байт. Правила должны отсутствовать в argv и присутствовать в выбранном append-файле. Реальный вызов:

```js
const spawned = spawnSync('/bin/true', args);
assert.equal(spawned.error, undefined);
assert.equal(spawned.status, 0);
```

Красный прогон до fix: 25 tests / 24 pass / 1 fail, inline 131 826 байт. Финальный коммит `569cc3c53e7ee0775d600dab2262f3ccf6b6d2ac`: 26 tests / 26 pass / 0 fail / 473.156812 ms, inline ровно 131 071 байт. Spec и quality review финального варианта пройдены без issues.

### Task 3: Доказать, что непринятый файл не включает ограничение

**Files:**
- Modify: `relay-agent/server.mjs:570-585`
- Test: `relay-agent/server-sandbox.test.mjs`

- [x] **Step 1: Добавить красный тест неуспешного `renameSync`**

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

- [x] **Step 2: Закоммитить тест и доказать красный результат**

```bash
git add relay-agent/server-sandbox.test.mjs
git commit -m "test(relay): непринятый файл не меняет политику (красный)" -m "Co-Authored-By: Kimi Code <noreply@anthropic.com>"
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test server-sandbox.test.mjs"
```

Expected: новый тест FAIL: production вызывает глобальный `fs.renameSync`, поэтому файл принимается, `Agent` запрещён и `User uploaded files:` присутствует. Это доказывает, что тест действительно различает ветку `renamedFiles.length === 0`.

- [x] **Step 3: Перевести только upload-переименования на существующий `fileOps`**

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

- [x] **Step 4: Прогнать integration-тесты и закоммитить минимальную правку**

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

- [x] **Step 1: Разрешить upload-fixture выбирать fallback**

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

- [x] **Step 2: Добавить guard transient-retry для upload**

```js
test('server retry: upload-политика одинакова на обеих попытках', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    onSpawn(call, index) {
      seen.push({
        denied: arg(call.args, '--disallowedTools'),
        prompt: fs.readFileSync(arg(call.args, '--append-system-prompt-file'), 'utf8'),
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

- [x] **Step 3: Добавить guard запасного провайдера для upload**

```js
test('server fallback: upload-политика сохраняется у запасного провайдера', async (t) => {
  const seen = [];
  const f = await fixture(t, {
    fallback: true,
    onSpawn(call, index) {
      seen.push({
        denied: arg(call.args, '--disallowedTools'),
        prompt: fs.readFileSync(arg(call.args, '--append-system-prompt-file'), 'utf8'),
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

- [x] **Step 4: Добавить guard canary-upload**

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

- [x] **Step 5: Усилить существующий MCP partial-write тест**

В `server partial MCP write: безопасный fallback на base config` внутри `onSpawn` после проверки `empty-mcp.json` добавить:

```js
const prompt = fs.readFileSync(arg(call.args, '--append-system-prompt-file'), 'utf8');
assert.match(prompt, /Не поручай Agent повторный анализ документа/);
assert.match(prompt, /Unknown skill/);
```

- [x] **Step 6: Прогнать guard-тесты и закоммитить**

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

- [x] **Step 1: Проверить syntax и diff перед полным прогоном**

```bash
node --check relay-agent/server.mjs
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: syntax-check без вывода; `diff --check` без ошибок. Изменены только `relay-agent/server.mjs`, `relay-agent/server-sandbox.test.mjs`, `relay-agent/document-analysis-rules.txt`, `relay-agent/document-analysis-rules-upload.txt` и два документа этой задачи (spec/plan).

- [x] **Step 2: Прогнать все relay-тесты на ноде**

```bash
git push -u origin fix/relay-single-document-analysis
SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back/relay-agent && node --test *.test.mjs"
```

Expected: `fail 0`; число passed не ниже baseline плюс добавленные тесты. Сохранить в журнале выполнения точные `pass`, `fail`, `duration_ms` и `SHA`.

- [x] **Step 3: Проверить чистоту ветки и отсутствие выката**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: рабочее дерево чистое; коммиты относятся только к spec/plan и этой правке. Никаких `deploy-relay.sh`, `pm2 restart`, `ssh`-правок живого релея на этом этапе не выполнялось.

**Итог выполнения Task 5 (2026-11-12):** полный relay-набор фактически выполнен дважды. На последнем SHA production-изменений `4c74e8d7d2897242a413c03054dbfbc7406e6665` результат: `tests 197`, `pass 197`, `fail 0`, `duration_ms 1415.689249`. На документном SHA `56d3e59031ff6bfc5426a2fabbfe9eda99f93b97` результат: `tests 197`, `pass 197`, `fail 0`, `duration_ms 1412.406337`. Syntax-check и `git diff --check` прошли; состав diff ограничен шестью разрешёнными путями. Рабочее дерево перед документированием было чистым, коммиты относятся только к этой функции и её документации.

Последующий doc-only коммит не меняет relay-код и не может заранее содержать собственный SHA. Поэтому в документе зафиксированы последний проверенный кодовый SHA и фактический прогон на документном SHA `56d3e59031ff6bfc5426a2fabbfe9eda99f93b97`, а фактический финальный HEAD после этого документального уточнения указывается в отчёте controller'а. Деплой, PM2 restart и правки живого релея не выполнялись.

### Task 5A: Финальные замечания общего code review

- [x] **Retry/fallback:** теперь сравниваются также inline `--system-prompt`, путь и содержимое append-файла и `--system-prompt-snapshot`.
- [x] **Resumed upload:** второй multipart-ход той же сессии проверяет совместное наличие `--resume`, запрета `Agent`, upload append-файла и `snapshot off`.
- [x] **Unknown skill:** оба prompt-файла прямо разрешают другой локальный подход через `Read`/`Bash`; запрещено лишь новое планирование ради поиска другого Skill. Красный TDD-коммит `dbf0440c`: 31 tests / 30 pass / 1 fail, падение только новой формулировки. Зелёный коммит `344557d3`: 31/31, `duration_ms 557.824328`.
- [x] **Документация:** добавлены обязательный раздел «Соответствие концепции» с фактически прочитанным §2.5, resumed-upload guard и все шесть разрешённых путей в Expected Task 5.
- [x] **Полный прогон после исправлений:** `344557d3` — 198 tests / 198 pass / 0 fail, `duration_ms 1380.22466`. Production-логика не изменялась, Task 6 остаётся невыполненным, deploy/probe не выполнялись.

Последующий doc-only коммит этих итогов не меняет relay-код и не может заранее содержать собственный SHA; фактический финальный HEAD и повторный прогон на нём указываются в отчёте controller'а.

### Task 6: Живой probe — только после нового явного OK владельца и официального выката

**Gate:** не выполнять вместе с реализацией. Сначала владелец отдельно согласует выкат; выкат выполняется только `scripts/deploy-relay.sh` с фактическим BASE живого дерева и TARGET этой ветки. После успешного `/health` выполнить probe ниже.

**Files:**
- Create во временном каталоге релея: `synthetic-49.pdf` — без персональных данных
- Read only: `/home/dv/file-agent/sessions.json` и транскрипт изолированной probe-сессии

- [x] **Step 1: Создать 49-страничный PDF, выполнить ход и проверить результат**

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
  .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).find(Boolean);
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

**Фактический результат после выката `2c0bb70e`:** HTTP 200, `doneFailed: false`, `durationMs 13484`, `modelCalls 2`, `maxContext 46878`, `toolCounts { "Bash": 1 }`, `agentCallCount 0`, `waitingSleepCount 0`, `missingCodes []`. Все 49 контрольных кодов присутствуют. Содержимое ответа в журнал не записывалось.

- [x] **Step 2: Проверить текстовый ход без глобального запрета**

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
  .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).find(Boolean);
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

**Фактический результат:** HTTP 200, `doneFailed: false`, `durationMs 3426`, `answerChars 25`, `agentCalls 0`, `failReason: null`.

**Исправление runbook после первой попытки probe:** `relay-secrets` содержит комментарии, поэтому секрет выбирается только из непустых строк без ведущего `#`. Первая попытка до HTTP-запроса приняла комментарий за секрет и остановилась на `ByteString`; production-код и выкат были не при чём. Временный синтетический PDF удалён, повторные probe прошли.

- [x] **Step 3: Отчитаться без содержимого документа**

Указать: TARGET SHA, официальный выкат завершён, `/health` успешен, результаты обоих probe, `durationMs`, `modelCalls`, `maxContext`, отсутствие `Agent` и ожидательных `sleep`. Не утверждать ускорение без фактического сравнения с исходными 599 550 мс и не публиковать содержимое ответа.
