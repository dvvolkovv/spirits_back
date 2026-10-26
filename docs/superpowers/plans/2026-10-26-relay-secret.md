# Секрет релея (`X-Agent-Secret`) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** релей принимает ходы только с секретом бэка; без простоя, с режимом наблюдения перед включением отказа.

**Architecture:** бэк собирает заголовок в одном модуле `src/chat/relay-auth.ts` и добавляет его во все шесть вызовов релея; сторож-тест не даёт завести новый вызов без заголовка. Релей проверяет заголовок middleware'ом из `relay-agent/relay-auth.mjs`: список секретов и режим (`log` | `enforce`) — в файлах рядом с `server.mjs`, перечитываются раз в 30 с без рестарта.

**Tech Stack:** NestJS 10 + axios + jest (бэк, `spirits_back/src`), Express 5 + `node:test` (релей, `spirits_back/relay-agent`).

**Спека:** `docs/superpowers/specs/2026-10-26-relay-secret-design.md`.

---

## Как работать по этому плану

- Воркдерево: `~/Downloads/spirits_back/.worktrees/relay-secret`, ветка `feat/relay-secret`. Общие чекауты (`~/Downloads/spirits_back`, `~/Downloads/spirits_front`) не трогать.
- Тесты и `tsc` бэка — только на тестовой ноде: `bash .superpowers/node-run.sh '<команда>'` (прогон идёт на ЗАКОММИЧЕННОМ коммите — коммить перед прогоном). Тесты релея (`node --test`) — тоже через node-run: `bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --test 2>&1 | tail -8'`.
- В GitHub не пушить без OK владельца. Коммиты — по-русски, вторым `-m` строка соавторства.
- Репозиторий публичный: в коммитах и комментариях не описывать, как обойти защиту, и не писать значения секретов.
- Задачи 6–10 трогают серверы — каждая только с явного OK владельца.

## Файлы

| Файл | Что |
|---|---|
| `src/chat/relay-auth.ts` (новый) | `relayAuthHeaders()` — заголовок из `RELAY_SECRET` |
| `src/chat/relay-auth.spec.ts` (новый) | тесты заголовка + сторож вызовов релея |
| `src/chat/chat.service.ts` | 3 вызова: ход, `agentReply`, список файлов сессии |
| `src/chat/chat.controller.ts` | ход с вложениями |
| `src/ask/clean-ask.service.ts` | эфемерный вопрос |
| `src/blog/blog-relay.client.ts` | автоблог |
| `relay-agent/relay-auth.mjs` (новый) | разбор файлов, сравнение, middleware |
| `relay-agent/relay-auth.test.mjs` (новый) | `node:test` на модуль и на настоящем Express |
| `relay-agent/server.mjs` | подключить middleware после `cors()` |
| `relay-agent/keep-warm.sh` | заголовок из файла секретов |
| `relay-agent/.gitignore`, `relay-agent/README.md` | файлы секретов не в git; как менять секрет |

---

### Задача 1: заголовок на бэке

**Files:**
- Create: `src/chat/relay-auth.ts`
- Test: `src/chat/relay-auth.spec.ts`

- [ ] **Шаг 1: тест**

`src/chat/relay-auth.spec.ts`:

```ts
import { Logger } from '@nestjs/common';

describe('relayAuthHeaders', () => {
  const OLD = process.env.RELAY_SECRET;
  afterEach(() => {
    if (OLD === undefined) delete process.env.RELAY_SECRET;
    else process.env.RELAY_SECRET = OLD;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('секрет задан — заголовок X-Agent-Secret с ним', () => {
    process.env.RELAY_SECRET = 's3cr3t';
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({ 'X-Agent-Secret': 's3cr3t' });
  });

  it('пробелы по краям значения не уходят в заголовок', () => {
    process.env.RELAY_SECRET = '  s3cr3t\n';
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({ 'X-Agent-Secret': 's3cr3t' });
  });

  it('секрета нет — пустой объект и одно предупреждение на процесс', () => {
    delete process.env.RELAY_SECRET;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { relayAuthHeaders } = require('./relay-auth');
    expect(relayAuthHeaders()).toEqual({});
    expect(relayAuthHeaders()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/chat/relay-auth.spec.ts
git commit -q -m "test(chat): заголовок секрета релея" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/relay-auth.spec.ts --maxWorkers=2 2>&1 | tail -15'
```

Ожидается: FAIL — `Cannot find module './relay-auth'`.

- [ ] **Шаг 3: реализация**

`src/chat/relay-auth.ts`:

```ts
import { Logger } from '@nestjs/common';

/**
 * Заголовок, по которому релей (relay-agent/server.mjs) узнаёт наш бэк.
 * Значение — RELAY_SECRET из .env; у прода и стенда свои значения, релей
 * принимает любое из своего списка. Спека:
 * docs/superpowers/specs/2026-10-26-relay-secret-design.md.
 */
export const RELAY_SECRET_HEADER = 'X-Agent-Secret';

const logger = new Logger('RelayAuth');
let warned = false;

/** Заголовки для любого запроса к релею. Секрета нет — пусто (и одно предупреждение). */
export function relayAuthHeaders(): Record<string, string> {
  const secret = (process.env.RELAY_SECRET || '').trim();
  if (!secret) {
    if (!warned) {
      warned = true;
      logger.warn('RELAY_SECRET не задан — релей в режиме enforce откажет в ходе');
    }
    return {};
  }
  return { [RELAY_SECRET_HEADER]: secret };
}
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add src/chat/relay-auth.ts
git commit -q -m "chat: заголовок секрета релея — один модуль на все вызовы" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/relay-auth.spec.ts --maxWorkers=2 2>&1 | tail -8'
```

Ожидается: PASS, 3 теста.

---

### Задача 2: все вызовы релея — с заголовком, и сторож

**Files:**
- Modify: `src/chat/chat.service.ts` (вызовы `POST ${AGENT_URL}/chat` в `streamUniversalAgent` и в `agentReply`; `GET ${AGENT_URL}/session/…/files`)
- Modify: `src/chat/chat.controller.ts` (`uploadAndChat`, `POST ${AGENT_URL}/chat`)
- Modify: `src/ask/clean-ask.service.ts` (`POST ${AGENT_URL}/chat`)
- Modify: `src/blog/blog-relay.client.ts` (`POST ${agentUrl}/chat`)
- Test: `src/chat/relay-auth.spec.ts`

- [ ] **Шаг 1: сторож — в `src/chat/relay-auth.spec.ts`** (импорты `fs` и `path` — в начало файла, рядом с `Logger`; блок `describe` — в конец)

```ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Каждый вызов релея (адрес из AGENT_URL / agentUrl, пути /chat и /session/)
 * обязан нести relayAuthHeaders(): в режиме enforce релей без него отвечает 401.
 * Проверка статическая: ищем вызов и смотрим, что заголовок стоит в той же
 * конструкции (в пределах 400 символов после адреса).
 */
describe('сторож: все вызовы релея — с секретом', () => {
  const SRC = path.join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) files.push(full);
    }
  };
  walk(SRC);

  const CALL = /\$\{(AGENT_URL|agentUrl)\}\/(chat|session\/)/g;

  it('находит все шесть известных вызовов', () => {
    const total = files.reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(CALL) || []).length, 0);
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it('у каждого вызова есть relayAuthHeaders()', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(CALL)) {
        const window = src.slice(m.index!, m.index! + 400);
        if (!window.includes('relayAuthHeaders()')) {
          const line = src.slice(0, m.index!).split('\n').length;
          missing.push(`${path.relative(SRC, f)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/chat/relay-auth.spec.ts
git commit -q -m "test(chat): сторож — каждый вызов релея несёт секрет" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/relay-auth.spec.ts --maxWorkers=2 2>&1 | grep -E "✕|✓|missing|Expected|Received" | head -20'
```

Ожидается: FAIL в «у каждого вызова есть relayAuthHeaders()», в `Received` — шесть мест: `blog/blog-relay.client.ts`, `ask/clean-ask.service.ts`, `chat/chat.controller.ts`, три в `chat/chat.service.ts`.

- [ ] **Шаг 3: правка шести вызовов**

В каждом из четырёх файлов добавить импорт (путь — относительно файла):

```ts
// src/chat/chat.service.ts и src/chat/chat.controller.ts
import { relayAuthHeaders } from './relay-auth';
// src/ask/clean-ask.service.ts и src/blog/blog-relay.client.ts
import { relayAuthHeaders } from '../chat/relay-auth';
```

Пять POST-вызовов — заменить строку заголовков:

```ts
// было
        headers: fd.getHeaders(),
// стало
        headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
```

(`chat.service.ts` — в `streamUniversalAgent` у `axios.post(\`${AGENT_URL}/chat\`, …)` и в `agentReply` у такого же вызова; `chat.controller.ts` — `axios.default.post(\`${AGENT_URL}/chat\`, …)`; `clean-ask.service.ts` и `blog-relay.client.ts` — их `axios.post(…/chat, fd, { headers: fd.getHeaders(), … })`.)

GET списка файлов сессии в `chat.service.ts`:

```ts
// было
                .get(`${AGENT_URL}/session/${encodeURIComponent(sid)}/files`, { timeout: 10_000 })
// стало
                .get(`${AGENT_URL}/session/${encodeURIComponent(sid)}/files`, { timeout: 10_000, headers: relayAuthHeaders() })
```

- [ ] **Шаг 4: коммит, прогон — зелёный, плюс тесты вызывающих**

```bash
git add src/chat/chat.service.ts src/chat/chat.controller.ts src/ask/clean-ask.service.ts src/blog/blog-relay.client.ts
git commit -q -m "chat, ask, blog: секрет релея во всех вызовах" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat src/ask src/blog --maxWorkers=2 2>&1 | grep -E "^FAIL|Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: строк `FAIL` нет; `tsc-exit=0`. Если какой-то существующий тест сверял `headers` вызова релея точным объектом — поправить ожидание на `expect.objectContaining(...)` и описать в отчёте.

---

### Задача 3: модуль проверки на релее

**Files:**
- Create: `relay-agent/relay-auth.mjs`
- Test: `relay-agent/relay-auth.test.mjs`

- [ ] **Шаг 1: тест**

`relay-agent/relay-auth.test.mjs`:

```js
// node --test relay-agent/relay-auth.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { parseSecrets, parseMode, isAuthorized, createRelayAuth } from "./relay-auth.mjs";

test("parseSecrets: строки без пустых и комментариев", () => {
  assert.deepEqual(parseSecrets("# прод\naaa\n\n  bbb  \n#x\n"), ["aaa", "bbb"]);
  assert.deepEqual(parseSecrets(""), []);
});

test("parseMode: только enforce включает отказ, остальное — log", () => {
  assert.equal(parseMode("enforce\n"), "enforce");
  assert.equal(parseMode("log"), "log");
  assert.equal(parseMode("ENFORCE"), "log");
  assert.equal(parseMode(""), "log");
});

test("isAuthorized: совпадение с любым из списка", () => {
  assert.equal(isAuthorized("bbb", ["aaa", "bbb"]), true);
  assert.equal(isAuthorized("ccc", ["aaa", "bbb"]), false);
  assert.equal(isAuthorized("", ["aaa"]), false);
  assert.equal(isAuthorized(undefined, ["aaa"]), false);
  assert.equal(isAuthorized("aaa", []), false);
});

// Настоящий Express: middleware + маршруты, как в server.mjs.
async function serve(files, nowRef) {
  const logs = [];
  const app = express();
  app.use(createRelayAuth({
    secretsPath: "S", modePath: "M",
    readFile: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
    now: () => nowRef.t,
    log: (line) => logs.push(line),
  }));
  app.post("/chat", (req, res) => res.json({ ok: true }));
  app.get("/session/:sid/files", (req, res) => res.json([]));
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/files/x.txt", (req, res) => res.send("file"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs, close: () => new Promise((r) => server.close(r)) };
}

test("log: без секрета проходит и пишет строку без значения заголовка", async () => {
  const t = { t: 0 };
  const s = await serve({ S: "good\n", M: "log\n" }, t);
  try {
    const r = await fetch(`${s.base}/chat`, { method: "POST", headers: { "X-Agent-Secret": "bad-value" } });
    assert.equal(r.status, 200);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /relay-auth: отказ был бы \(неверный\)/);
    assert.equal(s.logs[0].includes("bad-value"), false);
  } finally { await s.close(); }
});

test("enforce: без секрета 401, с верным — проходит; /health и /files без проверки", async () => {
  const t = { t: 0 };
  const s = await serve({ S: "good\nother\n", M: "enforce" }, t);
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${s.base}/session/abc/files`)).status, 401);
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST", headers: { "X-Agent-Secret": "other" } })).status, 200);
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    assert.equal((await fetch(`${s.base}/files/x.txt`)).status, 200);
  } finally { await s.close(); }
});

test("файлы перечитываются не чаще раза в 30 с; нет файла режима — log", async () => {
  const files = { S: "good", M: "enforce" };
  const t = { t: 0 };
  const s = await serve(files, t);
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 401);
    delete files.M;                       // режим убрали — но кэш ещё жив
    t.t = 10_000;
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 401);
    t.t = 31_000;                         // прошло 30 с — перечитали, файла нет → log
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 200);
  } finally { await s.close(); }
});

test("enforce без единого секрета — отказ всем (безопасное умолчание)", async () => {
  const s = await serve({ M: "enforce" }, { t: 0 });
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST", headers: { "X-Agent-Secret": "x" } })).status, 401);
  } finally { await s.close(); }
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add relay-agent/relay-auth.test.mjs
git commit -q -m "test(relay): проверка секрета — режимы, перечитывание, свободные пути" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --test relay-auth.test.mjs 2>&1 | tail -6'
```

Ожидается: FAIL — `Cannot find module …/relay-auth.mjs`.

- [ ] **Шаг 3: реализация**

`relay-agent/relay-auth.mjs`:

```js
// Проверка секрета бэка на входе релея (spirits_back,
// docs/superpowers/specs/2026-10-26-relay-secret-design.md).
// Список секретов и режим — в файлах рядом с server.mjs; перечитываются не
// чаще раза в RELOAD_MS, поэтому смена секрета и включение отказа идут без
// рестарта. Значение заголовка в лог не пишется никогда.
import crypto from "crypto";
import fs from "fs";

export const RELOAD_MS = 30_000;
export const HEADER = "x-agent-secret";

export function parseSecrets(text) {
  return String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

export function parseMode(text) {
  return String(text || "").trim() === "enforce" ? "enforce" : "log";
}

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

// Сравнение через хеши одинаковой длины: время не зависит от того, сколько
// символов совпало, и от длины присланного значения.
export function isAuthorized(header, secrets) {
  if (typeof header !== "string" || header === "") return false;
  const h = digest(header);
  let ok = false;
  for (const s of secrets) if (crypto.timingSafeEqual(h, digest(s))) ok = true;
  return ok;
}

// Пути без проверки: живость и статика файлов (файлы — отдельная задача).
const FREE = (req) =>
  req.method === "OPTIONS" || req.path === "/health" || req.path === "/files" || req.path.startsWith("/files/");

export function createRelayAuth({
  secretsPath,
  modePath,
  now = () => Date.now(),
  readFile = (p) => fs.readFileSync(p, "utf8"),
  log = (line) => console.log(line),
}) {
  let cache = { at: -Infinity, secrets: [], mode: "log" };
  const load = () => {
    if (now() - cache.at < RELOAD_MS) return cache;
    let secrets = [];
    let mode = "log";
    try { secrets = parseSecrets(readFile(secretsPath)); } catch {}
    try { mode = parseMode(readFile(modePath)); } catch {}
    cache = { at: now(), secrets, mode };
    return cache;
  };

  return function relayAuth(req, res, next) {
    if (FREE(req)) return next();
    const { secrets, mode } = load();
    const header = req.get(HEADER);
    if (isAuthorized(header, secrets)) return next();
    const why = header ? "неверный" : "нет секрета";
    const ip = req.get("x-real-ip") || req.socket?.remoteAddress || "?";
    if (mode === "enforce") {
      log(`relay-auth: отказ (${why}), ip=${ip}, path=${req.path}`);
      return res.status(401).json({ error: "unauthorized" });
    }
    log(`relay-auth: отказ был бы (${why}), ip=${ip}, path=${req.path}`);
    return next();
  };
}
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add relay-agent/relay-auth.mjs
git commit -q -m "relay: проверка секрета бэка — режимы log и enforce из файла" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && node --test relay-auth.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"'
```

Ожидается: `# fail 0`.

---

### Задача 4: подключить в server.mjs; keep-warm, .gitignore, README

**Files:**
- Modify: `relay-agent/server.mjs` (импорты вверху; строка `app.use(cors());`)
- Modify: `relay-agent/keep-warm.sh`
- Modify: `relay-agent/.gitignore`, `relay-agent/README.md`

- [ ] **Шаг 1: server.mjs**

К импортам вверху файла:

```js
import { fileURLToPath } from "url";
import { createRelayAuth } from "./relay-auth.mjs";
```

Сразу после `app.use(cors());` (до `app.use(express.json());`):

```js
// Ходы принимаются только от бэков с секретом (relay-auth.mjs). Файлы —
// рядом с server.mjs, права 600, не в git; режим log пишет «отказ был бы»
// и пропускает, enforce отвечает 401.
const HERE = path.dirname(fileURLToPath(import.meta.url));
app.use(createRelayAuth({
  secretsPath: process.env.RELAY_SECRETS_FILE || path.join(HERE, "relay-secrets"),
  modePath: process.env.RELAY_AUTH_MODE_FILE || path.join(HERE, "relay-auth-mode"),
}));
```

Проверка:

```bash
node --check relay-agent/server.mjs && echo syntax-ok
grep -n "createRelayAuth" relay-agent/server.mjs
```

Ожидается: `syntax-ok`; две строки (импорт и `app.use`), `app.use(createRelayAuth` — между `app.use(cors())` и `app.use(express.json())`.

- [ ] **Шаг 2: keep-warm.sh** — заменить блок `status=$(curl …)`:

```bash
secret=$(grep -v '^#' "$(dirname "$0")/relay-secrets" 2>/dev/null | grep -m1 . || true)
status=$(curl -sS -o /tmp/keepwarm.out -w '%{http_code}' \
  --connect-timeout 10 --max-time 90 \
  -X POST http://127.0.0.1:3033/chat \
  -H "X-Agent-Secret: ${secret}" \
  -F "sessionId=$sid" -F 'message=ping') || status=000
```

Проверка: `bash -n relay-agent/keep-warm.sh && echo ok`.

- [ ] **Шаг 3: .gitignore и README**

В конец `relay-agent/.gitignore`:

```
# Секреты бэков и режим проверки (relay-auth.mjs). Живут только на сервере, права 600.
relay-secrets
relay-auth-mode
```

В `relay-agent/README.md` — раздел (в конец файла):

```markdown
## Секрет бэка (`X-Agent-Secret`)

Релей принимает `/chat` и `/session/*` только с заголовком `X-Agent-Secret`, равным одной из строк файла `relay-secrets` (рядом с `server.mjs`, права 600, не в git). Режим — файл `relay-auth-mode`: `log` (пропускать и писать «отказ был бы») или `enforce` (401). Оба файла перечитываются раз в 30 с, рестарт не нужен. `/health` и `/files/*` — без проверки.

Смена секрета без простоя: добавить новую строку в `relay-secrets` → заменить `RELAY_SECRET` в `.env` бэка → `pm2 restart linkeon-api` при нуле живых ходов → удалить старую строку. Значения не печатать: передавать трубой `ssh … | ssh …`.
```

- [ ] **Шаг 4: коммит, прогоны релея целиком**

```bash
git add relay-agent/server.mjs relay-agent/keep-warm.sh relay-agent/.gitignore relay-agent/README.md
git commit -q -m "relay: проверка секрета на входе (по умолчанию log); keep-warm шлёт секрет" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && node --check server.mjs && echo syntax-ok; node --test 2>&1 | grep -E "^# (tests|pass|fail)"'
bash .superpowers/node-run.sh 'npx jest src/mcp/relay-mcp-template.spec.ts src/mcp/relay-products-tools.spec.ts src/chat/relay-help-guard.spec.ts --maxWorkers=2 2>&1 | grep -E "^FAIL|Tests:"'
```

Ожидается: `syntax-ok`; `# fail 0`; сторожа релея на бэке зелёные.

---

### Задача 5: полный прогон и ревью

- [ ] **Шаг 1:** `bash .superpowers/node-run.sh 'npx jest src/chat src/ask src/blog src/mcp src/support --maxWorkers=2 2>&1 | grep -E "^FAIL|Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'` — без новых `FAIL`, `tsc-exit=0`.
- [ ] **Шаг 2:** ревью ветки (`superpowers:requesting-code-review`), диапазон `origin/main...feat/relay-secret`; найденное — отдельными коммитами по TDD.
- [ ] **Шаг 3:** слияние в main — только с OK владельца: временное воркдерево на свежем `origin/main`, `merge --no-ff feat/relay-secret`, `push origin "${SHA}:refs/heads/main"`, проверка `merge-base --is-ancestor`.

---

### Задача 6: секреты на серверах — с OK владельца

Значения не печатаются нигде: генерация на месте, перенос — трубой.

- [ ] **Шаг 1: прод и стенд — `RELAY_SECRET` в `.env`**

Перед дописыванием — проверить перевод строки в конце `.env` (иначе `RELAY_SECRET=...` прилипнет к последней существующей строке):

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && [ -z "$(tail -c1 .env)" ] || echo >> .env; (grep -q "^RELAY_SECRET=" .env || printf "RELAY_SECRET=%s\n" "$(openssl rand -hex 32)" >> .env) && grep -c "^RELAY_SECRET=" .env && stat -c %a .env'
ssh dv@85.192.61.231 'cd ~/spirits_back && [ -z "$(tail -c1 .env)" ] || echo >> .env; (grep -q "^RELAY_SECRET=" .env || printf "RELAY_SECRET=%s\n" "$(openssl rand -hex 32)" >> .env) && grep -c "^RELAY_SECRET=" .env && stat -c %a .env'
```

Ожидается: `1` и права файла (`600` или прежние) в обоих.

- [ ] **Шаг 1а: другие бэки на ноде `85.192.61.231`, ходящие в релей**

На ноде, кроме живого `~/spirits_back`, есть `~/dev/spirits_back` и CI-клоны (`~/ci/spirits_back`, `~/ci/wt/*`) — проверить, у каких из них `AGENT_URL`/`agentUrl` реально указывает на `r.linkeon.io` (а не на локальный стенд/тест-дабл) и которые могут дёрнуть релей живым трафиком. Каждому такому — свой `RELAY_SECRET` в `.env` до включения `enforce` (Задача 9), либо явно отметить в этом плане, что конкретный клон в релей не ходит (CI-прогоны — не ходят, см. память «test без BACKEND_URL»).

- [ ] **Шаг 2: релей — файл секретов (две строки) и режим `log`**

```bash
ssh dv@5.101.115.184 'cd ~/file-agent && umask 077 && printf "# прод\n" > relay-secrets && printf "log\n" > relay-auth-mode'
ssh dvolkov@212.113.106.202 'sed -n "s/^RELAY_SECRET=//p" ~/spirits_back/.env' | ssh dv@5.101.115.184 'cat >> ~/file-agent/relay-secrets'
ssh dv@5.101.115.184 'printf "# стенд\n" >> ~/file-agent/relay-secrets'
ssh dv@85.192.61.231 'sed -n "s/^RELAY_SECRET=//p" ~/spirits_back/.env' | ssh dv@5.101.115.184 'cat >> ~/file-agent/relay-secrets'
ssh dv@5.101.115.184 'cd ~/file-agent && stat -c "%a %n" relay-secrets relay-auth-mode && grep -vc "^#" relay-secrets && cat relay-auth-mode'
```

Ожидается: `600 relay-secrets`, `600 relay-auth-mode`, `2` (две строки-секрета), `log`. Формат строк — без печати значений:

```bash
ssh dv@5.101.115.184 "awk '!/^#/ && NF && length(\$0)!=64' ~/file-agent/relay-secrets | wc -l"
```

Ожидается: `0` (каждая незакомментированная непустая строка — ровно 64 символа, `openssl rand -hex 32`).

---

### Задача 7: выкат бэка — с OK владельца

- [ ] **Шаг 1:** показать владельцу, что уедет: `git -C ~/Downloads/spirits_back log --oneline <прод-бэк>..origin/main` (хеш прода — `ssh dvolkov@212.113.106.202 'git -C ~/spirits_back rev-parse --short HEAD'`).
- [ ] **Шаг 2:** `deploy.sh` с ноды со свежих клонов (рецепт — память «Выкат: правила»: `~/deploy-clones/<имя>`, `test-server.env.local`, симлинк `tests/node_modules`, `. ~/.nvm/nvm.sh`, `SKIP_BOTS=1` при отсутствии ключа к машине ботов), отвязанно, лог без `tail`.
- [ ] **Шаг 3:** на проде — `grep -c relayAuthHeaders ~/spirits_back/dist/chat/chat.service.js` ≥ 1, `git reflog -3` без отката.

---

### Задача 8: выкат релея в режиме `log` — с OK владельца

- [ ] **Шаг 1:** живой `server.mjs` совпадает с копией main до правки (`diff` с `git show <база>:relay-agent/server.mjs`); иначе — переносить правку руками, не перезаписывать.
- [ ] **Шаг 2:** живых ходов нет: `curl -s https://my.linkeon.io/webhook/chat/active-streams` с ноды и то же для стенда (Basic Auth из `test-server.env.local`) — оба `{"active":0}`.
- [ ] **Шаг 3:** выкатить (файлы — с конкретного SHA слияния в main, не с движущегося `origin/main`: взять его командой из Задачи 5, шаг 3, `${SHA}`; имя временного файла — с расширением `.mjs`, иначе `node --check` не проверит):

```bash
git -C ~/Downloads/spirits_back show ${SHA}:relay-agent/server.mjs > /tmp/server.new.mjs
git -C ~/Downloads/spirits_back show ${SHA}:relay-agent/relay-auth.mjs > /tmp/relay-auth.mjs
git -C ~/Downloads/spirits_back show ${SHA}:relay-agent/keep-warm.sh > /tmp/keep-warm.sh
scp -q /tmp/server.new.mjs /tmp/relay-auth.mjs /tmp/keep-warm.sh dv@5.101.115.184:file-agent/
ssh dv@5.101.115.184 'cd ~/file-agent && node --check server.new.mjs && node --check relay-auth.mjs \
  && node --test *.test.mjs 2>&1 | tail -6 \
  && [ "$(ps --ppid "$(pm2 pid file-agent)" | wc -l)" = "1" ] \
  && mv server.new.mjs server.mjs \
  && { grep -qx "relay-secrets*" .gitignore || printf "# Секреты бэков и режим проверки — только на сервере\nrelay-secrets*\nrelay-auth-mode*\n" >> .gitignore; } \
  && chmod 755 keep-warm.sh && git add server.mjs relay-auth.mjs keep-warm.sh .gitignore \
  && git commit -q -m "секрет бэка на входе (режим log)" && git log --oneline -1 && git status --short | head -3 \
  && pm2 restart file-agent >/dev/null && pm2 describe file-agent | grep -E "status|restarts" | head -2'
```

Прогон тестов релея — ПЕРЕД `mv`: битый `server.mjs` не должен попасть на диск. «Живых ходов нет» (Шаг 2 проверял это через `/webhook/chat/active-streams` на бэках) здесь проверяется ЕЩЁ РАЗ, но уже со стороны релея и в той же SSH-команде — числом процессов-потомков `file-agent` (`ps --ppid`), непосредственно перед `mv`, не раньше: ход может начаться в промежутке между Шагом 2 и этим SSH-вызовом. Рестарт — БЕЗ `--update-env`: релей не берёт секрет/режим из переменных окружения процесса (только из файлов `relay-secrets`/`relay-auth-mode`, см. `RELAY_SECRETS_FILE`/`RELAY_AUTH_MODE_FILE` в README), а `--update-env` на этой машине заодно перечитывает окружение pm2 целиком — лишний риск без пользы здесь.

Ожидается: тесты релея — `# fail 0`; коммит в git релея; в `git status` нет `relay-secrets`/`relay-auth-mode` (их скрывает `.gitignore`); `status │ online`.

- [ ] **Шаг 4:** первые ходы прода и стенда после рестарта — в журнале nginx `POST /chat 200`, в `pm2 logs file-agent --lines 200 --nostream` ни одной строки `relay-auth: отказ был бы` с адресов бэков.

  Положительный контроль (что лог вообще способен поймать СВОЙ бэк без заголовка): с прода, без заголовка и без тела —
  ```bash
  ssh dvolkov@212.113.106.202 'curl -s -o /dev/null -w "%{http_code}\n" -X POST https://r.linkeon.io/chat'
  ```
  Ожидается `400` (режим ещё `log` — relay-auth пропускает запрос дальше, но у `/chat`-обработчика нет ни `sessionId`, ни тела — он сам отвечает 400) и следом в `pm2 logs file-agent --lines 20 --nostream` — строка `relay-auth: отказ был бы (нет секрета), ip=<IP прода>, ...`. Если строки нет или IP не прода — проверку ломать нарочно не нужно, но разобраться, почему лог не увидел вызов, нужно до Задачи 9.

---

### Задача 9: сутки наблюдения и включение отказа — с OK владельца

- [ ] **Шаг 1:** через сутки — грепать файлы логов ЦЕЛИКОМ, а не последние N строк из `pm2 logs` (ротация `pm2-logrotate` может унести интересующий кусок за пределы `--lines`):
  ```bash
  ssh dv@5.101.115.184 "grep -c 'relay-auth: отказ был бы' ~/.pm2/logs/file-agent-out.log* 2>/dev/null | awk -F: '{s+=\$2} END{print s+0}'"
  ```
  → `0` (любая строка — пропущенный вызов; найти и починить до шага 2). Перед этим убедиться, что за окно наблюдения действительно прошли все виды вызовов релея, а не только обычный веб-чат: ход с прикреплённым файлом, автоблог (`blog-relay.client.ts`), проба качества (`agentReply`) и `clean-ask` (эфемерный вопрос). Если какого-то из них за сутки не было — вызвать вручную, иначе его путь к `relayAuthHeaders()` останется непроверенным.
- [ ] **Шаг 2:** включить: `ssh dv@5.101.115.184 'printf "enforce\n" > ~/file-agent/relay-auth-mode'` (без рестарта; вступает в силу за ≤ 30 с).
- [ ] **Шаг 3:** проверка через минуту: с прода без заголовка `ssh dvolkov@212.113.106.202 'curl -s -o /dev/null -w %{http_code} -X POST https://r.linkeon.io/chat'` → `401`; обычные ходы — в журнале nginx `POST /chat 200` с адресов прода и стенда; ход с файлом, автоблог, проба качества — без 401 в `pm2 logs`.
- [ ] **Шаг 4 (постоянный мониторинг):** после включения `enforce` завести отдельную задачу — добавить проверку 401 от `r.linkeon.io/chat` (без заголовка, с адреса одного из бэков, как в Шаге 3) в постоянный мониторинг (synthetic-раннер/Prometheus — см. памяти `project_synthetic_runner_node3_manual`, `project_prometheus_alerts_undelivered`), чтобы тихий откат секрета на стороне релея или бэка не остался незамеченным между ручными проверками.
- [ ] **Откат:** `printf "log\n" > ~/file-agent/relay-auth-mode` — мгновенно.

---

### Задача 10: память и документы

- [ ] Обновить заметки памяти `project_relay_chat_open_no_auth` (закрыто: белый список 26.10, секрет — дата enforce) и `project_relay` (секрет, файлы, смена). В `spirits_back/CLAUDE.md` — строка в разделе о релее: «ходы принимаются только с `X-Agent-Secret`; смена — `relay-agent/README.md`».
