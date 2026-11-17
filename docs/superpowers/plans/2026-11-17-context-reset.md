# «Чистый лист» как точка отсчёта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Чистый лист» перестаёт быть отдельной лентой и становится серверной точкой отсчёта памяти ассистента: лента одна, после точки ассистент видит профиль и новые сообщения.

**Architecture:** Бэк хранит точку в `chat_context_resets` (модуль `src/chat/context-reset/`). `ChatService` сам узнаёт точку пары и применяет её к ключу релея (`_r<мс>`), хвосту переписки, памяти загрузок, задачам, гостевой приписке; голос Романа фильтрует преамбулу. Сообщения всегда пишутся в основную ленту; прежний изолированный fresh-путь остаётся только у пингов мониторинга (`probe`). Фронт теряет `freshTs`, получает кнопку-действие с подтверждением и черту в ленте по `contextResetAt` из истории.

**Tech Stack:** NestJS 10 + pg + jest (бэк), React 18 + TS + vitest (фронт).

**Спека:** `docs/superpowers/specs/2026-11-17-context-reset-design.md` (в этом же воркдереве бэка).

---

## Где и как гонять

- Воркдеревья: бэк `~/Downloads/spirits_back/.worktrees/context-reset`, фронт `~/Downloads/spirits_front/.worktrees/context-reset`, ветки `feat/context-reset`.
- **На маке тяжёлое не гонять** (CLAUDE.md обоих репо). Локально можно только точечный vitest фронта: `./node_modules/.bin/vitest run <файл>` (после `pnpm install` в воркдереве; `pnpm-workspace.yaml` не коммитить).
- Бэк — на ноде, в своём воркдереве CI-клона (jest слеп внутри `.worktrees/` — паттерн игнора):

```bash
# с мака: запушить ветку
git -C ~/Downloads/spirits_back/.worktrees/context-reset push -q -u origin feat/context-reset
SHA=$(git -C ~/Downloads/spirits_back/.worktrees/context-reset rev-parse HEAD)
# на ноде: свой ворктри (первый раз) или переключение на sha
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && (test -d ~/ci/wt/context-reset-back || git worktree add -q --detach ~/ci/wt/context-reset-back ${SHA}) && cd ~/ci/wt/context-reset-back && git checkout -q --detach ${SHA} && git log --oneline -1"
# первый раз: зависимости
ssh dv@85.192.61.231 'cd ~/ci/wt/context-reset-back && source ~/.nvm/nvm.sh && npm ci --silent'
# точечный прогон
ssh dv@85.192.61.231 'cd ~/ci/wt/context-reset-back && source ~/.nvm/nvm.sh && npx jest src/chat/context-reset --silent'
```

- pg-спеки (`*.pg.spec.ts`) — с временной базой на ноде:

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/context-reset-back && source ~/.nvm/nvm.sh && DB=ctxreset_$$ && createdb -h /var/run/postgresql $DB && PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest <путь> --silent; dropdb -h /var/run/postgresql $DB'
```

- Фронт — так же: `~/ci/spirits_front` → `git worktree add --detach ~/ci/wt/context-reset-front <sha>`, `pnpm install`, `pnpm vitest run <файлы>`.
- Типы бэка jest не проверяет: гейт — `npx tsc --noEmit -p tsconfig.build.json`, мерить дельтой против `origin/main`.

---

## Карта файлов

**Бэк (создать):**
- `src/chat/context-reset/migrations/001_chat_context_resets.sql` — таблица.
- `src/chat/context-reset/after-reset.ts` — чистые функции: `afterReset`, `legacyFreshResetAt`.
- `src/chat/context-reset/context-reset.service.ts` — `ChatContextResetService`: `migrate/get/reset`.
- `src/chat/context-reset/context-reset.module.ts` — модуль, миграция при старте.
- `src/chat/context-reset/after-reset.spec.ts`, `context-reset.pg.spec.ts`.
- `src/chat/relay-session.spec.ts` — ключ релея с точкой.
- `scripts/oneoff/2026-11-17-merge-fresh-sessions.sql` + `scripts/oneoff/merge-fresh-sessions.pg.spec.ts`.

**Бэк (изменить):** `relay-session.ts`, `chat.service.ts`, `chat.controller.ts`, `chat.module.ts`, `tasks/tasks.service.ts`, `action-plans/action-plans.{service,controller}.ts`, `chat-files/chat-files.controller.ts`, `voice-call/voice-call.service.ts` (+ module), `context/context.service.ts` (+ module), `profile/profile-account-deletion.adapter.ts`, `platform-kb/articles/chat.ts`, `chat/platform-guide.ts`, затронутые спеки.

**Фронт (создать):** `src/components/chat/contextReset.ts` (+ `.test.ts`), `src/components/chat/ContextResetDivider.tsx`, `src/components/chat/contextResetWiring.test.ts`.

**Фронт (изменить):** `ChatInterface.tsx`, `files/chatFiles.ts`, `files/ChatFilesPanel.tsx`, `action-plan/ActionPlanPanel.tsx`, `services/actionPlansApi.ts`, 7 локалей, затронутые тесты.

---

## Часть 1. Бэк

### Task 1: Модуль точки — таблица, чистые функции, сервис

**Files:**
- Create: `src/chat/context-reset/migrations/001_chat_context_resets.sql`
- Create: `src/chat/context-reset/after-reset.ts`
- Create: `src/chat/context-reset/context-reset.service.ts`
- Create: `src/chat/context-reset/context-reset.module.ts`
- Test: `src/chat/context-reset/after-reset.spec.ts`, `src/chat/context-reset/context-reset.pg.spec.ts`

- [ ] **Step 1: Падающий тест чистых функций**

`src/chat/context-reset/after-reset.spec.ts`:

```ts
import { afterReset, legacyFreshResetAt, LEGACY_FRESH_FUTURE_SLACK_MS } from './after-reset';

describe('afterReset', () => {
  const rows = [
    { id: 'old', created_at: '2026-11-16T10:00:00Z' },
    { id: 'edge', created_at: '2026-11-16T12:00:00Z' },
    { id: 'new', created_at: '2026-11-16T12:00:01Z' },
  ];

  it('без точки — всё как есть', () => {
    expect(afterReset(rows, null, (r) => r.created_at)).toBe(rows);
    expect(afterReset(rows, undefined, (r) => r.created_at)).toBe(rows);
  });

  it('с точкой — только строго позже неё', () => {
    const out = afterReset(rows, new Date('2026-11-16T12:00:00Z'), (r) => r.created_at);
    expect(out.map((r) => r.id)).toEqual(['new']);
  });

  it('строка без времени при заданной точке отбрасывается: старое не должно протечь', () => {
    const out = afterReset([{ id: 'x', created_at: null }], new Date(0), (r) => r.created_at);
    expect(out).toEqual([]);
  });

  it('принимает Date и строку', () => {
    const out = afterReset(
      [{ at: new Date('2026-11-17T00:00:00Z') }, { at: '2026-11-15T00:00:00Z' }],
      new Date('2026-11-16T00:00:00Z'),
      (r) => r.at,
    );
    expect(out).toHaveLength(1);
  });
});

describe('legacyFreshResetAt', () => {
  const now = Date.UTC(2026, 10, 17, 8, 0, 0);

  it('метка старого клиента — это и есть точка', () => {
    expect(legacyFreshResetAt(String(now - 1000), now)?.getTime()).toBe(now - 1000);
    expect(legacyFreshResetAt(now - 1000, now)?.getTime()).toBe(now - 1000);
  });

  it('мусор — не точка', () => {
    for (const v of [undefined, null, '', 'abc', '12345', '1.5e12', '-1794804919138']) {
      expect(legacyFreshResetAt(v, now)).toBeNull();
    }
  });

  it('метка из будущего дальше окна — не точка: иначе память стёрлась бы навсегда', () => {
    expect(legacyFreshResetAt(String(now + LEGACY_FRESH_FUTURE_SLACK_MS + 1), now)).toBeNull();
    expect(legacyFreshResetAt(String(now + LEGACY_FRESH_FUTURE_SLACK_MS), now)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Прогнать — падает** (`Cannot find module './after-reset'`)

Run (нода): `npx jest src/chat/context-reset/after-reset.spec.ts --silent`

- [ ] **Step 3: Чистые функции**

`src/chat/context-reset/after-reset.ts`:

```ts
/**
 * «Чистый лист» — точка отсчёта памяти ассистента
 * (spec 2026-11-17-context-reset-design.md).
 *
 * Чистые функции без БД: что из прошлого ещё можно показать модели и как
 * понимать метку `freshTs` старых клиентов.
 */

/**
 * Метка старого клиента правдоподобна, только если не из будущего дальше
 * этого окна: точка из будущего стёрла бы ассистенту память навсегда (точка
 * только движется вперёд) — а ходы клиента с кривыми часами шли бы в никуда.
 */
export const LEGACY_FRESH_FUTURE_SLACK_MS = 5 * 60 * 1000;

/**
 * Строки, созданные строго после точки. Без точки — входной массив как есть.
 * Строка без читаемого времени при заданной точке отбрасывается: показать
 * модели старое хуже, чем недосчитаться строки.
 */
export function afterReset<T>(
  rows: T[],
  resetAt: Date | null | undefined,
  createdAt: (row: T) => unknown,
): T[] {
  if (!resetAt) return rows;
  const edge = resetAt.getTime();
  return rows.filter((row) => {
    const raw = createdAt(row);
    if (raw === null || raw === undefined) return false;
    const t = new Date(raw as string | number | Date).getTime();
    return Number.isFinite(t) && t > edge;
  });
}

/**
 * `freshTs` старого клиента (вкладки до выката, Flutter, e2e-скрипты) → точка.
 * Формат тот же, что принимал прежний контроллер: только цифры, не меньше
 * шести.
 */
export function legacyFreshResetAt(freshTs: unknown, nowMs: number): Date | null {
  const s = freshTs === null || freshTs === undefined ? '' : String(freshTs);
  if (!/^\d{6,}$/.test(s)) return null;
  const ms = Number(s);
  if (!Number.isSafeInteger(ms) || ms > nowMs + LEGACY_FRESH_FUTURE_SLACK_MS) return null;
  return new Date(ms);
}
```

- [ ] **Step 4: Прогнать — зелёный**

Run: `npx jest src/chat/context-reset/after-reset.spec.ts --silent` → PASS.

- [ ] **Step 5: Падающий pg-тест сервиса**

`src/chat/context-reset/context-reset.pg.spec.ts`:

```ts
import { Pool } from 'pg';
import { ChatContextResetService } from './context-reset.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('ChatContextResetService (pg)', () => {
  let pool: Pool;
  let svc: ChatContextResetService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    svc = new ChatContextResetService({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any);
    await svc.migrate();
    await svc.migrate(); // повторный старт не падает
  });
  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS chat_context_resets');
    await pool?.end();
  });
  beforeEach(async () => { await pool.query('TRUNCATE chat_context_resets'); });

  it('без точки — null', async () => {
    expect(await svc.get('u1', '10')).toBeNull();
  });

  it('reset без времени ставит точку «сейчас» по часам базы', async () => {
    const before = Date.now() - 5000;
    const at = await svc.reset('u1', '10');
    expect(at.getTime()).toBeGreaterThan(before);
    expect((await svc.get('u1', '10'))?.getTime()).toBe(at.getTime());
  });

  it('точка только движется вперёд', async () => {
    await svc.reset('u1', '10', new Date('2026-11-17T08:00:00Z'));
    const kept = await svc.reset('u1', '10', new Date('2026-11-16T08:00:00Z'));
    expect(kept.toISOString()).toBe('2026-11-17T08:00:00.000Z');
    const moved = await svc.reset('u1', '10', new Date('2026-11-18T08:00:00Z'));
    expect(moved.toISOString()).toBe('2026-11-18T08:00:00.000Z');
  });

  it('пары независимы', async () => {
    await svc.reset('u1', '10', new Date('2026-11-17T08:00:00Z'));
    expect(await svc.get('u1', '12')).toBeNull();
    expect(await svc.get('u2', '10')).toBeNull();
  });
});
```

- [ ] **Step 6: Прогнать — падает** (нет модуля сервиса). Run (нода, временная база): `… npx jest src/chat/context-reset/context-reset.pg.spec.ts`

- [ ] **Step 7: Миграция, сервис, модуль**

`src/chat/context-reset/migrations/001_chat_context_resets.sql`:

```sql
-- «Чистый лист» — точка отсчёта памяти ассистента (spec 2026-11-17-context-reset).
-- Одна строка на пару «пользователь + ассистент»: значение имеет только последняя точка.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('chat-context-resets/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS chat_context_resets (
    user_id text NOT NULL,
    assistant_id text NOT NULL,
    reset_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, assistant_id)
  );
END $$;
```

`src/chat/context-reset/context-reset.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../../common/services/pg.service';

/**
 * Точка «Чистого листа» на пару «пользователь + ассистент»
 * (spec 2026-11-17-context-reset-design.md). После точки ассистент помнит
 * только новый разговор и профиль; лента при этом одна и не прерывается.
 *
 * Точка хранится на сервере, а не во вкладке: иначе с телефона, в рутине или
 * в «Пути» ассистент снова смешал бы старое с новым.
 */
@Injectable()
export class ChatContextResetService {
  constructor(private readonly pg: PgService) {}

  async migrate(): Promise<void> {
    // .sql в dist не копируется (nest-cli.json) — второй путь ведёт в src.
    const candidates = [
      path.join(__dirname, 'migrations', '001_chat_context_resets.sql'),
      path.join(__dirname, '..', '..', '..', 'src', 'chat', 'context-reset', 'migrations', '001_chat_context_resets.sql'),
    ];
    const migrationPath = candidates.find((c) => fs.existsSync(c));
    if (!migrationPath) throw new Error('chat-context-resets migration 001 not found');
    await this.pg.query(fs.readFileSync(migrationPath, 'utf8'));
  }

  async get(userId: string, assistantId: string): Promise<Date | null> {
    const { rows } = await this.pg.query(
      'SELECT reset_at FROM chat_context_resets WHERE user_id = $1 AND assistant_id = $2',
      [userId, String(assistantId)],
    );
    return rows[0]?.reset_at ? new Date(rows[0].reset_at) : null;
  }

  /**
   * Ставит точку (по умолчанию — «сейчас» по часам базы, теми же, что у
   * created_at сообщений) и возвращает действующую. Точка только движется
   * вперёд: два нажатия в разных вкладках или запоздалая метка старого клиента
   * не возвращают ассистенту забытое.
   */
  async reset(userId: string, assistantId: string, at?: Date): Promise<Date> {
    const { rows } = await this.pg.query(
      `INSERT INTO chat_context_resets (user_id, assistant_id, reset_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()))
       ON CONFLICT (user_id, assistant_id) DO UPDATE
         SET reset_at = GREATEST(chat_context_resets.reset_at, EXCLUDED.reset_at)
       RETURNING reset_at`,
      [userId, String(assistantId), at ?? null],
    );
    return new Date(rows[0].reset_at);
  }
}
```

`src/chat/context-reset/context-reset.module.ts`:

```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ChatContextResetService } from './context-reset.service';

/**
 * Отдельный модуль, а не провайдер ChatModule: точку читают и голосовой звонок
 * (VoiceCallModule), и сборщик контекста (ContextModule) — без цикла через
 * ChatModule. Миграция при старте: без таблицы приложение не поднимается
 * (образец — ChatUploadsModule).
 */
@Module({
  imports: [CommonModule],
  providers: [ChatContextResetService],
  exports: [ChatContextResetService],
})
export class ContextResetModule implements OnModuleInit {
  constructor(private readonly resets: ChatContextResetService) {}

  async onModuleInit(): Promise<void> {
    await this.resets.migrate();
  }
}
```

- [ ] **Step 8: Прогнать оба теста — зелёные** (unit на ноде, pg — с временной базой).

- [ ] **Step 9: Commit**

```bash
git add src/chat/context-reset
git commit -m "feat(chat): точка «Чистого листа» — таблица, сервис, чистые функции"
```

---

### Task 2: Ключ релея с точкой

**Files:**
- Modify: `src/chat/relay-session.ts`
- Create: `src/chat/relay-session.spec.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { relaySessionKey } from './relay-session';
import { relaySessionForProfiling } from './relay-prompt-privacy';

describe('relaySessionKey: точка «Чистого листа»', () => {
  const R = new Date(1794804919138);

  it('без точки — прежний ключ: живые сессии не теряют память при выкате', () => {
    expect(relaySessionKey('u1', '10', 'ru')).toBe('u1_10_ru');
    expect(relaySessionKey('u1', '10', 'ru', undefined, null)).toBe('u1_10_ru');
  });

  it('с точкой — новая сессия: релей не резюмит старую память', () => {
    expect(relaySessionKey('u1', '10', 'ru', undefined, R)).toBe('u1_10_ru_r1794804919138');
  });

  it('изолированная сессия пинга перебивает точку', () => {
    expect(relaySessionKey('u1', '10', 'ru', 'u1_10_fresh_1', R)).toBe('u1_10_fresh_1');
  });

  it('суффикс запрета профилирования встаёт после точки', () => {
    expect(relaySessionForProfiling(relaySessionKey('u1', '10', 'ru', undefined, R), false))
      .toBe('u1_10_ru_r1794804919138_noprofiling');
  });
});
```

(Перед написанием сверить сигнатуру `relaySessionForProfiling` в `relay-prompt-privacy.ts:44` и точный суффикс; если он другой — поправить ожидание в последнем тесте под фактический.)

- [ ] **Step 2: Прогнать — падает** (третий/второй тест: лишний параметр игнорируется). `npx jest src/chat/relay-session.spec.ts --silent`

- [ ] **Step 3: Реализация** — в `src/chat/relay-session.ts` заменить функцию целиком:

```ts
export function relaySessionKey(
  userId: string,
  assistantId: string,
  userLanguage: string,
  // Изолированная сессия пинга мониторинга (probe + fresh, только тестовые
  // аккаунты): задан — значит он и есть ключ.
  freshSessionId?: string,
  // Точка «Чистого листа» (spec 2026-11-17-context-reset): новая точка —
  // новая Claude-сессия, релей не резюмит память, накопленную до неё.
  resetAt?: Date | null,
): string {
  if (freshSessionId) return freshSessionId;
  const base = `${userId}_${assistantId}_${userLanguage}`;
  return resetAt ? `${base}_r${resetAt.getTime()}` : base;
}
```

- [ ] **Step 4: Прогнать — зелёный.** Плюс старые: `npx jest src/chat/chat.upload-session.spec.ts -t relaySessionKey --silent`.

- [ ] **Step 5: Commit** — `git add src/chat/relay-session.ts src/chat/relay-session.spec.ts && git commit -m "feat(chat): ключ релея с точкой «Чистого листа»"`

---

### Task 3: Задачи — только созданные после точки

**Files:**
- Modify: `src/tasks/tasks.service.ts` (`buildContextForPrompt`, ~179)
- Test: `src/tasks/tasks.context-reset.spec.ts` (создать)

- [ ] **Step 1: Падающий тест**

```ts
import { TasksService } from './tasks.service';

function svcWith(active: any[], archived: any[]) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/status = 'active'/.test(sql)) return { rows: active };
      if (/status = 'archived'/.test(sql)) return { rows: archived };
      return { rows: [] };
    }),
  };
  const svc = new TasksService(pg as any);
  // без ключа OpenAI ранжирования нет — активные идут по свежести
  (svc as any).embed = jest.fn(async () => null);
  return svc;
}

const task = (id: string, created: string) => ({
  id, title: `задача ${id}`, summary: '', status: 'active',
  created_at: created, last_active_at: created, claudemd: '', embedding: null,
});

describe('buildContextForPrompt: точка «Чистого листа»', () => {
  it('без точки — задачи как раньше', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], []);
    expect(await svc.buildContextForPrompt('u1', 'привет')).toContain('задача old');
  });

  it('с точкой — задачи до неё не показываются', async () => {
    const svc = svcWith(
      [task('old', '2026-11-10T00:00:00Z'), task('new', '2026-11-17T09:00:00Z')],
      [],
    );
    const out = await svc.buildContextForPrompt('u1', 'привет', { since: new Date('2026-11-17T00:00:00Z') });
    expect(out).toContain('задача new');
    expect(out).not.toContain('задача old');
  });

  it('с точкой и без новых задач — пусто', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], []);
    expect(await svc.buildContextForPrompt('u1', 'привет', { since: new Date('2026-11-17T00:00:00Z') })).toBe('');
  });
});
```

Перед запуском сверить конструктор `TasksService` (первым идёт `pg`?) и как блок рендерит задачу (`title` в тексте?) — поправить фикстуру под фактический рендер, смысл тестов не менять.

- [ ] **Step 2: Прогнать — падает** (третий аргумент игнорируется). `npx jest src/tasks/tasks.context-reset.spec.ts --silent`

- [ ] **Step 3: Реализация** — сигнатура и фильтр после чтения обоих списков:

```ts
  async buildContextForPrompt(
    userId: string,
    userMessage: string = '',
    // Точка «Чистого листа» (spec 2026-11-17-context-reset): задачи общие для
    // всех ассистентов, поэтому отсечка — по времени создания, а не по ассистенту.
    opts: { since?: Date | null } = {},
  ): Promise<string> {
```

и сразу после блока, где заполнены `active` и `archived` (до `if (active.length === 0 && archived.length === 0) return '';`):

```ts
    const activeAfter = afterReset(active, opts.since, (t) => t.created_at);
    const archivedAfter = afterReset(archived, opts.since, (t) => t.created_at);
```

…и дальше по методу использовать `activeAfter` / `archivedAfter` вместо `active` / `archived` (включая проверку на пустоту). Импорт: `import { afterReset } from '../chat/context-reset/after-reset';`

- [ ] **Step 4: Прогнать — зелёный**, плюс соседние: `npx jest src/tasks --silent`.

- [ ] **Step 5: Commit** — `git commit -am "feat(tasks): после точки «Чистого листа» — только новые задачи"` (добавить новый spec поимённо).

---

### Task 4: ChatService — точка в текстовом ходе, загрузке и agentReply

**Files:**
- Modify: `src/chat/chat.service.ts`
- Test: `src/chat/chat.service.context-reset.spec.ts` (создать)

- [ ] **Step 1: Падающий тест**

Харнес — как в `chat.upload-session.spec.ts` (`makePg`, `makeService`, `sseStream`, `fieldsOf`, мок `axios`): скопировать нужные хелперы в новый файл, меняя фикстуру истории так, чтобы строки несли `created_at`:

```ts
// в makePg: история с временем — до и после точки
if (/FROM custom_chat_history/.test(sql) && /SELECT sender_type/.test(sql)) {
  return { rows: [
    { sender_type: 'ai', content: 'НОВЫЙ ответ', created_at: '2026-11-17T09:00:02Z' },
    { sender_type: 'human', content: 'НОВЫЙ вопрос', created_at: '2026-11-17T09:00:01Z' },
    { sender_type: 'ai', content: 'СТАРЫЙ ответ', created_at: '2026-11-10T09:00:02Z' },
    { sender_type: 'human', content: 'СТАРЫЙ вопрос', created_at: '2026-11-10T09:00:01Z' },
  ] };
}
```

Тесты (сервис получает точку через свойство, как прочие @Optional-зависимости в спеках):

```ts
const R = new Date('2026-11-17T00:00:00Z');
const resets = (at: Date | null) => ({ get: jest.fn(async () => at) });

describe('ChatService: точка «Чистого листа»', () => {
  afterEach(() => jest.clearAllMocks());

  it('текстовый ход: ключ релея с точкой, хвост — только после неё', async () => {
    const pg = makePg();
    const svc = makeService(pg);
    (svc as any).contextResets = resets(R);
    const fields = await textTurn(svc); // streamChat(...) → поля, ушедшие на релей
    expect(fields.sessionId).toBe(`u1_12_ru_r${R.getTime()}`);
    expect(fields.history).toContain('НОВЫЙ вопрос');
    expect(fields.history).not.toContain('СТАРЫЙ');
  });

  it('без точки — ключ и хвост прежние', async () => {
    const svc = makeService(makePg());
    (svc as any).contextResets = resets(null);
    const fields = await textTurn(svc);
    expect(fields.sessionId).toBe('u1_12_ru');
    expect(fields.history).toContain('СТАРЫЙ вопрос');
  });

  it('без сервиса точки (старые стенды, спеки) — поведение прежнее', async () => {
    const fields = await textTurn(makeService(makePg()));
    expect(fields.sessionId).toBe('u1_12_ru');
  });

  it('загрузка файла: тот же ключ с точкой и тот же отфильтрованный хвост', async () => {
    const svc = makeService(makePg());
    (svc as any).contextResets = resets(R);
    const handoff = await svc.buildUploadHandoff({ userId: 'u1', assistantId: '12', requestLang: 'ru' });
    expect(handoff.sessionId ?? handoff.baseSessionId).toContain(`_r${R.getTime()}`);
    expect(JSON.stringify(handoff)).not.toContain('СТАРЫЙ');
  });

  it('задачи спрашиваются с точкой', async () => {
    const svc = makeService(makePg());
    const tasks = { buildContextForPrompt: jest.fn(async () => ''), extractFromTurn: jest.fn() };
    (svc as any).tasksService = tasks;
    (svc as any).contextResets = resets(R);
    await textTurn(svc);
    expect(tasks.buildContextForPrompt).toHaveBeenCalledWith('u1', expect.any(String), { since: R });
  });

  it('сбой чтения точки не роняет ход', async () => {
    const svc = makeService(makePg());
    (svc as any).contextResets = { get: jest.fn(async () => { throw new Error('db down'); }) };
    const fields = await textTurn(svc);
    expect(fields.sessionId).toBe('u1_12_ru');
  });
});
```

`textTurn(svc)` — вызов `svc.streamChat('u1', 'вопрос', '12', 'u1_12', '', res, req)` с `makeRes()` и `req = { headers: {} }`, затем `await` нескольких `setImmediate` и `fieldsOf(post.mock.calls[0][1])`. Точные позиционные аргументы `streamChat` сверить с `chat.service.legacy-greeting.spec.ts` (там он уже вызывается напрямую). Имя поля ключа в результате `buildUploadHandoff` сверить с типом `UploadHandoff` и поправить ожидание.

- [ ] **Step 2: Прогнать — падает.** `npx jest src/chat/chat.service.context-reset.spec.ts --silent`

- [ ] **Step 3: Реализация в `chat.service.ts`**

3a. Импорты наверху файла:

```ts
import { afterReset } from './context-reset/after-reset';
import { ChatContextResetService } from './context-reset/context-reset.service';
```

3b. Последним параметром конструктора (после `chatUploads`):

```ts
    // Точка «Чистого листа» (spec 2026-11-17-context-reset). Последним и
    // @Optional: спеки собирают сервис позиционно; без него точки нет.
    @Optional() private readonly contextResets?: ChatContextResetService,
```

3c. Приватный хелпер рядом с `uploadContextBlock`:

```ts
  /**
   * Точка «Чистого листа» пары. Сбой чтения не роняет ход: ассистент ответит
   * с прежней памятью — хуже, чем с чистой, но лучше, чем никак.
   */
  private async contextResetAt(userId: string, assistantId: string): Promise<Date | null> {
    if (!this.contextResets) return null;
    try {
      return await this.contextResets.get(userId, String(assistantId));
    } catch (e: any) {
      this.logger.warn(`context reset lookup failed (${userId}_${assistantId}): ${e?.message}`);
      return null;
    }
  }
```

3d. `uploadContextBlock` — четвёртый параметр и фильтр:

```ts
  private async uploadContextBlock(
    userId: string,
    rawSessionId: string,
    excludeIds?: string[],
    // Точка «Чистого листа»: файлы до неё ассистенту не напоминаем.
    since?: Date | null,
  ): Promise<string> {
    if (!this.chatUploads || process.env.CHAT_UPLOADS_ENABLED !== 'true') return '';
    try {
      const records = await this.chatUploads.recentForSession(userId, rawSessionId, excludeIds || []);
      return this.chatUploads.assistantBlock(afterReset(records, since, (r) => r.createdAt));
```

(остальное тело без изменений).

3e. `streamChat` — после `const chatSessionId = …`:

```ts
    // Точка «Чистого листа»: ассистент помнит только то, что после неё. У пинга
    // мониторинга (fresh) своя изолированная сессия — точка ему не нужна.
    const resetAt = fresh ? null : await this.contextResetAt(userId, String(assistantId));
```

Запрос хвоста (сейчас ~1314) — `created_at` в SELECT и фильтр до разворота:

```ts
    const histRes = await this.pg.query(
      `SELECT sender_type, content, created_at FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [chatSessionId],
    );
    const recentHistory = afterReset(histRes.rows, resetAt, (r: any) => r.created_at)
      .reverse()
      .map((r: any) => ({
        type: r.sender_type === 'human' ? 'user' : 'assistant',
        content: r.content,
      }));
```

Ветка Маши (~1467) — задачи с точкой:

```ts
        const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message, { since: resetAt });
```

Вызов `streamUniversalAgent` (~1395) — дописать `resetAt` последним аргументом после `storeBuild`.

3f. `streamUniversalAgent` — новый последний параметр после `storeBuild`:

```ts
    // Точка «Чистого листа» — собрана в streamChat (spec 2026-11-17-context-reset).
    contextResetAt: Date | null = null,
```

и в теле:
- память загрузок: `uploadContext = await this.uploadContextBlock(userId, rawSessionId, undefined, contextResetAt);`
- задачи: `const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message, { since: contextResetAt });`
- гостевая приписка: условие `if (this.redis && !fresh && !probe && !contextResetAt) {` с комментарием «приписка гостевой пробы старше любой точки — после точки её не тянем»;
- ключ: `const baseRelaySid = relaySessionKey(userId, assistantId, userLanguage, fresh ? freshSessionId : undefined, contextResetAt);`

3g. `buildUploadHandoff` — убрать параметр `freshSessionId` из типа и деструктуризации (загрузки больше не ходят изолированным путём — у пингов загрузок нет), затем:

```ts
    const { userId, assistantId } = p;
    const profileText = p.profileText || '';
    const userLanguage = await this.language.resolveUserLanguage(userId, p.requestLang);
    const resetAt = await this.contextResetAt(userId, assistantId);
    const baseSessionId = relaySessionKey(userId, assistantId, userLanguage, undefined, resetAt);
```

хвост:

```ts
      const histRes = await this.pg.query(
        `SELECT sender_type, content, created_at FROM custom_chat_history
         WHERE session_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [`${userId}_${assistantId}`],
      );
      history = this.renderHistoryBlock(
        afterReset(histRes.rows, resetAt, (r: any) => r.created_at).reverse().map((r: any) => ({
          type: r.sender_type === 'human' ? 'user' : 'assistant',
          content: r.content,
        })),
      );
```

память загрузок: `this.uploadContextBlock(userId, \`${userId}_${assistantId}\`, p.savedUploadIds, resetAt)`.

3h. `agentReply` (~3218):

```ts
    // Рутины и «Путь» продолжают ту же сессию релея, что и чат — значит, и
    // точку «Чистого листа» уважают ту же. Изолированные пробы (override) — без неё.
    const resetAt = sessionIdOverride ? null : await this.contextResetAt(userId, assistantId);
    const baseRelaySid = sessionIdOverride || relaySessionKey(userId, assistantId, userLanguage, undefined, resetAt);
```

- [ ] **Step 4: Прогнать новый тест — зелёный.**

- [ ] **Step 5: Прогнать весь `src/chat` и поправить сломанные ожидания**

Run: `npx jest src/chat --silent --maxWorkers=2`

Ожидаемые поломки и как чинить (не ослабляя смысл):
- спеки, вызывающие `buildUploadHandoff({ freshSessionId })` (`chat-uploads.prompt.spec.ts` ~211 и др.) — тест «реестр опрошен по fresh-сессии» переписать на «реестр опрошен по основной ленте, файлы до точки отсечены» (с `contextResets` = точка и записью `createdAt` до/после);
- фикстуры, сравнивающие SQL хвоста строкой целиком, — добавить `created_at` в ожидание.
Остальные падения — разобрать: регрессия или ожидание старой логики.

- [ ] **Step 6: Commit** — `git add` поимённо, `git commit -m "feat(chat): ассистент после точки «Чистого листа» помнит только новое"`

---

### Task 5: Контроллер — совместимость, адрес точки, история

**Files:**
- Modify: `src/chat/chat.controller.ts`, `src/chat/chat.module.ts`
- Test: `src/chat/chat.controller.context-reset.spec.ts` (создать); правка `src/chat/chat.upload-session.spec.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { ChatController } from './chat.controller';

function makeCtrl(over: Partial<Record<string, any>> = {}) {
  const chatService = {
    streamChat: jest.fn(async () => {}),
    getChatHistory: jest.fn(async () => ({ messages: [], hasMore: false })),
    ...over.chatService,
  };
  const resets = {
    get: jest.fn(async () => null),
    reset: jest.fn(async (_u: string, _a: string, at?: Date) => at ?? new Date('2026-11-17T08:00:00Z')),
    ...over.resets,
  };
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: over.userId ?? 'u1' })) };
  const ctrl = new ChatController(chatService as any, jwtSvc as any, undefined as any, undefined);
  (ctrl as any).contextResets = resets;
  return { ctrl, chatService, resets };
}
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(), end: jest.fn() }) as any;

describe('ChatController: «Чистый лист» как точка', () => {
  it('POST reset-context ставит точку и отдаёт её', async () => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, { assistantId: 10 }, r);
    expect(resets.reset).toHaveBeenCalledWith('u1', '10');
    expect(r.json).toHaveBeenCalledWith({ resetAt: '2026-11-17T08:00:00.000Z' });
  });

  it('reset-context без ассистента — 400', async () => {
    const { ctrl, resets } = makeCtrl();
    const r = res();
    await ctrl.resetContext({ userId: 'u1' }, {}, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(resets.reset).not.toHaveBeenCalled();
  });

  it('история отдаёт contextResetAt и не читает freshTs', async () => {
    const at = new Date('2026-11-17T08:00:00Z');
    const { ctrl, chatService } = makeCtrl({ resets: { get: jest.fn(async () => at) } });
    const r = res();
    await ctrl.getHistory({ userId: 'u1' }, '10', '30', '0', r);
    expect(chatService.getChatHistory).toHaveBeenCalledWith('u1', '10', 30, 0);
    expect(r.json).toHaveBeenCalledWith({ messages: [], hasMore: false, contextResetAt: at.toISOString() });
  });

  it('обычный fresh старого клиента — точка на freshTs и ход в основную ленту', async () => {
    const ts = String(Date.now() - 60_000);
    const { ctrl, chatService, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: ts }), res());
    expect(resets.reset).toHaveBeenCalledWith('u1', '10', new Date(Number(ts)));
    const args = chatService.streamChat.mock.calls[0];
    expect(args[3]).toBe('u1_10');      // sessionId
    expect(args[7]).toBe(false);        // fresh
  });

  it('пинг мониторинга (probe у тестового аккаунта) — прежний изолированный путь, точка не трогается', async () => {
    const ts = String(Date.now());
    const { ctrl, chatService, resets } = makeCtrl({ userId: '70000000000' });
    await ctrl.chat(chatReq({ message: 'ping', assistantId: '12', fresh: true, freshTs: ts, probe: true }, '70000000000'), res());
    expect(resets.reset).not.toHaveBeenCalled();
    const args = chatService.streamChat.mock.calls[0];
    expect(args[3]).toBe(`70000000000_12_fresh_${ts}`);
    expect(args[7]).toBe(true);
  });

  it('метка из будущего — точку не ставит', async () => {
    const { ctrl, resets } = makeCtrl();
    await ctrl.chat(chatReq({ message: 'q', assistantId: '10', fresh: true, freshTs: String(Date.now() + 3_600_000) }), res());
    expect(resets.reset).not.toHaveBeenCalled();
  });
});
```

`chatReq(body, userId?)` — объект запроса в форме, которую читает `chat()` (заголовок авторизации, `body`); сверить с тем, как `chat()` достаёт userId (через `jwtSvc.verify` или `@CurrentUser`), и собрать по образцу существующих спек контроллера (`grep -l "ctrl.chat(" src/chat/*.spec.ts`). Позиции `sessionId`/`fresh` в `streamChat` — 4-я и 8-я (см. `C:187,191`).

- [ ] **Step 2: Прогнать — падает.** `npx jest src/chat/chat.controller.context-reset.spec.ts --silent`

- [ ] **Step 3: Реализация**

3a. Конструктор `ChatController` — последним:

```ts
    // Точка «Чистого листа» (spec 2026-11-17-context-reset). Последним и
    // @Optional — по той же причине, что chatUploads.
    @Optional() private readonly contextResets?: ChatContextResetService,
```

Импорты: `ChatContextResetService` из `./context-reset/context-reset.service`, `legacyFreshResetAt` из `./context-reset/after-reset`.

3b. Хелпер в классе:

```ts
  /**
   * `fresh` + `freshTs` старого клиента (вкладки до выката, Flutter, e2e):
   * точка на его метку. Сбой записи хода не роняет — ассистент ответит с
   * прежней памятью.
   */
  private async applyLegacyFresh(userId: string, assistantId: string, freshTs: unknown): Promise<void> {
    const at = legacyFreshResetAt(freshTs, Date.now());
    if (!at || !this.contextResets) return;
    try {
      await this.contextResets.reset(userId, assistantId, at);
    } catch (e: any) {
      this.logger?.warn?.(`legacy fresh reset failed (${userId}_${assistantId}): ${e?.message}`);
    }
  }
```

(если у контроллера нет `logger` — завести `private readonly logger = new Logger(ChatController.name);` с импортом `Logger` из `@nestjs/common`.)

3c. `chat()` — заменить блок `fresh`/`finalSessionId` и поднять `probe` выше (старое объявление `probe` ниже удалить):

```ts
    // Пинг мониторинга (smoke / synthetic-runner): флаг признаётся ТОЛЬКО у
    // тестовых аккаунтов (комментарий ниже, у прежнего места — перенести сюда).
    const probe = body.probe === true && TEST_USERS.includes(userId);

    // «Чистый лист» (spec 2026-11-17-context-reset). Изолированная fresh-сессия
    // осталась только у пингов: каждый пинг — одноразовая дешёвая сессия, и он
    // не сдвигает точку тестового аккаунта посреди других проверок. У всех
    // остальных fresh + freshTs (старые клиенты) — это точка отсчёта.
    const freshRequested = body.fresh === true && /^\d{6,}$/.test(String(body.freshTs || ''));
    const fresh = freshRequested && probe;
    if (freshRequested && !probe) await this.applyLegacyFresh(userId, String(assistantId), body.freshTs);
    const finalSessionId = fresh
      ? `${userId}_${assistantId}_fresh_${body.freshTs}`
      : (sessionId || `${userId}_${assistantId}`);
```

3d. `uploadAndChat()` — блок `freshFlag/fresh/freshSessionId` заменить на:

```ts
    // «Чистый лист» старого клиента — точка (spec 2026-11-17-context-reset).
    // Изолированной сессии у загрузок больше нет: пинги файлов не шлют.
    const freshFlag = body.fresh === true || body.fresh === 'true';
    if (freshFlag) await this.applyLegacyFresh(userId, String(assistantId), body.freshTs);
```

`uploadSessionId` → всегда `` `${userId}_${assistantId}` ``; из вызова `buildUploadHandoff` убрать `freshSessionId`; из `persistUploadTurn` убрать `sessionIdOverride: freshSessionId`.

3e. `getHistory` и новый адрес:

```ts
  @Get('chat/history')
  @UseGuards(JwtGuard)
  async getHistory(@CurrentUser() user: any, @Query('assistantId') assistantId: string, @Query('limit') limit: string, @Query('offset') offset: string, @Res() res: Response) {
    // Лента одна (spec 2026-11-17-context-reset): freshTs старых клиентов не
    // читаем. Точка — чтобы фронт провёл черту.
    const history = await this.chatService.getChatHistory(user.userId, assistantId, parseInt(limit) || 30, parseInt(offset) || 0);
    let resetAt: Date | null = null;
    try {
      resetAt = this.contextResets ? await this.contextResets.get(user.userId, String(assistantId)) : null;
    } catch { /* без черты, но с историей */ }
    return res.status(200).json({ ...history, contextResetAt: resetAt ? resetAt.toISOString() : null });
  }

  @Post('chat/reset-context')
  @UseGuards(JwtGuard)
  async resetContext(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const assistantId = body?.assistantId === undefined || body?.assistantId === null ? '' : String(body.assistantId).trim();
    if (!assistantId || assistantId.length > 100) return res.status(400).json({ error: 'assistantId is required' });
    if (!this.contextResets) return res.status(503).json({ error: 'context reset unavailable' });
    const resetAt = await this.contextResets.reset(user.userId, assistantId);
    return res.status(200).json({ resetAt: resetAt.toISOString() });
  }
```

(Проверить, что `Body` и `Post` импортированы из `@nestjs/common` — в файле уже есть `@Post`.)

3f. `src/chat/chat.module.ts`: `import { ContextResetModule } from './context-reset/context-reset.module';`, добавить `ContextResetModule` в `imports` и в `exports` (его читают модули, импортирующие ChatModule).

- [ ] **Step 4: Прогнать новый тест — зелёный.**

- [ ] **Step 5: Поправить `chat.upload-session.spec.ts`**

Тест `'чистый лист: файл уходит в fresh-сессию, а не в основную'` заменить:

```ts
  it('чистый лист старого клиента: файл — в основную сессию, точка — на его метку', async () => {
    const ts = String(Date.now() - 1000);
    const fields = await upload(makePg(), { fresh: 'true', freshTs: ts });
    // без сервиса точки в этом харнесе ключ прежний — главное, что не fresh
    expect(fields.sessionId).toBe('u1_12_ru');
    expect(fields.sessionId).not.toContain('_fresh_');
  });
```

Тест `'чистый лист: блок памяти ищется по fresh-сессии'` (~648) — переписать на основную ленту (`recentForSession('u1','u1_12',[id])`).

Run: `npx jest src/chat --silent --maxWorkers=2` — зелёный.

- [ ] **Step 6: Commit** — `git commit -m "feat(chat): адрес reset-context, contextResetAt в истории, совместимость старых клиентов"`

**Дополнения по ревью задач 1–4 (обязательны в этой задаче):**
- **Раскол загрузок.** После задачи 4 релей и хвост загрузки идут по основной ленте, а контроллер ещё сохраняет исходник (`saveOriginals`) и ход (`persistUploadTurn({ sessionIdOverride })`) в fresh-сессию. Убрать оба: исходник и ход — всегда в `` `${userId}_${assistantId}` ``. Параметр `sessionIdOverride` у `ChatService.persistUploadTurn` удалить вместе с его комментарием (последний вызывающий уходит). Тест в `chat.upload-session.spec.ts` для старого клиента с `fresh`: `saveOriginals` вызван с `sessionId: 'u1_12'`, у `persistUploadTurn` нет `sessionIdOverride`.
- **Момент хода для загрузки.** `const turnAt = new Date()` первой строкой `uploadAndChat`; передать пятым аргументом в `chatService.consolidateAfterChatPublic(…)` (фоновое сохранение, ~`chat.controller.ts:693`). Тест: передан `Date`, не позже запроса к релею.
- **Комментарии контроллера** про «чистый лист» как fresh-сессию (~164-166, ~319-321, ~729) — переписать под новую логику.
- **Сервис точки (задача 1, мелкое):** в `reset()` нижняя граница `LEGACY_FRESH_MIN_MS` в той же проверке, что и будущее (+ pg-случай); JSDoc: `null`/`undefined` → `now()` по часам базы; в миграцию `001` (ещё не выкачена) — `CHECK (isfinite(reset_at))`.
- **Порядок выката:** задачи 4 и 5 — только вместе, задача 4 в одиночку ломает загрузки старых клиентов.

---

### Task 6: План действий и «Медиа и файлы» — без freshTs

**Files:**
- Modify: `src/chat/action-plans/action-plans.service.ts`, `action-plans.controller.ts`, `src/chat/chat-files/chat-files.controller.ts`
- Test: `src/chat/action-plans/action-plans.service.spec.ts`, `src/chat/chat-files/chat-files.controller.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `action-plans.service.spec.ts` тест `'uses the fresh-start history and storage session'` заменить двумя:

```ts
  it('строит план по сообщениям после точки «Чистого листа»', async () => {
    // chat.getChatHistory отдаёт два хода: до и после точки
    chat.getChatHistory.mockResolvedValue({ hasMore: false, messages: [
      { type: 'user', content: 'СТАРЫЙ вопрос', timestamp: '2026-11-10T09:00:00Z' },
      { type: 'assistant', content: 'СТАРЫЙ ответ', timestamp: '2026-11-10T09:00:01Z' },
      { type: 'user', content: 'НОВЫЙ вопрос', timestamp: '2026-11-17T09:00:00Z' },
      { type: 'assistant', content: 'НОВЫЙ ответ', timestamp: '2026-11-17T09:00:01Z' },
    ] });
    (service as any).contextResets = { get: jest.fn(async () => new Date('2026-11-17T00:00:00Z')) };
    await service.generate('u1', '10');
    const prompt = chat.generateAgentReply.mock.calls[0][2];
    expect(prompt).toContain('НОВЫЙ вопрос');
    expect(prompt).not.toContain('СТАРЫЙ');
  });

  it('хранит план по основной ленте', async () => {
    await service.generate('u1', '10');
    const insert = pg.query.mock.calls.find(([sql]: any[]) => /INSERT INTO action_plans/.test(sql));
    expect(insert[1][1]).toBe('u1_10');
  });
```

(Имена `chat`, `pg`, `service` и форма моков — как уже заведено в этом spec-файле; сверить и подогнать.)

В `chat-files.controller.spec.ts` тест про fresh переписать: `freshTs` в запросе игнорируется, `listForSession` зовётся с `'u1_12'`.

- [ ] **Step 2: Прогнать — падают.** `npx jest src/chat/action-plans src/chat/chat-files --silent`

- [ ] **Step 3: Реализация**

`action-plans.service.ts`:
- `sessionIdFor` → `function sessionIdFor(userId: string, assistantId: string): string { return \`${userId}_${assistantId}\`; }` (лента одна — spec 2026-11-17-context-reset);
- конструктор: `@Optional() private readonly contextResets?: ChatContextResetService` последним (импорт `Optional` из `@nestjs/common`);
- `generate(userId, assistantId)`:

```ts
  async generate(userId: string, assistantId: string): Promise<ActionPlan> {
    const sessionId = sessionIdFor(userId, assistantId);
    const history = await this.chat.getChatHistory(userId, assistantId, 30, 0);
    // После точки «Чистого листа» план — только по новому разговору: ассистент
    // старое уже не учитывает, и план не должен его воскрешать.
    let resetAt: Date | null = null;
    try { resetAt = this.contextResets ? await this.contextResets.get(userId, assistantId) : null; } catch { resetAt = null; }
    const messages = afterReset(history.messages, resetAt, (m: any) => m.timestamp)
      .filter((message: any) => clipped(message?.content, 1));
```

(остальное тело без изменений);
- `findForConversation(userId, assistantId)` — без `freshTs`.

`action-plans.controller.ts`: `generate` → `this.plans.generate(user.userId, assistantIdOf(body?.assistantId))`; `find` — без `@Query('freshTs')`.

`chat-files.controller.ts`: убрать `@Query('freshTs')`, сессия — `chatSessionId(userId, assistantId)` без метки. В `chat-files/session-id.ts` убрать параметр `freshTs` и ветку `_fresh_`; `session-id.spec.ts` привести к одной форме ключа.

- [ ] **Step 4: Прогнать — зелёные.**

- [ ] **Step 5: Commit** — `git commit -m "feat(chat): план действий и файлы — по основной ленте, план после точки"`

---

### Task 7: Голос Романа — преамбула и «Из переписки» после точки

**Files:**
- Modify: `src/voice-call/voice-call.service.ts` (~253), его модуль; `src/context/context.service.ts` (~308), `src/context/context.module.ts`
- Test: `src/voice-call/voice-call.context-reset.spec.ts`, `src/context/context.history-reset.spec.ts` (создать)

- [ ] **Step 1: Падающие тесты**

Контекст:

```ts
import { ContextService } from './context.service';

it('«Из переписки» — только после точки «Чистого листа»', async () => {
  const pg = { query: jest.fn(async () => ({ rows: [
    { sender_type: 'human', content: 'НОВОЕ', created_at: '2026-11-17T09:00:00Z' },
    { sender_type: 'human', content: 'СТАРОЕ', created_at: '2026-11-10T09:00:00Z' },
  ] })) };
  const svc = new ContextService(pg as any);
  (svc as any).contextResets = { get: jest.fn(async () => new Date('2026-11-17T00:00:00Z')) };
  const out = await (svc as any).sectionHistory('u1', 12);
  expect(out).toContain('НОВОЕ');
  expect(out).not.toContain('СТАРОЕ');
});
```

Голос — аналогично для метода, собирающего преамбулу (найти по SQL `LIMIT $2` с `PREAMBLE_MSG_LIMIT`; вызвать его напрямую, как это делают существующие спеки `src/voice-call/*.spec.ts`).

- [ ] **Step 2: Прогнать — падают.**

- [ ] **Step 3: Реализация**

В обоих местах: `created_at` в SELECT, фильтр после выборки:

```ts
    const resetAt = await this.contextResetAtSafe(userId, String(agentId));
    const rows = afterReset(res.rows, resetAt, (r: any) => r.created_at);
    if (!rows.length) return …; // прежний ранний выход
```

и дальше итерировать `rows` вместо `res.rows`. В каждом сервисе — последним в конструкторе `@Optional() private readonly contextResets?: ChatContextResetService` и маленький хелпер:

```ts
  private async contextResetAtSafe(userId: string, assistantId: string): Promise<Date | null> {
    try { return this.contextResets ? await this.contextResets.get(userId, assistantId) : null; } catch { return null; }
  }
```

Модули: `ContextModule` — добавить `ContextResetModule` в `imports`; `VoiceCallModule` получает сервис через `ChatModule` (он его реэкспортирует, Task 5) — если Nest не разрешит, добавить `ContextResetModule` в imports и там.

- [ ] **Step 4: Прогнать — зелёные**, плюс `npx jest src/voice-call src/context --silent`.

- [ ] **Step 5: Commit** — `git commit -m "feat(voice): голос Романа уважает точку «Чистого листа»"`

**Дополнение по ревью задачи 4:** `voice-call.service.ts` (~648) зовёт `chat.consolidateAfterChatPublic(…)` без момента хода — задачи из звонка получают время фоновой вставки и могут проскочить точку. Передать пятым аргументом момент начала звонка (то, что звонок хранит как начало; если его нет — `new Date()`, взятый при старте звонка, а не при сохранении). Тест: передан `Date` начала звонка.

---

### Task 8: Удаление аккаунта стирает точки

**Files:**
- Modify: `src/profile/profile-account-deletion.adapter.ts` (после `DELETE FROM action_plans`)
- Test: `src/profile/profile-account-deletion.adapter.spec.ts`, `src/profile/profile-account-deletion.pg.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `adapter.spec.ts` таблицу соответствий дополнить `[/^DELETE FROM chat_context_resets/, 'delete:context-resets']` и ожидаемую последовательность — `'delete:context-resets'` сразу после `'delete:plans'`.

В `pg.spec.ts`: рядом с миграцией action_plans — `await pool.query(readFileSync('src/chat/context-reset/migrations/001_chat_context_resets.sql', 'utf8'));`, в `TRUNCATE` добавить `chat_context_resets`, в сид удаляемого пользователя — `INSERT INTO chat_context_resets (user_id, assistant_id, reset_at) VALUES ($1, '10', now())`, в проверки после удаления — `SELECT count(*) FROM chat_context_resets WHERE user_id = $1` → 0 (и строка чужого пользователя на месте, если сид такой есть).

- [ ] **Step 2: Прогнать — падают.**

- [ ] **Step 3: Реализация** — после удаления планов:

```ts
  await tx.query(
    `DELETE FROM chat_context_resets
      WHERE user_id = $1
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );
```

- [ ] **Step 4: Прогнать — зелёные** (pg — с временной базой).

- [ ] **Step 5: Commit** — `git commit -m "feat(profile): удаление аккаунта стирает точки «Чистого листа»"`

---

### Task 9: Справка ассистентов

**Files:**
- Modify: `src/platform-kb/articles/chat.ts` (строки 7, 31, раздел «Если не получается»), `src/chat/platform-guide.ts:138`

- [ ] **Step 1: Правка текстов**

`chat.ts:7` (источник): `// источник: «Чистый лист» — src/chat/context-reset/*; src/chat/chat.service.ts (contextResetAt); spirits_front src/components/chat/contextReset.ts`

`chat.ts:31`:

```
- ${q('fresh')} — ассистент начинает с нуля: прошлые сообщения не учитывает, переписка остаётся в ленте; профиль и ${q('business')} видит. Черта в ленте показывает, откуда ассистент помнит разговор. Вернуть ему прошлое нельзя; нажать ещё раз — новая точка. Действует на всех устройствах.
```

В «Если не получается» добавить пункт:

```
- Ассистент «забыл» прошлый разговор — возможно, нажимали ${q('fresh')}: черта в ленте показывает, с какого места он помнит. Переписка выше цела, её можно пересказать ассистенту.
```

`platform-guide.ts:138`: `` `«${l.fresh}» — ассистент начинает с нуля: прошлые сообщения не учитывает, переписка остаётся. «${l.files}» — …` `` (хвост строки без изменений).

- [ ] **Step 2: Прогнать** `npx jest src/platform-kb src/chat/platform-guide.spec.ts --silent` — зелёные (ярлык «Чистый лист» не менялся; `sync-kb-labels` не нужен).

- [ ] **Step 3: Commit** — `git commit -m "docs(kb): «Чистый лист» — точка отсчёта памяти ассистента"`

---

### Task 10: Разовый перенос старых листов

**Files:**
- Create: `scripts/oneoff/2026-11-17-merge-fresh-sessions.sql`
- Test: `src/chat/context-reset/merge-fresh-sessions.pg.spec.ts`

- [ ] **Step 1: Падающий pg-тест**

```ts
import { Pool } from 'pg';
import * as fs from 'fs';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCRIPT = fs.readFileSync('scripts/oneoff/2026-11-17-merge-fresh-sessions.sql', 'utf8');

maybe('разовый перенос старых листов (pg)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    await pool.query(fs.readFileSync('src/chat/context-reset/migrations/001_chat_context_resets.sql', 'utf8'));
    await pool.query(`CREATE TABLE IF NOT EXISTS custom_chat_history (
      id serial PRIMARY KEY, session_id text NOT NULL, sender_type varchar(10) NOT NULL,
      content text NOT NULL, created_at timestamptz DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS chat_uploads (id serial PRIMARY KEY, user_id text, session_id text, created_at timestamptz DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS action_plans (id serial PRIMARY KEY, user_id text, session_id text, UNIQUE (user_id, session_id))`);
  });
  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS custom_chat_history, chat_uploads, action_plans, chat_context_resets');
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE custom_chat_history, chat_uploads, action_plans, chat_context_resets');
  });

  const msg = (s: string, at: string) =>
    pool.query(`INSERT INTO custom_chat_history (session_id, sender_type, content, created_at) VALUES ($1,'human','x',$2)`, [s, at]);

  it('переносит листы в основную ленту; точку ставит тому, кто «в режиме»', async () => {
    // A: последний ход — в листе → точка на метку листа
    await msg('79000000001_10', '2026-11-10T00:00:00Z');
    await msg('79000000001_10_fresh_1794804919138', '2026-11-16T05:00:00Z');
    // B: после листа писал в основную → точки нет
    await msg('79000000002_10_fresh_1794468117918', '2026-11-12T07:30:00Z');
    await msg('79000000002_10', '2026-11-17T05:00:00Z');
    // тестовый аккаунт не трогаем
    await msg('70000000000_12_fresh_1794804919138', '2026-11-16T05:00:00Z');

    await pool.query(SCRIPT);

    const { rows } = await pool.query(`SELECT session_id, count(*)::int n FROM custom_chat_history GROUP BY 1 ORDER BY 1`);
    expect(rows).toEqual([
      { session_id: '70000000000_12_fresh_1794804919138', n: 1 },
      { session_id: '79000000001_10', n: 2 },
      { session_id: '79000000002_10', n: 2 },
    ]);
    const resets = await pool.query(`SELECT user_id, assistant_id, reset_at FROM chat_context_resets ORDER BY 1`);
    expect(resets.rows).toHaveLength(1);
    expect(resets.rows[0]).toMatchObject({ user_id: '79000000001', assistant_id: '10' });
    expect(new Date(resets.rows[0].reset_at).getTime()).toBe(1794804919138);
  });

  it('повторный запуск ничего не меняет', async () => {
    await msg('79000000001_10_fresh_1794804919138', '2026-11-16T05:00:00Z');
    await pool.query(SCRIPT);
    await pool.query(SCRIPT);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM chat_context_resets`);
    expect(rows[0].n).toBe(1);
  });

  it('загрузки и план переезжают; план основной ленты при конфликте остаётся', async () => {
    await msg('79000000001_10_fresh_1794804919138', '2026-11-16T05:00:00Z');
    await pool.query(`INSERT INTO chat_uploads (user_id, session_id) VALUES ('79000000001','79000000001_10_fresh_1794804919138')`);
    await pool.query(`INSERT INTO action_plans (user_id, session_id) VALUES ('79000000001','79000000001_10'), ('79000000001','79000000001_10_fresh_1794804919138')`);
    await pool.query(SCRIPT);
    const up = await pool.query(`SELECT session_id FROM chat_uploads`);
    expect(up.rows[0].session_id).toBe('79000000001_10');
    const plans = await pool.query(`SELECT session_id FROM action_plans ORDER BY 1`);
    expect(plans.rows.map((r) => r.session_id)).toEqual(['79000000001_10', '79000000001_10_fresh_1794804919138']);
  });
});
```

- [ ] **Step 2: Прогнать — падает** (нет скрипта).

- [ ] **Step 3: Скрипт** `scripts/oneoff/2026-11-17-merge-fresh-sessions.sql`:

```sql
-- Разовый перенос старых листов «Чистого листа» в основные ленты
-- (spec 2026-11-17-context-reset). Запуск — после выката бэка, с OK владельца:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/oneoff/2026-11-17-merge-fresh-sessions.sql
-- Перед запуском сохранить карту для отката:
--   psql … -tA -F, -c "SELECT id, session_id FROM custom_chat_history WHERE session_id ~ '_fresh_[0-9]+$'" > fresh-map.csv
-- Тестовые аккаунты (common/test-users.ts) не трогаем: их листы — пинги мониторинга.
BEGIN;

CREATE TEMP TABLE fresh_rows ON COMMIT DROP AS
SELECT h.id,
       h.session_id,
       regexp_replace(h.session_id, '_fresh_[0-9]+$', '') AS base,
       substring(h.session_id FROM '_fresh_([0-9]+)$')::bigint AS ts,
       h.created_at
  FROM custom_chat_history h
 WHERE h.session_id ~ '_fresh_[0-9]+$'
   AND split_part(h.session_id, '_', 1) NOT IN ('70000000000', '79030169187', '79169403771', '79656445804')
   AND split_part(h.session_id, '_', 1) !~ '^790300[0-9]{5}$';

-- 1. Точка — парам, у кого последнее сообщение было в листе.
WITH last_any AS (
  SELECT regexp_replace(session_id, '_fresh_[0-9]+$', '') AS base, max(created_at) AS at
    FROM custom_chat_history
   WHERE regexp_replace(session_id, '_fresh_[0-9]+$', '') IN (SELECT base FROM fresh_rows)
   GROUP BY 1
), last_fresh AS (
  SELECT DISTINCT ON (base) base, ts, created_at
    FROM fresh_rows
   ORDER BY base, created_at DESC
)
INSERT INTO chat_context_resets (user_id, assistant_id, reset_at)
SELECT split_part(f.base, '_', 1), substring(f.base FROM '_([^_]+)$'),
       timestamptz 'epoch' + f.ts * interval '1 millisecond'  -- без округления через double
  FROM last_fresh f JOIN last_any a USING (base)
 WHERE f.created_at = a.at
ON CONFLICT (user_id, assistant_id) DO UPDATE
  SET reset_at = GREATEST(chat_context_resets.reset_at, EXCLUDED.reset_at);

-- 2. Сообщения — в основные ленты.
UPDATE custom_chat_history h SET session_id = f.base FROM fresh_rows f WHERE h.id = f.id;

-- 3. Загрузки и планы (план основной ленты при конфликте остаётся).
UPDATE chat_uploads u SET session_id = regexp_replace(u.session_id, '_fresh_[0-9]+$', '')
 WHERE u.session_id ~ '_fresh_[0-9]+$'
   AND u.user_id NOT IN ('70000000000', '79030169187', '79169403771', '79656445804')
   AND u.user_id !~ '^790300[0-9]{5}$';
UPDATE action_plans p SET session_id = regexp_replace(p.session_id, '_fresh_[0-9]+$', '')
 WHERE p.session_id ~ '_fresh_[0-9]+$'
   AND p.user_id NOT IN ('70000000000', '79030169187', '79169403771', '79656445804')
   AND p.user_id !~ '^790300[0-9]{5}$'
   AND NOT EXISTS (SELECT 1 FROM action_plans q
                    WHERE q.user_id = p.user_id
                      AND q.session_id = regexp_replace(p.session_id, '_fresh_[0-9]+$', ''));

COMMIT;
```

Замечание по шагу 1: `substring(base FROM '_([^_]+)$')` — id ассистента (последний сегмент основного ключа); userId — до первого `_` (телефон или UUID с дефисами — `_` в них нет).

- [ ] **Step 4: Прогнать — зелёный** (временная база).

- [ ] **Step 5: Commit** — `git add scripts/oneoff/2026-11-17-merge-fresh-sessions.sql src/chat/context-reset/merge-fresh-sessions.pg.spec.ts && git commit -m "chore(oneoff): перенос старых листов в основные ленты"`

---

### Task 11: Проверка бэка целиком

- [ ] **Step 1:** нода, ворктри на свежем sha: `NODE_OPTIONS=--max-old-space-size=5120 npx jest src/ --silent --maxWorkers=2` — сравнить с прогоном на `origin/main` того же дня (красное by design мерить дельтой, см. память «npm test бэка красный by design»).
- [ ] **Step 2:** `npx tsc --noEmit -p tsconfig.build.json` — без новых ошибок (дельта к main).
- [ ] **Step 3:** `npm run build` — зелёный; `tests/unit` (грузит `dist`): `cd tests && npx jest unit/ --silent`.
- [ ] **Step 4:** pg-спеки фичи и удаления — с временной базой.

---

## Часть 2. Фронт (воркдерево `spirits_front/.worktrees/context-reset`)

### Task 12: Чистые функции черты

**Files:**
- Create: `src/components/chat/contextReset.ts`, `src/components/chat/contextReset.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest';
import { parseContextResetAt, resetDividerIndex, sameResetAt } from './contextReset';

const R = new Date('2026-11-17T00:00:00Z');
const m = (iso: string) => ({ timestamp: new Date(iso) });

describe('parseContextResetAt', () => {
  it('нет поля (старый бэк) — undefined: состояние не трогаем', () => {
    expect(parseContextResetAt(undefined)).toBeUndefined();
  });
  it('null — точки нет', () => { expect(parseContextResetAt(null)).toBeNull(); });
  it('ISO — дата', () => { expect(parseContextResetAt(R.toISOString())?.getTime()).toBe(R.getTime()); });
  it('мусор — точки нет', () => { expect(parseContextResetAt('не дата')).toBeNull(); });
});

describe('resetDividerIndex', () => {
  it('без точки или без сообщений — черты нет', () => {
    expect(resetDividerIndex([m('2026-11-16T00:00:00Z')], null, false)).toBeNull();
    expect(resetDividerIndex([], R, false)).toBeNull();
  });
  it('перед первым сообщением новее точки', () => {
    expect(resetDividerIndex([m('2026-11-16T00:00:00Z'), m('2026-11-17T01:00:00Z'), m('2026-11-17T02:00:00Z')], R, false)).toBe(1);
  });
  it('новых ещё нет — черта внизу', () => {
    expect(resetDividerIndex([m('2026-11-16T00:00:00Z')], R, false)).toBe(1);
  });
  it('старше точки ничего нет и больше не подгрузить — черты нет', () => {
    expect(resetDividerIndex([m('2026-11-17T01:00:00Z')], R, false)).toBeNull();
  });
  it('старше точки есть на следующих страницах — черта сверху', () => {
    expect(resetDividerIndex([m('2026-11-17T01:00:00Z')], R, true)).toBe(0);
  });
  it('время строкой тоже понимает', () => {
    expect(resetDividerIndex([{ timestamp: '2026-11-16T00:00:00Z' }, { timestamp: '2026-11-17T01:00:00Z' }], R, false)).toBe(1);
  });
});

describe('sameResetAt', () => {
  it('сравнивает моменты, а не объекты', () => {
    expect(sameResetAt(new Date(R), new Date(R))).toBe(true);
    expect(sameResetAt(null, null)).toBe(true);
    expect(sameResetAt(R, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Прогнать — падает.** `./node_modules/.bin/vitest run src/components/chat/contextReset.test.ts`

- [ ] **Step 3: Реализация** `src/components/chat/contextReset.ts`:

```ts
/**
 * «Чистый лист» — точка отсчёта памяти ассистента (spec spirits_back
 * 2026-11-17-context-reset-design.md). Лента одна; бэк отдаёт точку с
 * историей (`contextResetAt`), а лента проводит по ней черту.
 */

export interface Timestamped {
  timestamp: Date | string;
}

/**
 * `contextResetAt` из ответа истории. undefined — поля нет (бэк до выката):
 * состояние не трогаем; null — точки нет.
 */
export function parseContextResetAt(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Куда в ленту вставить черту: индекс сообщения, ПЕРЕД которым она стоит
 * (`messages.length` — внизу), или null — черты нет.
 * - перед первым сообщением новее точки;
 * - новых ещё нет — внизу;
 * - старше точки ничего не загружено: черта сверху, если есть ещё страницы,
 *   иначе её нет (над ней было бы пусто).
 */
export function resetDividerIndex(
  messages: Timestamped[],
  resetAt: Date | null,
  hasMore: boolean,
): number | null {
  if (!resetAt || messages.length === 0) return null;
  const edge = resetAt.getTime();
  const first = messages.findIndex((msg) => new Date(msg.timestamp).getTime() > edge);
  if (first === -1) return messages.length;
  if (first === 0) return hasMore ? 0 : null;
  return first;
}

/** Опрос истории приносит точку каждые 8 с — без лишних перерисовок. */
export function sameResetAt(a: Date | null, b: Date | null): boolean {
  return (a ? a.getTime() : null) === (b ? b.getTime() : null);
}
```

- [ ] **Step 4: Прогнать — зелёный.**
- [ ] **Step 5: Commit** — `git add src/components/chat/contextReset.ts src/components/chat/contextReset.test.ts && git commit -m "feat(chat): черта «Чистого листа» — чистые функции"`

---

### Task 13: Панели и API — без freshTs

**Files:**
- Modify: `src/components/chat/files/chatFiles.ts:23-24`, `files/ChatFilesPanel.tsx:16-17,42,98,104`, `action-plan/ActionPlanPanel.tsx:10,23,36,44,85`, `src/services/actionPlansApi.ts:27-38`
- Test: `files/chatFiles.test.ts`, `files/ChatFilesPanel.test.tsx`, `action-plan/ActionPlanPanel.test.tsx`

- [ ] **Step 1: Обновить тесты (падают)**
  - `chatFiles.test.ts`: удалить тест с `&freshTs=`; оставить/добавить: `fetchChatFiles(12)` просит ровно `/webhook/chat/files?assistantId=12` (сверить фактический базовый URL в файле).
  - `ChatFilesPanel.test.tsx`: URL на строке ~47 — без `freshTs`; тест «повторная загрузка даёт битой миниатюре новый шанс» (126-137) — перезагрузку вызывать сменой `assistantId` вместо `freshTs`.
  - `ActionPlanPanel.test.tsx:66`: `expect(actionPlansApi.generate).toHaveBeenCalledWith(12);`
- [ ] **Step 2: Прогнать — падают.** `./node_modules/.bin/vitest run src/components/chat/files src/components/chat/action-plan`
- [ ] **Step 3: Реализация**
  - `chatFiles.ts`: `export async function fetchChatFiles(assistantId: string | number): Promise<ChatFileItem[]>` — без параметра `fresh` в URL.
  - `ChatFilesPanel.tsx`: убрать проп `freshTs` (тип, деструктуризация), `fetchChatFiles(assistantId)`, deps `[assistantId]`.
  - `ActionPlanPanel.tsx`: убрать проп `freshTs`; `actionPlansApi.get(assistantId)`, `actionPlansApi.generate(assistantId)`, deps без `freshTs`.
  - `actionPlansApi.ts`: `get(assistantId)` — `params` только с `assistantId`; `generate(assistantId)` — тело `{ assistantId }`.
- [ ] **Step 4: Прогнать — зелёные.**
- [ ] **Step 5: Commit** — `git commit -m "refactor(chat): панели и API без метки «Чистого листа»"`

---

### Task 14: ChatInterface — кнопка-действие, точка, черта

**Files:**
- Create: `src/components/chat/ContextResetDivider.tsx`, `src/components/chat/contextResetWiring.test.ts`
- Modify: `src/components/chat/ChatInterface.tsx`; тесты `filesWiring.test.ts`, `actionPlanWiring.test.ts`, `filesEventsWiring.test.ts`, `greetingRaceWiring.test.ts`

- [ ] **Step 1: Падающий wiring-тест** `contextResetWiring.test.ts` (по образцу соседних — читают исходник):

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, 'ChatInterface.tsx'), 'utf8');

describe('«Чистый лист» — точка отсчёта (проводка)', () => {
  it('метки freshTs больше нет нигде', () => {
    expect(src).not.toMatch(/freshTs|fresh_ts_|toggleFreshMode|getFreshKey/);
  });

  it('кнопка спрашивает подтверждение и зовёт reset-context', () => {
    const body = src.slice(src.indexOf('const startFreshContext = async'), src.indexOf('const handleCopyMessage'));
    expect(body).toContain("window.confirm(t('chat.fresh_confirm'))");
    expect(body).toContain("apiClient.post('/webhook/chat/reset-context', { assistantId })");
    expect(body).toContain('returnQueueToInput()');
    expect(body).toContain("window.alert(t('chat.fresh_failed'))");
  });

  it('кнопка в шапке и пункт меню неактивны, пока идёт ход', () => {
    // ровно два места: renderFreshButton и пункт меню «⋯»
    expect((src.match(/disabled=\{turnBusy \|\| resettingContext\}/g) || []).length).toBe(2);
  });

  it('история и опрос читают contextResetAt', () => {
    expect((src.match(/parseContextResetAt\(data\??\.contextResetAt\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('черта ставится по resetDividerIndex и не прикидывается сообщением', () => {
    expect(src).toContain('resetDividerIndex(messages, contextResetAt, hasMoreHistory)');
    expect(src).toContain('<ContextResetDivider />');
    const divider = readFileSync(join(__dirname, 'ContextResetDivider.tsx'), 'utf8');
    expect(divider).toContain('data-testid="chat-fresh-divider"');
    expect(divider).not.toContain('chat-message');
  });
});
```

- [ ] **Step 2: Прогнать — падает.** `./node_modules/.bin/vitest run src/components/chat/contextResetWiring.test.ts`

- [ ] **Step 3: `ContextResetDivider.tsx`**

```tsx
import { useTranslation } from 'react-i18next';

/**
 * Черта «Чистого листа» в ленте: выше — то, чего ассистент уже не учитывает.
 * Личного текста нет; лента и так под ym-hide-content.
 */
export function ContextResetDivider() {
  const { t } = useTranslation();
  return (
    <div data-testid="chat-fresh-divider" role="separator" className="flex items-center gap-2 my-2">
      <div className="flex-1 h-px bg-gray-300" />
      <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium text-center">
        {t('chat.fresh_divider')}
      </span>
      <div className="flex-1 h-px bg-gray-300" />
    </div>
  );
}
```

- [ ] **Step 4: Правки `ChatInterface.tsx`** (номера строк — по `e353428`, сдвигаются по ходу; искать по тексту)

4a. Импорты: `import { ContextResetDivider } from './ContextResetDivider';` и `import { parseContextResetAt, resetDividerIndex, sameResetAt } from './contextReset';`

4b. Блок 774-808 (комментарий «Чистый лист», `getFreshKey`, `freshTs`, эффект, `toggleFreshMode`) заменить на:

```tsx
  // «Чистый лист» (spec spirits_back 2026-11-17-context-reset): точка отсчёта
  // памяти ассистента. Лента одна; точку хранит бэк и отдаёт с историей —
  // черта в ленте показывает, откуда ассистент помнит разговор.
  const [contextResetAt, setContextResetAt] = useState<Date | null>(null);
  const [resettingContext, setResettingContext] = useState(false);
```

4c. Эффект панелей: `}, [selectedAssistant?.id, freshTs]);` → `}, [selectedAssistant?.id]);`

4d. `openFilesPanel`: убрать `fresh: !!freshTs, ` из объекта события.

4e. Эффект истории: комментарий у `let stale` — «Смена ассистента запускает новую загрузку, а прежний запрос ещё в пути…» (без «Чистого листа»); перед `try {` добавить `setContextResetAt(null);`; убрать `freshParam`, URL — `` `/webhook/chat/history?assistantId=${selectedAssistant.id}&limit=30&offset=0` ``; после `setHistoryOffset(30);` добавить `setContextResetAt(parseContextResetAt(data.contextResetAt) ?? null);`; deps — `[selectedAssistant?.id, hasUserSelectedAssistant]`.

4f. `pullHistoryOnce`: убрать `freshParam`, URL `…&limit=5&offset=0`; сразу после `const data = await response.json();`:

```tsx
      // Точку могли поставить в другой вкладке или на телефоне.
      const polledResetAt = parseContextResetAt(data?.contextResetAt);
      if (polledResetAt !== undefined && selectedAssistantIdRef.current === assistantId) {
        setContextResetAt(prev => (sameResetAt(prev, polledResetAt) ? prev : polledResetAt));
      }
```

4g. `loadMoreHistory`: убрать `freshParam`, URL `…&limit=30&offset=${historyOffset}`.

4h. Тело хода (`sendMessageToAI`): удалить строку `...(freshTs ? { fresh: true, freshTs } : {})`.

4i. Загрузка (`handleFileTaskSubmit`): удалить комментарий «Чистый лист — те же поля…» и блок `if (freshTs) { … }`.

4j. Сразу после `handleClearChat` (перед `const handleCopyMessage`):

```tsx
  const startFreshContext = async () => {
    if (!selectedAssistant || turnBusy || resettingContext) return;
    if (!window.confirm(t('chat.fresh_confirm'))) return;
    // Набранная очередь писалась для прежней памяти — возвращаем её в поле,
    // а не досылаем: после точки человек сам решит, что отправить.
    returnQueueToInput();
    const assistantId = selectedAssistant.id;
    setResettingContext(true);
    try {
      const response = await apiClient.post('/webhook/chat/reset-context', { assistantId });
      if (!response.ok) throw new Error(`reset-context ${response.status}`);
      const data = await response.json();
      if (selectedAssistantRef.current?.id !== assistantId) return;
      setContextResetAt(parseContextResetAt(data?.resetAt) ?? new Date());
      // Черта встаёт внизу — держим ленту прижатой, чтобы её было видно.
      pinToBottomRef.current = true;
      pinStartedAtRef.current = performance.now();
    } catch (error) {
      console.error('Failed to reset assistant context:', error);
      window.alert(t('chat.fresh_failed'));
    } finally {
      setResettingContext(false);
    }
  };
```

4k. `renderFreshToggle` (2698-2724) заменить на:

```tsx
  // «Чистый лист» в шапке живёт в двух местах: на десктопе справа с подписью,
  // на мобиле — иконкой слева, на месте ссылки «Подобрать специалиста» (та
  // обрезала баланс токенов). Разметка общая. Это действие, а не тумблер:
  // состояния «включён» нет — точку видно чертой в ленте.
  const renderFreshButton = (testId: string, wrapperClass: string) => (
    <button
      onClick={() => { void startFreshContext(); }}
      disabled={turnBusy || resettingContext}
      data-testid={testId}
      className={clsx(
        'items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors disabled:opacity-50',
        wrapperClass,
        'border-gray-200 text-gray-500 hover:text-forest-700 hover:border-forest-300'
      )}
      title={t('chat.fresh_mode_off_title')}
      aria-label={t('chat.fresh_mode_label')}
    >
      <Eraser className="w-4 h-4" />
      <span className="hidden md:inline text-xs font-medium">{t('chat.fresh_mode_label')}</span>
    </button>
  );
```

Оба вызова `renderFreshToggle(` → `renderFreshButton(`. Комментарий у `renderCallButton` «Тот же тумблер-стиль, что и «Чистый лист»» → «Та же форма кнопки, что у «Чистого листа»».

4l. Пункт меню «⋯» (3086-3093):

```tsx
                      <button
                        role="menuitem"
                        data-testid="chat-fresh-menuitem"
                        onClick={() => { setShowChatActions(false); void startFreshContext(); }}
                        disabled={turnBusy || resettingContext}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <Eraser className="w-4 h-4" />
                        {t('chat.fresh_mode_label')}
                      </button>
```

4m. Панели: у `ChatFilesPanel` и `ActionPlanPanel` — `key={selectedAssistant.id}`, удалить `freshTs={freshTs}`; комментарий над key у `ChatFilesPanel` сократить до «key по ассистенту: смена ассистента пересоздаёт панель, запоздалый fetch дозревает у выброшенного инстанса».

4n. Черта. Перед `return (` компонента (рядом с прочими вычислениями для рендера):

```tsx
  const resetDividerAt = resetDividerIndex(messages, contextResetAt, hasMoreHistory);
```

В ленте `messages.map((message, mi) => (` + `<div key={message.id}` →

```tsx
        ) : messages.map((message, mi) => (
          <React.Fragment key={message.id}>
          {mi === resetDividerAt && <ContextResetDivider />}
          <div
            data-testid="chat-message"
```

и закрытие этого элемента (`          </div>\n        ))}` перед комментарием `{/* Suggested-prompt chips for Роман`) →

```tsx
          </div>
          </React.Fragment>
        ))}

        {!historyLoading && resetDividerAt === messages.length && <ContextResetDivider />}
```

- [ ] **Step 5: Обновить wiring-тесты**
  - `filesWiring.test.ts`: тесты про `freshTs={freshTs}` и key `${id}|${freshTs}` → key `{selectedAssistant.id}`, пропа `freshTs` нет; якорь мобильного меню `'toggleFreshMode(); }}'` → `'startFreshContext(); }}'`; регэксп эффекта панелей → `}, [selectedAssistant?.id]);`.
  - `actionPlanWiring.test.ts`: вместо `freshTs={freshTs}` — `key={selectedAssistant.id}` у `ActionPlanPanel` и отсутствие `freshTs`.
  - `filesEventsWiring.test.ts`: регэксп события без `fresh: !!freshTs`.
  - `greetingRaceWiring.test.ts`: якоря `historyEffect()` → `'&limit=30&offset=0`'` и `'}, [selectedAssistant?.id, hasUserSelectedAssistant]);'`; текст describe без «Чистого листа». Сами проверки stale-guard не менять.
  - Остальные сторожа (`uploadMemory.test.tsx`, `remoteTurnWiring.test.ts`, `interactivityWiring.test.ts`, `streamFailureWiring.test.ts`) прогнать — должны остаться зелёными без правок.
- [ ] **Step 6: Прогнать** (нода, ворктри фронта): `pnpm vitest run src/components/chat && pnpm typecheck` — зелёные (typecheck — дельта к базе: см. память «tsc фронта — с -p, база 45»).
- [ ] **Step 7: Commit** — `git commit -m "feat(chat): «Чистый лист» — точка отсчёта: кнопка с подтверждением и черта в ленте"`

---

### Task 15: Тексты в 7 локалях и справка «Помощь»

**Files:**
- Modify: `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json` — ключи `chat.*`, `help.faq[18].a`

- [ ] **Step 1: Ключи `chat`** — в каждой локали: обновить `fresh_mode_off_title`, удалить `fresh_mode_on_title`, добавить `fresh_confirm`, `fresh_divider`, `fresh_failed`. `fresh_mode_label` не трогать.

| | `fresh_mode_off_title` | `fresh_confirm` | `fresh_divider` | `fresh_failed` |
|---|---|---|---|---|
| ru | Чистый лист: ассистент перестанет учитывать прошлые сообщения. Переписка останется, профиль ассистент видит. | Начать с чистого листа? Ассистент перестанет учитывать сообщения выше. Переписка останется. | Чистый лист — ассистент не видит сообщения выше | Не получилось начать с чистого листа. Попробуйте ещё раз. |
| en | Fresh start: the assistant stops taking past messages into account. The chat stays, and the assistant still sees your profile. | Start fresh? The assistant will stop taking the messages above into account. The chat stays. | Fresh start — the assistant doesn't see the messages above | Couldn't start fresh. Please try again. |
| es | Hoja en blanco: el asistente deja de tener en cuenta los mensajes anteriores. El chat se conserva y el asistente sigue viendo tu perfil. | ¿Empezar con una hoja en blanco? El asistente dejará de tener en cuenta los mensajes de arriba. El chat se conserva. | Hoja en blanco — el asistente no ve los mensajes de arriba | No se pudo empezar con una hoja en blanco. Inténtalo de nuevo. |
| de | Neustart: Der Assistent berücksichtigt frühere Nachrichten nicht mehr. Der Chat bleibt erhalten, dein Profil sieht er weiterhin. | Neu starten? Der Assistent berücksichtigt die Nachrichten oben nicht mehr. Der Chat bleibt erhalten. | Neustart — der Assistent sieht die Nachrichten oben nicht | Neustart hat nicht geklappt. Versuch es noch einmal. |
| fr | Page blanche : l'assistant ne tient plus compte des messages précédents. La conversation reste, et il voit toujours ton profil. | Repartir de zéro ? L'assistant ne tiendra plus compte des messages ci-dessus. La conversation reste. | Page blanche — l'assistant ne voit pas les messages ci-dessus | Impossible de repartir de zéro. Réessaie. |
| pt | Página em branco: o assistente deixa de ter em conta as mensagens anteriores. A conversa mantém-se e o assistente continua a ver o seu perfil. | Começar do zero? O assistente deixa de ter em conta as mensagens acima. A conversa mantém-se. | Página em branco — o assistente não vê as mensagens acima | Não foi possível começar do zero. Tente novamente. |
| zh | 空白模式：助手将不再参考之前的消息。聊天记录会保留，助手仍能看到你的个人资料。 | 要从头开始吗？助手将不再参考上面的消息，聊天记录会保留。 | 空白模式 — 助手看不到上面的消息 | 无法从头开始，请重试。 |

- [ ] **Step 2: `help.faq[18].a`** — ярлык ровно один раз:

- ru: «Нажмите «Чистый лист» в шапке чата (на телефоне — в меню «⋯») и подтвердите. С этого места ассистент не учитывает прошлые сообщения: он видит профиль и новый разговор. Переписка остаётся в ленте, а черта показывает, откуда ассистент её помнит. Вернуть ему прошлое нельзя — можно только начать заново с новой точки.»
- en: «Tap «Fresh start» in the chat header (on a phone, in the «⋯» menu) and confirm. From that point the assistant no longer takes past messages into account: it sees your profile and the new conversation. The chat stays in the feed, and a line shows where the assistant's memory starts. The earlier context can't be restored — you can only start again from a new point.»
- es: «Pulsa «Hoja en blanco» en la cabecera del chat (en el móvil, en el menú «⋯») y confirma. Desde ese punto el asistente deja de tener en cuenta los mensajes anteriores: ve tu perfil y la nueva conversación. El chat se conserva y una línea marca desde dónde lo recuerda el asistente. El contexto anterior no se puede recuperar; solo puedes volver a empezar desde un nuevo punto.»
- de: «Tippe in der Kopfzeile des Chats auf „Neustart“ (auf dem Handy im Menü „⋯“) und bestätige. Ab dieser Stelle berücksichtigt der Assistent frühere Nachrichten nicht mehr: Er sieht dein Profil und das neue Gespräch. Der Chat bleibt erhalten, eine Linie zeigt, ab wo sich der Assistent erinnert. Den früheren Kontext kannst du nicht zurückholen – du kannst nur von einer neuen Stelle aus neu beginnen.»
- fr: «Appuie sur « Page blanche » dans l'en-tête du chat (sur téléphone, dans le menu « ⋯ ») et confirme. À partir de là, l'assistant ne tient plus compte des messages précédents : il voit ton profil et la nouvelle conversation. La conversation reste affichée, et une ligne indique à partir d'où l'assistant s'en souvient. Le contexte précédent ne peut pas être rétabli : tu peux seulement repartir d'un nouveau point.»
- pt: «Toque em «Página em branco» no cabeçalho do chat (no telemóvel, no menu «⋯») e confirme. A partir desse ponto, o assistente deixa de ter em conta as mensagens anteriores: vê o seu perfil e a nova conversa. A conversa mantém-se no histórico e uma linha mostra a partir de onde o assistente se lembra. O contexto anterior não pode ser recuperado — só é possível recomeçar a partir de um novo ponto.»
- zh: «点击聊天顶部的「空白模式」（手机上在「⋯」菜单中）并确认。从这里开始，助手不再参考之前的消息：它能看到你的个人资料和新的对话。聊天记录会保留，一条分隔线标明助手从哪里开始记得。之前的上下文无法恢复，只能从新的位置重新开始。»

Правка — node-скриптом (`JSON.parse` → присвоить → `JSON.stringify(j, null, 2) + '\n'`), чтобы не испортить экранирование (память «Write портит \uXXXX»); перед записью сверить, что отступ в файлах — 2 пробела, и что `git diff` меняет только нужные строки.

- [ ] **Step 3: Прогнать** (нода): `pnpm check-locales && pnpm check-keys && pnpm check-hardcoded && pnpm check-locale-format && pnpm vitest run src/i18n src/pages/helpContent.test.ts` — зелёные (`check-locale-format` красный на main по звонку — мерить дельтой, см. память «i18n-скрипты фронта»).
- [ ] **Step 4: Commit** — `git add src/i18n/locales/*.json && git commit -m "i18n(chat): «Чистый лист» — точка отсчёта, 7 языков"`

### Task 16: Проверка фронта целиком

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm build` на ноде; `npx eslint` по тронутым файлам (полный lint красный на main).
- [ ] Ручная проверка на `test.linkeon.io` после выката на test (Basic Auth): нажать «Чистый лист» → подтверждение → черта внизу; следующий ход — ассистент не помнит прошлого; F5 — черта на месте; вторая вкладка видит черту после опроса.

---

## Выкат (только с OK владельца)

1. Слить `feat/context-reset` обоих репо в `main` (бэк и фронт), запушить.
2. `bash ~/Downloads/spirits_back/scripts/deploy.sh` со свежих клонов (память «Выкат: правила»): test → smoke → prod → smoke. Проверить хеш бандла фронта и живость (`/webhook/agents`).
3. С OK: карта отката + `scripts/oneoff/2026-11-17-merge-fresh-sessions.sql` на проде; счётчики до/после.
4. Сказать коллеге Дмитрию про Flutter: тумблер «выключить» больше не возвращает память — экран поменять на действие с подтверждением.
