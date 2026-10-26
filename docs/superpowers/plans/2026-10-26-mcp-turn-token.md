# Инструменты ассистентов узнают пользователя по токену хода — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** инструменты `mcp__linkeon__*` берут пользователя из подписанного бэком токена хода, номер телефона перестаёт уходить модели (ни строкой в реплике, ни в именах папок), общий `MCP_SECRET` снимается — без простоя, шагами, каждый обратим.

**Architecture:** бэк на каждый ход выпускает токен типа `linkeon-tool` (`src/mcp/linkeon-tool.token.ts`) и шлёт релею три поля — `linkeon_token`, `linkeon_mcp_url`, `fs_key` (`src/chat/linkeon-relay-fields.ts`) — на всех путях с известным пользователем. `McpController` работает на двух адресах (`/webhook/mcp/linkeon` — основной, `/mcp` — переходный) и принимает токен хода или, до снятия, общий секрет со строкой в лог. Релей подключает сервер `linkeon` в конфиг хода только из токена (`relay-agent/linkeon-mcp.mjs`), кладёт файлы в папку `fs_key` (`relay-agent/paths.mjs`, `turnFsKey`), строку с телефоном и `userId` в правилах убирает.

**Tech Stack:** NestJS 10 + jsonwebtoken + MCP SDK 1.29 + jest/ts-jest (бэк, `spirits_back/src`), Express 5 + `node:test` (релей, `spirits_back/relay-agent`).

**Спека:** `docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md`.

---

## Как работать по этому плану

- Воркдерево: `~/Downloads/spirits_back/.worktrees/mcp-turn-token`, ветка `feat/mcp-turn-token` (от origin/main 86c2b44). Все команды — из корня воркдерева. Общие чекауты (`~/Downloads/spirits_back`, `~/Downloads/spirits_front`) не трогать: ни checkout, ни commit.
- Тесты и `tsc` бэка — только на тестовой ноде: `bash .superpowers/node-run.sh '<команда>'` (скрипт уже лежит в воркдереве, вне git). Прогон идёт на ЗАКОММИЧЕННОМ коммите — коммитить перед прогоном. Не запускать два прогона одновременно: общий force-push в `tmp/mcp-turn-token` и общий каталог на ноде.
- Тесты релея — тоже через node-run: `bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --test 2>&1 | grep -E "^# (tests|pass|fail)"'`.
- Локально на маке ничего тяжёлого не запускать (ни jest, ни tsc, ни сборку).
- В GitHub не пушить без OK владельца. Коммиты — по-русски, вторым `-m` строка соавторства (в командах ниже — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; агенту другой модели — своя строка).
- Репозиторий публичный: в коммитах, комментариях и тестах не описывать, как обойти защиту, не писать значения секретов; номера телефонов — только тестовые из CLAUDE.md (`79030169187`, `70000000000`).
- `relay-agent/session-tail.mjs` не трогать: регулярка, снимающая старую строку «Current user phone…», остаётся — она чистит хвост старых сессий. `session-tail.test.mjs` — менять только если покраснеет (не должен).
- Задача 15 (шаг 4 — слияние), задачи 16–19 и 22 трогают GitHub и серверы — каждый такой шаг только с явного OK владельца. Задачи 20–21 — код; начинать их только после зелёной задачи 19. Бэк выкатывается только `deploy.sh`; релей — вручную по шагам задачи 18. Не совмещать выкат релея с включением `enforce` из плана секрета релея (`2026-10-26-relay-secret.md`, задача 9): одно изменение релея за раз.
- Значения, которые известны только во время выката (SHA слияния, время рестарта релея), записываются в отчёт задачи и подставляются в команды следующих задач вместо `<…>`. В zsh писать `${SHA}`, а не `$SHA:…`.

## Файлы

| Файл | Что |
|---|---|
| `src/mcp/linkeon-tool.token.ts` (новый) | `signLinkeonToolToken(userId)`, `verifyLinkeonToolToken(token)` → `{ userId }`; тип `linkeon-tool`, 30 минут, `JWT_SECRET_PREVIOUS` |
| `src/mcp/linkeon-tool.token.spec.ts` (новый) | выпуск и разбор, чужой тип и подпись, смена секрета |
| `src/mcp/mcp.controller.ts` | пользователь из токена (`caller`), `listTools(caller)`, `callTool(authHeader, name, args)`, переходный путь по `MCP_SECRET` со строкой в лог; два адреса |
| `src/mcp/mcp.controller.spec.ts` (новый) | токен, выброс `args.userId`, `tools/list`, переходный путь |
| `src/mcp/mcp.controller.routes.spec.ts` (новый) | адреса живым приложением Nest |
| `src/mcp/mcp.controller.problem-report.spec.ts` | новые ожидания: Bearer — токен хода, `userId` не в аргументах |
| `src/mcp/products-mcp.controller.ts` | только комментарий про общую точку |
| `src/chat/linkeon-relay-fields.ts` (новый) | `relayFsKey`, `linkeonRelayFields`, `appendLinkeonFields`, тип `LinkeonRelayFields` |
| `src/chat/linkeon-relay-fields.spec.ts` (новый) | токен, адрес, `fs_key` |
| `src/chat/chat.service.ts` | поля в `streamUniversalAgent`, `buildUploadHandoff`, `agentReply` (+ `AgentReplyOpts`); шаги работы и список файлов сессии по `fs_key` |
| `src/chat/chat.controller.ts` | поля и `fsKey` для шагов в `uploadAndChat` |
| `src/chat/chat.service.linkeon-fields.spec.ts` (новый) | поля у веб-хода и `agentReply`, шаги, список файлов |
| `src/chat/chat.upload-session.spec.ts` | поля у хода с вложениями |
| `src/chat/linkeon-fields-anonymous.spec.ts` (новый) | сторож: clean-ask, первый контакт, автоблог — без полей |
| `src/chat/activity-map.ts`, `activity-map.spec.ts` | снятие префикса загрузки по `fsKey` |
| `src/monitoring/quality-monitor.service.ts`, `quality-monitor.probe-tools.spec.ts` (новый) | проба качества — `{ linkeonTools: false }` |
| `src/support/support.service.ts`, `support-user-context.spec.ts` (новый) | `get_user_context` без `user_id` |
| `src/chat/relay-linkeon-guard.spec.ts` (новый) | сторож текста `server.mjs`, `linkeon-mcp.mjs`, `paths.mjs` |
| `src/mcp/relay-mcp-template.spec.ts` | шаблон `empty-mcp.json` — без серверов |
| `relay-agent/paths.mjs`, `paths.test.mjs` | `turnFsKey` (fs_key `[0-9a-f]{32}` или прежний ключ), `legacyTurnFsKey` |
| `relay-agent/linkeon-mcp.mjs`, `linkeon-mcp.test.mjs` (новые) | `LINKEON_TOOLS`, `linkeonServer(body)`, `isHttpsUrl` |
| `relay-agent/session-mcp-config.mjs`, `session-mcp-config.test.mjs` (новые) | имя конфига хода на ХОД (не на сессию), уборка осиротевших вне живых |
| `relay-agent/turn-files.mjs`, `turn-files.test.mjs` (новые) | снимок/дифф папки хода, включая прежнюю (до `fs_key`) |
| `relay-agent/server.mjs` | без строки с телефоном, без `userId` в правилах, `linkeon` из токена, `BASE_TOOLS`, папки по `fs_key`, конфиги хода в `agent-uploads/mcp/`, `Set` живых конфигов |
| `relay-agent/empty-mcp.json`, `relay-agent/README.md` | пустой базовый конфиг; описание папок и секретов |
| `CLAUDE.md` (бэка) | `RELAY_FS_SALT`, точка `/webhook/mcp/linkeon`, ручная проверка |
| позже, задачи 20–21: `src/mcp/*`, `src/main.ts` (комментарий), `src/platform-kb/articles/how-it-works.ts`, `src/platform-kb/how-it-works.spec.ts` (новый), `scripts/sync-api-keys-to-test.sh` (комментарий) | снятие переходного пути, справка |

---

### Задача 0: база прогонов

**Files:** нет.

- [ ] **Шаг 1: состояние воркдерева**

```bash
git status --short && git log --oneline -3
```

Ожидается: чисто (кроме `.superpowers/`, он вне git); сверху коммит плана, под ним `c2926e1 docs(spec): …`, `86c2b44 Merge feat/product-lifecycle…`.

- [ ] **Шаг 2: прогон бэка на базе**

```bash
bash .superpowers/node-run.sh 'npx jest src/mcp src/chat src/support src/monitoring src/ask src/blog src/products src/platform-kb src/voice-call src/trip src/routine-push --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Записать в отчёт: строки `FAIL` (ожидается ни одной) и `Tests:`, `tsc-exit` (ожидается `0`). Дальше всё мерится дельтой к этой базе.

- [ ] **Шаг 3: прогон релея на базе**

```bash
bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --test 2>&1 | grep -E "^# (tests|pass|fail)"'
```

Записать числа; ожидается `# fail 0`.

---

### Задача 1: токен хода

**Files:**
- Create: `src/mcp/linkeon-tool.token.ts`
- Test: `src/mcp/linkeon-tool.token.spec.ts`

- [ ] **Шаг 1: тест**

`src/mcp/linkeon-tool.token.spec.ts`:

```ts
import * as jwt from 'jsonwebtoken';
import { LINKEON_TOOL_TOKEN_TYPE, signLinkeonToolToken, verifyLinkeonToolToken } from './linkeon-tool.token';
import { signProductToolToken, verifyProductToolToken } from '../products/product-tool.token';

/**
 * Токен хода для инструментов Linkeon (mcp__linkeon__*) — спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 */
describe('токен хода для инструментов Linkeon', () => {
  const OLD = { cur: process.env.JWT_SECRET, prev: process.env.JWT_SECRET_PREVIOUS };
  beforeEach(() => {
    process.env.JWT_SECRET = 'linkeon-tool-spec';
    delete process.env.JWT_SECRET_PREVIOUS;
  });
  afterAll(() => {
    if (OLD.cur === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD.cur;
    if (OLD.prev === undefined) delete process.env.JWT_SECRET_PREVIOUS; else process.env.JWT_SECRET_PREVIOUS = OLD.prev;
  });

  it('выпуск и разбор: тот же пользователь — и больше ничего', () => {
    expect(verifyLinkeonToolToken(signLinkeonToolToken('79030169187'))).toEqual({ userId: '79030169187' });
  });

  it('пользователь с почтовым входом (UUID) — так же', () => {
    const id = '0b7c2a4e-1f3d-4c8a-9e2b-5d6f7a8b9c0d';
    expect(verifyLinkeonToolToken(signLinkeonToolToken(id))).toEqual({ userId: id });
  });

  it('в подписи только userId и тип; срок — 30 минут', () => {
    const p: any = jwt.decode(signLinkeonToolToken('u-1'));
    expect(Object.keys(p).sort()).toEqual(['exp', 'iat', 'type', 'userId']);
    expect(LINKEON_TOOL_TOKEN_TYPE).toBe('linkeon-tool');
    expect(p.type).toBe(LINKEON_TOOL_TOKEN_TYPE);
    expect(p.exp - p.iat).toBe(30 * 60);
  });

  it('без пользователя токен не выпускается', () => {
    expect(() => signLinkeonToolToken('')).toThrow();
  });

  it('чужая подпись — отказ', () => {
    const alien = jwt.sign({ userId: 'u-1', type: LINKEON_TOOL_TOKEN_TYPE }, 'not-our-secret');
    expect(() => verifyLinkeonToolToken(alien)).toThrow();
  });

  // JwtGuard симметрично требует type='access' (src/common/guards/jwt.guard.ts):
  // токен хода, лежащий на релее в конфиге хода, не открывает защищённых ручек.
  it('access-токен пользователя сюда не годится', () => {
    const access = jwt.sign({ userId: 'u-1', sub: 'u-1', type: 'access' }, process.env.JWT_SECRET!);
    expect(() => verifyLinkeonToolToken(access)).toThrow(/тип/i);
  });

  it('токен продуктов сюда не годится, и наоборот', () => {
    expect(() => verifyLinkeonToolToken(signProductToolToken('u-1'))).toThrow(/тип/i);
    expect(() => verifyProductToolToken(signLinkeonToolToken('u-1'))).toThrow(/тип/i);
  });

  it('просроченный — отказ', () => {
    const stale = jwt.sign({ userId: 'u-1', type: LINKEON_TOOL_TOKEN_TYPE }, process.env.JWT_SECRET!, { expiresIn: -60 });
    expect(() => verifyLinkeonToolToken(stale)).toThrow();
  });

  it('без userId в подписи — отказ', () => {
    const empty = jwt.sign({ type: LINKEON_TOOL_TOKEN_TYPE }, process.env.JWT_SECRET!);
    expect(() => verifyLinkeonToolToken(empty)).toThrow(/пользовател/i);
  });

  describe('смена JWT_SECRET', () => {
    it('токен на прежнем секрете принимается, пока задан JWT_SECRET_PREVIOUS', () => {
      const old = signLinkeonToolToken('u-1');
      process.env.JWT_SECRET_PREVIOUS = 'linkeon-tool-spec';
      process.env.JWT_SECRET = 'linkeon-tool-spec-new';
      expect(verifyLinkeonToolToken(old)).toEqual({ userId: 'u-1' });
    });

    it('без JWT_SECRET_PREVIOUS — отказ', () => {
      const old = signLinkeonToolToken('u-1');
      process.env.JWT_SECRET = 'linkeon-tool-spec-new';
      expect(() => verifyLinkeonToolToken(old)).toThrow();
    });

    it('просроченный на прежнем секрете — отказ и при JWT_SECRET_PREVIOUS', () => {
      const stale = jwt.sign({ userId: 'u-1', type: LINKEON_TOOL_TOKEN_TYPE }, 'linkeon-tool-spec', { expiresIn: -60 });
      process.env.JWT_SECRET_PREVIOUS = 'linkeon-tool-spec';
      process.env.JWT_SECRET = 'linkeon-tool-spec-new';
      expect(() => verifyLinkeonToolToken(stale)).toThrow();
    });
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/mcp/linkeon-tool.token.spec.ts
git commit -q -m "test(mcp): токен хода для инструментов Linkeon" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp/linkeon-tool.token.spec.ts --maxWorkers=2 2>&1 | tail -15'
```

Ожидается: FAIL — `Cannot find module './linkeon-tool.token'`.

- [ ] **Шаг 3: реализация**

`src/mcp/linkeon-tool.token.ts`:

```ts
import * as jwt from 'jsonwebtoken';

/**
 * Токен хода для инструментов Linkeon (mcp__linkeon__*: картинки, баннеры,
 * видео, озвучка, рутины, календарь, бодиграф). Спека:
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 *
 * Бэк выпускает его на каждый ход и отдаёт релею (src/chat/linkeon-relay-fields.ts);
 * релей кладёт его в заголовок сервера linkeon, точка /webhook/mcp/linkeon
 * берёт пользователя из подписи. Модель токена не видит и пользователя в
 * аргументах больше не пишет.
 *
 * Свой тип, а не 'access': токен живёт на релее в файле конфига хода, то есть
 * за нашим периметром, и не должен открывать ни одной защищённой ручки —
 * JwtGuard требует type='access' (src/common/guards/jwt.guard.ts). По образцу
 * src/products/product-tool.token.ts; чистые функции по той же причине.
 */
export const LINKEON_TOOL_TOKEN_TYPE = 'linkeon-tool';

/** Дольше любого хода (веб — до 10 минут с продолжениями, agentReply — 5) и заметно короче суток. */
const TTL_SECONDS = 30 * 60;

function secret(): string {
  return process.env.JWT_SECRET || 'default_secret_change_me';
}

/** Прежний секрет на время его смены — как в JwtService. */
function previousSecret(): string | null {
  return process.env.JWT_SECRET_PREVIOUS || null;
}

export function signLinkeonToolToken(userId: string): string {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Токен хода без пользователя не выпускается');
  }
  return jwt.sign({ userId, type: LINKEON_TOOL_TOKEN_TYPE }, secret(), { expiresIn: TTL_SECONDS });
}

/** Пользователь из подписи или исключение: без пользователя звать инструмент нечем. */
export function verifyLinkeonToolToken(token: string): { userId: string } {
  let payload: any;
  try {
    payload = jwt.verify(token, secret());
  } catch (e) {
    // Токен, выпущенный до смены секрета, доживает свой срок; просроченный — нет.
    const prev = previousSecret();
    if (!prev || e instanceof jwt.TokenExpiredError) throw e;
    payload = jwt.verify(token, prev);
  }
  if (payload?.type !== LINKEON_TOOL_TOKEN_TYPE) {
    throw new Error(`Неверный тип токена: ${payload?.type}`);
  }
  const userId = payload?.userId;
  if (!userId || typeof userId !== 'string') {
    throw new Error('В токене нет пользователя');
  }
  return { userId };
}
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add src/mcp/linkeon-tool.token.ts
git commit -q -m "mcp: токен хода linkeon-tool — пользователь в подписи" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp/linkeon-tool.token.spec.ts src/products/product-tool.token.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: оба файла `PASS`, в `linkeon-tool.token.spec.ts` 12 тестов.

---

### Задача 2: точка — пользователь из токена, переходный путь

**Files:**
- Modify: `src/mcp/mcp.controller.ts` (весь файл)
- Modify: `src/mcp/mcp.controller.problem-report.spec.ts` (весь файл)
- Modify: `src/mcp/products-mcp.controller.ts` (комментарий над `@Controller('/mcp/products')`)
- Test: `src/mcp/mcp.controller.spec.ts`

- [ ] **Шаг 1: тест точки**

`src/mcp/mcp.controller.spec.ts`:

```ts
import * as jwt from 'jsonwebtoken';
import { UnauthorizedException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpController } from './mcp.controller';
import { CHAT_TOOLS } from '../chat/chat-tools';
import { signLinkeonToolToken } from './linkeon-tool.token';
import { signProductToolToken } from '../products/product-tool.token';

/**
 * Точка инструментов Linkeon (mcp__linkeon__*): пользователь — из подписи
 * токена хода, а не из аргумента, который пишет модель. Спека:
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 */
const OLD = { jwt: process.env.JWT_SECRET, mcp: process.env.MCP_SECRET };
beforeAll(() => {
  process.env.JWT_SECRET = 'mcp-controller-spec';
  delete process.env.MCP_SECRET;
});
afterAll(() => {
  if (OLD.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD.jwt;
  if (OLD.mcp === undefined) delete process.env.MCP_SECRET; else process.env.MCP_SECRET = OLD.mcp;
});
afterEach(() => {
  delete process.env.MCP_SECRET;
  jest.restoreAllMocks();
});

const bearer = (userId: string) => `Bearer ${signLinkeonToolToken(userId)}`;

function make() {
  const tools = { executeTool: jest.fn(async (..._a: any[]) => ({ ok: true, kind: 'image', imageUrl: 'https://x/y.png' })) };
  const problems = { reportToolFailure: jest.fn(() => ({ supportNotified: false })) };
  const chat = { activeAssistantFor: jest.fn(() => null) };
  const ctrl = new McpController(tools as any, problems as any, chat as any);
  jest.spyOn((ctrl as any).logger, 'log').mockImplementation(() => undefined);
  return { ctrl, tools };
}

describe('точка инструментов Linkeon: пользователь из токена хода', () => {
  it('пользователь — из подписи токена', async () => {
    const { ctrl, tools } = make();
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'кот' });
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
  });

  // Главная защита точки: поле userId, которое пишет модель, не значит ничего
  // и до инструмента не доезжает (как в products-mcp.controller.ts).
  it('userId в аргументах ничего не значит и до инструмента не доезжает', async () => {
    const { ctrl, tools } = make();
    await ctrl.callTool(bearer('u-owner'), 'generate_image', { prompt: 'кот', userId: '70000000000' });
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
  });

  it('без Bearer — 401, инструмент не зовётся', async () => {
    const { ctrl, tools } = make();
    await expect(ctrl.callTool(undefined, 'generate_image', { userId: 'u-1', prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('чужая подпись — 401', async () => {
    const { ctrl, tools } = make();
    const alien = jwt.sign({ userId: 'u-1', type: 'linkeon-tool' }, 'not-our-secret');
    await expect(ctrl.callTool(`Bearer ${alien}`, 'generate_image', { prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('access-токен пользователя — 401', async () => {
    const { ctrl, tools } = make();
    const access = jwt.sign({ userId: 'u-1', type: 'access' }, process.env.JWT_SECRET!);
    await expect(ctrl.callTool(`Bearer ${access}`, 'generate_image', { prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('токен продуктов — 401', async () => {
    const { ctrl, tools } = make();
    await expect(ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, 'generate_image', { prompt: 'x' })).rejects.toThrow(UnauthorizedException);
    expect(tools.executeTool).not.toHaveBeenCalled();
  });

  it('tools/list по токену: все инструменты CHAT_TOOLS, ни в одном нет userId и номера-примера', () => {
    const list = make().ctrl.listTools({ kind: 'token', userId: 'u-1' });
    expect(list.map((t) => t.name)).toEqual(CHAT_TOOLS.map((t) => t.name));
    for (const t of list) {
      expect(Object.keys(t.inputSchema.properties)).not.toContain('userId');
      expect(t.inputSchema.required).not.toContain('userId');
    }
    expect(JSON.stringify(list)).not.toContain('79030169187');
  });

  it('через настоящий MCP-сервер по токену: в схемах нет userId, вызов — от пользователя подписи', async () => {
    const { ctrl, tools } = make();
    const server = (ctrl as any).makeServer(bearer('u-owner'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    const listed = await client.listTools();
    expect(listed.tools.length).toBe(CHAT_TOOLS.length);
    for (const t of listed.tools) expect(Object.keys((t.inputSchema as any).properties ?? {})).not.toContain('userId');
    await client.callTool({ name: 'generate_image', arguments: { prompt: 'кот', userId: '70000000000' } });
    expect(tools.executeTool).toHaveBeenCalledWith('u-owner', 'generate_image', { prompt: 'кот' });
    await client.close();
  });

  describe('переходный путь: общий MCP_SECRET', () => {
    const SHARED = 'Bearer shared-spec';
    beforeEach(() => { process.env.MCP_SECRET = 'shared-spec'; });

    it('пользователь — из args.userId; в лог — строка без пользователя и аргументов', async () => {
      const { ctrl, tools } = make();
      const warn = jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      await ctrl.callTool(SHARED, 'generate_image', { userId: '70000000000', prompt: 'тайный промпт' });
      expect(tools.executeTool).toHaveBeenCalledWith('70000000000', 'generate_image', { prompt: 'тайный промпт' });
      expect(warn).toHaveBeenCalledWith('mcp: вызов по общему секрету (переходный путь), tool=generate_image');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('70000000000');
      expect(logged).not.toContain('тайный промпт');
    });

    it('без args.userId — отказ, инструмент не зовётся', async () => {
      const { ctrl, tools } = make();
      jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      const r: any = await ctrl.callTool(SHARED, 'generate_image', { prompt: 'x' });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error: 'userId argument required' });
      expect(tools.executeTool).not.toHaveBeenCalled();
    });

    // Прежний релей пишет пользователя в аргумент по схеме: без поля в схеме
    // между выкатом бэка и выкатом релея модель могла бы перестать его слать.
    it('tools/list по общему секрету — прежняя схема с обязательным userId, но без номера-примера', () => {
      const list = make().ctrl.listTools({ kind: 'shared' });
      for (const t of list) {
        expect(t.inputSchema.required[0]).toBe('userId');
        expect(t.inputSchema.properties).toHaveProperty('userId');
      }
      expect(JSON.stringify(list)).not.toContain('79030169187');
    });

    it('неверный секрет — 401', async () => {
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer not-the-secret', 'generate_image', { userId: 'u-1' })).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });

    it('MCP_SECRET не задан — пустой Bearer не проходит', async () => {
      delete process.env.MCP_SECRET;
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer ', 'generate_image', { userId: 'u-1' })).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Шаг 2: новые ожидания в тесте сообщений о сбоях**

`src/mcp/mcp.controller.problem-report.spec.ts` — заменить целиком:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpController } from './mcp.controller';
import { SUPPORT_NOTE } from '../problem-report/problem-report.service';
import { signLinkeonToolToken } from './linkeon-tool.token';

const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';

const OLD_SECRET = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = 'mcp-problem-report-spec'; });
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});

/** Bearer, с которым релей зовёт точку: токен хода, пользователь — в подписи. */
const bearer = (userId: string) => `Bearer ${signLinkeonToolToken(userId)}`;

const make = (result: any, supportNotified = true) => {
  const tools = { executeTool: jest.fn(async (..._a: any[]) => result) };
  const problems = { reportToolFailure: jest.fn((..._a: any[]) => ({ supportNotified })) };
  const chat = { activeAssistantFor: jest.fn(() => '22') };
  const ctrl = new McpController(tools as any, problems as any, chat as any);
  return { ctrl, tools, problems, chat };
};
const payload = (r: any) => JSON.parse(r.content[0].text);

describe('точка инструментов Linkeon: сбой инструмента — в поддержку', () => {
  it('сбой: отправка с ассистентом хода; в результате supportNotified и supportNote; ошибка и isError прежние', async () => {
    const result = { ok: false, error: KIRA_ERROR };
    const { ctrl, problems, chat, tools } = make(result);
    const r = await ctrl.callTool(bearer('u1'), 'generate_video', { mode: 'text2video', prompt: 'тайный промпт' });
    expect(tools.executeTool).toHaveBeenCalledWith('u1', 'generate_video', { mode: 'text2video', prompt: 'тайный промпт' });
    expect(chat.activeAssistantFor).toHaveBeenCalledWith('u1');
    expect(problems.reportToolFailure).toHaveBeenCalledWith({ userId: 'u1', assistantId: '22', tool: 'generate_video', error: KIRA_ERROR });
    expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR, supportNotified: true, supportNote: SUPPORT_NOTE });
    // Копия, а не правка: если ответ инструмента когда-нибудь закешируют, поля не протекут в чужой вызов.
    expect(result).toEqual({ ok: false, error: KIRA_ERROR });
  });

  it('через настоящий MCP-сервер: tools/call доходит до callTool и несёт supportNotified', async () => {
    const { ctrl } = make({ ok: false, error: KIRA_ERROR });
    const server = (ctrl as any).makeServer(bearer('u1'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(clientSide);
    const r: any = await client.callTool({ name: 'generate_video', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error: KIRA_ERROR, supportNotified: true, supportNote: SUPPORT_NOTE });
    await client.close();
  });

  // Решение владельца 24.10: в группу — только служебное, аргументы инструмента не уходят.
  it('аргументы инструмента в отправку не попадают', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    await ctrl.callTool(bearer('u1'), 'generate_video', { prompt: 'тайный промпт' });
    expect(JSON.stringify(problems.reportToolFailure.mock.calls)).not.toContain('тайный промпт');
  });

  it('сервис сказал «не сбой» — полей нет', async () => {
    const { ctrl } = make({ ok: false, error: 'insufficient_tokens' }, false);
    const p = payload(await ctrl.callTool(bearer('u1'), 'generate_image', { prompt: 'x' }));
    expect(p.supportNotified).toBeUndefined();
    expect(p.supportNote).toBeUndefined();
  });

  it('успех — в поддержку не ходим', async () => {
    const { ctrl, problems } = make({ ok: true, kind: 'image', imageUrl: 'https://x/y.png', tokensSpent: 5000 });
    const r = await ctrl.callTool(bearer('u1'), 'generate_image', { prompt: 'x' });
    expect(problems.reportToolFailure).not.toHaveBeenCalled();
    expect(r.isError).toBe(false);
  });

  it('сообщение о сбое упало — ответ инструмента всё равно уходит как был', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    problems.reportToolFailure.mockImplementation(() => { throw new Error('boom'); });
    const r = await ctrl.callTool(bearer('u1'), 'generate_video', {});
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR });
    expect(r.isError).toBe(true);
  });

  it('общий секрет без userId — отказ; инструмент и поддержка не зовутся', async () => {
    process.env.MCP_SECRET = 'shared-problem-spec';
    try {
      const { ctrl, tools, problems } = make({ ok: true });
      jest.spyOn((ctrl as any).logger, 'warn').mockImplementation(() => undefined);
      const r = await ctrl.callTool('Bearer shared-problem-spec', 'generate_video', { prompt: 'x' });
      expect(r.isError).toBe(true);
      expect(payload(r)).toEqual({ ok: false, error: 'userId argument required' });
      expect(tools.executeTool).not.toHaveBeenCalled();
      expect(problems.reportToolFailure).not.toHaveBeenCalled();
    } finally {
      delete process.env.MCP_SECRET;
      jest.restoreAllMocks();
    }
  });
});
```

- [ ] **Шаг 3: коммит тестов, прогон — падает**

```bash
git add src/mcp/mcp.controller.spec.ts src/mcp/mcp.controller.problem-report.spec.ts
git commit -q -m "test(mcp): точка инструментов Linkeon — пользователь из токена хода, переходный путь" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp/mcp.controller.spec.ts src/mcp/mcp.controller.problem-report.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕" | head -30'
```

Ожидается: оба файла FAIL; красных — большинство (у контроллера нет `listTools`, `callTool` принимает `(name, args)` и не бросает 401). Зелёными случайно могут оказаться «без args.userId — отказ» и «общий секрет без userId — отказ».

- [ ] **Шаг 4: реализация**

`src/mcp/mcp.controller.ts` — заменить целиком (адрес пока прежний, `@Controller('/mcp')`; второй — в задаче 3):

```ts
import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  Headers,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CHAT_TOOLS, ChatToolsService } from '../chat/chat-tools';
import { ChatService } from '../chat/chat.service';
import { ProblemReportService, SUPPORT_NOTE } from '../problem-report/problem-report.service';
import { verifyLinkeonToolToken } from './linkeon-tool.token';

/**
 * Кто зовёт инструмент — по Bearer.
 *   token  — релей с токеном хода (linkeon-tool.token.ts): пользователь из подписи;
 *   shared — переходный путь: общий MCP_SECRET, пользователь из args.userId,
 *            как до 26.10.2026. Снимается шагом 4 выката (спека
 *            docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md).
 */
export type McpCaller = { kind: 'token'; userId: string } | { kind: 'shared' };

/** Поле userId — только в схеме переходного пути и без примера номера. */
const LEGACY_USER_ID_DESCRIPTION =
  'Current user id from the system context. Required on the transitional shared-secret path — the server uses it to bill tokens and attribute history.';

@Controller('/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly tools: ChatToolsService,
    // Без @Optional сознательно: модуль, выпавший из McpModule, должен ронять
    // старт, а не молча выключать сообщения о сбоях — тихий отказ и был
    // поводом для этой работы (Кира, 24.10.2026).
    private readonly problems: ProblemReportService,
    private readonly chat: ChatService,
  ) {}

  /** Кто зовёт. Бросает 401 — значит звать инструмент нечем. */
  private caller(authHeader?: string): McpCaller {
    const header = authHeader || '';
    const shared = process.env.MCP_SECRET || '';
    if (shared && header === `Bearer ${shared}`) return { kind: 'shared' };
    const raw = header.replace(/^Bearer\s+/i, '').trim();
    if (!raw) throw new UnauthorizedException('Нет токена');
    try {
      return { kind: 'token', userId: verifyLinkeonToolToken(raw).userId };
    } catch (e: any) {
      throw new UnauthorizedException(`Токен не принят: ${e?.message}`);
    }
  }

  /**
   * tools/list. По токену — схемы инструментов как есть: пользователь в
   * подписи, аргумента userId нет. По общему секрету — прежняя схема с
   * обязательным userId: прежний релей пишет его в аргумент.
   * Вынесено из makeServer ради проверяемости.
   */
  listTools(caller: McpCaller) {
    return CHAT_TOOLS.map((t) => {
      const schema: any = t.input_schema ?? {};
      const properties: Record<string, any> = { ...(schema.properties ?? {}) };
      const required: string[] = [...(schema.required ?? [])];
      if (caller.kind === 'shared') {
        return {
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object' as const,
            properties: { ...properties, userId: { type: 'string', description: LEGACY_USER_ID_DESCRIPTION } },
            required: ['userId', ...required],
          },
        };
      }
      return { name: t.name, description: t.description, inputSchema: { type: 'object' as const, properties, required } };
    });
  }

  private makeServer(authHeader?: string): Server {
    const caller = this.caller(authHeader);
    const server = new Server(
      { name: 'linkeon-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools(caller) }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params ?? {};
      return this.callTool(authHeader, name, args);
    });
    return server;
  }

  /**
   * tools/call: пользователь — по Bearer, дальше ChatToolsService.executeTool.
   * Вынесено из makeServer ради проверяемости — как в products-mcp.controller.ts.
   */
  async callTool(authHeader: string | undefined, name: string, args: any) {
    const caller = this.caller(authHeader);
    // userId из аргументов выбрасывается ЯВНО (как в products-mcp.controller.ts):
    // по токену пользователь — только из подписи, поле модели не значит ничего.
    const { userId: argUserId, ...toolArgs } = args ?? {};
    let userId: string;
    if (caller.kind === 'token') {
      userId = caller.userId;
    } else {
      // Без пользователя и аргументов: по этой строке видно, что переходный
      // путь ещё кто-то зовёт (шаг 3 выката).
      this.logger.warn(`mcp: вызов по общему секрету (переходный путь), tool=${String(name).slice(0, 64)}`);
      if (!argUserId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'userId argument required' }) }],
          isError: true,
        };
      }
      userId = String(argUserId);
    }
    this.logger.log(`tools/call ${name} userId=${userId}`);
    const result: any = await this.tools.executeTool(userId, name, toolArgs);
    const notified = !!result && result.ok === false && this.reportFailure(userId, String(name), result);
    // Копия, а не правка объекта инструмента: если ответ когда-нибудь закешируют, поля не протекут в чужие вызовы.
    const out = notified ? { ...result, supportNotified: true, supportNote: SUPPORT_NOTE } : result;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out) }],
      isError: !result.ok,
    };
  }

  /**
   * Сбой инструмента — в «Поддержку linkeon» (src/problem-report). Отдаёт,
   * можно ли сказать ассистенту «команда в курсе»: true, если Telegram
   * настроен и сбой поставлен в отправку, склеен с уже отправленным или упёрся
   * в общий потолок. Отправка идёт без ожидания, её исход сюда не доходит:
   * отказ Telegram true не отменит. Никогда не бросает: исключение при разборе
   * сбоя превращается в false.
   */
  private reportFailure(userId: string, tool: string, result: any): boolean {
    try {
      const { supportNotified } = this.problems.reportToolFailure({
        userId,
        assistantId: this.chat.activeAssistantFor(userId),
        tool,
        error: String(result.error ?? ''),
      });
      return supportNotified;
    } catch (e: any) {
      this.logger.warn(`сообщение о сбое ${tool} не обработано: ${e?.message}`);
      return false;
    }
  }

  @Post()
  async post(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth?: string,
  ) {
    this.caller(auth); // отказ до всякой работы
    // Stateless: new transport per request, no session tracking.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = this.makeServer(auth);
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
      // Cleanup once response is fully flushed
      res.on('close', () => {
        try {
          transport.close();
          server.close();
        } catch {}
      });
    } catch (e: any) {
      this.logger.error(`mcp post failed: ${e?.message || e}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  @Get()
  async get(@Res() res: Response, @Headers('authorization') auth?: string) {
    this.caller(auth);
    // Stateless mode — no server-initiated SSE stream is supported.
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    });
  }

  @Delete()
  async delete(@Res() res: Response, @Headers('authorization') auth?: string) {
    this.caller(auth);
    // Stateless — nothing to terminate.
    res.status(204).send();
  }
}
```

- [ ] **Шаг 5: комментарий в точке продуктов**

`src/mcp/products-mcp.controller.ts`:

```ts
// было
 * На общей точке владелец приезжает полем запроса, которое пишет модель
 * (mcp.controller.ts, callTool, релей подсказывает телефон в системном промпте —
 * relay-agent/server.mjs:378). Для картинок это цена в токенах, для продуктов —
 * правка чужого сайта.
// стало
 * До 26.10.2026 на общей точке владелец приезжал полем запроса, которое пишет
 * модель (релей подсказывал телефон в реплике хода). Для картинок это цена в
 * токенах, для продуктов — правка чужого сайта. Теперь и там токен хода
 * (src/mcp/linkeon-tool.token.ts); поле осталось только на переходном пути по
 * общему секрету.
```

- [ ] **Шаг 6: коммит, прогон — зелёный**

```bash
git add src/mcp/mcp.controller.ts src/mcp/products-mcp.controller.ts
git commit -q -m "mcp: инструменты Linkeon — пользователь из токена хода; общий секрет — переходный путь со строкой в лог" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: все файлы `src/mcp` — `PASS` (`mcp.controller.spec.ts` — 13 тестов, `mcp.controller.problem-report.spec.ts` — 7); `tsc-exit` как в базе (`0`).

---

### Задача 3: второй адрес — `/webhook/mcp/linkeon`

**Решение по месту.** Nest 10.4 принимает у `@Controller` массив путей и проверяет исключение глобального префикса для КАЖДОГО пути отдельно (`RoutesResolver.registerRouters` → `RoutePathFactory.create` → `isRouteExcluded`). Исключение в `main.ts` — ровно путь `mcp`, поэтому `@Controller(['mcp', 'mcp/linkeon'])` даёт `/mcp` и `/webhook/mcp/linkeon` — одной логикой, одним экземпляром, без базового класса и без правки `main.ts`. Снятие `/mcp` в задаче 20 — убрать один элемент массива.

**Files:**
- Modify: `src/mcp/mcp.controller.ts` (декоратор класса и комментарий над ним)
- Test: `src/mcp/mcp.controller.routes.spec.ts`

- [ ] **Шаг 1: тест адресов**

`src/mcp/mcp.controller.routes.spec.ts`:

```ts
import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { INestApplication, Module, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { McpController } from './mcp.controller';
import { ChatToolsService } from '../chat/chat-tools';
import { ChatService } from '../chat/chat.service';
import { ProblemReportService } from '../problem-report/problem-report.service';
import { signLinkeonToolToken } from './linkeon-tool.token';

jest.setTimeout(60_000);

/**
 * АДРЕСА ТОЧКИ — живым приложением Nest, а не метаданными: адрес складывается
 * из @Controller и исключения глобального префикса в main.ts, и по отдельности
 * ни то ни другое правды не говорит (см. «адрес точки» в
 * products-mcp.controller.spec.ts). Зависимости контроллера — заглушки:
 * проверяются маршрутизация и вход, а не инструменты.
 */
@Module({
  controllers: [McpController],
  providers: [
    { provide: ChatToolsService, useValue: { executeTool: async () => ({ ok: true }) } },
    { provide: ProblemReportService, useValue: { reportToolFailure: () => ({ supportNotified: false }) } },
    { provide: ChatService, useValue: { activeAssistantFor: () => null } },
  ],
})
class McpRoutesSpecModule {}

describe('адреса точки инструментов Linkeon', () => {
  const OLD = { jwt: process.env.JWT_SECRET, mcp: process.env.MCP_SECRET };
  let app: INestApplication;
  let port = 0;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'mcp-routes-spec';
    process.env.MCP_SECRET = 'mcp-routes-shared';
    app = await NestFactory.create(McpRoutesSpecModule, { logger: false, abortOnError: false });
    // Ровно как в main.ts — что строка там та же, проверяет первый тест.
    app.setGlobalPrefix('webhook', { exclude: [{ path: 'mcp', method: RequestMethod.ALL }] });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
    if (OLD.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD.jwt;
    if (OLD.mcp === undefined) delete process.env.MCP_SECRET; else process.env.MCP_SECRET = OLD.mcp;
  });

  /** Запрос без keep-alive (agent: false): открытый сокет не держит jest. */
  function call(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  const token = () => `Bearer ${signLinkeonToolToken('u-routes')}`;
  const status = async (p: string, auth?: string) => (await call('GET', p, auth ? { Authorization: auth } : {})).status;

  it('в main.ts то же исключение из глобального префикса', () => {
    const src = fs.readFileSync(path.join(__dirname, '../main.ts'), 'utf8');
    expect(src).toMatch(/setGlobalPrefix\('webhook',\s*\{\s*exclude:\s*\[\{\s*path:\s*'mcp',\s*method:\s*RequestMethod\.ALL\s*\}\]/);
  });

  it('основной адрес /webhook/mcp/linkeon: с токеном хода — до обработчика (405 у GET), без — 401', async () => {
    expect(await status('/webhook/mcp/linkeon', token())).toBe(405);
    expect(await status('/webhook/mcp/linkeon')).toBe(401);
  });

  it('прежний /mcp на переходный период: общий секрет и токен хода доходят до обработчика', async () => {
    expect(await status('/mcp', 'Bearer mcp-routes-shared')).toBe(405);
    expect(await status('/mcp', token())).toBe(405);
    expect(await status('/mcp')).toBe(401);
  });

  it('других адресов у точки нет', async () => {
    expect(await status('/mcp/linkeon', token())).toBe(404);
    expect(await status('/webhook/mcp', token())).toBe(404);
  });

  it('tools/list по HTTP на основном адресе — без userId', async () => {
    const r = await call('POST', '/webhook/mcp/linkeon', {
      Authorization: token(),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(200);
    // Ответ — SSE (`event: message` + `data: {...}`) или чистый JSON.
    const data = r.text.split('\n').find((l) => l.startsWith('data: '));
    const msg = JSON.parse(data ? data.slice(6) : r.text);
    expect(msg.result.tools.length).toBeGreaterThan(0);
    for (const t of msg.result.tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('userId');
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/mcp/mcp.controller.routes.spec.ts
git commit -q -m "test(mcp): адреса точки инструментов Linkeon — живым приложением Nest" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp/mcp.controller.routes.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✓|✕|Expected|Received" | head -20'
```

Ожидается: FAIL ровно в двух тестах — «основной адрес…» (`Expected: 405`, `Received: 404`) и «tools/list по HTTP…» (`Expected: 200`, `Received: 404`). Остальные три зелёные.

- [ ] **Шаг 3: реализация**

`src/mcp/mcp.controller.ts`:

```ts
// было
@Controller('/mcp')
export class McpController {
// стало
/**
 * Инструменты Linkeon для ассистентов релея (mcp__linkeon__*). Спека:
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 *
 * Два адреса одной логики:
 *   • /webhook/mcp/linkeon — основной. Подпуть остаётся под глобальным
 *     префиксом: исключение в main.ts — ровно путь `mcp` (тот же разбор, что
 *     у /webhook/mcp/products). Доступен и на стенде, где nginx пропускает
 *     только /webhook/*.
 *   • /mcp — прежний, до снятия переходного пути (шаг 4 выката).
 * Сторож адресов — mcp.controller.routes.spec.ts (живое приложение Nest).
 */
@Controller(['mcp', 'mcp/linkeon'])
export class McpController {
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add src/mcp/mcp.controller.ts
git commit -q -m "mcp: точка инструментов Linkeon и на /webhook/mcp/linkeon" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: все `PASS`, в том числе `products-mcp.controller.spec.ts` («адрес точки» продуктов не задет); `tsc-exit=0`.

---

### Задача 4: поля релею — `linkeon-relay-fields.ts`

**Files:**
- Create: `src/chat/linkeon-relay-fields.ts`
- Test: `src/chat/linkeon-relay-fields.spec.ts`

- [ ] **Шаг 1: тест**

`src/chat/linkeon-relay-fields.spec.ts`:

```ts
import { createHmac } from 'crypto';
import { appendLinkeonFields, linkeonRelayFields, relayFsKey } from './linkeon-relay-fields';
import { verifyLinkeonToolToken } from '../mcp/linkeon-tool.token';

/**
 * Поля, которыми бэк передаёт релею инструменты Linkeon и папку хода — спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 */
describe('поля инструментов Linkeon для релея', () => {
  const OLD = { jwt: process.env.JWT_SECRET, salt: process.env.RELAY_FS_SALT, base: process.env.BACKEND_URL };
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  beforeEach(() => {
    put('JWT_SECRET', 'jwt-linkeon-fields');
    put('RELAY_FS_SALT', 'salt-linkeon-fields');
    put('BACKEND_URL', undefined);
  });
  afterAll(() => {
    put('JWT_SECRET', OLD.jwt);
    put('RELAY_FS_SALT', OLD.salt);
    put('BACKEND_URL', OLD.base);
  });

  it('токен хода разбирается в того же пользователя', () => {
    const f = linkeonRelayFields('79030169187', '79030169187_12_ru');
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: '79030169187' });
  });

  it('адрес точки по умолчанию — прод, /webhook/mcp/linkeon', () => {
    expect(linkeonRelayFields('u-1', 'k').linkeon_mcp_url).toBe('https://my.linkeon.io/webhook/mcp/linkeon');
  });

  it('база — из BACKEND_URL, хвостовой слеш не дублируется', () => {
    put('BACKEND_URL', 'https://test.linkeon.io/');
    expect(linkeonRelayFields('u-1', 'k').linkeon_mcp_url).toBe('https://test.linkeon.io/webhook/mcp/linkeon');
  });

  it('fs_key — 32 hex, постоянен для сессии, разный у разных сессий', () => {
    const a = linkeonRelayFields('79030169187', '79030169187_12_ru').fs_key;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(linkeonRelayFields('79030169187', '79030169187_12_ru').fs_key).toBe(a);
    expect(linkeonRelayFields('79030169187', '79030169187_12_en').fs_key).not.toBe(a);
  });

  it('fs_key не содержит номера', () => {
    const key = linkeonRelayFields('79030169187', '79030169187_12_ru').fs_key;
    expect(key).not.toContain('79030169187');
    expect(key).not.toContain('9030169187');
  });

  it('fs_key — первые 32 hex от HMAC-SHA256 ключа сессии на RELAY_FS_SALT', () => {
    const want = createHmac('sha256', 'salt-linkeon-fields').update('79030169187_12_ru').digest('hex').slice(0, 32);
    expect(relayFsKey('79030169187_12_ru')).toBe(want);
  });

  it('без RELAY_FS_SALT — на JWT_SECRET', () => {
    put('RELAY_FS_SALT', undefined);
    const want = createHmac('sha256', 'jwt-linkeon-fields').update('79030169187_12_ru').digest('hex').slice(0, 32);
    expect(relayFsKey('79030169187_12_ru')).toBe(want);
  });

  it('appendLinkeonFields кладёт три поля под их именами', () => {
    const got: Record<string, string> = {};
    const f = linkeonRelayFields('u-1', 'k');
    appendLinkeonFields({ append: (n: string, v: string) => { got[n] = v; } }, f);
    expect(got).toEqual({ linkeon_token: f.linkeon_token, linkeon_mcp_url: f.linkeon_mcp_url, fs_key: f.fs_key });
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/chat/linkeon-relay-fields.spec.ts
git commit -q -m "test(chat): поля инструментов Linkeon для релея" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/linkeon-relay-fields.spec.ts --maxWorkers=2 2>&1 | tail -12'
```

Ожидается: FAIL — `Cannot find module './linkeon-relay-fields'`.

- [ ] **Шаг 3: реализация**

`src/chat/linkeon-relay-fields.ts`:

```ts
import { createHmac } from 'crypto';
import { signLinkeonToolToken } from '../mcp/linkeon-tool.token';

/**
 * Поля, которыми бэк передаёт релею инструменты Linkeon (mcp__linkeon__*) и
 * папку хода. Спека: docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 *
 *   linkeon_token   — токен хода: пользователь в подписи, модели он не виден;
 *   linkeon_mcp_url — /webhook/mcp/linkeon (подпуть mcp под глобальным
 *                     префиксом, как /webhook/mcp/products); без BACKEND_URL —
 *                     адрес прода;
 *   fs_key          — имя папки хода на релее вместо ключа сессии, где у
 *                     телефонных пользователей номер. Постоянен для сессии.
 *
 * Чистые функции по той же причине, что products-relay-fields.ts: конструктор
 * ChatService и так на 26 зависимостей.
 *
 * Шлются только на путях с известным пользователем: ход веб-ассистента, ход с
 * вложениями, agentReply с пользователем. Анонимным и служебным ходам
 * (clean-ask, первый контакт, автоблог, проба качества) — нет; сторож —
 * linkeon-fields-anonymous.spec.ts.
 */
export interface LinkeonRelayFields {
  linkeon_token: string;
  linkeon_mcp_url: string;
  fs_key: string;
}

/**
 * Первые 32 hex от HMAC-SHA256 ключа сессии релея. Соль — RELAY_FS_SALT из
 * .env (у прода и стенда свои); без неё — JWT_SECRET, и тогда смена JWT_SECRET
 * переименует папки новых ходов (старые ссылки живут). Длина и алфавит —
 * контракт с релеем: relay-agent/paths.mjs, FS_KEY_RE.
 */
export function relayFsKey(sessionKey: string): string {
  const salt = (process.env.RELAY_FS_SALT || '').trim() || process.env.JWT_SECRET || 'default_secret_change_me';
  return createHmac('sha256', salt).update(String(sessionKey)).digest('hex').slice(0, 32);
}

export function linkeonRelayFields(userId: string, sessionKey: string): LinkeonRelayFields {
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  return {
    linkeon_token: signLinkeonToolToken(userId),
    linkeon_mcp_url: `${base}/webhook/mcp/linkeon`,
    fs_key: relayFsKey(sessionKey),
  };
}

/** Три поля — в multipart-запрос к релею (form-data). */
export function appendLinkeonFields(fd: { append(name: string, value: string): void }, f: LinkeonRelayFields): void {
  fd.append('linkeon_token', f.linkeon_token);
  fd.append('linkeon_mcp_url', f.linkeon_mcp_url);
  fd.append('fs_key', f.fs_key);
}
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add src/chat/linkeon-relay-fields.ts
git commit -q -m "chat: поля релею — токен хода, адрес точки, fs_key без номера" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/linkeon-relay-fields.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: `PASS`, 8 тестов.

---

### Задача 5: лента шагов — префикс загрузки по `fs_key`

**Files:**
- Modify: `src/chat/activity-map.ts` (`ActivityOwner`, `fileName`)
- Test: `src/chat/activity-map.spec.ts` (новый `describe` в конце файла)

- [ ] **Шаг 1: тест — в конец `src/chat/activity-map.spec.ts`**

```ts
// fs_key (linkeon-relay-fields.ts): релей с 26.10.2026 называет загрузки
// `<fs_key>_<имя>` — без номера телефона в имени.
describe('toActivity — загрузки с префиксом fs_key', () => {
  const FS_KEY = '0123456789abcdef0123456789abcdef';
  const WHO_FS = { userId: PHONE, relaySessionId: `${PHONE}_12_ru`, fsKey: FS_KEY };

  it('префикс fs_key срезан, имя видно', () => {
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${FS_KEY}_egrul.pdf` }), WHO_FS))
      .toEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });

  it('загрузка до выката (префикс — ключ сессии) при известном fs_key — тоже срезана', () => {
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${PHONE}_12_ru_egrul.pdf` }), WHO_FS))
      .toEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });

  it('результат в папке fs_key — имя видно', () => {
    expect(toActivity('Write', json({ file_path: `/tmp/agent-output/${FS_KEY}/report.docx` }), WHO_FS))
      .toEqual({ type: 'activity', kind: 'write_file', detail: 'report.docx' });
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/chat/activity-map.spec.ts
git commit -q -m "test(chat): шаги работы — префикс загрузки по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/activity-map.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕|Expected|Received" | head -12'
```

Ожидается: FAIL ровно в «префикс fs_key срезан, имя видно» — в `Received` `detail: "0123456789abcdef0123456789abcdef_egrul.pdf"`.

- [ ] **Шаг 3: реализация**

`src/chat/activity-map.ts`:

```ts
// было
export interface ActivityOwner {
  userId: string;
  /** Ключ сессии релея: с него начинается имя загруженного файла на диске релея. */
  relaySessionId?: string;
}
// стало
export interface ActivityOwner {
  userId: string;
  /** Ключ сессии релея: с него начинается имя загрузки у релея без fs_key и у загрузок до 26.10.2026. */
  relaySessionId?: string;
  /** fs_key хода (linkeon-relay-fields.ts): с него начинается имя загрузки у релея с fs_key. */
  fsKey?: string;
}
```

```ts
// было
    if (who.relaySessionId) {
      const fsKey = who.relaySessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, RELAY_FS_KEY_MAX);
      const prefix = `${fsKey}_`;
      if (base.startsWith(prefix)) base = base.slice(prefix.length);
    }
// стало
    // Префикс — ключ папки хода: fs_key, а у релея без него и у загрузок до
    // выката — санитизированный ключ сессии. Срезается первый совпавший.
    const keys = [
      who.fsKey,
      who.relaySessionId?.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, RELAY_FS_KEY_MAX),
    ].filter((k): k is string => !!k);
    for (const key of keys) {
      if (base.startsWith(`${key}_`)) {
        base = base.slice(key.length + 1);
        break;
      }
    }
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add src/chat/activity-map.ts
git commit -q -m "chat: шаги работы срезают префикс загрузки и по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/activity-map.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: `PASS`, все прежние тесты файла плюс 3 новых.

---

### Задача 6: ход веб-ассистента — поля, шаги, список файлов сессии

**Files:**
- Modify: `src/chat/chat.service.ts` (импорты; `streamUniversalAgent`: после `const relaySid = …`, `callUpstreamOnce`, обработчик `ev.type === 'tool'`, подстановка пустых скобок)
- Test: `src/chat/chat.service.linkeon-fields.spec.ts`

Список файлов сессии сейчас спрашивает папку `<userId>_<assistantId>` — без языка, тогда как релей с 18.08 кладёт файлы в папку ключа `<userId>_<assistantId>_<язык>`. Новый порядок: сначала `fs_key`, пусто — ключ сессии хода (`relaySid`). Это и переход (релей ещё без `fs_key`, файлы прежних ходов), и починка старого расхождения.

- [ ] **Шаг 1: тест**

`src/chat/chat.service.linkeon-fields.spec.ts`:

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { relaySessionKey } from './relay-session';
import { relayFsKey } from './linkeon-relay-fields';
import { verifyLinkeonToolToken } from '../mcp/linkeon-tool.token';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Поля инструментов Linkeon (linkeon_token, linkeon_mcp_url, fs_key) на путях
 * с известным пользователем — спека 2026-10-26-mcp-turn-token-design.md.
 * Гоняются НАСТОЯЩИЕ streamUniversalAgent и agentReply с замоканными
 * axios/pg/res — как в chat.service.help-fields.spec.ts.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const OLD_SECRET = process.env.JWT_SECRET;
const realSetTimeout = global.setTimeout;
beforeAll(() => {
  process.env.JWT_SECRET = 'linkeon-fields-spec';
  // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});
beforeEach(() => jest.clearAllMocks());

const SID = relaySessionKey('u-test', '12', 'ru');

function streamHarness(events: any[], sessionFiles: (url: string) => any[] = () => []) {
  const pg = { query: jest.fn(async (sql: string) => (/AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream(events) }));
  const get = axios.get as jest.Mock;
  get.mockImplementation(async (url: string) => ({ data: sessionFiles(url) }));
  const written: any[] = [];
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((line: string) => { try { written.push(JSON.parse(line)); } catch {} return true; }),
    end: jest.fn(),
  };
  const run = async () => {
    await (svc as any).streamUniversalAgent(
      'u-test', 'сделай отчёт', '12', '12', [], '', res, 'Роман', '', '', undefined, false,
      undefined, undefined, undefined, undefined, undefined, false, { activity: true, ask: false },
    );
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };
  return { run, post, get, written };
}

describe('streamUniversalAgent: поля инструментов Linkeon', () => {
  it('ход везёт токен хода, адрес точки и fs_key своей сессии', async () => {
    const h = streamHarness([{ type: 'delta', text: 'ок' }, { type: 'done' }]);
    await h.run();
    const f = fieldsOf(h.post.mock.calls[0][1]);
    expect(f.sessionId).toBe(SID);
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-test' });
    expect(f.linkeon_mcp_url).toMatch(/^https:\/\/.+\/webhook\/mcp\/linkeon$/);
    expect(f.fs_key).toBe(relayFsKey(SID));
  });

  it('шаг работы: загрузка с префиксом fs_key — без префикса', async () => {
    const h = streamHarness([
      { type: 'tool', tool: 'Read', input: JSON.stringify({ file_path: `/tmp/agent-uploads/${relayFsKey(SID)}_egrul.pdf` }) },
      { type: 'delta', text: 'ок' },
      { type: 'done' },
    ]);
    await h.run();
    expect(h.written).toContainEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });

  it('пустые скобки: файлы сессии — сначала по fs_key, пусто — по ключу сессии хода', async () => {
    const h = streamHarness([{ type: 'delta', text: 'Готово: [Скачать report.pdf]()' }, { type: 'done' }]);
    await h.run();
    expect(h.get.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining(`/session/${relayFsKey(SID)}/files`),
      expect.stringContaining(`/session/${SID}/files`),
    ]);
  });

  it('нашлось по fs_key — второй раз релей не спрашивают', async () => {
    const fsKey = relayFsKey(SID);
    const h = streamHarness(
      [{ type: 'delta', text: 'Готово: [Скачать report.pdf]()' }, { type: 'done' }],
      (url) => (url.includes(`/session/${fsKey}/`) ? [{ name: 'report.pdf', url: `/files/${fsKey}/report.pdf`, size: 1 }] : []),
    );
    await h.run();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls[0][0]).toContain(`/session/${fsKey}/files`);
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/chat/chat.service.linkeon-fields.spec.ts
git commit -q -m "test(chat): ход веб-ассистента — поля инструментов Linkeon, шаги и файлы по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/chat.service.linkeon-fields.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✓|✕" | head -12'
```

Ожидается: FAIL, все 4 красные (полей нет; в шаге имя с префиксом; список файлов спрашивают один раз по `u-test_12`).

- [ ] **Шаг 3: импорт**

`src/chat/chat.service.ts`:

```ts
// было
import { productsRelayFields } from './products-relay-fields';
// стало
import { productsRelayFields } from './products-relay-fields';
import { appendLinkeonFields, linkeonRelayFields } from './linkeon-relay-fields';
```

- [ ] **Шаг 4: поля на ход**

```ts
// было
      const relaySid = relaySessionKey(userId, assistantId, userLanguage, fresh ? freshSessionId : undefined);
      const callUpstreamOnce = async (): Promise<void> => {
// стало
      const relaySid = relaySessionKey(userId, assistantId, userLanguage, fresh ? freshSessionId : undefined);
      // Инструменты Linkeon и папка хода на релее — токеном хода и ключом без
      // номера телефона (linkeon-relay-fields.ts). Один раз на ход: повтор
      // self-heal идёт с теми же полями и в ту же папку.
      const linkeonFields = linkeonRelayFields(userId, relaySid);
      const callUpstreamOnce = async (): Promise<void> => {
```

```ts
// было
        // Инструмент продуктов. В отличие от MCP-инструментов на общей точке,
        // владелец едет ПОДПИСЬЮ в заголовке, а не подсказкой в промпте:
        // телефоном в аргументе правились бы чужие сайты.
// стало
        // Инструмент продуктов. Владелец едет ПОДПИСЬЮ в заголовке, а не
        // подсказкой в промпте: телефоном в аргументе правились бы чужие сайты.
```

```ts
// было
        fd.append('products_token', pf.products_token);
        fd.append('products_mcp_url', pf.products_mcp_url);

        const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
// стало
        fd.append('products_token', pf.products_token);
        fd.append('products_mcp_url', pf.products_mcp_url);
        // Инструменты Linkeon (mcp__linkeon__*): пользователь — в подписи
        // токена, а не в аргументе, который пишет модель; папка хода — fs_key.
        appendLinkeonFields(fd, linkeonFields);

        const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
```

- [ ] **Шаг 5: шаги работы**

```ts
// было
                      const step = toActivity(ev.tool, ev.input, { userId, relaySessionId: relaySid });
// стало
                      const step = toActivity(ev.tool, ev.input, { userId, relaySessionId: relaySid, fsKey: linkeonFields.fs_key });
```

- [ ] **Шаг 6: список файлов сессии**

```ts
// было
          const sid = fresh && freshSessionId ? freshSessionId : `${userId}_${assistantId}`;
          // Список нужен только чтобы сопоставить ИМЯ из пустых скобок с
          // адресом. Готовый адрес самодостаточен — ради него relay не дёргаем.
          const listed = hasEmpty
            ? await axios
                .get(`${AGENT_URL}/session/${encodeURIComponent(sid)}/files`, {
                  timeout: 10_000,
                  headers: relayAuthHeaders(),
                  maxRedirects: 0,
                })
                .then((r) => (Array.isArray(r.data) ? r.data : []))
                .catch((e) => {
                  if (e?.response?.status === 401) this.logger.warn('релей отклонил секрет (401)');
                  return [] as any[];
                })
            : [];
// стало
          const listSession = (sid: string) =>
            axios
              .get(`${AGENT_URL}/session/${encodeURIComponent(sid)}/files`, {
                timeout: 10_000,
                headers: relayAuthHeaders(),
                maxRedirects: 0,
              })
              .then((r) => (Array.isArray(r.data) ? r.data : []))
              .catch((e) => {
                if (e?.response?.status === 401) this.logger.warn('релей отклонил секрет (401)');
                return [] as any[];
              });
          // Список нужен только чтобы сопоставить ИМЯ из пустых скобок с
          // адресом. Готовый адрес самодостаточен — ради него relay не дёргаем.
          // Папка хода — fs_key (linkeon-relay-fields.ts); пусто — папка по
          // ключу сессии хода: релей ещё без fs_key или файл из хода до
          // выката. До 26.10.2026 здесь стоял ключ без языка
          // (`<userId>_<assistantId>`), и обычный ход смотрел не в свою папку.
          let listed: any[] = [];
          if (hasEmpty) {
            listed = await listSession(linkeonFields.fs_key);
            if (listed.length === 0) listed = await listSession(relaySid);
          }
```

```ts
// было
            this.logger.log(`filled ${resolved.length} file link(s) for ${sid}`);
// стало
            this.logger.log(`filled ${resolved.length} file link(s) for ${relaySid}`);
```

- [ ] **Шаг 7: коммит, прогон — зелёный, плюс соседи и сторож секрета релея**

```bash
git add src/chat/chat.service.ts
git commit -q -m "chat: ход веб-ассистента шлёт токен хода и fs_key; шаги и файлы сессии — по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: строк `FAIL` нет (в том числе `relay-auth.spec.ts` — вызов `/session/` по-прежнему с `relayAuthHeaders()` в пределах 400 символов, и `chat.service.chat-files.spec.ts`); `tsc-exit=0`.

---

### Задача 7: `agentReply` и проба качества

**Как `agentReply` узнаёт пользователя.** Первым параметром `userId` от публичных обёрток `generateAgentReply(userId, assistantId, message, sessionIdOverride?)` и `generateAgentReplyWithCharge(…)`; сессия релея — `sessionIdOverride` или `relaySessionKey(userId, assistantId, язык)`. Вызывающие (сверено грепом):

| Вызывающий | Пользователь | Сессия | Поля |
|---|---|---|---|
| `src/routine-push/routine-push.service.ts:84` (рутины) | настоящий | ключ сессии пользователя | да |
| `src/trip/trip.service.ts:392` («Путь», итог дня) | настоящий | ключ сессии пользователя | да |
| `src/voice-call/voice-call.service.ts:647` (итоги звонка) | настоящий | `voice_summary_<uuid>` | да |
| `src/voice-call/voice-document.service.ts:236, 410` (голосовые документы) | настоящий | `voice_note_<callId>`, `voice_doc_<callId>_<docId>` | да |
| `src/voice-call/specialist-job.service.ts:102, 262` (консультация в звонке и её сжатие) | настоящий | своя / `voice_condense_<uuid>` | да (по умолчанию; в спеке не названы — см. отчёт) |
| `src/monitoring/quality-monitor.service.ts:66` (проба качества) | тестовый `70000000000` (`QUALITY_PROBE_USER`) | `qprobe_<…>` | **нет** |

Пользователь у пробы — настоящий тестовый аккаунт, поэтому «есть ли пользователь» по `userId` не отличить. Решение: явный параметр `AgentReplyOpts.linkeonTools` (по умолчанию `true`), проба передаёт `false`. clean-ask, первый контакт и автоблог идут мимо `agentReply` (свои вызовы релея) — задача 9.

**Files:**
- Modify: `src/chat/chat.service.ts` (перед `@Injectable()` класса; `generateAgentReply`, `generateAgentReplyWithCharge`, `agentReply`)
- Modify: `src/monitoring/quality-monitor.service.ts` (`probeOnce`)
- Test: `src/chat/chat.service.linkeon-fields.spec.ts` (новый `describe` в конце), `src/monitoring/quality-monitor.probe-tools.spec.ts`

- [ ] **Шаг 1: тест `agentReply` — в конец `src/chat/chat.service.linkeon-fields.spec.ts`**

```ts
describe('agentReply: поля инструментов Linkeon', () => {
  const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };
  function replyHarness() {
    const pg = { query: jest.fn(async (sql: string) => (/FROM agents WHERE id/.test(sql) ? { rows: [AGENT] } : { rows: [] })) };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
    const post = axios.post as jest.Mock;
    post.mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
    const last = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
    return { svc, last };
  }

  it('рутина и «Путь» (без своей сессии): токен пользователя, fs_key его сессии', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('u-routine', '12', 'утренний текст');
    const f = last();
    const sid = relaySessionKey('u-routine', '12', 'ru');
    expect(f.sessionId).toBe(sid);
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-routine' });
    expect(f.fs_key).toBe(relayFsKey(sid));
  });

  it('итоги звонка (своя сессия): fs_key — от этой сессии', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('u-voice', '12', 'итоги', 'voice_summary_abc');
    const f = last();
    expect(f.sessionId).toBe('voice_summary_abc');
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-voice' });
    expect(f.fs_key).toBe(relayFsKey('voice_summary_abc'));
  });

  it('голосовой документ (со списанием): поля тоже есть', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReplyWithCharge('u-voice', '12', 'документ', 'voice_doc_c1_d1');
    const f = last();
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u-voice' });
    expect(f.fs_key).toBe(relayFsKey('voice_doc_c1_d1'));
  });

  it('linkeonTools: false (проба качества) — полей нет', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('70000000000', '12', 'проба', 'qprobe_12_1', { linkeonTools: false });
    const f = last();
    expect(f.sessionId).toBe('qprobe_12_1');
    for (const k of ['linkeon_token', 'linkeon_mcp_url', 'fs_key']) expect(f[k]).toBeUndefined();
  });
});
```

- [ ] **Шаг 2: тест пробы качества**

`src/monitoring/quality-monitor.probe-tools.spec.ts`:

```ts
jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
  sendTelegramAlert: jest.fn(async () => {}),
}));

import { QualityMonitorService } from './quality-monitor.service';

/**
 * Проба качества — служебный ход тестового аккаунта: инструменты Linkeon ей
 * не нужны, поля токена хода она не получает (спека
 * 2026-10-26-mcp-turn-token-design.md, «Кто не получает»).
 */
describe('проба качества — без инструментов Linkeon', () => {
  const OLD = { user: process.env.QUALITY_PROBE_USER, agent: process.env.QUALITY_PROBE_ASSISTANT, off: process.env.QUALITY_PROBE_DISABLED };
  beforeAll(() => {
    delete process.env.QUALITY_PROBE_USER;
    delete process.env.QUALITY_PROBE_ASSISTANT;
    delete process.env.QUALITY_PROBE_DISABLED;
  });
  afterAll(() => {
    for (const [k, v] of [['QUALITY_PROBE_USER', OLD.user], ['QUALITY_PROBE_ASSISTANT', OLD.agent], ['QUALITY_PROBE_DISABLED', OLD.off]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('ответ ассистента зовётся с { linkeonTools: false } в своей qprobe-сессии', async () => {
    const chat = { generateAgentReply: jest.fn(async (..._a: any[]) => 'Желаю вам хорошего дня!') };
    const synthetic = { record: jest.fn(async () => {}) };
    const svc = new QualityMonitorService({ query: jest.fn(async () => ({ rows: [] })) } as any, chat as any, synthetic as any);
    await svc.qualityProbe();
    expect(chat.generateAgentReply).toHaveBeenCalledWith(
      '70000000000', '12', expect.any(String), expect.stringMatching(/^qprobe_12_/), { linkeonTools: false },
    );
  });
});
```

- [ ] **Шаг 3: коммит тестов, прогон — падает**

```bash
git add src/chat/chat.service.linkeon-fields.spec.ts src/monitoring/quality-monitor.probe-tools.spec.ts
git commit -q -m "test(chat): agentReply — поля инструментов Linkeon у вызовов с пользователем, без них у пробы" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/chat.service.linkeon-fields.spec.ts src/monitoring/quality-monitor.probe-tools.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✓|✕" | head -16'
```

Ожидается: FAIL — в `agentReply` красные три первых (полей нет), «linkeonTools: false» зелёный и до правки; проба — красная (вызов с четырьмя аргументами).

- [ ] **Шаг 4: тип параметров**

`src/chat/chat.service.ts`:

```ts
// было
@Injectable()
export class ChatService {
// стало
/** Что ещё уходит релею в ответе ассистента вне чата (agentReply). */
export interface AgentReplyOpts {
  /**
   * Инструменты Linkeon (mcp__linkeon__*) от имени userId — токен хода и
   * папка по fs_key (linkeon-relay-fields.ts). По умолчанию — да: у рутин,
   * «Пути», голосовых документов, итогов и консультаций звонка пользователь
   * настоящий. Нет — у пробы качества (quality-monitor): служебный ход
   * тестового аккаунта.
   */
  linkeonTools?: boolean;
}

@Injectable()
export class ChatService {
```

- [ ] **Шаг 5: сигнатуры и поля**

```ts
// было
  async generateAgentReply(userId: string, assistantId: string, message: string, sessionIdOverride?: string): Promise<string> {
    const { text } = await this.agentReply(userId, assistantId, message, sessionIdOverride, false);
    return text;
  }
// стало
  async generateAgentReply(
    userId: string, assistantId: string, message: string, sessionIdOverride?: string, opts: AgentReplyOpts = {},
  ): Promise<string> {
    const { text } = await this.agentReply(userId, assistantId, message, sessionIdOverride, false, opts);
    return text;
  }
```

```ts
// было
  async generateAgentReplyWithCharge(
    userId: string, assistantId: string, message: string, sessionIdOverride?: string,
  ): Promise<{ text: string; tokens: number; costUsd: number }> {
    return this.agentReply(userId, assistantId, message, sessionIdOverride, true);
  }

  private async agentReply(
    userId: string, assistantId: string, message: string, sessionIdOverride: string | undefined, billed: boolean,
  ): Promise<{ text: string; tokens: number; costUsd: number }> {
// стало
  async generateAgentReplyWithCharge(
    userId: string, assistantId: string, message: string, sessionIdOverride?: string, opts: AgentReplyOpts = {},
  ): Promise<{ text: string; tokens: number; costUsd: number }> {
    return this.agentReply(userId, assistantId, message, sessionIdOverride, true, opts);
  }

  private async agentReply(
    userId: string, assistantId: string, message: string, sessionIdOverride: string | undefined, billed: boolean,
    opts: AgentReplyOpts = {},
  ): Promise<{ text: string; tokens: number; costUsd: number }> {
```

```ts
// было
    fd.append(
      'sessionId',
      sessionIdOverride ||
        relaySessionKey(userId, assistantId, await this.language.resolveUserLanguage(userId)),
    );
// стало
    const relaySid = sessionIdOverride ||
      relaySessionKey(userId, assistantId, await this.language.resolveUserLanguage(userId));
    fd.append('sessionId', relaySid);
    // Инструменты Linkeon — от имени userId по токену хода (см. AgentReplyOpts).
    if (opts.linkeonTools !== false) appendLinkeonFields(fd, linkeonRelayFields(userId, relaySid));
```

- [ ] **Шаг 6: проба качества**

`src/monitoring/quality-monitor.service.ts`:

```ts
// было
      text = await this.chat!.generateAgentReply(probeUser, assistantId, prompt, probeSession);
// стало
      // Без инструментов Linkeon: проба проверяет текст ответа, а ход идёт от
      // тестового аккаунта (спека 2026-10-26-mcp-turn-token, «Кто не получает»).
      text = await this.chat!.generateAgentReply(probeUser, assistantId, prompt, probeSession, { linkeonTools: false });
```

- [ ] **Шаг 7: коммит, прогон — зелёный, плюс все вызывающие**

```bash
git add src/chat/chat.service.ts src/monitoring/quality-monitor.service.ts
git commit -q -m "chat: agentReply шлёт токен хода и fs_key, когда есть пользователь; проба качества — без" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat src/monitoring src/voice-call src/trip src/routine-push --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: строк `FAIL` нет (моки вызывающих в `specialist-job.service.spec.ts`, `trip.service.spec.ts` и др. не сверяют число аргументов); `tsc-exit=0`. Если какой-то тест вызывающего сверял вызов `generateAgentReply*` через `toHaveBeenCalledWith` ровно с четырьмя аргументами и покраснел — проверить, что вызов сам не менялся (вызывающие не трогаются), и описать в отчёте.

---

### Задача 8: ход с вложениями

**Files:**
- Modify: `src/chat/chat.service.ts` (импорт; `buildUploadHandoff` — тип результата и возврат)
- Modify: `src/chat/chat.controller.ts` (импорт; поля после `products_mcp_url`; `toActivity` в обработчике `ev.type === 'tool'`)
- Test: `src/chat/chat.upload-session.spec.ts`

- [ ] **Шаг 1: тест — в `src/chat/chat.upload-session.spec.ts`**

К импортам вверху:

```ts
import { relayFsKey } from './linkeon-relay-fields';
import { verifyLinkeonToolToken } from '../mcp/linkeon-tool.token';
```

После функции `upload()` — ещё одна, с лентой событий и ответом клиенту:

```ts
/** Как upload(), но со своей лентой событий релея; отдаёт и поля, и то, что ушло клиенту. */
async function uploadRun(body: any, events: any[]): Promise<{ fields: Record<string, string>; written: any[] }> {
  const svc = makeService(makePg());
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
  const ctrl = new ChatController(svc, jwtSvc as any, neo4j as any, undefined);
  const post = jest.fn(async () => ({ data: sseStream(events) }));
  (axios as any).default = { post };
  (axios as any).post = post;
  const res = makeRes();
  await ctrl.uploadAndChat(makeReq(body), res);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { fields: fieldsOf((post.mock.calls[0] as any[])[1]), written: res.written };
}
```

В конец файла:

```ts
describe('uploadAndChat: инструменты Linkeon и папка хода', () => {
  afterEach(() => jest.clearAllMocks());

  it('везёт токен хода, адрес точки и fs_key той же сессии, что у текстового хода', async () => {
    const f = await upload(makePg());
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u1' });
    expect(f.linkeon_mcp_url).toMatch(/\/webhook\/mcp\/linkeon$/);
    expect(f.fs_key).toBe(relayFsKey(relaySessionKey('u1', '12', 'ru')));
  });

  it('шаг работы: загрузка с префиксом fs_key — без префикса', async () => {
    const fsKey = relayFsKey(relaySessionKey('u1', '12', 'ru'));
    const { written } = await uploadRun({ ui: JSON.stringify({ activity: true, ask: false }) }, [
      { type: 'tool', tool: 'Read', input: JSON.stringify({ file_path: `/tmp/agent-uploads/${fsKey}_egrul.pdf` }) },
      { type: 'delta', text: ANSWER },
      { type: 'done' },
    ]);
    expect(written).toContainEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/chat/chat.upload-session.spec.ts
git commit -q -m "test(chat): ход с вложениями — токен хода и fs_key той же сессии" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/chat.upload-session.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕" | head -10'
```

Ожидается: FAIL ровно в двух новых тестах.

- [ ] **Шаг 3: `buildUploadHandoff`**

`src/chat/chat.service.ts`:

```ts
// было
import { appendLinkeonFields, linkeonRelayFields } from './linkeon-relay-fields';
// стало
import { LinkeonRelayFields, appendLinkeonFields, linkeonRelayFields } from './linkeon-relay-fields';
```

```ts
// было
  }): Promise<{ sessionId: string; systemPrompt: string; history: string; products: { products_token: string; products_mcp_url: string } }> {
// стало
  }): Promise<{ sessionId: string; systemPrompt: string; history: string; products: { products_token: string; products_mcp_url: string }; linkeon: LinkeonRelayFields }> {
```

```ts
// было
      agent: isCustom ? 'custom' : 'staff',
    });

    return { sessionId, systemPrompt, history, products };
// стало
      agent: isCustom ? 'custom' : 'staff',
    });
    // Инструменты Linkeon и папка хода — те же, что у текстового хода этой сессии.
    const linkeon = linkeonRelayFields(userId, sessionId);

    return { sessionId, systemPrompt, history, products, linkeon };
```

- [ ] **Шаг 4: контроллер**

`src/chat/chat.controller.ts`:

```ts
// было
import { relayAuthHeaders } from './relay-auth';
// стало
import { relayAuthHeaders } from './relay-auth';
import { appendLinkeonFields } from './linkeon-relay-fields';
```

```ts
// было
    fd.append('products_token', handoff.products.products_token);
    fd.append('products_mcp_url', handoff.products.products_mcp_url);
// стало
    fd.append('products_token', handoff.products.products_token);
    fd.append('products_mcp_url', handoff.products.products_mcp_url);
    // Инструменты Linkeon и папка хода — как у текстового хода (linkeon-relay-fields.ts).
    appendLinkeonFields(fd, handoff.linkeon);
```

```ts
// было
                  const step = toActivity(ev.tool, ev.input, { userId, relaySessionId: handoff.sessionId });
// стало
                  const step = toActivity(ev.tool, ev.input, { userId, relaySessionId: handoff.sessionId, fsKey: handoff.linkeon.fs_key });
```

- [ ] **Шаг 5: коммит, прогон — зелёный**

```bash
git add src/chat/chat.service.ts src/chat/chat.controller.ts
git commit -q -m "chat: ход с вложениями шлёт токен хода и fs_key; шаги — по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: строк `FAIL` нет; `tsc-exit=0`.

---

### Задача 9: сторожа — анонимные и служебные ходы без полей

Эти пути не меняются, поэтому тесты зелёные сразу: они держат будущие правки (скопированный вызов `appendLinkeonFields` в анонимный путь выдал бы модели инструменты чужого — тестового или случайного — аккаунта). Пробу качества стережёт `quality-monitor.probe-tools.spec.ts` (задача 7).

**Files:**
- Test: `src/chat/linkeon-fields-anonymous.spec.ts`

- [ ] **Шаг 1: тест**

`src/chat/linkeon-fields-anonymous.spec.ts`:

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { CleanAskService } from '../ask/clean-ask.service';
import { BlogRelayClient } from '../blog/blog-relay.client';

jest.mock('axios');

/**
 * Анонимные и служебные ходы — без инструментов Linkeon (спека
 * 2026-10-26-mcp-turn-token-design.md, «Кто не получает»): у clean-ask и
 * первого контакта пользователя нет по замыслу, у автоблога — вовсе.
 */
const LINKEON_FIELDS = ['linkeon_token', 'linkeon_mcp_url', 'fs_key'];

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const lastFields = () => {
  const calls = (axios.post as jest.Mock).mock.calls;
  return fieldsOf(calls[calls.length - 1][1]);
};

beforeEach(() => {
  jest.clearAllMocks();
  (axios.post as jest.Mock).mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
});

describe('анонимные и служебные ходы — без полей инструментов Linkeon', () => {
  const agents = { getAgentByName: jest.fn(async () => null), getAgentById: jest.fn(async () => null) };

  it('clean-ask', async () => {
    await new CleanAskService(agents as any).ask('как дела?');
    const f = lastFields();
    expect(f.sessionId).toMatch(/^anon_/);
    for (const k of LINKEON_FIELDS) expect(f[k]).toBeUndefined();
  });

  it('первый контакт', async () => {
    await new CleanAskService(agents as any).firstContact([{ from: 'user', text: 'привет' }], false);
    for (const k of LINKEON_FIELDS) expect(lastFields()[k]).toBeUndefined();
  });

  it('автоблог', async () => {
    await new BlogRelayClient().ask('системный промпт', 'сообщение', 'blog_spec_1');
    for (const k of LINKEON_FIELDS) expect(lastFields()[k]).toBeUndefined();
  });
});
```

- [ ] **Шаг 2: коммит, прогон — зелёный сразу**

```bash
git add src/chat/linkeon-fields-anonymous.spec.ts
git commit -q -m "test(chat): сторож — clean-ask, первый контакт и автоблог без инструментов Linkeon" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/linkeon-fields-anonymous.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: `PASS`, 3 теста. Если красный — разобраться: значит, поля протекли в анонимный путь, и это ошибка задач 6–8.

---

### Задача 10: ИИ-поддержка — `get_user_context` без `user_id`

**Files:**
- Modify: `src/support/support.service.ts` (`getUserContextData`)
- Test: `src/support/support-user-context.spec.ts`

- [ ] **Шаг 1: тест**

`src/support/support-user-context.spec.ts`:

```ts
import { SupportService } from './support.service';

/// get_user_context уходит модели ИИ-поддержки. Идентификатор аккаунта (у
/// телефонных пользователей — номер) ей не нужен и не передаётся (спека
/// 2026-10-26-mcp-turn-token-design.md); имя, почта, баланс и язык остаются.
describe('ИИ-поддержка: get_user_context без идентификатора аккаунта', () => {
  const ROW = {
    user_id: '79030169187',
    tokens: '1200',
    email: 'user@example.com',
    preferred_agent: '12',
    profile_data: { name: 'Дмитрий', family_name: 'В.', language: 'en' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    isadmin: false,
  };

  it('имя, почта, баланс и язык — есть; user_id и номера — нет', async () => {
    const svc = new SupportService({ query: jest.fn(async () => ({ rows: [ROW] })) } as any);
    const out = await (svc as any).executeTool('t-1', '79030169187', 'get_user_context', {});
    expect(out).not.toHaveProperty('user_id');
    expect(JSON.stringify(out)).not.toContain('79030169187');
    expect(out).toMatchObject({ tokens: 1200, email: 'user@example.com', name: 'Дмитрий', language: 'en' });
  });
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add src/support/support-user-context.spec.ts
git commit -q -m "test(support): get_user_context без идентификатора аккаунта" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/support/support-user-context.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|Expected|Received" | head -8'
```

Ожидается: FAIL — `expect(received).not.toHaveProperty(path)`, путь `user_id`.

- [ ] **Шаг 3: реализация**

`src/support/support.service.ts`:

```ts
// было
    return {
      user_id: row.user_id,
      tokens: Number(row.tokens || 0),
// стало
    // user_id в ответе нет: ответ уходит модели, а идентификатор аккаунта
    // (у телефонных пользователей — номер) ей не нужен (спека
    // 2026-10-26-mcp-turn-token-design.md).
    return {
      tokens: Number(row.tokens || 0),
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add src/support/support.service.ts
git commit -q -m "support: get_user_context без user_id" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/support --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: строк `FAIL` нет; `tsc-exit=0`.

---

### Задача 11: релей — папка хода по `fs_key` (`paths.mjs`)

**Files:**
- Modify: `relay-agent/paths.mjs` (после `sessionFsKey`)
- Test: `relay-agent/paths.test.mjs`

- [ ] **Шаг 1: тест**

`relay-agent/paths.test.mjs` — в импорте добавить `turnFsKey`:

```js
// было
import { sessionFsKey, uploadFileName, fallbackFileName, sessionOutputDir } from "./paths.mjs";
// стало
import { sessionFsKey, turnFsKey, uploadFileName, fallbackFileName, sessionOutputDir } from "./paths.mjs";
```

В конец файла:

```js
// fs_key от бэка (spirits_back src/chat/linkeon-relay-fields.ts): 32 hex от
// HMAC ключа сессии. Им называются папка хода и загрузки — без номера.
const FS_KEY = "0123456789abcdef0123456789abcdef";

test("turnFsKey: корректный fs_key от бэка — он и есть ключ папки", () => {
  assert.equal(turnFsKey(FS_KEY, SID, "x"), FS_KEY);
});

test("turnFsKey: нет fs_key — прежний ключ из sessionId", () => {
  assert.equal(turnFsKey(undefined, SID, "x"), SID);
  assert.equal(turnFsKey("", SID, "x"), SID);
});

test("turnFsKey: кривой fs_key не принимается — прежний ключ", () => {
  const bad = [FS_KEY.toUpperCase(), FS_KEY.slice(1), FS_KEY + "0", "../" + FS_KEY.slice(3), FS_KEY.slice(0, 31) + "/", ["a"], 123];
  for (const b of bad) {
    assert.equal(turnFsKey(b, SID, "x"), SID, "принят " + JSON.stringify(b));
  }
});

test("с fs_key в путях нет номера: загрузка, папка вывода, список файлов", () => {
  const key = turnFsKey(FS_KEY, SID, "x");
  const upload = uploadFileName("egrul.pdf", key);
  assert.equal(upload, FS_KEY + "_egrul.pdf");
  assert.equal(tryCreate(upload), null);
  const out = sessionOutputDir("/tmp/agent-output", key);
  assert.equal(out, path.join("/tmp/agent-output", FS_KEY));
  for (const p of [upload, out]) assert.ok(!p.includes("79093464922"), p);
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add relay-agent/paths.test.mjs
git commit -q -m "test(relay): папка хода по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --test paths.test.mjs 2>&1 | grep -E "turnFsKey|^# (tests|pass|fail)" | head -6'
```

Ожидается: падение файла — `does not provide an export named 'turnFsKey'`; `# fail 1`.

- [ ] **Шаг 3: реализация**

`relay-agent/paths.mjs` — сразу после функции `sessionFsKey`:

```js
// fs_key от бэка (spirits_back src/chat/linkeon-relay-fields.ts): первые 32
// hex от HMAC ключа сессии. Им называются папка хода и загрузки вместо ключа
// сессии, в котором у телефонных пользователей номер. Строго этот алфавит и
// длина: значение уходит в пути на диске. Сторож согласия с бэком —
// src/chat/relay-linkeon-guard.spec.ts.
const FS_KEY_RE = /^[0-9a-f]{32}$/;

// Ключ папки хода: fs_key, если бэк его прислал и он корректен, иначе —
// прежний, из sessionId (старый бэк, анонимные и служебные ходы).
export function turnFsKey(fsKeyFromBackend, sessionId, fallback) {
  if (typeof fsKeyFromBackend === "string" && FS_KEY_RE.test(fsKeyFromBackend)) return fsKeyFromBackend;
  return sessionFsKey(sessionId, fallback);
}
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add relay-agent/paths.mjs
git commit -q -m "relay: turnFsKey — папка хода по fs_key от бэка" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && node --test paths.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"'
```

Ожидается: `# fail 0`.

---

### Задача 12: релей — сервер `linkeon` из токена хода (`linkeon-mcp.mjs`)

**Files:**
- Create: `relay-agent/linkeon-mcp.mjs`
- Test: `relay-agent/linkeon-mcp.test.mjs`

- [ ] **Шаг 1: тест**

`relay-agent/linkeon-mcp.test.mjs`:

```js
// node --test relay-agent/linkeon-mcp.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { LINKEON_TOOLS, linkeonServer } from "./linkeon-mcp.mjs";

const URL_OK = "https://my.linkeon.io/webhook/mcp/linkeon";

test("без токена хода сервера linkeon нет", () => {
  assert.equal(linkeonServer({}), null);
  assert.equal(linkeonServer(undefined), null);
  assert.equal(linkeonServer({ linkeon_mcp_url: URL_OK }), null);
  assert.equal(linkeonServer({ linkeon_token: "", linkeon_mcp_url: URL_OK }), null);
});

test("адрес — только https", () => {
  assert.equal(linkeonServer({ linkeon_token: "t", linkeon_mcp_url: "http://my.linkeon.io/webhook/mcp/linkeon" }), null);
  assert.equal(linkeonServer({ linkeon_token: "t" }), null);
});

test("токен с переводом строки не принимается", () => {
  assert.equal(linkeonServer({ linkeon_token: "t\r\nX: 1", linkeon_mcp_url: URL_OK }), null);
});

test("повторённое поле multipart (массив) не принимается", () => {
  assert.equal(linkeonServer({ linkeon_token: ["a", "b"], linkeon_mcp_url: URL_OK }), null);
});

test("с токеном — http-сервер с Bearer токена хода", () => {
  assert.deepEqual(linkeonServer({ linkeon_token: "tkn", linkeon_mcp_url: URL_OK }), {
    type: "http",
    url: URL_OK,
    headers: { Authorization: "Bearer tkn" },
  });
});

test("LINKEON_TOOLS — 11 имён mcp__linkeon__* через запятую", () => {
  const names = LINKEON_TOOLS.split(",");
  assert.equal(names.length, 11);
  for (const n of names) assert.match(n, /^mcp__linkeon__[a-z_]+$/);
});
```

- [ ] **Шаг 2: коммит теста, прогон — падает**

```bash
git add relay-agent/linkeon-mcp.test.mjs
git commit -q -m "test(relay): сервер linkeon только из токена хода" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --test linkeon-mcp.test.mjs 2>&1 | grep -E "Cannot find|^# (tests|pass|fail)" | head -4'
```

Ожидается: `Cannot find module …/linkeon-mcp.mjs`; `# fail 1`.

- [ ] **Шаг 3: реализация**

`relay-agent/linkeon-mcp.mjs`:

```js
// Инструменты Linkeon (mcp__linkeon__*: картинки, баннеры, видео, озвучка,
// рутины, календарь, бодиграф) — сервер хода из токена бэка.
//
// Пользователя инструмент узнаёт по подписи токена (spirits_back,
// src/mcp/linkeon-tool.token.ts), а не по аргументу, который пишет модель:
// номер телефона модели больше не сообщается. Нет токена — нет и сервера, и
// имён mcp__linkeon__* в --allowedTools: модель инструментов не увидит.
// Спека: spirits_back docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
// Тесты — linkeon-mcp.test.mjs.

// Имя складывается как mcp__<ключ сервера>__<имя инструмента>; ключ — linkeon.
// Список сверяется с CHAT_TOOLS бэка сторожем src/chat/relay-linkeon-guard.spec.ts.
export const LINKEON_TOOLS = [
  "mcp__linkeon__generate_image",
  "mcp__linkeon__edit_image",
  "mcp__linkeon__compose_image",
  "mcp__linkeon__upscale_image",
  "mcp__linkeon__generate_video",
  "mcp__linkeon__generate_banner",
  "mcp__linkeon__manage_routine",
  "mcp__linkeon__propose_calendar_event",
  "mcp__linkeon__generate_speech",
  "mcp__linkeon__read_calendar",
  "mcp__linkeon__calculate_human_design",
].join(",");

// Сервер linkeon для конфига хода или null. Поля приходят из multipart как
// есть: повторённое поле — массив, поэтому проверяется тип; перевод строки в
// токене раздвоил бы заголовок.
export function linkeonServer(body) {
  const token = body && body.linkeon_token;
  const url = body && body.linkeon_mcp_url;
  if (typeof token !== "string" || token === "" || /[\r\n]/.test(token)) return null;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  return { type: "http", url, headers: { Authorization: "Bearer " + token } };
}
```

- [ ] **Шаг 4: коммит, прогон — зелёный**

```bash
git add relay-agent/linkeon-mcp.mjs
git commit -q -m "relay: linkeon-mcp — сервер linkeon и его имена только из токена хода" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && node --test linkeon-mcp.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"'
```

Ожидается: `# tests 6`, `# fail 0`.

---

### Задача 13: релей — `server.mjs` и сторож его текста

**Files:**
- Modify: `relay-agent/server.mjs` (импорты; `SYSTEM_PROMPT`; после `BASE_MCP_PATH`; `TALERID_PROMPT`; обработчик `POST /chat`: `fsKey`, строка с телефоном, `allowedTools`, блок постояльцев; `finally`)
- Test: `src/chat/relay-linkeon-guard.spec.ts`

- [ ] **Шаг 1: сторож**

`src/chat/relay-linkeon-guard.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { CHAT_TOOLS } from './chat-tools';
import { relayFsKey } from './linkeon-relay-fields';

/**
 * Релей и инструменты Linkeon по токену хода — спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md. Копия в
 * relay-agent/ — то, что выкатывается на релей; сторож держит обещания:
 *   • номер телефона не уходит модели строкой в реплике хода;
 *   • в правилах mcp__linkeon__* нет аргумента userId, есть оговорка «не передавай»;
 *   • сервер linkeon и его имена в --allowedTools — только из токена хода;
 *   • папка хода — по fs_key, и формат fs_key у бэка и релея один.
 */
const dir = path.join(__dirname, '../../relay-agent');
const server = fs.readFileSync(path.join(dir, 'server.mjs'), 'utf8');
const linkeonMcp = fs.readFileSync(path.join(dir, 'linkeon-mcp.mjs'), 'utf8');
const paths = fs.readFileSync(path.join(dir, 'paths.mjs'), 'utf8');
const SYS_START = server.indexOf('const SYSTEM_PROMPT = `');
const systemPrompt = server.slice(SYS_START, server.indexOf('`;', SYS_START));
const DISCLAIMER = 'НЕ передавай в них userId/телефон';

describe('релей: инструменты Linkeon по токену хода', () => {
  it('номера в реплике хода нет', () => {
    expect(server).not.toContain('Current user phone');
    expect(server).not.toContain('_phonePart');
  });

  it('в правилах SYSTEM_PROMPT нет userId, кроме оговорки «не передавай»', () => {
    expect(SYS_START).toBeGreaterThan(-1);
    expect(systemPrompt).toContain(DISCLAIMER);
    expect(systemPrompt.split(DISCLAIMER).join('')).not.toMatch(/userId/);
  });

  it('оговорка стоит в строке про mcp__linkeon__*', () => {
    const line = systemPrompt.split('\n').find((l) => l.includes(DISCLAIMER)) ?? '';
    expect(line).toContain('mcp__linkeon__*');
  });

  it('LINKEON_TOOLS — ровно инструменты CHAT_TOOLS бэка', () => {
    const names = [...linkeonMcp.matchAll(/"(mcp__linkeon__\w+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(CHAT_TOOLS.map((t) => `mcp__linkeon__${t.name}`).sort());
  });

  it('базовый список инструментов без mcp__linkeon__*; имена — только вместе с сервером из токена', () => {
    const base = /const BASE_TOOLS = "([^"]+)";/.exec(server)?.[1];
    expect(base).toBeDefined();
    expect(base).not.toContain('mcp__linkeon__');
    expect(server).not.toContain('WebFetch(*),mcp__linkeon__');
    expect(server).toContain('const linkeonSrv = linkeonServer(req.body);');
    expect(server).toMatch(/if \(wantLinkeon\) allowedTools \+= "," \+ LINKEON_TOOLS;/);
  });

  it('папка хода — по fs_key от бэка', () => {
    expect(server).toContain('turnFsKey(req.body.fs_key, sessionId, randomUUID())');
    expect(server).not.toMatch(/const fsKey = sessionFsKey\(/);
  });

  it('формат fs_key у бэка и проверка релея совпадают: 32 hex', () => {
    expect(/const FS_KEY_RE = \/(.+)\/;/.exec(paths)?.[1]).toBe('^[0-9a-f]{32}$');
    expect(relayFsKey('79030169187_12_ru')).toMatch(/^[0-9a-f]{32}$/);
  });
});
```

- [ ] **Шаг 2: коммит сторожа, прогон — падает**

```bash
git add src/chat/relay-linkeon-guard.spec.ts
git commit -q -m "test(chat): сторож релея — без номера в реплике, linkeon только из токена хода" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/chat/relay-linkeon-guard.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✓|✕" | head -12'
```

Ожидается: FAIL — красные «номера в реплике хода нет», «в правилах SYSTEM_PROMPT нет userId…», «оговорка стоит…», «базовый список…», «папка хода…»; зелёные «LINKEON_TOOLS…» и «формат fs_key…».

- [ ] **Шаг 3: импорты**

`relay-agent/server.mjs`:

```js
// было
import { sessionFsKey, uploadFileName, fallbackFileName, sessionOutputDir } from "./paths.mjs";
// стало
import { turnFsKey, uploadFileName, fallbackFileName, sessionOutputDir } from "./paths.mjs";
```

```js
// было
import { createRelayAuth } from "./relay-auth.mjs";
// стало
import { createRelayAuth } from "./relay-auth.mjs";
import { LINKEON_TOOLS, linkeonServer } from "./linkeon-mcp.mjs";
```

- [ ] **Шаг 4: `SYSTEM_PROMPT` — оговорка и семь правок `userId`**

Оговорка — новым абзацем сразу после строки `IMPORTANT: You are in WEB MODE…`:

```
// было
IMPORTANT: You are in WEB MODE. NEVER use telegram or ToolSearch. The ONLY MCP tools you may use are the linkeon ones listed below (mcp__linkeon__*). All other MCP/plugin tools are forbidden. Otherwise use: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.
// стало
IMPORTANT: You are in WEB MODE. NEVER use telegram or ToolSearch. The ONLY MCP tools you may use are the linkeon ones listed below (mcp__linkeon__*). All other MCP/plugin tools are forbidden. Otherwise use: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.

ИНСТРУМЕНТЫ mcp__linkeon__* сами знают, чей это разговор: НЕ передавай в них userId/телефон — только их собственные аргументы.
```

Семь замен (каждая подстрока в файле единственна):

| было | стало |
|---|---|
| `with arguments { userId: "<the user phone provided in the system context>", prompt: "english prompt", quality: "hd" or "std" }` | `with arguments { prompt: "english prompt", quality: "hd" or "std" }` |
| `mcp__linkeon__generate_banner with { userId, prompt:` | `mcp__linkeon__generate_banner with { prompt:` |
| `(Gemini Omni) takes. Pass userId as with every mcp__linkeon__* tool; mode "text2video" from a description` | `(Gemini Omni) takes. Mode "text2video" from a description` |
| `mcp__linkeon__generate_speech with { userId, text:` | `mcp__linkeon__generate_speech with { text:` |
| `mcp__linkeon__manage_routine с { userId, action: "enable"` | `mcp__linkeon__manage_routine с { action: "enable"` |
| `mcp__linkeon__propose_calendar_event с { userId, title, kind, note` | `mcp__linkeon__propose_calendar_event с { title, kind, note` |
| `mcp__linkeon__read_calendar с { userId, from, to }` | `mcp__linkeon__read_calendar с { from, to }` |

Проверка: `grep -n "userId" relay-agent/server.mjs` — остаются только оговорка (новая строка в `SYSTEM_PROMPT`) и строки `TALERID_PROMPT`/`PRODUCTS_PROMPT` вида «НЕ передавай в … userId/phone|телефон».

- [ ] **Шаг 5: `TALERID_PROMPT` — linkeon теперь тоже от лица пользователя**

```
// было
В отличие от linkeon-инструментов, talerid-инструменты работают от лица уже авторизованного пользователя —
// стало
Как и linkeon-инструменты, talerid-инструменты работают от лица уже авторизованного пользователя —
```

- [ ] **Шаг 6: базовый список инструментов**

```js
// было
const BASE_MCP_PATH = "/home/dv/file-agent/empty-mcp.json";
// стало
const BASE_MCP_PATH = "/home/dv/file-agent/empty-mcp.json";
// Встроенные инструменты CLI — у каждого хода. MCP-имена добавляются только
// вместе со своим сервером (блок постояльцев в POST /chat).
const BASE_TOOLS = "Bash(*),Read(*),Write(*),Edit(*),Glob(*),Grep(*),WebSearch(*),WebFetch(*)";
```

- [ ] **Шаг 7: папка хода**

```js
// было
  // sessionId остаётся логическим ключом сессии (sessionMap, activeChildren,
  // --resume), а на диск и в /files-ссылки уходит его санитизированная копия.
  // Для обычного "<телефон>_<n>" это та же строка, так что имена папок и
  // ссылок у живых сессий не меняются. См. relay-agent/paths.mjs.
  const fsKey = sessionFsKey(sessionId, randomUUID());
// стало
  // sessionId остаётся логическим ключом сессии (sessionMap, activeChildren,
  // --resume). На диск и в /files-ссылки идёт fs_key от бэка — HMAC ключа
  // сессии без номера телефона (spirits_back src/chat/linkeon-relay-fields.ts);
  // без него — санитизированная копия sessionId, как раньше. Старые папки не
  // переносятся: ссылки из истории чатов продолжают открываться. См. paths.mjs.
  const fsKey = turnFsKey(req.body.fs_key, sessionId, randomUUID());
```

- [ ] **Шаг 8: строка с телефоном**

```js
// было
  // Backend sends sessionId like "<phone>_<n>" (e.g. "79030169187_12").
  // Surface the phone to the agent so linkeon MCP tools can pass it as userId.
  const _sidStr = String(sessionId);
  const _phonePart = _sidStr.split("_")[0];
  if (/^\d{10,15}$/.test(_phonePart)) {
    prompt += "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): " + _phonePart + "\n\n";
  }

  prompt += message;
// стало
  // Номер телефона модели не сообщается: инструменты mcp__linkeon__* узнают
  // пользователя по токену хода (linkeon-mcp.mjs). Строку прежних ходов
  // срезает хвост сессии (session-tail.mjs).
  prompt += message;
```

- [ ] **Шаг 9: начало блока постояльцев**

```js
// было
  // Per-request injection дополнительных MCP-серверов: по умолчанию только
  // linkeon; если бэкенд передал пер-юзерный токен + MCP url, пишем пер-сессионный
  // конфиг и расширяем allowedTools + системный промпт. Постояльцев двое —
  // talerid (заметки/сообщения/почта) и products (сайты и телеграм-боты
  // пользователя). Временный файл убирается по завершении запроса (см. finally
  // ниже). Любая осечка — безопасный откат к базовому конфигу.
  let mcpConfigPath = BASE_MCP_PATH;
  let allowedTools = "Bash(*),Read(*),Write(*),Edit(*),Glob(*),Grep(*),WebSearch(*),WebFetch(*),mcp__linkeon__generate_image,mcp__linkeon__edit_image,mcp__linkeon__compose_image,mcp__linkeon__upscale_image,mcp__linkeon__generate_video,mcp__linkeon__generate_banner,mcp__linkeon__manage_routine,mcp__linkeon__propose_calendar_event,mcp__linkeon__generate_speech,mcp__linkeon__read_calendar,mcp__linkeon__calculate_human_design";
// стало
  // Per-request injection MCP-серверов. Базовый конфиг (empty-mcp.json) пуст;
  // если бэкенд передал пер-юзерный токен + MCP url, пишем пер-сессионный
  // конфиг и расширяем allowedTools (и системный промпт). Постояльцев трое —
  // linkeon (картинки, видео, озвучка, рутины, календарь, бодиграф; токен хода
  // с пользователем в подписи), talerid (заметки/сообщения/почта) и products
  // (сайты и телеграм-боты пользователя). Временный файл убирается по
  // завершении запроса (см. finally ниже). Любая осечка — безопасный откат к
  // базовому конфигу.
  let mcpConfigPath = BASE_MCP_PATH;
  let allowedTools = BASE_TOOLS;
```

- [ ] **Шаг 10: сервер `linkeon` в конфиг хода**

```js
// было
  const _taleridToken = req.body.talerid_token;
  const _taleridMcpUrl = req.body.talerid_mcp_url;
  const _productsToken = req.body.products_token;
  const _productsMcpUrl = req.body.products_mcp_url;
  const wantTalerid = !!(_taleridToken && _taleridMcpUrl && /^https:\/\//.test(_taleridMcpUrl));
  const wantProducts = !!(_productsToken && _productsMcpUrl && /^https:\/\//.test(_productsMcpUrl));

  if (wantTalerid || wantProducts) {
    try {
      const base = JSON.parse(fs.readFileSync(BASE_MCP_PATH, "utf8"));
      if (wantTalerid) {
// стало
  const linkeonSrv = linkeonServer(req.body);
  const wantLinkeon = !!linkeonSrv;
  const _taleridToken = req.body.talerid_token;
  const _taleridMcpUrl = req.body.talerid_mcp_url;
  const _productsToken = req.body.products_token;
  const _productsMcpUrl = req.body.products_mcp_url;
  const wantTalerid = !!(_taleridToken && _taleridMcpUrl && /^https:\/\//.test(_taleridMcpUrl));
  const wantProducts = !!(_productsToken && _productsMcpUrl && /^https:\/\//.test(_productsMcpUrl));

  if (wantLinkeon || wantTalerid || wantProducts) {
    try {
      const base = JSON.parse(fs.readFileSync(BASE_MCP_PATH, "utf8"));
      base.mcpServers = base.mcpServers || {};
      // Сервер linkeon — только из токена хода. Прежний, с общим секретом,
      // если он ещё остался в базовом конфиге, в конфиг хода не идёт.
      delete base.mcpServers.linkeon;
      if (wantLinkeon) base.mcpServers.linkeon = linkeonSrv;
      if (wantTalerid) {
```

```js
// было
      mcpConfigPath = sessionMcpPath;
      if (wantTalerid) { allowedTools += "," + TALERID_TOOLS; systemPrompt += TALERID_PROMPT; }
// стало
      mcpConfigPath = sessionMcpPath;
      if (wantLinkeon) allowedTools += "," + LINKEON_TOOLS;
      if (wantTalerid) { allowedTools += "," + TALERID_TOOLS; systemPrompt += TALERID_PROMPT; }
```

```js
// было
      allowedTools = allowedTools.split("," + TALERID_TOOLS)[0].split("," + PRODUCTS_TOOLS)[0];
// стало
      allowedTools = BASE_TOOLS;
```

- [ ] **Шаг 11: комментарий уборки конфига хода**

```js
// было
    // Remove the per-session MCP config (it holds the user's Bearer tokens —
    // talerid и/или products). Файл ОДИН на всех постояльцев: уборка по старому
// стало
    // Remove the per-session MCP config (it holds the user's Bearer tokens —
    // linkeon, talerid, products). Файл ОДИН на всех постояльцев: уборка по старому
```

- [ ] **Шаг 12: коммит, прогоны — сторож, релей целиком, соседние сторожа**

```bash
git add relay-agent/server.mjs
git commit -q -m "relay: номер модели не сообщается; linkeon — из токена хода; папки по fs_key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --check server.mjs && echo syntax-ok; node --test 2>&1 | grep -E "^# (tests|pass|fail)"'
bash .superpowers/node-run.sh 'npx jest src/chat/relay-linkeon-guard.spec.ts src/chat/relay-help-guard.spec.ts src/chat/relay-order-guard.spec.ts src/mcp/relay-products-tools.spec.ts src/products/products-cli-tool.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: `syntax-ok`; `# fail 0` (в том числе `session-tail.test.mjs` — без правок); все пять файлов jest — `PASS` (`relay-linkeon-guard.spec.ts` — 7 тестов).

---

### Задача 14: базовый конфиг релея без `linkeon`; README; CLAUDE.md

**Files:**
- Modify: `relay-agent/empty-mcp.json`, `src/mcp/relay-mcp-template.spec.ts`
- Modify: `relay-agent/README.md`, `CLAUDE.md`

- [ ] **Шаг 1: сторож шаблона — `src/mcp/relay-mcp-template.spec.ts` заменить целиком**

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Шаблон базового MCP-конфига релея лежит в публичном репозитории.
 *
 * До 26.10.2026 боевой файл на релее (/home/dv/file-agent/empty-mcp.json)
 * держал сервер linkeon с общим MCP_SECRET прода; с 06.08 по 07.10.2026 он
 * лежал здесь целиком. Теперь сервер linkeon подключается в конфиг хода из
 * токена хода (relay-agent/linkeon-mcp.mjs), и базовый конфиг пуст — ни
 * серверов, ни секретов.
 */
describe('relay-agent/empty-mcp.json', () => {
  const raw = readFileSync(join(__dirname, '../../relay-agent/empty-mcp.json'), 'utf8');

  it('серверов нет: linkeon — только из токена хода', () => {
    expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
  });

  it('нигде в файле нет заголовков и строк, похожих на секрет', () => {
    expect(raw).not.toMatch(/[A-Za-z0-9]{32,}/);
    expect(raw).not.toMatch(/Bearer|Authorization/);
  });
});
```

- [ ] **Шаг 2: коммит, прогон — падает**

```bash
git add src/mcp/relay-mcp-template.spec.ts
git commit -q -m "test(mcp): базовый конфиг релея — без серверов" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp/relay-mcp-template.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕"'
```

Ожидается: FAIL в обоих тестах (в шаблоне сервер `linkeon` и заголовок `Authorization`).

- [ ] **Шаг 3: шаблон**

`relay-agent/empty-mcp.json` — заменить целиком:

```json
{
  "mcpServers": {}
}
```

- [ ] **Шаг 4: README релея**

`relay-agent/README.md`:

```markdown
<!-- было -->
Всё, что ассистент кладёт в `/tmp/agent-output/<sessionId>/`, уезжает в
событии `done` списком `outputFiles`, а бэк превращает его в ссылки вида
`https://r.linkeon.io/files/<sessionId>/<имя>`.
<!-- стало -->
Всё, что ассистент кладёт в `/tmp/agent-output/<ключ папки>/`, уезжает в
событии `done` списком `outputFiles`, а бэк превращает его в ссылки вида
`https://r.linkeon.io/files/<ключ папки>/<имя>`. Ключ папки — `fs_key` от
бэка (32 hex от HMAC ключа сессии, без номера телефона; `paths.mjs`,
`turnFsKey`), у ходов без него — санитизированный `sessionId`, как до
26.10.2026. Загрузки называются `<ключ папки>_<имя>`.
```

```markdown
<!-- было -->
- боевой `empty-mcp.json` — в нём `MCP_SECRET` прода, здесь только шаблон
  с плейсхолдером. С 06.08 по 07.10.2026 файл лежал тут целиком, и `/mcp`
  был открыт любому читателю GitHub; секрет заменён, на релее файл выведен
  из git. Вернуть секрет сюда не даст `src/mcp/relay-mcp-template.spec.ts`;
<!-- стало -->
- секретов MCP. Базовый `empty-mcp.json` пуст (`{"mcpServers": {}}`):
  сервер `linkeon` подключается в конфиг хода из `linkeon_token` бэка
  (`linkeon-mcp.mjs`), как `products` и `talerid`. До 26.10.2026 боевой
  файл держал общий `MCP_SECRET` прода; с 06.08 по 07.10.2026 он лежал
  тут целиком. На релее файл по-прежнему вне git; вернуть сюда сервер или
  секрет не даст `src/mcp/relay-mcp-template.spec.ts`;
```

- [ ] **Шаг 5: CLAUDE.md бэка**

В разделе `## Credentials (на сервере ~/spirits_back/.env)` — после строки `JWT_SECRET`:

```markdown
- `RELAY_FS_SALT` — соль ключа папки хода на релее (`fs_key`, `src/chat/linkeon-relay-fields.ts`); у прода и стенда свои; смена переименует папки новых ходов (старые ссылки живут)
```

В разделе `### Chat` — после строки `DELETE /webhook/chat/history…`:

````markdown
- `POST /webhook/mcp/linkeon` — инструменты ассистентов релея (`mcp__linkeon__*`); Bearer — токен хода (`src/mcp/linkeon-tool.token.ts`), пользователь из подписи, аргумента `userId` нет. Ручная проверка — токен выпускается на самом сервере и не печатается:
  ```bash
  ssh dvolkov@212.113.106.202 'cd ~/spirits_back && umask 077 && node -e "require(\"dotenv\").config(); const t = require(\"./dist/mcp/linkeon-tool.token\").signLinkeonToolToken(\"70000000000\"); process.stdout.write(\"Authorization: Bearer \" + t + \"\\n\")" > /tmp/lt.hdr && curl -s -m 20 -X POST http://127.0.0.1:3001/webhook/mcp/linkeon -H @/tmp/lt.hdr -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" | grep -o "\"name\":\"[a-z_]*\"" | head -3; rm -f /tmp/lt.hdr'
  ```
````

- [ ] **Шаг 6: коммит, прогон — зелёный**

```bash
git add relay-agent/empty-mcp.json relay-agent/README.md CLAUDE.md
git commit -q -m "relay: базовый MCP-конфиг пуст; README и CLAUDE.md — fs_key, RELAY_FS_SALT, /webhook/mcp/linkeon" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp/relay-mcp-template.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: `PASS`, 2 теста.

---

### Задача 15: полный прогон, ревью, слияние — слияние только с OK владельца

- [ ] **Шаг 1: main не ушёл?**

```bash
git fetch -q origin && git merge-base --is-ancestor origin/main HEAD && echo "main не ушёл" || echo "main ушёл — влить"
```

Если «влить»: `git merge --no-ff -q origin/main -m "Merge origin/main в feat/mcp-turn-token" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"`; конфликты — разобрать руками и описать в отчёте.

- [ ] **Шаг 2: полный прогон**

```bash
bash .superpowers/node-run.sh 'npx jest src/mcp src/chat src/support src/monitoring src/ask src/blog src/products src/platform-kb src/voice-call src/trip src/routine-push --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
bash .superpowers/node-run.sh 'cd relay-agent && npm ci --silent >/dev/null 2>&1; node --check server.mjs && echo syntax-ok; node --test 2>&1 | grep -E "^# (tests|pass|fail)"'
```

Ожидается: новых строк `FAIL` против задачи 0 нет; `Tests:` — база плюс новые; `tsc-exit=0`; релей — `syntax-ok`, `# fail 0`.

- [ ] **Шаг 3: ревью** — `superpowers:requesting-code-review`, диапазон `origin/main...feat/mcp-turn-token`, со ссылкой на спеку и этот план. Найденное — отдельными коммитами по TDD, затем шаг 2 заново.

- [ ] **Шаг 4: слияние в main — только с OK владельца**

```bash
cd ~/Downloads/spirits_back
git fetch -q origin
git worktree add -q --detach .worktrees/merge-mcp-turn-token origin/main
git -C .worktrees/merge-mcp-turn-token merge --no-ff -q feat/mcp-turn-token -m "Merge feat/mcp-turn-token: инструменты ассистентов узнают пользователя по токену хода" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
SHA=$(git -C .worktrees/merge-mcp-turn-token rev-parse HEAD); echo "${SHA}"
git -C .worktrees/merge-mcp-turn-token diff --stat feat/mcp-turn-token "${SHA}" | tail -1
git push origin "${SHA}:refs/heads/main"
git fetch -q origin && git merge-base --is-ancestor "${SHA}" origin/main && echo в-main
git worktree remove .worktrees/merge-mcp-turn-token
```

Ожидается: `diff --stat` пуст (дерево слияния = дерево ветки); `в-main`. SHA записать в отчёт — он нужен задачам 17–18. Если GitHub не отвечает — пуш через ноду (память «Пуш через ноду»), не из detached HEAD без явного refspec.

---

### Задача 16: `RELAY_FS_SALT` в `.env` прода и стенда — с OK владельца

Значение генерируется на месте и не печатается. Перед дописыванием — перевод строки в конце `.env` (иначе новая строка прилипнет к последней). Nest читает `.env` при старте (ConfigModule), поэтому соль вступит в силу рестартом из `deploy.sh` (задача 17) — до него она ни на что не влияет.

- [ ] **Шаг 1: прод и стенд**

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && [ -z "$(tail -c1 .env)" ] || echo >> .env; (grep -q "^RELAY_FS_SALT=" .env || printf "RELAY_FS_SALT=%s\n" "$(openssl rand -hex 32)" >> .env) && grep -c "^RELAY_FS_SALT=" .env && stat -c %a .env'
ssh dv@85.192.61.231 'cd ~/spirits_back && [ -z "$(tail -c1 .env)" ] || echo >> .env; (grep -q "^RELAY_FS_SALT=" .env || printf "RELAY_FS_SALT=%s\n" "$(openssl rand -hex 32)" >> .env) && grep -c "^RELAY_FS_SALT=" .env && stat -c %a .env'
```

Ожидается: `1` и права (`600` или прежние) в обоих.

- [ ] **Шаг 2: формат — без печати значения**

```bash
ssh dvolkov@212.113.106.202 "awk -F= '/^RELAY_FS_SALT=/ { print length(\$2) }' ~/spirits_back/.env"
ssh dv@85.192.61.231 "awk -F= '/^RELAY_FS_SALT=/ { print length(\$2) }' ~/spirits_back/.env"
```

Ожидается: `64` в обоих. Значения разные (сгенерированы независимо) — у прода и стенда разные папки при совпавших ключах сессий тестовых аккаунтов.

---

### Задача 17: выкат бэка — с OK владельца

После выката точка принимает и токен, и общий секрет; поля релею уходят, релей их пока игнорирует.

- [ ] **Шаг 1: что уедет** — `git -C ~/Downloads/spirits_back/.worktrees/mcp-turn-token log --oneline <прод-sha>..origin/main` (прод-sha — `ssh dvolkov@212.113.106.202 'git -C ~/spirits_back rev-parse --short HEAD'`). Показать владельцу и получить OK.

- [ ] **Шаг 2: чужих выкатов нет**

```bash
ssh dv@85.192.61.231 'pgrep -fa "^bash scripts/deploy.sh" || echo "чужих выкатов нет"'
```

- [ ] **Шаг 3: свежие клоны на ноде**

```bash
ssh dv@85.192.61.231 'set -e; D=~/deploy-clones/mcp-turn-token-$(date +%Y%m%d-%H%M); mkdir -p "$D" ~/deploy-logs
  git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git "$D/spirits_back"
  git clone -q --branch main git@github.com:dvvolkovv/spirits.git "$D/spirits_front"
  install -m 600 ~/dev/spirits_back/scripts/test-server.env.local "$D/spirits_back/scripts/"
  ln -s ~/dev/spirits_back/tests/node_modules "$D/spirits_back/tests/node_modules"
  git -C "$D/spirits_back" log --oneline -1; echo "$D"'
```

Ожидается: верхний коммит клона — SHA слияния из задачи 15; путь клона — записать. Если сверху уже чужие коммиты — показать их владельцу до запуска: они уедут вместе с нашими.

- [ ] **Шаг 4: запуск отвязанно, лог без `tail`**

```bash
ssh dv@85.192.61.231 'D=$(ls -dt ~/deploy-clones/mcp-turn-token-* | head -1); cd "$D/spirits_back" && . ~/.nvm/nvm.sh && SKIP_BOTS=1 setsid -f bash -c "echo \$\$ > ~/deploy-logs/mcp-turn-token.pid; exec bash scripts/deploy.sh" > ~/deploy-logs/mcp-turn-token.log 2>&1 < /dev/null; sleep 3; cat ~/deploy-logs/mcp-turn-token.pid'
```

Ждать петлёй (раз в 2–3 минуты, через мастер-соединение):

```bash
ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231 'kill -0 $(cat ~/deploy-logs/mcp-turn-token.pid) 2>/dev/null && echo идёт || echo закончился; tail -4 ~/deploy-logs/mcp-turn-token.log'
```

Ожидается в конце: обе фазы зелёные. Красная фаза test — прод не тронут; разобраться по логу до повтора.

- [ ] **Шаг 5: доехало — прод и стенд**

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && git log --oneline -1 && git reflog -3 && grep -c "linkeon_token" dist/chat/linkeon-relay-fields.js && grep -c "mcp/linkeon" dist/mcp/mcp.controller.js && curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3001/webhook/mcp/linkeon'
ssh dv@85.192.61.231 'cd ~/spirits_back && git log --oneline -1 && grep -c "mcp/linkeon" dist/mcp/mcp.controller.js && curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3001/webhook/mcp/linkeon'
ssh dv@5.101.115.184 'curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -X POST https://my.linkeon.io/webhook/mcp/linkeon'
```

Ожидается: SHA слияния; в `reflog` нет `reset: moving to <старый sha>` после выката; счётчики ≥ 1; `401` на проде и стенде; с релея — `401 application/json…` (не `200 text/html`: это был бы SPA-фолбэк).

- [ ] **Шаг 6: оба пути точки на проде**

Токен хода (выпуск на сервере, без печати):

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && umask 077 && node -e "require(\"dotenv\").config(); const t = require(\"./dist/mcp/linkeon-tool.token\").signLinkeonToolToken(\"70000000000\"); process.stdout.write(\"Authorization: Bearer \" + t + \"\\n\")" > /tmp/lt.hdr && curl -s -m 20 -X POST http://127.0.0.1:3001/webhook/mcp/linkeon -H @/tmp/lt.hdr -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" > /tmp/lt.out; grep -o "\"name\":\"[a-z_]*\"" /tmp/lt.out | wc -l; grep -c "\"userId\"" /tmp/lt.out; rm -f /tmp/lt.hdr /tmp/lt.out'
```

Ожидается: `11` (инструментов) и `0` (`userId` в схемах нет).

Переходный путь (секрет из `.env`, заголовок — файлом, без печати):

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && umask 077 && printf "Authorization: Bearer %s\n" "$(sed -n "s/^MCP_SECRET=//p" .env | tr -d "\"'"'"'")" > /tmp/ms.hdr && curl -s -m 20 -X POST http://127.0.0.1:3001/mcp -H @/tmp/ms.hdr -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" | grep -c "\"userId\""; rm -f /tmp/ms.hdr'
```

Ожидается: `1` (одна строка SSE со схемами, где есть `userId`) — прежний релей продолжает работать.

- [ ] **Шаг 7: живые ходы прежнего релея идут** — через 10–30 минут обычного трафика:

```bash
ssh dvolkov@212.113.106.202 'L=$(ls -t ~/.pm2/logs/linkeon-api-out*.log | head -1); grep -a "вызов по общему секрету" "$L" | tail -2 | cut -c1-120; grep -a "tools/call" "$L" | tail -2 | cut -c1-100'
```

Ожидается: строки «вызов по общему секрету» есть (релей ещё старый) и рядом — `tools/call … userId=…`: переходный путь работает.

**Откат шага:** `git revert -m 1 <SHA слияния>` в отдельном воркдереве на свежем `origin/main` → слияние в main (OK) → `deploy.sh` (OK). Релей при этом не трогается — это верно, ПОКА релей ещё не выкачен (до задачи 18). После выката релея (задача 18) бэк в одиночку уже не откатывается — см. предупреждение в конце задачи 18.

---

### Задача 18: выкат релея — с OK владельца

Порядок: сверка живых файлов → заготовка с тестами на релее → в одной SSH-команде проверка живых ходов, замена файлов, пустой `empty-mcp.json`, коммит в git релея и рестарт без `--update-env`. Не совмещать с переключением `relay-auth-mode` (план секрета релея).

- [ ] **Шаг 1: живые файлы совпадают с main до слияния**

```bash
SHA=<SHA слияния из задачи 15>
WT=~/Downloads/spirits_back/.worktrees/mcp-turn-token
for f in server.mjs paths.mjs; do
  git -C "$WT" show "${SHA}^1:relay-agent/$f" | ssh dv@5.101.115.184 "cmp -s - ~/file-agent/$f && echo '$f: совпадает с main до слияния' || echo '$f: РАСХОДИТСЯ'"
done
```

Ожидается: оба «совпадает». «РАСХОДИТСЯ» — стоп: на релее правка, которой нет в main (или не выкачен предыдущий план релея); показать `diff` владельцу и переносить правку руками, не перезаписывая.

⚠️ Известное расхождение `server.mjs` (не повод для стопа): на живом релее нет трёх строк `PRODUCTS_PROMPT` из `feat/product-lifecycle` — они ещё не выкачены на релей отдельно и уедут вместе с этим выкатом. Если `cmp` на `server.mjs` покажет РАСХОДИТСЯ и `diff` — ровно эти три строки, это ожидаемо, можно продолжать.

- [ ] **Шаг 2: живых ходов на бэках нет (для сведения)**

```bash
ssh dvolkov@212.113.106.202 'curl -s http://127.0.0.1:3001/webhook/chat/active-streams'
ssh dv@85.192.61.231 'curl -s http://127.0.0.1:3001/webhook/chat/active-streams'
```

Ожидается: `{"active":0}` в обоих (иначе подождать). Окончательная проверка — по процессам релея в шаге 4.

- [ ] **Шаг 3: заготовка на релее и тесты в ней — до замены**

```bash
SHA=<SHA слияния из задачи 15>
WT=~/Downloads/spirits_back/.worktrees/mcp-turn-token
git -C "$WT" archive "${SHA}" relay-agent | ssh dv@5.101.115.184 "ST=~/file-agent-stage-${SHA:0:7}; rm -rf \$ST && mkdir \$ST && tar -x -C \$ST --strip-components=1 && cd \$ST && ln -s ~/file-agent/node_modules node_modules && for f in *.mjs; do node --check \"\$f\" || exit 1; done && echo syntax-ok && node --test 2>&1 | grep -E '^# (tests|pass|fail)'"
```

Ожидается: `syntax-ok`; `# fail 0`. Красное — не катить. `for f in *.mjs` — НЕ фиксированный список: задача 18 (ревью 26.10.2026) уже один раз отстала от кода с таким списком (см. шаг 4).

- [ ] **Шаг 4: замена и рестарт одной командой**

⚠️ **Не фиксированный список файлов.** 26.10.2026 повторное ревью нашло: список `server.mjs paths.mjs paths.test.mjs linkeon-mcp.mjs linkeon-mcp.test.mjs` в этом шаге не включал `session-mcp-config.mjs`/`session-mcp-config.test.mjs` и `turn-files.mjs`/`turn-files.test.mjs`, добавленные позже той же задачей 18 — `server.mjs` их импортирует, и релей после замены и рестарта не поднялся бы. Список ниже собирается диффом, а не пишется руками.

```bash
SHA=<SHA слияния из задачи 15>
WT=~/Downloads/spirits_back/.worktrees/mcp-turn-token
BASE="${SHA}^1"
# Все файлы relay-agent/, изменившиеся в этом слиянии — не фиксированный
# список (см. предупреждение выше). name-status — чтобы отдельно обработать
# удалённые (D), если такие будут.
CHANGED=$(git -C "$WT" diff --name-status "$BASE" "$SHA" -- relay-agent/)
echo "$CHANGED"
PUT=$(echo "$CHANGED" | awk '$1 != "D" {sub(/^relay-agent\//, "", $2); print $2}' | paste -sd, -)
DEL=$(echo "$CHANGED" | awk '$1 == "D" {sub(/^relay-agent\//, "", $2); print $2}' | paste -sd, -)
echo "копируем: $PUT"; echo "удаляем: ${DEL:-нет}"
ssh dv@5.101.115.184 "ST=file-agent-stage-${SHA:0:7} SHORT=${SHA:0:7} PUT=$PUT DEL=$DEL bash -s" <<'EOF'
set -euo pipefail
cd ~/file-agent
n=$(ps --ppid "$(pm2 pid file-agent)" --no-headers | wc -l)
[ "$n" = 0 ] || { echo "живых ходов: $n — не катим"; exit 1; }
IFS=',' read -ra PUTARR <<< "$PUT"
for f in "${PUTARR[@]}"; do
  [ -n "$f" ] || continue
  cp ~/"$ST"/"$f" ".$f.tmp" && mv ".$f.tmp" "$f"
done
if [ -n "${DEL:-}" ]; then
  IFS=',' read -ra DELARR <<< "$DEL"
  for f in "${DELARR[@]}"; do [ -n "$f" ] && rm -f -- "$f"; done
fi
( umask 077; printf '{\n  "mcpServers": {}\n}\n' > .empty-mcp.json.tmp && mv .empty-mcp.json.tmp empty-mcp.json )
# Целостность ДО коммита и ДО рестарта: все локальные импорты server.mjs и
# его модулей обязаны существовать файлом рядом — ровно так уже ломалось
# (см. предупреждение выше). Неудача — exit 1 из-под set -e останавливает
# скрипт: ни commit, ни restart не происходят.
grep -ohE 'from "\./[^"]+"' *.mjs | cut -d'"' -f2 | sort -u | while read m; do test -f "$m" || { echo "нет $m"; exit 1; }; done
echo "импорты на месте"
git add -A .
git commit -q -m "инструменты linkeon по токену хода, папки по fs_key (spirits_back $SHORT)"
git log --oneline -1
git status --short | head -5
pm2 restart file-agent >/dev/null
sleep 3
pm2 describe file-agent | grep -E "status|restarts" | head -2
curl -s http://127.0.0.1:3033/health
# Конфиги хода прежней версии лежали в корне каталога загрузок; новая уборка
# смотрит только mcp/. Прежний процесс уже остановлен — все они осиротевшие.
echo "старых конфигов в корне удалено: $(find /tmp/agent-uploads -maxdepth 1 -name "*-session-mcp.json" -print -delete | wc -l)"
stat -c "%a %n" /tmp/agent-uploads/mcp
date -u
EOF
```

Ожидается: коммит в git релея; в `git status` нет `empty-mcp.json` (он вне git) и нет `.tmp`; `status │ online`; `/health` — `{"status":"ok",…}`; число удалённых старых конфигов (любое, обычно 0); `700 /tmp/agent-uploads/mcp`; время рестарта (`date -u`) — записать в отчёт, оно нужно задаче 19. «живых ходов: N» — подождать и повторить шаг 4 целиком. «нет $m» / «импорты не сходятся» — стоп, разобраться, какого файла не хватает в `$PUT` (скорее всего `$CHANGED` неполный — проверить вручную `git diff --name-status` на всю историю задачи 18, а не только с `${SHA}^1`, если в это слияние попали промежуточные коммиты с других веток).

Почему так: живые ходы проверяются числом детей `file-agent` в той же команде, непосредственно перед заменой — ход мог начаться после шага 2. Рестарт БЕЗ `--update-env`: релею нечего брать из окружения, а перечитанное окружение pm2 — лишний риск. Старый `empty-mcp.json` (с общим секретом) копией НЕ держим — секрет в `~/file-agent-backups/` лежал бы бессрочно открытым текстом на диске релея, который держит и чужие транскрипты. Нужен откат — собрать его заново (см. ниже), значение берётся из `.env` прода трубой, а не копией файла.

- [ ] **Шаг 5: базовый конфиг работает — ход без токена**

```bash
ssh dv@5.101.115.184 'bash ~/file-agent/keep-warm.sh; grep -o "\"failed\":[a-z]*" /tmp/keepwarm.out | tail -1; grep -c "\"type\":\"done\"" /tmp/keepwarm.out'
```

Ожидается: `"failed":false` и `1` — CLI поднимается с пустым `mcpServers` и `--strict-mcp-config` (keep-warm шлёт ход без токенов, то есть с базовым конфигом). Стоит один короткий ход.

- [ ] **Шаг 6: первые ходы после рестарта**

Через 15–30 минут обычного трафика:

```bash
ssh dv@5.101.115.184 'ls -t /tmp/agent-output | head -5; ls /tmp/agent-uploads/*-session-mcp.json 2>/dev/null | wc -l; pm2 logs file-agent --lines 200 --nostream 2>&1 | grep -ciE "error|exception" || true'
ssh dvolkov@212.113.106.202 'L=$(ls -t ~/.pm2/logs/linkeon-api-out*.log | head -1); grep -a "tools/call" "$L" | tail -3 | cut -c1-100; grep -a "вызов по общему секрету" "$L" | tail -1 | cut -c1-60'
```

Ожидается: новые папки в `/tmp/agent-output` — 32 hex; конфигов хода на диске — по числу идущих ходов (единицы); ошибок в логе релея не больше обычного; на бэке `tools/call` идут, последняя строка «вызов по общему секрету» — по времени раньше рестарта релея.

**Откат шага** (при нуле живых ходов, той же схемой одной командой): `git -C ~/file-agent checkout HEAD~1 -- server.mjs paths.mjs` и коммит. `empty-mcp.json` — без копии: собрать заново, секрет трубой ssh → ssh, без печати и без файла на маке/ноде:

```bash
ssh dvolkov@212.113.106.202 'grep ^MCP_SECRET= ~/spirits_back/.env | cut -d= -f2-' | ssh dv@5.101.115.184 '
  umask 077
  S=$(cat)
  printf "{\n  \"mcpServers\": {\n    \"linkeon\": {\n      \"type\": \"http\",\n      \"url\": \"https://my.linkeon.io/mcp\",\n      \"headers\": { \"Authorization\": \"Bearer %s\" }\n    }\n  }\n}\n" "$S" > ~/file-agent/.empty-mcp.json.tmp
  mv ~/file-agent/.empty-mcp.json.tmp ~/file-agent/empty-mcp.json
  chmod 600 ~/file-agent/empty-mcp.json
'
pm2 restart file-agent  # на релее
```

Бэк ничего не заметит: переходный путь ещё открыт.

⚠️ **После этого шага бэк откатывается ТОЛЬКО вместе с релеем.** Релей новой версии подключает сервер `linkeon` в конфиг хода исключительно из `linkeon_token`/`linkeon_mcp_url`, которые шлёт бэк (`linkeon-relay-fields.ts`); откатившийся в одиночку бэк (например, до задачи 6) эти поля уже не шлёт или шлёт не в том виде, и инструменты Linkeon у всех пользователей молча пропадут — ни ошибки, ни предупреждения, просто ассистент перестанет их видеть. Порядок отката при уже выкаченном релее: СНАЧАЛА вернуть прежние `server.mjs` и `empty-mcp.json` релея (команда выше, из копии/бэкапа), и только потом откатывать бэк.

---

### Задача 19: сутки наблюдения и живая проверка — с OK владельца

Промпты штатных персон в базе (seed-агенты) владелец проверил вручную 26.10.2026: упоминаний `userId` и номера телефона — 0. Собственные ассистенты пользователей (кастомные промпты) владелец проверяет отдельно, вне этого плана.

- [ ] **Шаг 1: через сутки — переходным путём никто не ходит**

```bash
ssh dvolkov@212.113.106.202 'for f in $(ls -tr ~/.pm2/logs/linkeon-api-out*.log*); do n=$(zcat -f "$f" | grep -ac "вызов по общему секрету"); [ "$n" = 0 ] || echo "$f: $n, последняя: $(zcat -f "$f" | grep -a "вызов по общему секрету" | tail -1 | cut -c1-60)"; done; echo ---; L=$(ls -t ~/.pm2/logs/linkeon-api-out*.log | head -1); grep -ac "tools/call" "$L"'
```

Ожидается: у каждой строки «последняя» время раньше рестарта релея из задачи 18 (или строк нет вовсе); счётчик `tools/call` > 0. Строка после рестарта — кто-то ещё зовёт `/mcp` общим секретом: найти по времени и `tool=…`, разобраться до задачи 22.

Дополнительно к наблюдению за `/mcp` — то же для самой точки `/webhook/mcp/linkeon`:

```bash
# 401 на /webhook/mcp/linkeon должны быть близки к нулю (легитимный вызов несёт токен хода).
# Путь access-лога nginx на проде не задокументирован в этом плане — свериться с владельцем;
# ниже — общий вид проверки, путь подставить по месту.
ssh dvolkov@212.113.106.202 'L=$(ls -t /var/log/nginx/*access*.log 2>/dev/null | head -1); if [ -n "$L" ]; then awk "\$0 ~ /mcp\\/linkeon/ {print \$9}" "$L" | sort | uniq -c; else echo "access-лог не найден по обычному пути — уточнить у владельца"; fi'
# В шагах хода (activity-лента) не должно быть сырых имён скриптов вроде generate_image.sh —
# это внутренняя кухня self-heal, пользователю её видно не должно быть.
ssh dv@5.101.115.184 'pm2 logs file-agent --lines 1000 --nostream 2>&1 | grep -c "generate_image.sh" || true'
```

Ожидается: 401 — единицы или ноль за сутки (сверх ручных проверок самого плана); `generate_image.sh` — `0`.

- [ ] **Шаг 2: скрипт живой проверки** — файл `.superpowers/mcp-live-check.sh` (вне git; секретов в нём нет: `DEBUG_SECRET` читается из `.env` на сервере):

```bash
#!/usr/bin/env bash
# Живая проверка инструментов Linkeon по токену хода (план 2026-10-26-mcp-turn-token, задача 19).
# Запускается НА ПРОДЕ отвязанно; секреты берутся из ~/spirits_back/.env на месте и не печатаются.
set -uo pipefail
B=http://127.0.0.1:3001/webhook
DS=$(sed -n 's/^DEBUG_SECRET=//p' ~/spirits_back/.env | tr -d "\"'")
PHONE=70000000000
EMAIL=claude.itest@linkeon.io
AGENT=12   # Роман — через релей

dbg() { curl -s -H @<(printf 'X-Debug-Secret: %s\n' "$DS") "$1"; }
field() { python3 -c 'import sys,json; print(json.load(sys.stdin).get(sys.argv[1]) or "")' "$1"; }

curl -s "$B/898c938d-f094-455c-86af-969617e62f7a/sms/$PHONE" >/dev/null; sleep 1
CODE=$(dbg "$B/debug/sms-code/$PHONE" | field code)
TP=$(curl -s "$B/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$PHONE/$CODE" | field access-token)

curl -s -X POST "$B/auth/email/request" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" >/dev/null; sleep 1
ET=$(dbg "$B/debug/email-token/claude.itest%40linkeon.io" | field token)
TE=$(curl -s -H 'Accept: application/json' "$B/auth/email/confirm?token=$ET" | field access-token)
echo "вход: телефон=${TP:+ok} почта=${TE:+ok}"
[ -n "$TP" ] && [ -n "$TE" ] || exit 1

chat() { # $1 — access-токен, $2 — реплика; печатает начало ответа одной строкой
  python3 -c 'import json,sys; print(json.dumps({"assistantId": sys.argv[1], "message": sys.argv[2]}))' "$AGENT" "$2" \
  | curl -sN -m 900 -X POST "$B/soulmate/chat" -H @<(printf 'Authorization: Bearer %s\n' "$1") -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c 'import sys,json
t = ""
for l in sys.stdin:
    try:
        o = json.loads(l)
    except Exception:
        continue
    if o.get("type") == "item":
        t += o.get("content") or ""
print(" ".join(t.split())[:300])'
}

L=$(ls -t ~/.pm2/logs/linkeon-api-out*.log | head -1)
N0=$(grep -ac "вызов по общему секрету" "$L")
for who in phone email; do
  if [ "$who" = phone ]; then T=$TP; else T=$TE; fi
  echo "== $who / картинка:";       chat "$T" 'Нарисуй простую картинку: синий круг на белом фоне, качество std.'
  # Второе сообщение В ТОЙ ЖЕ СЕССИИ: инструменты должны остаться доступны и
  # на втором ходе, а не только на первом сообщении сессии (конфиг хода
  # пишется КАЖДЫЙ ход заново, см. server.mjs — проверяем именно это).
  echo "== $who / картинка вторым ходом той же сессии:"; chat "$T" 'Теперь нарисуй жёлтый квадрат на белом фоне, тоже std.'
  echo "== $who / рутина вкл:";     chat "$T" 'Включи мне ежедневное напоминание в 8 утра: «выпей стакан воды».'
  echo "== $who / рутина выкл:";    chat "$T" 'Выключи, пожалуйста, это ежедневное напоминание про воду.'
  echo "== $who / календарь:";      chat "$T" 'Что у меня в календаре на этой неделе? Прочитай календарь.'
done
echo "== вызовы инструментов (последние 16):"
grep -a "tools/call" "$L" | tail -16 | sed -E 's/.*(tools\/call .*)/\1/'
echo "== строк переходного пути за проверку (ждём 0): $(( $(grep -ac "вызов по общему секрету" "$L") - N0 ))"
echo "== готово"
```

- [ ] **Шаг 3: запуск на проде отвязанно и чтение лога**

```bash
ssh dvolkov@212.113.106.202 'cat > /tmp/mcp-live-check.sh' < .superpowers/mcp-live-check.sh
ssh dvolkov@212.113.106.202 'setsid -f bash /tmp/mcp-live-check.sh > /tmp/mcp-live-check.log 2>&1 < /dev/null; echo запущено'
```

Ждать до строки `== готово` (10 ходов, до 20–30 минут): `ssh dvolkov@212.113.106.202 'tail -5 /tmp/mcp-live-check.log'`. Цена — 10 ходов Opus и до четырёх картинок на тестовых аккаунтах.

Ожидается в `/tmp/mcp-live-check.log`:
- `вход: телефон=ok почта=ok`;
- картинка у телефонного пользователя — ответ с `![](https://my.linkeon.io/smm-media/…)`; у почтового — картинка или честное «недостаточно токенов» (это тоже доказательство: инструмент дошёл и списывал с ЭТОГО пользователя);
- картинка ВТОРЫМ ходом той же сессии — тот же результат, что и первым: инструмент доступен не только на первом сообщении сессии (конфиг хода пишется заново на каждый ход);
- рутина — «настроил»/«выключил» без «инструмент недоступен»;
- календарь — список событий или предложение подключить календарь (`connected:false`), но не «не могу прочитать»;
- в вызовах инструментов — `generate_image` (дважды на пользователя — первый и второй ход), `manage_routine` (×2), `read_calendar` с `userId=70000000000` и те же с UUID почтового пользователя;
- `строк переходного пути за проверку (ждём 0): 0`.

Отдельно, вручную (скрипт этого не делает — нужна папка хода ДО перехода на `fs_key`, которой у тестовых аккаунтов ещё нет): правка файла, созданного до выката, должна доходить до пользователя. Взять РЕАЛЬНУЮ сессию с файлом в истории (папка `/tmp/agent-output/<sanitized sessionId>` на релее, созданная до задачи 18) и попросить ассистента в том же разговоре поправить этот файл. Ожидается: ссылка на итог в ответе — файл не потерялся из-за перехода на новую папку (`fs_key`); проверять на том аккаунте, где такая история уже есть, без создания новых тестовых данных.

Любое расхождение — стоп, разбор до задачи 20. После проверки: `ssh dvolkov@212.113.106.202 'rm -f /tmp/mcp-live-check.sh /tmp/mcp-live-check.log'`.

---

### Задача 20: снятие переходного пути — код

Только после зелёной задачи 19. Новая ветка в том же воркдереве (node-run.sh привязан к нему):

```bash
git fetch -q origin && git switch -c feat/mcp-turn-token-cleanup origin/main
```

**Files:**
- Modify: `src/mcp/mcp.controller.ts`, `src/mcp/mcp.controller.spec.ts`, `src/mcp/mcp.controller.problem-report.spec.ts`, `src/mcp/mcp.controller.routes.spec.ts`
- Modify: `src/mcp/products-mcp.controller.ts` (комментарий), `src/main.ts` (комментарий)

`main.ts` по коду не меняется: исключение `mcp` из префикса без маршрута `/mcp` безвредно, а сторож адреса продуктов (`products-mcp.controller.spec.ts`) держится за него. Блок `location /mcp` в nginx прода не трогаем (один файл конфига — память «nginx прода — один файл»); запрос туда после снятия получит 404 от бэка.

- [ ] **Шаг 1: тесты**

`src/mcp/mcp.controller.spec.ts`:
- в тесте «tools/list по токену…» вызов `make().ctrl.listTools({ kind: 'token', userId: 'u-1' })` заменить на `make().ctrl.listTools()`;
- блок `describe('переходный путь: общий MCP_SECRET', () => { … });` заменить целиком на:

```ts
  describe('общий секрет снят', () => {
    it('Bearer, равный MCP_SECRET, больше не принимается', async () => {
      process.env.MCP_SECRET = 'shared-spec';
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer shared-spec', 'generate_image', { userId: '70000000000', prompt: 'x' })).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });

    it('пустой Bearer — 401', async () => {
      const { ctrl, tools } = make();
      await expect(ctrl.callTool('Bearer ', 'generate_image', { userId: 'u-1' })).rejects.toThrow(UnauthorizedException);
      expect(tools.executeTool).not.toHaveBeenCalled();
    });
  });
```

`src/mcp/mcp.controller.problem-report.spec.ts` — удалить последний тест «общий секрет без userId — отказ; инструмент и поддержка не зовутся» целиком.

`src/mcp/mcp.controller.routes.spec.ts`:

```ts
// было
  it('прежний /mcp на переходный период: общий секрет и токен хода доходят до обработчика', async () => {
    expect(await status('/mcp', 'Bearer mcp-routes-shared')).toBe(405);
    expect(await status('/mcp', token())).toBe(405);
    expect(await status('/mcp')).toBe(401);
  });

  it('других адресов у точки нет', async () => {
    expect(await status('/mcp/linkeon', token())).toBe(404);
    expect(await status('/webhook/mcp', token())).toBe(404);
  });
// стало
  it('прежнего /mcp больше нет — ни с общим секретом, ни с токеном хода', async () => {
    expect(await status('/mcp', 'Bearer mcp-routes-shared')).toBe(404);
    expect(await status('/mcp', token())).toBe(404);
  });

  it('других адресов у точки нет', async () => {
    expect(await status('/mcp/linkeon', token())).toBe(404);
    expect(await status('/webhook/mcp', token())).toBe(404);
  });
```

(`process.env.MCP_SECRET = 'mcp-routes-shared'` в `beforeAll` оставить: тест доказывает, что заданный секрет больше ничего не открывает.)

- [ ] **Шаг 2: коммит тестов, прогон — падает**

```bash
git add src/mcp/mcp.controller.spec.ts src/mcp/mcp.controller.problem-report.spec.ts src/mcp/mcp.controller.routes.spec.ts
git commit -q -m "test(mcp): общий секрет и /mcp сняты" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕" | head -12'
```

Ожидается: FAIL в «Bearer, равный MCP_SECRET, больше не принимается» и «прежнего /mcp больше нет…» (`Received: 405`).

- [ ] **Шаг 3: реализация — `src/mcp/mcp.controller.ts`**

```ts
// было
/**
 * Кто зовёт инструмент — по Bearer.
 *   token  — релей с токеном хода (linkeon-tool.token.ts): пользователь из подписи;
 *   shared — переходный путь: общий MCP_SECRET, пользователь из args.userId,
 *            как до 26.10.2026. Снимается шагом 4 выката (спека
 *            docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md).
 */
export type McpCaller = { kind: 'token'; userId: string } | { kind: 'shared' };

/** Поле userId — только в схеме переходного пути и без примера номера. */
const LEGACY_USER_ID_DESCRIPTION =
  'Current user id from the system context. Required on the transitional shared-secret path — the server uses it to bill tokens and attribute history.';
// стало
/** Кто зовёт инструмент: релей с токеном хода (linkeon-tool.token.ts), пользователь из подписи. */
export type McpCaller = { kind: 'token'; userId: string };
```

```ts
// было
 *   • /mcp — прежний, до снятия переходного пути (шаг 4 выката).
 * Сторож адресов — mcp.controller.routes.spec.ts (живое приложение Nest).
 */
@Controller(['mcp', 'mcp/linkeon'])
// стало
 * Прежний адрес /mcp и общий MCP_SECRET сняты (шаг 4 выката, спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md).
 * Сторож адресов — mcp.controller.routes.spec.ts (живое приложение Nest).
 */
@Controller('mcp/linkeon')
```

(строку `*   • /webhook/mcp/linkeon — основной.` в том же комментарии заменить на `*   • /webhook/mcp/linkeon — единственный адрес.`; строку `* Два адреса одной логики:` — на `* Адрес:`.)

```ts
// было
  private caller(authHeader?: string): McpCaller {
    const header = authHeader || '';
    const shared = process.env.MCP_SECRET || '';
    if (shared && header === `Bearer ${shared}`) return { kind: 'shared' };
    const raw = header.replace(/^Bearer\s+/i, '').trim();
// стало
  private caller(authHeader?: string): McpCaller {
    const raw = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
```

```ts
// было
  /**
   * tools/list. По токену — схемы инструментов как есть: пользователь в
   * подписи, аргумента userId нет. По общему секрету — прежняя схема с
   * обязательным userId: прежний релей пишет его в аргумент.
   * Вынесено из makeServer ради проверяемости.
   */
  listTools(caller: McpCaller) {
    return CHAT_TOOLS.map((t) => {
      const schema: any = t.input_schema ?? {};
      const properties: Record<string, any> = { ...(schema.properties ?? {}) };
      const required: string[] = [...(schema.required ?? [])];
      if (caller.kind === 'shared') {
        return {
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object' as const,
            properties: { ...properties, userId: { type: 'string', description: LEGACY_USER_ID_DESCRIPTION } },
            required: ['userId', ...required],
          },
        };
      }
      return { name: t.name, description: t.description, inputSchema: { type: 'object' as const, properties, required } };
    });
  }
// стало
  /**
   * tools/list: схемы инструментов как есть — пользователь в подписи токена,
   * аргумента userId нет. Вынесено из makeServer ради проверяемости.
   */
  listTools() {
    return CHAT_TOOLS.map((t) => {
      const schema: any = t.input_schema ?? {};
      const properties: Record<string, any> = { ...(schema.properties ?? {}) };
      const required: string[] = [...(schema.required ?? [])];
      return { name: t.name, description: t.description, inputSchema: { type: 'object' as const, properties, required } };
    });
  }
```

```ts
// было
    const caller = this.caller(authHeader);
    const server = new Server(
// стало
    this.caller(authHeader);
    const server = new Server(
```

```ts
// было
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools(caller) }));
// стало
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
```

```ts
// было
    const caller = this.caller(authHeader);
    // userId из аргументов выбрасывается ЯВНО (как в products-mcp.controller.ts):
    // по токену пользователь — только из подписи, поле модели не значит ничего.
    const { userId: argUserId, ...toolArgs } = args ?? {};
    let userId: string;
    if (caller.kind === 'token') {
      userId = caller.userId;
    } else {
      // Без пользователя и аргументов: по этой строке видно, что переходный
      // путь ещё кто-то зовёт (шаг 3 выката).
      this.logger.warn(`mcp: вызов по общему секрету (переходный путь), tool=${String(name).slice(0, 64)}`);
      if (!argUserId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'userId argument required' }) }],
          isError: true,
        };
      }
      userId = String(argUserId);
    }
    this.logger.log(`tools/call ${name} userId=${userId}`);
// стало
    const { userId } = this.caller(authHeader);
    // userId из аргументов выбрасывается ЯВНО (как в products-mcp.controller.ts):
    // пользователь — только из подписи, поле модели не значит ничего.
    const { userId: _drop, ...toolArgs } = args ?? {};
    this.logger.log(`tools/call ${name} userId=${userId}`);
```

- [ ] **Шаг 4: комментарии**

`src/mcp/products-mcp.controller.ts`:

```ts
// было
 * (src/mcp/linkeon-tool.token.ts); поле осталось только на переходном пути по
 * общему секрету.
// стало
 * (src/mcp/linkeon-tool.token.ts), а общий секрет снят.
```

`src/main.ts`:

```ts
// было
  // /webhook is the global prefix for backwards-compat with n8n routes,
  // but /mcp is mounted at the root for the MCP bridge to file-agent.
// стало
  // /webhook is the global prefix for backwards-compat with n8n routes.
  // Исключение `mcp` осталось от прежней точки /mcp (снята, спека
  // docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md). Оно
  // покрывает ровно путь `mcp`: /webhook/mcp/linkeon и /webhook/mcp/products
  // живут под префиксом — сторож в products-mcp.controller.spec.ts.
```

- [ ] **Шаг 5: коммит, прогон — зелёный; в коде не осталось `MCP_SECRET`**

```bash
git add src/mcp/mcp.controller.ts src/mcp/products-mcp.controller.ts src/main.ts
git commit -q -m "mcp: общий секрет и адрес /mcp сняты — только токен хода" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/mcp src/chat --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?; grep -rn "MCP_SECRET" src | grep -v "spec.ts" | wc -l'
```

Ожидается: строк `FAIL` нет; `tsc-exit=0`; `0` упоминаний `MCP_SECRET` в коде (кроме тестов).

---

### Задача 21: справка `how-it-works` и документы

**Files:**
- Modify: `src/platform-kb/articles/how-it-works.ts`
- Test: `src/platform-kb/how-it-works.spec.ts`
- Modify: `CLAUDE.md`, `scripts/sync-api-keys-to-test.sh` (комментарий)

- [ ] **Шаг 1: утверждение — правда?** Прежде чем писать в справку «номер и идентификатор нейросетям не передаются», проверить пути, которых эта работа не касалась:

```bash
grep -n '${userId}' src/chat/chat.service.ts src/tg-bot/tg-router.service.ts src/support/support.service.ts src/ask/clean-ask.service.ts
grep -n 'userId\|user_id\|phone' voice-host/src/agent.ts | head -20
```

Просмотреть глазами каждую строку. Ожидается: `${userId}` встречается только в ключах сессий и ходов (`${userId}_${assistantId}`, `${userId}::…`), в логах и в алертах команде (`<code>${userId}</code>`); в `voice-host` — только идентификатор участника LiveKit (`user_${userId}`, модели не передаётся — спека, «Не входит»). Ни одной строки, где `userId` или номер вклеивается в текст промпта, системного промпта или реплики модели. Нашлось — стоп: описать владельцу, строку в справку не писать.

- [ ] **Шаг 2: тест**

`src/platform-kb/how-it-works.spec.ts`:

```ts
import { howItWorks } from './articles/how-it-works';
import { renderArticle } from './render';

/**
 * Политика конфиденциальности обещает: номер телефона и идентификатор
 * аккаунта ИИ-провайдерам не передаются. С 2026-10 это правда (спека
 * 2026-10-26-mcp-turn-token-design.md), и справка говорит это прямо.
 */
describe('справка «Как устроен Linkeon»', () => {
  it('номер телефона и идентификатор аккаунта нейросетям не передаются', () => {
    expect(renderArticle(howItWorks, 'ru', 'web')).toContain('Номер телефона и идентификатор аккаунта нейросетям не передаются.');
  });
});
```

- [ ] **Шаг 3: коммит теста, прогон — падает**

```bash
git add src/platform-kb/how-it-works.spec.ts
git commit -q -m "test(platform-kb): справка — номер и идентификатор нейросетям не передаются" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/platform-kb/how-it-works.spec.ts --maxWorkers=2 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

Ожидается: FAIL.

- [ ] **Шаг 4: статья**

`src/platform-kb/articles/how-it-works.ts`:

```ts
// было
// источник: голос в Telegram — src/tg-bot/tg-voice.service.ts:34-58; расшифровки — voice_calls.transcript, src/admin/admin.service.ts:1866-1877; ключи Zoom/Taler ID — src/calendar/crypto.ts
// стало
// источник: голос в Telegram — src/tg-bot/tg-voice.service.ts:34-58; расшифровки — voice_calls.transcript, src/admin/admin.service.ts:1866-1877; ключи Zoom/Taler ID — src/calendar/crypto.ts
// источник: номер и идентификатор не уходят нейросетям — src/mcp/linkeon-tool.token.ts, relay-agent/server.mjs (нет строки с телефоном), src/support/support.service.ts (get_user_context без user_id)
```

```ts
// было
- Поставщикам нейросетей уходит то, что нужно для ответа: сообщения, переписка, профиль и файлы. Это Anthropic, OpenAI, Google, ElevenLabs и Яндекс, в том числе за пределами страны пользователя. Данные не продаются.
// стало
- Поставщикам нейросетей уходит то, что нужно для ответа: сообщения, переписка, профиль и файлы. Это Anthropic, OpenAI, Google, ElevenLabs и Яндекс, в том числе за пределами страны пользователя. Данные не продаются.
- Номер телефона и идентификатор аккаунта нейросетям не передаются.
```

Статья — «ВЫЧИТКА ВЛАДЕЛЬЦЕМ — вся статья»: строку показать владельцу до слияния.

- [ ] **Шаг 5: документы**

`CLAUDE.md` бэка — из рецепта ручной проверки и описаний убрать упоминания `/mcp` и `MCP_SECRET` как действующих: в списках «rsync сносил … MCP_SECRET …» оставить (это история), в разделе `### Chat` к строке `POST /webhook/mcp/linkeon` дописать: «Прежние `/mcp` и `MCP_SECRET` сняты (2026-10, спека `2026-10-26-mcp-turn-token-design.md`)».

`scripts/sync-api-keys-to-test.sh`:

```bash
# было
  # MCP_SECRET не копируется: у test свой с 07.10.2026. Общий секрет
  # превращал утечку .env стенда в ключ от /mcp прода (календари, рутины,
  # генерация за чужие токены).
# стало
  # MCP_SECRET снят вместе с точкой /mcp (2026-10): инструменты ассистентов
  # ходят по токену хода. Не возвращать.
```

- [ ] **Шаг 6: коммит, прогон — зелёный**

```bash
git add src/platform-kb/articles/how-it-works.ts CLAUDE.md scripts/sync-api-keys-to-test.sh
git commit -q -m "platform-kb: справка — номер и идентификатор нейросетям не передаются; документы без MCP_SECRET" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest src/platform-kb src/mcp --maxWorkers=2 2>&1 | grep -E "^FAIL|^Tests:"; npx tsc -p tsconfig.build.json --noEmit; echo tsc-exit=$?'
```

Ожидается: строк `FAIL` нет (в том числе `kb.spec.ts` — у `how-it-works` свободная форма); `tsc-exit=0`.

---

### Задача 22: слияние, смена и удаление `MCP_SECRET`, выкат — каждый шаг с OK владельца

- [ ] **Шаг 1: ревью и слияние** — как задача 15 (шаги 1–4), ветка `feat/mcp-turn-token-cleanup`, сообщение слияния «Merge feat/mcp-turn-token-cleanup: общий секрет и /mcp сняты». SHA — в отчёт.

- [ ] **Шаг 2: `MCP_SECRET` в `.env` прода и стенда меняется** — до выката: если выкат когда-нибудь откатят на старый бэк, прежнее значение (оно лежит в копии старого `empty-mcp.json` на релее и в старых конфигах) уже ничего не откроет. Значение генерируется на месте, в argv не попадает, не печатается:

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && a=$(stat -c %a .env) && perl -i -pe "BEGIN { chomp(\$n = qx(openssl rand -hex 32)) } s/^MCP_SECRET=.*/MCP_SECRET=\$n/" .env && grep -c "^MCP_SECRET=" .env && [ "$(stat -c %a .env)" = "$a" ] && echo права-прежние'
ssh dv@85.192.61.231 'cd ~/spirits_back && a=$(stat -c %a .env) && perl -i -pe "BEGIN { chomp(\$n = qx(openssl rand -hex 32)) } s/^MCP_SECRET=.*/MCP_SECRET=\$n/" .env && grep -c "^MCP_SECRET=" .env && [ "$(stat -c %a .env)" = "$a" ] && echo права-прежние'
```

Ожидается: `1` и `права-прежние` в обоих. Рестарт не нужен: новый код секрет не читает, а рестарт выката (шаг 3) подхватит новое значение для старого кода на случай отката.

- [ ] **Шаг 3: выкат** — как задача 17, шаги 2–5, с SHA этой задачи. Проверка доехавшего:

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && git log --oneline -1 && for p in /mcp /webhook/mcp/linkeon; do printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3001$p; done'
```

Ожидается: `/mcp 404`, `/webhook/mcp/linkeon 401`. Плюс рецепт ручной проверки с токеном хода из CLAUDE.md — `11` инструментов; через 15–30 минут в логе бэка идут `tools/call`.

- [ ] **Шаг 4: через сутки без отката — удалить `MCP_SECRET` из `.env`**

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && perl -i -ne "print unless /^MCP_SECRET=/" .env; grep -c "^MCP_SECRET=" .env; true'
ssh dv@85.192.61.231 'cd ~/spirits_back && perl -i -ne "print unless /^MCP_SECRET=/" .env; grep -c "^MCP_SECRET=" .env; true'
```

Ожидается: `0`, `0`. Копии старого конфига релея нет (задача 18 её не делает) — чистить нечего.

**Откат после этой задачи** — только вместе: старому бэку нужен старый релей с общим секретом, а секрета больше нет. Поэтому откат бэка на коммит до задачи 20 требует и отката релея (задача 18, «Откат шага»), и нового `MCP_SECRET` в `.env` и в `empty-mcp.json` релея.

---

### Задача 23: память

- [ ] Обновить заметки памяти (`~/.claude/projects/-Users-dmitry-Downloads-spirits-front/memory/`):
  - `project_mcp_userid_forgeable.md` — закрыто: дата выката задачи 18; пользователь из токена хода (`linkeon-tool`), `args.userId` выбрасывается;
  - `project_mcp_secret_consumers.md` — `MCP_SECRET` сменён и удалён (даты задачи 22), точка `/mcp` снята; ручная проверка — рецепт в CLAUDE.md бэка;
  - `project_relay.md` — `linkeon` в конфиге хода из `linkeon_token`, базовый `empty-mcp.json` пуст, папки и загрузки по `fs_key` (`turnFsKey`), строки с телефоном нет;
  - `project_test_no_backend_url_relay_products.md` — то же теперь и для `mcp__linkeon__*`: на стенде без `BACKEND_URL` токен стенда уходит на прод и отвергается (если владелец не решил иначе — см. отчёт);
  - строки в `MEMORY.md` — по заметкам выше, коротко.
