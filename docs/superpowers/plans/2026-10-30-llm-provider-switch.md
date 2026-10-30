# Переключатель модели по аккаунту и запасной Qwen на релее — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** админ выбирает для аккаунта «Claude» или «Qwen» — и ответы всех ассистентов этому человеку (веб через релей, Маша, его TG-боты) идут через выбранную модель; релей сам переигрывает ход на Qwen при сбое доступа к Claude.

**Architecture:** настройка — колонка `ai_profiles_consolidated.llm_provider`, сервис `UserLlmProviderService`, админ-ручки и блок в карточке пользователя. Бэкенд передаёт выбор в `ClaudeCliService` (`provider: 'qwen'`) и в релей (поле формы `provider=qwen`; пробы — `noFallback=1`). Релей получает модуль `qwen-provider.mjs` (чистые функции + окно предохранителя) и небольшую врезку в `server.mjs`, одинаковую для живого релея и копии в main. Мониторинг читает `/health` релея.

**Tech Stack:** NestJS 10 + jest/ts-jest (бэк), Node 22 ESM + `node:test` (релей), React 18 + vitest (фронт), Claude Code CLI 2.1.280 (релей) / 2.1.312 (нода).

**Spec:** `docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md` — читать первым. Предыдущая фича: `docs/superpowers/specs/2026-10-29-qwen-fallback-design.md`.

---

## Где что делается (обязательно)

- **spirits_back:** воркдерево `~/Downloads/spirits_back/.worktrees/llm-provider-switch`, ветка `feat/llm-provider-switch`. Общий чекаут `~/Downloads/spirits_back` (main) не трогать.
- **spirits_front:** воркдерево `~/Downloads/spirits_front/.worktrees/llm-provider-switch`, ветка `feat/llm-provider-switch` (создаётся в Task 0). Общий чекаут не трогать.
- **Тесты, tsc, сборки — только на ноде** `dv@85.192.61.231` (мак не тянет; jest бэка к тому же игнорирует `/.worktrees/`). На ноде — свои воркдеревья `~/ci/wt/llm-switch-back` и `~/ci/wt/llm-switch-front` (Task 0). В каждой ssh-команде `source ~/.nvm/nvm.sh`. Порядок: коммит → `git push` ветки → на ноде `git fetch -q origin && git checkout -q --detach <sha>` → прогон.
- **На ноде не трогать** `~/spirits_back`, `~/spirits_front` (живой test-стенд), `~/dev`, сами `~/ci/spirits_back` и `~/ci/spirits_front` (только `git -C … fetch` и `worktree add/remove`).
- **Живой релей** `dv@5.101.115.184:~/file-agent` (git без remote, база `9ba7f53`) — до Task 11 только читать. На релее нет nvm: `node`/`pm2` системные.
- Пушить только ветки `feat/llm-provider-switch`. В main — только в Task 10.
- ssh рвётся («Connection closed») — подождать 20–30 с и повторить (лимит подключений).
- Ключ Alibaba лежит на маке в `~/.qwen/settings.json` (`security.auth.apiKey`). Передавать только через stdin, никогда не печатать, не класть в argv, файлы репозиториев и отчёты.
- Комментарии в коде — по-русски. Подпись коммитов: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (или своя модель — по системной инструкции агента).

Шаблон прогона бэка на ноде (дальше — «прогон бэка: <файлы>»):

```bash
cd ~/Downloads/spirits_back/.worktrees/llm-provider-switch && git push -q && SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/llm-switch-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest <файлы> 2>&1 | tail -15"
```

Шаблон tsc бэка: тот же ssh, команда `npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK`.

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| Create `src/common/services/user-llm-provider.service.ts` (+ `.spec.ts`) | колонка `llm_provider`, `get`/`set` |
| Modify `src/common/common.module.ts` | регистрация сервиса |
| Create `src/admin/admin-llm-provider.controller.ts` (+ `.spec.ts`) | `GET/POST /webhook/admin/users/:userId/llm-provider` |
| Modify `src/admin/admin.module.ts` | регистрация контроллера |
| Modify `src/common/services/claude-cli.service.ts` | опция `provider: 'qwen'`, `fallback` в событии |
| Create `src/common/services/claude-cli.forced-qwen.spec.ts` | тесты принудительного Qwen |
| Create `src/chat/answer-provider.ts` (+ `.spec.ts`) | чистые функции: выбор провайдера хода, поля к релею, разбор `done` |
| Modify `src/chat/chat.service.ts` | Маша и релей следуют выбору; `provider`/`fallback` в `chat_quality` |
| Modify `src/tg-bot/tg-router.service.ts`, `src/tg-bot/tg-router.model.spec.ts` | TG-бот следует выбору владельца |
| Create `src/monitoring/relay-qwen-monitor.service.ts` (+ `.spec.ts`) | алерт «релей на запасном Qwen» по `/health` |
| Modify `src/monitoring/monitoring.module.ts` | регистрация |
| Create `relay-agent/qwen-provider.mjs` (+ `qwen-provider.test.mjs`) | релей: конфиг, модели, окружение, решения, окно |
| Create `relay-agent/qwen-patch.py` | врезка в `server.mjs` по якорям — одна для живого релея и копии |
| Modify `relay-agent/server.mjs` | результат `qwen-patch.py` |
| Front: Create `src/components/admin/UserLlmProviderControl.tsx` (+ `.test.tsx`) | блок «Модель ответов» |
| Front: Modify `src/components/admin/UserActivityDrawer.tsx`, `src/i18n/locales/{ru,en,pt}.json` | вставка блока, строки |

---

### Task 0: воркдеревья на маке и ноде, база

- [ ] **Step 1: Ветка бэка на GitHub и воркдерево на ноде**

```bash
git -C ~/Downloads/spirits_back/.worktrees/llm-provider-switch push -q -u origin feat/llm-provider-switch
SHA=$(git -C ~/Downloads/spirits_back/.worktrees/llm-provider-switch rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/llm-switch-back $SHA && cd ~/ci/wt/llm-switch-back && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund 2>&1 | tail -1"
```

Expected: `added N packages`.

- [ ] **Step 2: Воркдерево фронта на маке и на ноде**

```bash
cd ~/Downloads/spirits_front && git fetch -q origin && git worktree add -q -b feat/llm-provider-switch .worktrees/llm-provider-switch origin/main
git -C .worktrees/llm-provider-switch push -q -u origin feat/llm-provider-switch
FSHA=$(git -C .worktrees/llm-provider-switch rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/llm-switch-front $FSHA && cd ~/ci/wt/llm-switch-front && source ~/.nvm/nvm.sh && pnpm install --frozen-lockfile 2>&1 | tail -2"
```

- [ ] **Step 3: База (до правок)**

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/llm-switch-back && source ~/.nvm/nvm.sh && npx jest src/common src/admin src/chat src/tg-bot src/monitoring --silent 2>&1 | grep -aE "^(Tests:|Test Suites:)"; npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK; cd relay-agent && node --test *.test.mjs 2>&1 | grep -aE "^# (pass|fail)"'
ssh dv@85.192.61.231 'cd ~/ci/wt/llm-switch-front && source ~/.nvm/nvm.sh && ./node_modules/.bin/vitest run src/components/admin 2>&1 | grep -aE "Test Files|Tests "; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c "error TS"'
```

Записать числа в отчёт: дальше мерить дельтой (у фронта tsc на main не нулевой — память: база ~45 ошибок).

---

### Task 1: `UserLlmProviderService`

**Files:**
- Create: `src/common/services/user-llm-provider.service.ts`
- Test: `src/common/services/user-llm-provider.service.spec.ts`
- Modify: `src/common/common.module.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { UserLlmProviderService } from './user-llm-provider.service';

const mk = (impl: (sql: string, params?: any[]) => any) => {
  const query = jest.fn(async (sql: string, params?: any[]) => impl(sql, params));
  return { svc: new UserLlmProviderService({ query } as any), query };
};

describe('UserLlmProviderService', () => {
  it('get: qwen', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'qwen' }] }));
    expect(await svc.get('79030169187')).toBe('qwen');
  });

  it('get: NULL — claude', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: null }] }));
    expect(await svc.get('79030169187')).toBe('claude');
  });

  it('get: нет пользователя — claude', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.get('nobody')).toBe('claude');
  });

  it('get: сбой БД — claude, без исключения', async () => {
    const { svc } = mk(() => { throw new Error('db down'); });
    expect(await svc.get('79030169187')).toBe('claude');
  });

  it('get: пустой userId — claude без запроса', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    expect(await svc.get('')).toBe('claude');
    expect(query).not.toHaveBeenCalled();
  });

  it('set qwen — пишет qwen, true', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    expect(await svc.set('79030169187', 'qwen')).toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE ai_profiles_consolidated SET llm_provider = \$2 WHERE user_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['79030169187', 'qwen']);
  });

  it('set claude — пишет NULL', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('79030169187', 'claude');
    expect(query.mock.calls[0][1]).toEqual(['79030169187', null]);
  });

  it('set: нет пользователя — false', async () => {
    const { svc } = mk(() => ({ rows: [], rowCount: 0 }));
    expect(await svc.set('nobody', 'qwen')).toBe(false);
  });

  it('onModuleInit: колонка добавляется без значения по умолчанию; сбой не роняет старт', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    await svc.onModuleInit();
    expect(query.mock.calls[0][0]).toBe('ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS llm_provider text');
    const bad = mk(() => { throw new Error('lock timeout'); });
    await expect(bad.svc.onModuleInit()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Коммит, push, прогон — красный**

```bash
cd ~/Downloads/spirits_back/.worktrees/llm-provider-switch
git add src/common/services/user-llm-provider.service.spec.ts
git commit -q -m "test: UserLlmProviderService (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Прогон бэка: `src/common/services/user-llm-provider`. Expected: FAIL `Cannot find module './user-llm-provider.service'`.

- [ ] **Step 3: Сервис**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';

export type LlmProvider = 'claude' | 'qwen';
export const LLM_PROVIDERS: readonly LlmProvider[] = ['claude', 'qwen'];

/**
 * Модель ответов ассистентов для конкретного человека (spec
 * docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md).
 * NULL — Claude (по умолчанию), 'qwen' — ответы сразу через Qwen.
 *
 * Отдельная колонка, а не ключ profile_data: profile_data пишет сам
 * пользователь через обновление профиля, а этот выбор тратит квоту владельца —
 * его меняет только админка.
 */
@Injectable()
export class UserLlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(UserLlmProviderService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    try {
      // Без значения по умолчанию и без индекса — мгновенно, без долгих блокировок.
      await this.pg.query('ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS llm_provider text');
    } catch (e: any) {
      this.logger.warn(`llm_provider: колонка не добавлена: ${e?.message}`);
    }
  }

  /** Сбой БД — Claude: ход не должен падать из-за настройки. */
  async get(userId: string): Promise<LlmProvider> {
    if (!userId) return 'claude';
    try {
      const r = await this.pg.query('SELECT llm_provider FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      return r.rows[0]?.llm_provider === 'qwen' ? 'qwen' : 'claude';
    } catch (e: any) {
      this.logger.warn(`llm_provider: не прочитан для ${userId}: ${e?.message}`);
      return 'claude';
    }
  }

  /** false — такого пользователя нет. */
  async set(userId: string, provider: LlmProvider): Promise<boolean> {
    const r = await this.pg.query(
      'UPDATE ai_profiles_consolidated SET llm_provider = $2 WHERE user_id = $1',
      [userId, provider === 'qwen' ? 'qwen' : null],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 4: Регистрация в `src/common/common.module.ts`**

Добавить импорт `import { UserLlmProviderService } from './services/user-llm-provider.service';` и вписать `UserLlmProviderService` в конец обоих массивов — `providers` и `exports`.

- [ ] **Step 5: Коммит, прогон — зелёный, tsc**

```bash
git add src/common/services/user-llm-provider.service.ts src/common/common.module.ts
git commit -q -m "feat: UserLlmProviderService — модель ответов по аккаунту (колонка llm_provider)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Прогон бэка: `src/common/services/user-llm-provider` — PASS 9/9; tsc — `TSC_OK`.

---

### Task 2: админ-ручки

**Files:**
- Create: `src/admin/admin-llm-provider.controller.ts`
- Test: `src/admin/admin-llm-provider.controller.spec.ts`
- Modify: `src/admin/admin.module.ts`

- [ ] **Step 1: Падающий тест**

```ts
import 'reflect-metadata';
import { AdminLlmProviderController } from './admin-llm-provider.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('AdminLlmProviderController', () => {
  const OLD = process.env.QWEN_FALLBACK_API_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.QWEN_FALLBACK_API_KEY;
    else process.env.QWEN_FALLBACK_API_KEY = OLD;
  });

  it('закрыт JwtGuard + AdminGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminLlmProviderController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });

  it('GET: выбор и наличие ключа', async () => {
    process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
    const svc = { get: jest.fn(async () => 'qwen'), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).get('79030169187', res);
    expect(svc.get).toHaveBeenCalledWith('79030169187');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ userId: '79030169187', provider: 'qwen', qwenConfigured: true });
  });

  it('GET без ключа — qwenConfigured: false', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const svc = { get: jest.fn(async () => 'claude'), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).get('u1', res);
    expect(res.json).toHaveBeenCalledWith({ userId: 'u1', provider: 'claude', qwenConfigured: false });
  });

  it('POST: сохраняет и отдаёт новое значение', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('79030169187', { provider: 'qwen' }, res);
    expect(svc.set).toHaveBeenCalledWith('79030169187', 'qwen');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ userId: '79030169187', provider: 'qwen', qwenConfigured: false });
  });

  it('POST: чужое значение — 400, ничего не пишет', async () => {
    const svc = { get: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('u1', { provider: 'gpt' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST: нет пользователя — 404', async () => {
    const svc = { get: jest.fn(), set: jest.fn(async () => false) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('nobody', { provider: 'claude' }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
```

- [ ] **Step 2: Коммит, прогон — красный** (`src/admin/admin-llm-provider`; Expected: FAIL — нет модуля).

- [ ] **Step 3: Контроллер**

```ts
import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { LLM_PROVIDERS, LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';
import { readQwenFallbackConfig } from '../common/services/qwen-fallback';

/**
 * Модель ответов ассистентов по аккаунту (spec 2026-10-30-llm-provider-switch).
 * :userId — тот же идентификатор, что у /webhook/admin/users/:phone/activity
 * (телефон или UUID входа по почте). qwenConfigured — задан ли ключ Qwen на
 * бэкенде: без него выбор «Qwen» молча работает как Claude.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminLlmProviderController {
  constructor(private readonly providers: UserLlmProviderService) {}

  @Get('admin/users/:userId/llm-provider')
  async get(@Param('userId') userId: string, @Res() res: Response) {
    const provider = await this.providers.get(userId);
    return res.status(200).json({ userId, provider, qwenConfigured: readQwenFallbackConfig() !== null });
  }

  @Post('admin/users/:userId/llm-provider')
  async set(@Param('userId') userId: string, @Body() body: any, @Res() res: Response) {
    const provider = String(body?.provider ?? '') as LlmProvider;
    if (!LLM_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: "provider: 'claude' | 'qwen'" });
    }
    if (!(await this.providers.set(userId, provider))) {
      return res.status(404).json({ error: 'user not found' });
    }
    return res.status(200).json({ userId, provider, qwenConfigured: readQwenFallbackConfig() !== null });
  }
}
```

- [ ] **Step 4: `src/admin/admin.module.ts`** — импорт `AdminLlmProviderController` и добавить его в массив `controllers` (`[AdminController, AdminProductsController, AdminLlmProviderController]`). `CommonModule` там уже импортирован — сервис доступен.

- [ ] **Step 5: Коммит, прогон — зелёный** (`src/admin`), tsc — `TSC_OK`.

---

### Task 3: `ClaudeCliService` — принудительный Qwen

**Files:**
- Modify: `src/common/services/claude-cli.service.ts`
- Test: `src/common/services/claude-cli.forced-qwen.spec.ts`

- [ ] **Step 1: Падающий тест** (вспомогательные функции — как в `claude-cli.fallback.spec.ts`)

```ts
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { Logger } from '@nestjs/common';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Выбор пользователя «Qwen» (админка, spec 2026-10-30-llm-provider-switch):
 * вызов сразу на Qwen, без попытки Claude. Это не авария — окно
 * предохранителя и fallbackStats не трогаются, событие помечено fallback: false.
 */

const spawnMock = spawn as unknown as jest.Mock;

function fakeProc(stdout: string, code = 0) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => { outH.forEach((cb) => cb(Buffer.from(stdout))); on['close']?.(code); });
  return proc;
}

const OK = (result: string, cost = 0.01) => JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
const hasEnv = (i: number) => spawnMock.mock.calls[i][2]?.env !== undefined;
const envOf = (i: number) => spawnMock.mock.calls[i][2]?.env as NodeJS.ProcessEnv | undefined;
const modelOf = (i: number) => { const a: string[] = spawnMock.mock.calls[i][1]; return a[a.indexOf('--model') + 1]; };

const OLD = process.env.QWEN_FALLBACK_API_KEY;
beforeEach(() => { spawnMock.mockReset(); process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test'; });
afterEach(() => {
  if (OLD === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD;
  jest.restoreAllMocks();
});

describe('ClaudeCliService — provider: qwen', () => {
  it('сразу Qwen: один spawn, модель и окружение Alibaba', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('ответ qwen', 0.03)));
    const r = await new ClaudeCliService().textWithCost('x', { model: 'claude-opus-5-5', provider: 'qwen' });
    expect(r).toEqual({ text: 'ответ qwen', costUsd: 0.03 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(modelOf(0)).toBe('qwen3.8-max');
    expect(envOf(0)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('без ключа — Claude и предупреждение', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('claude')));
    expect(await new ClaudeCliService().text('x', { provider: 'qwen' })).toBe('claude');
    expect(hasEnv(0)).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Qwen выбран.*ключ/);
  });

  it('noFallback побеждает: проба — только Claude', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('claude')));
    await new ClaudeCliService().text('x', { provider: 'qwen', noFallback: true });
    expect(hasEnv(0)).toBe(false);
  });

  it('окно предохранителя и fallbackStats не трогаются', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q'))).mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    await svc.text('x', { provider: 'qwen' });
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
    await svc.text('y'); // обычный вызов — на Claude
    expect(hasEnv(1)).toBe(false);
  });

  it('сбой принудительного Qwen — понятная ошибка, окно не открыто', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1)).mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    const err = await svc.text('x', { provider: 'qwen' }).catch((e) => e);
    expect(err.message).toMatch(/^claude CLI не вызывался \(выбран Qwen\) \| qwen: .*401/);
    expect(svc.fallbackStats().failed).toBe(0);
    await svc.text('y');
    expect(hasEnv(1)).toBe(false);
  });

  it('событие: provider qwen, fallback false', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    await new ClaudeCliService(pg as any).text('x', { model: 'claude-opus-5-5', provider: 'qwen' });
    expect(JSON.parse(pg.query.mock.calls[0][1][0])).toMatchObject({ provider: 'qwen', fallback: false, model: 'qwen3.8-max' });
  });
});
```

- [ ] **Step 2: Коммит, прогон — красный** (`src/common/services/claude-cli.forced-qwen`).

- [ ] **Step 3: Опция** — в `ClaudeCliOptions` после `noFallback?: boolean;`:

```ts
  /** Выбор пользователя в админке (UserLlmProviderService): 'qwen' — вызов
   *  сразу на Qwen, без попытки Claude. Не авария: окно предохранителя и
   *  fallbackStats не трогаются. Без ключа и при noFallback — обычный Claude. */
  provider?: 'qwen';
```

- [ ] **Step 4: Флаг `fallback` в событии.** `trackCallEvent` — параметр `fallback: boolean` и в JSON `fallback: opts.fallback` (вместо `opts.provider === 'qwen'`). `runOnce(prompt, opts, qwen, fallback: boolean = qwen !== null)` передаёт `fallback` пятым аргументом в `spawnClaude`, `spawnClaude(…, qwen, fallback: boolean)` — в оба вызова `trackCallEvent({ …, provider, fallback })`. Существующие вызовы `runOnce(prompt, opts, null)` и `runOnce(prompt, opts, qwen)` не меняются (значение по умолчанию сохраняет прежний смысл).

- [ ] **Step 5: `runRaw` и `runForcedQwen`.** В начале `runRaw`, сразу после `const qwen = opts.noFallback ? null : readQwenFallbackConfig();`:

```ts
    // Выбор пользователя (админка): ответы сразу через Qwen, без попытки Claude.
    if (opts.provider === 'qwen') {
      if (qwen) return this.runForcedQwen(prompt, opts, qwen);
      if (!opts.noFallback) {
        this.logger.warn('Qwen выбран для пользователя, но ключ QWEN_FALLBACK_API_KEY не задан — вызов идёт на Claude');
      }
    }
```

Новый метод рядом с `runOnQwen`:

```ts
  /** Принудительный Qwen (выбор пользователя): окно предохранителя и
   *  fallbackStats не трогаются — это не авария, а выбор. */
  private async runForcedQwen(
    prompt: string,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig,
  ): Promise<CliRunResult> {
    try {
      return await this.runOnce(prompt, opts, qwen, false);
    } catch (qe: any) {
      const qmsg = String(qe?.message ?? qe);
      this.logger.error(`Qwen (выбран для пользователя) упал: ${qmsg.slice(0, 200)}`);
      throw new Error(`claude CLI не вызывался (выбран Qwen) | qwen: ${qmsg}`);
    }
  }
```

- [ ] **Step 6: Коммит, прогон — зелёный:** `src/common/services` целиком (все прежние спеки CLI — тоже), tsc.

---

### Task 4: бэкенд следует выбору — Маша, релей, TG

**Files:**
- Create: `src/chat/answer-provider.ts`, `src/chat/answer-provider.spec.ts`
- Modify: `src/chat/chat.service.ts`, `src/tg-bot/tg-router.service.ts`, `src/tg-bot/tg-router.model.spec.ts`

- [ ] **Step 1: Падающий тест чистых функций** — `src/chat/answer-provider.spec.ts`:

```ts
import { readDoneProvider, relayProviderFields, resolveAnswerProvider } from './answer-provider';

describe('resolveAnswerProvider', () => {
  const svc = (p: 'claude' | 'qwen') => ({ get: jest.fn(async () => p) });

  it('выбор пользователя', async () => {
    expect(await resolveAnswerProvider(false, 'u1', svc('qwen') as any)).toBe('qwen');
  });
  it('проба — всегда claude, настройку не читает', async () => {
    const s = svc('qwen');
    expect(await resolveAnswerProvider(true, 'u1', s as any)).toBe('claude');
    expect(s.get).not.toHaveBeenCalled();
  });
  it('нет сервиса или userId — claude', async () => {
    expect(await resolveAnswerProvider(false, 'u1', undefined)).toBe('claude');
    expect(await resolveAnswerProvider(false, '', svc('qwen') as any)).toBe('claude');
  });
});

describe('relayProviderFields', () => {
  it('проба — noFallback', () => expect(relayProviderFields(true, 'qwen')).toEqual({ noFallback: '1' }));
  it('qwen — provider', () => expect(relayProviderFields(false, 'qwen')).toEqual({ provider: 'qwen' }));
  it('claude — ничего', () => expect(relayProviderFields(false, 'claude')).toEqual({}));
});

describe('readDoneProvider', () => {
  it('новый релей', () => {
    expect(readDoneProvider({ type: 'done', provider: 'qwen', fallback: true })).toEqual({ provider: 'qwen', fallback: true });
  });
  it('старый релей — пусто', () => {
    expect(readDoneProvider({ type: 'done' })).toEqual({ provider: undefined, fallback: false });
  });
  it('мусор — пусто', () => {
    expect(readDoneProvider({ type: 'done', provider: 'gpt', fallback: 'yes' })).toEqual({ provider: undefined, fallback: false });
  });
});
```

- [ ] **Step 2: Коммит, прогон — красный** (`src/chat/answer-provider`).

- [ ] **Step 3: `src/chat/answer-provider.ts`**

```ts
import type { LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Через какую модель отвечать человеку (spec 2026-10-30-llm-provider-switch).
 * Пробы мониторинга — всегда Claude: они меряют его, а не настройку.
 */
export async function resolveAnswerProvider(
  probe: boolean,
  userId: string | null | undefined,
  svc?: Pick<UserLlmProviderService, 'get'>,
): Promise<LlmProvider> {
  if (probe || !svc || !userId) return 'claude';
  return svc.get(userId);
}

/** Поля формы запроса к релею: проба — только Claude, выбор «Qwen» — provider. */
export function relayProviderFields(probe: boolean, provider: LlmProvider): Record<string, string> {
  if (probe) return { noFallback: '1' };
  return provider === 'qwen' ? { provider: 'qwen' } : {};
}

/** Чем ответил релей — из события done (старый релей полей не шлёт). */
export function readDoneProvider(ev: any): { provider?: LlmProvider; fallback: boolean } {
  const provider = ev?.provider === 'qwen' || ev?.provider === 'claude' ? ev.provider : undefined;
  return { provider, fallback: ev?.fallback === true };
}
```

- [ ] **Step 4: Коммит, прогон — зелёный.**

- [ ] **Step 5: `chat.service.ts` — зависимость.** Импорты:

```ts
import { UserLlmProviderService } from '../common/services/user-llm-provider.service';
import { readDoneProvider, relayProviderFields, resolveAnswerProvider } from './answer-provider';
```

В конструктор — ПОСЛЕДНИМ параметром (после `productActions`), по правилу файла:

```ts
    // Модель ответов человека (админка, spec 2026-10-30-llm-provider-switch).
    // Последним и @Optional по той же причине, что chatFiles.
    @Optional() private readonly llmProvider?: UserLlmProviderService,
```

- [ ] **Step 6: Маша.** В вызове `this.claudeCli.textWithCost(fullPrompt, { … })` Маши (тот, где `model: probe ? PROBE_MODEL : CHAT_MODEL,` и следом `noFallback: probe,`) — перед вызовом:

```ts
        const mashaProvider = await resolveAnswerProvider(probe, userId, this.llmProvider);
```

и в объект опций, сразу после `noFallback: probe,`:

```ts
          ...(mashaProvider === 'qwen' ? { provider: 'qwen' as const } : {}),
```

- [ ] **Step 7: Релей — запрос.** В `streamUniversalAgent` перед строкой `let turnFailed = false;` (единственная в файле):

```ts
    // Модель ответов человека: 'qwen' — релей сразу идёт в Qwen; проба — только Claude.
    const answerProvider = await resolveAnswerProvider(probe, userId, this.llmProvider);
```

После строки `fd.append('model', probe ? PROBE_MODEL : CHAT_MODEL);`:

```ts
        for (const [k, v] of Object.entries(relayProviderFields(probe, answerProvider))) fd.append(k, v);
```

- [ ] **Step 8: Релей — ответ.** Рядом с `let failReason = '';` (та, что над `// Single persistence point`):

```ts
    // Чем ответил релей (done.provider/fallback) — в chat_quality.
    let turnProvider: 'claude' | 'qwen' | undefined;
    let turnFallback = false;
```

В ветке `} else if (ev.type === 'done') {` (та, где `agentCostUsd += ev.costUsd`), первой строкой ветки:

```ts
                    ({ provider: turnProvider, fallback: turnFallback } = readDoneProvider(ev));
```

В `props` события `chat_quality`, где `fail_reason: failReason || undefined,` — следом:

```ts
            provider: turnProvider,
            fallback: turnFallback || undefined,
```

Второй путь релея (`generateAgentReply`, пробы качества) не трогать: он меряет ответы как есть, запасной путь релея там работает по умолчанию.

- [ ] **Step 9: TG-бот.** `src/tg-bot/tg-router.service.ts`: импорты `UserLlmProviderService` и `resolveAnswerProvider` (`../chat/answer-provider`); в конструктор последним параметром `@Optional() private readonly llmProvider?: UserLlmProviderService,` (импорт `Optional` из `@nestjs/common`, если ещё нет). Перед основным вызовом `const { text, costUsd } = await this.claudeCli.textWithCost(userPrompt, {`:

```ts
    // Модель ответов владельца бота (админка, spec 2026-10-30-llm-provider-switch).
    const ownerProvider = await resolveAnswerProvider(false, cfg.owner_user_id, this.llmProvider);
```

в объект опций после `model: CHAT_MODEL,`:

```ts
      ...(ownerProvider === 'qwen' ? { provider: 'qwen' as const } : {}),
```

Вызов-привратник (`claudeCli.text(gatePrompt, …)`) не трогать.

- [ ] **Step 10: Тест TG** — в `src/tg-bot/tg-router.model.spec.ts` в конец `describe`:

```ts
  it('владелец выбрал Qwen — основной ход с provider: qwen', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { get: jest.fn(async () => 'qwen') };
    await svc.generateReply({ ...cfg, owner_user_id: '79030169187' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('qwen');
  });

  it('без выбора — provider не задан', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { get: jest.fn(async () => 'claude') };
    await svc.generateReply({ ...cfg, owner_user_id: '79030169187' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBeUndefined();
  });
```

Если `generateReply` с заданным `owner_user_id` тянет зависимости, которых нет в `makeRouter` (neo4j, продукты, справка), — замокать их `jest.spyOn(svc as any, '<метод>')` так же, как в файле уже замоканы `resolveSystemPrompt` и `loadHistory`; само утверждение не менять.

- [ ] **Step 11: Коммит, прогон:** `src/chat src/tg-bot src/common` — не хуже базы Task 0 + новые тесты; tsc — `TSC_OK`.

---

### Task 5: мониторинг — релей на запасном Qwen

**Files:**
- Create: `src/monitoring/relay-qwen-monitor.service.ts`, `src/monitoring/relay-qwen-monitor.service.spec.ts`
- Modify: `src/monitoring/monitoring.module.ts`

- [ ] **Step 1: Падающий тест**

```ts
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({ sendTelegramPayload: jest.fn(async () => undefined) }));
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { RelayQwenMonitorService, relayFallbackAlertText, relayFallbackVerdict } from './relay-qwen-monitor.service';

const get = (axios as any).get as jest.Mock;
const send = sendTelegramPayload as unknown as jest.Mock;
const NOW = 10_000_000;
const q = (o: any) => ({ status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0, ...o } });

describe('relayFallbackVerdict', () => {
  it('старый релей или нет ответа — unknown', () => {
    expect(relayFallbackVerdict({ status: 'ok' }, NOW)).toBe('unknown');
    expect(relayFallbackVerdict(null, NOW)).toBe('unknown');
  });
  it('окно открыто — active', () => expect(relayFallbackVerdict(q({ breakerOpenUntil: NOW + 1 }), NOW)).toBe('active'));
  it('были аварийные ходы за окно — active', () => expect(relayFallbackVerdict(q({ ok: 2 }), NOW)).toBe('active'));
  it('тихо — idle', () => expect(relayFallbackVerdict(q({}), NOW)).toBe('idle'));
});

it('текст алерта — со счётчиками и минутами окна', () => {
  const t = relayFallbackAlertText(q({ ok: 5, failed: 1 }).qwen);
  expect(t).toContain('ответов 5, ошибок 1');
  expect(t).toContain('за 15 мин');
});

describe('RelayQwenMonitorService.check', () => {
  const OLD = { tok: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  let alerted: boolean;
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.startsWith('SELECT alerted')) return { rows: alerted ? [{ alerted: true }] : [] };
      alerted = params?.[1] === true;
      return { rows: [] };
    }),
  };
  beforeEach(() => {
    alerted = false; get.mockReset(); send.mockClear(); pg.query.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = 't'; process.env.TELEGRAM_CHAT_ID = 'c';
  });
  afterAll(() => { process.env.TELEGRAM_BOT_TOKEN = OLD.tok; process.env.TELEGRAM_CHAT_ID = OLD.chat; });

  it('active впервые — алерт и отметка', async () => {
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('active');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toContain('Релей: Claude недоступен');
    expect(alerted).toBe(true);
  });
  it('active повторно — без повтора алерта', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    await new RelayQwenMonitorService(pg as any).check(NOW);
    expect(send).not.toHaveBeenCalled();
  });
  it('idle после алерта — отбой', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({}) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('idle');
    expect(send.mock.calls[0][0].text).toContain('Claude снова отвечает');
    expect(alerted).toBe(false);
  });
  it('/health недоступен — ничего не шлёт', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Коммит, прогон — красный** (`src/monitoring/relay-qwen-monitor`).

- [ ] **Step 3: Сервис**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { sendTelegramPayload } from '../common/telegram-alert';

/** Поле qwen в /health релея (relay-agent/qwen-provider.mjs, stats()). */
export interface RelayQwenHealth {
  enabled: boolean;
  ok: number;
  failed: number;
  windowMs: number;
  breakerOpenUntil: number;
}

/**
 * active — релей сейчас отвечает через запасной Qwen (окно открыто или были
 * аварийные ходы за окно статистики); idle — нет; unknown — /health не ответил
 * или релей старый (поля qwen нет). Принудительные ходы (выбор пользователя)
 * релей в эти счётчики не пишет.
 */
export function relayFallbackVerdict(health: any, now: number = Date.now()): 'active' | 'idle' | 'unknown' {
  const qw = health?.qwen;
  if (!qw || typeof qw !== 'object') return 'unknown';
  if (Number(qw.breakerOpenUntil) > now) return 'active';
  if (Number(qw.ok) + Number(qw.failed) > 0) return 'active';
  return 'idle';
}

export function relayFallbackAlertText(qw: RelayQwenHealth): string {
  const mins = Math.round((Number(qw.windowMs) || 900_000) / 60_000);
  return `<b>🟠 Релей: Claude недоступен — ассистенты отвечают через запасной Qwen</b>\n` +
    `Qwen за ${mins} мин: ответов ${qw.ok}, ошибок ${qw.failed}.\n` +
    `Починка: на релее \`claude\` → /login, либо ждать сброса лимита подписки.`;
}

const COMPONENT = 'relay_qwen_fallback';

/**
 * Запасной Qwen на релее не должен прятать сбой Claude: раз в 15 минут читаем
 * /health релея и шлём алерт в начале аварийного режима и отбой в конце
 * (spec 2026-10-30-llm-provider-switch, «Мониторинг»). Антиповтор — та же
 * таблица monitor_alert_state, что у алерта CLI.
 */
@Injectable()
export class RelayQwenMonitorService {
  private readonly log = new Logger(RelayQwenMonitorService.name);

  constructor(private readonly pg: PgService) {}

  @Cron('30 */15 * * * *')
  async tick(): Promise<void> {
    await this.check();
  }

  async check(now: number = Date.now()): Promise<'active' | 'idle' | 'unknown'> {
    const base = (process.env.AGENT_URL || 'https://r.linkeon.io').replace(/\/+$/, '');
    let health: any = null;
    try {
      health = (await axios.get(`${base}/health`, { timeout: 10_000 })).data;
    } catch (e: any) {
      this.log.warn(`relay /health недоступен: ${e?.message}`);
    }
    const verdict = relayFallbackVerdict(health, now);
    if (verdict === 'unknown') return verdict;
    const alerted = await this.getAlerted();
    if (verdict === 'active' && !alerted) {
      await this.send(relayFallbackAlertText(health.qwen));
      await this.setAlerted(true);
      this.log.error('relay: Claude недоступен, ходы идут через запасной Qwen — алерт отправлен');
    } else if (verdict === 'idle' && alerted) {
      await this.send('<b>🟢 Релей: Claude снова отвечает</b>\nЗапасной Qwen за последние 15 мин не понадобился.');
      await this.setAlerted(false);
      this.log.warn('relay: запасной Qwen больше не нужен — отбой отправлен');
    }
    return verdict;
  }

  private async getAlerted(): Promise<boolean> {
    try {
      const r = await this.pg.query('SELECT alerted FROM monitor_alert_state WHERE component=$1', [COMPONENT]);
      return r.rows[0]?.alerted === true;
    } catch { return false; }
  }

  private async setAlerted(alerted: boolean): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO monitor_alert_state (component, alerted, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (component) DO UPDATE SET alerted=$2, updated_at=now()`,
        [COMPONENT, alerted],
      );
    } catch (e: any) { this.log.error(`setAlerted(${COMPONENT}) failed: ${e.message}`); }
  }

  private async send(text: string): Promise<void> {
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) { this.log.warn(`relay qwen alert (no Telegram creds): ${text.replace(/<[^>]+>/g, '')}`); return; }
    try {
      await sendTelegramPayload({ chat_id: TG_CHAT, parse_mode: 'HTML', text }, { timeout: 8000 });
    } catch (e: any) {
      this.log.error(`relay qwen Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }
}
```

- [ ] **Step 4: Регистрация** — `src/monitoring/monitoring.module.ts`: импорт и `RelayQwenMonitorService` в конец `providers`.

- [ ] **Step 5: Коммит, прогон — зелёный** (`src/monitoring`), tsc.

---

### Task 6: релей — модуль `qwen-provider.mjs`

**Files:**
- Create: `relay-agent/qwen-provider.mjs`, `relay-agent/qwen-provider.test.mjs`

- [ ] **Step 1: Падающий тест** — `relay-agent/qwen-provider.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as q from "./qwen-provider.mjs";

const MODELS = { opus: "qwen3.8-max", sonnet: "qwen3.8-flash", haiku: "qwen3.6-flash" };
const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

test("readQwenConfig: нет файла или пустой — null", () => {
  assert.equal(q.readQwenConfig({}, missing), null);
  assert.equal(q.readQwenConfig({}, () => "  \n"), null);
});

test("readQwenConfig: значения по умолчанию, ключ без пробелов, путь по умолчанию", () => {
  let asked;
  const cfg = q.readQwenConfig({}, (p) => { asked = p; return " sk-sp-x \n"; });
  assert.equal(asked, q.QWEN_DEFAULT_KEY_FILE);
  assert.deepEqual(cfg, { apiKey: "sk-sp-x", baseUrl: q.QWEN_DEFAULT_BASE_URL, models: MODELS, breakerMs: 300000 });
});

test("readQwenConfig: путь и переопределения из env", () => {
  let asked;
  const cfg = q.readQwenConfig({
    QWEN_KEY_FILE: "/k", QWEN_FALLBACK_BASE_URL: "https://x/apps/anthropic",
    QWEN_FALLBACK_MODEL_OPUS: "m", QWEN_FALLBACK_BREAKER_MS: "0",
  }, (p) => { asked = p; return "k"; });
  assert.equal(asked, "/k");
  assert.equal(cfg.baseUrl, "https://x/apps/anthropic");
  assert.equal(cfg.models.opus, "m");
  assert.equal(cfg.breakerMs, 0);
  assert.equal(q.readQwenConfig({ QWEN_FALLBACK_BREAKER_MS: "abc" }, () => "k").breakerMs, 300000);
});

test("qwenModelFor", () => {
  for (const [req, want] of [["default", "qwen3.8-max"], ["opus", "qwen3.8-max"], ["claude-opus-5-5", "qwen3.8-max"],
    ["sonnet", "qwen3.8-flash"], ["claude-sonnet-5", "qwen3.8-flash"], ["haiku", "qwen3.6-flash"], ["Claude-Haiku-4-5", "qwen3.6-flash"]]) {
    assert.equal(q.qwenModelFor(req, MODELS), want, req);
  }
});

test("withModel: меняет только значение --model, исходный массив цел", () => {
  const args = ["--print", "--model", "default", "--max-turns", "40"];
  assert.deepEqual(q.withModel(args, "qwen3.8-max"), ["--print", "--model", "qwen3.8-max", "--max-turns", "40"]);
  assert.equal(args[2], "default");
});

test("qwenSpawnEnv: снимает ANTHROPIC_* и OAuth-токен, ставит Alibaba", () => {
  const cfg = q.readQwenConfig({}, () => "sk-sp-x");
  const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "old", CLAUDE_CODE_OAUTH_TOKEN: "o" };
  const env = q.qwenSpawnEnv(base, cfg);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, q.QWEN_DEFAULT_BASE_URL);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-sp-x");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen3.6-flash");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.API_TIMEOUT_MS, "300000");
  assert.equal(base.ANTHROPIC_API_KEY, "old");
});

test("looksLikeCliRefusal", () => {
  for (const t of ["Not logged in · Please run /login", "You've hit your session limit · resets 3am (UTC)",
    "You’ve hit your limit · resets 3am", "Claude AI usage limit reached|1730000000", "OAuth token has expired"]) {
    assert.equal(q.looksLikeCliRefusal(t), true, t);
  }
  for (const t of ["Это значит, что ключ неверный: Invalid API key", "Invalid API key — так ответил сервис",
    "Ответ: hit your usage limit", "x".repeat(301) + " Not logged in", ""]) {
    assert.equal(q.looksLikeCliRefusal(t), false, t.slice(0, 40));
  }
});

test("isAccessFailure", () => {
  assert.equal(q.isAccessFailure("Not logged in · Please run /login"), true);
  assert.equal(q.isAccessFailure("API Error: 429 Too Many Requests", { isError: true }), true);
  assert.equal(q.isAccessFailure("boom", { isError: true, apiStatus: 529 }), true);
  assert.equal(q.isAccessFailure("API Error: 401 Unauthorized", { isError: true }), true);
  assert.equal(q.isAccessFailure("API Error: 429", { isError: false }), false);
  assert.equal(q.isAccessFailure("Prompt is too long: 250000 tokens", { isError: true, apiStatus: 400 }), false);
  assert.equal(q.isAccessFailure("Context window exceeded · try again", { isError: true }), false);
  assert.equal(q.isAccessFailure("обычный ответ ассистента"), false);
});

test("pickProvider", () => {
  const cfg = { apiKey: "k" };
  assert.equal(q.pickProvider({ forced: true, cfg, breakerOpen: false, noFallback: false }), "qwen");
  assert.equal(q.pickProvider({ forced: false, cfg, breakerOpen: true, noFallback: false }), "qwen");
  assert.equal(q.pickProvider({ forced: false, cfg, breakerOpen: false, noFallback: false }), "claude");
  assert.equal(q.pickProvider({ forced: true, cfg: null, breakerOpen: true, noFallback: false }), "claude");
  assert.equal(q.pickProvider({ forced: true, cfg, breakerOpen: true, noFallback: true }), "claude");
});

test("mayFallback", () => {
  const ok = { provider: "claude", cfg: { apiKey: "k" }, noFallback: false, sentAnyText: false, riskyToolUsed: false };
  assert.equal(q.mayFallback(ok), true);
  assert.equal(q.mayFallback({ ...ok, provider: "qwen" }), false);
  assert.equal(q.mayFallback({ ...ok, cfg: null }), false);
  assert.equal(q.mayFallback({ ...ok, noFallback: true }), false);
  assert.equal(q.mayFallback({ ...ok, sentAnyText: true }), false);
  assert.equal(q.mayFallback({ ...ok, riskyToolUsed: true }), false);
});

test("SIDE_EFFECT_FREE_TOOLS", () => {
  for (const t of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]) assert.equal(q.SIDE_EFFECT_FREE_TOOLS.has(t), true);
  for (const t of ["Bash", "Write", "mcp__linkeon__generate_image", "mcp__products__manage_product"]) assert.equal(q.SIDE_EFFECT_FREE_TOOLS.has(t), false);
});

test("createQwenBreaker: открытие, закрытие, статистика", () => {
  const b = q.createQwenBreaker();
  assert.equal(b.isOpen(1000), false);
  b.open(60000, 1000);
  assert.equal(b.isOpen(2000), true);
  b.claudeSucceeded(500); // ход начат до открытия — окно не закрывает
  assert.equal(b.isOpen(2000), true);
  b.claudeSucceeded(1500); // после открытия — закрывает
  assert.equal(b.isOpen(2000), false);
  b.open(60000, 3000);
  b.qwenFinished(true, 4000);
  assert.equal(b.isOpen(5000), true);
  b.qwenFinished(false, 5000); // сбой Qwen закрывает окно
  assert.equal(b.isOpen(5001), false);
  assert.deepEqual(b.stats(6000), { ok: 1, failed: 1, windowMs: q.QWEN_STATS_WINDOW_MS, breakerOpenUntil: 0 });
  assert.deepEqual(b.stats(6000 + q.QWEN_STATS_WINDOW_MS), { ok: 0, failed: 0, windowMs: q.QWEN_STATS_WINDOW_MS, breakerOpenUntil: 0 });
});
```

- [ ] **Step 2: Коммит, прогон — красный**

```bash
cd ~/Downloads/spirits_back/.worktrees/llm-provider-switch
git add relay-agent/qwen-provider.test.mjs
git commit -q -m "test: релей — qwen-provider (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q && SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/llm-switch-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && cd relay-agent && node --test qwen-provider.test.mjs 2>&1 | tail -6"
```

Expected: FAIL — `Cannot find module …/qwen-provider.mjs`.

- [ ] **Step 3: Модуль** — `relay-agent/qwen-provider.mjs`:

```js
// Qwen на релее: принудительный (выбор пользователя в админке бэкенда) и
// запасной (сбой доступа к Claude). Тот же claude и те же аргументы — другие
// модель и окружение процесса. Спецификация — spirits_back
// docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md. Те же правила,
// что у бэкенда (src/common/services/qwen-fallback.ts, src/common/llm-error.ts):
// меняешь здесь — сверь там.
import fs from "node:fs";

export const QWEN_DEFAULT_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
export const QWEN_DEFAULT_MODELS = Object.freeze({ opus: "qwen3.8-max", sonnet: "qwen3.8-flash", haiku: "qwen3.6-flash" });
// Ключ — файлом (600): читается на каждом ходе, сменить можно без рестарта;
// нет файла — Qwen на релее выключен целиком.
export const QWEN_DEFAULT_KEY_FILE = "/home/dv/file-agent/secrets/qwen.key";
export const QWEN_DEFAULT_BREAKER_MS = 5 * 60_000;
export const QWEN_STATS_WINDOW_MS = 15 * 60_000;
// После этих инструментов ход можно переиграть на Qwen: последствий нет.
export const SIDE_EFFECT_FREE_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

const trimmed = (v) => (v ?? "").toString().trim();

export function readQwenConfig(env = process.env, readFile = (p) => fs.readFileSync(p, "utf8")) {
  let apiKey = "";
  try { apiKey = trimmed(readFile(trimmed(env.QWEN_KEY_FILE) || QWEN_DEFAULT_KEY_FILE)); } catch { return null; }
  if (!apiKey) return null;
  const breakerRaw = trimmed(env.QWEN_FALLBACK_BREAKER_MS);
  const breaker = Number(breakerRaw);
  return {
    apiKey,
    baseUrl: trimmed(env.QWEN_FALLBACK_BASE_URL) || QWEN_DEFAULT_BASE_URL,
    models: {
      opus: trimmed(env.QWEN_FALLBACK_MODEL_OPUS) || QWEN_DEFAULT_MODELS.opus,
      sonnet: trimmed(env.QWEN_FALLBACK_MODEL_SONNET) || QWEN_DEFAULT_MODELS.sonnet,
      haiku: trimmed(env.QWEN_FALLBACK_MODEL_HAIKU) || QWEN_DEFAULT_MODELS.haiku,
    },
    breakerMs: breakerRaw !== "" && Number.isFinite(breaker) && breaker >= 0 ? breaker : QWEN_DEFAULT_BREAKER_MS,
  };
}

export function qwenModelFor(requested, models) {
  const m = trimmed(requested).toLowerCase();
  if (m === "haiku" || m.startsWith("claude-haiku")) return models.haiku;
  if (m === "sonnet" || m.startsWith("claude-sonnet")) return models.sonnet;
  return models.opus;
}

export function withModel(args, model) {
  const out = [...args];
  const i = out.indexOf("--model");
  if (i >= 0 && i + 1 < out.length) out[i + 1] = model;
  return out;
}

// Ключ — в ANTHROPIC_AUTH_TOKEN: ANTHROPIC_API_KEY живой OAuth не перебивает.
// MAX_RETRIES=1: без него на 401 CLI повторяет 11 раз с нарастающей паузой.
export function qwenSpawnEnv(base, cfg) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("ANTHROPIC_") || k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    env[k] = v;
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.models.haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: cfg.models.opus,
    CLAUDE_CODE_MAX_RETRIES: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "300000",
  };
}

// Отказ CLI обычным ответом — по правилам looksLikeCliRefusal бэкенда: фраза в
// начале текста, не длиннее 300 символов, без кириллицы. Ложное срабатывание
// открыло бы окно для всех веб-чатов. Уведомление одного хода по-прежнему
// решает FATAL_RE в server.mjs.
const CLI_REFUSAL_RE = /^(?:Not logged in|Please run \/login|(?:You['’]ve |You have )?hit your (?:\w+ )?limit|Invalid API key|Credit balance is too low|OAuth token (?:has )?expired|Claude AI usage limit reached)/i;
const CONTEXT_LENGTH_RE = /context (window|length|limit)|prompt is too long|output token|max_tokens/i;
const ACCESS_STATUS = new Set([401, 403, 429, 529]);
const ACCESS_TEXT_RE = /\b(401|403|429|529)\b|Unauthorized|Forbidden|rate.?limit|overloaded/i;

export function looksLikeCliRefusal(text) {
  const t = trimmed(text);
  return !!t && t.length <= 300 && !/[а-яё]/i.test(t) && CLI_REFUSAL_RE.test(t);
}

// Сбой доступа к Claude: отказ CLI или ошибка со статусом входа/лимита/перегрузки.
export function isAccessFailure(text, { isError = false, apiStatus } = {}) {
  const t = trimmed(text);
  if (CONTEXT_LENGTH_RE.test(t)) return false;
  if (looksLikeCliRefusal(t)) return true;
  if (!isError) return false;
  return ACCESS_STATUS.has(Number(apiStatus)) || ACCESS_TEXT_RE.test(t);
}

export function pickProvider({ forced, cfg, breakerOpen, noFallback }) {
  if (!cfg || noFallback) return "claude";
  if (forced) return "qwen";
  return breakerOpen ? "qwen" : "claude";
}

export function mayFallback({ provider, cfg, noFallback, sentAnyText, riskyToolUsed }) {
  return provider === "claude" && !!cfg && !noFallback && !sentAnyText && !riskyToolUsed;
}

// Окно запасного Qwen на весь процесс: после сбоя доступа к Claude ходы идут
// сразу на Qwen. Закрывается успехом Claude, начатым после открытия окна, и
// любым сбоем аварийного хода на Qwen. Статистика — только аварийные ходы.
export function createQwenBreaker() {
  let openUntil = 0;
  let openedAt = 0;
  let outcomes = [];
  const prune = (now) => { outcomes = outcomes.filter((o) => o.at >= now - QWEN_STATS_WINDOW_MS); };
  return {
    isOpen: (now = Date.now()) => now < openUntil,
    open(ms, now = Date.now()) { openedAt = now; openUntil = now + ms; },
    claudeSucceeded(startedAt) { if (startedAt >= openedAt) openUntil = 0; },
    qwenFinished(ok, now = Date.now()) {
      outcomes.push({ at: now, ok });
      prune(now);
      if (!ok) openUntil = 0;
    },
    stats(now = Date.now()) {
      prune(now);
      const ok = outcomes.filter((o) => o.ok).length;
      return { ok, failed: outcomes.length - ok, windowMs: QWEN_STATS_WINDOW_MS, breakerOpenUntil: openUntil > now ? openUntil : 0 };
    },
  };
}
```

- [ ] **Step 4: Коммит, прогон — зелёный** (`node --test qwen-provider.test.mjs`: все `# pass`, `# fail 0`).

---

### Task 7: релей — врезка в `server.mjs` (копия в main)

**Files:**
- Create: `relay-agent/qwen-patch.py`
- Modify: `relay-agent/server.mjs` (только запуском скрипта)

- [ ] **Step 1: Скрипт врезки** — `relay-agent/qwen-patch.py`. Один и тот же для копии в main и живого релея (Task 8); каждый якорь обязан встретиться ровно один раз, иначе скрипт падает, ничего не записав.

```python
#!/usr/bin/env python3
"""Врезка Qwen в relay server.mjs (spec spirits_back
docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md).
Одна и та же для копии relay-agent/ в main и живого релея: каждый якорь
обязан встретиться ровно один раз, иначе — выход без записи.
Запуск: python3 qwen-patch.py <путь к server.mjs>"""
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()
if "qwen-provider.mjs" in s:
    sys.exit("уже пропатчено")


def rep(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {old[:90]!r}")
    s = s.replace(old, new)


# 1. Импорт модуля и окно предохранителя на весь процесс.
rep('import express from "express";\n',
    'import express from "express";\n'
    'import * as qwen from "./qwen-provider.mjs";\n')
rep('const sweepRuns = () => reap(finishedRun(liveRuns)).then(logReaped, () => {});\n',
    'const sweepRuns = () => reap(finishedRun(liveRuns)).then(logReaped, () => {});\n'
    '// Окно запасного Qwen и исходы аварийных ходов на нём — на весь процесс\n'
    '// (qwen-provider.mjs; spec spirits_back 2026-10-30-llm-provider-switch).\n'
    'const qwenBreaker = qwen.createQwenBreaker();\n')

# 2. Провайдер хода.
rep('  const reqModel = MODELS.includes(String(req.body.model || "")) ? String(req.body.model) : "default";\n',
    '  const reqModel = MODELS.includes(String(req.body.model || "")) ? String(req.body.model) : "default";\n'
    '  // Qwen: принудительный (provider=qwen — выбор пользователя в админке бэкенда)\n'
    '  // и запасной (сбой доступа к Claude). Ключ — файлом, читается на каждом ходе:\n'
    '  // нет файла — Qwen выключен. noFallback=1 — пробы мониторинга, только Claude.\n'
    '  const qwenCfg = qwen.readQwenConfig();\n'
    '  const qwenForced = String(req.body.provider || "") === "qwen";\n'
    '  const reqNoFallback = String(req.body.noFallback || "") === "1";\n'
    '  if (qwenForced && !qwenCfg) console.warn("[qwen] provider=qwen, но ключа нет — ход на Claude");\n'
    '  let provider = qwen.pickProvider({ forced: qwenForced, cfg: qwenCfg, breakerOpen: qwenBreaker.isOpen(), noFallback: reqNoFallback });\n'
    '  // Аварийный ход на Qwen: через открытое окно или после сбоя Claude в этом ходе.\n'
    '  let usedFallback = provider === "qwen" && !qwenForced;\n'
    '  // Инструмент с последствиями в этом ходе — после него на Qwen не переигрываем.\n'
    '  let riskyToolUsed = false;\n')

# 3. runOnce: провайдер запуска — модель и окружение.
rep('  function runOnce(useResume) {\n',
    '  function runOnce(useResume, runProvider = provider) {\n')
rep('      const runArgs = resumeSid ? [...args, "--resume", resumeSid] : args;\n',
    '      const baseArgs = runProvider === "qwen" ? qwen.withModel(args, qwen.qwenModelFor(reqModel, qwenCfg.models)) : args;\n'
    '      const runArgs = resumeSid ? [...baseArgs, "--resume", resumeSid] : baseArgs;\n'
    '      const runStartedAt = Date.now();\n')
rep('...process.env, MCP_TIMEOUT: "120000"',
    '...(runProvider === "qwen" ? qwen.qwenSpawnEnv(process.env, qwenCfg) : process.env), MCP_TIMEOUT: "120000"')
rep('      let imageLimitHit = false;\n',
    '      let imageLimitHit = false;\n'
    '      let accessFailHit = false;\n'
    '      let transientAccessLike = false;\n'
    '      let sawResult = false;\n')

# 4. Инструмент с последствиями.
rep('taleridWriteUsed = true;',
    'taleridWriteUsed = true;\n'
    '              if (!qwen.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;')

# 5. result: отказ CLI → Qwen; ошибка доступа — признак для решения после повтора.
rep('          if (FATAL_RE.test(ev.result)) {\n',
    '          // Отказ CLI до первого текста и без инструментов с последствиями — ход\n'
    '          // переигрывается на Qwen, уведомление не шлём. Ошибка доступа со статусом\n'
    '          // — признак для решения после штатного повтора (transientHit ниже).\n'
    '          if (runProvider === "claude" && qwen.looksLikeCliRefusal(ev.result) &&\n'
    '              qwen.mayFallback({ provider: runProvider, cfg: qwenCfg, noFallback: reqNoFallback, sentAnyText: streamedAny, riskyToolUsed })) {\n'
    '            accessFailHit = true;\n'
    '            return;\n'
    '          }\n'
    '          if (runProvider === "claude" && isErrorResult && qwen.isAccessFailure(ev.result, { isError: true, apiStatus: ev.api_error_status })) {\n'
    '            transientAccessLike = true;\n'
    '          }\n'
    '          if (FATAL_RE.test(ev.result)) {\n')
rep('          if (!clientDisconnected) res.write("data: " + JSON.stringify({ type: "result", text: ev.result }) + "\\n\\n");\n',
    '          sawResult = true;\n'
    '          if (!clientDisconnected) res.write("data: " + JSON.stringify({ type: "result", text: ev.result }) + "\\n\\n");\n')
rep('resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit });',
    'resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, accessFailHit, transientAccessLike, sawResult, startedAt: runStartedAt });')

# 6. Внешний цикл: переигровка на Qwen.
rep('    let r = await runOnce(useResume);\n',
    '    // Ход на Qwen после сбоя доступа к Claude: окно открывается, тот же ход\n'
    '    // (тот же --resume — беседа продолжается между провайдерами) идёт на Qwen.\n'
    '    const fallbackToQwen = (why) => {\n'
    '      qwenBreaker.open(qwenCfg.breakerMs);\n'
    '      console.warn("[qwen] " + sessionId + ": Claude недоступен (" + why + ") → запасной Qwen " + qwen.qwenModelFor(reqModel, qwenCfg.models));\n'
    '      provider = "qwen";\n'
    '      usedFallback = true;\n'
    '      return runOnce(useResume, "qwen");\n'
    '    };\n'
    '    let r = await runOnce(useResume);\n')
rep('    if (r.imageLimitHit) {\n',
    '    if (r.accessFailHit) r = await fallbackToQwen("отказ CLI");\n\n'
    '    if (r.imageLimitHit) {\n')
rep('        notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n',
    '        if (provider === "claude" && r.transientAccessLike &&\n'
    '            qwen.mayFallback({ provider, cfg: qwenCfg, noFallback: reqNoFallback, sentAnyText: streamedAny, riskyToolUsed })) {\n'
    '          r = await fallbackToQwen("ошибка доступа после повтора");\n'
    '        }\n'
    '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n')

# 7. Исход хода — окно и статистика.
rep('    if (maxTurnContext > SESSION_MAX_CONTEXT_TOKENS) {\n',
    '    // Окно запасного Qwen: успех Claude, начатый после открытия окна, его\n'
    '    // закрывает; исход аварийного хода на Qwen идёт в статистику (сбой —\n'
    '    // закрывает). Принудительный Qwen (выбор пользователя) не считается.\n'
    '    {\n'
    '      const runOk = !!r.sawResult && !r.accessFailHit && !r.transientHit;\n'
    '      if (provider === "qwen" && usedFallback) qwenBreaker.qwenFinished(runOk);\n'
    '      else if (provider === "claude" && runOk) qwenBreaker.claudeSucceeded(r.startedAt);\n'
    '    }\n'
    '    if (maxTurnContext > SESSION_MAX_CONTEXT_TOKENS) {\n')

# 8. done и /health.
rep('        failReason,\n      }) + ',
    '        failReason,\n'
    '        provider,\n'
    '        fallback: usedFallback,\n'
    '      }) + ')
rep('res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime() });',
    'res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime(), qwen: { enabled: !!qwen.readQwenConfig(), ...qwenBreaker.stats() } });')

open(path, "w", encoding="utf-8").write(s)
print("ok:", path)
```

- [ ] **Step 2: Применить к копии и проверить**

```bash
cd ~/Downloads/spirits_back/.worktrees/llm-provider-switch/relay-agent
python3 qwen-patch.py server.mjs
python3 qwen-patch.py server.mjs; echo "повторный запуск: $?"   # ожидается «уже пропатчено», код 1
git diff --stat server.mjs
```

Expected: `ok: server.mjs`; повторный — «уже пропатчено»; дифф ~60–70 строк.

- [ ] **Step 3: Прочитать дифф глазами.** `git diff server.mjs` — каждое место: переменные `streamedAny`, `isErrorResult`, `block`, `sessionId`, `reqModel`, `args` действительно в области видимости там, куда вставлены (особенно п. 5 — внутри `handleEvent`, п. 4 — внутри цикла по `ev.message.content`). Если нет — правка скрипта, а не руками в `server.mjs`.

- [ ] **Step 4: Коммит, на ноде — `node --check` и все тесты релея**

```bash
cd ~/Downloads/spirits_back/.worktrees/llm-provider-switch
git add relay-agent/qwen-patch.py relay-agent/server.mjs
git commit -q -m "relay: Qwen — принудительный (provider=qwen) и запасной при сбое доступа к Claude; done.provider, /health.qwen

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q && SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/llm-switch-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && cd relay-agent && node --check server.mjs && echo CHECK_OK && node --test *.test.mjs 2>&1 | grep -aE '^# (pass|fail)'"
```

Expected: `CHECK_OK`; `# fail 0` (или то же число, что в базе Task 0).

---

### Task 8: релей — живая версия и проверка на ноде (без выката)

Второй экземпляр релея на 5.101.115.184 запускать НЕЛЬЗЯ: порт 3033 и `sessions.json` прибиты в коде, а `sweepRuns` при старте убивает «чужие» ходы с меткой релея. Проверка — на ноде: там `dv`, `claude` 2.1.312 и Node 22; уборщик трогает только процессы с меткой релея.

- [ ] **Step 1: Снять живую версию и пропатчить её**

```bash
W=/private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/2ee1bf56-31d4-4343-84d9-321f7e3c99d0/scratchpad/relay-live-qwen
rm -rf $W && mkdir -p $W
ssh dv@5.101.115.184 'cd ~/file-agent && git rev-parse --short HEAD && git status --short && tar czf - --exclude=node_modules --exclude=.git --exclude="sessions.json*" --exclude=secrets .' > $W/live.tgz
tar xzf $W/live.tgz -C $W && rm $W/live.tgz
cp ~/Downloads/spirits_back/.worktrees/llm-provider-switch/relay-agent/{qwen-provider.mjs,qwen-provider.test.mjs,qwen-patch.py} $W/
python3 $W/qwen-patch.py $W/server.mjs
```

Expected: HEAD `9ba7f53` (иначе — стоп и доклад: живой релей ушёл вперёд); в `git status` нет изменённых отслеживаемых файлов (только `?? sessions.json.bak-*`); `ok: …/server.mjs`.

- [ ] **Step 2: Временный стенд на ноде**

Проверить, что на ноде нет `/home/dv/file-agent`, `/tmp/agent-uploads`, `/tmp/agent-output` и порт 3033 свободен (`ss -ltn | grep -c ':3033 '` → 0); если что-то есть — стоп и доклад. Затем:

```bash
ssh dv@85.192.61.231 'mkdir -p ~/relay-qwen-check' && tar czf - -C $W . | ssh dv@85.192.61.231 'tar xzf - -C ~/relay-qwen-check'
ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh && cd ~/relay-qwen-check && npm ci --no-audit --no-fund 2>&1 | tail -1 && node --check server.mjs && node --test qwen-provider.test.mjs 2>&1 | grep -aE "^# (pass|fail)" && mkdir -p /home/dv/file-agent && cp empty-mcp.json /home/dv/file-agent/ && echo READY'
```

- [ ] **Step 3: Запуск с пустым `CLAUDE_CONFIG_DIR` и ключом во временном файле** (ключ — через stdin):

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.qwen/settings.json")))["security"]["auth"]["apiKey"])' \
 | ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh; cd ~/relay-qwen-check; umask 077; read -r K; printf "%s" "$K" > key.tmp; CFG=$(mktemp -d); echo $CFG > cfgdir.txt; CLAUDE_CONFIG_DIR=$CFG QWEN_KEY_FILE=$PWD/key.tmp QWEN_FALLBACK_BREAKER_MS=0 setsid -f node server.mjs > relay.log 2>&1 < /dev/null; for i in $(seq 1 20); do curl -s 127.0.0.1:3033/health >/dev/null && break; read -t 1 < /dev/zero 2>/dev/null; done; curl -s 127.0.0.1:3033/health'
```

Expected: JSON `/health` с `"qwen":{"enabled":true,"ok":0,"failed":0,…}`.

- [ ] **Step 4: Три хода**

```bash
ssh dv@85.192.61.231 'cd ~/relay-qwen-check
ask() { curl -s -N -m 300 -X POST 127.0.0.1:3033/chat -F "message=Ответь одним словом: ок" -F "sessionId=qwen-check-$1" -F "model=claude-opus-5-5" $2 | grep -a "\"type\":\"done\"\|\"type\":\"notice\"" | cut -c1-260; }
echo "== 1. сбой Claude → запасной Qwen"; ask a ""
echo "== 2. noFallback → прежнее уведомление cli_fatal"; ask b "-F noFallback=1"
echo "== 3. provider=qwen → принудительный"; ask c "-F provider=qwen"
curl -s 127.0.0.1:3033/health; echo; grep -a "\[qwen\]" relay.log | tail -5'
```

Expected:
1. `done` с `"provider":"qwen","fallback":true`, `"failed":false`; в логе `[qwen] qwen-check-a: Claude недоступен (отказ CLI) → запасной Qwen qwen3.8-max`;
2. `notice` про сбой авторизации, `done` с `"failed":true`, `"failReason":"cli_fatal"`, `"provider":"claude"`;
3. `done` с `"provider":"qwen","fallback":false`;
4. `/health`: `qwen.ok` = 1 (только ход 1 — принудительный не считается).

Если ход 1 пришёл не так — стоп: разбор по `relay.log`, правка `qwen-patch.py`/модуля в spirits_back (Task 6–7), повтор Task 8 с Step 1.

- [ ] **Step 5: Уборка стенда (обязательно, даже при провале)**

```bash
ssh dv@85.192.61.231 'pkill -f "node server.mjs" -u dv --newest; cd ~ && rm -rf "$(cat ~/relay-qwen-check/cfgdir.txt)" ~/relay-qwen-check /home/dv/file-agent /tmp/agent-uploads /tmp/agent-output; ss -ltn | grep -c ":3033 "'
```

Expected: `0`. (`pkill … --newest` — только что запущенный стенд; перед этим можно сверить `pgrep -af "node server.mjs"` — ровно один процесс, из `~/relay-qwen-check`.)

- [ ] **Step 6: Сохранить пропатченную живую версию для выката** — `$W/server.mjs`, `$W/qwen-provider.mjs`, `$W/qwen-provider.test.mjs` остаются в scratchpad до Task 11. Записать в отчёт sha256 живого `server.mjs` до патча (`ssh dv@5.101.115.184 'sha256sum ~/file-agent/server.mjs'`) — Task 11 сверит, что живой файл не изменился.

---

### Task 9: фронт — блок «Модель ответов»

**Files (в `~/Downloads/spirits_front/.worktrees/llm-provider-switch`):**
- Create: `src/components/admin/UserLlmProviderControl.tsx`, `src/components/admin/UserLlmProviderControl.test.tsx`
- Modify: `src/components/admin/UserActivityDrawer.tsx`, `src/i18n/locales/ru.json`, `src/i18n/locales/en.json`, `src/i18n/locales/pt.json`

- [ ] **Step 1: Падающий тест**

```tsx
// @vitest-environment jsdom
/**
 * Модель ответов человека в карточке (spec spirits_back 2026-10-30-llm-provider-switch).
 */
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { get, post } }));

import { UserLlmProviderControl } from './UserLlmProviderControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const mount = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<UserLlmProviderControl userId="79030169187" />); });
  await settle();
};
const radio = (name: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find((el) => el.textContent?.includes(name)) as HTMLButtonElement;

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('UserLlmProviderControl', () => {
  it('показывает текущий выбор', async () => {
    get.mockResolvedValue(ok({ userId: '79030169187', provider: 'qwen', qwenConfigured: true }));
    await mount();
    expect(get).toHaveBeenCalledWith('/webhook/admin/users/79030169187/llm-provider');
    expect(radio('Qwen').getAttribute('aria-checked')).toBe('true');
    expect(radio('Claude').getAttribute('aria-checked')).toBe('false');
  });

  it('переключение сохраняется сразу', async () => {
    get.mockResolvedValue(ok({ userId: '79030169187', provider: 'claude', qwenConfigured: true }));
    post.mockResolvedValue(ok({ userId: '79030169187', provider: 'qwen', qwenConfigured: true }));
    await mount();
    await act(async () => { radio('Qwen').click(); });
    await settle();
    expect(post).toHaveBeenCalledWith('/webhook/admin/users/79030169187/llm-provider', { provider: 'qwen' });
    expect(radio('Qwen').getAttribute('aria-checked')).toBe('true');
  });

  it('без ключа на сервере — предупреждение', async () => {
    get.mockResolvedValue(ok({ userId: '79030169187', provider: 'claude', qwenConfigured: false }));
    await mount();
    expect(container.textContent).toContain('Ключ Qwen на сервере не настроен');
  });

  it('ошибка загрузки видна', async () => {
    get.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('Не удалось загрузить или сохранить выбор');
  });
});
```

- [ ] **Step 2: Коммит, push, прогон на ноде — красный**

```bash
cd ~/Downloads/spirits_front/.worktrees/llm-provider-switch
git add src/components/admin/UserLlmProviderControl.test.tsx
git commit -q -m "test: админка — блок «Модель ответов» (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q && FSHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/llm-switch-front && git fetch -q origin && git checkout -q --detach $FSHA && source ~/.nvm/nvm.sh && ./node_modules/.bin/vitest run src/components/admin/UserLlmProviderControl.test.tsx 2>&1 | tail -8"
```

Expected: FAIL — нет модуля.

- [ ] **Step 3: Компонент**

```tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Cpu, Loader } from 'lucide-react';
import { apiClient } from '../../services/apiClient';

type Provider = 'claude' | 'qwen';
interface ProviderState { provider: Provider; qwenConfigured: boolean }

const toState = (j: any): ProviderState => ({
  provider: j?.provider === 'qwen' ? 'qwen' : 'claude',
  qwenConfigured: j?.qwenConfigured === true,
});

/**
 * Модель ответов ассистентов этому человеку (spec spirits_back
 * 2026-10-30-llm-provider-switch). Меняет только админ; сохраняется сразу.
 * userId — тот же идентификатор, что получает карточка (телефон или UUID).
 */
export const UserLlmProviderControl: React.FC<{ userId: string }> = ({ userId }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<ProviderState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/webhook/admin/users/${encodeURIComponent(userId)}/llm-provider`;

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    (async () => {
      try {
        const r = await apiClient.get(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) setState(toState(j));
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const choose = async (provider: Provider) => {
    if (!state || saving || provider === state.provider) return;
    setSaving(true);
    setError(null);
    try {
      const r = await apiClient.post(url, { provider });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState(toState(await r.json()));
    } catch (e: any) {
      setError(e?.message ?? 'error');
    } finally {
      setSaving(false);
    }
  };

  const label = (p: Provider) => (p === 'claude'
    ? t('admin.userActivity.llmProvider.claude', 'Claude (по умолчанию)')
    : t('admin.userActivity.llmProvider.qwen', 'Qwen'));

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-gray-800">
        <Cpu className="w-4 h-4" />
        {t('admin.userActivity.llmProvider.title', 'Модель ответов')}
        {saving && <Loader className="w-3.5 h-3.5 animate-spin text-gray-400" />}
      </div>
      {error && (
        <p className="text-sm text-red-600 mb-2">
          {t('admin.userActivity.llmProvider.error', 'Не удалось загрузить или сохранить выбор')}: {error}
        </p>
      )}
      {state && (
        <>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {(['claude', 'qwen'] as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={state.provider === p}
                disabled={saving}
                onClick={() => choose(p)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg border text-sm',
                  state.provider === p
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50',
                )}
              >
                {label(p)}
              </button>
            ))}
          </div>
          {!state.qwenConfigured && (
            <p className="mt-2 text-xs text-amber-700">
              {t('admin.userActivity.llmProvider.noKey', 'Ключ Qwen на сервере не настроен — ответы пойдут через Claude.')}
            </p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            {t('admin.userActivity.llmProvider.hint', 'Веб-ассистенты, Маша и TG-боты этого человека. Пробы мониторинга и фоновые задачи — всегда Claude.')}
          </p>
        </>
      )}
    </div>
  );
};
```

- [ ] **Step 4: Вставка в карточку** — `UserActivityDrawer.tsx`: импорт `import { UserLlmProviderControl } from './UserLlmProviderControl';` рядом с `import { UserCallsList } from './UserCallsList';`; после строки `<UserCallsList userId={phone} />`:

```tsx

              {/* Модель ответов ассистентов этому человеку — Claude или Qwen. */}
              <UserLlmProviderControl userId={phone} />
```

- [ ] **Step 5: Строки в локалях** — узлом, не правкой текста (Write портит `\uXXXX`): ключи `admin.userActivity.llmProvider.{title,claude,qwen,noKey,hint,error}` в `ru.json` (тексты — как значения по умолчанию в компоненте), `en.json` (`Answer model`, `Claude (default)`, `Qwen`, `Qwen key is not configured on the server — answers will go through Claude.`, `Web assistants, Masha and this person's Telegram bots. Monitoring probes and background jobs always use Claude.`, `Could not load or save the choice`) и `pt.json` (`Modelo de respostas`, `Claude (predefinido)`, `Qwen`, `A chave do Qwen não está configurada no servidor — as respostas irão pelo Claude.`, `Assistentes web, a Masha e os bots de Telegram desta pessoa. Sondas de monitorização e tarefas em segundo plano usam sempre o Claude.`, `Não foi possível carregar ou guardar a escolha`):

```bash
cd ~/Downloads/spirits_front/.worktrees/llm-provider-switch && node -e '
const fs = require("fs");
const T = {
  ru: { title: "Модель ответов", claude: "Claude (по умолчанию)", qwen: "Qwen", noKey: "Ключ Qwen на сервере не настроен — ответы пойдут через Claude.", hint: "Веб-ассистенты, Маша и TG-боты этого человека. Пробы мониторинга и фоновые задачи — всегда Claude.", error: "Не удалось загрузить или сохранить выбор" },
  en: { title: "Answer model", claude: "Claude (default)", qwen: "Qwen", noKey: "Qwen key is not configured on the server — answers will go through Claude.", hint: "Web assistants, Masha and this person’s Telegram bots. Monitoring probes and background jobs always use Claude.", error: "Could not load or save the choice" },
  pt: { title: "Modelo de respostas", claude: "Claude (predefinido)", qwen: "Qwen", noKey: "A chave do Qwen não está configurada no servidor — as respostas irão pelo Claude.", hint: "Assistentes web, a Masha e os bots de Telegram desta pessoa. Sondas de monitorização e tarefas em segundo plano usam sempre o Claude.", error: "Não foi possível carregar ou guardar a escolha" },
};
for (const [lang, v] of Object.entries(T)) {
  const p = `src/i18n/locales/${lang}.json`;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j.admin || !j.admin.userActivity) throw new Error(lang + ": нет admin.userActivity");
  j.admin.userActivity.llmProvider = v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
console.log("ok");'
git diff --stat src/i18n/locales
```

Expected: `ok`; в диффе только добавленные строки (если файл был в другом форматировании и дифф огромный — откатить и вставить ключи точечно тем же узлом, сохранив исходный отступ: определить его по второй строке файла).

- [ ] **Step 6: Коммит, прогон на ноде — зелёный, tsc и сборка**

```bash
git add src/components/admin/UserLlmProviderControl.tsx src/components/admin/UserActivityDrawer.tsx src/i18n/locales/ru.json src/i18n/locales/en.json src/i18n/locales/pt.json
git commit -q -m "feat: админка — модель ответов (Claude/Qwen) в карточке пользователя

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q && FSHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/llm-switch-front && git fetch -q origin && git checkout -q --detach $FSHA && source ~/.nvm/nvm.sh && ./node_modules/.bin/vitest run src/components/admin 2>&1 | grep -aE 'Test Files|Tests ' ; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'; pnpm build 2>&1 | tail -2"
```

Expected: vitest зелёный (база + 4); число ошибок tsc — как в базе Task 0; сборка без ошибок.

---

### Task 10: финальное ревью и слияние

- [ ] **Step 1: Ревью** — `superpowers:code-reviewer` по `origin/main..feat/llm-provider-switch` в обоих репозиториях; отдельно — `$W/server.mjs` против живого (`diff`).
- [ ] **Step 2: Полный прогон на финальных sha** — бэк: `npx tsc -p tsconfig.build.json --noEmit` и полный `npx jest` на ветке и на `origin/main`, дельта падений — ноль (красное by design — те же наборы); релей: `node --test *.test.mjs`; фронт: vitest целиком + tsc (дельта) + `pnpm build`.
- [ ] **Step 3: Слияние бэка** — squash поверх свежего `origin/main` (как в прошлой фиче: `checkout --detach origin/main` → `merge --squash` → коммит → push во временную ветку → tsc+jest на ноде → `git push origin HEAD:refs/heads/main` → удалить ветки на GitHub).
- [ ] **Step 4: Слияние фронта** — так же, в `spirits_front`.

---

### Task 11: выкат — ТОЛЬКО С OK ВЛАДЕЛЬЦА НА КАЖДЫЙ ШАГ

Порядок по финальному ревью (30.10): релей **без ключа** первым (поведение
прежнее — `readQwenConfig()` вернёт `null`, Qwen выключен целиком), ключ
файлом — **последним шагом**, рестарт для него не нужен (файл читается на
каждом ходе). Так между Step 2 и Step 4 прод уже на новом коде, но без
живого запасного пути — откатывать нечего, если что-то не так с ключом.

- [ ] **Step 1: Выкат релея без ключа (OK)** — по рецепту памяти «Релей
  file-agent»: sha живого `server.mjs` = записанному в Task 8 Step 6; положить
  `$W/qwen-provider.mjs`, `$W/qwen-provider.test.mjs`, `$W/.gitignore` и
  `$W/server.mjs` (как `server.next.mjs`) → `node --check server.next.mjs` →
  `node --test *.test.mjs` → `mv server.next.mjs server.mjs` →
  **`git add server.mjs qwen-provider.mjs qwen-provider.test.mjs .gitignore`
  поимённо, не `-A`** (случайный мусор в рабочей копии релея не должен уйти в
  коммит) → `git commit` от `dv` → в ОДНОЙ ssh-команде:
  `[ -z "$(ps --ppid $(pm2 pid file-agent) -o pid=)" ] && pm2 restart file-agent`
  (если ходы идут — подождать и повторить) → `curl -s 127.0.0.1:3033/health`:
  `qwen.enabled: false` (ключа ещё нет — ожидаемо).
- [ ] **Step 2: Выкат бэка и фронта (OK)** — `deploy.sh` с ноды из свежих
  клонов main, `SKIP_BOTS=1 SKIP_PRODUCTS_HOST=1`, отвязанно; порядок и
  ловушки — память «Выкат: правила».
- [ ] **Step 3: `RELAY_QWEN_MONITOR=off` на test (OK)** — если в `.env` test
  уже есть `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (там `AGENT_URL` указывает
  на боевой релей — без выключателя test дублировал бы алерты прода): если
  переменные появляются только сейчас (Step 2 их ещё не добавил) — выставить
  до того, как `RelayQwenMonitorService` на test начнёт слать; если уже были
  раньше — можно и следом за Step 2.
- [ ] **Step 4: Ключ на релей файлом (OK)**

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.qwen/settings.json")))["security"]["auth"]["apiKey"])' \
 | ssh dv@5.101.115.184 'umask 077; mkdir -p ~/file-agent/secrets && chmod 700 ~/file-agent/secrets && read -r K && printf "%s" "$K" > ~/file-agent/secrets/qwen.key && stat -c "%a %s" ~/file-agent/secrets/qwen.key; grep -c "^secrets/" ~/file-agent/.gitignore'
```

Expected: `600 114` и `1` (строка `secrets/` из Step 1). Рестарт не нужен —
`readQwenConfig()` читает файл на каждом ходе; проверить
`curl -s 127.0.0.1:3033/health` → `qwen.enabled: true`.

- [ ] **Step 5: Проверка после выката**
  - прод: колонка есть (`SELECT llm_provider FROM ai_profiles_consolidated LIMIT 1` без ошибки); `GET /webhook/admin/users/79030169187/llm-provider` с админским JWT → `qwenConfigured: true`;
  - владелец в админке ставит себе «Qwen» и пишет Роману, Маше, своему TG-боту; в `events`: `chat_quality.props.provider = 'qwen'` (Роман), `claude_cli_call` с `provider: 'qwen', fallback: false` (Маша, TG); в логе бэка — `llm_provider: <актор> → 79030169187 = qwen`;
  - `/health` релея: `qwen.ok` не растёт от ходов владельца (принудительные не считаются);
  - синтетика `chat_streaming` зелёная.
- [ ] **Step 6: Память и уборка** — обновить `project_qwen_fallback_for_claude.md`; снять воркдеревья на маке и ноде, scratchpad-копию релея.
