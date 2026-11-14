# Codex-провайдер (GPT-6 Astra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить codex (OpenAI gpt-6-astra через подписку ChatGPT Pro) четвёртым запасным провайдером Linkeon — в цепочку Claude → Qwen → Kimi → Codex, в оба переключателя (личный и глобальный) и на прод-бэк с релеем.

**Architecture:** На каждом сервере поднимается локальный codex-bridge (`127.0.0.1:8790`) — переводчик Anthropic Messages ⇄ OpenAI Responses API, портированный с мака (`~/.linkeon/tools/`, 95/95 тестов). `ClaudeCliService` и релейный агент продолжают спавнить тот же `claude` CLI с подменой env (`ANTHROPIC_BASE_URL` на мост) — как для Qwen/Kimi. Мост аутентифицируется сам через `~/.codex/auth.json` (read-only); свежесть токена поддерживает официальный codex CLI по cron (keep-alive раз в ~3 дня), собственного refresh-кода нет нигде. В реестрах провайдер включается ключом-заглушкой `local-bridge`.

**Tech Stack:** Node.js (ESM, `node --test`) для моста и релея; NestJS/TypeScript + jest для бэка; React 18 + TypeScript + vitest для фронта; i18next (ru/en/pt); pm2; bash.

**Спек (источник истины):** `spirits_back/docs/superpowers/specs/2026-11-14-codex-provider-design.md`

---

## Контекст для инженера с нулевым контекстом

**Продукт.** my.linkeon.io — веб-приложение общения с AI-ассистентами. Бэкенд NestJS (`~/Downloads/spirits_back`, прод `dvolkov@212.113.106.202`, pm2 `linkeon-api`), фронт React (`~/Downloads/spirits_front`), релей-агент (`dv@5.101.115.184`, pm2 `file-agent`, живёт в `spirits_back/relay-agent/` и разворачивается в `/home/dv/file-agent/`), тестовая нода `dv@85.192.61.231` (CI-клоны в `~/ci/`).

**Как уже работают запасные провайдеры (Qwen, Kimi).** `ClaudeCliService` (бэк) и `relay-agent/llm-fallback.mjs` (релей) спавнят один и тот же `claude` CLI. Для запасного провайдера подменяется env: `ANTHROPIC_BASE_URL` (Anthropic-совместимый эндпоинт провайдера), `ANTHROPIC_AUTH_TOKEN` (ключ), `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. Реестры: `FALLBACK_ORDER`, `PROVIDER_DEFAULTS`, `PROVIDER_LABELS` в `src/common/services/llm-fallback.ts` (бэк) и `relay-agent/llm-fallback.mjs` (релей) — два файла, которые нужно держать в синхроне (комментарий в обоих об этом говорит). Наличие ключа в env (бэк) или в key-файле (релей) включает провайдера. Цепочка: Claude упал → по порядку `FALLBACK_ORDER` те, у кого есть конфиг и кто не «не отвечает». Плюс два переключателя: личный (админ выбирает модель для пользователя) и глобальный рубильник (админка, `admin-global-llm.controller.ts`).

**Чем codex отличается.** У OpenAI НЕТ Anthropic-совместимого эндпоинта, и API-ключа нет — есть подписка ChatGPT Pro (OAuth-токены в `~/.codex/auth.json`). Поэтому на каждом сервере нужен локальный мост `127.0.0.1:8790`, который принимает Anthropic Messages и ходит на `https://chatgpt.com/backend-api/codex/responses` (Responses API). Мост уже написан и обкатан на маке этим же днём (`~/.linkeon/tools/codex-bridge.mjs` + `codex-translate.mjs` + `codex-sse.mjs`, 39 тестов моста из 95 общих). Задача — перенести его в репозиторий `spirits_back/codex-bridge/` с тремя серверными диффами (уважать входящую модель; ретрай ровно раз при 401 с перечитыванием auth.json; Linux User-Agent) и зарегистрировать codex во всех реестрах/переключателях по образцу kimi.

**Решения владельца (окончательные, не пересматривать):**
1. Аутентификация — подписка ChatGPT Pro (как на маке), НЕ API-ключ OpenAI.
2. Аккаунт — текущий личный аккаунт владельца; ToS-риск принят осознанно.
3. Роль — паритет: цепочка (codex последним) + оба переключателя; операционное правило «глобальный рубильник на codex не ставится» → в UI у варианта Codex метка «только аварийно».
4. Архитектура B — bridge read-only (никакого собственного refresh-кода), свежесть токена поддерживает официальный codex CLI (одноразовый `codex login` на сервер + cron `codex exec` раз в ~3 дня).

**Ключ-заглушка.** Провайдер включается наличием ключа. Для codex ключ фиктивный: `CODEX_FALLBACK_API_KEY=local-bridge` (env бэка) / файл `/home/dv/file-agent/secrets/codex.key` со значением `local-bridge` (релей). Мост значение токена игнорирует. На тест-ноде ключ НЕ заводится сознательно — там цепочка остаётся Claude → Qwen → Kimi.

## Глобальные правила (читать перед КАЖДОЙ задачей)

1. **Никаких выкатов, ssh-изменений на прод/релей, pm2-рестартов и живых smoke во время задач T1–T13.** Задачи меняют только код в репозиториях. Выкат — отдельно, по runbook из задачи 13, только с явным OK владельца. Единственное исключение — ssh на тест-ноду `dv@85.192.61.231` для прогонов jest/tsc (read-only CI-клон `~/ci/spirits_back`).
2. **Репозитории публичные.** В код и коммиты не попадают: ключи, токены, номера телефонов, содержимое `~/.codex/auth.json`.
3. **`~/.codex/auth.json` на маке — только читать.** Никогда не запускать refresh токена с мака (сломает Codex-приложение и роутер 8788).
4. **Git.** Работа прямо в `main` (конвенция репо: красный тест коммитится в main сразу, фикс — следующим коммитом). В обоих репо параллельные сессии: перед коммитом `git status --porcelain` — в индексе не должно быть чужих файлов; `git branch --show-current` обязан быть `main` (никогда не коммитить в detached HEAD); перед пушем `git pull --rebase -q origin main`, пуш `git push -q origin main`. Треiler каждого коммита:
   ```
   Co-Authored-By: Claude Code <noreply@anthropic.com>
   ```
5. **Где что запускать.** `node --test` (мост, релей) и точечный `pnpm vitest run <файлы>` (фронт) — на маке можно; vitest под Node 22 (`nvm use 22`; Node 26 ломает jsdom). `npx jest` и `npx tsc` бэка — ТОЛЬКО на тест-ноде (мак не тянет), в CI-клоне `~/ci/spirits_back` с чекаутом по sha и `source ~/.nvm/nvm.sh` в каждой ssh-команде. `pnpm lint` фронта сломан на main (i18next-плагин) — не чинить, не гонять. `check-locale-format` красный на main — игнорировать.
6. **Инструмент Write портит литеральные последовательности `\uXXXX`** — весь кириллический текст писать литералами (в этом плане и в коде ниже экранированных юникод-последовательностей нет).
7. **Строки в плане с номерами (L123) даны по состоянию main на 2026-11-14** — искать по процитированному коду/заголовкам тестов, номера лишь ориентир.
8. Если после правок теста фактический результат не совпадает с ожиданием из плана — НЕ переписывать ожидание вслепую: пересчитать по семантике `planProviders` (в конце `llm-fallback.ts`) и сообщить оркестратору.

## Карта файлов

**Создаются (spirits_back):**
- `codex-bridge/translate.mjs`, `codex-bridge/sse.mjs`, `codex-bridge/bridge.mjs` + `translate.test.mjs`, `sse.test.mjs`, `bridge.test.mjs` — порт с мака + 3 серверных диффа (T1–T5)
- `codex-bridge/keep-alive.sh` — cron-освежитель токена (T13)
- `scripts/codex-fallback-check.js` — живая проверка цепочки (T12)
- `docs/superpowers/runbooks/2026-11-14-codex-provider-rollout.md` — runbook выката (T13)

**Меняются (spirits_back):**
- `src/common/services/llm-fallback.ts` (+ `.spec.ts`) — реестр бэка (T6)
- `src/monitoring/claude-health.alert-line.spec.ts`, `src/monitoring/relay-qwen-monitor.service.spec.ts`, `src/monitoring/claude-health.outage-alert.spec.ts` — строки/фикстуры алертов (T7; источник `fallback-alert-line.ts` генерик-обходит FALLBACK_ORDER и НЕ меняется)
- `src/common/services/user-llm-provider.service.ts` — только комментарии (T7)
- `src/admin/admin-global-llm.controller.ts` (+ `.spec.ts`), `src/admin/admin-llm-provider.controller.ts` (+ `.spec.ts`) — `configured()` и тесты (T8)
- `relay-agent/llm-fallback.mjs` (+ `.test.mjs`) — реестр релея (T9)

**Меняются (spirits_front):**
- `src/i18n/locales/{ru,en,pt}.json` — ключи codex (T10)
- `src/components/admin/globalLlm.ts` (+ `.test.ts`), `GlobalLlmProviderControl.tsx` (+ `.test.tsx`), `UserLlmProviderControl.tsx` (+ `.test.tsx`), `GlobalLlmBanner.test.tsx`, `UserActivityDrawer.tsx` (комментарий) — переключатели (T11; `GlobalLlmBanner.tsx` не меняется — он берёт метки из `PROVIDER_LABELS`)

**Порядок задач:** T1–T5 (мост) → T6 (реестр бэка) → T7 (мониторинг — чинит красноту, внесённую T6 в спеки мониторинга) → T8 (админ-контроллеры) → T9 (релей) → T10 (локали) → T11 (фронт) → T12 (живая проверка) → T13 (runbook + keep-alive). Между пушем T6 и пушем T7 спеки мониторинга на main briefly красные — приемлемо (полный прогон бэка и так noisy-by-design, проверки точечные).

---

### Task 1: Перенос переводчика и SSE-сборщика (translate.mjs, sse.mjs)

**Files:**
- Create: `spirits_back/codex-bridge/translate.mjs` (копия `~/.linkeon/tools/codex-translate.mjs`)
- Create: `spirits_back/codex-bridge/sse.mjs` (копия `~/.linkeon/tools/codex-sse.mjs`)
- Test: `spirits_back/codex-bridge/translate.test.mjs`, `spirits_back/codex-bridge/sse.test.mjs`

Модули самодостаточны: `codex-sse.mjs` импортирует только `node:crypto`, `codex-translate.mjs` — ничего; мак-путей не содержат (проверено грепом 2026-11-14).

- [ ] **Step 1: Скопировать файлы и поправить импорты в тестах**

```bash
cd ~/Downloads/spirits_back
mkdir -p codex-bridge
cp ~/.linkeon/tools/codex-translate.mjs codex-bridge/translate.mjs
cp ~/.linkeon/tools/codex-sse.mjs codex-bridge/sse.mjs
cp ~/.linkeon/tools/codex-translate.test.mjs codex-bridge/translate.test.mjs
cp ~/.linkeon/tools/codex-sse.test.mjs codex-bridge/sse.test.mjs
sed -i '' "s|'./codex-translate.mjs'|'./translate.mjs'|g; s|'./codex-sse.mjs'|'./sse.mjs'|g" codex-bridge/translate.test.mjs codex-bridge/sse.test.mjs
```

- [ ] **Step 2: Проверить чистоту и прогнать тесты**

```bash
grep -rn "claude-model-router\|codex-translate\|codex-sse\|/Users/dmitry" codex-bridge/ || echo CLEAN
node --test codex-bridge/*.test.mjs
```

Expected: `CLEAN`; `# pass 22` (translate 10 + sse 12), `# fail 0`.

- [ ] **Step 3: Commit**

```bash
git status --porcelain          # только codex-bridge/*
git branch --show-current       # main
git add codex-bridge
git commit -m "$(cat <<'EOF'
feat(codex-bridge): перенос переводчика и SSE-сборщика с мака

Начало переноса codex-bridge (spec docs/superpowers/specs/
2026-11-14-codex-provider-design.md): translate.mjs и sse.mjs без
изменений, тесты переименованы под новые пути.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 2: Перенос моста — самодостаточный bridge.mjs

**Files:**
- Create: `spirits_back/codex-bridge/bridge.mjs` (копия `~/.linkeon/tools/codex-bridge.mjs` с заменой «головы»)
- Test: `spirits_back/codex-bridge/bridge.test.mjs` (копия с переименованием импортов)

На серверах нет `~/.linkeon/tools/claude-model-router.mjs`, поэтому шесть хелперов, которые мост на маке импортирует оттуда (`DEFAULT_BODY_LIMIT`, `createFileLogger`, `isMain`, `readBody`, `sendError`, `sendJson`), инлайнятся в bridge.mjs (копируются дословно из роутера). Мак-пути в константах заменяются на `os.homedir()`.

- [ ] **Step 1: Скопировать мост и тест, переименовать импорты ТОЛЬКО в тесте**

```bash
cd ~/Downloads/spirits_back
cp ~/.linkeon/tools/codex-bridge.mjs codex-bridge/bridge.mjs
cp ~/.linkeon/tools/codex-bridge.test.mjs codex-bridge/bridge.test.mjs
sed -i '' "s|'./codex-bridge.mjs'|'./bridge.mjs'|g; s|'./claude-model-router.mjs'|'./bridge.mjs'|g" codex-bridge/bridge.test.mjs
```

(В тесте три динамических `await import('./claude-model-router.mjs')` ради `createFileLogger` — после sed они ведут на bridge.mjs, который будет его экспортировать.)

- [ ] **Step 2: Заменить «голову» bridge.mjs (строки 1–23 копии)**

Edit-ом заменить блок от `import http from 'node:http';` до строки `  ?? 'codex_cli_rs/0.154.0 (MacOS 25.6.0; arm64)';` включительно на:

```js
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { translateRequest } from './translate.mjs';
import { assembleMessage, createAnthropicStream, createSseParser } from './sse.mjs';

export const DEFAULT_BODY_LIMIT = 100 * 1024 * 1024;
export const DEFAULT_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
export const DEFAULT_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
export const DEFAULT_BRIDGE_MODEL = 'gpt-6-astra';
export const DEFAULT_LOG_PATH = path.join(os.homedir(), '.linkeon', 'logs', 'codex-bridge.log');
// User-Agent сверен с реальным Codex CLI: 0.154.0 — закреплённый пин пакета
// @openai/codex (runbook выката). Серверы Linkeon — Linux x86_64; значение
// для Linux вводится диффом 3 (Task 5), до него — значение мака.
export const UPSTREAM_UA = process.env.CODEX_BRIDGE_UA
  ?? 'codex_cli_rs/0.154.0 (MacOS 25.6.0; arm64)';

// --- Хелперы, инлайнные из ~/.linkeon/tools/claude-model-router.mjs ---
// (на серверах роутера нет; мост обязан быть самодостаточным)

function safeLogEvent(event = {}) {
  const safe = { time: event.time ?? new Date().toISOString() };
  for (const field of ['id', 'type', 'route', 'model', 'status', 'error']) {
    if (event[field] !== undefined) safe[field] = event[field];
  }
  return safe;
}

export function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errorEnvelope(type, message) {
  return { type: 'error', error: { type, message } };
}

export function sendError(res, status, type, message) {
  sendJson(res, status, errorEnvelope(type, message));
}

export function readBody(req, bodyLimit) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    req.on('error', () => {});
    req.resume();
    return Promise.resolve({ tooLarge: true });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > bodyLimit) {
        tooLarge = true;
        chunks.length = 0;
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({
      tooLarge,
      body: tooLarge ? null : Buffer.concat(chunks),
    }));
    req.on('error', () => {
      if (!settled) {
        settled = true;
        reject(Object.assign(new Error('Request read failed'), { safeType: 'request_read' }));
      }
    });
  });
}

export function createFileLogger(filePath = DEFAULT_LOG_PATH) {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const fd = openSync(filePath, 'a', 0o600);
  chmodSync(filePath, 0o600);
  let closed = false;
  const logger = (event) => {
    if (closed) return;
    appendFileSync(fd, `${JSON.stringify(safeLogEvent(event))}\n`);
  };
  logger.close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  return logger;
}

export function isMain(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  return Boolean(argvPath) && fileURLToPath(metaUrl) === path.resolve(argvPath);
}
```

Всё, что шло в копии после этого блока (`export function loadCodexAuth...` и далее до конца), остаётся без изменений.

- [ ] **Step 3: В isMain-блоке (конец файла) добавить authPath**

Заменить:

```js
  const bridge = createBridge({
    log,
    reasoningEffort: process.env.CODEX_BRIDGE_REASONING_EFFORT ?? 'medium',
  });
```

на:

```js
  const bridge = createBridge({
    authPath: process.env.CODEX_AUTH_PATH ?? DEFAULT_AUTH_PATH,
    log,
    reasoningEffort: process.env.CODEX_BRIDGE_REASONING_EFFORT ?? 'medium',
  });
```

- [ ] **Step 4: Проверить чистоту, синтаксис, прогнать тесты**

```bash
grep -n "claude-model-router\|codex-translate\|codex-sse\|/Users/dmitry" codex-bridge/bridge.mjs | grep -v 'инлайнные из' || echo CLEAN
node --check codex-bridge/bridge.mjs && echo SYNTAX-OK
node --test codex-bridge/*.test.mjs
```

Expected: `CLEAN`, `SYNTAX-OK`, `# pass 39` (22 из Task 1 + 17 bridge), `# fail 0`.
(Единственное допустимое попадание — provenance-комментарий `// --- Хелперы, инлайнные из ~/.linkeon/tools/claude-model-router.mjs ---` из verbatim-текста «головы» Step 2; он отфильтрован вторым grep. Функционально файл чист: ни импортов мак-модулей, ни путей `/Users/dmitry`.)

- [ ] **Step 5: Проверить на ноде, что jest/tsc бэка не подхватывают .mjs**

```bash
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest --listTests 2>/dev/null | grep -c codex-bridge; npx tsc -p tsconfig.build.json --noEmit && echo TSC-OK"
```

Expected: `0` и `TSC-OK`. (SHA — от последнего коммита, к этому моменту Task 2 ещё не закоммичен — использовать sha HEAD, т.е. коммит Task 1; файлы codex-bridge появятся на ноде после пуша Task 2, поэтому этот шаг выполнять ПОСЛЕ commit+push Task 2.) Если jest/tsc сообщают о ненайденных модулях — один раз `npm ci` в `~/ci/spirits_back`.

- [ ] **Step 6: Commit**

```bash
git status --porcelain && git branch --show-current   # только свои файлы, main
git add codex-bridge
git commit -m "$(cat <<'EOF'
feat(codex-bridge): перенос моста — самодостаточный bridge.mjs

Хелперы роутера инлайнены (на серверах его нет), мак-пути заменены на
os.homedir(), добавлен env CODEX_AUTH_PATH. Поведение — 1:1 с маком
(39/39 тестов). Серверные диффы — следующими коммитами (TDD).

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

После пуша — выполнить Step 5 (он проверяет уже запушенный sha).

---

### Task 2b: Дифф 4 — запуск под pm2 (TDD)

Введён по code-quality ревью Task 2. Под pm2 (fork mode) `process.argv[1]` указывает на `ProcessContainerFork.js`, а не на скрипт, поэтому `isMain()` возвращает false и мост **молча не открывает порт** — pm2 при этом показывает процесс «online» (IPC-канал держит event loop). Тот же инцидент случился 04.11.2026 на релее: прецедент и фикс — в `relay-agent/server.mjs` (`process.env.pm_id !== undefined || isMain(...)`). Runbook (Task 13) запускает мост именно через `pm2 start bridge.mjs` на обоих серверах, поэтому без этого диффа выкат упал бы на первом healthz.

**Files:**
- Modify: `spirits_back/codex-bridge/bridge.mjs` (isMain-блок, конец файла)
- Test: `spirits_back/codex-bridge/bridge.test.mjs` (новый тест в конце файла)

- [ ] **Step 1: Красный тест** — добавить в конец `codex-bridge/bridge.test.mjs`:

```js
test('Дифф 4: под pm2 (pm_id в env) мост открывает порт', async (t) => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pm2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // pm2 в fork mode поднимает процесс через ProcessContainerFork.js: argv[1]
  // указывает на раннер, а не на скрипт. Имитируем обёрткой, импортирующей bridge.mjs.
  const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  const wrapperPath = path.join(dir, 'wrapper.mjs');
  fs.writeFileSync(wrapperPath, `await import(${JSON.stringify(bridgePath)});\n`);

  const logPath = path.join(dir, 'bridge.log');
  const port = 18000 + Math.floor(Math.random() * 1000);

  const healthzUp = (child) =>
    new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(false);
        const req = http.get(
          { host: '127.0.0.1', port, path: '/healthz', timeout: 300 },
          (res) => { res.resume(); resolve(res.statusCode === 200); },
        );
        req.on('error', () => {
          if (Date.now() > deadline) return resolve(false);
          setTimeout(tick, 100);
        });
        req.on('timeout', () => req.destroy());
      };
      tick();
    });

  const run = async (extraEnv) => {
    const child = spawn(process.execPath, [wrapperPath], {
      env: { ...process.env, ...extraEnv, BRIDGE_PORT: String(port), BRIDGE_LOG_PATH: logPath },
      stdio: 'ignore',
    });
    const up = await healthzUp(child);
    child.kill('SIGKILL');
    // Слушатель 'exit' регистрируется только если процесс ещё жив: обёртка без
    // listen-сервера выходит раньше, и once('exit'), добавленный после события,
    // не вызывается никогда (проверено исполнением 14.11.2026).
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    return up;
  };

  assert.equal(await run({ pm_id: '0' }), true,
    'при pm_id (pm2 fork mode) мост обязан открыть порт');
  assert.equal(await run({ pm_id: undefined }), false,
    'без pm_id и не будучи главным модулем — порт не открывает');
});
```

Пояснения: `spawn` с `pm_id: undefined` выбрасывает этот ключ из env дочернего процесса — так задаётся негативная ветка. Позитивная ветка живёт, пока жив listen-сервер; если мост не поднялся, обёртка сразу выходит и `healthzUp` возвращает false по `exitCode`. Файловые импорты `fs`/`os`/`path`/`http` в тесте уже есть (статические, в шапке файла). Порт рандомизирован, чтобы не collide с живым маковским мостом на 8790.

- [ ] **Step 2: Убедиться, что тест красный**

Run: `cd ~/Downloads/spirits_back && node --test codex-bridge/*.test.mjs`
Expected: `# pass 39`, `# fail 1` (позитивная ветка: мост без фикса не слушает).

- [ ] **Step 3: Фикс** — в `codex-bridge/bridge.mjs` заменить последнюю isMain-строку:

```js
if (isMain(import.meta.url)) {
```

на:

```js
// Под pm2 (fork mode) argv[1] указывает на ProcessContainerFork.js, а не на скрипт:
// без проверки pm_id мост молча не открыл бы порт (инцидент 04.11 на релее,
// см. relay-agent/server.mjs). Прямой запуск node по-прежнему решает isMain().
if (process.env.pm_id !== undefined || isMain(import.meta.url)) {
```

- [ ] **Step 4: Убедиться, что зелёный**

Run: `node --test codex-bridge/*.test.mjs`
Expected: `# pass 40`, `# fail 0`.

- [ ] **Step 5: Commit (красный тест, затем фикс)**

```bash
git status --porcelain && git branch --show-current
git add codex-bridge/bridge.test.mjs
git commit -m "$(cat <<'EOF'
test(codex-bridge): под pm2 мост открывает порт (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git add codex-bridge/bridge.mjs
git commit -m "$(cat <<'EOF'
fix(codex-bridge): дифф 4 — запуск под pm2 через pm_id

Под pm2 fork mode argv[1] — ProcessContainerFork.js, isMain() ложен,
и мост молча не открывал порт. Прецедент и фикс — relay-agent/server.mjs
(инцидент 04.11.2026). Прямой запуск node не меняется.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

(Оба коммита пушатся вместе — на origin/main красный тест отдельно не появляется.)

---

### Task 3: Дифф 1 — уважать входящую модель (TDD)

**Files:**
- Modify: `spirits_back/codex-bridge/bridge.mjs`
- Test: `spirits_back/codex-bridge/bridge.test.mjs`

Зачем: `ClaudeCliService` шлёт в `ANTHROPIC_DEFAULT_*_MODEL` модель из реестра бэка, а не дефолт моста; мост обязан брать модель из тела запроса, если она там есть.

- [ ] **Step 1: Дописать красный тест в конец bridge.test.mjs**

Используются существующие хелперы файла: `startPair(t, upstreamHandler)` (возвращает `{records, bridgeOrigin, upstreamOrigin, authPath}`; каждый хит upstream записывается в `records` как `{method, url, headers, body}`), `post(origin, path, body)`, фикстура `TEXT_SSE`.

```js
test('Серверный дифф 1: входящая модель идёт на upstream и в кадры', async (t) => {
  const { records, bridgeOrigin } = await startPair(t, (record, req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(TEXT_SSE);
  });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra-custom',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(records[0].body).model, 'gpt-6-astra-custom');
  assert.match(result.text, /gpt-6-astra-custom/);

  const fallback = await post(bridgeOrigin, '/v1/messages', { messages: [] });
  assert.equal(fallback.status, 200);
  assert.equal(JSON.parse(records[1].body).model, 'gpt-6-astra');
});
```

- [ ] **Step 2: Прогнать — тест красный**

```bash
cd ~/Downloads/spirits_back && node --test codex-bridge/*.test.mjs
```

Expected: `# pass 40`, `# fail 1` (новый тест: на upstream уходит `gpt-6-astra` вместо `gpt-6-astra-custom`).

- [ ] **Step 3: Commit красного теста**

```bash
git add codex-bridge/bridge.test.mjs
git commit -m "$(cat <<'EOF'
test(codex-bridge): входящая модель идёт на upstream и в кадры (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

- [ ] **Step 4: Реализовать дифф 1 — три правки в bridge.mjs**

(a) Объявить `requestModel` ДО `try` (иначе внешний catch его не увидит). Заменить:

```js
    const id = randomUUID();
    let clientGone = false;
    try {
```

на:

```js
    const id = randomUUID();
    let clientGone = false;
    // Серверный дифф 1 (spec 2026-11-14): уважаем входящую модель —
    // ClaudeCliService шлёт ANTHROPIC_DEFAULT_*_MODEL из реестра, а не дефолт
    // моста. Объявлена до try, чтобы внешний catch тоже мог её логировать.
    let requestModel = model;
    try {
```

(b) Прочитать модель из тела — после блока проверки объекта (`sendError(res, 400, 'invalid_request', 'JSON object required')`), перед блоком `count_tokens`:

```js
      if (typeof parsed.model === 'string' && parsed.model.trim() !== '') {
        requestModel = parsed.model.trim();
      }
```

(c) Заменить shorthand `model` на `model: requestModel` в 10 местах (строки по копии L134–L265):
1. emit `auth_missing` (401): `emit(log, { id, type: 'error', route: 'codex', model: requestModel, status: 401, error: 'auth_missing' });`
2. `const payload = translateRequest(parsed, { model: requestModel, reasoningEffort });`
3. emit `upstream_status`: `emit(log, { id, type: 'error', route: 'codex', model: requestModel, status, error: 'upstream_status' });`
4. `createAnthropicStream({ model: requestModel, write: ... })`
5. emit 499 `client_disconnect` в `upstreamRes.on('end')`: `model: requestModel`
6. emit 200 `response` там же: `model: requestModel`
7. emit 499 в `upstreamRes.on('error')`: `model: requestModel`
8. emit `upstream_stream` (status 200) там же: `model: requestModel`
9. emit `upstream_request` (502) в `upstreamRequest.on('error')`: `model: requestModel`
10. emit во внешнем catch (500): `model: requestModel`

- [ ] **Step 5: Прогнать — всё зелёное**

```bash
node --test codex-bridge/*.test.mjs
```

Expected: `# pass 41`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add codex-bridge/bridge.mjs
git commit -m "$(cat <<'EOF'
feat(codex-bridge): дифф 1 — уважать входящую модель

ClaudeCliService шлёт модель из реестра бэка (ANTHROPIC_DEFAULT_*_MODEL);
мост берёт model из тела запроса, дефолт gpt-6-astra — только когда поля нет.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 4: Дифф 2 — ретрай ровно один раз при 401 upstream (TDD)

**Files:**
- Modify: `spirits_back/codex-bridge/bridge.mjs`
- Test: `spirits_back/codex-bridge/bridge.test.mjs`

Зачем: cron-освежитель (keep-alive.sh) обновляет `~/.codex/auth.json` независимо от моста; запрос, пришедший в момент протухшего токена, должен один раз перечитать файл и повторить — без собственного refresh-кода (он сломал бы ротацию refresh_token CLI).

- [ ] **Step 1: Дописать два красных теста в конец bridge.test.mjs**

```js
test('Серверный дифф 2: 401 от upstream — перечитать auth.json и повторить ровно один раз', async (t) => {
  let hits = 0;
  const { records, bridgeOrigin, authPath } = await startPair(t, (record, req, res) => {
    hits += 1;
    if (hits === 1) {
      // К моменту первого хита «освежитель» уже перезаписал auth.json:
      fs.writeFileSync(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { access_token: 'fresh-access', account_id: 'acct_43', refresh_token: 'fake-refresh' },
      }), { mode: 0o600 });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid token' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(TEXT_SSE);
  });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra', stream: true, messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.status, 200);
  assert.equal(records.length, 2);
  assert.equal(records[1].headers.authorization, 'Bearer fresh-access');
  assert.equal(records[1].headers['chatgpt-account-id'], 'acct_43');
});

test('Серверный дифф 2: 401 дважды — второй уходит клиенту, бесконечного ретрая нет', async (t) => {
  const { records, bridgeOrigin } = await startPair(t, (record, req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid token' } }));
  });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.status, 401);
  assert.equal(records.length, 2);
  assert.match(result.text, /Codex token rejected/);
});
```

- [ ] **Step 2: Прогнать — два красных**

```bash
cd ~/Downloads/spirits_back && node --test codex-bridge/*.test.mjs
```

Expected: `# pass 41`, `# fail 2` (без ретрая: `records.length === 1`, клиенту уходит 401 с первого хита).

- [ ] **Step 3: Commit красного теста**

```bash
git add codex-bridge/bridge.test.mjs
git commit -m "$(cat <<'EOF'
test(codex-bridge): ретрай ровно раз при 401 upstream (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

- [ ] **Step 4: Перестроить upstream-зону в bridge.mjs**

Заменить ВЕСЬ участок от строки `const payload = translateRequest(parsed, { model: requestModel, reasoningEffort });` до строки `upstreamRequest.end(JSON.stringify(payload));` включительно (внешний `catch` и код выше не трогаются) на:

```js
      const payload = translateRequest(parsed, { model: requestModel, reasoningEffort });
      const target = new URL(`${upstream.replace(/\/+$/, '')}/responses`);
      const transport = target.protocol === 'https:' ? https : http;
      // Серверный дифф 2 (spec 2026-11-14): при 401 от upstream один раз
      // перечитываем auth.json (cron-освежитель codex CLI мог уже обновить
      // токен) и повторяем запрос РОВНО ОДИН РАЗ. Сами токены мост не
      // обновляет никогда — ротацию refresh_token делает официальный CLI.
      let upstreamRequest;
      const sendUpstream = (attemptAuth, isRetry) => {
        const request = transport.request(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${attemptAuth.accessToken}`,
            ...(attemptAuth.accountId ? { 'chatgpt-account-id': attemptAuth.accountId } : {}),
            'openai-beta': 'responses=experimental',
            originator: 'codex_cli_rs',
            'user-agent': UPSTREAM_UA,
            session_id: randomUUID(),
          },
          agent: false,
        }, (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          if (status === 401 && !isRetry && !clientGone) {
            const fresh = loadCodexAuth(authPath);
            if (fresh) {
              upstreamRes.resume();
              emit(log, { id, type: 'error', route: 'codex', model: requestModel, status: 401, error: 'auth_retry' });
              sendUpstream(fresh, true);
              return;
            }
          }
          if (status !== 200) {
            const chunks = [];
            let collected = 0;
            upstreamRes.on('data', (c) => {
              if (collected < 4096) { chunks.push(c); collected += c.length; }
            });
            upstreamRes.on('end', () => {
              let message = `Upstream status ${status}`;
              try {
                const e = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (typeof e?.error?.message === 'string') message = e.error.message.slice(0, 300);
                else if (typeof e?.message === 'string') message = e.message.slice(0, 300);
              } catch {
                // оставляем дефолтное сообщение; тело upstream не логируем
              }
              if (status === 401) {
                message = `Codex token rejected: open the Codex app once to refresh login (${message})`;
              }
              emit(log, { id, type: 'error', route: 'codex', model: requestModel, status, error: 'upstream_status' });
              sendError(res, status, 'upstream_error', message);
            });
            upstreamRes.on('error', () => {
              if (!res.writableEnded && !res.destroyed) sendError(res, 502, 'bad_gateway', 'Upstream read failed');
            });
            return;
          }

          // stream:false (Claude Code не использует, но контракт Anthropic требует):
          // upstream всё равно стримится, фреймы копятся и собираются в один JSON.
          // При отсутствующем поле stream мост отвечает SSE — осознанное отклонение
          // от дефолта Anthropic (где отсутствие поля означало бы non-streaming):
          // единственный потребитель Claude Code всегда шлёт stream явно.
          const nonStreaming = parsed.stream === false;
          const frames = [];
          const stream = createAnthropicStream({
            model: requestModel,
            write: nonStreaming
              ? (frame) => frames.push(frame)
              : (frame) => {
                if (!res.writableEnded && !res.destroyed) res.write(frame);
              },
          });
          if (!nonStreaming) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            res.flushHeaders();
          }
          const parser = createSseParser((ev) => {
            try {
              stream.handleEvent(ev);
            } catch {
              // ошибка перевода одного события не должна рвать поток
            }
          });
          upstreamRes.setEncoding('utf8');
          upstreamRes.on('data', (chunk) => parser.push(chunk));
          upstreamRes.on('end', () => {
            stream.finishIfOpen();
            if (clientGone) {
              emit(log, { id, type: 'error', route: 'codex', model: requestModel, status: 499, error: 'client_disconnect' });
            } else {
              emit(log, { id, type: 'response', route: 'codex', model: requestModel, status: 200 });
            }
            if (nonStreaming) {
              try {
                sendJson(res, 200, assembleMessage(frames));
              } catch (error) {
                sendError(res, 500, error.safeType ?? 'api_error',
                  error.message ?? 'Stream assembly failed');
              }
              return;
            }
            if (!res.writableEnded) res.end();
          });
          upstreamRes.on('error', () => {
            if (clientGone) {
              emit(log, { id, type: 'error', route: 'codex', model: requestModel, status: 499, error: 'client_disconnect' });
            } else {
              emit(log, { id, type: 'error', route: 'codex', model: requestModel, status: 200, error: 'upstream_stream' });
            }
            if (nonStreaming) {
              sendError(res, 502, 'bad_gateway', 'Upstream stream failed');
              return;
            }
            stream.failOpen('Upstream connection error');
            if (!res.writableEnded) res.end();
          });
        });
        upstreamRequest = request;
        request.on('error', () => {
          // Ошибка СТАРОЙ попытки (её заменил ретрай) игнорируется — иначе она
          // перетёрла бы ответ ретрая пятьсот вторым.
          if (request !== upstreamRequest) return;
          if (res.writableEnded || res.destroyed) return;
          emit(log, { id, type: 'error', route: 'codex', model: requestModel, status: 502, error: 'upstream_request' });
          sendError(res, 502, 'bad_gateway', 'Upstream request failed');
        });
        request.end(JSON.stringify(payload));
      };
      // Обрыв клиента — в т.ч. до прихода заголовков upstream: уничтожаем запрос
      // сразу (иначе генерация на chatgpt.com продолжает жечь квоту, а при
      // зависшем upstream сокет висит вечно) и помечаем обрыв, чтобы логи не
      // приняли его за ошибку upstream — 499 client_disconnect, как в forward() роутера.
      // После нормального завершения destroyed === true и destroy() — no-op.
      res.on('close', () => {
        clientGone = true;
        if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy();
      });
      sendUpstream(auth, false);
```

Ключевые отличия от копии, кроме обёртки: (1) заголовки берутся из `attemptAuth`, а не из `auth`; (2) ветка 401-ретрая в начале колбэка ответа; (3) guard `if (request !== upstreamRequest) return;` в обработчике ошибки запроса — защита от гонки «старая попытка упала после старта ретрая»; (4) `res.on('close')` уничтожает ТЕКУЩУЮ попытку (`upstreamRequest` переприсваивается внутри `sendUpstream`).

- [ ] **Step 5: Прогнать — всё зелёное**

```bash
node --check codex-bridge/bridge.mjs && node --test codex-bridge/*.test.mjs
```

Expected: `# pass 43`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add codex-bridge/bridge.mjs
git commit -m "$(cat <<'EOF'
feat(codex-bridge): дифф 2 — перечитать auth.json и повторить 401 один раз

Токен освежает официальный codex CLI по cron; мост на 401 лишь один раз
перечитывает файл и повторяет запрос. Ошибка устаревшей попытки не
перетирает ответ ретрая (guard request !== upstreamRequest).

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 5: Дифф 3 — Linux User-Agent по умолчанию (TDD)

**Files:**
- Modify: `spirits_back/codex-bridge/bridge.mjs`
- Test: `spirits_back/codex-bridge/bridge.test.mjs`

Зачем: мост изображает codex CLI; серверы Linkeon — Linux x86_64, а дефолт остался от мака. Существующий тест mac-набора проверяет UA только регэкспом `/codex_cli_rs/`, так что смена суффикса его не ломает.

- [ ] **Step 1: Дописать красный тест в конец bridge.test.mjs**

```js
test('Серверный дифф 3: дефолтный User-Agent — Linux x86_64', async (t) => {
  const { records, bridgeOrigin } = await startPair(t, (record, req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(TEXT_SSE);
  });
  const result = await post(bridgeOrigin, '/v1/messages', {
    model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.status, 200);
  assert.equal(records[0].headers['user-agent'], 'codex_cli_rs/0.154.0 (Linux; x86_64)');
});
```

- [ ] **Step 2: Прогнать — красный; commit**

```bash
cd ~/Downloads/spirits_back && node --test codex-bridge/*.test.mjs   # pass 43, fail 1
git add codex-bridge/bridge.test.mjs
git commit -m "$(cat <<'EOF'
test(codex-bridge): дефолтный UA — Linux x86_64 (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

- [ ] **Step 3: Поменять дефолт в bridge.mjs**

Заменить:

```js
// User-Agent сверен с реальным Codex CLI: 0.154.0 — закреплённый пин пакета
// @openai/codex (runbook выката). Серверы Linkeon — Linux x86_64; значение
// для Linux вводится диффом 3 (Task 5), до него — значение мака.
export const UPSTREAM_UA = process.env.CODEX_BRIDGE_UA
  ?? 'codex_cli_rs/0.154.0 (MacOS 25.6.0; arm64)';
```

на:

```js
// User-Agent сверен с реальным Codex CLI: 0.154.0 — закреплённый пин пакета
// @openai/codex (runbook выката). Серверы Linkeon — Linux x86_64.
export const UPSTREAM_UA = process.env.CODEX_BRIDGE_UA
  ?? 'codex_cli_rs/0.154.0 (Linux; x86_64)';
```

- [ ] **Step 4: Прогнать — зелёное; commit**

```bash
node --test codex-bridge/*.test.mjs    # pass 44, fail 0
git add codex-bridge/bridge.mjs
git commit -m "$(cat <<'EOF'
feat(codex-bridge): дифф 3 — Linux User-Agent по умолчанию

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 6: Реестр бэка — codex четвёртым запасным (TDD)

**Files:**
- Modify: `spirits_back/src/common/services/llm-fallback.ts`
- Test: `spirits_back/src/common/services/llm-fallback.spec.ts`

Семантика включения: `readFallbackConfig('codex', env)` читает `CODEX_FALLBACK_API_KEY` (значением может быть заглушка `local-bridge`) плюс опциональные переопределения `CODEX_FALLBACK_BASE_URL`, `CODEX_FALLBACK_MODEL_{OPUS,SONNET,HAIKU}` — всё через общий механизм `envPrefix`.

#### Шаг A — красный тест

- [ ] **Step 1: Правки llm-fallback.spec.ts**

1. После последнего import (~L18) добавить:
   ```ts
   import { classifyLlmError } from '../llm-error';
   ```
2. После `const KIMI_MODELS = ...` (~L21) добавить:
   ```ts
   const CODEX_MODELS = { opus: 'gpt-6-astra', sonnet: 'gpt-6-astra', haiku: 'gpt-6-astra' };
   ```
3. В `describe('readFallbackConfig')` после последнего kimi-теста (~L39) добавить:
   ```ts
     it('Codex с ключом — адрес локального моста и gpt-6-astra для всех классов', () => {
       expect(readFallbackConfig('codex', { CODEX_FALLBACK_API_KEY: 'local-bridge' })).toEqual({
         name: 'codex',
         apiKey: 'local-bridge',
         baseUrl: 'http://127.0.0.1:8790',
         models: CODEX_MODELS,
       });
     });

     it('переопределения из env — у Codex свои', () => {
       const cfg = readFallbackConfig('codex', {
         CODEX_FALLBACK_API_KEY: 'local-bridge',
         CODEX_FALLBACK_BASE_URL: 'http://127.0.0.1:9999',
         CODEX_FALLBACK_MODEL_OPUS: 'gpt-5.6-sol',
       });
       expect(cfg?.baseUrl).toBe('http://127.0.0.1:9999');
       expect(cfg?.models).toEqual({ opus: 'gpt-5.6-sol', sonnet: 'gpt-6-astra', haiku: 'gpt-6-astra' });
     });
   ```
4. Тест порядка fallback (~L58–63, «Порядок fallback: Claude → Qwen → Kimi»): заголовок → «Порядок fallback: Claude → Qwen → Kimi → Codex»; ожидание → `expect(FALLBACK_ORDER).toEqual(['qwen', 'kimi', 'codex']);`; в env-объект вызова `readFallbackConfigs` добавить `CODEX_FALLBACK_API_KEY: 'local-bridge'` и новое ожидание `expect(all.codex?.name).toBe('codex');` (имя переменной результата — как в файле).
5. В `describe('fallbackModelFor')` добавить:
   ```ts
     it('Codex: любой класс — gpt-6-astra', () => {
       for (const req of ['claude-opus-5-5', 'sonnet', 'claude-haiku-4-5', 'default']) {
         expect(fallbackModelFor(req, CODEX_MODELS)).toBe('gpt-6-astra');
       }
     });
   ```
6. В `describe('isFallbackWorthy')` добавить (проверяет, что 401-рефрейм моста классифицируется как auth БЕЗ изменения прод-кода):
   ```ts
     it('401-рефрейм моста Codex — достойный сбой вида auth', () => {
       const msg = 'claude CLI error: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Codex token rejected: open the Codex app once to refresh login (invalid token)"}}';
       expect(isFallbackWorthy(msg)).toBe(true);
       expect(classifyLlmError(msg).kind).toBe('auth');
     });
   ```
7. `it.each(['qwen', 'kimi'])` (~L207) → `it.each(['qwen', 'kimi', 'codex'])`.
8. В `describe('planProviders')`:
   - тип хелпера (~L253): `const cfg = (name: 'qwen' | 'kimi' | 'codex') => ...`
   - (~L254): `const both = { qwen: cfg('qwen'), kimi: cfg('kimi'), codex: cfg('codex') }; // имя историческое — запасных уже три`
   - (~L261, noFallback-тест): литерал конфигов → `{ qwen: null, kimi: null, codex: null }`; ожидание НЕ меняется (`['claude']`).
   - (~L274–275): заголовок теста обычного пути → «… — Claude, Qwen, Kimi, Codex»; ожидание → `['claude', 'qwen', 'kimi', 'codex']`.
   - (~L278, qwen: null): литерал → добавить `codex: null`; ожидание НЕ меняется (`['claude', 'kimi']`).
   - (~L281): литерал → `{ qwen: null, kimi: null, codex: null }`; ожидание НЕ меняется (`['claude']`).
   - (~L286, окно Claude открыто, все живы): ожидание → `['qwen', 'kimi', 'codex']`.
   - (~L291, qwen «не отвечает»): ожидание → `['claude', 'kimi', 'codex']`.
   - (~L293–298, все «не отвечают»): добавить `s.markDown('codex', 60_000, T);`; ожидание НЕ меняется (`['claude']`).
   - (~L301): ожидание → `['kimi', 'claude', 'qwen', 'codex']`.
   - (~L306): ожидание → `['kimi', 'qwen', 'codex']`.
   - (~L311): ожидание → `['kimi', 'claude', 'qwen', 'codex']`.
   - (~L319, kimi «не отвечает», не выбран): ожидание → `['claude', 'qwen', 'codex']`.
   - (~L322): ожидание → `['kimi', 'claude', 'qwen', 'codex']`.
   - (~L330): литерал конфигов → добавить `codex: null`; ожидание НЕ меняется (`['claude', 'qwen']`).
   - (~L333 и ~L336): ожидания → `['claude', 'qwen', 'kimi', 'codex']`.
   - (~L338–343, «выбран Kimi, окно Claude открыто, Qwen «не отвечает»»): добавить `s.markDown('codex', 60_000, T);`, заголовок → «выбран Kimi, окно Claude открыто, Qwen и Codex «не отвечают» — Kimi, затем Claude»; ожидание НЕ меняется (`['kimi', 'claude']`).
   - Перед закрывающим `});` describe('planProviders') добавить:
     ```ts
       it('выбран Codex — сначала он, затем обычный путь без него', () => {
         expect(planProviders({ selected: 'codex', configs: both, state: new FallbackState(), now: T }))
           .toEqual(['codex', 'claude', 'qwen', 'kimi']);
       });

       it('noFallback с выбором Codex — только Codex', () => {
         expect(planProviders({ selected: 'codex', configs: both, state: new FallbackState(), now: T, noFallback: true }))
           .toEqual(['codex']);
       });
     ```
     (Конструктор состояния и поле `noFallback` — как в соседних тестах файла; `T` — константа времени из соседних тестов, если в этом describe её нет — взять `now: 10_000`.)

- [ ] **Step 2: Прогнать на ноде — красный**

```bash
git -C ~/Downloads/spirits_back add src/common/services/llm-fallback.spec.ts
git -C ~/Downloads/spirits_back commit -m "$(cat <<'EOF'
test(llm-fallback): codex в реестре запасных (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git -C ~/Downloads/spirits_back pull --rebase -q origin main && git -C ~/Downloads/spirits_back push -q origin main
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest src/common/services/llm-fallback.spec.ts 2>&1 | tail -25"
```

Expected: FAIL — несколько упавших тестов (codex не в FALLBACK_ORDER, readFallbackConfig('codex') возвращает null, ожидания планов не совпадают).

#### Шаг B — фикс

- [ ] **Step 3: Правки llm-fallback.ts (8 штук)**

1. Комментарий JSDoc (~L4): «Запасные провайдеры ClaudeCliService — Qwen и Kimi.» → «Запасные провайдеры ClaudeCliService — Qwen, Kimi и Codex.»
2. В том же JSDoc список спецификаций: после `2026-10-31-kimi-provider-design.md` дописать `, 2026-11-14-codex-provider-design.md`.
3. `export type FallbackProvider = 'qwen' | 'kimi' | 'codex';`
4. `export const FALLBACK_ORDER: readonly FallbackProvider[] = ['qwen', 'kimi', 'codex'];`
5. `export const PROVIDER_LABELS: Readonly<Record<AnswerProvider, string>> = { claude: 'Claude', qwen: 'Qwen', kimi: 'Kimi', codex: 'Codex' };`
6. В `PROVIDER_DEFAULTS` после блока kimi добавить:
   ```ts
     // Локальный codex-bridge (Anthropic Messages ⇄ OpenAI Responses API,
     // spec 2026-11-14): ключ-заглушка local-bridge — мост аутентифируется сам
     // через ~/.codex/auth.json (подписка ChatGPT Pro). gpt-6-astra для всех
     // классов.
     codex: {
       envPrefix: 'CODEX',
       baseUrl: 'http://127.0.0.1:8790',
       models: { opus: 'gpt-6-astra', sonnet: 'gpt-6-astra', haiku: 'gpt-6-astra' },
     },
   ```
7. `export const NO_FALLBACK_CONFIGS: Readonly<FallbackConfigs> = Object.freeze({ qwen: null, kimi: null, codex: null });`
8. `readFallbackConfigs`:
   ```ts
   export function readFallbackConfigs(env = process.env): FallbackConfigs {
     return {
       qwen: readFallbackConfig('qwen', env),
       kimi: readFallbackConfig('kimi', env),
       codex: readFallbackConfig('codex', env),
     };
   }
   ```

Остальное (ANSWER_PROVIDERS, isAnswerProvider, planProviders, stats, spawn-env, тексты ошибок 400) — генерик над FALLBACK_ORDER/Record-типами и подхватит codex автоматически; Record-типы (`FallbackConfigs`, `PROVIDER_DEFAULTS`, `PROVIDER_LABELS`) не дадут забыть ни одну запись — tsc покраснеет.

- [ ] **Step 4: Прогнать на ноде — зелёный + tsc**

```bash
git -C ~/Downloads/spirits_back add src/common/services/llm-fallback.ts
git -C ~/Downloads/spirits_back commit -m "$(cat <<'EOF'
feat(llm-fallback): codex — четвёртый запасной провайдер

Локальный codex-bridge на 127.0.0.1:8790, ключ-заглушка local-bridge,
gpt-6-astra для всех классов. Цепочка: Claude → Qwen → Kimi → Codex.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git -C ~/Downloads/spirits_back pull --rebase -q origin main && git -C ~/Downloads/spirits_back push -q origin main
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest src/common/services/llm-fallback.spec.ts 2>&1 | tail -10 && npx tsc -p tsconfig.build.json --noEmit && echo TSC-OK"
```

Expected: все тесты spec PASS; `TSC-OK`. Если tsc краснеет на `src/admin/*` (configured() без codex) — это ожидаемо и чинится в Task 8; в этом случае зафиксировать список ошибок и продолжить (гейт tsc для Task 6 — отсутствие НОВЫХ ошибок вне admin/monitoring).

---

### Task 7: Мониторинг — строки алертов и комментарии сервиса

**Files:**
- Test: `spirits_back/src/monitoring/claude-health.alert-line.spec.ts`
- Test: `spirits_back/src/monitoring/relay-qwen-monitor.service.spec.ts`
- Test: `spirits_back/src/monitoring/claude-health.outage-alert.spec.ts`
- Modify (комментарии): `spirits_back/src/common/services/user-llm-provider.service.ts`

Источник `fallback-alert-line.ts` генерик-обходит `FALLBACK_ORDER` (`p?.enabled ? '<Label> — ответов N, ошибок M' : '<Label> — не настроен'`) и НЕ меняется: строки про Codex появляются сами после Task 6 — поэтому существующие ожидания строк в спеках становятся красными. Сначала наблюдаем красноту, потом чиним.

- [ ] **Step 1: Наблюдать красные на ноде (sha Task 6)**

```bash
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest src/monitoring/claude-health.alert-line.spec.ts src/monitoring/relay-qwen-monitor.service.spec.ts src/monitoring/claude-health.outage-alert.spec.ts 2>&1 | tail -30"
```

Expected: FAIL в строковых ожиданиях («; Codex — не настроен» в фактических строках) и, возможно, в outage-alert на литералах Provs.

- [ ] **Step 2: claude-health.alert-line.spec.ts — 4 строки + новый тест**

К каждому из четырёх ожиданий строк (L8, L13, L18, L22) дописать суффикс `; Codex — не настроен` перед закрывающей кавычкой:
- `'Запасные за 15 мин: Qwen — не настроен; Kimi — не настроен'` (L8 и L22) → `'Запасные за 15 мин: Qwen — не настроен; Kimi — не настроен; Codex — не настроен'`
- `'Запасные за 15 мин: Qwen — ответов 12, ошибок 1; Kimi — ответов 3, ошибок 0'` (L13) → `...ошибок 0; Codex — не настроен'`
- `'Запасные за 15 мин: Qwen — ответов 0, ошибок 3; Kimi — не настроен'` (L18) → `...Kimi — не настроен; Codex — не настроен'`

Добавить тест (используя существующий в файле хелпер `p(...)` — сигнатура как у соседей: `p(enabled, ok, failed)`):

```ts
  it('Codex в счётчиках — строка про Codex', () => {
    expect(fallbackAlertLine({
      windowMs: 900_000,
      providers: { qwen: p(false), kimi: p(false), codex: p(true, 2, 1) },
    })).toContain('Codex — ответов 2, ошибок 1');
  });
```

(Вызов `fallbackAlertLine` и форму ассерта скопировать с соседних тестов файла — они уже импортированы.)

- [ ] **Step 3: relay-qwen-monitor.service.spec.ts — 3 строки + новый тест**

- L83: `'\nЗапасные за 15 мин: Qwen — ответов 0, ошибок 2; Kimi — ответов 4, ошибок 0.\n'` → вставить `; Codex — не настроен` перед точкой: `...Kimi — ответов 4, ошибок 0; Codex — не настроен.\n'`
- L89: `'...Qwen — ответов 1, ошибок 0; Kimi — не настроен.'` → `'...Kimi — не настроен; Codex — не настроен.'`
- L99: `'...Qwen — ответов 5, ошибок 1; Kimi — не настроен.'` → `'...Kimi — не настроен; Codex — не настроен.'`

Добавить тест (хелперы `fb()`/`text()` — из файла; `fb()` остаётся без codex-ключа — строка «не настроен» берётся из отсутствия записи):

```ts
  it('Codex в счётчиках релея — строка про Codex', () => {
    const h = fb();
    (h.fallback.providers as any).codex = { enabled: true, ok: 1, failed: 0, downUntil: 0 };
    expect(text(h)).toContain('Codex — ответов 1, ошибок 0');
  });
```

Ожидание legacy-теста `providers` toEqual({qwen}) (L35) НЕ менять: legacy-ветка ключуется по наличию поля qwen.

- [ ] **Step 4: claude-health.outage-alert.spec.ts — тип Provs и литералы**

- В `healthyOnly(provider)` (~L48–51) добавить строку `codex: provider === 'codex' ? up : noKey,` (по образцу kimi-строки).
- Во все объектные литералы типа Provs (~L105–108, L125–127, L175, L374, L397) добавить `codex: noKey` (или `codex: up` — по образцу соседних kimi-записей в том же литерале).
- `it.each(['kimi', 'qwen'])` (~L139) НЕ расширять (правило «рубильник на codex не ставится» — YAGNI).
- Контрольная сверка (спеки не проходят через tsc-гейт — ловим пропуски грепом):
  ```bash
  grep -n 'qwen:' ~/Downloads/spirits_back/src/monitoring/claude-health.outage-alert.spec.ts
  ```
  Каждый литерал с `qwen:` обязан содержать `codex:`.

- [ ] **Step 5: user-llm-provider.service.ts — комментарии**

- `/** Модель ответов: 'claude', 'qwen' или 'kimi'. */` → `/** Модель ответов: 'claude', 'qwen', 'kimi' или 'codex'. */`
- В JSDoc (~L24–33) строку «'claude' / 'qwen' / 'kimi' — явный личный выбор» → «'claude' / 'qwen' / 'kimi' / 'codex' — явный личный выбор».

- [ ] **Step 6: Прогнать на ноде — зелёный; commit**

```bash
cd ~/Downloads/spirits_back
git add src/monitoring/claude-health.alert-line.spec.ts src/monitoring/relay-qwen-monitor.service.spec.ts src/monitoring/claude-health.outage-alert.spec.ts
git commit -m "$(cat <<'EOF'
test(monitoring): строки запасных и исходы с Codex

fallback-alert-line генерик-обходит FALLBACK_ORDER — ожидания строк
пополнены суффиксом про Codex, добавлены тесты счётчиков; в outage-alert
литералы Provs получили codex-записи.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git add src/common/services/user-llm-provider.service.ts
git commit -m "$(cat <<'EOF'
docs(llm): codex в комментариях user-llm-provider.service

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest src/monitoring/claude-health.alert-line.spec.ts src/monitoring/relay-qwen-monitor.service.spec.ts src/monitoring/claude-health.outage-alert.spec.ts 2>&1 | tail -10"
```

Expected: все три спека PASS.

---

### Task 8: Админ-контроллеры — codex в configured() (TDD)

**Files:**
- Modify: `spirits_back/src/admin/admin-global-llm.controller.ts`, `spirits_back/src/admin/admin-llm-provider.controller.ts`
- Test: `spirits_back/src/admin/admin-global-llm.controller.spec.ts`, `spirits_back/src/admin/admin-llm-provider.controller.spec.ts`

Тексты 400-ошибок (`provider: 'claude' | 'qwen' | ...`) собираются через `.map` по ANSWER_PROVIDERS/LLM_CHOICES и получают codex автоматически; 409 no_key — генерик. Вручную правится только `configured()`.

#### Шаг A — красные тесты

- [ ] **Step 1: admin-global-llm.controller.spec.ts**

1. `const OLD = { qwen: ..., kimi: ... };` (~L17) → добавить `codex: process.env.CODEX_FALLBACK_API_KEY,`.
2. Хелпер `keys(qwen, kimi)` (~L18–21) → `keys(qwen: boolean, kimi: boolean, codex = false)`; внутри добавить строку по образцу kimi: если `codex` — `process.env.CODEX_FALLBACK_API_KEY = 'local-bridge'`, иначе `delete process.env.CODEX_FALLBACK_API_KEY`.
3. В `afterEach` (~L22–28) добавить восстановление CODEX_FALLBACK_API_KEY по образцу строки kimi (из `OLD.codex`).
4. Литералы `configured` в ожиданиях ответов (~L41, L54, L124): `{ qwen: true, kimi: false }` → `{ qwen: true, kimi: false, codex: false }`.
5. Ожидание 400 (~L83): `{ error: "provider: 'claude' | 'qwen' | 'kimi'" }` → `{ error: "provider: 'claude' | 'qwen' | 'kimi' | 'codex'" }`.
6. После теста про 409 no_key (~L76) добавить два теста:
   ```ts
     it('POST codex без ключа — 409 no_key, ничего не пишет', async () => {
       keys(true, false);
       const svc = { status: jest.fn(), set: jest.fn() };
       const res = mkRes();
       await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'codex' }, res);
       expect(res.status).toHaveBeenCalledWith(409);
       expect(res.json).toHaveBeenCalledWith({ error: 'no_key', provider: 'codex' });
       expect(svc.set).not.toHaveBeenCalled();
     });

     it('POST codex с ключом — 200, лог и сообщение в группу с меткой Codex', async () => {
       keys(true, false, true);
       const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
       const svc = { status: jest.fn(async () => status('codex')), set: jest.fn(async () => ({ previous: 'claude' })) };
       const res = mkRes();
       await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'codex' }, res);
       expect(svc.set).toHaveBeenCalledWith('codex', 'admin-1');
       expect(res.status).toHaveBeenCalledWith(200);
       expect(res.json).toHaveBeenCalledWith({ ...status('codex'), configured: { qwen: true, kimi: false, codex: true } });
       expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('admin-1: claude → codex');
       expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
       expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('Модель ответов для всех: Codex');
     });
   ```
   (Имена `mkRes`, `status`, `keys`, моки `Logger`/`sendTelegramAlert` — уже есть в файле.)

- [ ] **Step 2: admin-llm-provider.controller.spec.ts**

1. `OLD` (~L20) → + `codex: process.env.CODEX_FALLBACK_API_KEY,`.
2. `keys(qwen, kimi)` (~L22–25) → третий параметр `codex = false`, строка set/delete `CODEX_FALLBACK_API_KEY = 'local-bridge'` по образцу kimi.
3. `afterEach` (~L26–29) → + восстановление codex из OLD.
4. Литералы `configured` (~L44 `{qwen:true,kimi:false}`, ~L54 `{qwen:false,kimi:false}`, ~L66 `{qwen:false,kimi:true}`, ~L119 `{qwen:true,kimi:false}`, ~L130 `{qwen:false,kimi:false}`) → в каждый добавить `codex: false`.
5. Ожидание 400 (~L75): `{ error: "provider: 'default' | 'claude' | 'qwen' | 'kimi'" }` → `{ error: "provider: 'default' | 'claude' | 'qwen' | 'kimi' | 'codex'" }`.
6. После теста «POST kimi...» (~L68) добавить:
   ```ts
     it('POST codex: сохраняет и отдаёт новое значение', async () => {
       keys(false, false, true);
       const svc = { get: jest.fn(), set: jest.fn(async () => true) };
       const res = mkRes();
       await new AdminLlmProviderController(svc as any, global as any).set('u-1', { userId: 'admin-1' }, { provider: 'codex' }, res);
       expect(svc.set).toHaveBeenCalledWith('u-1', 'codex');
       expect(res.status).toHaveBeenCalledWith(200);
       expect(res.json).toHaveBeenCalledWith({
         userId: 'u-1', provider: 'codex', effective: 'codex', global: 'claude', qwenConfigured: false, configured: { qwen: false, kimi: false, codex: true },
       });
     });
   ```

- [ ] **Step 3: Commit красного, прогон на ноде — FAIL**

```bash
cd ~/Downloads/spirits_back
git add src/admin/admin-global-llm.controller.spec.ts src/admin/admin-llm-provider.controller.spec.ts
git commit -m "$(cat <<'EOF'
test(admin): codex в переключателях (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest src/admin/admin-global-llm.controller.spec.ts src/admin/admin-llm-provider.controller.spec.ts 2>&1 | tail -25"
```

Expected: FAIL (в ответах `configured` без codex, строка 400 без `| 'codex'`).

#### Шаг B — фикс

- [ ] **Step 4: admin-global-llm.controller.ts — configured()**

Заменить (~L65–68):

```ts
function configured(): { qwen: boolean; kimi: boolean } {
  const c = readFallbackConfigs();
  return { qwen: c.qwen !== null, kimi: c.kimi !== null };
}
```

на:

```ts
function configured(): { qwen: boolean; kimi: boolean; codex: boolean } {
  const c = readFallbackConfigs();
  return { qwen: c.qwen !== null, kimi: c.kimi !== null, codex: c.codex !== null };
}
```

- [ ] **Step 5: admin-llm-provider.controller.ts — configured в body()**

Заменить (~L72):

```ts
  const configured = { qwen: configs.qwen !== null, kimi: configs.kimi !== null };
```

на:

```ts
  const configured = { qwen: configs.qwen !== null, kimi: configs.kimi !== null, codex: configs.codex !== null };
```

- [ ] **Step 6: Прогон на ноде — PASS + tsc; commit**

```bash
cd ~/Downloads/spirits_back
git add src/admin/admin-global-llm.controller.ts src/admin/admin-llm-provider.controller.ts
git commit -m "$(cat <<'EOF'
feat(admin): codex в configured() обоих контроллеров

Тексты 400 и проверка 409 no_key — генерики над ANSWER_PROVIDERS,
подхватили codex без правок.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
SHA=$(git -C ~/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest src/admin/admin-global-llm.controller.spec.ts src/admin/admin-llm-provider.controller.spec.ts 2>&1 | tail -10 && npx tsc -p tsconfig.build.json --noEmit && echo TSC-OK"
```

Expected: оба спека PASS, `TSC-OK` (теперь — полный гейт: admin и llm-fallback обязаны компилироваться).

---

### Task 9: Реестр релея — codex четвёртым запасным (TDD)

**Files:**
- Modify: `spirits_back/relay-agent/llm-fallback.mjs`
- Test: `spirits_back/relay-agent/llm-fallback.test.mjs`

Прогон — локально на маке (`node --test`), ssh не нужен. `readProviderConfig`, `readProviderConfigs`, `anyConfigured`, `parseSelected`, `isEmergency`, `modelFor`, `withModel`, `providerSpawnEnv`, `planProviders`, `stats` — генерики над `FALLBACK_ORDER`, правится только реестр.

#### Шаг A — красные тесты

- [ ] **Step 1: Правки llm-fallback.test.mjs**

1. После `const KIMI_MODELS = ...` (~L6) добавить:
   ```js
   const CODEX_MODELS = { opus: "gpt-6-astra", sonnet: "gpt-6-astra", haiku: "gpt-6-astra" };
   ```
2. После kimi-теста `readProviderConfig` (~L22–27) добавить:
   ```js
   test("readProviderConfig: Codex — локальный мост, gpt-6-astra, ключ secrets/codex.key", () => {
     let asked;
     const cfg = l.readProviderConfig("codex", {}, (p) => { asked = p; return "local-bridge"; });
     assert.equal(asked, "/home/dv/file-agent/secrets/codex.key");
     assert.deepEqual(cfg, { name: "codex", apiKey: "local-bridge", baseUrl: "http://127.0.0.1:8790", models: CODEX_MODELS });
   });
   ```
3. В тесте `readProviderConfigs` (~L39–45, readFile возвращает `"k"` только для kimi.key, остальное — ENOENT) добавить ожидание:
   ```js
     assert.equal(cfgs.codex, null);
   ```
4. В тесте `parseSelected`/`isEmergency` (~L56–64) добавить:
   ```js
     assert.equal(l.parseSelected("codex"), "codex");
     assert.equal(l.isEmergency("codex", "codex"), false);
     assert.equal(l.isEmergency("qwen", "codex"), true);
   ```
5. В тесте `modelFor` (~L66–72) добавить:
   ```js
     for (const req of ["default", "sonnet", "haiku"]) assert.equal(l.modelFor(req, CODEX_MODELS), "gpt-6-astra");
   ```
6. После теста «planProviders: выбран Kimi, окно Claude открыто...» (~L303) добавить (существующие тесты planProviders НЕ менять: их литералы `both` без codex-ключа — в JS отсутствие ключа = провайдер не настроен, ожидания остаются верными):
   ```js
   test("planProviders: Codex настроен — четвёртое звено цепочки", () => {
     const cfg = (name) => ({ name, apiKey: "k", baseUrl: "u", models: KIMI_MODELS });
     const all = { qwen: cfg("qwen"), kimi: cfg("kimi"), codex: cfg("codex") };
     assert.deepEqual(l.planProviders({ cfgs: all, state: l.createFallbackState(), now: 10_000 }), ["claude", "qwen", "kimi", "codex"]);
   });

   test("planProviders: выбран Codex — сначала он, затем обычный путь без него", () => {
     const cfg = (name) => ({ name, apiKey: "k", baseUrl: "u", models: KIMI_MODELS });
     const all = { qwen: cfg("qwen"), kimi: cfg("kimi"), codex: cfg("codex") };
     assert.deepEqual(l.planProviders({ selected: "codex", cfgs: all, state: l.createFallbackState(), now: 10_000 }), ["codex", "claude", "qwen", "kimi"]);
   });
   ```
7. В тесте «stats и legacyQwenHealth» (~L364–367) ожидание `st.providers` → добавить третью запись:
   ```js
     assert.deepEqual(st.providers, {
       qwen: { enabled: true, ok: 0, failed: 1, downUntil: 61_000 },
       kimi: { enabled: false, ok: 1, failed: 0, downUntil: 0 },
       codex: { enabled: false, ok: 0, failed: 0, downUntil: 0 },
     });
   ```

- [ ] **Step 2: Прогнать — красный; commit**

```bash
cd ~/Downloads/spirits_back && node --test relay-agent/llm-fallback.test.mjs 2>&1 | tail -20
```

Expected: новые тесты FAIL (`readProviderConfig` для codex возвращает null/кидает, planProviders без codex, stats без codex-записи).

```bash
git add relay-agent/llm-fallback.test.mjs
git commit -m "$(cat <<'EOF'
test(relay): codex в реестре релея (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

#### Шаг B — фикс

- [ ] **Step 3: Правки llm-fallback.mjs**

1. Шапка-комментарий (L1–6): `provider=qwen|kimi` → `provider=qwen|kimi|codex`; «аварийная цепочка Claude → Qwen → Kimi» → «Claude → Qwen → Kimi → Codex»; в список спецификаций дописать `2026-11-14-codex-provider-design.md`.
2. `export const FALLBACK_ORDER = Object.freeze(["qwen", "kimi", "codex"]);`
3. В `PROVIDER_LABELS` добавить `codex: "Codex"`.
4. В `PROVIDER_DEFAULTS` после kimi добавить:
   ```js
     // Локальный codex-bridge (spec 2026-11-14): ключ-заглушка local-bridge —
     // мост аутентифицируется сам через ~/.codex/auth.json (подписка ChatGPT Pro).
     codex: Object.freeze({
       envPrefix: "CODEX",
       keyFile: "/home/dv/file-agent/secrets/codex.key",
       baseUrl: "http://127.0.0.1:8790",
       models: Object.freeze({ opus: "gpt-6-astra", sonnet: "gpt-6-astra", haiku: "gpt-6-astra" }),
     }),
   ```
5. `export const NO_CONFIGS = Object.freeze({ qwen: null, kimi: null, codex: null });`

- [ ] **Step 4: Прогнать — зелёный; commit**

```bash
node --test relay-agent/llm-fallback.test.mjs 2>&1 | tail -8    # pass, fail 0
git add relay-agent/llm-fallback.mjs
git commit -m "$(cat <<'EOF'
feat(relay): codex — четвёртый запасной на релее

Ключ-заглушка в /home/dv/file-agent/secrets/codex.key включает провайдер
без рестарта file-agent; переименование файла — выключает.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 10: Локали — ключи codex в ru/en/pt

**Files:**
- Modify: `spirits_front/src/i18n/locales/ru.json`, `en.json`, `pt.json`

Префикс `admin.*` входит в `UNTRANSLATED_PREFIXES` фронт-чеков — по прецеденту kimi ключи добавляются ТОЛЬКО в ru/en/pt (в de/es/fr/zh ключей llmProvider/globalLlm нет вовсе). Локали идут РАНЬШЕ фронта (Task 11), чтобы `check-keys-exist` не краснел между коммитами.

- [ ] **Step 1: Добавить ключи (по три файла)**

В объект `admin.userActivity.llmProvider`:
- рядом с ключом `"kimi"` (найти: `grep -n '"kimi"' src/i18n/locales/ru.json`) добавить:
  ```json
        "codex": "Codex (GPT-6 Astra)",
  ```
- сразу после `"noKeyKimi"` (ru L996, en L991, pt L1013→954) добавить:
  - ru: `"noKeyCodex": "Ключ Codex на сервере не настроен — ответы пойдут через Claude.",`
  - en: `"noKeyCodex": "Codex key is not configured on the server — answers will go through Claude.",`
  - pt: `"noKeyCodex": "A chave do Codex não está configurada no servidor — as respostas irão pelo Claude.",`

В объект `admin.globalLlm` сразу после `"confirmKimiTraining"` (ru L1055, en L1050, pt L1013) добавить:
- ru:
  ```json
      "codexEmergencyOnly": "только аварийно",
      "confirmCodexEmergency": "Codex работает на личной подписке ChatGPT Pro владельца — переключайте только аварийно.",
  ```
- en:
  ```json
      "codexEmergencyOnly": "emergency only",
      "confirmCodexEmergency": "Codex runs on the owner's personal ChatGPT Pro subscription — switch only in an emergency.",
  ```
- pt:
  ```json
      "codexEmergencyOnly": "apenas emergência",
      "confirmCodexEmergency": "O Codex funciona com a subscrição pessoal ChatGPT Pro do proprietário — mude apenas em caso de emergência.",
  ```

Соблюсти JSON-синтаксис: если строка-якорь была последней в объекте (без запятой) — добавить запятую ей, а у последней новой строки запятой не ставить.

- [ ] **Step 2: Валидация**

```bash
cd ~/Downloads/spirits_front
for f in ru en pt; do node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/$f.json','utf8')); console.log('$f OK')"; done
node scripts/check-locales.mjs && node scripts/check-keys-exist.mjs
```

Expected: `ru OK en OK pt OK`, оба чека зелёные. (`check-locale-format` НЕ запускать — он красный на main, известное.)

- [ ] **Step 3: Commit (в репо spirits_front)**

```bash
git status --porcelain && git branch --show-current
git add src/i18n/locales/ru.json src/i18n/locales/en.json src/i18n/locales/pt.json
git commit -m "$(cat <<'EOF'
feat(i18n): ключи codex в ru/en/pt

Метка модели, предупреждение «нет ключа», метка «только аварийно» и
текст подтверждения для глобального рубильника. de/es/fr/zh — по
прецеденту kimi (префикс admin.* в UNTRANSLATED_PREFIXES).

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 11: Фронт — codex в обоих переключателях (TDD)

**Files:**
- Modify: `spirits_front/src/components/admin/globalLlm.ts`, `GlobalLlmProviderControl.tsx`, `UserLlmProviderControl.tsx`, `UserActivityDrawer.tsx` (комментарий L471)
- Test: `globalLlm.test.ts`, `GlobalLlmProviderControl.test.tsx`, `UserLlmProviderControl.test.tsx`, `GlobalLlmBanner.test.tsx`

`GlobalLlmBanner.tsx` не меняется — метку он берёт из `PROVIDER_LABELS`. Запуск vitest — на маке под Node 22.

#### Шаг A — красные тесты

- [ ] **Step 1: globalLlm.test.ts** — в тест «известные модели проходят как есть» добавить:
  ```ts
    expect(parseProvider('codex')).toBe('codex');
  ```

- [ ] **Step 2: GlobalLlmProviderControl.test.tsx**

1. Хелпер state (~L34–35) → codex ВТОРЫМ параметром (никто из существующих вызовов не передаёт `since` позиционно — безопасно):
   ```ts
   const state = (provider: string, kimi = false, codex = false, since: string | null = '2026-10-31T13:40:00.000Z') =>
     ok({ provider, since, by: 'admin-1', configured: { qwen: true, kimi, codex } });
   ```
2. Тест «три варианта...» (~L67): заголовок → «четыре варианта, текущий выбран; GET общего рубильника»; `toHaveLength(3)` → `toHaveLength(4)`.
3. Добавить четыре теста (в конец describe):
   ```tsx
     it('Codex без ключа — недоступен и помечен', async () => {
       get.mockResolvedValue(state('claude'));
       await mount();
       expect(radio('Codex (GPT-6 Astra)').disabled).toBe(true);
       expect(radio('Codex (GPT-6 Astra)').textContent).toContain('нет ключа на сервере');
     });

     it('Codex с ключом — доступен и помечен «только аварийно»', async () => {
       get.mockResolvedValue(state('claude', false, true));
       await mount();
       const codex = radio('Codex (GPT-6 Astra)');
       expect(codex.disabled).toBe(false);
       expect(codex.textContent).toContain('только аварийно');
     });

     it('confirm для Codex — предупреждение про подписку владельца', async () => {
       get.mockResolvedValue(state('claude', false, true));
       const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
       await mount();
       await act(async () => { radio('Codex (GPT-6 Astra)').click(); });
       expect(confirm).toHaveBeenCalledTimes(1);
       expect(confirm.mock.calls[0][0]).toContain('Codex работает на личной подписке ChatGPT Pro владельца — переключайте только аварийно.');
       expect(post).not.toHaveBeenCalled();
     });

     it('переключение на Codex — POST и событие смены', async () => {
       get.mockResolvedValue(state('claude', false, true));
       post.mockResolvedValue(state('codex', false, true));
       vi.spyOn(window, 'confirm').mockReturnValue(true);
       const seen = vi.fn();
       onGlobalLlmEvent(seen);
       await mount();
       await act(async () => { radio('Codex (GPT-6 Astra)').click(); });
       await settle();
       expect(post).toHaveBeenCalledWith('/webhook/admin/llm-provider', { provider: 'codex' });
       expect(radio('Codex (GPT-6 Astra)').getAttribute('aria-checked')).toBe('true');
       expect(seen).toHaveBeenCalledTimes(1);
     });
   ```

- [ ] **Step 3: UserLlmProviderControl.test.tsx**

1. Хелпер state (~L39–40) → codex ПОСЛЕДНИМ параметром (защищает позиционные вызовы L75/L83/L93/L181/L221–222):
   ```ts
   const state = (provider: string, qwen = true, kimi = true, userId = 'u-1', global = 'claude', effective?: string, codex = true) =>
     ok({ userId, provider, effective: effective ?? (provider === 'default' ? global : provider), global, qwenConfigured: qwen, configured: { qwen, kimi, codex } });
   ```
2. Тест «четыре варианта...» (~L63): заголовок → «пять вариантов; показывает текущий выбор»; `toHaveLength(4)` → `toHaveLength(5)`.
3. Добавить четыре теста (в конец describe; `radio()` ищет по `startsWith` — имя кнопки начинается с метки):
   ```tsx
     it('переключение на Codex сохраняется сразу', async () => {
       get.mockResolvedValue(state('claude'));
       post.mockResolvedValue(state('codex'));
       await mount();
       await act(async () => { radio('Codex (GPT-6 Astra)').click(); });
       await settle();
       expect(post).toHaveBeenCalledWith('/webhook/admin/users/u-1/llm-provider', { provider: 'codex' });
       expect(radio('Codex (GPT-6 Astra)').getAttribute('aria-checked')).toBe('true');
     });

     it('вариант Codex без ключа помечен «нет ключа»', async () => {
       get.mockResolvedValue(state('claude', true, true, 'u-1', 'claude', undefined, false));
       await mount();
       expect(radio('Codex (GPT-6 Astra)').textContent).toContain('нет ключа');
       expect(container.textContent).not.toContain('на сервере не настроен');
     });

     it('выбран Codex без ключа — предупреждение про Codex', async () => {
       get.mockResolvedValue(state('codex', true, true, 'u-1', 'claude', undefined, false));
       await mount();
       expect(container.textContent).toContain('Ключ Codex на сервере не настроен');
     });

     it('Codex выбран — подсказка про ответ Claude', async () => {
       get.mockResolvedValue(state('codex'));
       await mount();
       expect(container.textContent).toContain('Если выбранная модель не ответит, ответит Claude.');
     });
   ```

- [ ] **Step 4: GlobalLlmBanner.test.tsx** — добавить тест (компонент не меняется, тест зелёный только после фикса globalLlm.ts):
  ```tsx
    it('рубильник на Codex — плашка с моделью', async () => {
      get.mockResolvedValue(ok({ provider: 'codex', since: '2026-11-14T10:00:00.000Z', by: 'admin-1', configured: { qwen: true, kimi: true, codex: true } }));
      await mount();
      expect(banner()!.textContent).toContain('Codex (GPT-6 Astra)');
    });
  ```

- [ ] **Step 5: Прогнать — красный; commit**

```bash
cd ~/Downloads/spirits_front
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null
pnpm vitest run src/components/admin/globalLlm.test.ts src/components/admin/GlobalLlmProviderControl.test.tsx src/components/admin/UserLlmProviderControl.test.tsx src/components/admin/GlobalLlmBanner.test.tsx 2>&1 | tail -25
```

Expected: FAIL (нет codex в PROVIDERS — 3/4 кнопки вместо 4/5; parseProvider('codex') → 'claude'; плашка Banner не появляется).

```bash
git status --porcelain && git branch --show-current
git add src/components/admin/globalLlm.test.ts src/components/admin/GlobalLlmProviderControl.test.tsx src/components/admin/UserLlmProviderControl.test.tsx src/components/admin/GlobalLlmBanner.test.tsx
git commit -m "$(cat <<'EOF'
test(admin-ui): codex в переключателях модели (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

#### Шаг B — фикс

- [ ] **Step 6: globalLlm.ts**

1. L6: `export type AnswerProvider = 'claude' | 'qwen' | 'kimi' | 'codex';`
2. L7: `export const PROVIDERS: readonly AnswerProvider[] = ['claude', 'qwen', 'kimi', 'codex'];`
3. L8: `export const PROVIDER_LABELS: Record<AnswerProvider, string> = { claude: 'Claude', qwen: 'Qwen', kimi: 'Kimi', codex: 'Codex (GPT-6 Astra)' };`
4. parseProvider (L11–13):
   ```ts
   export function parseProvider(v: unknown): AnswerProvider {
     return v === 'qwen' || v === 'kimi' || v === 'codex' || v === 'claude' ? v : 'claude';
   }
   ```
5. L19: `configured: { qwen: boolean; kimi: boolean; codex: boolean };`
6. toGlobalState (L31): `configured: { qwen: j?.configured?.qwen === true, kimi: j?.configured?.kimi === true, codex: j?.configured?.codex === true },`

- [ ] **Step 7: GlobalLlmProviderControl.tsx**

1. В `choose()` после kimi-ветки (L67–69) добавить:
   ```tsx
      // Codex работает на личной подписке ChatGPT Pro владельца — запасной
      // только на крайний случай (правило: глобальный рубильник на codex не ставится).
      if (p === 'codex') {
        message += ' ' + t('admin.globalLlm.confirmCodexEmergency', 'Codex работает на личной подписке ChatGPT Pro владельца — переключайте только аварийно.');
      }
   ```
2. В рендере кнопки после span «нет ключа на сервере» (L141–145) добавить:
   ```tsx
                {p === 'codex' && available(p) && (
                  <span className="ml-1 text-xs opacity-75">
                    <span aria-hidden="true">·</span> {t('admin.globalLlm.codexEmergencyOnly', 'только аварийно')}
                  </span>
                )}
   ```

- [ ] **Step 8: UserLlmProviderControl.tsx**

1. toState (L30): `j?.provider === 'claude' || j?.provider === 'qwen' || j?.provider === 'kimi' || j?.provider === 'codex' ? j.provider : 'default'`
2. toState (L33): `{ qwen: j.configured.qwen === true, kimi: j.configured.kimi === true, codex: j.configured.codex === true }`
3. toState (L34): `: { qwen: j?.qwenConfigured === true, kimi: false, codex: false },`
4. label() (L110–115) — перед финальным `return ... kimi` вставить:
   ```tsx
    if (c === 'codex') return t('admin.userActivity.llmProvider.codex', 'Codex (GPT-6 Astra)');
   ```
5. noKeyWarning (L117–119) → трёхветочный:
   ```tsx
  const noKeyWarning = (p: Alt) => (p === 'qwen'
    ? t('admin.userActivity.llmProvider.noKey', 'Ключ Qwen на сервере не настроен — ответы пойдут через Claude.')
    : p === 'kimi'
      ? t('admin.userActivity.llmProvider.noKeyKimi', 'Ключ Kimi на сервере не настроен — ответы пойдут через Claude.')
      : t('admin.userActivity.llmProvider.noKeyCodex', 'Ключ Codex на сервере не настроен — ответы пойдут через Claude.'));
   ```
6. showFallbackHint (L125–128): `state.provider === 'qwen' || state.provider === 'kimi' || state.provider === 'codex'`
7. L166: `{(c === 'qwen' || c === 'kimi' || c === 'codex') && !state.configured[c] && (`
8. L174: `{(state.provider === 'qwen' || state.provider === 'kimi' || state.provider === 'codex') && !state.configured[state.provider] && (`

- [ ] **Step 9: UserActivityDrawer.tsx (L471) — комментарий**

`{/* Модель ответов ассистентов этому человеку — Claude, Qwen или Kimi. */}` → `{/* Модель ответов ассистентов этому человеку — Claude, Qwen, Kimi или Codex. */}`

- [ ] **Step 10: Прогнать — зелёный; чеки i18n; commit**

```bash
cd ~/Downloads/spirits_front
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null
pnpm vitest run src/components/admin/globalLlm.test.ts src/components/admin/GlobalLlmProviderControl.test.tsx src/components/admin/UserLlmProviderControl.test.tsx src/components/admin/GlobalLlmBanner.test.tsx 2>&1 | tail -10
node scripts/check-keys-exist.mjs && node scripts/check-locales.mjs
```

Expected: все тесты PASS, чеки зелёные.

```bash
git add src/components/admin/globalLlm.ts src/components/admin/GlobalLlmProviderControl.tsx src/components/admin/UserLlmProviderControl.tsx src/components/admin/UserActivityDrawer.tsx
git commit -m "$(cat <<'EOF'
feat(admin-ui): codex в глобальном и личном переключателях

Метка «Codex (GPT-6 Astra)», у рубильника — отметка «только аварийно» и
предупреждение в confirm (правило: глобальный рубильник на codex не
ставится); в карточке пользователя — обычный вариант с предупреждением
«нет ключа» по образцу Kimi.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 12: scripts/codex-fallback-check.js — живая проверка цепочки

**Files:**
- Create: `spirits_back/scripts/codex-fallback-check.js` (копия `scripts/llm-fallback-check.js` с правками)

Скрипт НЕ запускается во время задач (тратит квоту ChatGPT Pro и требует собранного клона + поднятого моста на сервере) — локально только `node --check`. Живой прогон — шаг 2/3 runbook (ровно один раз, с OK).

- [ ] **Step 1: Скопировать и применить правки**

```bash
cd ~/Downloads/spirits_back
cp scripts/llm-fallback-check.js scripts/codex-fallback-check.js
```

Правки в копии:

1. Шапка (комментарий L2–9 и gate L15–19) — заменить на:
   ```js
   // Живая проверка цепочки запасных ClaudeCliService через Codex: настоящий
   // claude, codex-bridge на 127.0.0.1:8790, без выката. Запуск — НА СЕРВЕРЕ с
   // поднятым мостом, из корня собранного клона (npm run build):
   //   CODEX_FALLBACK_API_KEY=local-bridge node scripts/codex-fallback-check.js
   // Qwen и Kimi принудительно выключаются на время проверок (withKeys), чтобы
   // ответ гарантированно шёл через Codex. Ключ-заглушка local-bridge: мост
   // аутентифицируется сам через ~/.codex/auth.json (подписка ChatGPT Pro).
   // Claude «ломается» пустым CLAUDE_CONFIG_DIR (вход не найден → auth); боевые
   // креды не трогаются.
   ```
   и gate:
   ```js
   if (!process.env.CODEX_FALLBACK_API_KEY) {
     console.error('нет CODEX_FALLBACK_API_KEY');
     process.exit(2);
   }
   ```
   строку `const HAS_QWEN = ...` удалить.
2. `counts()` — заменить тело на:
   ```js
     return { codexOk: p.codex.ok, codexFailed: p.codex.failed };
   ```
3. `const NO_QWEN = { QWEN_FALLBACK_API_KEY: undefined };` — заменить на:
   ```js
   const NO_OTHERS = { QWEN_FALLBACK_API_KEY: undefined, KIMI_FALLBACK_API_KEY: undefined };
   ```
4. Пять проверок в `try { ... }` (L143–231) — заменить на (scrub, breaker, cfgDir, dist, RAW_CLI_TEXT, withKeys, PNG-энкодер, finally/печать/exit — БЕЗ изменений):
   ```js
    await check('Qwen и Kimi выключены: json, haiku-класс → Codex', ['codexOk'], () => withKeys(NO_OTHERS, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 120000 });
      return `«${r.text}», $${r.costUsd}`;
    }));

    await check('Qwen и Kimi выключены: stream-json + Read в своём cwd → Codex', ['codexOk'], () => withKeys(NO_OTHERS, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-cwd-'));
      try {
        fs.writeFileSync(path.join(dir, 'note.txt'), 'Кодовое слово: черёмуха-47\n');
        const tools = [];
        const r = await svc.textWithCost('Прочитай файл note.txt инструментом Read и назови кодовое слово. Ответь только словом.', {
          model: 'claude-opus-5-5', cwd: dir, tools: 'Read', timeoutMs: 180000,
          onProgress: (e) => tools.push(e.name),
        });
        if (!/черёмуха-47/.test(r.text)) throw new Error(`не то слово: ${r.text}`);
        return `«${r.text}», инструменты: ${tools.join(',') || '—'}`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }));

    await check('сведения: вложение-картинка → Codex (best-effort input_image)', ['codexOk'], () => withKeys(NO_OTHERS, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-img-'));
      const imgPath = path.join(dir, 'red.png');
      try {
        fs.writeFileSync(imgPath, makeRedPng());
        const r = await svc.textWithCost('Какого цвета картинка во вложении? Ответь одним словом.', {
          model: 'claude-opus-5-5', attachments: [imgPath], onProgress: () => {}, timeoutMs: 180000,
        });
        if (!/красн|red/i.test(r.text)) throw new Error(`не то: ${r.text}`);
        return `«${r.text}»`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }), true);

    await check('выбран Codex → ответ без аварийного счёта', [], () => withKeys(NO_OTHERS, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-opus-5-5', provider: 'codex', timeoutMs: 120000 });
      if (!r.text.trim()) throw new Error('пустой ответ');
      return `«${r.text}» (Claude сломан — ответить мог только Codex)`;
    }));

    await check('noFallback (проба живости) обязана упасть на Claude', [], async () => {
      let text;
      try {
        text = await svc.text('Reply with exactly: ok', { model: 'claude-haiku-4-5', timeoutMs: 60000, noFallback: true });
      } catch (e) {
        const m = String(e.message);
        if (!/^claude CLI /.test(m) || RAW_CLI_TEXT.test(m)) throw new Error(`не тот текст ошибки пробы: ${m.slice(0, 200)}`);
        if (!(e instanceof ClaudeCliCallError) || !e.kind) throw new Error(`у ошибки пробы нет признаков: ${e && e.name}`);
        return `упала, как и должна (${e.kind}): ${m.slice(0, 100)}`;
      }
      throw new Error(`проба прошла — значит, пошла мимо Claude: ${String(text).slice(0, 100)}`);
    });
   ```
   (Счётчики растут только на АВАРИЙНЫХ переходах; явно выбранный провайдер (`provider: 'codex'`) и noFallback счётчики не двигают — поэтому grow `[]`. Блок «выбран Kimi с битым ключом» и HAS_QWEN-блок из копии удалить.)

- [ ] **Step 2: Синтаксис; commit**

```bash
node --check scripts/codex-fallback-check.js && echo SYNTAX-OK
git add scripts/codex-fallback-check.js
git commit -m "$(cat <<'EOF'
feat(scripts): codex-fallback-check — живая проверка цепочки

По образцу llm-fallback-check: Qwen/Kimi принудительно выключены,
проверки json/stream-json+Read/картинка(сведения)/выбранный codex/
noFallback. Запуск только на сервере с поднятым мостом (runbook),
тратит квоту ChatGPT Pro — ровно один раз на выкат.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

### Task 13: keep-alive.sh + runbook выката

**Files:**
- Create: `spirits_back/codex-bridge/keep-alive.sh`
- Create: `spirits_back/docs/superpowers/runbooks/2026-11-14-codex-provider-rollout.md`

- [ ] **Step 1: keep-alive.sh**

```bash
#!/usr/bin/env bash
# Освежитель токена codex (spec 2026-11-14): раз в ~3 дня из cron дёргает
# codex exec тривиальным запросом, чтобы официальный CLI обновил
# access_token в ~/.codex/auth.json. Мост токены не обновляет никогда.
set -euo pipefail
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"
codex exec --model gpt-5.6-luna --sandbox read-only --skip-git-repo-check 'ответь ok' >/dev/null 2>&1 \
  || codex exec --model gpt-5.6-luna --skip-git-repo-check 'ответь ok' >/dev/null 2>&1 \
  || true
```

```bash
cd ~/Downloads/spirits_back
chmod +x codex-bridge/keep-alive.sh
bash -n codex-bridge/keep-alive.sh && echo SYNTAX-OK
```

(Флаги `codex exec` при выкате сверить с `codex exec --help` на сервере — runbook об этом напоминает.)

- [ ] **Step 2: runbook — создать `docs/superpowers/runbooks/2026-11-14-codex-provider-rollout.md`**

````markdown
# Выкат codex-провайдера (GPT-6 Astra) — runbook

Дата: 2026-11-14
Спек: docs/superpowers/specs/2026-11-14-codex-provider-design.md
План: docs/superpowers/plans/2026-11-14-codex-provider.md

Правила на весь выкат:
- Каждый шаг — только с явным OK владельца.
- Рестарты (linkeon-api, file-agent, codex-bridge) — при нуле активных стримов.
- Ключи и токены не печатать; передача значений — только через stdin.
- ~/.codex/auth.json — только читать; мост и скрипты токены НЕ обновляют.
- Live-проверки тратят квоту ChatGPT Pro — каждую выполнять ровно один раз.

## Шаг 1. Код (test → prod)
1. Убедиться, что T1–T13 влиты в main обоих репо (spirits_back, spirits_front).
2. `bash ~/Downloads/spirits_back/scripts/deploy.sh` (с мака; с ноды — `~/dev/spirits_back/scripts/deploy.sh`) — двухфазный test → smoke → prod → smoke. codex-bridge/ уезжает вместе с бэком (деплой git-based).
3. На test-ноде цепочка останется Claude → Qwen → Kimi: CODEX_FALLBACK_API_KEY там НЕ заводится (сознательно — smoke deploy.sh должен пройти без codex).
4. Релей (вручную):
   - скопировать `codex-bridge/` из spirits_back в `/home/dv/file-agent/codex-bridge/` (bridge.mjs, translate.mjs, sse.mjs, keep-alive.sh);
   - обновлённый `relay-agent/llm-fallback.mjs` закоммитить как dv в живой ветке `reconcile/agent-versioned-live-part-b`;
   - на релее: `node --check` каждого .mjs, `node --test` для llm-fallback.test.mjs и `node --test codex-bridge/*.test.mjs` → 44 pass (ловит порчу при копировании);
   - `pm2 restart file-agent` — при нуле стримов, с OK; после — `pm2 status` и журнал без ошибок.

## Шаг 2. Сервер бэкенда (dvolkov@212.113.106.202)
1. Закрепить CLI: `npm i -g @openai/codex@0.154.0`; `codex --version`; флаги освежителя сверить с `codex exec --help`.
2. Логин владельца: на маке `ssh -L 1455:localhost:1455 dvolkov@212.113.106.202`, на сервере `codex login` — владелец одобряет в браузере САМ (пароль/2FA не трогать). Проверка: `test -r ~/.codex/auth.json && echo OK` (содержимое не выводить).
3. Smoke сосуществования: один короткий `codex exec` (gpt-5.6-luna, read-only) на сервере; на маке убедиться, что роутер жив: `curl -s http://127.0.0.1:8788/healthz` → {"ok":true}.
4. Поднять мост: `cd /home/dvolkov/spirits_back && node --test codex-bridge/*.test.mjs` → 44 pass / 0 fail (ловит порчу при выкате и версию Node), затем `cd codex-bridge && pm2 start bridge.mjs --name codex-bridge && pm2 save`. Запускать из оболочки, где НЕ экспортированы `BRIDGE_PORT`/`BRIDGE_LOG_PATH` (имена без префикса — чужая переменная окружения молча переставит мост; pm2 наследует env оболочки при первом start). Под pm2 мост поднимается благодаря диффу 4 (pm_id) — проверить `pm2 logs codex-bridge --lines 20` на строку listen.
5. `curl -s http://127.0.0.1:8790/healthz` → {"ok":true}. Ходить ТОЛЬКО на `127.0.0.1`, не на `localhost`: мост слушает IPv4 и требует Host буквально `127.0.0.1:<port>` (иначе 421), а `localhost` на Node ≥17 резолвится в `::1` первым → ECONNREFUSED.
6. Один живой smoke через мост (РОВНО РАЗ): `curl -sS http://127.0.0.1:8790/v1/messages -H 'content-type: application/json' -d '{"model":"gpt-6-astra","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"ответь ok"}]}'` → SSE с stop_reason end_turn.
7. Ключ-заглушка в .env бэка (через stdin, не печатая): добавить строку `CODEX_FALLBACK_API_KEY=local-bridge`.
8. Перезапуск API: `BACK_ONLY=1 bash ~/Downloads/spirits_back/scripts/deploy.sh` (с мака) — при нуле стримов, с OK.
9. Cron-освежитель: `crontab -e` → `0 4 */3 * * /home/dvolkov/spirits_back/codex-bridge/keep-alive.sh`; проверить, что `crontab -l` содержит строку. Ротация журнала моста (`~/.linkeon/logs/codex-bridge.log`, ~150 Б на строку, строка на запрос): ротация у моста отсутствует — либо logrotate строго в режиме `copytruncate` (обычный create/move тихо унесёт fd, и журнал продолжит писаться в ротированный файл до рестарта), либо сознательно принять неограниченный рост с периодической проверкой места (на серверах был инцидент DiskFull 27.10).
10. Живая проверка цепочки (РОВНО РАЗ, с OK): `cd /home/dvolkov/spirits_back && npm run build && CODEX_FALLBACK_API_KEY=local-bridge node scripts/codex-fallback-check.js` → все строки OK (картинка — INFO допустим), exit 0.
11. Мониторинг: в ближайшем health-алерте строка «Codex — ответов N, ошибок M» (до первого хода — «не настроен» сменится после включения ключа).

## Шаг 3. Релей (dv@5.101.115.184) — то же, с поправками
- Туннель и логин: `ssh -L 1455:localhost:1455 dv@5.101.115.184` → `codex login` (одобряет владелец).
- Мост: `cd /home/dv/file-agent/codex-bridge && pm2 start bridge.mjs --name codex-bridge && pm2 save`; healthz. Те же оговорки, что на Шаге 2: чистый env оболочки (нет BRIDGE_PORT/BRIDGE_LOG_PATH), только `127.0.0.1` (не localhost), ротация журнала — только `copytruncate`. Под pm2 мост поднимается благодаря диффу 4 (pm_id).
- Ключ: записать `local-bridge` в `/home/dv/file-agent/secrets/codex.key` через stdin, `chmod 600`. Рестарт file-agent НЕ нужен (readProviderConfig читает файл на каждый запрос).
- Cron: `0 4 */3 * * /home/dv/file-agent/codex-bridge/keep-alive.sh` (от dv).
- Контроль: короткий ход через канал, который обслуживает релей, с личным выбором Codex (шаг 4) — в журнале file-agent провайдер codex.

## Шаг 4. Приёмка владельцем (E2E)
1. Админка → карточка пользователя → «Модель ответов» → Codex (GPT-6 Astra).
2. Короткий вопрос ассистенту → ответ пришёл; в журнале бэка вызов claude_cli_call с provider:'codex'.
3. Вернуть выбор на «Как у всех».
4. Глобальный рубильник: проверить метку «только аварийно» у Codex и предупреждение в confirm. НА Codex рубильник не ставить (правило).

## Откат
- Релей: `mv /home/dv/file-agent/secrets/codex.key /home/dv/file-agent/secrets/codex.key.disabled` — провайдер выключается без рестарта.
- Бэк: убрать `CODEX_FALLBACK_API_KEY` из .env + рестарт API через `BACK_ONLY=1 deploy.sh`.
- Сохранённые личные выборы 'codex' деградируют до Claude автоматически (usable() = false без конфига).
- Полное удаление: `pm2 delete codex-bridge && pm2 save` на обоих серверах; убрать строки cron; владелец может отозвать сессии в аккаунте ChatGPT. Записи в реестрах (FALLBACK_ORDER и др.) можно не удалять — без ключа провайдер не включится.
````

- [ ] **Step 3: Commit**

```bash
cd ~/Downloads/spirits_back
git status --porcelain && git branch --show-current
git add codex-bridge/keep-alive.sh docs/superpowers/runbooks/2026-11-14-codex-provider-rollout.md
git commit -m "$(cat <<'EOF'
docs(codex): runbook выката + keep-alive.sh

Четыре шага выката с OK-гейтами (код → сервер бэка → релей → приёмка
владельцем), cron-освежитель токена и откат без удаления реестров.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
git pull --rebase -q origin main && git push -q origin main
```

---

## Финальная проверка (после всех задач)

- [ ] `cd ~/Downloads/spirits_back && node --test codex-bridge/*.test.mjs relay-agent/llm-fallback.test.mjs` → 44 + relay, fail 0.
- [ ] На ноде (свежий sha main): `npx jest src/common/services/llm-fallback.spec.ts src/admin/admin-global-llm.controller.spec.ts src/admin/admin-llm-provider.controller.spec.ts src/monitoring/claude-health.alert-line.spec.ts src/monitoring/relay-qwen-monitor.service.spec.ts src/monitoring/claude-health.outage-alert.spec.ts` → PASS; `npx tsc -p tsconfig.build.json --noEmit` → OK.
- [ ] `cd ~/Downloads/spirits_front` (Node 22): `pnpm vitest run src/components/admin/` → PASS; `node scripts/check-keys-exist.mjs && node scripts/check-locales.mjs` → зелёные.
- [ ] `node --check scripts/codex-fallback-check.js`, `bash -n codex-bridge/keep-alive.sh`.
- [ ] В обоих репо `git log origin/main -5` — коммиты на месте, рабочих деревьев чистых ничего не осталось.
- [ ] Выкат — ОТДЕЛЬНАЯ процедура по runbook, только с OK владельца. В рамках плана не выполняется.
