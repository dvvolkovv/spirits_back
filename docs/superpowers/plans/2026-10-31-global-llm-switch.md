# Общий рубильник модели ответов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Один переключатель в админке переводит ответы всех пользователей, гостей пробы и фоновые задачи на Claude, Qwen или Kimi; личный выбор в карточке пользователя важнее.

**Architecture:** Значение рубильника — строка `global_provider` в новой таблице `llm_settings` (сервис `GlobalLlmProviderService`, кэш 15 с). Применяется в двух точках: `ClaudeCliService` подставляет его каждому вызову без явного выбора, а запросы бэкенда к релею получают его полем `provider` через общий помощник. Личный выбор (`ai_profiles_consolidated.llm_provider`: NULL — «Как у всех», `claude`/`qwen`/`kimi` — явный) решает `UserLlmProviderService.route()`.

**Tech Stack:** NestJS 10 + TypeScript + Jest (spirits_back), React 18 + TypeScript + Vitest + i18next (spirits_front), PostgreSQL.

**Спека:** `docs/superpowers/specs/2026-10-31-global-llm-switch-design.md` (коммит 1aa0d4b5).

---

## Перед началом — правила

- **Воркдеревья и ветки:** бэк — `~/Downloads/spirits_back/.worktrees/global-llm-switch` (ветка `feat/global-llm-switch`, от `origin/main` f4dad531); кабинет — `~/Downloads/spirits_front/.worktrees/global-llm-switch` (ветка `feat/global-llm-switch`, от `origin/main` 25d2bed). Основные чекауты и чужие воркдеревья не трогать.
- **На маке не запускать** `jest`, `tsc`, `vitest`, `pnpm build`, `npm ci`, `pnpm install` — только на тестовой ноде через помощник `.superpowers/node-run.sh` (Задача 0). Он гоняет **закоммиченное** состояние: каждый прогон начинается с коммита. Красный тест коммитится отдельным коммитом `test: …`.
- **Прогон — под `timeout`**: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern="…" 2>&1 | tail -60'`. Код 124 — зависание, а не зелёный прогон.
- **jest бэка — только через `--testPathPattern`** (позиционный путь не сужает прогон). `Tests: 0` — промах фильтра, не зелёный прогон.
- **Типы бэкенда jest не проверяет.** Гейт — `npx tsc --noEmit -p tsconfig.build.json` (на базе чистый). В кабинете — `pnpm typecheck`; на базе есть ошибки, мерить дельтой от числа из Задачи 0.
- **Репозитории публичные:** ни номеров телефонов, ни секретов, ни IP в коде, тестах и коммитах. В тестах — `u-1`, `admin-1`, ключи `sk-sp-test`/`sk-kimi-test`.
- **Коммиты** — по-русски, в стиле репозитория (`feat(llm): …`, `test(llm): …`), в конце строка `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add` — только поимённо.
- **Слияние в main, выкат, правка прода, переключение рубильника на проде — только с OK владельца** (Часть В).

## Карта файлов

**spirits_back:**

| Файл | Что |
|---|---|
| `src/common/services/global-llm-provider.service.ts` (новый) | таблица `llm_settings`, чтение рубильника с кэшем, запись, статус |
| `src/common/services/llm-fallback.ts` | `planProviders`: `noFallback` с выбором — одна эта модель |
| `src/common/services/claude-cli.service.ts` | рубильник для вызовов без `provider`; `provider` принимает `'claude'`; поле `choice` в событии |
| `src/common/services/user-llm-provider.service.ts` | «Как у всех» (`default`), явный `claude`, `route()` |
| `src/common/common.module.ts` | регистрация `GlobalLlmProviderService` |
| `src/chat/answer-provider.ts` | `resolveAnswerProvider` отдаёт маршрут; `cliProviderOption(route)` |
| `src/chat/chat.service.ts`, `src/chat/chat.controller.ts`, `src/tg-bot/tg-router.service.ts` | маршрут вместо модели |
| `src/blog/blog-relay.client.ts`, `src/ask/clean-ask.service.ts` | поле `provider` рубильника в запросе к релею |
| `src/chat/chat.service.ts` (`agentReply`) | поле `provider` (личный выбор или рубильник) в запросе к релею |
| `src/guest-trial/guest-turn.service.ts` | модель рубильника без цепочки, проверка её окна |
| `src/common/global-llm-messages.ts` (новый) | тексты сообщений: переключение и напоминание |
| `src/admin/admin-global-llm.controller.ts` (новый), `src/admin/admin.module.ts` | `GET/POST /webhook/admin/llm-provider` |
| `src/admin/admin-llm-provider.controller.ts` | карточка: `default`, `effective`, `global` |
| `src/monitoring/global-llm-reminder.service.ts` (новый), `src/monitoring/monitoring.module.ts` | напоминание раз в сутки |
| `CLAUDE.md` | раздел о рубильнике |

**spirits_front:**

| Файл | Что |
|---|---|
| `src/components/admin/globalLlm.ts` (новый) | типы, разбор ответа, запросы, событие смены, формат даты |
| `src/components/admin/GlobalLlmProviderControl.tsx` (новый) | блок «Модель ответов для всех» |
| `src/components/admin/GlobalLlmBanner.tsx` (новый) | плашка на всех вкладках |
| `src/components/admin/AdminAssistantsView.tsx` | блок вверху вкладки |
| `src/pages/AdminPage.tsx`, `src/pages/AdminPage.test.tsx` | плашка под строкой вкладок |
| `src/components/admin/UserLlmProviderControl.tsx` | четыре варианта |
| `src/i18n/locales/{ru,en,pt}.json` | тексты |

---

## Задача 0. Помощники прогона и база

**Files:**
- Create: `~/Downloads/spirits_back/.worktrees/global-llm-switch/.superpowers/node-run.sh`
- Create: `~/Downloads/spirits_front/.worktrees/global-llm-switch/.superpowers/node-run.sh`

`.superpowers/` в обоих репозиториях не коммитится (он уже игнорируется: `git status` его не показывает; если покажет — добавить строку `.superpowers/` в `.git/info/exclude` основного репозитория).

- [ ] **Шаг 1: помощник бэка**

```bash
#!/usr/bin/env bash
# Прогон на тестовой ноде на ТЕКУЩЕМ коммите воркдерева global-llm-switch (бэк).
#   bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern=src/common/services/llm-fallback'
# Код едет git push'ем в CI-клон ноды (ветка tmp/gls), не в GitHub. Незакоммиченное не едет.
# Один ControlMaster на все вызовы: нода рвёт частые новые SSH (MaxStartups). Не запускать параллельно.
set -euo pipefail
WT=~/Downloads/spirits_back/.worktrees/global-llm-switch
NODE_WT=ci/wt/gls-back
BRANCH=tmp/gls
SSH_OPTS="-o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h"
git -C "$WT" status --porcelain | grep -q . && echo "⚠ незакоммиченные изменения на ноду не едут — прогон на коммите $(git -C "$WT" rev-parse --short HEAD)" >&2
SHA=$(git -C "$WT" rev-parse HEAD)
GIT_SSH_COMMAND="ssh $SSH_OPTS" git -C "$WT" push -q -f "dv@85.192.61.231:ci/spirits_back" "$SHA:refs/heads/$BRANCH"
ssh $SSH_OPTS dv@85.192.61.231 "set -eo pipefail
  git -C ~/ci/spirits_back worktree prune
  [ -d ~/$NODE_WT ] || git -C ~/ci/spirits_back worktree add -q --detach ~/$NODE_WT $SHA
  cd ~/$NODE_WT && git checkout -q -f --detach $SHA
  [ \"\$(git rev-parse HEAD)\" = \"$SHA\" ] || { echo \"MISMATCH: на ноде \$(git rev-parse --short HEAD), ждали $SHA\"; exit 1; }
  source ~/.nvm/nvm.sh
  H=\$(sha256sum package-lock.json | cut -c1-16)
  if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != \"\$H\" ]; then
    npm ci > /tmp/gls-back-npmci.log 2>&1 || (tail -20 /tmp/gls-back-npmci.log; exit 1)
    echo \"\$H\" > node_modules/.lockhash
  fi
  echo \"== \$(git log --oneline -1)\"
  set +e
  $1"
```

- [ ] **Шаг 2: помощник кабинета** — тот же файл с заменами: `WT=~/Downloads/spirits_front/.worktrees/global-llm-switch`, `NODE_WT=ci/wt/gls-front`, `ci/spirits_back` → `ci/spirits_front` (в двух местах), блок установки:

```bash
  H=\$(sha256sum pnpm-lock.yaml | cut -c1-16)
  if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != \"\$H\" ]; then
    pnpm install --frozen-lockfile > /tmp/gls-front-install.log 2>&1 || (tail -20 /tmp/gls-front-install.log; exit 1)
    echo \"\$H\" > node_modules/.lockhash
  fi
```

- [ ] **Шаг 3: база бэка**

Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern="src/(common/services|chat/(answer-provider|chat.service.llm-provider|chat.service.masha-provider|chat.upload-llm-provider)|admin/admin-llm-provider|guest-trial|blog/blog-relay|ask/clean-ask|tg-bot/tg-router.model|monitoring/claude-health)" 2>&1 | tail -8; timeout 200 npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?'`
Expected: `Tests: … passed`, 0 failed; `tsc_build=0`. Записать числа наборов и тестов в отчёт.

- [ ] **Шаг 4: база кабинета**

Run: `bash .superpowers/node-run.sh 'timeout 240 pnpm vitest run src/components/admin src/pages/AdminPage.test.tsx 2>&1 | tail -6; pnpm typecheck 2>&1 | grep -c "error TS"; node scripts/check-locales.mjs >/dev/null 2>&1; echo locales=$?; node scripts/check-keys-exist.mjs >/dev/null 2>&1; echo keys=$?; node scripts/check-no-hardcoded.mjs >/dev/null 2>&1; echo hardcoded=$?'`
Expected: тесты зелёные; число ошибок TS — **база** (записать); `locales=0`, `keys=0`, `hardcoded=0` (если какой-то не 0 на базе — записать как базу).

---

## Задача 1. `planProviders`: `noFallback` с выбором — одна эта модель

**Files:**
- Modify: `src/common/services/llm-fallback.ts` (функция `planProviders`, ~строка 277–307)
- Test: `src/common/services/llm-fallback.spec.ts` (тест `'noFallback — только Claude, выбор не действует'`, ~строка 257)

- [ ] **Шаг 1: тесты.** Заменить тест `'noFallback — только Claude, выбор не действует'` на эти четыре:

```ts
  it('noFallback с выбором (ход гостя) — только выбранная модель', () => {
    expect(planProviders({ selected: 'kimi', configs: both, state: new FallbackState(), noFallback: true, now: T })).toEqual(['kimi']);
  });
  it('noFallback с выбором без ключа — Claude', () => {
    expect(planProviders({ selected: 'qwen', configs: { qwen: null, kimi: cfg('kimi') }, state: new FallbackState(), noFallback: true, now: T })).toEqual(['claude']);
  });
  it('noFallback без выбора (проба мониторинга) — Claude', () => {
    expect(planProviders({ configs: both, state: new FallbackState(), noFallback: true, now: T })).toEqual(['claude']);
  });
  it('noFallback с именем из прототипа — Claude', () => {
    expect(planProviders({ selected: 'constructor' as any, configs: both, state: new FallbackState(), noFallback: true, now: T })).toEqual(['claude']);
  });
```

- [ ] **Шаг 2: красный прогон.** Коммит `test(llm): noFallback с выбором — одна модель (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern=src/common/services/llm-fallback 2>&1 | tail -25'`
Expected: FAIL — `noFallback с выбором (ход гостя)` получает `['claude']`.

- [ ] **Шаг 3: реализация.** В `planProviders` заменить строку `if (args.noFallback) return ['claude'];` на:

```ts
  // noFallback — без цепочки (spec 2026-10-31-global-llm-switch, раздел 3):
  // проба мониторинга (без выбора) — только Claude; ход гостя — только модель
  // рубильника, если у неё есть ключ, иначе Claude.
  if (args.noFallback) {
    const s = args.selected;
    return s && FALLBACK_ORDER.includes(s) && args.configs[s] ? [s] : ['claude'];
  }
```

и в doc-комментарии над функцией строку `noFallback — только Claude.` заменить на `noFallback — одна модель: выбранная (ход гостя) или Claude (проба).`

- [ ] **Шаг 4: зелёный прогон** той же командой. Expected: PASS.
- [ ] **Шаг 5: коммит** `feat(llm): noFallback с выбором — только эта модель (ход гостя)` — `git add src/common/services/llm-fallback.ts src/common/services/llm-fallback.spec.ts`.

---

## Задача 2. `GlobalLlmProviderService` и таблица `llm_settings`

**Files:**
- Create: `src/common/services/global-llm-provider.service.ts`
- Create: `src/common/services/global-llm-provider.service.spec.ts`
- Modify: `src/common/common.module.ts`

- [ ] **Шаг 1: тест** `src/common/services/global-llm-provider.service.spec.ts`:

```ts
import { GlobalLlmProviderService, GLOBAL_PROVIDER_CACHE_MS, LLM_SETTINGS_DDL } from './global-llm-provider.service';

const mk = (impl: (sql: string, params?: any[]) => any) => {
  const query = jest.fn(async (sql: string, params?: any[]) => impl(sql, params));
  return { svc: new GlobalLlmProviderService({ query } as any), query };
};
const row = (provider: unknown, extra: Record<string, unknown> = {}) => ({ rows: [{ value: { provider }, ...extra }] });

describe('GlobalLlmProviderService', () => {
  it('get: строки нет — claude', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.get()).toBe('claude');
  });

  it('get: qwen', async () => {
    const { svc } = mk(() => row('qwen'));
    expect(await svc.get()).toBe('qwen');
  });

  it('get: мусор в значении — claude', async () => {
    const { svc } = mk(() => row('gpt'));
    expect(await svc.get()).toBe('claude');
  });

  it('get: кэш 15 секунд — второй запрос в базу только после истечения', async () => {
    const { svc, query } = mk(() => row('kimi'));
    const t0 = 1_000_000;
    expect(await svc.get(t0)).toBe('kimi');
    expect(await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS - 1)).toBe('kimi');
    expect(query).toHaveBeenCalledTimes(1);
    await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('get: сбой базы без прочитанного раньше значения — claude', async () => {
    const { svc } = mk(() => { throw new Error('db down'); });
    expect(await svc.get()).toBe('claude');
  });

  it('get: сбой базы после прочитанного qwen — qwen (не возвращаем всех на Claude молча)', async () => {
    let fail = false;
    const { svc } = mk(() => { if (fail) throw new Error('db down'); return row('qwen'); });
    const t0 = 2_000_000;
    expect(await svc.get(t0)).toBe('qwen');
    fail = true;
    expect(await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS + 1)).toBe('qwen');
  });

  it('set: upsert с актором; отдаёт прежнее значение; кэш сразу новый', async () => {
    const { svc, query } = mk((sql) => (/^SELECT value, updated_at/.test(sql) ? row('claude') : { rows: [], rowCount: 1 }));
    const r = await svc.set('kimi', 'admin-1');
    expect(r).toEqual({ previous: 'claude' });
    const upsert = query.mock.calls.find((c) => /INSERT INTO llm_settings/.test(c[0]))!;
    expect(upsert[0]).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(upsert[1]).toEqual(['global_provider', JSON.stringify({ provider: 'kimi' }), 'admin-1']);
    query.mockClear();
    expect(await svc.get()).toBe('kimi');
    expect(query).not.toHaveBeenCalled();
  });

  it('status: модель, с какого момента и кто', async () => {
    const { svc } = mk(() => row('qwen', { updated_at: new Date('2026-10-31T13:40:00Z'), updated_by: 'admin-1' }));
    expect(await svc.status()).toEqual({ provider: 'qwen', since: '2026-10-31T13:40:00.000Z', by: 'admin-1' });
  });

  it('status: строки нет — claude, since и by пусты', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.status()).toEqual({ provider: 'claude', since: null, by: null });
  });

  it('onModuleInit: один DO под advisory-локом, CREATE TABLE IF NOT EXISTS llm_settings', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    await svc.onModuleInit();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(LLM_SETTINGS_DDL);
    expect(LLM_SETTINGS_DDL).toMatch(/pg_advisory_xact_lock/);
    expect(LLM_SETTINGS_DDL).toMatch(/CREATE TABLE IF NOT EXISTS llm_settings/);
  });

  it('onModuleInit: сбой — не роняет старт', async () => {
    const { svc } = mk(() => { throw new Error('lock timeout'); });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});
```

- [ ] **Шаг 2: красный прогон.** Коммит `test(llm): сервис рубильника (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern=src/common/services/global-llm-provider 2>&1 | tail -15'`
Expected: FAIL — `Cannot find module './global-llm-provider.service'`.

- [ ] **Шаг 3: реализация** `src/common/services/global-llm-provider.service.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { AnswerProvider, isAnswerProvider } from './llm-fallback';

/** Ключ строки рубильника в llm_settings. */
export const GLOBAL_PROVIDER_KEY = 'global_provider';
/** Сколько живёт прочитанное значение: API — один процесс pm2, переключение
 *  действует не позже чем через это время, без выката и рестарта. */
export const GLOBAL_PROVIDER_CACHE_MS = 15_000;

/**
 * Таблица настроек модели ответов. Катится при КАЖДОМ старте API, поэтому —
 * один DO под advisory-локом (одновременные старты не сталкиваются), как
 * guest-trial/migrations/001_guest_trial.sql. CREATE TABLE IF NOT EXISTS на
 * готовой таблице — бесплатный no-op.
 */
export const LLM_SETTINGS_DDL = `DO $llm_settings$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('llm-settings/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS llm_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );
END
$llm_settings$`;

export interface GlobalProviderStatus {
  provider: AnswerProvider;
  /** Когда переключили (ISO); null — ни разу. */
  since: string | null;
  /** Кто переключил — userId админа. */
  by: string | null;
}

/**
 * Общий рубильник модели ответов (spec 2026-10-31-global-llm-switch, раздел 2):
 * модель для всех, у кого в карточке «Как у всех», для гостей пробы и для
 * фоновых задач. Нет строки или мусор — Claude.
 */
@Injectable()
export class GlobalLlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(GlobalLlmProviderService.name);
  private cached: { provider: AnswerProvider; at: number } | null = null;
  /** Последнее прочитанное из базы: падение базы во время аварии Claude не
   *  должно молча вернуть всех на Claude. */
  private lastKnown: AnswerProvider | null = null;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pg.query(LLM_SETTINGS_DDL);
    } catch (e: any) {
      this.logger.warn(`llm_settings: таблица не создана: ${e?.message}`);
    }
  }

  async get(now: number = Date.now()): Promise<AnswerProvider> {
    if (this.cached && now - this.cached.at < GLOBAL_PROVIDER_CACHE_MS) return this.cached.provider;
    try {
      const r = await this.pg.query('SELECT value FROM llm_settings WHERE key = $1', [GLOBAL_PROVIDER_KEY]);
      const v = r.rows[0]?.value?.provider;
      const provider: AnswerProvider = isAnswerProvider(v) ? v : 'claude';
      this.cached = { provider, at: now };
      this.lastKnown = provider;
      return provider;
    } catch (e: any) {
      this.logger.warn(`llm_settings: рубильник не прочитан: ${e?.message}`);
      return this.lastKnown ?? 'claude';
    }
  }

  async status(): Promise<GlobalProviderStatus> {
    const r = await this.pg.query(
      'SELECT value, updated_at, updated_by FROM llm_settings WHERE key = $1',
      [GLOBAL_PROVIDER_KEY],
    );
    const row = r.rows[0];
    const v = row?.value?.provider;
    return {
      provider: isAnswerProvider(v) ? v : 'claude',
      since: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      by: row?.updated_by ?? null,
    };
  }

  /** Записывает выбор и сразу обновляет кэш; отдаёт прежнее значение. */
  async set(provider: AnswerProvider, by: string): Promise<{ previous: AnswerProvider }> {
    const before = await this.status();
    await this.pg.query(
      `INSERT INTO llm_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [GLOBAL_PROVIDER_KEY, JSON.stringify({ provider }), by],
    );
    this.cached = { provider, at: Date.now() };
    this.lastKnown = provider;
    return { previous: before.provider };
  }
}
```

В `src/common/common.module.ts` импортировать `GlobalLlmProviderService` из `./services/global-llm-provider.service` и добавить его в `providers` и `exports` (после `UserLlmProviderService`).

- [ ] **Шаг 4: зелёный прогон** той же командой + `timeout 200 npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?`. Expected: PASS, `tsc_build=0`.
- [ ] **Шаг 5: коммит** `feat(llm): общий рубильник модели — таблица llm_settings и сервис` — `git add src/common/services/global-llm-provider.service.ts src/common/services/global-llm-provider.service.spec.ts src/common/common.module.ts`.

---

## Задача 3. `ClaudeCliService` применяет рубильник

**Files:**
- Modify: `src/common/services/claude-cli.service.ts` (импорты; `ClaudeCliOptions.noFallback`/`provider`; конструктор; начало `runRaw`; `runOnce`/`spawnClaude`/`trackCallEvent` — поле `choice`)
- Create: `src/common/services/claude-cli.global-switch.spec.ts`
- Modify: `src/common/services/claude-cli.chain.spec.ts` (тест `'noFallback с provider kimi — только Claude…'`)

- [ ] **Шаг 1: тесты** `src/common/services/claude-cli.global-switch.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/** Общий рубильник модели (spec 2026-10-31-global-llm-switch, разделы 1 и 3). */

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
/** Ключ i-го запуска; undefined — запуск Claude. */
const tokenOf = (i: number) => spawnMock.mock.calls[i][2]?.env?.ANTHROPIC_AUTH_TOKEN as string | undefined;
const pgMock = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) });
const event = (pg: any) => JSON.parse(pg.query.mock.calls[0][1][0]);
const sw = (p: 'claude' | 'qwen' | 'kimi') => ({ get: jest.fn(async () => p) });

let roots: string[] = [];
function svc(pg?: any, global?: any): ClaudeCliService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gls-spec-root-'));
  roots.push(root);
  const s = new ClaudeCliService(pg, global);
  (s as any).tmpRoot = () => root;
  return s;
}

const VARS = ['QWEN_FALLBACK_API_KEY', 'KIMI_FALLBACK_API_KEY', 'LLM_FALLBACK_BREAKER_MS', 'QWEN_FALLBACK_BREAKER_MS'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
  process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
});
afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
  jest.restoreAllMocks();
});

describe('ClaudeCliService — общий рубильник', () => {
  it('без provider, рубильник Qwen — сразу Qwen; событие: selected qwen, choice global, fallback false', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await svc(pg, sw('qwen')).text('x')).toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-sp-test');
    expect(event(pg)).toMatchObject({ provider: 'qwen', fallback: false, selected: 'qwen', choice: 'global' });
  });

  it('без provider, рубильник Claude — Claude; в событии нет selected и choice', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(pg, sw('claude')).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(event(pg)).not.toHaveProperty('selected');
    expect(event(pg)).not.toHaveProperty('choice');
  });

  it('явный provider claude — Claude, рубильник не читается', async () => {
    const global = sw('qwen');
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, global).text('x', { provider: 'claude' })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(global.get).not.toHaveBeenCalled();
  });

  it('явный provider kimi при рубильнике Qwen — Kimi; choice user', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('k')));
    expect(await svc(pg, sw('qwen')).text('x', { provider: 'kimi' })).toBe('k');
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(event(pg)).toMatchObject({ provider: 'kimi', selected: 'kimi', choice: 'user' });
  });

  it('noFallback без provider (проба мониторинга) — Claude, рубильник не читается', async () => {
    const global = sw('qwen');
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, global).text('x', { noFallback: true })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(global.get).not.toHaveBeenCalled();
  });

  it('noFallback с provider qwen (ход гостя) — только Qwen: его сбой — ошибка, Claude не пробуется', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const s = svc(undefined, sw('claude'));
    await expect(s.text('x', { provider: 'qwen', noFallback: true })).rejects.toThrow(/401/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-sp-test');
    // Сбой доступа выбранного — его окно «не отвечает»; окно Claude не трогается.
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
    expect(s.fallbackStats().breakerOpenUntil).toBe(0);
  });

  it('noFallback с provider kimi без ключа — Claude, один запуск', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc().text('x', { provider: 'kimi', noFallback: true })).toBe('c');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBeUndefined();
  });

  it('рубильник Qwen, Qwen упал по доступу — ответ Claude (обычный путь), Qwen «не отвечает»', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const s = svc(undefined, sw('qwen'));
    expect(await s.text('x')).toBe('c');
    expect(tokenOf(0)).toBe('sk-sp-test');
    expect(tokenOf(1)).toBeUndefined();
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
  });

  it('рубильник Kimi без ключа — предупреждение «для всех» и обычный путь', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, sw('kimi')).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Kimi выбран для всех \(рубильник\).*KIMI_FALLBACK_API_KEY/);
  });

  it('сервис рубильника бросает — Claude', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    const broken = { get: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await svc(undefined, broken).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
  });

  it('без сервиса рубильника — как раньше: Claude', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc().text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
  });
});
```

В `src/common/services/claude-cli.chain.spec.ts` тест `'noFallback с provider kimi — только Claude, selected в событии нет (пробы выбору не следуют)'` заменить на:

```ts
  it('noFallback с provider kimi — только Kimi (ход гостя): один запуск, selected kimi', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('k')));
    expect(await new ClaudeCliService(pg as any).text('x', { provider: 'kimi', noFallback: true })).toBe('k');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(event(pg)).toMatchObject({ provider: 'kimi', fallback: false, selected: 'kimi', choice: 'user' });
  });
```

В `src/common/services/claude-cli.forced-qwen.spec.ts` тест `'noFallback побеждает: проба — только Claude'` заменить двумя:

```ts
  it('noFallback с provider — только эта модель (ход гостя), без цепочки', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await new ClaudeCliService().text('x', { provider: 'qwen', noFallback: true })).toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(hasEnv(0)).toBe(true);
  });

  it('noFallback без provider (проба мониторинга) — только Claude', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('claude')));
    await new ClaudeCliService().text('x', { noFallback: true });
    expect(hasEnv(0)).toBe(false);
  });
```

- [ ] **Шаг 2: красный прогон.** Коммит `test(llm): ClaudeCliService и рубильник (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern="src/common/services/claude-cli" 2>&1 | tail -40'`
Expected: FAIL — рубильник не применяется (`tokenOf(0)` undefined в первом тесте), `noFallback с provider kimi` получает Claude.

- [ ] **Шаг 3: реализация** в `src/common/services/claude-cli.service.ts`:

1. Импорты: `import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';`, добавить `import { GlobalLlmProviderService } from './global-llm-provider.service';` и `FallbackConfigs` в список импорта из `./llm-fallback`.
2. В `ClaudeCliOptions` заменить поля `noFallback` и `provider` (вместе с их комментариями) на:

```ts
  /** Без цепочки (spec 2026-10-31-global-llm-switch, раздел 3): без provider —
   *  только Claude (проверки живости Claude: с запасными они показывали бы
   *  «зелёный», когда Claude лежит; общий рубильник к ним не применяется); с
   *  provider — только эта модель (ход гостя пробы). Сбой такого вызова окно
   *  Claude не открывает, успех — закрывает. */
  noFallback?: boolean;
  /** Чья модель: личный выбор пользователя (админка, UserLlmProviderService) —
   *  в том числе явный 'claude', к нему общий рубильник не применяется. Не
   *  задан — модель общего рубильника (GlobalLlmProviderService). Выбранный
   *  запасной — сразу он, при его сбое — обычный путь (Claude, затем запасные
   *  без него; spec 2026-10-31-kimi-provider-design.md). Не авария: окно Claude
   *  и аварийные счётчики он не трогает. Без ключа — обычный путь. */
  provider?: AnswerProvider;
```

3. Конструктор:

```ts
  constructor(
    private readonly pg?: PgService,
    // Общий рубильник модели (spec 2026-10-31-global-llm-switch). Optional:
    // тесты и сборки без него работают как раньше — Claude.
    @Optional() private readonly globalProvider?: GlobalLlmProviderService,
  ) {}
```

4. В начале `runRaw` заменить блок от `const configs = opts.noFallback ? NO_FALLBACK_CONFIGS : readFallbackConfigs();` до `const plan = planProviders(...)` включительно на:

```ts
    // Чья модель (spec 2026-10-31-global-llm-switch, разделы 1 и 3): вызывающий
    // выбрал сам (provider, в том числе явный 'claude') — его выбор; не выбрал и
    // это не проба — общий рубильник; проба мониторинга (noFallback без
    // provider) — Claude.
    const fromSwitch = opts.provider === undefined && !opts.noFallback;
    const requested: AnswerProvider = fromSwitch ? await this.switchProvider() : (opts.provider ?? 'claude');
    const all = readFallbackConfigs();
    // Проверка через FALLBACK_ORDER.includes, не all[...] и не `in`: имя из
    // прототипа объекта (например 'constructor') резолвится правдой по цепочке
    // прототипов — тот же случай отсекает planProviders.
    const chosen: FallbackProvider | undefined =
      requested !== 'claude' && FALLBACK_ORDER.includes(requested as FallbackProvider)
        ? (requested as FallbackProvider)
        : undefined;
    // Для события claude_cli_call: чей это выбор — только рядом с selected.
    const choice: 'user' | 'global' | undefined = chosen ? (fromSwitch ? 'global' : 'user') : undefined;
    // Выбор, по которому идёт вызов, — только с ключом: сразу выбранный, при его
    // сбое — обычный путь (у noFallback — ошибка). По нему же — аварийность
    // попытки, текст ошибки и метки логов.
    let selected: FallbackProvider | undefined;
    if (chosen && all[chosen]) selected = chosen;
    else if (chosen) {
      const who = choice === 'global' ? 'для всех (рубильник)' : 'для пользователя';
      this.logger.warn(`${PROVIDER_LABELS[chosen]} выбран ${who}, но ключ ${PROVIDER_DEFAULTS[chosen].envPrefix}_FALLBACK_API_KEY не задан — обычный путь`);
    }
    // noFallback — ни аварийной цепочки, ни окна Claude: в конфигах только
    // выбранная модель (ход гостя) или никого (проба).
    const configs: FallbackConfigs = opts.noFallback
      ? (selected ? { ...NO_FALLBACK_CONFIGS, [selected]: all[selected] } : NO_FALLBACK_CONFIGS)
      : all;
    const plan = planProviders({ selected, configs, state: this.fallback, noFallback: opts.noFallback });
```

5. В цикле `runRaw` вызов `runOnce` — добавить `choice` в мету:

```ts
        res = await this.runOnce(prompt, attemptOpts, p === 'claude' ? null : configs[p], { fallback: emergency, selected: chosen, choice });
```

6. Тип меты в сигнатурах `runOnce` и `spawnClaude` — `meta: { fallback: boolean; selected?: FallbackProvider; choice?: 'user' | 'global' }`; в `trackCallEvent` — поле опций `choice?: 'user' | 'global';` и в `JSON.stringify({...})` строка `choice: opts.choice,` сразу после `selected: opts.selected,`; в двух вызовах `this.trackCallEvent({ … })` (stream-json и json) — строка `choice: meta.choice,` после `selected: meta.selected,`.

7. Новый приватный метод (рядом с `attemptLabel`):

```ts
  /** Модель общего рубильника; без сервиса и при его сбое — Claude. */
  private async switchProvider(): Promise<AnswerProvider> {
    if (!this.globalProvider) return 'claude';
    try {
      return await this.globalProvider.get();
    } catch (e: any) {
      this.logger.warn(`рубильник модели не прочитан: ${e?.message}`);
      return 'claude';
    }
  }
```

- [ ] **Шаг 4: зелёный прогон** — та же команда + `timeout 200 npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?`. Expected: все наборы `claude-cli*` PASS, `tsc_build=0`.
- [ ] **Шаг 5: коммит** `feat(llm): ClaudeCliService подставляет общий рубильник вызовам без выбора` — `git add src/common/services/claude-cli.service.ts src/common/services/claude-cli.global-switch.spec.ts src/common/services/claude-cli.chain.spec.ts src/common/services/claude-cli.forced-qwen.spec.ts`.

---

## Задача 4. `UserLlmProviderService`: «Как у всех», явный Claude, `route()`

**Files:**
- Modify: `src/common/services/user-llm-provider.service.ts`
- Modify: `src/common/services/user-llm-provider.service.spec.ts`

- [ ] **Шаг 1: тесты.** В `user-llm-provider.service.spec.ts`:
  - фабрику `mk` дополнить вторым аргументом: `const mk = (impl, global?: any) => { const query = …; return { svc: new UserLlmProviderService({ query } as any, global), query }; };`
  - в тестах `'get: NULL — claude'`, `'get: нет пользователя — claude'`, `'get: сбой БД — claude, без исключения'`, `'get: пустой userId — claude без запроса'` ожидание `'claude'` → `'default'`, в названиях «claude» → «default»;
  - тест `'set claude — пишет NULL'` заменить двумя:

```ts
  it('set claude — пишет claude (явный выбор)', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('u-1', 'claude');
    expect(query.mock.calls[0][1]).toEqual(['u-1', 'claude']);
  });

  it('set default — пишет NULL («Как у всех»)', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('u-1', 'default');
    expect(query.mock.calls[0][1]).toEqual(['u-1', null]);
  });

  it('get: claude в базе — claude', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'claude' }] }));
    expect(await svc.get('u-1')).toBe('claude');
  });

  it('route: личный выбор — он, choice user; рубильник не читается', async () => {
    const global = { get: jest.fn(async () => 'qwen') };
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'claude' }] }), global);
    expect(await svc.route('u-1')).toEqual({ provider: 'claude', choice: 'user' });
    expect(global.get).not.toHaveBeenCalled();
  });

  it('route: «Как у всех» — модель рубильника, choice global', async () => {
    const global = { get: jest.fn(async () => 'qwen') };
    const { svc } = mk(() => ({ rows: [{ llm_provider: null }] }), global);
    expect(await svc.route('u-1')).toEqual({ provider: 'qwen', choice: 'global' });
  });

  it('route: «Как у всех» без сервиса рубильника — claude, choice global', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.route('u-1')).toEqual({ provider: 'claude', choice: 'global' });
  });
```

- [ ] **Шаг 2: красный прогон.** Коммит `test(llm): «Как у всех» и route() (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern=src/common/services/user-llm-provider 2>&1 | tail -30'`
Expected: FAIL — `get` отдаёт `'claude'` вместо `'default'`, `route` не существует.

- [ ] **Шаг 3: реализация** — `src/common/services/user-llm-provider.service.ts` целиком:

```ts
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PgService } from './pg.service';
import { ANSWER_PROVIDERS, AnswerProvider, isAnswerProvider } from './llm-fallback';
import { GlobalLlmProviderService } from './global-llm-provider.service';

/** Модель ответов: 'claude', 'qwen' или 'kimi'. */
export type LlmProvider = AnswerProvider;
export const LLM_PROVIDERS: readonly LlmProvider[] = ANSWER_PROVIDERS;

/** Личный выбор в карточке: 'default' — «Как у всех» (NULL в базе), иначе модель. */
export type LlmChoice = 'default' | AnswerProvider;
export const LLM_CHOICES: readonly LlmChoice[] = ['default', ...ANSWER_PROVIDERS];

export function isLlmChoice(v: unknown): v is LlmChoice {
  return v === 'default' || isAnswerProvider(v);
}

/** Чем отвечать человеку: модель и чей это выбор (null — проба, выбора нет). */
export interface AnswerRoute {
  provider: AnswerProvider;
  choice: 'user' | 'global' | null;
}

/**
 * Модель ответов ассистентов для конкретного человека (spec
 * 2026-10-30-llm-provider-switch, 2026-10-31-global-llm-switch).
 * NULL — «Как у всех» (общий рубильник), 'claude' / 'qwen' / 'kimi' — явный
 * личный выбор, рубильник к нему не применяется.
 *
 * Отдельная колонка, а не ключ profile_data: profile_data пишет сам
 * пользователь через обновление профиля, а этот выбор тратит квоту владельца —
 * его меняет только админка.
 */
@Injectable()
export class UserLlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(UserLlmProviderService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly globalProvider?: GlobalLlmProviderService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const exists = await this.pg.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_profiles_consolidated' AND column_name = 'llm_provider'",
      );
      if (exists.rows.length > 0) return;
      await this.pg.query('ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS llm_provider text');
    } catch (e: any) {
      this.logger.warn(`llm_provider: колонка не добавлена: ${e?.message}`);
    }
  }

  /** Личный выбор; NULL, мусор, нет пользователя и сбой БД — «Как у всех». */
  async get(userId: string): Promise<LlmChoice> {
    if (!userId) return 'default';
    try {
      const r = await this.pg.query('SELECT llm_provider FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      const v = r.rows[0]?.llm_provider;
      return isAnswerProvider(v) ? v : 'default';
    } catch (e: any) {
      this.logger.warn(`llm_provider: не прочитан для ${userId}: ${e?.message}`);
      return 'default';
    }
  }

  /**
   * false — такого пользователя нет. 'default' и незнакомое значение пишутся
   * как NULL («Как у всех») — колонку не засоряет мусором ни один вызывающий.
   */
  async set(userId: string, choice: LlmChoice): Promise<boolean> {
    const value = isAnswerProvider(choice) ? choice : null;
    const r = await this.pg.query(
      'UPDATE ai_profiles_consolidated SET llm_provider = $2 WHERE user_id = $1',
      [userId, value],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Чем отвечать человеку: личный выбор, иначе общий рубильник. */
  async route(userId: string): Promise<AnswerRoute> {
    const mine = await this.get(userId);
    if (mine !== 'default') return { provider: mine, choice: 'user' };
    const provider = this.globalProvider ? await this.globalProvider.get() : 'claude';
    return { provider, choice: 'global' };
  }
}
```

- [ ] **Шаг 4: зелёный прогон** той же командой. Expected: PASS. (`tsc` — после Задачи 5: здесь меняется тип `get`, вызывающие поправятся там.)
- [ ] **Шаг 5: коммит** `feat(llm): личный выбор — «Как у всех», явный Claude и route()` — `git add src/common/services/user-llm-provider.service.ts src/common/services/user-llm-provider.service.spec.ts`.

---

## Задача 5. `resolveAnswerProvider` отдаёт маршрут; места вызова

**Files:**
- Modify: `src/chat/answer-provider.ts`, `src/chat/answer-provider.spec.ts`
- Modify: `src/chat/chat.service.ts` (~1231, ~1248, ~1789, ~1847, ~2020)
- Modify: `src/chat/chat.controller.ts` (~301, ~326)
- Modify: `src/tg-bot/tg-router.service.ts` (~700, ~704)
- Modify (тесты-моки): `src/chat/chat.service.llm-provider.spec.ts`, `src/chat/chat.upload-llm-provider.spec.ts`, `src/chat/chat.service.masha-provider.spec.ts`, `src/tg-bot/tg-router.model.spec.ts`

- [ ] **Шаг 1: тесты `answer-provider.spec.ts`.** Блоки `resolveAnswerProvider` и `cliProviderOption` заменить на:

```ts
describe('resolveAnswerProvider', () => {
  const svc = (provider: 'claude' | 'qwen' | 'kimi', choice: 'user' | 'global' = 'user') =>
    ({ route: jest.fn(async () => ({ provider, choice })) });

  it('маршрут из сервиса: личный выбор', async () => {
    expect(await resolveAnswerProvider(false, 'u1', svc('qwen') as any)).toEqual({ provider: 'qwen', choice: 'user' });
  });
  it('маршрут из сервиса: рубильник', async () => {
    expect(await resolveAnswerProvider(false, 'u1', svc('kimi', 'global') as any)).toEqual({ provider: 'kimi', choice: 'global' });
  });
  it('проба — всегда claude, choice null, настройку не читает', async () => {
    const s = svc('qwen');
    expect(await resolveAnswerProvider(true, 'u1', s as any)).toEqual({ provider: 'claude', choice: null });
    expect(s.route).not.toHaveBeenCalled();
  });
  it('нет сервиса — claude, choice null', async () => {
    expect(await resolveAnswerProvider(false, 'u1', undefined)).toEqual({ provider: 'claude', choice: null });
  });
  it('нет userId — маршрут для пустого id (рубильник)', async () => {
    const s = svc('qwen', 'global');
    expect(await resolveAnswerProvider(false, '', s as any)).toEqual({ provider: 'qwen', choice: 'global' });
    expect(s.route).toHaveBeenCalledWith('');
  });
});

describe('cliProviderOption', () => {
  it('личный Claude — явно claude (рубильник не применится)', () =>
    expect(cliProviderOption({ provider: 'claude', choice: 'user' })).toEqual({ provider: 'claude' }));
  it('личный kimi', () => expect(cliProviderOption({ provider: 'kimi', choice: 'user' })).toEqual({ provider: 'kimi' }));
  it('рубильник — без поля (ClaudeCliService применит его сам)', () =>
    expect(cliProviderOption({ provider: 'qwen', choice: 'global' })).toEqual({}));
  it('проба — без поля', () => expect(cliProviderOption({ provider: 'claude', choice: null })).toEqual({}));
});
```

Блоки `relayProviderFields` и `readDoneProvider` — без изменений.

- [ ] **Шаг 2: тесты мест вызова.**
  - `chat.service.llm-provider.spec.ts`: сигнатура `function harness(choice, events = [...], routeChoice: 'user' | 'global' = 'user')`, мок `const llmProvider = { route: jest.fn(async () => ({ provider: choice, choice: routeChoice })) };`; во всех ожиданиях `h.llmProvider.get` → `h.llmProvider.route`. Новый тест в первый `describe`:

```ts
  it('«Как у всех» при рубильнике Qwen — provider=qwen; в chat_quality selected qwen и choice global', async () => {
    const h = harness('qwen', undefined, 'global');
    await h.run();
    expect(h.fields().provider).toBe('qwen');
    expect(h.quality()).toMatchObject({ selected: 'qwen', choice: 'global' });
  });
```

  (`undefined` вторым аргументом подставляет события по умолчанию.)
  - `chat.upload-llm-provider.spec.ts`: в `upload(choice)` мок `const llmProvider = { route: jest.fn(async () => ({ provider: choice, choice: 'user' })) };`, ожидания `llmProvider.get` → `llmProvider.route`.
  - `chat.service.masha-provider.spec.ts`: `makeService(choice)` → `makeService(choice, routeChoice: 'user' | 'global' = 'user')`, мок — `const llmProvider = { route: jest.fn(async () => ({ provider: choice, choice: routeChoice })) };`. Три теста `describe('Маша (локальный CLI)…')` заменить на:

```ts
  it('выбран Kimi — в опциях CLI provider: kimi', async () => {
    const { svc, claudeCli, llmProvider } = makeService('kimi');
    await runMasha(svc);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('kimi');
    expect(llmProvider.route).toHaveBeenCalledWith(USER);
  });

  it('личный Claude — provider claude явно (рубильник к нему не применяется)', async () => {
    const { svc, claudeCli } = makeService('claude');
    await runMasha(svc);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('claude');
  });

  it('«Как у всех» — provider не задан (рубильник применит ClaudeCliService)', async () => {
    const { svc, claudeCli } = makeService('qwen', 'global');
    await runMasha(svc);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBeUndefined();
  });

  it('проба мониторинга — выбор не читается, provider не задан', async () => {
    const { svc, claudeCli, llmProvider } = makeService('kimi');
    await runMasha(svc, true);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBeUndefined();
    expect(llmProvider.route).not.toHaveBeenCalled();
  });
```

  - `tg-router.model.spec.ts`: три теста про выбор владельца (`'владелец выбрал Qwen…'`, `'без выбора — provider не задан'`, `'владелец выбрал Kimi…'`) заменить на:

```ts
  it('владелец выбрал Qwen — основной ход с provider: qwen', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { route: jest.fn(async () => ({ provider: 'qwen', choice: 'user' })) };
    await svc.generateReply({ ...cfg, owner_user_id: 'u-owner' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('qwen');
  });

  it('владелец «Как у всех» — provider не задан (рубильник применит ClaudeCliService)', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { route: jest.fn(async () => ({ provider: 'qwen', choice: 'global' })) };
    await svc.generateReply({ ...cfg, owner_user_id: 'u-owner' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBeUndefined();
  });

  it('владелец выбрал Claude явно — provider claude', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { route: jest.fn(async () => ({ provider: 'claude', choice: 'user' })) };
    await svc.generateReply({ ...cfg, owner_user_id: 'u-owner' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('claude');
  });

  it('владелец выбрал Kimi — основной ход с provider: kimi', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { route: jest.fn(async () => ({ provider: 'kimi', choice: 'user' })) };
    await svc.generateReply({ ...cfg, owner_user_id: 'u-owner' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('kimi');
  });
```

- [ ] **Шаг 3: красный прогон.** Коммит `test(llm): маршрут модели в чате, Маше, загрузке и TG (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern="src/(chat/(answer-provider|chat.service.llm-provider|chat.service.masha-provider|chat.upload-llm-provider)|tg-bot/tg-router.model)" 2>&1 | tail -40'`
Expected: FAIL — `route is not a function` / неверная форма результата.

- [ ] **Шаг 4: реализация.** `src/chat/answer-provider.ts` целиком:

```ts
import { isAnswerProvider } from '../common/services/llm-fallback';
import type { AnswerProvider } from '../common/services/llm-fallback';
import type { AnswerRoute, LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Через какую модель отвечать человеку (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-global-llm-switch): личный выбор в карточке, иначе общий
 * рубильник. Пробы мониторинга — всегда Claude: они меряют его, а не настройку.
 */
export async function resolveAnswerProvider(
  probe: boolean,
  userId: string | null | undefined,
  svc?: Pick<UserLlmProviderService, 'route'>,
): Promise<AnswerRoute> {
  if (probe || !svc) return { provider: 'claude', choice: null };
  return svc.route(userId ?? '');
}

/** Поля формы запроса к релею: проба — только Claude, выбор Qwen/Kimi — provider.
 *  У релея своего рубильника нет — модель приходит в каждом запросе. */
export function relayProviderFields(probe: boolean, provider: LlmProvider): Record<string, string> {
  if (probe) return { noFallback: '1' };
  return provider === 'claude' ? {} : { provider };
}

/** Выбор для ClaudeCliService (Маша, TG): личный — явно, в том числе Claude
 *  (рубильник к нему не применяется); рубильник и проба — без поля: рубильник
 *  ClaudeCliService применит сам, а проба идёт с noFallback. */
export function cliProviderOption(route: AnswerRoute): { provider?: AnswerProvider } {
  return route.choice === 'user' ? { provider: route.provider } : {};
}

/** Чем ответил релей — из события done (старый релей полей не шлёт). */
export function readDoneProvider(ev: any): { provider?: LlmProvider; fallback: boolean } {
  return { provider: isAnswerProvider(ev?.provider) ? ev.provider : undefined, fallback: ev?.fallback === true };
}
```

  `src/chat/chat.service.ts`:
  - ~1230: комментарий и строку заменить на

```ts
        // Модель ответов: личный выбор (админка) или общий рубильник; проба — только Claude.
        const mashaRoute = await resolveAnswerProvider(probe, userId, this.llmProvider);
```

    и ~1248 `...cliProviderOption(mashaProvider),` → `...cliProviderOption(mashaRoute),`;
  - ~1788: комментарий и строку заменить на

```ts
    // Модель ответов: личный выбор или общий рубильник — релей сразу идёт к ней; проба — только Claude.
    const answerRoute = await resolveAnswerProvider(probe, userId, this.llmProvider);
```

  - ~1846 в props `chat_quality` строки про `selected` заменить на

```ts
            // Выбор (не Claude) — личный или рубильник (choice); «выбранный подвёл» — selected ≠ provider.
            selected: answerRoute.provider === 'claude' ? undefined : answerRoute.provider,
            choice: answerRoute.provider === 'claude' ? undefined : (answerRoute.choice ?? undefined),
```

  - ~2020: `relayProviderFields(probe, answerProvider)` → `relayProviderFields(probe, answerRoute.provider)`.
  - Проверить грепом, что `answerProvider` и `mashaProvider` в файле больше не встречаются: `grep -n -E "\banswerProvider\b|\bmashaProvider\b" src/chat/chat.service.ts` — пусто.

  `src/chat/chat.controller.ts`: `const answerProvider = await resolveAnswerProvider(false, userId, this.llmProvider);` → `const answerRoute = await resolveAnswerProvider(false, userId, this.llmProvider);`, а `relayProviderFields(false, answerProvider)` → `relayProviderFields(false, answerRoute.provider)`.

  `src/tg-bot/tg-router.service.ts`: `const ownerProvider = await resolveAnswerProvider(false, cfg.owner_user_id, this.llmProvider);` → `const ownerRoute = …`, `...cliProviderOption(ownerProvider),` → `...cliProviderOption(ownerRoute),`; комментарий над ней: `// Модель ответов владельца бота: личный выбор или общий рубильник (spec 2026-10-31-global-llm-switch).`

- [ ] **Шаг 5: зелёный прогон** той же командой + `timeout 200 npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?`. Expected: PASS, `tsc_build=0`.
- [ ] **Шаг 6: коммит** `feat(llm): маршрут модели — личный выбор или рубильник; Маша, чат, загрузка, TG` — поимённо все изменённые файлы задачи.

---

## Задача 6. Автоблог, clean-ask и `agentReply` — модель в запросе к релею

**Files:**
- Modify: `src/blog/blog-relay.client.ts`, `src/blog/blog-relay.client.spec.ts`
- Modify: `src/ask/clean-ask.service.ts`, `src/ask/clean-ask.service.spec.ts`
- Modify: `src/chat/chat.service.ts` (`agentReply`, ~2627–2700)
- Create: `src/chat/chat.service.agent-reply-provider.spec.ts`

`agentReply` (через `generateAgentReply` и `generateAgentReplyWithCharge`) зовут рутины (`routine-push`), план действий (`chat/action-plans`), поездки (`trip`), итоги, документы и задания специалистам в звонках (`voice-call/*`) и проба качества (`monitoring/quality-monitor`). Сейчас этот путь не передаёт модель вовсе — не действует даже личный выбор.

- [ ] **Шаг 1: тесты.** В конец `src/blog/blog-relay.client.spec.ts`:

```ts
import axios from 'axios';
import { Readable } from 'stream';
import { BlogRelayClient } from './blog-relay.client';

jest.mock('axios');

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

describe('BlogRelayClient: модель общего рубильника (spec 2026-10-31-global-llm-switch)', () => {
  const post = axios.post as jest.Mock;
  beforeEach(() => {
    post.mockReset();
    post.mockImplementation(async () => ({ data: Readable.from(['data: {"type":"delta","text":"пост"}\n\n']) }));
  });

  it('рубильник Qwen — provider=qwen', async () => {
    const c = new BlogRelayClient({ get: jest.fn(async () => 'qwen') } as any);
    expect(await c.ask('sys', 'msg', 's-1')).toBe('пост');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBe('qwen');
  });

  it('рубильник Claude — без provider', async () => {
    const c = new BlogRelayClient({ get: jest.fn(async () => 'claude') } as any);
    await c.ask('sys', 'msg', 's-1');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBeUndefined();
  });

  it('без сервиса рубильника — без provider', async () => {
    await new BlogRelayClient().ask('sys', 'msg', 's-1');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBeUndefined();
  });
});
```

(Если в файле уже есть `import`-строки в начале — новые импорты поднять наверх; `jest.mock('axios')` jest поднимает сам. Существующие тесты `collectRelayText` axios не трогают.)

В `src/ask/clean-ask.service.spec.ts` — новый `describe` в конце (импорты `axios`, `Readable`, `jest.mock('axios')` и функцию `fieldsOf` — как выше, наверх файла):

```ts
describe('CleanAskService: модель общего рубильника в запросе к релею', () => {
  const post = axios.post as jest.Mock;
  beforeEach(() => {
    post.mockReset();
    post.mockImplementation(async () => ({ data: Readable.from(['data: {"type":"delta","text":"ок"}\n']) }));
  });

  it('рубильник Kimi — provider=kimi', async () => {
    const svc = new CleanAskService({} as any, { get: jest.fn(async () => 'kimi') } as any);
    expect(await (svc as any).callRelay('вопрос')).toBe('ок');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBe('kimi');
  });

  it('рубильник Claude — без provider', async () => {
    const svc = new CleanAskService({} as any, { get: jest.fn(async () => 'claude') } as any);
    await (svc as any).callRelay('вопрос');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBeUndefined();
  });
});
```

Если `callRelay` после чтения потока делает `trim`/склейку иначе и тест на `'ок'` не проходит по тексту — проверять только поля запроса (поле `provider` — суть теста).

Новый файл `src/chat/chat.service.agent-reply-provider.spec.ts` (заготовка — как `describe('agentReply: …')` в `chat.service.linkeon-fields.spec.ts`):

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/** agentReply: модель ответов — личный выбор или общий рубильник (spec 2026-10-31-global-llm-switch, раздел 4). */

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

const realSetTimeout = global.setTimeout;
beforeAll(() => {
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => { (global as any).setTimeout = realSetTimeout; });
beforeEach(() => jest.clearAllMocks());

const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };
function replyHarness(route?: { provider: 'claude' | 'qwen' | 'kimi'; choice: 'user' | 'global' }) {
  const pg = { query: jest.fn(async (sql: string) => (/FROM agents WHERE id/.test(sql) ? { rows: [AGENT] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
  if (route) (svc as any).llmProvider = { route: jest.fn(async () => route) };
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
  const last = () => fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
  return { svc, last };
}

describe('agentReply: модель в запросе к релею', () => {
  it('«Как у всех» при рубильнике Qwen — provider=qwen', async () => {
    const { svc, last } = replyHarness({ provider: 'qwen', choice: 'global' });
    await svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_1');
    expect(last().provider).toBe('qwen');
    expect(last().noFallback).toBeUndefined();
  });

  it('личный Kimi — provider=kimi (и со списанием)', async () => {
    const { svc, last } = replyHarness({ provider: 'kimi', choice: 'user' });
    await svc.generateAgentReplyWithCharge('u-1', '12', 'вопрос', 'voice_12_1');
    expect(last().provider).toBe('kimi');
  });

  it('личный Claude — без provider', async () => {
    const { svc, last } = replyHarness({ provider: 'claude', choice: 'user' });
    await svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_2');
    expect(last().provider).toBeUndefined();
  });

  it('без сервиса выбора — без provider (как раньше)', async () => {
    const { svc, last } = replyHarness();
    await svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_3');
    expect(last().provider).toBeUndefined();
  });
});
```

Если `generateAgentReplyWithCharge` в этом окружении требует ещё зависимостей (списание) и падает до запроса — в тесте про Kimi использовать `generateAgentReply`: суть теста — поле `provider`.

- [ ] **Шаг 2: красный прогон.** Коммит `test(llm): автоблог, clean-ask и agentReply — модель в запросе к релею (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern="src/(blog/blog-relay.client|ask/clean-ask|chat/chat.service.agent-reply-provider)" 2>&1 | tail -30'`
Expected: FAIL — поля `provider` нет.

- [ ] **Шаг 3: реализация.**

`src/blog/blog-relay.client.ts`: импорты `import { Injectable, Logger, Optional } from '@nestjs/common';`, `import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';`, `import { relayProviderFields } from '../chat/answer-provider';`. В класс:

```ts
  constructor(
    // Общий рубильник модели (spec 2026-10-31-global-llm-switch): фоновые
    // посты автоблога идут через модель рубильника. Optional — для тестов.
    @Optional() private readonly globalProvider?: GlobalLlmProviderService,
  ) {}
```

и в `ask()` сразу после `fd.append('sessionId', sessionId);`:

```ts
    const provider = this.globalProvider ? await this.globalProvider.get() : 'claude';
    for (const [k, v] of Object.entries(relayProviderFields(false, provider))) fd.append(k, v);
```

`src/ask/clean-ask.service.ts`: конструктор

```ts
  constructor(
    private readonly agents: AgentsService,
    // Общий рубильник модели (spec 2026-10-31-global-llm-switch). Optional — для тестов.
    @Optional() private readonly globalProvider?: GlobalLlmProviderService,
  ) {}
```

(импорт `Optional` из `@nestjs/common`, `GlobalLlmProviderService` из `../common/services/global-llm-provider.service`, `relayProviderFields` из `../chat/answer-provider`); в `callRelay` сразу после `fd.append('sessionId', \`anon_${randomUUID()}\`);`:

```ts
    const provider = this.globalProvider ? await this.globalProvider.get() : 'claude';
    for (const [k, v] of Object.entries(relayProviderFields(false, provider))) fd.append(k, v);
```

`BlogModule` и `AskModule` уже импортируют `CommonModule` — сервис внедрится без правки модулей.

`src/chat/chat.service.ts`, `agentReply`: сразу после строки `fd.append('sessionId', relaySid);` вставить:

```ts
    // Модель ответов: личный выбор этого человека или общий рубильник (spec
    // 2026-10-31-global-llm-switch, раздел 4) — рутины, «Путь», план действий,
    // поездки, итоги и документы звонков, проба качества.
    const route = await resolveAnswerProvider(false, userId, this.llmProvider);
    for (const [k, v] of Object.entries(relayProviderFields(false, route.provider))) fd.append(k, v);
```

(`resolveAnswerProvider` и `relayProviderFields` в `chat.service.ts` уже импортированы.)

- [ ] **Шаг 4: зелёный прогон** — та же команда + `--testPathPattern="src/(blog|ask|chat/chat.service|routine-push|trip|chat/action-plans|monitoring/quality-monitor|voice-call)"` (модули и соседние тесты путей `agentReply`) + `tsc`. Expected: PASS, `tsc_build=0`.
- [ ] **Шаг 5: коммит** `feat(llm): автоблог, clean-ask и agentReply идут через личный выбор или рубильник` — поимённо 6 файлов.

---

## Задача 7. Проба без входа — модель рубильника без цепочки

**Files:**
- Modify: `src/guest-trial/guest-turn.service.ts` (конструктор ~98–106; проверка окна ~203–212; вызов модели ~272–290)
- Modify: `src/guest-trial/guest-turn.service.spec.ts` (`harness`)
- Modify: `src/guest-trial/guest-trial.module.spec.ts`

- [ ] **Шаг 1: тесты.** В `guest-turn.service.spec.ts`:
  - тип опций `harness`: `fallbackStats?: () => any;` и новое `global?: 'claude' | 'qwen' | 'kimi';`
  - сборка: `const global = opts.global ? { get: jest.fn(async () => opts.global) } : undefined;` и `new GuestTurnService(pg as any, redis as any, cli as any, store as any, sessions as any, chat as any, events as any, global as any)`;
  - новые тесты рядом с тестом про окно запасного пути:

```ts
  it('рубильник Qwen — гость идёт в Qwen без цепочки (provider qwen, noFallback)', async () => {
    const h = harness({
      global: 'qwen',
      fallbackStats: () => ({ breakerOpenUntil: 0, providers: { qwen: { enabled: true, downUntil: 0 }, kimi: { enabled: false, downUntil: 0 } } }),
    });
    await h.turn();
    expect(h.cli.textWithCost).toHaveBeenCalledTimes(1);
    expect(h.cli.textWithCost.mock.calls[0][1]).toMatchObject({ provider: 'qwen', providerChoice: 'global', noFallback: true });
  });

  it('рубильник Kimi без ключа — сразу error model, модель не зовётся', async () => {
    const h = harness({
      global: 'kimi',
      fallbackStats: () => ({ breakerOpenUntil: 0, providers: { qwen: { enabled: true, downUntil: 0 }, kimi: { enabled: false, downUntil: 0 } } }),
    });
    const { evs } = await h.turn();
    expect(evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_error', { props: { reason: 'breaker', assistant_id: '12', preview: false, provider: 'kimi' } });
  });

  it('рубильник Qwen «не отвечает» — сразу error model', async () => {
    const h = harness({
      global: 'qwen',
      fallbackStats: () => ({ breakerOpenUntil: 0, providers: { qwen: { enabled: true, downUntil: Date.now() + 60_000 }, kimi: { enabled: false, downUntil: 0 } } }),
    });
    const { evs } = await h.turn();
    expect(evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('рубильник Qwen при открытом окне Claude — гость всё равно идёт в Qwen', async () => {
    const h = harness({
      global: 'qwen',
      fallbackStats: () => ({ breakerOpenUntil: Date.now() + 60_000, providers: { qwen: { enabled: true, downUntil: 0 }, kimi: { enabled: false, downUntil: 0 } } }),
    });
    await h.turn();
    expect(h.cli.textWithCost).toHaveBeenCalledTimes(1);
  });

  it('рубильник Claude — как раньше: без provider, noFallback', async () => {
    const h = harness({ global: 'claude' });
    await h.turn();
    const o = h.cli.textWithCost.mock.calls[0][1];
    expect(o.noFallback).toBe(true);
    expect(o).not.toHaveProperty('provider');
  });
```

  В `guest-trial.module.spec.ts`, тест `'GuestTurnService объявляет ChatService и EventsService классами, не Object'` — добавить `expect(deps).toContain(GlobalLlmProviderService);` (импорт из `../common/services/global-llm-provider.service`) и в название — «и GlobalLlmProviderService».

- [ ] **Шаг 2: красный прогон.** Коммит `test(guest-trial): модель рубильника для гостя (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern=src/guest-trial 2>&1 | tail -30'`
Expected: FAIL — `provider` нет в опциях, проверка ключа отсутствует.

- [ ] **Шаг 3: реализация** в `src/guest-trial/guest-turn.service.ts`:

1. Импорты: `GlobalLlmProviderService` из `../common/services/global-llm-provider.service`, тип `AnswerProvider` из `../common/services/llm-fallback`.
2. Конструктор — последним параметром:

```ts
    // Общий рубильник модели (spec 2026-10-31-global-llm-switch, раздел 6).
    @Optional() private readonly globalProvider?: GlobalLlmProviderService,
```

3. Проверку окна (блок `if (this.claudeCli.fallbackStats().breakerOpenUntil > Date.now()) { … }`) заменить на:

```ts
      // Модель гостя — рубильник, без цепочки (решение 31.10). Она сейчас
      // недоступна (у Claude открыто его окно, у запасного нет ключа или он
      // «не отвечает») — гостю сразу ошибка, а не две минуты ожидания и
      // занятый слот.
      const trialProvider: AnswerProvider = this.globalProvider ? await this.globalProvider.get() : 'claude';
      if (this.providerUnavailable(trialProvider)) {
        this.startStream(res);
        this.write(res, guestEvent);
        this.write(res, { type: 'error', code: 'model' });
        this.end(res);
        this.events?.track('guest_trial_error', {
          props: {
            reason: 'breaker', assistant_id: String(agent.id), preview: input.preview,
            ...(trialProvider === 'claude' ? {} : { provider: trialProvider }),
          },
        });
        return;
      }
```

4. В вызове `this.claudeCli.textWithCost(...)` строки

```ts
            // Запасной Qwen гостям не положен: его квота — для платящих.
            noFallback: true,
```

заменить на

```ts
            // Без цепочки: только модель рубильника (решение 31.10); у Claude —
            // без provider, как раньше.
            noFallback: true,
            // providerChoice 'global': ответ гостя — по рубильнику (событие
            // claude_cli_call с choice=global, суточный счёт).
            ...(trialProvider === 'claude' ? {} : { provider: trialProvider, providerChoice: 'global' as const }),
```

5. Новый приватный метод класса:

```ts
  /** Модель рубильника сейчас недоступна гостю: у Claude — открыто его окно,
   *  у запасного — нет ключа или он «не отвечает». */
  private providerUnavailable(p: AnswerProvider, now: number = Date.now()): boolean {
    const s = this.claudeCli.fallbackStats(now);
    if (p === 'claude') return s.breakerOpenUntil > now;
    const st = s.providers?.[p];
    return !st?.enabled || st.downUntil > now;
  }
```

Переменная `trialProvider` объявлена до вызова модели — если вызов модели находится в другом методе, передать её туда параметром.

- [ ] **Шаг 4: зелёный прогон** той же командой + `tsc`. Expected: PASS (в том числе прежний тест «окно запасного пути на Qwen открыто — сразу error model» — у него рубильника нет, значит Claude), `tsc_build=0`.
- [ ] **Шаг 5: коммит** `feat(guest-trial): гость идёт через модель рубильника без цепочки` — поимённо 3 файла.

---

## Задача 8. Админ-ручки: рубильник и карточка

**Files:**
- Create: `src/common/global-llm-messages.ts`, `src/common/global-llm-messages.spec.ts`
- Create: `src/admin/admin-global-llm.controller.ts`, `src/admin/admin-global-llm.controller.spec.ts`
- Modify: `src/admin/admin.module.ts`
- Modify: `src/admin/admin-llm-provider.controller.ts`, `src/admin/admin-llm-provider.controller.spec.ts`

- [ ] **Шаг 1: тексты сообщений — тест** `src/common/global-llm-messages.spec.ts`:

```ts
import { mskStamp, reminderText, switchedText } from './global-llm-messages';

describe('тексты рубильника', () => {
  it('mskStamp — дд.мм чч:мм по Москве', () => {
    expect(mskStamp('2026-10-31T13:40:00Z')).toBe('31.10 16:40');
  });

  it('переключение на Qwen — с кем было и кто, подсказка как вернуть', () => {
    const t = switchedText('claude', 'qwen', 'admin-1');
    expect(t).toContain('Модель ответов для всех: Qwen');
    expect(t).toContain('было Claude');
    expect(t).toContain('Переключил: admin-1');
    expect(t).toContain('Админка → Ассистенты');
  });

  it('возврат на Claude — «все снова на Claude»', () => {
    expect(switchedText('qwen', 'claude', 'admin-1')).toContain('Все снова отвечают через Claude');
  });

  it('актор экранируется для HTML', () => {
    expect(switchedText('claude', 'qwen', '<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('напоминание: модель, с какого момента, дни, состояние Claude', () => {
    const t = reminderText({
      provider: 'qwen', since: '2026-10-29T07:00:00Z', now: new Date('2026-10-31T07:00:00Z'),
      claudeStatus: 'ok', claudeCheckedAt: '2026-10-31T06:45:00Z', keyMissing: false,
    });
    expect(t).toContain('Все отвечают через Qwen');
    expect(t).toContain('с 29.10 10:00');
    expect(t).toContain('(2 дн.)');
    expect(t).toContain('Claude по последней пробе: отвечает (31.10 09:45)');
    expect(t).not.toContain('ключа');
  });

  it('напоминание: Claude не отвечает; нет ключа — фактически Claude', () => {
    const t = reminderText({
      provider: 'kimi', since: null, now: new Date('2026-10-31T07:00:00Z'),
      claudeStatus: 'down', claudeCheckedAt: null, keyMissing: true,
    });
    expect(t).toContain('Claude по последней пробе: не отвечает');
    expect(t).toContain('Ключа Kimi на сервере нет — фактически отвечает Claude');
  });

  it('напоминание: нет данных пробы', () => {
    const t = reminderText({ provider: 'qwen', since: null, now: new Date(), claudeStatus: null, claudeCheckedAt: null, keyMissing: false });
    expect(t).toContain('Claude по последней пробе: нет данных');
  });

  it('напоминание: счёт за сутки — ответов через модель рубильника и сколько раз она не ответила', () => {
    const t = reminderText({
      provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false,
      day: { ok: 120, other: 3 },
    });
    expect(t).toContain('За сутки через Qwen: 120 ответов; не ответила (ответил другой) — 3');
  });

  it('напоминание: счёта нет (сбой запроса) — строки нет', () => {
    const t = reminderText({ provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false, day: null });
    expect(t).not.toContain('За сутки');
  });
});
```

- [ ] **Шаг 2: ручка рубильника — тест** `src/admin/admin-global-llm.controller.spec.ts`:

```ts
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AdminGlobalLlmController } from './admin-global-llm.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => undefined) }));
import { sendTelegramAlert } from '../common/telegram-alert';

const mkRes = () => { const res: any = {}; res.status = jest.fn(() => res); res.json = jest.fn(() => res); return res; };
const status = (provider: string) => ({ provider, since: '2026-10-31T13:40:00.000Z', by: 'admin-1' });

describe('AdminGlobalLlmController', () => {
  const OLD = { qwen: process.env.QWEN_FALLBACK_API_KEY, kimi: process.env.KIMI_FALLBACK_API_KEY };
  const keys = (qwen: boolean, kimi: boolean) => {
    if (qwen) process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test'; else delete process.env.QWEN_FALLBACK_API_KEY;
    if (kimi) process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test'; else delete process.env.KIMI_FALLBACK_API_KEY;
  };
  afterEach(() => {
    if (OLD.qwen === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD.qwen;
    if (OLD.kimi === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD.kimi;
    (sendTelegramAlert as jest.Mock).mockClear();
    jest.restoreAllMocks();
  });

  it('закрыт JwtGuard + AdminGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminGlobalLlmController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });

  it('GET: статус и ключи', async () => {
    keys(true, false);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn() };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).get(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ...status('qwen'), configured: { qwen: true, kimi: false } });
  });

  it('POST qwen: пишет с актором, лог, сообщение в группу, отдаёт новый статус', async () => {
    keys(true, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn(async () => ({ previous: 'claude' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(svc.set).toHaveBeenCalledWith('qwen', 'admin-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('admin-1: claude → qwen');
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('Модель ответов для всех: Qwen');
  });

  it('POST того же значения — без сообщения в группу', async () => {
    keys(true, false);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn(async () => ({ previous: 'qwen' })) };
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, mkRes());
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('POST kimi без ключа — 409 no_key, ничего не пишет', async () => {
    keys(true, false);
    const svc = { status: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'kimi' }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'no_key', provider: 'kimi' });
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST чужого значения — 400', async () => {
    const svc = { status: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'gpt' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "provider: 'claude' | 'qwen' | 'kimi'" });
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST claude — всегда можно (ключ не нужен)', async () => {
    keys(false, false);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('claude')), set: jest.fn(async () => ({ previous: 'qwen' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'claude' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Шаг 3: карточка — тест.** В `admin-llm-provider.controller.spec.ts`:
  - во всех `svc`-моках добавить `route: jest.fn(async () => ({ provider: 'claude', choice: 'global' }))` (в тестах, где выбор `'kimi'` — `route` отдаёт `{ provider: 'kimi', choice: 'user' }`);
  - конструктор — `new AdminLlmProviderController(svc as any, global as any)` с `const global = { get: jest.fn(async () => 'claude') }` (объявить в начале `describe`);
  - ожидания тел ответов дополнить полями `effective` и `global`: для `'kimi'` с ключом Kimi — `effective: 'kimi', global: 'claude'`; для `'kimi'` без ключа — `effective: 'claude'`; для «без ключей» с `'claude'` — `provider: 'claude', effective: 'claude', global: 'claude'`;
  - тест 400: ожидаемый текст — `"provider: 'default' | 'claude' | 'qwen' | 'kimi'"`;
  - новые тесты:

```ts
  it('GET: «Как у всех» при рубильнике Qwen — provider default, effective qwen, global qwen', async () => {
    keys(true, false);
    const svc = { get: jest.fn(async () => 'default'), set: jest.fn(), route: jest.fn(async () => ({ provider: 'qwen', choice: 'global' })) };
    const g = { get: jest.fn(async () => 'qwen') };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, g as any).get('u-1', res);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'default', effective: 'qwen', global: 'qwen', qwenConfigured: true, configured: { qwen: true, kimi: false },
    });
  });

  it('POST default — пишет «Как у всех»', async () => {
    keys(false, false);
    const svc = { get: jest.fn(), set: jest.fn(async () => true), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, { get: jest.fn(async () => 'claude') } as any).set('u-1', { userId: 'admin-1' }, { provider: 'default' }, res);
    expect(svc.set).toHaveBeenCalledWith('u-1', 'default');
    expect(res.status).toHaveBeenCalledWith(200);
  });
```

- [ ] **Шаг 4: красный прогон.** Коммит `test(llm): админ-ручки рубильника и карточки, тексты сообщений (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern="src/(common/global-llm-messages|admin/admin-(global-llm|llm-provider))" 2>&1 | tail -40'`
Expected: FAIL — модулей нет, поля `effective`/`global` отсутствуют.

- [ ] **Шаг 5: реализация.**

`src/common/global-llm-messages.ts`:

```ts
import { AnswerProvider, FallbackProvider, PROVIDER_LABELS } from './services/llm-fallback';

/** дд.мм чч:мм по Москве. */
export function mskStamp(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return d
    .toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .replace(',', '');
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Сообщение в группу алертов при переключении рубильника (spec 2026-10-31-global-llm-switch, раздел 8). */
export function switchedText(previous: AnswerProvider, next: AnswerProvider, actor: string): string {
  const head = `🔀 <b>Модель ответов для всех: ${PROVIDER_LABELS[next]}</b> (было ${PROVIDER_LABELS[previous]}).`;
  const tail = next === 'claude' ? 'Все снова отвечают через Claude.' : 'Вернуть — Админка → Ассистенты.';
  return `${head}\nПереключил: ${escapeHtml(actor)}. ${tail}`;
}

/** Суточное напоминание, пока рубильник не на Claude. */
export function reminderText(a: {
  provider: FallbackProvider;
  since: string | null;
  now: Date;
  claudeStatus: 'ok' | 'down' | null;
  claudeCheckedAt: string | null;
  keyMissing: boolean;
  /** Ответы за сутки по выбору рубильника (события chat_quality и claude_cli_call
   *  с choice=global): ok — ответила модель рубильника, other — она не ответила
   *  и ответил другой. Релей такие ходы в /health.fallback не считает (они «по
   *  выбору», не авария), поэтому без этой строки сбои модели рубильника не
   *  видны. null/нет — строки нет. */
  day?: { ok: number; other: number } | null;
}): string {
  const label = PROVIDER_LABELS[a.provider];
  const since = a.since
    ? ` с ${mskStamp(a.since)} (${Math.floor((a.now.getTime() - new Date(a.since).getTime()) / 86_400_000)} дн.)`
    : '';
  const claude = a.claudeStatus === 'ok' ? 'отвечает' : a.claudeStatus === 'down' ? 'не отвечает' : 'нет данных';
  const checked = a.claudeCheckedAt ? ` (${mskStamp(a.claudeCheckedAt)})` : '';
  const lines = [
    `⏰ <b>Все отвечают через ${label}</b>${since}.`,
    `Claude по последней пробе: ${claude}${checked}.`,
  ];
  if (a.day) lines.push(`За сутки через ${label}: ${a.day.ok} ответов; не ответила (ответил другой) — ${a.day.other}.`);
  if (a.keyMissing) lines.push(`Ключа ${label} на сервере нет — фактически отвечает Claude.`);
  lines.push('Вернуть — Админка → Ассистенты.');
  return lines.join('\n');
}
```

`src/admin/admin-global-llm.controller.ts`:

```ts
import { Body, Controller, Get, Logger, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { ANSWER_PROVIDERS, isAnswerProvider, readFallbackConfigs } from '../common/services/llm-fallback';
import { sendTelegramAlert } from '../common/telegram-alert';
import { switchedText } from '../common/global-llm-messages';

/**
 * Общий рубильник модели ответов (spec 2026-10-31-global-llm-switch, раздел 7).
 * Модель без ключа на сервере не выбирается (409 no_key): иначе рубильник
 * показывал бы Kimi, а отвечал бы Claude. Каждое переключение — лог и
 * сообщение в группу алертов.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminGlobalLlmController {
  private readonly logger = new Logger(AdminGlobalLlmController.name);

  constructor(private readonly global: GlobalLlmProviderService) {}

  @Get('admin/llm-provider')
  async get(@Res() res: Response) {
    const s = await this.global.status();
    return res.status(200).json({ ...s, configured: configured() });
  }

  @Post('admin/llm-provider')
  async set(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const provider = String(body?.provider ?? '');
    if (!isAnswerProvider(provider)) {
      return res.status(400).json({ error: `provider: ${ANSWER_PROVIDERS.map((p) => `'${p}'`).join(' | ')}` });
    }
    const cfg = configured();
    if (provider !== 'claude' && !cfg[provider]) {
      return res.status(409).json({ error: 'no_key', provider });
    }
    const actor = String(user?.userId ?? 'unknown');
    const { previous } = await this.global.set(provider, actor);
    this.logger.log(`llm_provider (все): ${actor}: ${previous} → ${provider}`);
    if (previous !== provider) {
      await sendTelegramAlert(switchedText(previous, provider, actor)).catch((e: any) =>
        this.logger.warn(`сообщение о рубильнике не отправлено: ${e?.message}`),
      );
    }
    const s = await this.global.status();
    return res.status(200).json({ ...s, configured: cfg });
  }
}

function configured(): { qwen: boolean; kimi: boolean } {
  const c = readFallbackConfigs();
  return { qwen: c.qwen !== null, kimi: c.kimi !== null };
}
```

`src/admin/admin.module.ts`: импорт `AdminGlobalLlmController` и добавление в `controllers` после `AdminLlmProviderController`.

`src/admin/admin-llm-provider.controller.ts` — заменить содержимое класса и импорты:

```ts
import { Body, Controller, Get, Logger, Optional, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { AnswerRoute, LLM_CHOICES, LlmChoice, UserLlmProviderService, isLlmChoice } from '../common/services/user-llm-provider.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { AnswerProvider, readFallbackConfigs } from '../common/services/llm-fallback';

/**
 * Модель ответов ассистентов по аккаунту (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-global-llm-switch). :userId — тот же идентификатор, что у
 * /webhook/admin/users/:phone/activity (телефон или UUID входа по почте).
 * provider — личный выбор ('default' — «Как у всех»); effective — чем человек
 * отвечает сейчас с учётом рубильника и ключей; global — модель рубильника
 * (для подписи «Как у всех (сейчас: …)»). qwenConfigured — прежнее поле.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminLlmProviderController {
  private readonly logger = new Logger(AdminLlmProviderController.name);

  constructor(
    private readonly providers: UserLlmProviderService,
    @Optional() private readonly global?: GlobalLlmProviderService,
  ) {}

  @Get('admin/users/:userId/llm-provider')
  async get(@Param('userId') userId: string, @Res() res: Response) {
    const choice = await this.providers.get(userId);
    return res.status(200).json(await this.body(userId, choice, await this.providers.route(userId)));
  }

  @Post('admin/users/:userId/llm-provider')
  async set(
    @Param('userId') userId: string,
    @CurrentUser() user: any,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const choice = String(body?.provider ?? '');
    if (!isLlmChoice(choice)) {
      return res.status(400).json({ error: `provider: ${LLM_CHOICES.map((p) => `'${p}'`).join(' | ')}` });
    }
    if (!(await this.providers.set(userId, choice))) {
      return res.status(404).json({ error: 'user not found' });
    }
    // Смена модели ответов тратит квоту владельца — оставляем след: кто и
    // кого переключил.
    const actor = user?.userId ?? 'unknown';
    this.logger.log(`llm_provider: ${actor} → ${userId} = ${choice}`);
    return res.status(200).json(await this.body(userId, choice, await this.providers.route(userId)));
  }

  private async body(userId: string, choice: LlmChoice, route: AnswerRoute) {
    const configs = readFallbackConfigs();
    const configured = { qwen: configs.qwen !== null, kimi: configs.kimi !== null };
    const usable = (p: AnswerProvider) => p === 'claude' || configured[p];
    const global: AnswerProvider = this.global ? await this.global.get() : 'claude';
    return {
      userId,
      provider: choice,
      effective: usable(route.provider) ? route.provider : 'claude',
      global,
      qwenConfigured: configured.qwen,
      configured,
    };
  }
}
```

Проверка грепом: `LLM_PROVIDERS` и `LlmProvider` из `user-llm-provider.service` где-то ещё используются (`grep -rn "LLM_PROVIDERS\|LlmProvider\b" src --include=*.ts | grep -v spec`) — экспорт оставлен, ничего не ломается.

- [ ] **Шаг 6: зелёный прогон** той же командой + `--testPathPattern=src/admin` целиком + `tsc`. Expected: PASS, `tsc_build=0`.
- [ ] **Шаг 7: коммит** `feat(llm): ручка общего рубильника, сообщения в группу, карточка — «Как у всех» и effective` — поимённо 7 файлов.

---

## Задача 9. Суточное напоминание

**Files:**
- Create: `src/monitoring/global-llm-reminder.service.ts`, `src/monitoring/global-llm-reminder.service.spec.ts`
- Modify: `src/monitoring/monitoring.module.ts`

- [ ] **Шаг 1: тест** `src/monitoring/global-llm-reminder.service.spec.ts`:

```ts
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => undefined) }));
import { sendTelegramAlert } from '../common/telegram-alert';
import { GlobalLlmReminderService } from './global-llm-reminder.service';

const health = (llmStatus: 'ok' | 'down' | null) => ({
  getOverview: jest.fn(async () => ({ usage: { llmStatus, llmCheckedAt: '2026-10-31T06:45:00Z' } })),
});
/** pg с суточным счётом ответов по выбору рубильника. */
const pgDay = (ok = 0, other = 0) => ({ query: jest.fn(async () => ({ rows: [{ ok, other }] })) });

describe('GlobalLlmReminderService', () => {
  const OLD = process.env.KIMI_FALLBACK_API_KEY;
  afterEach(() => {
    (sendTelegramAlert as jest.Mock).mockClear();
    if (OLD === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD;
  });

  it('рубильник на Claude — молчит', async () => {
    const g = { status: jest.fn(async () => ({ provider: 'claude', since: null, by: null })) };
    const pg = pgDay();
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    expect(await s.remind(new Date('2026-10-31T07:00:00Z'))).toBe(false);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('рубильник на Kimi без ключа — напоминание с пометкой «фактически Claude»', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: '2026-10-30T07:00:00Z', by: 'admin-1' })) };
    const s = new GlobalLlmReminderService(g as any, health('down') as any, pgDay() as any);
    expect(await s.remind(new Date('2026-10-31T07:00:00Z'))).toBe(true);
    const text = (sendTelegramAlert as jest.Mock).mock.calls[0][0];
    expect(text).toContain('Все отвечают через Kimi');
    expect(text).toContain('Claude по последней пробе: не отвечает');
    expect(text).toContain('фактически отвечает Claude');
  });

  it('счёт за сутки — по событиям с choice=global и selected модели рубильника', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const pg = pgDay(57, 2);
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    await s.remind();
    const [sql, params] = (pg.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/props->>'choice' = 'global'/);
    expect(sql).toMatch(/name IN \('chat_quality', 'claude_cli_call'\)/);
    expect(params).toEqual(['kimi']);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('За сутки через Kimi: 57 ответов; не ответила (ответил другой) — 2');
  });

  it('сбой счёта — напоминание уходит без строки «За сутки»', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const pg = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pg as any);
    expect(await s.remind()).toBe(true);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).not.toContain('За сутки');
  });

  it('сбой статуса — молчит, не бросает', async () => {
    const g = { status: jest.fn(async () => { throw new Error('db down'); }) };
    const s = new GlobalLlmReminderService(g as any, health('ok') as any, pgDay() as any);
    await expect(s.remind()).resolves.toBe(false);
  });

  it('сбой обзора здоровья — напоминание всё равно уходит, «нет данных»', async () => {
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
    const g = { status: jest.fn(async () => ({ provider: 'kimi', since: null, by: null })) };
    const h = { getOverview: jest.fn(async () => { throw new Error('boom'); }) };
    const s = new GlobalLlmReminderService(g as any, h as any, pgDay() as any);
    expect(await s.remind()).toBe(true);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('нет данных');
  });
});
```

- [ ] **Шаг 2: красный прогон.** Коммит `test(llm): суточное напоминание (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 npx jest --testPathPattern=src/monitoring/global-llm-reminder 2>&1 | tail -20'`
Expected: FAIL — модуля нет.

- [ ] **Шаг 3: реализация** `src/monitoring/global-llm-reminder.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { FallbackProvider, readFallbackConfigs } from '../common/services/llm-fallback';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { reminderText } from '../common/global-llm-messages';
import { ClaudeHealthService } from './claude-health.service';

/**
 * Раз в сутки, пока общий рубильник не на Claude, — напоминание в группу
 * алертов (spec 2026-10-31-global-llm-switch, раздел 8): возврат только
 * вручную, и про него легко забыть после аварии. Состояние Claude — по
 * последней пробе живости (ClaudeHealthService, раз в 15 минут). Счёт за
 * сутки — по событиям: релей ходы «по выбору» в /health.fallback не считает,
 * и сбои модели рубильника иначе не видны.
 */
@Injectable()
export class GlobalLlmReminderService {
  private readonly logger = new Logger(GlobalLlmReminderService.name);

  constructor(
    private readonly global: GlobalLlmProviderService,
    private readonly health: ClaudeHealthService,
    private readonly pg: PgService,
  ) {}

  @Cron('0 0 10 * * *', { name: 'global-llm-reminder', timeZone: 'Europe/Moscow' })
  async daily(): Promise<void> {
    await this.remind();
  }

  /** true — напоминание отправлено. */
  async remind(now: Date = new Date()): Promise<boolean> {
    const s = await this.global.status().catch((e: any) => {
      this.logger.warn(`рубильник: статус не прочитан: ${e?.message}`);
      return null;
    });
    if (!s || s.provider === 'claude') return false;
    const provider = s.provider as FallbackProvider;
    const overview: any = await this.health.getOverview().catch(() => null);
    const day = await this.dayCounts(provider).catch((e: any) => {
      this.logger.warn(`рубильник: счёт за сутки не прочитан: ${e?.message}`);
      return null;
    });
    const text = reminderText({
      provider,
      since: s.since,
      now,
      claudeStatus: overview?.usage?.llmStatus ?? null,
      claudeCheckedAt: overview?.usage?.llmCheckedAt ?? null,
      keyMissing: readFallbackConfigs()[provider] === null,
      day,
    });
    await sendTelegramAlert(text).catch((e: any) => this.logger.warn(`напоминание о рубильнике не отправлено: ${e?.message}`));
    return true;
  }

  /** Ответы за сутки по выбору рубильника: ok — ответила его модель, other —
   *  ответил другой (она не ответила; у chat_quality — и неудачные ходы). */
  private async dayCounts(provider: FallbackProvider): Promise<{ ok: number; other: number }> {
    const r = await this.pg.query(
      `SELECT count(*) FILTER (WHERE props->>'provider' = $1)::int AS ok,
              count(*) FILTER (WHERE props->>'provider' IS DISTINCT FROM $1)::int AS other
         FROM events
        WHERE ts > now() - interval '1 day'
          AND name IN ('chat_quality', 'claude_cli_call')
          AND props->>'choice' = 'global'
          AND props->>'selected' = $1`,
      [provider],
    );
    return { ok: Number(r.rows[0]?.ok ?? 0), other: Number(r.rows[0]?.other ?? 0) };
  }
}
```

`src/monitoring/monitoring.module.ts`: импорт и `GlobalLlmReminderService` в конец `providers`.

- [ ] **Шаг 4: зелёный прогон** — та же команда + `--testPathPattern=src/monitoring` целиком + `tsc`. Expected: PASS, `tsc_build=0`.
- [ ] **Шаг 5: коммит** `feat(llm): напоминание раз в сутки, пока рубильник не на Claude` — поимённо 3 файла.

---

## Задача 10. Кабинет: блок «Модель ответов для всех» и плашка

Репозиторий — spirits_front, воркдерево `~/Downloads/spirits_front/.worktrees/global-llm-switch`.

**Files:**
- Create: `src/components/admin/globalLlm.ts`
- Create: `src/components/admin/GlobalLlmProviderControl.tsx`, `src/components/admin/GlobalLlmProviderControl.test.tsx`
- Create: `src/components/admin/GlobalLlmBanner.tsx`, `src/components/admin/GlobalLlmBanner.test.tsx`
- Modify: `src/components/admin/AdminAssistantsView.tsx`
- Modify: `src/pages/AdminPage.tsx`, `src/pages/AdminPage.test.tsx`

- [ ] **Шаг 1: тест блока** `src/components/admin/GlobalLlmProviderControl.test.tsx`:

```tsx
// @vitest-environment jsdom
/** Общий рубильник модели ответов (spec spirits_back 2026-10-31-global-llm-switch). */
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { get, post } }));
// В тестах i18n не инициализирован: без подмены t() вернёт текст по умолчанию
// без подстановки {{model}}/{{since}}. Подмена подставляет значения.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, def?: string, opts?: Record<string, unknown>) =>
      String(def ?? k).replace(/\{\{(\w+)\}\}/g, (_m: string, n: string) => String(opts?.[n] ?? '')),
  }),
}));

import { GlobalLlmProviderControl } from './GlobalLlmProviderControl';
import { GLOBAL_LLM_EVENT, fmtSince } from './globalLlm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const state = (provider: string, kimi = false, since: string | null = '2026-10-31T13:40:00.000Z') =>
  ok({ provider, since, by: 'admin-1', configured: { qwen: true, kimi } });
const mount = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<GlobalLlmProviderControl />); });
  await settle();
};
const radio = (name: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find((el) => el.textContent?.includes(name)) as HTMLButtonElement;

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('GlobalLlmProviderControl', () => {
  it('три варианта, текущий выбран; GET общего рубильника', async () => {
    get.mockResolvedValue(state('qwen'));
    await mount();
    expect(get).toHaveBeenCalledWith('/webhook/admin/llm-provider');
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(radio('Qwen').getAttribute('aria-checked')).toBe('true');
  });

  it('модель без ключа недоступна и помечена', async () => {
    get.mockResolvedValue(state('claude', false));
    await mount();
    expect(radio('Kimi').disabled).toBe(true);
    expect(radio('Kimi').textContent).toContain('нет ключа на сервере');
  });

  it('уход с Claude — подтверждение; отказ — без запроса', async () => {
    get.mockResolvedValue(state('claude'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mount();
    await act(async () => { radio('Qwen').click(); });
    expect(confirm).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('уход с Claude — согласие: POST и событие смены', async () => {
    get.mockResolvedValue(state('claude'));
    post.mockResolvedValue(state('qwen'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const seen = vi.fn();
    window.addEventListener(GLOBAL_LLM_EVENT, seen);
    await mount();
    await act(async () => { radio('Qwen').click(); });
    await settle();
    expect(post).toHaveBeenCalledWith('/webhook/admin/llm-provider', { provider: 'qwen' });
    expect(radio('Qwen').getAttribute('aria-checked')).toBe('true');
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(GLOBAL_LLM_EVENT, seen);
  });

  it('возврат на Claude — без подтверждения', async () => {
    get.mockResolvedValue(state('qwen'));
    post.mockResolvedValue(state('claude'));
    const confirm = vi.spyOn(window, 'confirm');
    await mount();
    await act(async () => { radio('Claude').click(); });
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/webhook/admin/llm-provider', { provider: 'claude' });
  });

  it('строка «с …, переключил …»', async () => {
    get.mockResolvedValue(state('qwen'));
    await mount();
    expect(container.textContent).toContain(fmtSince('2026-10-31T13:40:00.000Z'));
    expect(container.textContent).toContain('admin-1');
  });

  it('409 no_key — понятная ошибка', async () => {
    get.mockResolvedValue(state('claude', true));
    post.mockResolvedValue(ok({ error: 'no_key', provider: 'kimi' }, 409));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();
    await act(async () => { radio('Kimi').click(); });
    await settle();
    expect(container.textContent).toContain('У этой модели нет ключа на сервере');
  });
});
```

- [ ] **Шаг 2: тест плашки** `src/components/admin/GlobalLlmBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { get } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, def?: string, opts?: Record<string, unknown>) =>
      String(def ?? k).replace(/\{\{(\w+)\}\}/g, (_m: string, n: string) => String(opts?.[n] ?? '')),
  }),
}));

import GlobalLlmBanner from './GlobalLlmBanner';
import { GLOBAL_LLM_EVENT } from './globalLlm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const mount = async (onOpen = vi.fn()) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<GlobalLlmBanner onOpen={onOpen} />); });
  await settle();
  return onOpen;
};

beforeEach(() => { get.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('GlobalLlmBanner', () => {
  it('рубильник на Claude — плашки нет', async () => {
    get.mockResolvedValue(ok({ provider: 'claude', since: null, by: null, configured: { qwen: true, kimi: false } }));
    await mount();
    expect(container.querySelector('[data-testid="global-llm-banner"]')).toBeNull();
  });

  it('рубильник на Qwen — плашка с моделью; «Изменить» открывает блок', async () => {
    get.mockResolvedValue(ok({ provider: 'qwen', since: '2026-10-31T13:40:00.000Z', by: 'admin-1', configured: { qwen: true, kimi: false } }));
    const onOpen = await mount();
    const b = container.querySelector('[data-testid="global-llm-banner"]')!;
    expect(b.textContent).toContain('Qwen');
    await act(async () => { (b.querySelector('button') as HTMLButtonElement).click(); });
    expect(onOpen).toHaveBeenCalled();
  });

  it('событие смены на Claude — плашка исчезает без запроса', async () => {
    get.mockResolvedValue(ok({ provider: 'qwen', since: null, by: null, configured: { qwen: true, kimi: false } }));
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(GLOBAL_LLM_EVENT, { detail: { provider: 'claude', since: null, by: null, configured: { qwen: true, kimi: false } } }));
    });
    expect(container.querySelector('[data-testid="global-llm-banner"]')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('ошибка загрузки — плашки нет', async () => {
    get.mockRejectedValue(new Error('network'));
    await mount();
    expect(container.querySelector('[data-testid="global-llm-banner"]')).toBeNull();
  });
});
```

В `src/pages/AdminPage.test.tsx` к остальным `vi.mock` добавить: `vi.mock('../components/admin/GlobalLlmBanner', () => ({ default: () => null }));`.

- [ ] **Шаг 3: красный прогон.** Коммит `test(admin): блок рубильника и плашка (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 pnpm vitest run src/components/admin/GlobalLlm src/pages/AdminPage.test.tsx 2>&1 | tail -20'`
Expected: FAIL — модулей нет.

- [ ] **Шаг 4: реализация.**

`src/components/admin/globalLlm.ts`:

```ts
import { apiClient } from '../../services/apiClient';

export type Provider = 'claude' | 'qwen' | 'kimi';
export const PROVIDERS: Provider[] = ['claude', 'qwen', 'kimi'];
export const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude', qwen: 'Qwen', kimi: 'Kimi' };

export interface GlobalLlmState {
  provider: Provider;
  since: string | null;
  by: string | null;
  configured: { qwen: boolean; kimi: boolean };
}

/** Смена рубильника в этой вкладке: блок сообщает, плашка слушает. */
export const GLOBAL_LLM_EVENT = 'linkeon:global-llm-changed';
export const GLOBAL_LLM_URL = '/webhook/admin/llm-provider';

export function toGlobalState(j: any): GlobalLlmState {
  return {
    provider: j?.provider === 'qwen' || j?.provider === 'kimi' ? j.provider : 'claude',
    since: typeof j?.since === 'string' ? j.since : null,
    by: typeof j?.by === 'string' ? j.by : null,
    configured: { qwen: j?.configured?.qwen === true, kimi: j?.configured?.kimi === true },
  };
}

export async function fetchGlobalLlm(): Promise<GlobalLlmState> {
  const r = await apiClient.get(GLOBAL_LLM_URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return toGlobalState(await r.json());
}

/** null в .error — успех. */
export async function saveGlobalLlm(provider: Provider): Promise<{ state: GlobalLlmState | null; error: string | null }> {
  const r = await apiClient.post(GLOBAL_LLM_URL, { provider });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { state: null, error: j?.error === 'no_key' ? 'no_key' : `HTTP ${r.status}` };
  return { state: toGlobalState(j), error: null };
}

/** дд.мм чч:мм в местном времени браузера — без зависимости от локали. */
export function fmtSince(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function announceGlobalLlm(state: GlobalLlmState): void {
  window.dispatchEvent(new CustomEvent(GLOBAL_LLM_EVENT, { detail: state }));
}
```

`src/components/admin/GlobalLlmProviderControl.tsx`:

```tsx
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Cpu, Loader } from 'lucide-react';
import {
  GlobalLlmState, PROVIDERS, PROVIDER_LABELS, Provider,
  announceGlobalLlm, fetchGlobalLlm, fmtSince, saveGlobalLlm,
} from './globalLlm';

/**
 * Общий рубильник модели ответов (spec spirits_back 2026-10-31-global-llm-switch):
 * ассистенты, фоновые задачи и проба без входа. Личный выбор в карточке
 * пользователя важнее. Модель без ключа на сервере недоступна.
 */
export const GlobalLlmProviderControl: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<GlobalLlmState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    fetchGlobalLlm()
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e: any) => { if (!cancelled) setError(`${t('admin.globalLlm.error', 'Не удалось загрузить или сохранить')}: ${e?.message ?? 'error'}`); });
    return () => { cancelled = true; };
  }, []);

  const available = (p: Provider) => p === 'claude' || !!state?.configured[p];

  const choose = async (p: Provider) => {
    if (saving || !state || p === state.provider || !available(p)) return;
    if (state.provider === 'claude' && p !== 'claude') {
      const sure = window.confirm(t('admin.globalLlm.confirm', 'Ассистенты, фоновые задачи и проба без входа перейдут на {{model}}. Вернуть — здесь же.', { model: PROVIDER_LABELS[p] }));
      if (!sure) return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await saveGlobalLlm(p);
      if (r.error === 'no_key') setError(t('admin.globalLlm.errorNoKey', 'У этой модели нет ключа на сервере.'));
      else if (r.error) setError(`${t('admin.globalLlm.error', 'Не удалось загрузить или сохранить')}: ${r.error}`);
      else if (r.state) { setState(r.state); announceGlobalLlm(r.state); }
    } catch (e: any) {
      setError(`${t('admin.globalLlm.error', 'Не удалось загрузить или сохранить')}: ${e?.message ?? 'error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-4 mt-4 bg-white border border-gray-200 rounded-xl p-4" data-testid="global-llm-control">
      <div id={titleId} className="flex items-center gap-2 mb-2 text-sm font-semibold text-gray-800">
        <Cpu className="w-4 h-4" />
        {t('admin.globalLlm.title', 'Модель ответов для всех')}
        {saving && <Loader className="w-3.5 h-3.5 animate-spin text-gray-400" />}
      </div>
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {state && (
        <>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={titleId}>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={state.provider === p}
                disabled={!available(p)}
                onClick={() => choose(p)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg border text-sm disabled:opacity-50 disabled:cursor-not-allowed',
                  state.provider === p
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50',
                )}
              >
                {PROVIDER_LABELS[p]}
                {!available(p) && (
                  <span className="ml-1 text-xs opacity-75">
                    <span aria-hidden="true">·</span> {t('admin.globalLlm.noKey', 'нет ключа на сервере')}
                  </span>
                )}
              </button>
            ))}
          </div>
          {state.since && (
            <p className="mt-2 text-xs text-gray-500">
              {t('admin.globalLlm.since', 'С {{since}}, переключил {{by}}', { since: fmtSince(state.since), by: state.by ?? '—' })}
            </p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            {t('admin.globalLlm.hint', 'Ассистенты, фоновые задачи и проба без входа. Личный выбор в карточке пользователя важнее.')}
          </p>
        </>
      )}
    </div>
  );
};
```

`src/components/admin/GlobalLlmBanner.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { GLOBAL_LLM_EVENT, GlobalLlmState, PROVIDER_LABELS, fetchGlobalLlm, fmtSince } from './globalLlm';

/**
 * Плашка на всех вкладках админки, пока общий рубильник не на Claude
 * (spec spirits_back 2026-10-31-global-llm-switch, раздел 7): возврат только
 * вручную, и про него легко забыть.
 */
const GlobalLlmBanner: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<GlobalLlmState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGlobalLlm().then((s) => { if (!cancelled) setState(s); }).catch(() => { /* без плашки */ });
    const onChange = (e: Event) => setState((e as CustomEvent<GlobalLlmState>).detail);
    window.addEventListener(GLOBAL_LLM_EVENT, onChange);
    return () => { cancelled = true; window.removeEventListener(GLOBAL_LLM_EVENT, onChange); };
  }, []);

  if (!state || state.provider === 'claude') return null;
  const model = PROVIDER_LABELS[state.provider];
  return (
    <div data-testid="global-llm-banner" className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-900 flex-shrink-0">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1 min-w-0">
        {state.since
          ? t('admin.globalLlm.banner', 'Все отвечают через {{model}} с {{since}}', { model, since: fmtSince(state.since) })
          : t('admin.globalLlm.bannerNoSince', 'Все отвечают через {{model}}', { model })}
      </span>
      <button type="button" onClick={onOpen} className="underline flex-shrink-0">
        {t('admin.globalLlm.bannerOpen', 'Изменить')}
      </button>
    </div>
  );
};

export default GlobalLlmBanner;
```

`src/pages/AdminPage.tsx`: импорт `import GlobalLlmBanner from '../components/admin/GlobalLlmBanner';`; сразу после закрывающего `</div>` блока вкладок (перед `<div className="flex-1 overflow-hidden">`) вставить `<GlobalLlmBanner onOpen={() => selectTab('assistants')} />`.

`src/components/admin/AdminAssistantsView.tsx`: импорт `import { GlobalLlmProviderControl } from './GlobalLlmProviderControl';`; сразу после закрывающего `</div>` шапки (блок с `<h1>` и кнопкой «Обновить»), перед `{error && (`, вставить `<GlobalLlmProviderControl />`.

- [ ] **Шаг 5: зелёный прогон** — `timeout 240 pnpm vitest run src/components/admin src/pages/AdminPage.test.tsx 2>&1 | tail -8; pnpm typecheck 2>&1 | grep -c "error TS"`. Expected: PASS; число ошибок TS — не больше базы.
- [ ] **Шаг 6: коммит** `admin: общий рубильник модели — блок во вкладке «Ассистенты» и плашка` — поимённо 8 файлов.

---

## Задача 11. Кабинет: четыре варианта в карточке

**Files:**
- Modify: `src/components/admin/UserLlmProviderControl.tsx`, `src/components/admin/UserLlmProviderControl.test.tsx`

- [ ] **Шаг 1: тесты.** В `UserLlmProviderControl.test.tsx`:
  - после `vi.mock('../../services/apiClient', …)` добавить подмену `react-i18next` с подстановкой значений (i18n в тестах не инициализирован, а подпись «Как у всех (сейчас: {{model}})» должна показать модель):

```tsx
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, def?: string, opts?: Record<string, unknown>) =>
      String(def ?? k).replace(/\{\{(\w+)\}\}/g, (_m: string, n: string) => String(opts?.[n] ?? '')),
  }),
}));
```

  - фабрика ответа: `const state = (provider: string, qwen = true, kimi = true, userId = 'u-1', global = 'claude', effective?: string) => ok({ userId, provider, effective: effective ?? (provider === 'default' ? global : provider), global, qwenConfigured: qwen, configured: { qwen, kimi } });`
  - тест `'три варианта; показывает текущий выбор'` → `'четыре варианта; показывает текущий выбор'`, ожидание длины `4`, плюс `expect(radio('Как у всех').getAttribute('aria-checked')).toBe('false');`
  - тест `'старый бэкенд (только qwenConfigured)…'` — добавить проверку, что без `global` подпись «Как у всех (сейчас: Claude)»;
  - новые тесты:

```tsx
  it('«Как у всех» — подпись с моделью рубильника; выбран, если provider default', async () => {
    get.mockResolvedValue(state('default', true, true, 'u-1', 'qwen'));
    await mount();
    const d = radio('Как у всех');
    expect(d.textContent).toContain('Qwen');
    expect(d.getAttribute('aria-checked')).toBe('true');
  });

  it('выбор «Как у всех» отправляет default', async () => {
    get.mockResolvedValue(state('kimi'));
    post.mockResolvedValue(state('default'));
    await mount();
    await act(async () => { radio('Как у всех').click(); });
    await settle();
    expect(post).toHaveBeenCalledWith('/webhook/admin/users/u-1/llm-provider', { provider: 'default' });
  });

  it('явный Claude — отдельный вариант', async () => {
    get.mockResolvedValue(state('claude'));
    await mount();
    expect(radio('Claude').getAttribute('aria-checked')).toBe('true');
    expect(radio('Как у всех').getAttribute('aria-checked')).toBe('false');
  });
```

  Функция `radio(name)` ищет по `textContent.includes(name)`; «Claude» входит и в подпись «Как у всех (сейчас: Claude)» — поэтому `radio` должна сначала искать точное совпадение начала: заменить на

```tsx
const radio = (name: string) => {
  const all = Array.from(container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
  return all.find((el) => el.textContent?.trim().startsWith(name)) as HTMLButtonElement;
};
```

- [ ] **Шаг 2: красный прогон.** Коммит `test(admin): четыре варианта модели в карточке (красный)`.
Run: `bash .superpowers/node-run.sh 'timeout 240 pnpm vitest run src/components/admin/UserLlmProviderControl 2>&1 | tail -20'`
Expected: FAIL — трёх вариантов вместо четырёх.

- [ ] **Шаг 3: реализация** в `UserLlmProviderControl.tsx`:

```tsx
type Provider = 'claude' | 'qwen' | 'kimi';
type Choice = 'default' | Provider;
type Alt = Exclude<Provider, 'claude'>;
const CHOICES: Choice[] = ['default', 'claude', 'qwen', 'kimi'];
const LABELS: Record<Provider, string> = { claude: 'Claude', qwen: 'Qwen', kimi: 'Kimi' };
interface ProviderState { provider: Choice; global: Provider; configured: Record<Alt, boolean> }

const asProvider = (v: unknown): Provider => (v === 'qwen' || v === 'kimi' || v === 'claude' ? v : 'claude');

const toState = (j: any): ProviderState => ({
  provider: j?.provider === 'claude' || j?.provider === 'qwen' || j?.provider === 'kimi' ? j.provider : 'default',
  // Старый бэкенд поля global не шлёт — рубильника там нет, все на Claude.
  global: asProvider(j?.global),
  configured: j?.configured && typeof j.configured === 'object'
    ? { qwen: j.configured.qwen === true, kimi: j.configured.kimi === true }
    : { qwen: j?.qwenConfigured === true, kimi: false },
});
```

  Старый бэкенд отдавал `provider: 'claude'` в значении «по умолчанию» — после выката бэкенд и фронт едут вместе (Часть В), так что это не встретится.

  `PROVIDERS.map` → `CHOICES.map`; `choose(provider: Provider)` → `choose(choice: Choice)` (тело то же, POST `{ provider: choice }`); подписи:

```tsx
  const label = (c: Choice) => {
    if (c === 'default') return t('admin.userActivity.llmProvider.default', 'Как у всех (сейчас: {{model}})', { model: LABELS[state?.global ?? 'claude'] });
    if (c === 'claude') return t('admin.userActivity.llmProvider.claude', 'Claude');
    if (c === 'qwen') return t('admin.userActivity.llmProvider.qwen', 'Qwen');
    return t('admin.userActivity.llmProvider.kimi', 'Kimi');
  };
```

  Пометка «нет ключа» и предупреждение — только для `c === 'qwen' || c === 'kimi'` (проверка `c !== 'claude'` → `(c === 'qwen' || c === 'kimi')`); подсказка «Если выбранная модель не ответит, ответит Claude» — при `state.provider === 'qwen' || state.provider === 'kimi'`; нижняя подсказка:

```tsx
            {t('admin.userActivity.llmProvider.hint', 'Веб-ассистенты, Маша и TG-боты этого человека. «Как у всех» — модель общего рубильника (вкладка «Ассистенты»).')}
```

- [ ] **Шаг 4: зелёный прогон** той же командой + `pnpm typecheck 2>&1 | grep -c "error TS"`. Expected: PASS, TS — не больше базы.
- [ ] **Шаг 5: коммит** `admin: модель ответов в карточке — «Как у всех» и явный Claude` — поимённо 2 файла.

---

## Задача 12. Кабинет: тексты ru/en/pt

**Files:**
- Modify: `src/i18n/locales/ru.json`, `src/i18n/locales/en.json`, `src/i18n/locales/pt.json`

- [ ] **Шаг 1: скрипт** `.superpowers/add-global-llm-keys.mjs` (не коммитится; формат файлов сохраняется — `JSON.stringify(obj, null, 2) + '\n'`):

```js
import fs from 'node:fs';
const T = {
  ru: {
    'admin.globalLlm.title': 'Модель ответов для всех',
    'admin.globalLlm.hint': 'Ассистенты, фоновые задачи и проба без входа. Личный выбор в карточке пользователя важнее.',
    'admin.globalLlm.noKey': 'нет ключа на сервере',
    'admin.globalLlm.since': 'С {{since}}, переключил {{by}}',
    'admin.globalLlm.confirm': 'Ассистенты, фоновые задачи и проба без входа перейдут на {{model}}. Вернуть — здесь же.',
    'admin.globalLlm.errorNoKey': 'У этой модели нет ключа на сервере.',
    'admin.globalLlm.error': 'Не удалось загрузить или сохранить',
    'admin.globalLlm.banner': 'Все отвечают через {{model}} с {{since}}',
    'admin.globalLlm.bannerNoSince': 'Все отвечают через {{model}}',
    'admin.globalLlm.bannerOpen': 'Изменить',
    'admin.userActivity.llmProvider.default': 'Как у всех (сейчас: {{model}})',
    'admin.userActivity.llmProvider.claude': 'Claude',
    'admin.userActivity.llmProvider.hint': 'Веб-ассистенты, Маша и TG-боты этого человека. «Как у всех» — модель общего рубильника (вкладка «Ассистенты»).',
  },
  en: {
    'admin.globalLlm.title': 'Answer model for everyone',
    'admin.globalLlm.hint': 'Assistants, background tasks and the no-sign-in trial. A personal choice in the user card takes priority.',
    'admin.globalLlm.noKey': 'no key on the server',
    'admin.globalLlm.since': 'Since {{since}}, switched by {{by}}',
    'admin.globalLlm.confirm': 'Assistants, background tasks and the no-sign-in trial will switch to {{model}}. You can switch back here.',
    'admin.globalLlm.errorNoKey': 'This model has no key on the server.',
    'admin.globalLlm.error': 'Could not load or save',
    'admin.globalLlm.banner': 'Everyone is answered by {{model}} since {{since}}',
    'admin.globalLlm.bannerNoSince': 'Everyone is answered by {{model}}',
    'admin.globalLlm.bannerOpen': 'Change',
    'admin.userActivity.llmProvider.default': 'Same as everyone (now: {{model}})',
    'admin.userActivity.llmProvider.claude': 'Claude',
    'admin.userActivity.llmProvider.hint': 'This person’s web assistants, Masha and Telegram bots. “Same as everyone” is the global switch model (Assistants tab).',
  },
  pt: {
    'admin.globalLlm.title': 'Modelo de respostas para todos',
    'admin.globalLlm.hint': 'Assistentes, tarefas em segundo plano e a experiência sem conta. A escolha pessoal no cartão do utilizador tem prioridade.',
    'admin.globalLlm.noKey': 'sem chave no servidor',
    'admin.globalLlm.since': 'Desde {{since}}, alterado por {{by}}',
    'admin.globalLlm.confirm': 'Os assistentes, as tarefas em segundo plano e a experiência sem conta passarão para {{model}}. Pode reverter aqui.',
    'admin.globalLlm.errorNoKey': 'Este modelo não tem chave no servidor.',
    'admin.globalLlm.error': 'Não foi possível carregar ou guardar',
    'admin.globalLlm.banner': 'Todos são respondidos por {{model}} desde {{since}}',
    'admin.globalLlm.bannerNoSince': 'Todos são respondidos por {{model}}',
    'admin.globalLlm.bannerOpen': 'Alterar',
    'admin.userActivity.llmProvider.default': 'Como para todos (agora: {{model}})',
    'admin.userActivity.llmProvider.claude': 'Claude',
    'admin.userActivity.llmProvider.hint': 'Assistentes web, Masha e bots do Telegram desta pessoa. «Como para todos» — modelo do interruptor geral (separador «Assistentes»).',
  },
};
for (const [lang, keys] of Object.entries(T)) {
  const file = `src/i18n/locales/${lang}.json`;
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [path, value] of Object.entries(keys)) {
    const parts = path.split('.');
    let o = obj;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)] = value;
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
console.log('ok');
```

Run (локально — это не сборка): `node .superpowers/add-global-llm-keys.mjs` → `ok`. Проверить `git diff --stat src/i18n/locales` — три файла, только добавленные/изменённые строки; `git diff src/i18n/locales/en.json | grep -c '\\u'` — `0` (экранирование `’`/`“` в скрипте JS раскрывается в символы при записи).

- [ ] **Шаг 2: проверки** — коммит `admin: тексты рубильника модели (ru, en, pt)`; Run: `bash .superpowers/node-run.sh 'node scripts/check-locales.mjs; echo locales=$?; node scripts/check-keys-exist.mjs; echo keys=$?; node scripts/check-no-hardcoded.mjs >/dev/null; echo hardcoded=$?; timeout 240 pnpm vitest run src/components/admin src/i18n 2>&1 | tail -6'`
Expected: коды как в базе (Задача 0), тесты PASS. Если `check-locales` требует ключи админки во всех 7 локалях — сверить с базой: на базе блок `admin.userActivity.llmProvider` есть только в ru/en/pt и проверка зелёная; значит, админка из проверки исключена.

---

## Задача 13. Документация, гейты, итоговое ревью

**Files:**
- Modify: `CLAUDE.md` (spirits_back) — раздел «API Endpoints»

- [ ] **Шаг 1: CLAUDE.md бэка.** После раздела `### Проба без входа (…)` добавить:

```markdown
### Модель ответов: общий рубильник (`src/common/services/global-llm-provider.service.ts`, спека `docs/superpowers/specs/2026-10-31-global-llm-switch-design.md`)
- `GET/POST /webhook/admin/llm-provider` (админ) — `{provider: 'claude'|'qwen'|'kimi'}`; модель без ключа на сервере — 409 `no_key`. Каждое переключение — лог и сообщение в группу алертов; пока не Claude — напоминание раз в сутки в 10:00 МСК (`GlobalLlmReminderService`) и плашка в админке
- Хранится в `llm_settings` (`key = 'global_provider'`, `value = {"provider": …}`), кэш 15 с — действует без выката. Откат — переключить на Claude в админке или `UPDATE llm_settings SET value = '{"provider":"claude"}', updated_at = now() WHERE key = 'global_provider'`
- Порядок: проба мониторинга (`noFallback` без `provider`, `probe: true`) — Claude; личный выбор в карточке (`ai_profiles_consolidated.llm_provider` = `claude`/`qwen`/`kimi`) — он; «Как у всех» (NULL), привратники TG, фоновые задачи (`ClaudeCliService` без `provider`), `agentReply` (рутины, план действий, поездки, звонки, проба качества), автоблог и clean-ask — рубильник; гость пробы — рубильник без цепочки
- Карточка: `GET/POST /webhook/admin/users/:userId/llm-provider` — `provider: 'default'|'claude'|'qwen'|'kimi'`, в ответе `effective` и `global`
```

Коммит `docs(llm): общий рубильник в CLAUDE.md`.

- [ ] **Шаг 2: гейты бэка.** Run: `bash .superpowers/node-run.sh 'timeout 200 npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?; timeout 600 npx jest --testPathPattern="src/" 2>&1 | grep -E "^(Tests|Test Suites):|FAIL " | head -20; timeout 300 npm run build >/dev/null 2>&1; echo build=$?'`
Expected: `tsc_build=0`; `FAIL` только из базы Задачи 0 (сравнить); `build=0`.

- [ ] **Шаг 3: гейты кабинета.** Run: `bash .superpowers/node-run.sh 'timeout 300 pnpm test 2>&1 | tail -5; pnpm typecheck 2>&1 | grep -c "error TS"; node scripts/check-locales.mjs >/dev/null; echo locales=$?; node scripts/check-keys-exist.mjs >/dev/null; echo keys=$?; node scripts/check-no-hardcoded.mjs >/dev/null; echo hardcoded=$?; timeout 300 pnpm build >/dev/null 2>&1; echo build=$?'`
Expected: тесты зелёные; TS ≤ базы; коды проверок — как в базе; `build=0`.

- [ ] **Шаг 4: итоговое ревью** — отдельным ревьюером по обоим диффам `origin/main..feat/global-llm-switch` против спеки: охват раздела 4 (все запросы к релею), пробы не идут в рубильник, гость без цепочки, публичность (номера, секреты).

- [ ] **Шаг 5: пуш веток** в GitHub (`git push -u origin feat/global-llm-switch` в обоих) после скана публичности: `git diff origin/main..HEAD | grep -n -E "[0-9]{11}|sk-[a-z0-9]{8,}|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}"` — только `sk-sp-test`/`sk-kimi-test` в тестах и IP ноды в `.superpowers` (не в диффе).

---

## Задача 14. Фоновые задачи на Qwen — проверка (выполняет контроллер, не субагент)

Нужен доступ к проду; всё — только чтение или вызовы без записи результата.

- [ ] **Шаг 1: что уже отвечало через Qwen.** На проде (только чтение, `PGOPTIONS="-c default_transaction_read_only=on"`):

```sql
SELECT props->>'model' AS model, props->>'provider' AS provider, props->>'fallback' AS fallback, count(*)
  FROM events
 WHERE name = 'claude_cli_call' AND ts > '2026-10-29' AND props->>'provider' IN ('qwen', 'kimi')
 GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Модель (`claude-haiku-4-5` — разбор профиля и фоновые; `claude-opus-*` — ответы) показывает, какие классы вызовов уже проходили через Qwen.

- [ ] **Шаг 2: прогон промптов фоновых задач через Qwen.** Скрипт в `.superpowers/qwen-bg-check.mjs` (не коммитится), запуск на проде из `~/spirits_back` (там `dist/` и ключ в `.env`): для каждого потребителя `ClaudeCliService` из списка спеки (разбор профиля `neo4j.service` consolidate, затыки недели `insights`, бизнес-профиль, задачи, календарь, сжатие профиля, бэклог, свои ассистенты, vmm/vpm) — взять из исходника системный промпт и формат ответа, собрать запрос на данных тестового аккаунта и вызвать `new ClaudeCliService().textWithCost(prompt, { system, model, provider: 'qwen', noFallback: true })` из `dist`; результат не записывать, проверить разбор (JSON.parse или тот же парсер, что у задачи) и сохранить вывод в `/tmp` прода на время проверки, затем удалить. Автоблог и clean-ask — запросом к релею с `provider=qwen`.

- [ ] **Шаг 3: итог** — в спеку (раздел «Риски») список: прошло / не прошло; для не прошедших — правка или явный `provider: 'claude'` в вызове (отдельной задачей с тестом, по правилам выше).

---

## Часть В. Выкат (каждый шаг — с OK владельца)

- [ ] **В1. Слияние** обеих веток в main (fast-forward или merge поверх свежего `origin/main`; перед этим — сообщить соседним сессиям, чьи коммиты лежат в main), полный прогон гейтов Задачи 13 на результате слияния.
- [ ] **В2. `deploy.sh`** из свежих клонов на ноде с `source ~/.nvm/nvm.sh` и `SKIP_BOTS=1`. Рубильник на Claude — для людей ничего не меняется. Проверка: `GET /webhook/admin/llm-provider` → `claude`; в админке блок во вкладке «Ассистенты», плашки нет; карточка — четыре варианта, у всех «Как у всех».
- [ ] **В3. Короткое окно на Qwen** (5–10 минут, в тихий час): переключить в админке → сообщение в группу пришло, плашка видна; ход веб-чата тестовым аккаунтом — в `chat_quality` `selected: qwen, choice: global`; ход гостя пробы — `claude_cli_call` с `provider: qwen`; одна фоновая задача (например, затыки недели вручную для тестового аккаунта) — `claude_cli_call` с `choice: global`; затем обратно на Claude → сообщение «Все снова отвечают через Claude», плашка ушла.
- [ ] **В4. Уборка:** воркдеревья `global-llm-switch` в обоих репозиториях, `~/ci/wt/gls-*` и `tmp/gls` на ноде, клон выката.
