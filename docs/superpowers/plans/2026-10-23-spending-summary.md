# Сводка расхода по месяцам — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** пользователь видит в окне оплаты, на странице `/tokens` и в кошельке мини-аппа, куда ушли токены — по месяцам и категориям; старые траты мимо журнала перенесены в журнал.

**Architecture:** бэкенд отдаёт `GET /webhook/tokens/spending` — группировку журнала `token_transactions` по месяцу (в поясе пользователя) и категории. Категория определяется при чтении одной таблицей правил (`src/tokens/spend-category.ts`), из которой строятся и SQL, и функция для тестов. Перенос старых трат — идемпотентный SQL-файл модуля `tokens`, который `TokensSchemaService` применяет при каждом старте API. Фронт: общий разбор ответа и общий список месяцев (`src/shared/`), обёртка для веба и секция в кошельке мини-аппа.

**Tech Stack:** NestJS 10 + node-pg + PostgreSQL 16, jest/ts-jest (бэк); React 18 + TypeScript + i18next + Tailwind, vitest (фронт).

**Спека:** `docs/superpowers/specs/2026-10-23-spending-summary-design.md` (в этом же воркдереве бэка).

---

## Правила работы (прочитать до первой задачи)

- **Пути.** Бэк — воркдерево `~/Downloads/spirits_back/.worktrees/spending-summary` (ветка `feat/spending-summary`). Фронт — `~/Downloads/spirits_front/.worktrees/spending-summary` (та же ветка, заводится в задаче 0). План и спеку читать **только** из воркдерева бэка: копии в основных чекаутах устаревают.
- **Тесты и сборки — на тест-ноде `dv@85.192.61.231`, не на маке.** Мак их не тянет (решение владельца). Код на ноду попадает через `git push` ветки и `git checkout <sha>` в своих клонах `~/ci/wt/spending-back` и `~/ci/wt/spending-front` (заводятся в задаче 0). Не rsync. Не трогать `~/spirits_back`, `~/spirits_front` (живой стенд test) и `~/dev/*` (там работают другие сессии).
- **Шаг «прогнать тест» = закоммитить и вызвать помощник** (задача 0 его создаёт):
  ```bash
  bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh back 'npx jest src/tokens/spend-category'
  bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/shared/spending.test.ts'
  ```
  Помощник пушит текущий коммит воркдерева в `origin/feat/spending-summary`, ставит клон на ноде ровно на этот sha и выполняет команду. Красный тест коммитится как `test(...): … (красный)` — так в репозитории уже принято.
- **Бэк ставится `npm ci`, не pnpm.** jest бэка типы не проверяет — гейт типов `npx tsc --noEmit -p tsconfig.build.json`. Фронт: голый `tsc` проверяет ноль файлов, нужен `-p tsconfig.app.json`; на `main` есть предсуществующие ошибки — мерить дельтой.
- **Репозитории публичные:** в коде, тестах, коммитах и этом плане — ни номеров телефонов, ни почт, ни секретов. В тестах пользователи — `u-a`, `u-sum` и т. п.
- **`\uXXXX` в исходниках не писать** — инструмент записи превращает их в невидимые символы.
- **Коммиты** — по-русски, в конце строка `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. В `main` ничего не вливать и ничего не выкатывать без явного «катим» владельца (задачи 14–15).

## Карта файлов

Бэк (`spirits_back`):

| файл | что делает |
|---|---|
| `src/tokens/spend-category.ts` (новый) | таблица правил категорий, `classifySpend()`, `spendCategorySql()` |
| `src/tokens/spend-category.samples.ts` (новый) | образцы реальных подписей журнала с ожидаемой категорией — общие для двух спеков |
| `src/tokens/spend-category.spec.ts` (новый) | юнит-тесты правил |
| `src/tokens/spending.service.ts` (новый) | `SpendingService.monthly()`, `groupMonths()`, `clampMonths()`, пояс |
| `src/tokens/spending.service.spec.ts` (новый) | юнит-тесты сервиса на заглушке pg |
| `src/tokens/tokens.controller.ts` | маршрут `GET tokens/spending` |
| `src/tokens/tokens.controller.spec.ts` (новый) | тесты маршрута |
| `src/tokens/tokens.module.ts` | `SpendingService` в providers |
| `src/tokens/migrations/002_backfill_spend_history.sql` (новый) | индекс журнала + перенос старых трат |
| `src/tokens/tokens-schema.service.ts` | применяет 002 после 001 |
| `src/tokens/tokens-schema.spec.ts` | сторожа текста 002 |
| `src/tokens/spending.integration.spec.ts` (новый) | живой Postgres: SQL ≡ TS, пояс, сводка, перенос |

Фронт (`spirits_front`):

| файл | что делает |
|---|---|
| `src/shared/spending.ts` (новый) | типы, `parseSpending()`, `categoryLabelKey()`, `monthLabel()`, `spendingUrl()` |
| `src/shared/spending.test.ts` (новый) | тесты разбора, подписей, URL |
| `src/shared/ui/SpendingMonths.tsx` (новый) | список месяцев со сворачиванием — общий для веба и мини-аппа |
| `src/shared/ui/SpendingMonths.test.tsx` (новый) | тесты отрисовки |
| `src/components/tokens/SpendingSummary.tsx` (новый) | веб-блок: запрос + заголовок + список |
| `src/components/tokens/SpendingSummary.test.tsx` (новый) | тесты блока |
| `src/components/tokens/TokenPackages.tsx`, `src/pages/TokenPurchasePage.tsx` | блок над историей пополнений |
| `src/tma/screens/walletData.ts`, `walletData.test.ts`, `WalletScreen.tsx` | третий источник и секция в кошельке |
| `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json` | `payment.spending.title` и `payment.spending.cat.*` |

---

### Task 0: Подготовка окружения

**Files:** создаются вне отслеживаемых деревьев — `~/Downloads/spirits_back/.worktrees/spending-node-run.sh`, воркдерево фронта, клоны на ноде.

- [ ] **Step 1: Воркдерево фронта**

```bash
cd ~/Downloads/spirits_front && git fetch -q origin \
  && git worktree add -q .worktrees/spending-summary -b feat/spending-summary origin/main \
  && git -C .worktrees/spending-summary branch --unset-upstream \
  && git -C .worktrees/spending-summary status -sb | head -1
```
Ожидается: `## feat/spending-summary` (без `...origin/main` — чтобы случайный `git push` не ушёл в main).

- [ ] **Step 2: Мастер-соединение к ноде** (нода рвёт пачки новых ssh по `MaxStartups`)

```bash
ssh -O check -S ~/.ssh/cm-lnode dv@85.192.61.231 2>/dev/null \
  || ssh -M -S ~/.ssh/cm-lnode -o ControlPersist=4h -fN dv@85.192.61.231
```

- [ ] **Step 3: Помощник прогонов**

Создать `~/Downloads/spirits_back/.worktrees/spending-node-run.sh` (каталог `.worktrees/` игнорируется git, файл лежит вне обоих воркдеревьев):

```bash
#!/bin/bash
# Прогон команды на тест-ноде на ТЕКУЩЕМ коммите воркдерева spending-summary.
#   spending-node-run.sh back|front '<команда>'
set -euo pipefail
repo=$1; shift
wt="$HOME/Downloads/spirits_${repo}/.worktrees/spending-summary"
sock="$HOME/.ssh/cm-lnode"
ssh -O check -S "$sock" dv@85.192.61.231 2>/dev/null \
  || ssh -M -S "$sock" -o ControlPersist=4h -fN dv@85.192.61.231
git -C "$wt" diff --quiet && git -C "$wt" diff --cached --quiet \
  || { echo "в воркдереве незакоммиченные правки — сначала коммит" >&2; exit 2; }
git -C "$wt" push -q origin "HEAD:refs/heads/feat/spending-summary"
sha=$(git -C "$wt" rev-parse HEAD)
ssh -S "$sock" dv@85.192.61.231 "set -e; . ~/.nvm/nvm.sh >/dev/null; cd ~/ci/wt/spending-${repo}; \
  git fetch -q origin feat/spending-summary; git checkout -q --detach ${sha}; \
  test \"\$(git rev-parse HEAD)\" = ${sha}; echo \"== ${repo} @ \${PWD} ${sha:0:7}\"; $*"
```

```bash
chmod +x ~/Downloads/spirits_back/.worktrees/spending-node-run.sh
```

Помощник откажется работать с незакоммиченными правками — иначе на ноде проверялся бы не тот код.

- [ ] **Step 4: Свои клоны на ноде и установка зависимостей**

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'set -e; . ~/.nvm/nvm.sh >/dev/null
git -C ~/ci/spirits_back fetch -q origin
[ -d ~/ci/wt/spending-back ] || git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/spending-back origin/main
cd ~/ci/wt/spending-back && npm ci --no-audit --no-fund >/dev/null && echo back-ok
git -C ~/ci/spirits_front fetch -q origin
[ -d ~/ci/wt/spending-front ] || git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/spending-front origin/main
cd ~/ci/wt/spending-front && pnpm install --frozen-lockfile >/dev/null && echo front-ok'
```
Ожидается: `back-ok`, `front-ok`.

- [ ] **Step 5: База для гейтов (на `origin/main`, до любых правок)**

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'set -e; . ~/.nvm/nvm.sh >/dev/null
cd ~/ci/wt/spending-back && echo "back tsc build:" && (npx tsc --noEmit -p tsconfig.build.json && echo clean)
cd ~/ci/wt/spending-front && echo "front tsc app errors:" && (npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c "error TS" || true)
node scripts/check-no-hardcoded-locale.mjs >/tmp/spending-locfmt-base.txt 2>&1; echo "locale-format exit=$?"; cat /tmp/spending-locfmt-base.txt | tail -5'
```
Записать числа (ошибки `tsc` фронта, вывод `check-no-hardcoded-locale`) — в задаче 12 сравнивать с ними.

---

### Task 1: Правила категорий (бэк)

**Files:**
- Create: `src/tokens/spend-category.ts`
- Create: `src/tokens/spend-category.samples.ts`
- Test: `src/tokens/spend-category.spec.ts`

- [ ] **Step 1: Образцы подписей**

`src/tokens/spend-category.samples.ts`:

```ts
/**
 * Образцы consumed-строк журнала: различные подписи прода за 90 дней до
 * 23.10.2026 (цифры, имена и id заменены). Общие для юнит-теста правил и для
 * живого прогона, который сверяет SQL-выражение с classifySpend.
 *
 * Новая подпись в коде списания — новая строка здесь с ожидаемой категорией.
 */
export type SpendSample = [description: string | null, metadata: Record<string, unknown> | null, expected: string];

export const SPEND_SAMPLES: SpendSample[] = [
  ['Ответ ассистента «Роман»', { source: 'usage', costUsd: 0.26 }, 'replies'],
  ['Ответ ассистента «Роман», 3 мин работы', { taken: 'turn' }, 'replies'],
  ['Ответ ассистента, 2 мин работы', null, 'replies'],
  ['Ответ ассистента', null, 'replies'],
  [null, null, 'replies'],
  ['Ответ ассистента «Роман», 4 мин работы', { callId: 'c-1', durationSec: 240 }, 'calls'],
  ['Ответ ассистента «Роман»', { callId: 'c-2' }, 'calls'],
  ['image', null, 'images'],
  ['Генерация видео', { mode: 'text2video', model: 'veo-3.1' }, 'video'],
  ['Генерация видео', { mode: 'image2video', model: 'veo-3.1', composed: true }, 'video'],
  ['Озвучка ответа', { listen_id: 'l-1', chars: 900 }, 'voice'],
  ['Синтез речи', { clip_id: 'k-1' }, 'voice'],
  ['tg-bot', null, 'tg_bots'],
  ['product turn 3f2a9c1e-0000-4000-8000-000000000001', null, 'products'],
  ['Аренда продукта demo — месяц', { kind: 'product_rent', product_id: 'p-1' }, 'products'],
];
```

- [ ] **Step 2: Красный тест**

`src/tokens/spend-category.spec.ts`:

```ts
import { classifySpend, spendCategorySql, SPEND_RULES } from './spend-category';
import { SPEND_SAMPLES } from './spend-category.samples';

describe('classifySpend', () => {
  it.each(SPEND_SAMPLES)('«%s» %j → %s', (description, metadata, expected) => {
    expect(classifySpend(description, metadata)).toBe(expected);
  });

  it('незнакомая подпись — other', () => {
    expect(classifySpend('что-то новое', null)).toBe('other');
  });

  it('подпись сравнивается целиком, а не подстрокой', () => {
    expect(classifySpend('image edit', null)).toBe('other');
    expect(classifySpend('Возврат за видео', null)).toBe('other');
  });

  it('callId: null не делает строку звонком — как ->> в SQL', () => {
    expect(classifySpend('Ответ ассистента', { callId: null })).toBe('replies');
  });
});

describe('spendCategorySql', () => {
  it('ветка на каждое правило в порядке SPEND_RULES и other по умолчанию', () => {
    const sql = spendCategorySql();
    const positions = SPEND_RULES.map((r) => sql.indexOf(`THEN '${r.category}'`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sql).toMatch(/ELSE 'other' END$/);
  });

  it('звонок — по ->> (JSON null не звонок), подписи — целиком и по началу', () => {
    const sql = spendCategorySql('t.description', 't.metadata');
    expect(sql).toContain(`(t.metadata ->> 'callId') IS NOT NULL`);
    expect(sql).toContain(`t.description = 'image'`);
    expect(sql).toContain(`starts_with(t.description, 'Ответ ассистента')`);
    expect(sql).toContain('t.description IS NULL');
  });
});
```

- [ ] **Step 3: Коммит и прогон — должен упасть**

```bash
cd ~/Downloads/spirits_back/.worktrees/spending-summary
git add src/tokens/spend-category.samples.ts src/tokens/spend-category.spec.ts
git commit -q -m "test(tokens): правила категорий расхода (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/spend-category 2>&1 | tail -15'
```
Ожидается: FAIL, `Cannot find module './spend-category'`.

- [ ] **Step 4: Реализация**

`src/tokens/spend-category.ts`:

```ts
/**
 * Категории расхода для сводки «Расход по месяцам».
 *
 * Категория определяется при ЧТЕНИИ журнала — по подписи и метаданным строки
 * (решение владельца 23.10.2026, спека
 * docs/superpowers/specs/2026-10-23-spending-summary-design.md). Код, который
 * списывает токены, не трогаем: таких мест восемь, и там же работают другие
 * сессии.
 *
 * Правила записаны ОДИН раз — в SPEND_RULES. Из них строятся и SQL-выражение
 * для группировки в базе (spendCategorySql), и функция для тестов
 * (classifySpend); spending.integration.spec.ts сверяет на живом Postgres, что
 * оба дают одно и то же.
 *
 * Переименуют подпись списания — такие строки уйдут в 'other'. Итоги при этом
 * верны, поедет только раскладка. Сторож — образцы в spend-category.samples.ts.
 */
export type SpendCategory =
  | 'replies'
  | 'calls'
  | 'images'
  | 'video'
  | 'voice'
  | 'tg_bots'
  | 'products'
  | 'other';

interface SpendRule {
  category: Exclude<SpendCategory, 'other'>;
  /** Ключ metadata; строка относится сюда, если значение не null. */
  metadataKey?: string;
  /** Строка без подписи тоже относится сюда. */
  nullDescription?: boolean;
  /** Подпись совпадает целиком. */
  equals?: string[];
  /** Подпись начинается с. */
  prefixes?: string[];
}

/** Порядок важен: выигрывает первое совпавшее правило. */
export const SPEND_RULES: readonly SpendRule[] = [
  // Звонок подписан «Ответ ассистента…», отличает его только callId — поэтому первым.
  { category: 'calls', metadataKey: 'callId' },
  // До вечера 10.08.2026 ответы писались без подписи; картинки, видео и TG тогда шли мимо журнала.
  { category: 'replies', prefixes: ['Ответ ассистента'], nullDescription: true },
  { category: 'images', equals: ['image'] },
  { category: 'video', equals: ['Генерация видео'] },
  { category: 'voice', equals: ['Озвучка ответа', 'Синтез речи'] },
  { category: 'tg_bots', equals: ['tg-bot'] },
  { category: 'products', prefixes: ['product turn ', 'Аренда продукта'] },
];

export function classifySpend(
  description: string | null | undefined,
  metadata?: Record<string, unknown> | null,
): SpendCategory {
  for (const rule of SPEND_RULES) {
    if (rule.metadataKey && metadata && metadata[rule.metadataKey] != null) return rule.category;
    if (rule.nullDescription && description == null) return rule.category;
    if (description != null) {
      if (rule.equals?.includes(description)) return rule.category;
      if (rule.prefixes?.some((p) => description.startsWith(p))) return rule.category;
    }
  }
  return 'other';
}

/** Строковый литерал SQL. Правила — константы кода, но кавычку всё равно экранируем. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * CASE-выражение категории для строки журнала. Колонки передаются, чтобы
 * выражение работало и с алиасом таблицы.
 */
export function spendCategorySql(descriptionCol = 'description', metadataCol = 'metadata'): string {
  const branches = SPEND_RULES.map((rule) => {
    const conds: string[] = [];
    if (rule.metadataKey) conds.push(`(${metadataCol} ->> ${lit(rule.metadataKey)}) IS NOT NULL`);
    if (rule.nullDescription) conds.push(`${descriptionCol} IS NULL`);
    for (const e of rule.equals ?? []) conds.push(`${descriptionCol} = ${lit(e)}`);
    for (const p of rule.prefixes ?? []) conds.push(`starts_with(${descriptionCol}, ${lit(p)})`);
    return `WHEN ${conds.join(' OR ')} THEN ${lit(rule.category)}`;
  });
  return `CASE ${branches.join(' ')} ELSE 'other' END`;
}
```

- [ ] **Step 5: Коммит и прогон — зелёный**

```bash
git add src/tokens/spend-category.ts
git commit -q -m "feat(tokens): правила категорий расхода — одна таблица для SQL и тестов

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/spend-category 2>&1 | tail -8'
```
Ожидается: `Tests: 20 passed` (15 образцов + 5), 0 failed.

---

### Task 2: Сервис сводки (бэк)

**Files:**
- Create: `src/tokens/spending.service.ts`
- Test: `src/tokens/spending.service.spec.ts`

- [ ] **Step 1: Красный тест**

`src/tokens/spending.service.spec.ts`:

```ts
import {
  SpendingService,
  clampMonths,
  groupMonths,
  DEFAULT_SPENDING_TZ,
} from './spending.service';

describe('clampMonths', () => {
  it('по умолчанию 12', () => {
    expect(clampMonths(undefined)).toBe(12);
    expect(clampMonths('')).toBe(12);
    expect(clampMonths('abc')).toBe(12);
  });
  it('прижимается к 1–24', () => {
    expect(clampMonths('0')).toBe(1);
    expect(clampMonths('-5')).toBe(1);
    expect(clampMonths('100')).toBe(24);
    expect(clampMonths('6')).toBe(6);
  });
});

describe('groupMonths', () => {
  const rows = [
    { month: '2026-06', category: 'replies', tokens: '250050', count: '63' },
    { month: '2026-10', category: 'replies', tokens: '6193', count: '12' },
    { month: '2026-06', category: 'images', tokens: '110000', count: '11' },
    { month: '2026-05', category: 'video', tokens: '50000', count: '2' },
    { month: '2026-05', category: 'other', tokens: '0', count: '1' },
  ];

  it('месяцы от нового к старому, категории по убыванию, итог — сумма', () => {
    expect(groupMonths(rows, 12)).toEqual([
      { month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] },
      {
        month: '2026-06',
        total: 360050,
        categories: [
          { key: 'replies', tokens: 250050, count: 63 },
          { key: 'images', tokens: 110000, count: 11 },
        ],
      },
      { month: '2026-05', total: 50000, categories: [{ key: 'video', tokens: 50000, count: 2 }] },
    ]);
  });

  it('отрезает лишние месяцы — остаются самые новые', () => {
    expect(groupMonths(rows, 2).map((m) => m.month)).toEqual(['2026-10', '2026-06']);
  });

  it('месяц с одними нулями не попадает в ответ', () => {
    const r = groupMonths([{ month: '2026-01', category: 'other', tokens: '0', count: '3' }], 12);
    expect(r).toEqual([]);
  });
});

describe('SpendingService', () => {
  function makePg(zones: string[] = ['Europe/Moscow', 'UTC', 'Asia/Novosibirsk']) {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const pg = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes('pg_timezone_names')) return { rows: zones.map((name) => ({ name })) };
        return { rows: [{ month: '2026-10', category: 'replies', tokens: '6193', count: '12' }] };
      }),
    };
    return { pg, calls };
  }

  it('известный пояс уходит в запрос как есть', async () => {
    const { pg } = makePg();
    expect(await new SpendingService(pg as any).resolveTz('Asia/Novosibirsk')).toBe('Asia/Novosibirsk');
  });

  it('неизвестный или пустой пояс — Москва', async () => {
    const { pg } = makePg();
    const svc = new SpendingService(pg as any);
    expect(await svc.resolveTz('Nowhere/Atlantis')).toBe(DEFAULT_SPENDING_TZ);
    expect(await svc.resolveTz(undefined)).toBe(DEFAULT_SPENDING_TZ);
    expect(await svc.resolveTz('')).toBe(DEFAULT_SPENDING_TZ);
  });

  it('список поясов читается один раз на процесс', async () => {
    const { pg, calls } = makePg();
    const svc = new SpendingService(pg as any);
    await svc.resolveTz('UTC');
    await svc.resolveTz('Europe/Moscow');
    expect(calls.filter((c) => c.sql.includes('pg_timezone_names'))).toHaveLength(1);
  });

  it('сбой чтения поясов — Москва, а не ошибка', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await new SpendingService(pg as any).resolveTz('UTC')).toBe(DEFAULT_SPENDING_TZ);
  });

  it('monthly: только списания этого пользователя, месяц в поясе, категории из правил', async () => {
    const { pg, calls } = makePg();
    const r = await new SpendingService(pg as any).monthly('u-1', 'UTC', '6');
    const q = calls.find((c) => c.sql.includes('token_transactions'))!;
    expect(q.params).toEqual(['u-1', 'UTC']);
    expect(q.sql).toContain("transaction_type = 'consumed'");
    expect(q.sql).toContain('AT TIME ZONE $2');
    expect(q.sql).toContain("THEN 'images'");
    expect(r).toEqual([{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }]);
  });
});
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
git add src/tokens/spending.service.spec.ts
git commit -q -m "test(tokens): сервис сводки расхода (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/spending.service 2>&1 | tail -10'
```
Ожидается: FAIL, `Cannot find module './spending.service'`.

- [ ] **Step 3: Реализация**

`src/tokens/spending.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { spendCategorySql, type SpendCategory } from './spend-category';

/**
 * Сводка расхода по месяцам для GET /webhook/tokens/spending.
 *
 * Только consumed-строки журнала: пополнения, возвраты и корректировки
 * остаются в истории пополнений, поэтому баланс = пополнения − расход.
 */
export interface SpendingCategoryRow {
  key: SpendCategory;
  tokens: number;
  count: number;
}

export interface SpendingMonthRow {
  month: string;
  total: number;
  categories: SpendingCategoryRow[];
}

/** Пояс по умолчанию: без него ответ в 02:11 по Москве 1-го числа уехал бы в прошлый месяц. */
export const DEFAULT_SPENDING_TZ = 'Europe/Moscow';
export const DEFAULT_MONTHS = 12;
export const MAX_MONTHS = 24;

export function clampMonths(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MONTHS;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MONTHS;
  return Math.min(MAX_MONTHS, Math.max(1, n));
}

interface RawRow {
  month: string;
  category: string;
  tokens: string | number;
  count: string | number;
}

export function groupMonths(rows: RawRow[], limit: number): SpendingMonthRow[] {
  const byMonth = new Map<string, SpendingCategoryRow[]>();
  for (const r of rows) {
    const tokens = Number(r.tokens) || 0;
    if (tokens <= 0) continue;
    const list = byMonth.get(r.month) ?? [];
    list.push({ key: r.category as SpendCategory, tokens, count: Number(r.count) || 0 });
    byMonth.set(r.month, list);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, limit)
    .map(([month, categories]) => ({
      month,
      total: categories.reduce((sum, c) => sum + c.tokens, 0),
      categories: categories.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key)),
    }));
}

@Injectable()
export class SpendingService {
  private readonly logger = new Logger(SpendingService.name);
  /** Имена из pg_timezone_names. Читаются один раз: представление каждый раз обходит базу поясов. */
  private zones: Set<string> | null = null;

  constructor(private readonly pg: PgService) {}

  /**
   * Пояс пользователя или Москва. Неизвестный пояс — не ошибка: у старого
   * браузера блок иначе молча пропал бы.
   */
  async resolveTz(tz: unknown): Promise<string> {
    if (typeof tz !== 'string' || !tz) return DEFAULT_SPENDING_TZ;
    try {
      if (!this.zones) {
        const r = await this.pg.query('SELECT name FROM pg_timezone_names');
        this.zones = new Set(r.rows.map((x: any) => String(x.name)));
      }
    } catch (e: any) {
      this.logger.warn(`список часовых поясов не прочитан: ${e?.message}`);
      return DEFAULT_SPENDING_TZ;
    }
    return this.zones.has(tz) ? tz : DEFAULT_SPENDING_TZ;
  }

  async monthly(userId: string, tz?: unknown, months?: unknown): Promise<SpendingMonthRow[]> {
    const zone = await this.resolveTz(tz);
    const res = await this.pg.query(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE $2), 'YYYY-MM') AS month,
              ${spendCategorySql()} AS category,
              SUM(ABS(amount))::bigint AS tokens,
              COUNT(*)::int AS count
         FROM token_transactions
        WHERE user_id = $1 AND transaction_type = 'consumed'
        GROUP BY 1, 2`,
      [userId, zone],
    );
    return groupMonths(res.rows as RawRow[], clampMonths(months));
  }
}
```

- [ ] **Step 4: Коммит и прогон — зелёный**

```bash
git add src/tokens/spending.service.ts
git commit -q -m "feat(tokens): сервис сводки расхода по месяцам и категориям

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/spending.service 2>&1 | tail -8'
```
Ожидается: все тесты файла зелёные (10).

---

### Task 3: Ручка `GET /webhook/tokens/spending` (бэк)

**Files:**
- Modify: `src/tokens/tokens.controller.ts`
- Modify: `src/tokens/tokens.module.ts`
- Test: `src/tokens/tokens.controller.spec.ts`

- [ ] **Step 1: Красный тест**

`src/tokens/tokens.controller.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { TokensController } from './tokens.controller';

function mockRes() {
  const res: any = {};
  res.status = jest.fn((c: number) => { res._status = c; return res; });
  res.json = jest.fn((b: any) => { res._body = b; return res; });
  return res;
}

describe('GET /webhook/tokens/spending', () => {
  it('отдаёт сводку текущего пользователя и передаёт пояс и число месяцев', async () => {
    const months = [{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }];
    const spending = { monthly: jest.fn(async () => months) };
    const res = mockRes();
    await new TokensController({} as any, spending as any).getSpending({ userId: 'u-1' }, 'Asia/Novosibirsk', '6', res);
    expect(spending.monthly).toHaveBeenCalledWith('u-1', 'Asia/Novosibirsk', '6');
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ months });
  });

  it('сбой сервиса — 500 без подробностей', async () => {
    const spending = { monthly: jest.fn(async () => { throw new Error('db down'); }) };
    const res = mockRes();
    await new TokensController({} as any, spending as any).getSpending({ userId: 'u-1' }, undefined as any, undefined as any, res);
    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'spending_failed' });
  });

  it('ручка закрыта входом', () => {
    const src = fs.readFileSync(path.join(__dirname, 'tokens.controller.ts'), 'utf8');
    expect(src).toMatch(/@Get\('tokens\/spending'\)\s*\n\s*@UseGuards\(JwtGuard\)/);
  });

  it('SpendingService зарегистрирован в модуле', () => {
    const mod = fs.readFileSync(path.join(__dirname, 'tokens.module.ts'), 'utf8');
    expect(mod).toMatch(/providers:\s*\[[^\]]*SpendingService/);
  });
});
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
git add src/tokens/tokens.controller.spec.ts
git commit -q -m "test(tokens): ручка сводки расхода (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/tokens.controller 2>&1 | tail -10'
```
Ожидается: FAIL (`getSpending is not a function` / нет провайдера).

- [ ] **Step 3: Реализация**

`src/tokens/tokens.controller.ts` целиком:

```ts
import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProfileService } from '../profile/profile.service';
import { SpendingService } from './spending.service';

@Controller('')
export class TokensController {
  private readonly logger = new Logger(TokensController.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly spending: SpendingService,
  ) {}

  @Get('user/tokens')
  @UseGuards(JwtGuard)
  async getTokens(@CurrentUser() user: any, @Res() res: Response) {
    const tokens = await this.profileService.getTokenBalance(user.userId);
    return res.status(200).json({ success: true, tokens });
  }

  /**
   * Сводка расхода по месяцам и категориям — блок «Расход по месяцам» в окне
   * оплаты, на /tokens и в кошельке мини-аппа. tz — пояс браузера (границы
   * месяцев), months — сколько месяцев (1–24, по умолчанию 12).
   */
  @Get('tokens/spending')
  @UseGuards(JwtGuard)
  async getSpending(
    @CurrentUser() user: any,
    @Query('tz') tz: string,
    @Query('months') months: string,
    @Res() res: Response,
  ) {
    try {
      const result = await this.spending.monthly(user.userId, tz, months);
      return res.status(200).json({ months: result });
    } catch (e: any) {
      this.logger.error(`сводка расхода для ${user?.userId}: ${e?.message}`);
      return res.status(500).json({ error: 'spending_failed' });
    }
  }
}
```

`src/tokens/tokens.module.ts` — импорт и providers:

```ts
import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { ProfileModule } from '../profile/profile.module';
import { CommonModule } from '../common/common.module';
import { BalanceContextService } from './balance-context.service';
import { TokensSchemaService } from './tokens-schema.service';
import { SpendingService } from './spending.service';

@Module({
  imports: [ProfileModule, CommonModule],
  controllers: [TokensController],
  // TokensSchemaService ничего не экспортирует и никем не инжектится: он нужен
  // только ради onModuleInit, который накатывает процедуры баланса. Убрать его
  // из providers — значит перестать накатывать миграцию, ничего при этом не
  // сломав ни в одном вызове; сторож на это — tokens-schema.spec.ts.
  providers: [BalanceContextService, TokensSchemaService, SpendingService],
  exports: [BalanceContextService],
})
export class TokensModule {}
```

- [ ] **Step 4: Коммит и прогон — зелёный, плюс гейт типов**

```bash
git add src/tokens/tokens.controller.ts src/tokens/tokens.module.ts
git commit -q -m "feat(tokens): GET /webhook/tokens/spending — сводка расхода по месяцам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens 2>&1 | tail -6 && npx tsc --noEmit -p tsconfig.build.json && echo TSC-CLEAN'
```
Ожидается: все сюиты `src/tokens` зелёные (интеграционные пропущены без адреса базы), `TSC-CLEAN`.

---

### Task 4: Перенос старых трат и индекс (бэк)

**Files:**
- Create: `src/tokens/migrations/002_backfill_spend_history.sql`
- Modify: `src/tokens/tokens-schema.service.ts` (`onModuleInit`)
- Test: `src/tokens/tokens-schema.spec.ts` (дописать)

- [ ] **Step 1: Красные сторожа текста**

Дописать в конец `src/tokens/tokens-schema.spec.ts`:

```ts
describe('миграция 002 — перенос старых трат', () => {
  /** Текст 002 так, как его получает база, без комментариев. */
  async function sql002(): Promise<{ text: string; order: number; order001: number }> {
    const { svc, queries } = makeService();
    await svc.onModuleInit();
    const order = queries.findIndex((q) => q.includes('idx_token_transactions_user_created'));
    const order001 = queries.findIndex((q) => q.includes('add_user_tokens'));
    if (order < 0) throw new Error('миграция 002 не применена');
    const text = queries[order].replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    return { text, order, order001 };
  }

  it('применяется после 001', async () => {
    const { order, order001 } = await sql002();
    expect(order001).toBeGreaterThanOrEqual(0);
    expect(order).toBeGreaterThan(order001);
  });

  it('баланс не трогает: ни процедур списания и зачисления, ни UPDATE баланса', async () => {
    const { text } = await sql002();
    expect(text).not.toMatch(/consume_user_tokens|add_user_tokens/i);
    expect(text).not.toMatch(/UPDATE\s+(public\.)?ai_profiles_consolidated/i);
  });

  it('четыре источника, каждый под to_regclass, каждая строка помечена', async () => {
    const { text } = await sql002();
    expect(text.match(/INSERT INTO token_transactions/g)).toHaveLength(4);
    expect(text.match(/'reconstructed', true/g)).toHaveLength(4);
    for (const src of ['generated_images', 'video_jobs', 'video_jobs_expired_bak_20260728', 'tg_bot_messages']) {
      expect(text).toContain(`to_regclass('public.${src}')`);
      expect(text).toContain(`'source', '${src}'`);
    }
  });

  it('идемпотентна и сериализована: индекс IF NOT EXISTS, advisory-лок, без явного BEGIN/COMMIT', async () => {
    const { text } = await sql002();
    expect(text).toMatch(/CREATE INDEX IF NOT EXISTS idx_token_transactions_user_created/);
    expect(text).toContain('pg_advisory_xact_lock');
    // Явная транзакция в многооператорном запросе при ошибке оставила бы
    // соединение пула в прерванной транзакции.
    expect(text).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });

  it('границы переноса — моменты, с которых такие списания пишутся в журнал', async () => {
    const { text } = await sql002();
    expect(text).toContain("'2026-08-08 09:02:12+00'");
    expect(text).toContain("'2026-08-20 02:55:51+00'");
    expect(text).toContain("'2026-08-11 11:28:37+00'");
  });
});
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
git add src/tokens/tokens-schema.spec.ts
git commit -q -m "test(tokens): сторожа миграции переноса старых трат (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/tokens-schema 2>&1 | tail -10'
```
Ожидается: FAIL, `миграция 002 не применена`.

- [ ] **Step 3: SQL-файл**

> **Поправка по ходу (23.10, коммиты `5c3c25a` + `591886b`).** Листинг ниже — первоначальный. На PG 16 верхнеуровневый `CREATE INDEX IF NOT EXISTS` берёт ShareLock на `token_transactions` даже при существующем индексе и держит его всю неявную транзакцию — при каждом старте API списания ждали бы конца переноса, а два одновременных первых старта ловили deadlock. В итоговом файле индекс создаётся ВНУТРИ блока DO, после `pg_advisory_xact_lock`, и только если `to_regclass('public.idx_token_transactions_user_created') IS NULL`. Сторожит это живой тест «повторный старт не запирает журнал». Истина — файл `src/tokens/migrations/002_backfill_spend_history.sql`.

`src/tokens/migrations/002_backfill_spend_history.sql`:

```sql
-- Перенос в журнал трат, которые когда-то списывались мимо него, и индекс
-- журнала под сводку расхода по месяцам.
--
-- Спека: docs/superpowers/specs/2026-10-23-spending-summary-design.md.
--
-- ЗАЧЕМ. До августа 2026 картинки, видео и ответы TG-ботов списывали токены
-- прямым UPDATE баланса и строки в token_transactions не оставляли. Сводка
-- расхода читает только журнал, и без переноса у тех, кто тратил весной,
-- картинки и видео выглядели бы «сгоревшими» — ровно жалоба 23.10.2026.
--
-- ЧТО ПЕРЕНОСИТСЯ. Источник → граница (первая строка журнала этой категории
-- на проде, то есть момент, с которого такие списания пишет процедура):
--   generated_images                    → 2026-08-08 09:02:12 UTC, подпись 'image'
--   video_jobs и video_jobs_expired_bak_20260728, только 'ready'
--     (за неудачные тогда возвращали)   → 2026-08-20 02:55:51 UTC, 'Генерация видео'
--   tg_bot_messages, на владельца бота  → 2026-08-11 11:28:37 UTC, 'tg-bot'
-- Подписи — те же, что пишет сегодняшний код: классификатор сводки
-- (src/tokens/spend-category.ts) узнаёт строки без особых правил.
--
-- БАЛАНС НЕ ТРОГАЕМ. Только INSERT в журнал, без процедур и без UPDATE
-- баланса: эти токены уже списаны тогда. balance_after = 0 и пометка
-- reconstructed — как у перенесённых покупок (payments/migrations/002);
-- ручка истории по ней отдаёт остаток null.
--
-- ИДЕМПОТЕНТНОСТЬ. Файл выполняется при КАЖДОМ старте API
-- (TokensSchemaService). У строки metadata.source + metadata.source_id; что
-- уже перенесено, второй раз не вставляется. Весь файл — одна НЕЯВНАЯ
-- транзакция (несколько операторов в одном запросе без BEGIN/COMMIT): при
-- ошибке откатывается целиком и не оставляет соединение пула в прерванной
-- транзакции, как оставил бы явный BEGIN. Два одновременных старта
-- сериализует advisory-лок.
--
-- ЗАЩИТА ОТ ДУБЛЕЙ. Если в журнале уже есть списание того же человека на ту
-- же сумму в пределах двух минут (и это не перенесённая строка), исходную
-- запись пропускаем: ошибка здесь даёт недосчёт, а не двойной счёт.
--
-- ОТСУТСТВУЮЩИЕ ТАБЛИЦЫ. Каждый источник — под to_regclass: резервная таблица
-- видео есть только на проде. PL/pgSQL разрешает имена таблиц при первом
-- исполнении оператора, поэтому ветка под ложным IF может ссылаться на
-- несуществующую таблицу.
--
-- ОТКАТ. Убрать файл из TokensSchemaService.onModuleInit (иначе следующий
-- старт перенесёт заново), затем:
--   DELETE FROM token_transactions
--    WHERE metadata->>'reconstructed' = 'true'
--      AND metadata->>'source' IN ('generated_images', 'video_jobs',
--          'video_jobs_expired_bak_20260728', 'tg_bot_messages');
-- Балансы при этом не меняются.

CREATE INDEX IF NOT EXISTS idx_token_transactions_user_created
    ON token_transactions (user_id, created_at);

DO $backfill$
DECLARE
    c_images CONSTANT timestamptz := '2026-08-08 09:02:12+00';
    c_video  CONSTANT timestamptz := '2026-08-20 02:55:51+00';
    c_tg     CONSTANT timestamptz := '2026-08-11 11:28:37+00';
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('tokens/002_backfill_spend_history'));

    IF to_regclass('public.generated_images') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT g.user_id, 'consumed'::transaction_type_enum, -g.tokens_spent, 0, 'image',
               jsonb_build_object('reconstructed', true, 'source', 'generated_images', 'source_id', g.id::text),
               g.created_at
          FROM generated_images g
         WHERE g.tokens_spent > 0
           AND g.created_at < c_images
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'generated_images'
                              AND t.metadata ->> 'source_id' = g.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = g.user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -g.tokens_spent
                              AND t.created_at BETWEEN g.created_at - interval '2 minutes'
                                                   AND g.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;

    IF to_regclass('public.video_jobs') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT v.user_id, 'consumed'::transaction_type_enum, -v.tokens_spent, 0, 'Генерация видео',
               jsonb_build_object('reconstructed', true, 'source', 'video_jobs', 'source_id', v.id::text,
                                  'mode', v.mode, 'model', v.model),
               v.created_at
          FROM video_jobs v
         WHERE v.status = 'ready'
           AND v.tokens_spent > 0
           AND v.created_at < c_video
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'video_jobs'
                              AND t.metadata ->> 'source_id' = v.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = v.user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -v.tokens_spent
                              AND t.created_at BETWEEN v.created_at - interval '2 minutes'
                                                   AND v.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;

    IF to_regclass('public.video_jobs_expired_bak_20260728') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT v.user_id, 'consumed'::transaction_type_enum, -v.tokens_spent, 0, 'Генерация видео',
               jsonb_build_object('reconstructed', true, 'source', 'video_jobs_expired_bak_20260728', 'source_id', v.id::text,
                                  'mode', v.mode, 'model', v.model),
               v.created_at
          FROM video_jobs_expired_bak_20260728 v
         WHERE v.status = 'ready'
           AND v.tokens_spent > 0
           AND v.created_at < c_video
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'video_jobs_expired_bak_20260728'
                              AND t.metadata ->> 'source_id' = v.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = v.user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -v.tokens_spent
                              AND t.created_at BETWEEN v.created_at - interval '2 minutes'
                                                   AND v.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;

    IF to_regclass('public.tg_bot_messages') IS NOT NULL AND to_regclass('public.tg_bot_configs') IS NOT NULL THEN
        INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
        SELECT c.owner_user_id, 'consumed'::transaction_type_enum, -m.tokens_charged, 0, 'tg-bot',
               jsonb_build_object('reconstructed', true, 'source', 'tg_bot_messages', 'source_id', m.id::text,
                                  'config_id', m.config_id::text),
               m.created_at
          FROM tg_bot_messages m
          JOIN tg_bot_configs c ON c.id = m.config_id
         WHERE m.tokens_charged > 0
           AND m.created_at < c_tg
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.metadata ->> 'source' = 'tg_bot_messages'
                              AND t.metadata ->> 'source_id' = m.id::text)
           AND NOT EXISTS (SELECT 1 FROM token_transactions t
                            WHERE t.user_id = c.owner_user_id
                              AND t.transaction_type = 'consumed'
                              AND t.amount = -m.tokens_charged
                              AND t.created_at BETWEEN m.created_at - interval '2 minutes'
                                                   AND m.created_at + interval '2 minutes'
                              AND (t.metadata ->> 'reconstructed') IS DISTINCT FROM 'true');
    END IF;
END
$backfill$;
```

- [ ] **Step 4: Подключить в `TokensSchemaService`**

В `src/tokens/tokens-schema.service.ts` заменить `onModuleInit` на:

```ts
  async onModuleInit() {
    await this.applyMigration('001_add_user_tokens_lock.sql');
    // Индекс журнала под сводку расхода и перенос старых трат мимо журнала.
    // Идемпотентно: выполняется при каждом старте, повторно ничего не добавляет.
    await this.applyMigration('002_backfill_spend_history.sql');
  }
```

- [ ] **Step 5: Коммит и прогон — зелёный**

```bash
git add src/tokens/migrations/002_backfill_spend_history.sql src/tokens/tokens-schema.service.ts
git commit -q -m "feat(tokens): перенос старых трат в журнал и индекс под сводку расхода

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'npx jest src/tokens/tokens-schema 2>&1 | tail -8'
```
Ожидается: все тесты файла зелёные, включая прежние про 001.

---

### Task 5: Живой Postgres — SQL, пояс, сводка, перенос (бэк)

**Files:**
- Test: `src/tokens/spending.integration.spec.ts`

- [ ] **Step 1: Одноразовая база на ноде**

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'set -e
sudo -u postgres psql -qc "DROP DATABASE IF EXISTS spend_test"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname = '"'"'spendtest'"'"'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE spendtest LOGIN PASSWORD '"'"'spendtest'"'"'"
sudo -u postgres psql -qc "CREATE DATABASE spend_test OWNER spendtest" && echo db-ok'
```
Базу пересоздавать перед КАЖДЫМ прогоном: снимок `base/001` второй раз не накатывается. Отдельная база и отдельная переменная (`SPENDING_PG_URL`, не `TOKENS_PG_URL`) — чтобы не столкнуться с `add-tokens-race.integration.spec.ts`, который в своей базе делает TRUNCATE.

- [ ] **Step 2: Тест**

`src/tokens/spending.integration.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { TokensSchemaService } from './tokens-schema.service';
import { SpendingService } from './spending.service';
import { classifySpend, spendCategorySql } from './spend-category';
import { SPEND_SAMPLES } from './spend-category.samples';

/**
 * Сводка расхода и перенос старых трат — против живого Postgres.
 *
 * Здесь проверяется то, чего не видят юнит-тесты: что CASE из
 * spendCategorySql в базе классифицирует так же, как classifySpend; что
 * граница месяца считается в поясе; что 002_backfill_spend_history.sql,
 * применённый ТЕМ ЖЕ TokensSchemaService, что и на проде, переносит нужное,
 * не трогает балансы и второй раз ничего не добавляет.
 *
 * КАК ГОНЯТЬ. База одноразовая — пересоздавать перед каждым прогоном
 * (снимок base/001 второй раз не накатывается):
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS spend_test"
 *   sudo -u postgres psql -qc "CREATE ROLE spendtest LOGIN PASSWORD 'spendtest'"   # один раз
 *   sudo -u postgres psql -qc "CREATE DATABASE spend_test OWNER spendtest"
 *   SPENDING_PG_URL=postgresql://spendtest:spendtest@127.0.0.1:5432/spend_test \
 *     npx jest src/tokens/spending.integration
 */
const PG = process.env.SPENDING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('сводка расхода и перенос старых трат — живой Postgres', () => {
  jest.setTimeout(120_000);
  let pool: Pool;
  const db = () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params) }) as any;
  const migrate = () => new TokensSchemaService(db()).onModuleInit();

  const consumed = (userId: string, amount: number, at: string, description: string | null, metadata: object | null = null) =>
    pool.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
       VALUES ($1, 'consumed', $2, 0, $3, $4, $5)`,
      [userId, amount, description, metadata ? JSON.stringify(metadata) : null, at],
    );

  const reconstructed = async () =>
    (await pool.query(
      `SELECT user_id, amount::int AS amount, description, metadata ->> 'source' AS source,
              metadata ->> 'source_id' AS source_id, balance_after::int AS balance_after,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS at
         FROM token_transactions
        WHERE metadata ->> 'reconstructed' = 'true'
        ORDER BY source, created_at`,
    )).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    // Снимок base/001 — на отдельном соединении, которое затем уничтожается:
    // строка pg_dump `set_config('search_path', '', false)` оставляет его с
    // пустым search_path на всю сессию.
    const loader = await pool.connect();
    try {
      await loader.query(
        fs.readFileSync(path.join(__dirname, '..', 'base', 'migrations', '001_core_schema.sql'), 'utf8'),
      );
    } finally {
      loader.release(true);
    }
    await pool.query(
      fs.readFileSync(path.join(__dirname, '..', 'tg-bot', 'migrations', '001_tg_bot_schema.sql'), 'utf8'),
    );
    const n = await pool.query('SELECT count(*)::int AS n FROM token_transactions');
    if (n.rows[0].n !== 0) {
      throw new Error('SPENDING_PG_URL указывает на непустую базу — нужна одноразовая (рецепт в шапке)');
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE token_transactions, ai_profiles_consolidated, generated_images, video_jobs, tg_bot_messages, tg_bot_configs RESTART IDENTITY CASCADE',
    );
    await pool.query('DROP TABLE IF EXISTS video_jobs_expired_bak_20260728');
  });

  it('SQL-выражение категорий совпадает с classifySpend на всех образцах', async () => {
    for (const [i, [description, metadata]] of SPEND_SAMPLES.entries()) {
      await consumed('u-cls', -(i + 1), '2026-10-01T12:00:00Z', description, metadata);
    }
    const r = await pool.query(
      `SELECT description, metadata, ${spendCategorySql()} AS category FROM token_transactions WHERE user_id = 'u-cls'`,
    );
    expect(r.rows).toHaveLength(SPEND_SAMPLES.length);
    for (const row of r.rows) {
      expect(row.category).toBe(classifySpend(row.description, row.metadata));
    }
  });

  it('граница месяца — в поясе пользователя; неизвестный или пустой пояс — Москва', async () => {
    await consumed('u-tz', -1000, '2026-10-31T22:30:00Z', 'image');
    const svc = new SpendingService(db());
    expect((await svc.monthly('u-tz', 'Europe/Moscow'))[0].month).toBe('2026-11');
    expect((await svc.monthly('u-tz', 'UTC'))[0].month).toBe('2026-10');
    expect((await svc.monthly('u-tz', 'Nowhere/Atlantis'))[0].month).toBe('2026-11');
    expect((await svc.monthly('u-tz', undefined))[0].month).toBe('2026-11');
  });

  it('сводка: только списания этого пользователя, месяцы от нового к старому, категории по убыванию', async () => {
    await consumed('u-sum', -600, '2026-10-22T23:12:50Z', 'Ответ ассистента «Роман»', { taken: 'turn' });
    await consumed('u-sum', -400, '2026-10-22T23:14:05Z', 'Ответ ассистента «Роман»');
    await consumed('u-sum', -10000, '2026-06-27T18:17:48Z', 'image');
    await consumed('u-sum', -2000, '2026-06-27T18:20:00Z', null);
    await pool.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, created_at)
       VALUES ('u-sum', 'purchase', 200000, 200000, 'Пополнение', '2026-10-22T23:11:09Z')`,
    );
    await consumed('u-other', -999, '2026-10-01T00:00:00Z', 'image');

    expect(await new SpendingService(db()).monthly('u-sum', 'Europe/Moscow')).toEqual([
      { month: '2026-10', total: 1000, categories: [{ key: 'replies', tokens: 1000, count: 2 }] },
      {
        month: '2026-06',
        total: 12000,
        categories: [
          { key: 'images', tokens: 10000, count: 1 },
          { key: 'replies', tokens: 2000, count: 1 },
        ],
      },
    ]);
  });

  describe('перенос старых трат (002)', () => {
    async function seed() {
      await pool.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES
           ('u-a', 193807), ('u-b', 1000), ('u-c', 5000), ('u-d', 0)`,
      );
      await pool.query(
        `INSERT INTO generated_images (id, user_id, prompt, image_url, tokens_spent, created_at) VALUES
           (1, 'u-a', 'p', 'https://x/1.png', 10000, '2026-06-27T18:17:48Z'),
           (2, 'u-a', 'p', 'https://x/2.png', 10000, '2026-09-01T10:00:00Z'),
           (3, 'u-a', 'p', 'https://x/3.png', 0,     '2026-06-01T10:00:00Z'),
           (4, 'u-d', 'p', 'https://x/4.png', 10000, '2026-07-01T10:00:00Z')`,
      );
      // Уже записанное списание той же суммы у u-d в пределах двух минут — картинку 4 не переносить.
      await consumed('u-d', -10000, '2026-07-01T10:00:30Z', null);
      await pool.query(
        `INSERT INTO video_jobs (id, user_id, mode, model, quality, duration_sec, tokens_spent, status, created_at) VALUES
           ('00000000-0000-4000-8000-000000000001', 'u-a', 'image2video', 'kling-v1-6', 'std', 5, 25000, 'ready',  '2026-05-06T03:02:36Z'),
           ('00000000-0000-4000-8000-000000000002', 'u-a', 'image2video', 'kling-v1-6', 'std', 5, 25000, 'failed', '2026-05-06T02:35:00Z'),
           ('00000000-0000-4000-8000-000000000003', 'u-a', 'text2video',  'veo-3.1',    'std', 8, 90000, 'ready',  '2026-09-10T00:00:00Z')`,
      );
      await pool.query('CREATE TABLE video_jobs_expired_bak_20260728 (LIKE video_jobs INCLUDING DEFAULTS)');
      await pool.query(
        `INSERT INTO video_jobs_expired_bak_20260728 (id, user_id, mode, model, quality, duration_sec, tokens_spent, status, created_at)
         VALUES ('00000000-0000-4000-8000-000000000004', 'u-b', 'image2video', 'kling-v1-6', 'std', 5, 25000, 'ready', '2026-04-21T10:08:43Z')`,
      );
      const cfg = await pool.query(
        `INSERT INTO tg_bot_configs (owner_user_id, display_name, preset_agent_id, addressing_mode, voice_reply_mode, status)
         VALUES ('u-c', 'bot', 'roman', 'smart', 'never', 'active') RETURNING id`,
      );
      const configId = cfg.rows[0].id;
      await pool.query(
        `INSERT INTO tg_bot_messages (config_id, tg_chat_id, role, content, content_type, tokens_charged, created_at) VALUES
           ($1, 1, 'user',      'привет', 'text', 0,    '2026-08-01T00:00:00Z'),
           ($1, 1, 'assistant', 'ответ',  'text', 7000, '2026-08-01T00:00:10Z'),
           ($1, 1, 'assistant', 'ответ',  'text', 3000, '2026-08-12T00:00:00Z')`,
        [configId],
      );
    }

    const balances = async () =>
      (await pool.query('SELECT user_id, tokens::int AS tokens FROM ai_profiles_consolidated ORDER BY user_id')).rows;

    it('переносит только своё, до границы и не дублируя; балансы не трогает', async () => {
      await seed();
      const before = await balances();

      await migrate();

      expect(await reconstructed()).toEqual([
        { user_id: 'u-a', amount: -10000, description: 'image', source: 'generated_images', source_id: '1', balance_after: 0, at: '2026-06-27T18:17:48' },
        { user_id: 'u-c', amount: -7000, description: 'tg-bot', source: 'tg_bot_messages', source_id: '2', balance_after: 0, at: '2026-08-01T00:00:10' },
        { user_id: 'u-a', amount: -25000, description: 'Генерация видео', source: 'video_jobs', source_id: '00000000-0000-4000-8000-000000000001', balance_after: 0, at: '2026-05-06T03:02:36' },
        { user_id: 'u-b', amount: -25000, description: 'Генерация видео', source: 'video_jobs_expired_bak_20260728', source_id: '00000000-0000-4000-8000-000000000004', balance_after: 0, at: '2026-04-21T10:08:43' },
      ]);
      expect(await balances()).toEqual(before);
    });

    it('второй старт ничего не добавляет', async () => {
      await seed();
      await migrate();
      const first = await reconstructed();
      await migrate();
      expect(await reconstructed()).toEqual(first);
    });

    it('индекс журнала создан', async () => {
      await migrate();
      const r = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = 'token_transactions' AND indexname = 'idx_token_transactions_user_created'`,
      );
      expect(r.rowCount).toBe(1);
    });

    it('нет резервной таблицы видео — остальные источники всё равно переносятся', async () => {
      await pool.query(
        `INSERT INTO generated_images (id, user_id, prompt, image_url, tokens_spent, created_at)
         VALUES (10, 'u-a', 'p', 'https://x/10.png', 5000, '2026-06-01T10:00:00Z')`,
      );
      await migrate();
      expect((await reconstructed()).map((r) => r.source)).toEqual(['generated_images']);
    });

    it('две картинки на одну сумму подряд переносятся обе — защита от дублей их не съедает', async () => {
      await pool.query(
        `INSERT INTO generated_images (id, user_id, prompt, image_url, tokens_spent, created_at) VALUES
           (20, 'u-a', 'p', 'https://x/20.png', 10000, '2026-06-27T20:37:47Z'),
           (21, 'u-a', 'p', 'https://x/21.png', 10000, '2026-06-27T20:37:57Z')`,
      );
      await migrate();
      expect((await reconstructed()).map((r) => r.source_id)).toEqual(['20', '21']);
    });

    it('перенесённое попадает в свои категории сводки', async () => {
      await seed();
      await migrate();
      expect(await new SpendingService(db()).monthly('u-a', 'UTC')).toEqual([
        { month: '2026-06', total: 10000, categories: [{ key: 'images', tokens: 10000, count: 1 }] },
        { month: '2026-05', total: 25000, categories: [{ key: 'video', tokens: 25000, count: 1 }] },
      ]);
    });
  });
});
```

- [ ] **Step 3: Коммит и прогон на живой базе**

```bash
git add src/tokens/spending.integration.spec.ts
git commit -q -m "test(tokens): сводка расхода и перенос старых трат на живом Postgres

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ../spending-node-run.sh back 'sudo -u postgres psql -qc "DROP DATABASE IF EXISTS spend_test" && sudo -u postgres psql -qc "CREATE DATABASE spend_test OWNER spendtest" && SPENDING_PG_URL=postgresql://spendtest:spendtest@127.0.0.1:5432/spend_test npx jest src/tokens/spending.integration 2>&1 | tail -20'
```
Ожидается: 9 passed (после поправки индекса — 10). Если что-то красное — чинить код (задачи 1–4), а не тест; тест описывает спеку.

- [ ] **Step 4: Сломать нарочно — убедиться, что прибор видит**

Пробная поломка: в `002_backfill_spend_history.sql` убрать строку `AND v.status = 'ready'` из блока `video_jobs`, закоммитить (`test(tokens): проба — перенос без фильтра статуса видео, ждём красный`), прогнать шаг 3.
Ожидается: красный «переносит только своё…» (появилась строка failed-видео). Затем откатить **revert-коммитом** — не `reset`: помощник уже отправил пробный коммит в `origin/feat/spending-summary`, и после `reset` следующий push отказал бы (историю ветки не переписываем):

```bash
git revert --no-edit HEAD
```
и прогнать шаг 3 ещё раз — снова зелёный. Записать в отчёт оба результата.

---

### Task 6: Гейты бэка

- [ ] **Step 1: Типы, юнит-набор `src/`, `tests/unit` на свежей сборке**

```bash
bash ../spending-node-run.sh back 'npx tsc --noEmit -p tsconfig.build.json && echo TSC-CLEAN; \
  npx jest src/ --silent 2>&1 | grep -E "^(Tests|Test Suites):|✕|FAIL" | tail -20; \
  npm run build >/dev/null && cd tests && npx jest unit/ --silent 2>&1 | grep -E "^(Tests|Test Suites):|FAIL" | tail -10'
```
Ожидается: `TSC-CLEAN`; в `src/` и `tests/unit` нет падений в `src/tokens` и ничего нового против `origin/main`. Если в `src/` есть падения — прогнать тот же набор на базе (`git checkout --detach origin/main` в `~/ci/wt/spending-back`) и сравнить списки `FAIL`: свои — чинить, общие — записать в отчёт как предсуществующие.

---

### Task 7: Разбор ответа и подписи (фронт)

**Files:**
- Create: `src/shared/spending.ts`
- Test: `src/shared/spending.test.ts`

Все пути задач 7–12 — внутри `~/Downloads/spirits_front/.worktrees/spending-summary`.

- [ ] **Step 1: Красный тест**

`src/shared/spending.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ lang: 'ru' }));
// formatDate берёт язык у экземпляра i18next — подставляем свой.
vi.mock('../i18n', () => ({
  default: {
    get language() {
      return state.lang;
    },
  },
}));

import { parseSpending, categoryLabelKey, monthLabel, spendingUrl } from './spending';

describe('parseSpending', () => {
  it('читает форму /webhook/tokens/spending', () => {
    const raw = {
      months: [{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }],
    };
    expect(parseSpending(raw)).toEqual(raw.months);
  });

  it('пустой список на мусоре', () => {
    expect(parseSpending(null)).toEqual([]);
    expect(parseSpending({ months: 'x' })).toEqual([]);
  });

  it('выбрасывает месяцы без даты и с нулём, категории с нулём', () => {
    const raw = {
      months: [
        { month: 'oct', total: 5, categories: [] },
        { month: '2026-09', total: 0, categories: [] },
        {
          month: '2026-08',
          total: 10,
          categories: [
            { key: 'images', tokens: 10, count: 1 },
            { key: 'video', tokens: 0, count: 0 },
          ],
        },
      ],
    };
    expect(parseSpending(raw)).toEqual([
      { month: '2026-08', total: 10, categories: [{ key: 'images', tokens: 10, count: 1 }] },
    ]);
  });
});

describe('categoryLabelKey', () => {
  it('известный ключ — свой текст', () => {
    expect(categoryLabelKey('tg_bots')).toBe('payment.spending.cat.tg_bots');
  });
  it('незнакомый ключ — «Прочее»', () => {
    expect(categoryLabelKey('music')).toBe('payment.spending.cat.other');
  });
});

describe('monthLabel', () => {
  it('месяц словом и год, с заглавной', () => {
    state.lang = 'ru';
    expect(monthLabel('2026-10')).toMatch(/^Октябрь 2026/);
    state.lang = 'en';
    expect(monthLabel('2026-10')).toBe('October 2026');
  });

  it('к западу от Гринвича не съезжает на месяц назад', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      state.lang = 'en';
      expect(monthLabel('2026-10')).toBe('October 2026');
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('непонятную строку отдаёт как есть', () => {
    expect(monthLabel('oct')).toBe('oct');
  });
});

describe('spendingUrl', () => {
  it('передаёт пояс браузера', () => {
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'Asia/Novosibirsk' } as Intl.ResolvedDateTimeFormatOptions);
    expect(spendingUrl()).toBe('/webhook/tokens/spending?tz=Asia%2FNovosibirsk');
    spy.mockRestore();
  });

  it('без пояса — без параметра', () => {
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions);
    expect(spendingUrl()).toBe('/webhook/tokens/spending');
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
cd ~/Downloads/spirits_front/.worktrees/spending-summary
git add src/shared/spending.test.ts
git commit -q -m "test(spending): разбор сводки расхода и подписи месяцев (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/shared/spending.test.ts 2>&1 | tail -12'
```
Ожидается: FAIL, `Failed to resolve import "./spending"`.

- [ ] **Step 3: Реализация**

`src/shared/spending.ts`:

```ts
import { formatDate } from '../utils/formatters';

/**
 * Сводка расхода по месяцам — GET /webhook/tokens/spending. Общая часть для
 * веба (окно оплаты, /tokens) и кошелька мини-аппа.
 *
 * Ключ категории приходит строкой: бэк может добавить новую раньше, чем
 * обновится фронт, — тогда она подписывается как «Прочее».
 */
export interface SpendingCategory {
  key: string;
  tokens: number;
  count: number;
}

export interface SpendingMonth {
  /** 'YYYY-MM' в поясе пользователя. */
  month: string;
  total: number;
  categories: SpendingCategory[];
}

const LABEL_KEYS: Record<string, string> = {
  replies: 'payment.spending.cat.replies',
  calls: 'payment.spending.cat.calls',
  images: 'payment.spending.cat.images',
  video: 'payment.spending.cat.video',
  voice: 'payment.spending.cat.voice',
  tg_bots: 'payment.spending.cat.tg_bots',
  products: 'payment.spending.cat.products',
  other: 'payment.spending.cat.other',
};

export function categoryLabelKey(key: string): string {
  return LABEL_KEYS[key] ?? LABEL_KEYS.other;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function parseSpending(raw: unknown): SpendingMonth[] {
  const months = (raw as { months?: unknown } | null)?.months;
  if (!Array.isArray(months)) return [];
  return months
    .filter((m: any) => typeof m?.month === 'string' && MONTH_RE.test(m.month))
    .map((m: any) => ({
      month: m.month as string,
      total: Number(m.total) || 0,
      categories: (Array.isArray(m.categories) ? m.categories : [])
        .map((c: any) => ({
          key: String(c?.key ?? 'other'),
          tokens: Number(c?.tokens) || 0,
          count: Number(c?.count) || 0,
        }))
        .filter((c: SpendingCategory) => c.tokens > 0),
    }))
    .filter((m) => m.total > 0);
}

/**
 * «Октябрь 2026 г.» на языке интерфейса. timeZone: 'UTC' обязателен: дата
 * собрана в UTC, и без него к западу от Гринвича 1 октября 00:00 UTC — ещё
 * 30 сентября.
 */
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const s = formatDate(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Адрес ручки с поясом браузера: границы месяцев бэк считает в нём. */
export function spendingUrl(): string {
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    tz = '';
  }
  return tz ? `/webhook/tokens/spending?tz=${encodeURIComponent(tz)}` : '/webhook/tokens/spending';
}
```

- [ ] **Step 4: Коммит и прогон — зелёный**

```bash
git add src/shared/spending.ts
git commit -q -m "feat(spending): разбор сводки расхода, подписи категорий и месяцев

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/shared/spending.test.ts 2>&1 | tail -8'
```
Ожидается: все тесты файла зелёные.

---

### Task 8: Тексты на семи языках (фронт)

**Files:** `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json`

Ключи вложенные — `payment.spending.title` и `payment.spending.cat.<ключ>`. Плоский `payment.spending_cat_other` нельзя: `check-locales.mjs` считает хвост `_other` формой множественного числа и требовал бы `_one/_few/_many`.

- [ ] **Step 1: Вставка скриптом**

Из воркдерева фронта (скрипт пишет текстом после строки `"history_incl_bonus"`, не пересериализуя файл, — чтобы не тронуть остальные строки):

```bash
cd ~/Downloads/spirits_front/.worktrees/spending-summary && node - <<'EOF'
const fs = require('fs');
const T = {
  ru: ['Расход по месяцам', { replies: 'Ответы ассистентов', calls: 'Звонки', images: 'Картинки', video: 'Видео', voice: 'Озвучка', tg_bots: 'Telegram-боты', products: 'Продукты', other: 'Прочее' }],
  en: ['Spending by month', { replies: 'Assistant replies', calls: 'Calls', images: 'Images', video: 'Videos', voice: 'Voice-overs', tg_bots: 'Telegram bots', products: 'Products', other: 'Other' }],
  es: ['Gastos por mes', { replies: 'Respuestas de los asistentes', calls: 'Llamadas', images: 'Imágenes', video: 'Vídeo', voice: 'Locución', tg_bots: 'Bots de Telegram', products: 'Productos', other: 'Otros' }],
  de: ['Verbrauch nach Monaten', { replies: 'Antworten der Assistenten', calls: 'Anrufe', images: 'Bilder', video: 'Videos', voice: 'Vertonung', tg_bots: 'Telegram-Bots', products: 'Produkte', other: 'Sonstiges' }],
  fr: ['Dépenses par mois', { replies: 'Réponses des assistants', calls: 'Appels', images: 'Images', video: 'Vidéo', voice: 'Synthèse vocale', tg_bots: 'Bots Telegram', products: 'Produits', other: 'Autres' }],
  pt: ['Gastos por mês', { replies: 'Respostas dos assistentes', calls: 'Chamadas', images: 'Imagens', video: 'Vídeo', voice: 'Locução', tg_bots: 'Bots do Telegram', products: 'Produtos', other: 'Outros' }],
  zh: ['每月消费', { replies: '助手回复', calls: '通话', images: '图片', video: '视频', voice: '配音', tg_bots: 'Telegram 机器人', products: '产品', other: '其他' }],
};
for (const [lang, [title, cat]] of Object.entries(T)) {
  const file = `src/i18n/locales/${lang}.json`;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const idx = lines.map((l, i) => (/^    "history_incl_bonus": /.test(l) ? i : -1)).filter((i) => i >= 0);
  if (idx.length !== 1) throw new Error(`${lang}: ждали одну строку history_incl_bonus, нашли ${idx.length}`);
  if (!lines[idx[0]].trimEnd().endsWith(',')) throw new Error(`${lang}: после history_incl_bonus нет запятой`);
  if (JSON.parse(text).payment.spending) throw new Error(`${lang}: payment.spending уже есть`);
  const block = [
    '    "spending": {',
    `      "title": ${JSON.stringify(title)},`,
    '      "cat": {',
    ...Object.entries(cat).map(([k, v], i, a) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)}${i < a.length - 1 ? ',' : ''}`),
    '      }',
    '    },',
  ];
  lines.splice(idx[0] + 1, 0, ...block);
  const out = lines.join('\n');
  const parsed = JSON.parse(out);
  if (parsed.payment.spending.title !== title || parsed.payment.spending.cat.other !== cat.other) throw new Error(`${lang}: вставка не читается`);
  fs.writeFileSync(file, out);
  console.log(lang, 'ok');
}
EOF
git diff --stat
```
Ожидается: `ru ok` … `zh ok`; в diff только 7 файлов локалей, по 13 добавленных строк в каждом.

- [ ] **Step 2: Коммит и проверки локалей**

```bash
git add src/i18n/locales/*.json
git commit -q -m "feat(i18n): тексты блока «Расход по месяцам» на семи языках

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'node scripts/check-locales.mjs && pnpm vitest run src/i18n 2>&1 | tail -6'
```
Ожидается: `check-locales` зелёный; тесты `src/i18n` (в том числе `localeRegister.test.ts` — европейский португальский) зелёные.

---

### Task 9: Список месяцев (фронт, общий компонент)

**Files:**
- Create: `src/shared/ui/SpendingMonths.tsx`
- Test: `src/shared/ui/SpendingMonths.test.tsx`

- [ ] **Step 1: Красный тест**

`src/shared/ui/SpendingMonths.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, click, visibleText, type Mounted } from '../../test/dom';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t }) };
});
// formatNumber и formatDate берут язык у экземпляра i18next.
vi.mock('../../i18n', () => ({ default: { language: 'ru' } }));

import { SpendingMonths } from './SpendingMonths';

const months = [
  { month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] },
  {
    month: '2026-06',
    total: 360050,
    categories: [
      { key: 'replies', tokens: 250050, count: 63 },
      { key: 'images', tokens: 110000, count: 11 },
    ],
  },
];

/** Разряды в ru — неразрывные пробелы; сравниваем по обычным. */
const text = (m: Mounted) => visibleText(m.container).replace(/\s/g, ' ');

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe('SpendingMonths', () => {
  it('новый месяц раскрыт, прошлые свёрнуты; итог виден у каждого', () => {
    m = mount(<SpendingMonths months={months} />);
    const t = text(m);
    expect(t).toContain('Октябрь 2026');
    expect(t).toContain('Июнь 2026');
    expect(t).toContain('6 193');
    expect(t).toContain('360 050');
    expect(t).toContain('Ответы ассистентов');
    expect(t).not.toContain('Картинки');
  });

  it('нажатие раскрывает и сворачивает месяц', () => {
    m = mount(<SpendingMonths months={months} />);
    const june = m.container.querySelector('[data-testid="spending-month-2026-06"] button');
    if (!june) throw new Error('нет кнопки июня');
    click(june);
    expect(text(m)).toContain('Картинки');
    expect(text(m)).toContain('110 000');
    expect(june.getAttribute('aria-expanded')).toBe('true');
    click(june);
    expect(text(m)).not.toContain('Картинки');
  });

  it('незнакомая категория подписана «Прочее»', () => {
    m = mount(<SpendingMonths months={[{ month: '2026-10', total: 5, categories: [{ key: 'music', tokens: 5, count: 1 }] }]} />);
    expect(text(m)).toContain('Прочее');
  });
});
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
git add src/shared/ui/SpendingMonths.test.tsx
git commit -q -m "test(spending): список месяцев сводки расхода (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/shared/ui/SpendingMonths.test.tsx 2>&1 | tail -10'
```
Ожидается: FAIL, `Failed to resolve import "./SpendingMonths"`.

- [ ] **Step 3: Реализация**

`src/shared/ui/SpendingMonths.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { categoryLabelKey, monthLabel, type SpendingMonth } from '../spending';

/**
 * Месяцы сводки расхода: строка месяца с итогом, по нажатию — категории.
 * Самый новый месяц раскрыт сразу: чаще всего спрашивают про текущий.
 * Общий для веба и кошелька мини-аппа — заголовок и запрос у каждого свои.
 */
export function SpendingMonths({ months }: { months: SpendingMonth[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(() => new Set(months[0] ? [months[0].month] : []));

  const toggle = (month: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month);
      else next.add(month);
      return next;
    });

  return (
    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
      {months.map((m) => {
        const isOpen = open.has(m.month);
        return (
          <li key={m.month} data-testid={`spending-month-${m.month}`}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggle(m.month)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
            >
              <span className="flex items-center gap-1 text-gray-900">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-gray-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-gray-400" />
                )}
                {monthLabel(m.month)}
              </span>
              <span className="tabular-nums text-gray-900">{formatNumber(m.total)}</span>
            </button>
            {isOpen && (
              <ul className="pb-2">
                {m.categories.map((c) => (
                  <li key={c.key} className="flex items-center justify-between py-1 pl-8 pr-3 text-sm">
                    <span className="text-gray-700">
                      {t(categoryLabelKey(c.key))}
                      <span className="ml-2 text-xs text-gray-400">{formatNumber(c.count)}</span>
                    </span>
                    <span className="tabular-nums text-gray-700">{formatNumber(c.tokens)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Коммит и прогон — зелёный**

```bash
git add src/shared/ui/SpendingMonths.tsx
git commit -q -m "feat(spending): список месяцев сводки расхода — общий для веба и мини-аппа

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/shared 2>&1 | tail -8'
```
Ожидается: тесты `src/shared` зелёные.

---

### Task 10: Веб-блок и его место (фронт)

**Files:**
- Create: `src/components/tokens/SpendingSummary.tsx`
- Test: `src/components/tokens/SpendingSummary.test.tsx`
- Modify: `src/components/tokens/TokenPackages.tsx` (блок с `<TopUpHistory />`, ~строка 466)
- Modify: `src/pages/TokenPurchasePage.tsx` (блок с `<TopUpHistory />`, ~строка 447)

- [ ] **Step 1: Красный тест**

`src/components/tokens/SpendingSummary.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { get } }));
vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../i18n', () => ({ default: { language: 'ru' } }));

import { mount, flush, visibleText, type Mounted } from '../../test/dom';
import { SpendingSummary } from './SpendingSummary';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let m: Mounted | null = null;
beforeEach(() => {
  get.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

const render = async () => {
  m = mount(<SpendingSummary />);
  await flush();
  await flush();
  return m;
};

describe('SpendingSummary', () => {
  it('показывает заголовок и месяцы из ручки; запрос — с поясом', async () => {
    get.mockResolvedValue(ok({ months: [{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }] }));
    const r = await render();
    expect(visibleText(r.container)).toContain('Расход по месяцам');
    expect(visibleText(r.container)).toContain('Ответы ассистентов');
    expect(String(get.mock.calls[0][0])).toMatch(/^\/webhook\/tokens\/spending(\?tz=.+)?$/);
  });

  it('ручка ответила ошибкой — блока нет', async () => {
    get.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect((await render()).container.textContent).toBe('');
  });

  it('трат нет — блока нет', async () => {
    get.mockResolvedValue(ok({ months: [] }));
    expect((await render()).container.textContent).toBe('');
  });

  it('запрос упал — блока нет', async () => {
    get.mockRejectedValue(new Error('network'));
    expect((await render()).container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
git add src/components/tokens/SpendingSummary.test.tsx
git commit -q -m "test(tokens): веб-блок «Расход по месяцам» (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/components/tokens 2>&1 | tail -10'
```
Ожидается: FAIL, `Failed to resolve import "./SpendingSummary"`.

- [ ] **Step 3: Реализация блока**

`src/components/tokens/SpendingSummary.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import { parseSpending, spendingUrl, type SpendingMonth } from '../../shared/spending';
import { SpendingMonths } from '../../shared/ui/SpendingMonths';

/**
 * «Расход по месяцам» — куда ушли токены, по категориям.
 *
 * Заведён после жалобы 23.10.2026 «сгорели токены»: история пополнений
 * показывает только начисления, в чате видна стоимость одних ответов, и
 * картинки с видео нигде не было видно.
 *
 * Пока грузится, при ошибке и без трат — молчим, как TopUpHistory: это
 * справка, она не должна мешать оплате.
 */
export const SpendingSummary: React.FC = () => {
  const { t } = useTranslation();
  const [months, setMonths] = useState<SpendingMonth[] | null>(null);

  useEffect(() => {
    let alive = true;
    apiClient
      .get(spendingUrl())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (alive) setMonths(parseSpending(data));
      })
      .catch((e) => {
        console.error('расход по месяцам:', e);
        if (alive) setMonths([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!months || months.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center space-x-2">
        <PieChart className="h-4 w-4 text-gray-600" />
        <h4 className="text-sm font-medium text-gray-700">{t('payment.spending.title')}</h4>
      </div>
      <SpendingMonths months={months} />
    </div>
  );
};
```

Проверить, что иконка есть в установленной версии (`lucide-react` ^0.344): на ноде
`grep -c "PieChart" ~/ci/wt/spending-front/node_modules/lucide-react/dist/lucide-react.d.ts` — ожидается ≥ 1.

- [ ] **Step 4: Поставить блок над историей пополнений**

`src/components/tokens/TokenPackages.tsx` — импорт рядом с `TopUpHistory`:

```tsx
import { TopUpHistory } from './TopUpHistory';
import { SpendingSummary } from './SpendingSummary';
```

и блок истории:

```tsx
          {/* Под кнопками оплаты: сначала то, ради чего пришли, потом справка —
              куда ушли токены и откуда пришли. */}
          <div className="mt-8">
            <SpendingSummary />
            <TopUpHistory />
          </div>
```

`src/pages/TokenPurchasePage.tsx` — импорт рядом с `TopUpHistory`:

```tsx
import { TopUpHistory } from '../components/tokens/TopUpHistory';
import { SpendingSummary } from '../components/tokens/SpendingSummary';
```

и блок:

```tsx
            {/* Справка — под кнопками оплаты, а не перед ними: куда ушли токены и откуда пришли. */}
            <div className="mb-8">
              <SpendingSummary />
              <TopUpHistory />
            </div>
```

- [ ] **Step 5: Коммит и прогон — зелёный**

```bash
git add src/components/tokens/SpendingSummary.tsx src/components/tokens/TokenPackages.tsx src/pages/TokenPurchasePage.tsx
git commit -q -m "feat(tokens): блок «Расход по месяцам» в окне оплаты и на /tokens

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'grep -c PieChart node_modules/lucide-react/dist/lucide-react.d.ts; pnpm vitest run src/components/tokens src/components/onboarding src/pages 2>&1 | tail -8'
```
Ожидается: число ≥ 1; тесты зелёные (соседние тесты окна оплаты и страниц не сломаны).

---

### Task 11: Кошелёк мини-аппа (фронт)

**Files:**
- Modify: `src/tma/screens/walletData.ts`
- Test: `src/tma/screens/walletData.test.ts`
- Modify: `src/tma/screens/WalletScreen.tsx`

- [ ] **Step 1: Красный тест**

В `src/tma/screens/walletData.test.ts`:

1) в двух существующих тестах `loadWallet` добавить в `deps` строку `getSpending: vi.fn(async () => ({ months: [] })),`;
2) дописать в `describe('loadWallet — независимая деградация', …)`:

```ts
  it('падение сводки расхода не гасит баланс и историю', async () => {
    const deps = {
      getTokens: vi.fn(async () => ({ tokens: 100 })),
      getHistory: vi.fn(async () => ({ items: [] })),
      getSpending: vi.fn(async () => { throw new Error('500'); }),
    };
    const r = await loadWallet(deps);
    expect(r.balance).toBe(100);
    expect(r.history).toEqual([]);
    expect(r.spending).toBe('failed');
  });

  it('сводка расхода разбирается общим разбором', async () => {
    const months = [{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }];
    const deps = {
      getTokens: vi.fn(async () => ({ tokens: 1 })),
      getHistory: vi.fn(async () => ({ items: [] })),
      getSpending: vi.fn(async () => ({ months })),
    };
    expect((await loadWallet(deps)).spending).toEqual(months);
  });
```

- [ ] **Step 2: Коммит и прогон — должен упасть**

```bash
git add src/tma/screens/walletData.test.ts
git commit -q -m "test(tma): сводка расхода в кошельке (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/tma/screens/walletData.test.ts 2>&1 | tail -10'
```
Ожидается: FAIL на двух новых тестах (`r.spending` — undefined).

- [ ] **Step 3: Реализация `walletData.ts`**

Импорт в начало файла:

```ts
import { parseSpending, type SpendingMonth } from '../../shared/spending';
```

В шапке-комментарии после пункта 2 дописать:

```ts
 * 3. Расход — отдельная ручка GET /webhook/tokens/spending (сводка по
 *    месяцам и категориям, только списания); разбор общий с вебом —
 *    src/shared/spending.ts.
```

Заменить `WalletDeps` и `loadWallet`:

```ts
export interface WalletDeps {
  getTokens: () => Promise<unknown>;
  getHistory: () => Promise<unknown>;
  getSpending: () => Promise<unknown>;
}

/**
 * Баланс, история и расход грузятся и падают независимо: разрыв в одном не
 * должен прятать уже полученное другое.
 */
export async function loadWallet(deps: WalletDeps): Promise<{
  balance: Field<number>;
  history: Field<HistoryRow[]>;
  spending: Field<SpendingMonth[]>;
}> {
  const [balance, history, spending] = await Promise.all([
    deps.getTokens().then(parseBalance).catch(() => 'failed' as const),
    deps.getHistory().then(parseHistory).catch(() => 'failed' as const),
    deps.getSpending().then(parseSpending).catch(() => 'failed' as const),
  ]);
  return { balance, history, spending };
}
```

- [ ] **Step 4: Реализация `WalletScreen.tsx`**

Импорты:

```tsx
import { loadWallet, tokensLabel, type Field, type HistoryRow } from './walletData';
import { spendingUrl, type SpendingMonth } from '../../shared/spending';
import { SpendingMonths } from '../../shared/ui/SpendingMonths';
```

Состояние рядом с `history`:

```tsx
  const [spending, setSpending] = useState<Field<SpendingMonth[]>>(null);
```

В `load` — третий источник и установка состояния:

```tsx
      loadWallet({
        getTokens: () => getJson('/webhook/user/tokens/'),
        getHistory: () => getJson('/webhook/tokens/history'),
        getSpending: () => getJson(spendingUrl()),
      }).then((r) => {
        setBalance(r.balance);
        setHistory(r.history);
        setSpending(r.spending);
      });
```

После закрывающего `</ul>` списка истории, перед закрывающим `</div>` экрана:

```tsx
      {Array.isArray(spending) && spending.length > 0 && (
        <>
          <h2 className="mt-6 font-medium">{t('payment.spending.title')}</h2>
          <div className="mt-2">
            <SpendingMonths months={spending} />
          </div>
        </>
      )}
```

Пока грузится или при ошибке секции нет — так же, как в вебе.

- [ ] **Step 5: Коммит и прогон — зелёный**

```bash
git add src/tma/screens/walletData.ts src/tma/screens/WalletScreen.tsx
git commit -q -m "feat(tma): сводка расхода по месяцам в кошельке мини-аппа

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front 'pnpm vitest run src/tma 2>&1 | tail -8'
```
Ожидается: тесты `src/tma` зелёные.

---

### Task 12: Гейты фронта

- [ ] **Step 1: Полный vitest, типы дельтой, скрипты локалей, сборка**

```bash
bash ~/Downloads/spirits_back/.worktrees/spending-node-run.sh front '
pnpm vitest run 2>&1 | grep -E "Test Files|Tests |FAIL" | tail -10
echo "tsc app errors:"; npx tsc --noEmit -p tsconfig.app.json 2>&1 | tee /tmp/spending-tsc.txt | grep -c "error TS" || true
echo "tsc errors in our files:"; grep -E "src/(shared|components/tokens|tma/screens|pages/TokenPurchasePage)" /tmp/spending-tsc.txt || echo none
node scripts/check-locales.mjs && node scripts/check-keys-exist.mjs && node scripts/check-no-hardcoded.mjs && echo I18N-OK
node scripts/check-no-hardcoded-locale.mjs > /tmp/spending-locfmt.txt 2>&1 || true; diff /tmp/spending-locfmt-base.txt /tmp/spending-locfmt.txt && echo LOCFMT-SAME-AS-MAIN
pnpm build 2>&1 | tail -3'
```
Ожидается: vitest без падений (или те же, что на `main`, — сверить отдельным прогоном на базе); число ошибок `tsc` не больше базового из задачи 0 и `none` в своих файлах; `I18N-OK`; `LOCFMT-SAME-AS-MAIN`; сборка `✓ built`.

- [ ] **Step 2: Ревью кода**

Запросить ревью (superpowers:requesting-code-review) по диффам обеих веток против `origin/main`; замечания — исправить отдельными коммитами и повторить затронутые прогоны.

---

### Task 13: Предпросмотр переноса на проде (только чтение)

Не меняет ничего на проде. Нужен, чтобы после выката сверить, что перенос сделал ровно это.

- [ ] **Step 1: Счёт по источникам и снимок балансов затронутых**

С мака (ssh на прод сейчас ходит напрямую; если нет — спросить владельца, обходы — только с его OK):

```bash
mkdir -p ~/Downloads/spirits_back/.worktrees/spending-check
cat > ~/Downloads/spirits_back/.worktrees/spending-check/preview.sql <<'SQL'
SELECT now() AS t0 \gset
\echo T0 :t0
WITH src AS (
  SELECT 'generated_images' s, g.user_id u, g.tokens_spent::bigint n FROM generated_images g
   WHERE g.tokens_spent > 0 AND g.created_at < '2026-08-08 09:02:12+00'
  UNION ALL SELECT 'video_jobs', v.user_id, v.tokens_spent FROM video_jobs v
   WHERE v.status = 'ready' AND v.tokens_spent > 0 AND v.created_at < '2026-08-20 02:55:51+00'
  UNION ALL SELECT 'video_jobs_expired_bak_20260728', v.user_id, v.tokens_spent FROM video_jobs_expired_bak_20260728 v
   WHERE v.status = 'ready' AND v.tokens_spent > 0 AND v.created_at < '2026-08-20 02:55:51+00'
  UNION ALL SELECT 'tg_bot_messages', c.owner_user_id, m.tokens_charged FROM tg_bot_messages m JOIN tg_bot_configs c ON c.id = m.config_id
   WHERE m.tokens_charged > 0 AND m.created_at < '2026-08-11 11:28:37+00')
SELECT s, count(*) AS rows, sum(n) AS tokens, count(DISTINCT u) AS users FROM src GROUP BY s ORDER BY s;
\copy (SELECT a.user_id, a.tokens FROM ai_profiles_consolidated a WHERE a.user_id IN (SELECT user_id FROM generated_images WHERE created_at < '2026-08-08 09:02:12+00' UNION SELECT user_id FROM video_jobs WHERE created_at < '2026-08-20 02:55:51+00' UNION SELECT user_id FROM video_jobs_expired_bak_20260728 UNION SELECT c.owner_user_id FROM tg_bot_configs c JOIN tg_bot_messages m ON m.config_id = c.id WHERE m.created_at < '2026-08-11 11:28:37+00') ORDER BY 1) TO STDOUT WITH CSV
SQL
{ echo 'cd ~/spirits_back || exit 1'
  echo 'DBURL=$(node -e "process.stdout.write(require(\"dotenv\").parse(require(\"fs\").readFileSync(\".env\")).DATABASE_URL)")'
  echo 'PGOPTIONS="-c default_transaction_read_only=on" psql "$DBURL" -X -q -P pager=off <<'"'"'SQL_EOF'"'"''
  cat ~/Downloads/spirits_back/.worktrees/spending-check/preview.sql
  echo 'SQL_EOF'
} | ssh -o ConnectTimeout=20 -o BatchMode=yes dvolkov@212.113.106.202 bash -s \
  | tee ~/Downloads/spirits_back/.worktrees/spending-check/preview.out
```
Ожидается: строка `T0 …`, таблица по четырём источникам (на 23.10: картинки ≈879 / 5 875 000, видео 64 + 35 / 12 615 700, TG 77 / 1 153 476 — с тестовыми аккаунтами), затем CSV `user_id,tokens`. Файл — вне воркдеревьев, в репозиторий не попадает (там номера).

---

### Task 14: Слияние в main — только после «катим» владельца

Вливать раньше нельзя: любой чужой `deploy.sh` выкатит то, что лежит в `main`.

- [ ] **Step 1: Спросить владельца** — коротко: что выкатывается (ручка, перенос ~1 тыс. строк в журнал при старте API, блок в вебе и мини-аппе), что перенос не трогает балансы, что откат описан в спеке. Ждать явного «катим».

- [ ] **Step 2: Бэк**

```bash
cd ~/Downloads/spirits_back/.worktrees/spending-summary && git fetch -q origin \
  && git checkout -q --detach origin/main \
  && git merge -q --no-ff feat/spending-summary -m "Merge feat/spending-summary: сводка расхода по месяцам — ручка, категории, перенос старых трат

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" \
  && git push -q origin HEAD:main && SHA=$(git rev-parse HEAD) && git fetch -q origin \
  && git merge-base --is-ancestor "$SHA" origin/main && echo "back merged ${SHA:0:7}"
```

- [ ] **Step 3: Фронт**

```bash
cd ~/Downloads/spirits_front/.worktrees/spending-summary && git fetch -q origin \
  && git checkout -q --detach origin/main \
  && git merge -q --no-ff feat/spending-summary -m "Merge feat/spending-summary: блок «Расход по месяцам» в вебе и мини-аппе

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" \
  && git push -q origin HEAD:main && SHA=$(git rev-parse HEAD) && git fetch -q origin \
  && git merge-base --is-ancestor "$SHA" origin/main && echo "front merged ${SHA:0:7}"
```
Если push отклонён (кто-то влил своё) — `git fetch`, повторить merge от свежего `origin/main`, прогнать затронутые гейты.

---

### Task 15: Выкат через `deploy.sh` с ноды

- [ ] **Step 1: Проверки до запуска**

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'pgrep -f "^bash scripts/deploy.sh" && echo "ИДЁТ ЧУЖОЙ ВЫКАТ" || echo free
ssh -o ConnectTimeout=10 -o BatchMode=yes linkeon-prod true && echo prod-reachable || echo PROD-UNREACHABLE
ssh -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=/dev/null linkeon@46.101.255.44 true 2>/dev/null && echo bots-ok || echo bots-no-access'
```
Чужой выкат — ждать. Прод недоступен с ноды — остановиться и спросить владельца. Нет доступа к машине ботов — катить с `SKIP_BOTS=1` и сказать об этом владельцу.

- [ ] **Step 2: Свежие клоны и запуск отвязанно**

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'set -e; . ~/.nvm/nvm.sh >/dev/null
D=~/deploy-clones/spending-1023; rm -rf "$D"; mkdir -p "$D" ~/deploy-logs; cd "$D"
git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git spirits_back
git clone -q --branch main git@github.com:dvvolkovv/spirits.git spirits_front
install -m 600 ~/dev/spirits_back/scripts/test-server.env.local spirits_back/scripts/
ln -s ~/dev/spirits_back/tests/node_modules spirits_back/tests/node_modules
cd spirits_back && git log -1 --format="back %h %s" && git -C ../spirits_front log -1 --format="front %h %s"
LOCAL_BACK_DIR=$D/spirits_back LOCAL_FRONT_DIR=$D/spirits_front SKIP_BOTS=1 \
  setsid -f bash -c "echo \$\$ > $D/pid; exec bash scripts/deploy.sh" > ~/deploy-logs/spending-1023.log 2>&1 < /dev/null
sleep 2; echo "pid $(cat $D/pid)"'
```
`SKIP_BOTS=1` — только если в шаге 1 было `bots-no-access`.

- [ ] **Step 3: Ждать итог**

Следить через Monitor (без `| tail` на фоновом процессе — лог пишется построчно):

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'D=~/deploy-clones/spending-1023; while kill -0 $(cat $D/pid) 2>/dev/null; do sleep 30; done; \
  sed -E "s/\x1b\[[0-9;]*m//g" ~/deploy-logs/spending-1023.log | grep -v "^\[Nest\]" | grep -E "PHASE|GREEN|RED|regression|rollback|ERROR" | tail -30'
```
Ожидается: `ALL PHASES GREEN`. Красный test — прод не тронут; разобрать лог, не перезапускать вслепую.

---

### Task 16: Проверка после выката

- [ ] **Step 1: Перенос на проде совпал с предпросмотром, балансы не сдвинулись**

Счёт перенесённого по источникам (сравнить с `preview.out`) и сверка балансов: у каждого затронутого `баланс сейчас − баланс в T0` обязан равняться сумме его обычных (не перенесённых) строк журнала после T0.

```bash
CHK=~/Downloads/spirits_back/.worktrees/spending-check
T0=$(grep '^T0 ' $CHK/preview.out | cut -d' ' -f2-)
VALUES=$(grep -E '^[^,]+,-?[0-9]+$' $CHK/preview.out | awk -F, '{printf "%s(%s%s%s,%s)", (NR>1?",":""), q, $1, q, $2}' q="'")
cat > $CHK/after.sql <<SQL
SELECT metadata->>'source' s, count(*) rows, -sum(amount) tokens FROM token_transactions
 WHERE metadata->>'reconstructed' = 'true' AND metadata->>'source' IN ('generated_images','video_jobs','video_jobs_expired_bak_20260728','tg_bot_messages')
 GROUP BY 1 ORDER BY 1;
WITH snap(user_id, t0_tokens) AS (VALUES $VALUES)
SELECT count(*) AS users_checked,
       count(*) FILTER (WHERE a.tokens - s.t0_tokens <> COALESCE(d.delta, 0)) AS mismatched
  FROM snap s JOIN ai_profiles_consolidated a USING (user_id)
  LEFT JOIN (SELECT user_id, sum(amount) delta FROM token_transactions
              WHERE created_at > '$T0' AND (metadata->>'reconstructed') IS DISTINCT FROM 'true'
              GROUP BY 1) d USING (user_id);
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_token_transactions_user_created';
SQL
{ echo 'cd ~/spirits_back || exit 1'
  echo 'DBURL=$(node -e "process.stdout.write(require(\"dotenv\").parse(require(\"fs\").readFileSync(\".env\")).DATABASE_URL)")'
  echo 'PGOPTIONS="-c default_transaction_read_only=on" psql "$DBURL" -X -q -P pager=off <<'"'"'SQL_EOF'"'"''
  cat $CHK/after.sql; echo 'SQL_EOF'
} | ssh -o ConnectTimeout=20 -o BatchMode=yes dvolkov@212.113.106.202 bash -s | tee $CHK/after.out
```
Ожидается: строки и токены по источникам = предпросмотру (± записи, появившиеся в источниках между T0 и выкатом, — у старых таблиц их быть не должно); `mismatched = 0`; индекс есть.

- [ ] **Step 2: Ручка вживую — JSON, а не SPA-заглушка**

С ноды, тестовым аккаунтом «Test user» из `CLAUDE.md` фронта (номер в команду подставить из `CLAUDE.md`; в отчёт и репозиторий не писать):

```bash
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'set -e; PHONE=<номер Test user из CLAUDE.md>
S=$(ssh -o BatchMode=yes linkeon-prod "cd ~/spirits_back && node -e \"process.stdout.write(require(\\\"dotenv\\\").parse(require(\\\"fs\\\").readFileSync(\\\".env\\\")).DEBUG_SECRET)\"")
B=https://my.linkeon.io/webhook
curl -s -o /dev/null "$B/898c938d-f094-455c-86af-969617e62f7a/sms/$PHONE"
CODE=$(curl -s -H "X-Debug-Secret: $S" "$B/debug/sms-code/$PHONE" | node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(0)).code||\"\")")
TOK=$(curl -s "$B/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$PHONE/$CODE" | node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(0))[\"access-token\"]||\"\")")
curl -s -D - -o /tmp/spending.json -H "Authorization: Bearer $TOK" "$B/tokens/spending?tz=Europe%2FMoscow" | grep -i "^content-type"
node -e "const j=require(\"/tmp/spending.json\"); console.log(Array.isArray(j.months), j.months.length, JSON.stringify(j.months[0]).slice(0,200))"'
```
Ожидается: `content-type: application/json…`, `true <N> {"month":"2026-10",…}`.

- [ ] **Step 3: Клиент из жалобы 23.10** (id — в переписке, не в репозитории)

Запрос сервиса для его id, read-only, с CASE из собранного `dist` (он есть в `~/ci/wt/spending-back` после задачи 6):

```bash
CHK=~/Downloads/spirits_back/.worktrees/spending-check
USER_ID='<id клиента из жалобы 23.10 — из переписки>'
CASE_SQL=$(ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'cd ~/ci/wt/spending-back && node -e "process.stdout.write(require(\"./dist/tokens/spend-category\").spendCategorySql())"')
cat > $CHK/client.sql <<SQL
SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM') AS month,
       $CASE_SQL AS category, SUM(ABS(amount)) AS tokens, COUNT(*) AS count
  FROM token_transactions
 WHERE user_id = '$USER_ID' AND transaction_type = 'consumed'
 GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;
SQL
{ echo 'cd ~/spirits_back || exit 1'
  echo 'DBURL=$(node -e "process.stdout.write(require(\"dotenv\").parse(require(\"fs\").readFileSync(\".env\")).DATABASE_URL)")'
  echo 'PGOPTIONS="-c default_transaction_read_only=on" psql "$DBURL" -X -q -P pager=off <<'"'"'SQL_EOF'"'"''
  cat $CHK/client.sql; echo 'SQL_EOF'
} | ssh -o ConnectTimeout=20 -o BatchMode=yes dvolkov@212.113.106.202 bash -s | tee $CHK/client.out
```
Ожидается: в `2026-06` строка `images | 110000 | 11`, в `2026-05` — `video | 50000 | 2`.

- [ ] **Step 4: Глазами** (если my.linkeon.io открывается с мака)

Playwright: открыть `https://my.linkeon.io/chat?view=tokens` с токеном тестового аккаунта в `localStorage` (`jwt_access_token`), сделать снимок блока «Расход по месяцам» над историей пополнений. Если с мака сайт не открывается — пропустить и сказать об этом в отчёте.

---

### Task 17: Уборка и память

- [ ] **Step 1: Убрать воркдеревья и клоны**

```bash
git -C ~/Downloads/spirits_back worktree remove .worktrees/spending-summary
git -C ~/Downloads/spirits_front worktree remove .worktrees/spending-summary
rm -f ~/Downloads/spirits_back/.worktrees/spending-node-run.sh
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 'git -C ~/ci/spirits_back worktree remove --force ~/ci/wt/spending-back; \
  git -C ~/ci/spirits_front worktree remove --force ~/ci/wt/spending-front; rm -rf ~/deploy-clones/spending-1023; \
  sudo -u postgres psql -qc "DROP DATABASE IF EXISTS spend_test"'
git -C ~/Downloads/spirits_back push -q origin --delete feat/spending-summary
git -C ~/Downloads/spirits_front push -q origin --delete feat/spending-summary
```
Каталог `~/Downloads/spirits_back/.worktrees/spending-check` (там номера) — удалить после того, как отчёт владельцу отправлен.

- [ ] **Step 2: Память**

Обновить `project_balance_complaint_reconciliation.md`: сводка расхода есть в окне оплаты и кошельке; старые картинки, видео и TG перенесены в журнал с `metadata.reconstructed` и `source` — при сверке баланса их уже не нужно искать в таблицах-источниках (кроме картинок до 19.05 и удалённых видео). Добавить в индекс `MEMORY.md`, если появится новая заметка.
