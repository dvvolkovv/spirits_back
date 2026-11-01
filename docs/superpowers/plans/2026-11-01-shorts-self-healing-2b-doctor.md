# Самовосстановление роликов, очередь 2б — доктор упавших — план исполнения

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** упавший ролик сам выбирает самопочинку по коду сбоя — повтор позже, новая сцена или сборка без сценок — и пишет владельцу, только когда не справился.

**Architecture:** студия и API пишут код сбоя в новую колонку `failed_code`; разбор упавших (`ShortsApprovalService.notifyFailures`) до сообщения спрашивает `ShortsDoctorService`. Решение — чистая функция `prescribe` (`src/shorts/short-doctor.ts`) по таблице «этап + код → действие» с пределами на круг; запись — по захваченному сбою, так что «Повторить» владельца не перебить. История самопочинок — `recoveries` (jsonb), счётчик круга — `auto_recoveries`, обнуляют кнопки владельца. Предел секунд Omni — тоже на круг владельца (`omni_base`, решение 01.11). Строки «Сам пробовал» (сбой) и «Сам восстанавливался» / «Собран без сценок» (проверка); в админке кабинета — история в карточке ролика.

**Tech Stack:** NestJS 10 + node-pg + jest (API, `src/shorts/`); ESM TypeScript + node:test через tsx (студия, `studio/`); React 18 + vitest (кабинет, `spirits_front`); Postgres.

**Спека:** `docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md` — «Очередь 2 → Доктор», «Сообщения владельцу», «Данные», «Админка», «Уточнения при плане 2б».

**Основа:** ветка `feat/shorts-self-healing-2b` от `feat/shorts-self-healing-2` (очередь 2а: колонка `skit_feedback`, `SkitFeedbackError`, `omni_bad_request`). Кабинет — отдельная ветка `feat/shorts-doctor-card` от `origin/main` `spirits_front` (задача 10). Сливать 2б в `main` — только после 2а.

## Правила исполнения (для каждой задачи)

- Тесты, `tsc` и сборки — только на тестовой ноде, мак их не тянет. Бэк и студия — `studio/scripts/node-run.sh "<команда>"` из корня воркдерева: скрипт пушит ветку и гоняет на ноде ровно закоммиченный sha, поэтому сначала коммит, потом прогон. Команды API — с `NODE_RUN_DIR=.` (корень репозитория). Длинные прогоны — в фоне, ждать уведомления.
- Живые базы на ноде: API — `SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it`, студия — `STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it`.
- `git add` — только названные файлы. Репозиторий публичный: ни секретов, ни телефонов.
- Комментарии — по-русски, в стиле соседнего кода. Красное не совпало с ожидаемым — остановиться и доложить с выводом, тесты не подгонять.

## Файлы

| Файл | Что |
|---|---|
| `src/shorts/migrations/005_doctor.sql` (новый) | колонки `failed_code`, `auto_recoveries`, `recoveries` |
| `src/shorts/shorts-schema.service.ts`, `shorts-schema.spec.ts`, `shorts.integration.spec.ts` | накат 005 и сторожа |
| `src/shorts/shorts.controller.ts` | `LIST_COLUMNS`; «Повторить» обнуляет круг |
| `src/shorts/shorts.types.ts`, `shorts.types.spec.ts` | `ShortRecovery`, поля `ShortVideo`, `rowToShort` |
| `src/shorts/short-jobs.ts`, `short-jobs.spec.ts` | код у `StageFatalError`; `failed_code` у сбоя этапа и истёкшей аренды |
| `src/shorts/shorts-director.service.ts`, `shorts-writer.service.ts` (+ спеки) | коды фатальных сбоев |
| `studio/src/errors.ts`, `animate/google.ts`, `capture/login.ts`, `worker/db.ts` (+ тесты, `package.json`) | `keyframe_blocked`, `no_input` у 404, `failed_code` |
| `src/shorts/short-doctor.ts`, `short-doctor.spec.ts` (новые) | таблица, пределы, слова |
| `src/shorts/shorts-doctor.service.ts`, `shorts-doctor.service.spec.ts` (новые) | записи доктора, выключатель |
| `src/shorts/short-env.ts`, `.env.example`, `shorts.module.ts`, `shorts.module.spec.ts` | `SHORTS_AUTO_HEAL`, провайдер |
| `src/shorts/shorts-approval.service.ts` (+ спека) | доктор в разборе упавших; строки сообщений |
| `src/shorts/short-review.ts` (+ спека) | «Замечание» и «Переснять» обнуляют круг |
| `src/shorts/short-captions.ts` (+ спека) | строки в подписи на проверку |
| `spirits_front/src/components/admin/shortStatus.ts`, `ShortCard.tsx` (+ тесты) | история самопочинок, пометка «без сценок — сам» |
| `005_doctor.sql`, `short-review.ts`, `short-captions.ts`, студия `worker/*`, `animate/run-animate.ts` (+ тесты) | предел Omni — на круг владельца (`omni_base`, задача 11) |

---

### Task 1: Миграция 005

**Files:**
- Create: `src/shorts/migrations/005_doctor.sql`
- Modify: `src/shorts/shorts-schema.service.ts`, `src/shorts/shorts.controller.ts` (`LIST_COLUMNS`)
- Test: `src/shorts/shorts-schema.spec.ts`, `src/shorts/shorts.integration.spec.ts`

`LIST_COLUMNS` — здесь же, а не с типами: живой сторож «`LIST_COLUMNS` ∪ тяжёлые поля = все колонки» иначе покраснеет сразу после наката. Пока `rowToShort` новые колонки не читает, тест «тонкий SELECT» их не замечает.

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts-schema.spec.ts` после функции `appliedSkitFeedbackSql` добавить:

```ts
async function appliedDoctorSql(): Promise<string> {
  const text = (await applied()).find((q) => q.includes("hashtext('shorts/005')"));
  if (!text) throw new Error('миграция 005 не применена');
  return text;
}
```

в `describe('ShortsSchemaService', …)` после теста `it('катит 004 после 003', …)`:

```ts
  it('катит 005 после 004', async () => {
    const qs = await applied();
    const fourth = qs.findIndex((q) => q.includes("hashtext('shorts/004')"));
    const fifth = qs.findIndex((q) => q.includes("hashtext('shorts/005')"));
    expect(fourth).toBeGreaterThanOrEqual(0);
    expect(fifth).toBeGreaterThan(fourth);
  });
```

и в конец файла:

```ts
describe('текст 005_doctor.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedDoctorSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql.endsWith('$shorts$;')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/005'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('три колонки — каждая под проверкой information_schema, умолчания — константы', async () => {
    const sql = await appliedDoctorSql();
    const adds = [...sql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+)/g)];
    expect(adds.map(([, t, c]) => `${t}.${c}`).sort()).toEqual(['short_video.auto_recoveries', 'short_video.failed_code', 'short_video.recoveries']);
    expect((sql.match(/ALTER TABLE/g) ?? []).length).toBe(adds.length);
    for (const [, table, column] of adds) {
      expect(sql).toMatch(
        new RegExp(
          `IF NOT EXISTS \\(SELECT 1 FROM information_schema\\.columns\\s+WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'\\) THEN\\s+ALTER TABLE ${table} ADD COLUMN ${column}`,
        ),
      );
    }
    expect(sql).toContain('ADD COLUMN failed_code text;');
    expect(sql).toContain('ADD COLUMN auto_recoveries integer NOT NULL DEFAULT 0;');
    expect(sql).toContain("ADD COLUMN recoveries jsonb NOT NULL DEFAULT '[]'::jsonb;");
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS/);
  });
});
```

В `src/shorts/shorts.integration.spec.ts` список миграций:

```ts
const MIGRATIONS = ['001_shorts.sql', '002_skits.sql', '003_youtube.sql', '004_skit_feedback.sql', '005_doctor.sql'].map((f) => path.join(__dirname, 'migrations', f));
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-schema.spec.ts src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): миграция 005 — код сбоя и самопочинки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `Tests: 3 failed` — два теста текста 005 падают на `миграция 005 не применена`, «катит 005 после 004» — на `expect(fifth).toBeGreaterThan(fourth)` (индекс −1).

- [ ] **Step 3: Миграция**

Создать `src/shorts/migrations/005_doctor.sql`:

```sql
-- 005_doctor.sql — самопочинка упавших роликов: код сбоя, счётчик круга и история.
--
-- Спека: docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md, «Очередь 2 → Доктор», «Данные».
-- План: docs/superpowers/plans/2026-11-01-shorts-self-healing-2b-doctor.md, задача 1.
--
-- КАК КАТИТСЯ — как 001–004: ShortsSchemaService выполняет файл при КАЖДОМ
-- старте API, весь файл — один DO-блок (одна транзакция) под advisory-локом,
-- чужих замков ждём не дольше 5 с. Колонки — под проверкой information_schema:
-- ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT EXISTS и на каждом старте
-- ждал бы открытые записи (шапка 001). Умолчания — константы: Postgres не
-- переписывает таблицу.
--
-- ОТКАТ: весь код очереди 2б — API, студия и кабинет — на старый; колонки можно
-- оставить: старый код их не видит. Снимать колонки — только после отката кода
-- (студия и API 2б пишут их на каждом сбое): убрать 005 из ShortsSchemaService, затем
--   SET lock_timeout = '5s';
--   ALTER TABLE short_video DROP COLUMN failed_code, DROP COLUMN auto_recoveries, DROP COLUMN recoveries;
DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/005'));
    PERFORM set_config('lock_timeout', '5s', true);
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'failed_code') THEN
        ALTER TABLE short_video ADD COLUMN failed_code text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'auto_recoveries') THEN
        ALTER TABLE short_video ADD COLUMN auto_recoveries integer NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'recoveries') THEN
        ALTER TABLE short_video ADD COLUMN recoveries jsonb NOT NULL DEFAULT '[]'::jsonb;
    END IF;
END
$shorts$;
```

В `src/shorts/shorts-schema.service.ts` комментарий `/** По порядку: 002–004 правят таблицы, которые создаёт 001. */` заменить на `/** По порядку: 002–005 правят таблицы, которые создаёт 001. */`, а после строки `await this.applyMigration('004_skit_feedback.sql');` добавить `await this.applyMigration('005_doctor.sql');`.

В `src/shorts/shorts.controller.ts`, в `LIST_COLUMNS`, строку

```ts
  'failed_from', 'failure_notified', 'published_at', 'created_at', 'updated_at',
```

заменить на

```ts
  'failed_from', 'failure_notified', 'failed_code', 'auto_recoveries', 'recoveries', 'published_at', 'created_at', 'updated_at',
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/migrations/005_doctor.sql src/shorts/shorts-schema.service.ts src/shorts/shorts.controller.ts
git commit -m "feat(shorts): миграция 005 — failed_code, auto_recoveries, recoveries" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts src/shorts/shorts.controller.spec.ts 2>&1 | grep -E '✕|Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'"
```

Ожидается: оба `Tests:` без `failed`.

---

### Task 2: Поля ролика — код сбоя и самопочинки

**Files:**
- Modify: `src/shorts/shorts.types.ts`
- Test: `src/shorts/shorts.types.spec.ts`, `src/shorts/shorts.integration.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts.types.spec.ts`, в `describe` с тестами `rowToShort`, добавить:

```ts
  it('самопочинки: код сбоя, счётчик круга и история; без колонок — пусто', () => {
    const rec = { at: '2030-01-01T10:00:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'оживление: лимит' };
    const v = rowToShort({ id: 'x', failed_code: 'google_quota', auto_recoveries: 1, recoveries: [rec] });
    expect([v.failedCode, v.autoRecoveries, v.recoveries]).toEqual(['google_quota', 1, [rec]]);
    const empty = rowToShort({ id: 'y' });
    expect([empty.failedCode, empty.autoRecoveries, empty.recoveries]).toEqual([null, 0, []]);
  });
```

В `src/shorts/shorts.integration.spec.ts`, в тесте `'list: тонкий SELECT не меняет форму ответа — …'`, в объект `insert({…})` новой строкой после строки `      failed_from: 'writing', failure_notified: true, published_at: new Date(Date.now() - 60_000),` добавить (массив jsonb — строкой: node-pg превратил бы JS-массив в массив Postgres):

```ts
      failed_code: 'код-тест', auto_recoveries: 2,
      recoveries: JSON.stringify([{ at: '2030-01-01T10:00:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'причина-тест' }]),
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts.types.spec.ts src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): поля ролика — код сбоя и самопочинки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: падает новый тест (`undefined` вместо значений), `Tests: 1 failed`. Живой тест списка новыми полями пока не отличается: `rowToShort` их не читает ни там, ни там.

- [ ] **Step 3: Типы**

В `src/shorts/shorts.types.ts` перед строкой `// ── Строки таблиц ──────────────────────────────────────────────────────────` вставить:

```ts
/**
 * Самопочинка упавшего ролика (доктор, short-doctor.ts): что сделал и почему.
 * Пишет только API; история не обнуляется, текущий круг — последние
 * auto_recoveries записей (кнопка владельца начинает новый).
 */
export interface ShortRecovery {
  /** Когда — время записи доктора (ISO). */
  at: string;
  /** С какого этапа упал (failed_from). */
  from: ShortStatus;
  /** Код сбоя (failed_code); null — сбой без кода. */
  code: string | null;
  action: 'later' | 'new_scene' | 'no_skits';
  /** «Позже» — через сколько минут повтор. */
  delayMin?: number;
  /** Причина сбоя (last_error), до 300 знаков. */
  reason: string;
}

```

В `ShortVideo` после `failureNotified: boolean;` добавить:

```ts
  /** Код последнего сбоя: StudioError студии или сбой этапа API (relay, lease, rules…). */
  failedCode: string | null;
  /** Самопочинки текущего круга — кнопка владельца обнуляет. */
  autoRecoveries: number;
  /** Вся история самопочинок; текущий круг — последние autoRecoveries. */
  recoveries: ShortRecovery[];
```

В `rowToShort` после `failureNotified: row.failure_notified === true,` добавить:

```ts
    failedCode: row.failed_code ?? null,
    autoRecoveries: Number(row.auto_recoveries || 0),
    recoveries: Array.isArray(row.recoveries) ? row.recoveries : [],
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/shorts.types.ts
git commit -m "feat(shorts): код сбоя и самопочинки в ролике" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: оба `Tests:` без `failed`, `TSC_OK`. Тестовые образцы ролика, собранные руками как `ShortVideo` (не через `rowToShort`), `tsc` может потребовать дополнить тремя полями — дописать `failedCode: null, autoRecoveries: 0, recoveries: []`.

---

### Task 3: Коды сбоев этапов API

**Files:**
- Modify: `src/shorts/short-jobs.ts`, `src/shorts/shorts-director.service.ts`, `src/shorts/shorts-writer.service.ts`
- Test: `src/shorts/short-jobs.spec.ts`, `src/shorts/shorts-director.service.spec.ts`, `src/shorts/shorts-writer.service.spec.ts`

Коды: у `StageFatalError` — свой (`rules`, `recapture`, `no_assistant`, `no_scene` — у сценариста нет сцены или съёмки, `no_conflict` — ролик со сценками без сценки 1); исчерпанные повторы этапа — `relay`; истёкшая аренда — `lease`.

- [ ] **Step 1: Падающие тесты**

`src/shorts/short-jobs.spec.ts`:

- в тесте `'до захвата зависшая последняя попытка уходит в failed с подписью этапа'` после `expect(stuck.sql).toMatch(/failure_notified = false/);` добавить `expect(stuck.sql).toMatch(/failed_code = 'lease'/);`;
- в тесте `'третья неудача — failed с этапом, сообщение владельцу ещё не ушло'` строку с параметрами заменить на:

```ts
    expect(p.calls[0].sql).toMatch(/failed_code = \$5/);
    expect(p.calls[0].params).toEqual(['v1', 'directing', 'режиссёр: релей молчит', 3, 'relay']);
```

- тест `'StageFatalError — сразу failed, без повторов'` заменить на:

```ts
  it('StageFatalError — сразу failed, без повторов, с его кодом', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'сценарист', new StageFatalError('rules', 'правила не прошли'))).toBe('failed');
    expect(p.calls[0].params[4]).toBe('rules');
  });
```

- в тесте `'подпись этапа, уже стоящая в ошибке, не дублируется'` — `new StageFatalError('no_assistant', 'режиссёр: нет ассистента')`.

`src/shorts/shorts-director.service.spec.ts`:

- тест `'ассистент темы больше не активен — фатально, повтор не поможет'`: ожидание `.rejects.toBeInstanceOf(StageFatalError)` заменить на `.rejects.toMatchObject({ name: 'StageFatalError', code: 'no_assistant' })`;
- тест `` `нарушения и после ${MAX_SKIT_REWRITES} переписок — StageFatalError, ролик не записан` ``: `.rejects.toThrow(StageFatalError)` → `.rejects.toMatchObject({ name: 'StageFatalError', code: 'rules' })`.

`src/shorts/shorts-writer.service.spec.ts`:

- `'три варианта подряд с нарушениями — фатально, без записи'`: `.rejects.toBeInstanceOf(StageFatalError)` → `.rejects.toMatchObject({ name: 'StageFatalError', code: 'rules' })`;
- `'уже дважды просил другую сцену — третий раз фатально, без записи'`: после `expect(err).toBeInstanceOf(StageFatalError);` добавить `expect(err).toMatchObject({ code: 'recapture' });`;
- `'нет съёмки — фатально'`: → `.rejects.toMatchObject({ name: 'StageFatalError', code: 'no_scene' })`;
- `'у ролика со сценками нет сценки 1 — StageFatalError: нужен режиссёр'`: после ожидания `rejects.toThrow(/нет сценки 1/)` добавить `await expect(svc.write(video({ format: 'skit' }))).rejects.toMatchObject({ code: 'no_conflict' });`.

Если импорт `StageFatalError` в спеке после правок больше не используется — оставить: сторож `toBeInstanceOf` остаётся у теста `recapture`.

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/short-jobs.spec.ts src/shorts/shorts-director.service.spec.ts src/shorts/shorts-writer.service.spec.ts
git commit -m "test(shorts): коды сбоев этапов API (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-jobs.spec.ts src/shorts/shorts-director.service.spec.ts src/shorts/shorts-writer.service.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `Tests: 10 failed` — short-jobs 4, режиссёр 2, сценарист 4 (у `StageFatalError` нет `code`, у SQL нет `failed_code`; jest без проверки типов, поэтому `new StageFatalError('rules', …)` пока кладёт код в сообщение).

- [ ] **Step 3: Код**

`src/shorts/short-jobs.ts` — класс `StageFatalError` с комментарием над ним заменить на:

```ts
/**
 * Код детерминированного сбоя этапа API — по нему доктор (short-doctor.ts)
 * выбирает самопочинку: rules, recapture, no_scene, no_conflict — новая
 * сцена; no_assistant — сообщение владельцу.
 */
export type StageFatalCode = 'rules' | 'recapture' | 'no_assistant' | 'no_scene' | 'no_conflict';

/** Сбой, который повтором не лечится: ролик сразу уходит в failed. */
export class StageFatalError extends Error {
  readonly code: StageFatalCode;

  constructor(code: StageFatalCode, message: string) {
    super(message);
    this.name = 'StageFatalError';
    this.code = code;
  }
}
```

в `claimStage` строку `            last_error = $3, updated_at = now()` (первый запрос) заменить на `            last_error = $3, failed_code = 'lease', updated_at = now()`;

в `stageFailed` последний запрос

```ts
  const r = await pg.query(
    `UPDATE short_video SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3,
            failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2 AND attempts = $4`,
    [v.id, v.status, message, v.attempts],
  );
```

заменить на

```ts
  // Код сбоя — доктору: у фатального свой, у исчерпанных повторов — relay.
  const code = e instanceof StageFatalError ? e.code : 'relay';
  const r = await pg.query(
    `UPDATE short_video SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3,
            failed_code = $5, failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2 AND attempts = $4`,
    [v.id, v.status, message, v.attempts, code],
  );
```

и в описание `stageFailed` после строки `` * `failure_notified = false`: владельцу напишет следующий тик. `` добавить:

```ts
 * Код сбоя — в failed_code: у StageFatalError — его, у исчерпанных повторов —
 * relay (истёкшая аренда — lease, claimStage).
```

`src/shorts/shorts-director.service.ts`:

- `throw new StageFatalError(\`режиссёр: ассистента ${v.assistantId} нет среди активных\`)` → `throw new StageFatalError('no_assistant', \`режиссёр: ассистента ${v.assistantId} нет среди активных\`)`;
- `throw new StageFatalError(\`режиссёр: сценка 1 не прошла правила …\`)` → первым аргументом `'rules'`.

`src/shorts/shorts-writer.service.ts`:

- `'сценарист: у ролика нет сцены или съёмки'` → `new StageFatalError('no_scene', 'сценарист: у ролика нет сцены или съёмки')`;
- `'сценарист: у ролика со сценками нет сценки 1 — повторите с этапа режиссёра'` → первым аргументом `'no_conflict'`;
- `` `сценарист: уже дважды просил другую сцену — …` `` → первым аргументом `'recapture'`;
- `` `сценарист: правила текста не прошли и после ${MAX_REWRITES} переписок — …` `` → первым аргументом `'rules'`.

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/short-jobs.ts src/shorts/shorts-director.service.ts src/shorts/shorts-writer.service.ts
git commit -m "feat(shorts): код сбоя этапа API — в failed_code" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: оба `Tests:` без `failed`, `TSC_OK` (`tsc` найдёт и любой забытый вызов `new StageFatalError(<сообщение>)`).

---

### Task 4: Коды сбоев студии

**Files:**
- Modify: `studio/src/errors.ts`, `studio/src/animate/google.ts`, `studio/src/capture/login.ts`, `studio/src/worker/db.ts`, `studio/package.json`
- Create: `studio/src/capture/login.test.ts`
- Test: `studio/src/animate/google.test.ts`, `studio/src/animate/run-animate.test.ts`, `studio/src/worker/db.integration.ts`, `src/shorts/shorts.contract.spec.ts`

Два кода разделяются (спека, «Доктор»): блок промпта кадра фильтром — `keyframe_blocked` (новая сцена), а не `keyframe` (повтор); debug-ручка ответила 404 — `no_input` (настройка среды, «никак»), а не `login` (повтор).

- [ ] **Step 1: Падающие тесты**

`studio/src/animate/google.test.ts`, тест `'кадр без картинки: RECITATION — повторяемая ошибка, заблокированный промпт — без повтора'`: в проверке заблокированного промпта `isErr('keyframe', false)` заменить на `isErr('keyframe_blocked', false)`.

`studio/src/animate/run-animate.test.ts`, тест `'кадр: пустой ответ — ещё попытка; заблокированный промпт — ни одного запуска Omni'`: в подделке `new StudioError('keyframe', '…заблокировал промпт (PROHIBITED_CONTENT)', false)` код заменить на `'keyframe_blocked'`, в проверке `isErr('keyframe', false)` — на `isErr('keyframe_blocked', false)`.

Создать `studio/src/capture/login.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import { loginDemo } from './login';

const cfg = { apiUrl: 'https://api.test', demoPhone: 'demo', debugSecret: 's' } as unknown as StudioConfig;

test('debug-ручка ответила 404 — no_input без повтора: это настройка среды, а не сбой входа', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('/webhook/debug/sms-code/') ? new Response('', { status: 404 }) : new Response('{}', { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      loginDemo(cfg),
      (e: unknown) => e instanceof StudioError && e.code === 'no_input' && e.retryable === false && /debug-ручка ответила 404/.test(e.message),
    );
  } finally {
    globalThis.fetch = real;
  }
});
```

В `studio/package.json`, в скрипте `test`, после `src/capture/reveal.test.ts` добавить ` src/capture/login.test.ts`.

`studio/src/worker/db.integration.ts`:

- шапку `(src/shorts/migrations: 001, 002, 004; 003 — колонки YouTube, студии не нужны):` → `(src/shorts/migrations: 001, 002, 004, 005; 003 — колонки YouTube, студии не нужны):`;
- `MIGRATIONS`: `['001_shorts.sql', '002_skits.sql', '004_skit_feedback.sql', '005_doctor.sql']`;
- код сбоя — в тестах, где ролик уходит в `failed` (после их проверок строки):
  - `'последняя попытка с истёкшей арендой — при следующем захвате failed, владельцу напишет API'`: для обеих строк (сборки и съёмки) — `assert.equal((await row(<id>)).failed_code, 'lease');`;
  - `'оживление упало без повтора — failed с этапа animating…'` — `failed_code` = `'omni_budget'`;
  - `'сбой с повтором — пауза…; без повтора — failed с этапом'` — `'wrong_assistant'` у упавшей;
  - `'озвучка длиннее 60 с…'` — у `failed` — `'too_long'`;
  - `'сценарий, отвергнутый студией (script_invalid)…'` — у `failed` — `'script_invalid'`;
  - `'сценку не снять с этими репликами — …'` — у `failed` (`f`) — `'speech_mismatch'`;
  - `'код отзыва без SkitFeedbackError …'` — `'speech_mismatch'`.

`src/shorts/shorts.contract.spec.ts`, тест `'очередь студии — те же статусы и колонки'`: в список строк после `'skit_feedback',` добавить `'failed_code',`.

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add studio/src/animate/google.test.ts studio/src/animate/run-animate.test.ts studio/src/capture/login.test.ts studio/package.json studio/src/worker/db.integration.ts src/shorts/shorts.contract.spec.ts
git commit -m "test(studio): коды сбоев — keyframe_blocked, no_input у 404, failed_code (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts src/animate/run-animate.test.ts src/capture/login.test.ts 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'; STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
```

Ожидается: красные — тест кадра в google, тест 404 и тесты живой базы с `failed_code` (`null` вместо кода). Тест кадра в run-animate проходит и сейчас: его подделка сама бросает новый код, а оживление код не переупаковывает — он стережёт, чтобы так и осталось.

- [ ] **Step 3: Код**

`studio/src/errors.ts`: в `StudioErrorCode` после `| 'keyframe'` добавить `| 'keyframe_blocked'`.

`studio/src/animate/google.ts`, строки

```ts
  // Заблокированный промпт не пройдёт и со второго раза — не тратим попытки.
  const blocked = reply.promptFeedback?.blockReason;
  if (blocked) throw new StudioError('keyframe', `keyframe: Nano Banana заблокировал промпт (${blocked})`, false);
```

заменить на

```ts
  // Заблокированный промпт не пройдёт и со второго раза — не тратим попытки. Свой
  // код: доктор API ведёт его к новой сцене, а не к повтору, как сбой кадра.
  const blocked = reply.promptFeedback?.blockReason;
  if (blocked) throw new StudioError('keyframe_blocked', `keyframe: Nano Banana заблокировал промпт (${blocked})`, false);
```

`studio/src/capture/login.ts`, строку

```ts
    if (r.status === 404) throw new StudioError('login', 'login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены', false);
```

заменить на

```ts
    // 404 — настройка среды (секрет или выключенные ручки), а не сбой входа: no_input, доктор его не лечит.
    if (r.status === 404) throw new StudioError('no_input', 'login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены', false);
```

`studio/src/worker/db.ts`:

1. В `claimJob` строку `            last_error = $3, updated_at = now()` (первый запрос) заменить на `            last_error = $3, failed_code = 'lease', updated_at = now()`.

2. В `failJob`, ветка `SkitFeedbackError`, запрос `failed`:

```ts
    return write(
      `UPDATE short_video
          SET status = 'failed', failed_from = 'writing', writer_feedback = $4, skit_feedback = $5::jsonb,
              lease_until = NULL, last_error = $6, failure_notified = false, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      params,
      'failed',
    );
```

заменить на (код — только этой записи: возврат сценаристу параметров до `$6`, лишний Postgres отверг бы)

```ts
    return write(
      `UPDATE short_video
          SET status = 'failed', failed_from = 'writing', writer_feedback = $4, skit_feedback = $5::jsonb,
              lease_until = NULL, last_error = $6, failed_code = $7, failure_notified = false, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      [...params, err.code],
      'failed',
    );
```

3. Ветка сборки, запрос `failed`:

```ts
      `UPDATE short_video
          SET status = 'failed', failed_from = 'writing', writer_feedback = $4, lease_until = NULL, last_error = $5,
              failure_notified = false, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      [feedback, message],
      'failed',
```

→

```ts
      `UPDATE short_video
          SET status = 'failed', failed_from = 'writing', writer_feedback = $4, lease_until = NULL, last_error = $5,
              failed_code = $6, failure_notified = false, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      [feedback, message, err.code],
      'failed',
```

4. Общая ветка:

```ts
    `UPDATE short_video
        SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $4, failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2 AND attempts = $3`,
    [message],
```

→

```ts
    `UPDATE short_video
        SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $4, failed_code = $5,
            failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2 AND attempts = $3`,
    [message, err.code],
```

5. В описании `failJob` после строки `* - иначе failed: failed_from — с чего продолжит «Повторить», владельцу напишет API.` добавить:

```ts
 * У каждого failed — код сбоя (err.code) в failed_code: по нему доктор API
 * выбирает самопочинку; у истёкшей аренды (claimJob) — lease.
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add studio/src/errors.ts studio/src/animate/google.ts studio/src/capture/login.ts studio/src/worker/db.ts
git commit -m "feat(studio): код сбоя — в failed_code; keyframe_blocked и no_input у 404" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npm test 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'; npm run typecheck; STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: студия и живая база `# fail 0`, `tsc` пуст, контракт без `failed`.

- [ ] **Step 5: 404 «No code» — ждать код, а не no_input (ревью задачи 4)**

Debug-ручка отвечает 404 в двух случаях (`src/auth/auth.controller.ts`, `debugSmsCode`): доступа нет (секрет, выключенные ручки) — и секрет верный, но кода в Redis нет (`{ error: 'No code' }`: параллельный вход погасил код, код истёк). Второй — гонка, а не настройка: с `no_input` доктор не стал бы чинить, а владельцу пришло бы «неверный DEBUG_SECRET». Плюс два сторожа из ревью.

`studio/src/capture/login.test.ts`, в конец файла:

```ts
test('404 «No code» — секрет верный, кода ещё (или уже) нет: ждёт, как пустой ответ, а не no_input', async () => {
  const real = globalThis.fetch;
  let codeCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/webhook/debug/sms-code/')) {
      codeCalls++;
      return codeCalls === 1
        ? new Response(JSON.stringify({ error: 'No code' }), { status: 404 })
        : new Response(JSON.stringify({ code: '1234' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    // Код — со второго раза; дальше подделка не отдаёт токенов: вход падает на check-code, но уже не как настройка среды.
    await assert.rejects(loginDemo(cfg), (e: unknown) => e instanceof StudioError && e.code === 'login' && e.retryable === true && /нет токенов/.test(e.message));
    assert.equal(codeCalls, 2);
  } finally {
    globalThis.fetch = real;
  }
});
```

`studio/src/animate/run-animate.test.ts`, тест `'кадр: пустой ответ — ещё попытка; заблокированный промпт — ни одного запуска Omni'`: после `assert.deepEqual(blocked.calls.start, []);` добавить `assert.equal(blocked.calls.keyframe.filter((k) => k.kind === 'conflict').length, 1);` (заблокированный промпт — без повторов кадра).

`src/shorts/shorts.contract.spec.ts`, тест `'очередь студии — те же статусы и колонки'`: строку списка `'failed_code',` заменить на `"failed_code = 'lease'", 'failed_code = $',` (комментарий в `db.ts` один закрыл бы прежнюю проверку).

```bash
git add studio/src/capture/login.test.ts studio/src/animate/run-animate.test.ts src/shorts/shorts.contract.spec.ts
git commit -m "test(studio): 404 «No code» — ждать, а не no_input; сторожа блока кадра и failed_code (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/capture/login.test.ts src/animate/run-animate.test.ts 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: красный один — новый тест `login.test.ts` (сейчас `no_input`); сторож кадра и контракт — зелёные.

`studio/src/capture/login.ts`, в `fetchCode` строки

```ts
    // 404 — настройка среды (секрет или выключенные ручки), а не сбой входа: no_input, доктор его не лечит.
    if (r.status === 404) throw new StudioError('no_input', 'login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены', false);
    if (r.ok) {
      const body = (await r.json()) as { code?: string };
      if (body.code) return body.code;
    }
```

заменить на

```ts
    if (r.status === 404) {
      // «No code» — секрет верный, кода в Redis нет (параллельный вход погасил, истёк): ждём, как пустой ответ.
      // Прочий 404 — настройка среды (секрет или выключенные ручки), а не сбой входа: no_input, доктор его не лечит.
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      if (body?.error !== 'No code') {
        throw new StudioError('no_input', 'login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены', false);
      }
    } else if (r.ok) {
      const body = (await r.json()) as { code?: string };
      if (body.code) return body.code;
    }
```

```bash
git add studio/src/capture/login.ts
git commit -m "fix(studio): 404 «No code» от debug-ручки — ждать код, а не no_input" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npm test 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'; npm run typecheck"
```

Ожидается: студия `# fail 0`, `tsc` пуст.

---

### Task 5: Доктор — решение без базы

**Files:**
- Create: `src/shorts/short-doctor.ts`, `src/shorts/short-doctor.spec.ts`

- [ ] **Step 1: Падающие тесты**

Создать `src/shorts/short-doctor.spec.ts`:

```ts
import { LATER_DELAYS_MIN, MAX_AUTO_RECOVERIES, currentCircle, newSceneNote, prescribe, recoveryEntry, recoveryWords } from './short-doctor';
import type { ShortRecovery, ShortStatus } from './shorts.types';

const rec = (action: ShortRecovery['action'], over: Partial<ShortRecovery> = {}): ShortRecovery => ({
  at: '2030-01-01T10:00:00.000Z', from: 'animating', code: 'google_quota', action, reason: 'r', ...over,
});
const v = (over: Record<string, unknown> = {}) => ({
  failedFrom: 'animating' as ShortStatus | null, failedCode: 'google_quota' as string | null, format: 'skit' as const,
  capture: { answerText: 'ответ' } as any, recoveries: [] as ShortRecovery[], autoRecoveries: 0, lastError: 'оживление: лимит Google исчерпан',
  ...over,
});

describe('prescribe — таблица «этап + код → самопочинка»', () => {
  it.each([
    ['directing', 'relay', 'later'], ['directing', 'lease', 'later'], ['directing', 'rules', 'new_scene'], ['directing', 'no_assistant', 'never'],
    ['writing', 'relay', 'later'], ['writing', 'lease', 'later'], ['writing', 'rules', 'new_scene'], ['writing', 'recapture', 'new_scene'],
    ['writing', 'no_scene', 'new_scene'], ['writing', 'no_conflict', 'new_scene'], ['writing', 'too_long', 'new_scene'],
    ['writing', 'too_short', 'new_scene'], ['writing', 'line_too_short', 'new_scene'], ['writing', 'script_invalid', 'new_scene'],
    ['writing', 'speech_mismatch', 'no_skits'], ['writing', 'omni_rejected', 'no_skits'],
    ['capturing', 'login', 'later'], ['capturing', 'blocked', 'later'], ['capturing', 'idle_timeout', 'later'], ['capturing', 'unknown', 'later'],
    ['capturing', 'lease', 'later'], ['capturing', 'wrong_assistant', 'new_scene'], ['capturing', 'question_hidden', 'new_scene'],
    ['capturing', 'answer_rejected', 'new_scene'], ['capturing', 'no_paragraphs', 'new_scene'],
    ['animating', 'omni_failed', 'later'], ['animating', 'omni_timeout', 'later'], ['animating', 'google_quota', 'later'],
    ['animating', 'keyframe', 'later'], ['animating', 'clip_invalid', 'later'], ['animating', 'stt', 'later'], ['animating', 'lease', 'later'],
    ['animating', 'omni_budget', 'no_skits'], ['animating', 'model_gone', 'no_skits'], ['animating', 'google_auth', 'no_skits'],
    ['animating', 'omni_bad_request', 'no_skits'], ['animating', 'speech_mismatch', 'no_skits'], ['animating', 'omni_rejected', 'no_skits'],
    ['animating', 'keyframe_blocked', 'new_scene'], ['animating', 'script_invalid', 'new_scene'],
    ['rendering', 'tts', 'later'], ['rendering', 'video_invalid', 'later'], ['rendering', 'lease', 'later'], ['rendering', 'frame_size', 'new_scene'],
    ['capturing', 'no_input', 'never'], ['animating', 'no_input', 'never'], ['rendering', 'no_input', 'never'],
    ['publishing', 'telegram', 'never'], ['publishing', null, 'never'],
    ['capturing', 'код-из-будущего', 'later'], ['animating', null, 'later'],
  ])('%s + %s → %s', (from, code, action) => {
    expect(prescribe(v({ failedFrom: from, failedCode: code })).action).toBe(action);
  });

  it('без этапа падения — никак', () => {
    expect(prescribe(v({ failedFrom: null })).action).toBe('never');
  });
});

describe('prescribe — пределы на круг', () => {
  it('«позже»: первый через 30 мин, второй через 2 ч, третьего нет — у съёмки дальше никак', () => {
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login' }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[0] });
    const once = [rec('later', { from: 'capturing', code: 'login', delayMin: 30 })];
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login', recoveries: once, autoRecoveries: 1 }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[1] });
    const twice = [...once, rec('later', { from: 'capturing', code: 'login', delayMin: 120 })];
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login', recoveries: twice, autoRecoveries: 2 })).action).toBe('never');
  });

  it('оживление: «позже» исчерпано — без сценок; без сценок уже было — никак', () => {
    const twice = [rec('later', { delayMin: 30 }), rec('later', { delayMin: 120 })];
    expect(prescribe(v({ recoveries: twice, autoRecoveries: 2 })).action).toBe('no_skits');
    const done = [rec('later', { delayMin: 30 }), rec('no_skits')];
    expect(prescribe(v({ failedCode: 'omni_budget', recoveries: done, autoRecoveries: 2 })).action).toBe('never');
  });

  it(`всего на круг — ${MAX_AUTO_RECOVERIES}`, () => {
    const three = [rec('later', { delayMin: 30 }), rec('new_scene', { from: 'capturing', code: 'answer_rejected' }), rec('later', { delayMin: 120 })];
    expect(prescribe(v({ failedCode: 'omni_budget', recoveries: three, autoRecoveries: 3 })).action).toBe('never');
  });

  it('новая сцена — одна на круг', () => {
    const once = [rec('new_scene', { from: 'capturing', code: 'answer_rejected' })];
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'answer_rejected', recoveries: once, autoRecoveries: 1 })).action).toBe('never');
  });

  it('без сценок нельзя: ролик уже только чат или без съёмки — никак', () => {
    expect(prescribe(v({ failedCode: 'omni_budget', format: 'chat' })).action).toBe('never');
    expect(prescribe(v({ failedCode: 'omni_budget', capture: null })).action).toBe('never');
  });

  it('круг — последние autoRecoveries записей: история прошлых кругов не мешает', () => {
    const old = [rec('later', { delayMin: 30 }), rec('later', { delayMin: 120 }), rec('no_skits')];
    expect(currentCircle({ recoveries: old, autoRecoveries: 0 })).toEqual([]);
    expect(currentCircle({ recoveries: old, autoRecoveries: 1 })).toEqual([old[2]]);
    expect(prescribe(v({ recoveries: old, autoRecoveries: 0 }))).toEqual({ action: 'later', delayMin: 30 });
  });
});

describe('слова и записи', () => {
  it('recoveryWords: «повтор через 30 мин (google_quota), повтор через 2 ч (…), новая сцена (…), без сценок (…)»', () => {
    expect(recoveryWords([
      rec('later', { delayMin: 30 }), rec('later', { delayMin: 120 }),
      rec('new_scene', { code: 'answer_rejected' }), rec('no_skits', { code: null }),
    ])).toBe('повтор через 30 мин (google_quota), повтор через 2 ч (google_quota), новая сцена (answer_rejected), без сценок (без кода)');
  });

  it('recoveryEntry: этап, код, действие; пауза — только у «позже»; причина — до 300 знаков', () => {
    const now = new Date('2030-01-01T10:00:00.000Z');
    expect(recoveryEntry(v(), { action: 'later', delayMin: 30 }, now)).toEqual({
      at: '2030-01-01T10:00:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'оживление: лимит Google исчерпан',
    });
    const long = recoveryEntry(v({ lastError: 'я'.repeat(400) }), { action: 'no_skits' }, now);
    expect(long).not.toHaveProperty('delayMin');
    expect(Array.from(long.reason).length).toBeLessThanOrEqual(300);
  });

  it('newSceneNote: «Сам: прошлая сцена не удалась — <причина>»; без причины — код; переводы строк склеены', () => {
    expect(newSceneNote(v({ lastError: 'съёмка: ответ не годится' }))).toBe('Сам: прошлая сцена не удалась — съёмка: ответ не годится');
    expect(newSceneNote(v({ lastError: null, failedCode: 'answer_rejected' }))).toBe('Сам: прошлая сцена не удалась — answer_rejected');
    // Замечания — построчные (appendOwnerNote): многострочная ошибка студии разорвала бы строку «Сам: …».
    expect(newSceneNote(v({ lastError: 'сборка: сценарий не прошёл\n- строка 1\n- строка 2' }))).toBe('Сам: прошлая сцена не удалась — сборка: сценарий не прошёл - строка 1 - строка 2');
    expect(recoveryEntry(v({ lastError: 'a\n  b' }), { action: 'no_skits' }, new Date(0)).reason).toBe('a b');
  });
});
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/short-doctor.spec.ts
git commit -m "test(shorts): доктор — таблица, пределы, слова (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-doctor.spec.ts 2>&1 | grep -E 'Cannot find module|Tests:|Test Suites:'"
```

Ожидается: набор не грузится — `Cannot find module './short-doctor'`.

- [ ] **Step 3: Решение**

Создать `src/shorts/short-doctor.ts`:

```ts
import { clip } from './short-captions';
import { ShortRecovery, ShortStatus, ShortVideo, retryTarget } from './shorts.types';

/**
 * Доктор упавших роликов — решение без базы (спека самовосстановления,
 * «Доктор»). По этапу падения и коду сбоя — самопочинка: «позже» (тот же этап
 * через 30 мин, во второй раз через 2 ч), «новая сцена» (с режиссёра со
 * строкой «Сам: …» в замечаниях), «без сценок» (сценарист в формате chat) или
 * «никак» — сообщение владельцу. Пределы — на круг: кнопка владельца начинает
 * новый (auto_recoveries = 0). Запись — ShortsDoctorService.
 */

export type HealAction = ShortRecovery['action'];

/** Самопочинок на круг — всего и по видам (спека, «Пределы на ролик»). */
export const MAX_AUTO_RECOVERIES = 3;
export const MAX_PER_ACTION: Record<HealAction, number> = { later: 2, new_scene: 1, no_skits: 1 };
/** «Позже»: первый повтор через 30 минут, второй — через 2 часа. */
export const LATER_DELAYS_MIN = [30, 120];

/** Сцена или съёмка не годится, сценарист с ней не справился — новая сцена. */
const NEW_SCENE: Partial<Record<ShortStatus, readonly string[]>> = {
  directing: ['rules'],
  writing: ['rules', 'recapture', 'no_scene', 'no_conflict', 'too_long', 'too_short', 'line_too_short', 'script_invalid'],
  capturing: ['wrong_assistant', 'question_hidden', 'answer_rejected', 'no_paragraphs'],
  animating: ['keyframe_blocked', 'script_invalid'],
  rendering: ['frame_size'],
};

/** Сценки не снять: у сценариста кончились круги отзыва о сценке, у оживления — секунды, модель, ключ или запрос. */
const NO_SKITS: Partial<Record<ShortStatus, readonly string[]>> = {
  writing: ['speech_mismatch', 'omni_rejected'],
  animating: ['omni_budget', 'model_gone', 'google_auth', 'omni_bad_request', 'speech_mismatch', 'omni_rejected'],
};

type Rule = HealAction | 'later_then_no_skits' | 'never';

function ruleFor(from: ShortStatus | null, code: string | null): Rule {
  // Публикация — никогда: риск двойного поста, у неё свой разбор. no_input — настройка или данные, нужен человек.
  if (!from || from === 'publishing' || code === 'no_input') return 'never';
  if (from === 'directing' && code === 'no_assistant') return 'never';
  if (code && NEW_SCENE[from]?.includes(code)) return 'new_scene';
  if (code && NO_SKITS[from]?.includes(code)) return 'no_skits';
  // Сбои Omni, Google и распознавания — повтор, а исчерпан — без сценок. Незнакомый код — тоже «позже».
  if (from === 'animating') return 'later_then_no_skits';
  return retryTarget({ status: 'failed', failedFrom: from, approvedAt: null }) ? 'later' : 'never';
}

/** Текущий круг — последние autoRecoveries записей истории. */
export function currentCircle(v: Pick<ShortVideo, 'recoveries' | 'autoRecoveries'>): ShortRecovery[] {
  return v.autoRecoveries > 0 ? v.recoveries.slice(-v.autoRecoveries) : [];
}

export type Prescription = { action: HealAction; delayMin?: number } | { action: 'never' };
type Heal = Exclude<Prescription, { action: 'never' }>;

/** Что делать с упавшим роликом. «Никак» — и когда пределы круга кончились. */
export function prescribe(
  v: Pick<ShortVideo, 'failedFrom' | 'failedCode' | 'format' | 'capture' | 'recoveries' | 'autoRecoveries'>,
): Prescription {
  const circle = currentCircle(v);
  if (circle.length >= MAX_AUTO_RECOVERIES) return { action: 'never' };
  const used = (a: HealAction): number => circle.filter((r) => r.action === a).length;
  const allowed = (a: HealAction): boolean => used(a) < MAX_PER_ACTION[a];
  // Без сценок — только ролику со сценками и со съёмкой: сценарист пишет текст по съёмке.
  const noSkits = (): Prescription => (allowed('no_skits') && v.format === 'skit' && v.capture ? { action: 'no_skits' } : { action: 'never' });
  const later = (): Prescription | null => (allowed('later') ? { action: 'later', delayMin: LATER_DELAYS_MIN[used('later')] } : null);
  switch (ruleFor(v.failedFrom, v.failedCode)) {
    case 'later':
      return later() ?? { action: 'never' };
    case 'later_then_no_skits':
      return later() ?? noSkits();
    case 'new_scene':
      return allowed('new_scene') ? { action: 'new_scene' } : { action: 'never' };
    case 'no_skits':
      return noSkits();
    default:
      return { action: 'never' };
  }
}

const ACTION_WORDS: Record<HealAction, (r: ShortRecovery) => string> = {
  later: (r) => `повтор через ${r.delayMin && r.delayMin >= 60 ? `${r.delayMin / 60} ч` : `${r.delayMin ?? LATER_DELAYS_MIN[0]} мин`}`,
  new_scene: () => 'новая сцена',
  no_skits: () => 'без сценок',
};

/** Самопочинки словами: «повтор через 30 мин (google_quota), новая сцена (answer_rejected)». */
export function recoveryWords(entries: ShortRecovery[]): string {
  return entries.map((r) => `${ACTION_WORDS[r.action]?.(r) ?? r.action} (${r.code ?? 'без кода'})`).join(', ');
}

/** Ошибка одной строкой: замечания построчные (appendOwnerNote), а ошибки студии бывают многострочными. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Запись истории: этап и код сбоя, действие, пауза «позже», причина — last_error одной строкой до 300 знаков. */
export function recoveryEntry(v: Pick<ShortVideo, 'failedFrom' | 'failedCode' | 'lastError'>, p: Heal, now: Date): ShortRecovery {
  return {
    at: now.toISOString(),
    from: v.failedFrom as ShortStatus,
    code: v.failedCode,
    action: p.action,
    ...(p.action === 'later' ? { delayMin: p.delayMin } : {}),
    reason: clip(oneLine(v.lastError ?? ''), 300),
  };
}

/** Строка в замечания перед новой сценой: режиссёр и сценарист увидят, что прошлая не удалась. */
export function newSceneNote(v: Pick<ShortVideo, 'lastError' | 'failedCode'>): string {
  return `Сам: прошлая сцена не удалась — ${clip(oneLine(v.lastError || v.failedCode || 'причина не записана'), 300)}`;
}
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/short-doctor.ts
git commit -m "feat(shorts): доктор — таблица самопочинок и пределы круга" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-doctor.spec.ts 2>&1 | grep -E '✕|Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: `Tests:` без `failed`, `TSC_OK`. (`clip` меряет длину в единицах UTF-16 и режет по целым символам — тест длины причины проходит.)

- [ ] **Step 5: Второй заход по ревью качества**

Ревью задачи 5: таблица и пределы верны, критичного нет. Правки: круг считается надёжно и при расхождении счётчика с историей; число «позже» связано с числом пауз; «без сценок» требует и сцены, и съёмки; префикс «Сам:» — одна константа для доктора и сценариста; паузы словами без «1.5 ч»; «позже» — размеченное объединение с обязательной паузой; каждый код студии явно разнесён по таблице (сторож в контракте). И решение по вопросу ревью S1 в духе решения владельца «сценки не удались — собрать без сценок»: у оживления последнее действие круга — сразу «без сценок» (а не «позже», после которого ролика не будет), и при израсходованной новой сцене круга оживление тоже идёт «без сценок», а не к владельцу.

`src/shorts/short-doctor.spec.ts`:

1. Импорт — `import { DOCTOR_NOTE_PREFIX, LATER_DELAYS_MIN, MAX_AUTO_RECOVERIES, currentCircle, newSceneNote, prescribe, recoveryEntry, recoveryWords } from './short-doctor';`; в помощнике `v` после `capture: { answerText: 'ответ' } as any,` добавить `scene: { kind: 'chat' } as any,`.

2. В таблицу `it.each` (перед строкой `['capturing', 'no_input', 'never'], …`) добавить строки — коды, которые спека называет, а решает умолчание:

```ts
    ['capturing', 'answer_timeout', 'later'], ['capturing', 'empty_frame', 'later'],
    ['animating', 'omni_unreadable', 'later'], ['animating', 'unknown', 'later'], ['rendering', 'unknown', 'later'],
```

3. В `describe('prescribe — пределы на круг', …)` добавить:

```ts
  it('«позже» считается на весь круг: после паузы на съёмке первый повтор оживления — уже через 2 ч', () => {
    const once = [rec('later', { from: 'capturing', code: 'login', delayMin: 30 })];
    expect(prescribe(v({ recoveries: once, autoRecoveries: 1 }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[1] });
  });

  it('оживление, последнее действие круга — без сценок, а не «позже»: ролик выйдет наверняка', () => {
    const two = [rec('new_scene', { from: 'capturing', code: 'answer_rejected' }), rec('later', { delayMin: 30 })];
    expect(prescribe(v({ recoveries: two, autoRecoveries: 2 })).action).toBe('no_skits');
    // У других этапов «без сценок» не лечит — там последнее действие прежнее.
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login', recoveries: two, autoRecoveries: 2 }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[1] });
  });

  it('оживление: новая сцена круга израсходована — без сценок; у сценариста — никак', () => {
    const once = [rec('new_scene', { code: 'keyframe_blocked' })];
    expect(prescribe(v({ failedCode: 'keyframe_blocked', recoveries: once, autoRecoveries: 1 })).action).toBe('no_skits');
    expect(prescribe(v({ failedFrom: 'writing', failedCode: 'rules', recoveries: once, autoRecoveries: 1 })).action).toBe('never');
  });

  it('счётчик — источник правды о круге: история короче счётчика или с мусором не ломает предел', () => {
    expect(prescribe(v({ recoveries: [], autoRecoveries: MAX_AUTO_RECOVERIES })).action).toBe('never');
    const junk = [null, rec('later', { delayMin: 30 }), 'x'] as unknown as ShortRecovery[];
    expect(currentCircle({ recoveries: junk, autoRecoveries: 3 })).toEqual([junk[1]]);
    expect(() => recoveryWords(currentCircle({ recoveries: junk, autoRecoveries: 3 }))).not.toThrow();
  });

  it('без сцены «без сценок» нельзя: сценарист пишет текст по сцене и съёмке', () => {
    expect(prescribe(v({ failedCode: 'omni_budget', scene: null })).action).toBe('never');
  });
```

4. В `describe('слова и записи', …)` добавить:

```ts
  it('паузы словами: «1 ч 30 мин», без паузы — «позже»; незнакомое действие — как есть', () => {
    expect(recoveryWords([rec('later', { delayMin: 90 }), rec('later', { delayMin: undefined })])).toBe('повтор через 1 ч 30 мин (google_quota), повтор позже (google_quota)');
    expect(recoveryWords([rec('teleport' as any)])).toBe('teleport (google_quota)');
  });

  it('recoveryEntry без ошибки — пустая причина; строка доктора — с общим префиксом', () => {
    expect(recoveryEntry(v({ lastError: null }), { action: 'no_skits' }, new Date(0)).reason).toBe('');
    expect(newSceneNote(v()).startsWith(`${DOCTOR_NOTE_PREFIX} `)).toBe(true);
  });
```

`src/shorts/shorts.contract.spec.ts`, в `describe('контракт API и студии', …)`:

```ts
  it('каждый код сбоя студии осознанно разнесён в таблице доктора (short-doctor.ts)', () => {
    const union = studio('errors.ts').match(/export type StudioErrorCode =([^;]+);/)?.[1] ?? '';
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(20);
    const doctor = fs.readFileSync(path.join(__dirname, 'short-doctor.ts'), 'utf8');
    expect(codes.filter((c) => !doctor.includes(`'${c}'`))).toEqual([]);
  });
```

```bash
git add src/shorts/short-doctor.spec.ts src/shorts/shorts.contract.spec.ts
git commit -m "test(shorts): доктор — круг по счётчику, последнее действие оживления, паузы словами, сторож кодов студии (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-doctor.spec.ts src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:|Test Suites:'"
```

Ожидается: красные — «последнее действие круга», «новая сцена израсходована», «счётчик — источник правды» (`null` в истории роняет `recoveryWords`), «без сцены», «паузы словами», «префикс» (импорт `DOCTOR_NOTE_PREFIX` — `undefined`, `startsWith('undefined ')` ложно) и сторож кодов студии (в `short-doctor.ts` нет явных `'login'`, `'blocked'` и других кодов «позже»). Новые строки таблицы и «позже на весь круг» — зелёные и сейчас.

`src/shorts/short-doctor.ts`:

1. Константы

```ts
/** Самопочинок на круг — всего и по видам (спека, «Пределы на ролик»). */
export const MAX_AUTO_RECOVERIES = 3;
export const MAX_PER_ACTION: Record<HealAction, number> = { later: 2, new_scene: 1, no_skits: 1 };
/** «Позже»: первый повтор через 30 минут, второй — через 2 часа. */
export const LATER_DELAYS_MIN = [30, 120];
```

заменить на

```ts
/** «Позже»: первый повтор круга через 30 минут, второй — через 2 часа (паузы считаются на весь круг, а не на этап). */
export const LATER_DELAYS_MIN = [30, 120];
/** Самопочинок на круг — всего и по видам (спека, «Пределы на ролик»); «позже» — сколько пауз. */
export const MAX_AUTO_RECOVERIES = 3;
export const MAX_PER_ACTION: Record<HealAction, number> = { later: LATER_DELAYS_MIN.length, new_scene: 1, no_skits: 1 };
/** Начало строки доктора в замечаниях: по нему сценарист отличает её от замечаний владельца (shorts-writer.service.ts). */
export const DOCTOR_NOTE_PREFIX = 'Сам:';
```

2. После `NO_SKITS` добавить явный список «позже» (логика та же — умолчание, — но каждый код студии теперь разнесён осознанно, сторож — `shorts.contract.spec.ts`):

```ts
/** Сбои сети, Google, распознавания, стенда — «позже» (у оживления исчерпано — без сценок). Новый код студии — сюда или в таблицы выше. */
const LATER: readonly string[] = [
  'relay', 'lease', 'login', 'blocked', 'idle_timeout', 'answer_timeout', 'empty_frame', 'unknown',
  'omni_failed', 'omni_timeout', 'google_quota', 'keyframe', 'clip_invalid', 'stt', 'omni_unreadable', 'tts', 'video_invalid',
];
```

и в `ruleFor` перед комментарием `// Сбои Omni, Google и распознавания — …` — `if (code && LATER.includes(code)) return from === 'animating' ? 'later_then_no_skits' : 'later';` (незнакомый код дальше по-прежнему — «позже»).

3. `currentCircle` заменить на:

```ts
/** Текущий круг — последние autoRecoveries записей истории; не записи (ручной SQL, мусор) отбрасываются. */
export function currentCircle(v: Pick<ShortVideo, 'recoveries' | 'autoRecoveries'>): ShortRecovery[] {
  const all = (Array.isArray(v.recoveries) ? v.recoveries : []).filter((r): r is ShortRecovery => !!r && typeof r === 'object');
  return v.autoRecoveries > 0 ? all.slice(-v.autoRecoveries) : [];
}
```

4. Тип и `prescribe`:

```ts
export type Prescription = { action: HealAction; delayMin?: number } | { action: 'never' };
```

→

```ts
export type Prescription = { action: 'later'; delayMin: number } | { action: 'new_scene' } | { action: 'no_skits' } | { action: 'never' };
```

а функцию `prescribe` целиком заменить на:

```ts
/** Что делать с упавшим роликом. «Никак» — и когда пределы круга кончились. */
export function prescribe(
  v: Pick<ShortVideo, 'failedFrom' | 'failedCode' | 'format' | 'scene' | 'capture' | 'recoveries' | 'autoRecoveries'>,
): Prescription {
  const circle = currentCircle(v);
  // Источник правды о круге — счётчик: история могла разойтись с ним (ручной SQL).
  const total = Math.max(circle.length, v.autoRecoveries);
  if (total >= MAX_AUTO_RECOVERIES) return { action: 'never' };
  const used = (a: HealAction): number => circle.filter((r) => r.action === a).length;
  const allowed = (a: HealAction): boolean => used(a) < MAX_PER_ACTION[a];
  // Без сценок — только ролику со сценками, сценой и съёмкой: сценарист пишет текст по ним.
  const noSkits = (): Prescription =>
    allowed('no_skits') && v.format === 'skit' && v.scene && v.capture ? { action: 'no_skits' } : { action: 'never' };
  const later = (): Prescription | null => (allowed('later') ? { action: 'later', delayMin: LATER_DELAYS_MIN[used('later')] } : null);
  const animating = v.failedFrom === 'animating';
  switch (ruleFor(v.failedFrom, v.failedCode)) {
    case 'later':
      return later() ?? { action: 'never' };
    case 'later_then_no_skits':
      // Последнее действие круга у оживления — без сценок: после неудачного «позже» ролика не было бы
      // (решение владельца: сценки не удались — собрать без сценок).
      return total === MAX_AUTO_RECOVERIES - 1 ? noSkits() : later() ?? noSkits();
    case 'new_scene':
      if (allowed('new_scene')) return { action: 'new_scene' };
      // Новая сцена круга израсходована: у оживления — без сценок, у прочих этапов — к владельцу.
      return animating ? noSkits() : { action: 'never' };
    case 'no_skits':
      return noSkits();
    default:
      return { action: 'never' };
  }
}
```

5. Слова: `ACTION_WORDS.later` —

```ts
  later: (r) => `повтор через ${r.delayMin && r.delayMin >= 60 ? `${r.delayMin / 60} ч` : `${r.delayMin ?? LATER_DELAYS_MIN[0]} мин`}`,
```

→

```ts
  later: (r) => `повтор ${delayWords(r.delayMin)}`,
```

и перед `ACTION_WORDS` добавить:

```ts
/** Пауза словами: «через 30 мин», «через 2 ч», «через 1 ч 30 мин»; без паузы — «позже». */
function delayWords(min: number | undefined): string {
  if (!min || min <= 0) return 'позже';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `через ${[h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ')}`;
}
```

6. `newSceneNote`: `` `Сам: прошлая сцена не удалась — …` `` → `` `${DOCTOR_NOTE_PREFIX} прошлая сцена не удалась — ${clip(oneLine(v.lastError || v.failedCode || 'причина не записана'), 300)}` ``.

7. Тип `Heal` (`Exclude<Prescription, { action: 'never' }>`) остаётся; в `recoveryEntry` строка `...(p.action === 'later' ? { delayMin: p.delayMin } : {}),` работает с новым объединением без правок.

```bash
git add src/shorts/short-doctor.ts
git commit -m "fix(shorts): доктор — круг по счётчику, без сценок как последнее действие оживления, префикс «Сам:» общий" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-doctor.spec.ts src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: оба набора без `failed`, `TSC_OK`.

---

### Task 6: Доктор — записи в базу и выключатель

**Files:**
- Create: `src/shorts/shorts-doctor.service.ts`, `src/shorts/shorts-doctor.service.spec.ts`
- Modify: `src/shorts/short-env.ts`, `.env.example`, `src/shorts/shorts.module.ts`, `src/shorts/shorts-approval.service.ts` (конструктор)
- Test: `src/shorts/shorts.module.spec.ts`, `src/shorts/shorts.integration.spec.ts`

- [ ] **Step 1: Падающие тесты**

Создать `src/shorts/shorts-doctor.service.spec.ts`:

```ts
import { ShortsDoctorService } from './shorts-doctor.service';
import { rowToShort } from './shorts.types';

const NOW = new Date('2030-01-01T10:00:00.000Z');
const failed = (over: Record<string, any> = {}) =>
  rowToShort({
    id: 'v1', rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', status: 'failed', format: 'skit',
    failed_from: 'animating', failed_code: 'google_quota', last_error: 'оживление: лимит Google исчерпан', failure_notified: true,
    capture: { answerText: 'ответ', paragraphs: [] }, owner_note: null, recoveries: [], auto_recoveries: 0, ...over,
  });

function setup(rowCount = 1) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      return { rows: [], rowCount };
    }),
  };
  return { svc: new ShortsDoctorService(pg as any), calls };
}

describe('ShortsDoctorService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.SHORTS_AUTO_HEAL;
  });
  afterAll(() => {
    process.env = env;
  });

  it('«позже»: тот же этап в очередь с паузой 30 мин, попытки с нуля, запись в историю — по захваченному сбою', async () => {
    const { svc, calls } = setup();
    expect(await svc.treat(failed(), NOW)).toBe('took');
    expect(calls).toHaveLength(1);
    const [w] = calls;
    expect(w.sql).toMatch(/SET status = \$4, lease_until = now\(\) \+ make_interval\(mins => \$5\)/);
    expect(w.sql).toMatch(/attempts = 0, last_error = NULL, failed_from = NULL, failed_code = NULL, failure_notified = false/);
    expect(w.sql).toMatch(/auto_recoveries = auto_recoveries \+ 1, recoveries = recoveries \|\| \$3::jsonb/);
    expect(w.sql).toMatch(/WHERE id = \$1 AND status = 'failed' AND failed_from = \$2 AND failure_notified$/);
    expect(w.params.slice(0, 2)).toEqual(['v1', 'animating']);
    expect(JSON.parse(w.params[2])).toEqual([
      { at: NOW.toISOString(), from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'оживление: лимит Google исчерпан' },
    ]);
    expect(w.params.slice(3)).toEqual(['animate_queued', 30]);
  });

  it('«новая сцена»: режиссёр, строка «Сам: …» к замечаниям, отзывы и круги сценариста — с нуля, формат прежний', async () => {
    const { svc, calls } = setup();
    const v = failed({ failed_from: 'capturing', failed_code: 'answer_rejected', last_error: 'съёмка: ответ не годится', owner_note: 'Короче.' });
    expect(await svc.treat(v, NOW)).toBe('took');
    const [w] = calls;
    expect(w.sql).toMatch(/SET status = 'directing', lease_until = NULL, writer_rounds = 0, owner_note = \$4, writer_feedback = NULL, skit_feedback = NULL/);
    expect(w.sql).not.toMatch(/format/);
    expect(w.params[3]).toBe('Короче.\nСам: прошлая сцена не удалась — съёмка: ответ не годится');
    expect(JSON.parse(w.params[2])[0]).toMatchObject({ from: 'capturing', code: 'answer_rejected', action: 'new_scene' });
  });

  it('«без сценок»: сценарист в формате chat; оживление (счёт секунд Omni) не трогается', async () => {
    const { svc, calls } = setup();
    expect(await svc.treat(failed({ failed_code: 'omni_budget' }), NOW)).toBe('took');
    const [w] = calls;
    expect(w.sql).toMatch(/SET status = 'writing', format = 'chat', lease_until = NULL, writer_rounds = 0, writer_feedback = NULL, skit_feedback = NULL/);
    expect(w.sql).not.toMatch(/animation/);
    expect(JSON.parse(w.params[2])[0].action).toBe('no_skits');
  });

  it('запись ничего не нашла (владелец успел нажать кнопку) — gone', async () => {
    const { svc } = setup(0);
    expect(await svc.treat(failed(), NOW)).toBe('gone');
  });

  it('не лечится или ролик не упал — gave_up, в базу ничего', async () => {
    const { svc, calls } = setup();
    expect(await svc.treat(failed({ failed_from: 'directing', failed_code: 'no_assistant' }), NOW)).toBe('gave_up');
    expect(await svc.treat(failed({ failed_from: 'publishing', failed_code: null }), NOW)).toBe('gave_up');
    expect(await svc.treat(failed({ status: 'writing' }), NOW)).toBe('gave_up');
    expect(calls).toHaveLength(0);
  });

  it('SHORTS_AUTO_HEAL=false — выключен: gave_up без записи; любое другое значение и отсутствие — включён', async () => {
    process.env.SHORTS_AUTO_HEAL = ' FALSE ';
    const off = setup();
    expect(await off.svc.treat(failed(), NOW)).toBe('gave_up');
    expect(off.calls).toHaveLength(0);
    process.env.SHORTS_AUTO_HEAL = 'true';
    expect(await setup().svc.treat(failed(), NOW)).toBe('took');
    delete process.env.SHORTS_AUTO_HEAL;
    expect(await setup().svc.treat(failed(), NOW)).toBe('took');
  });
});
```

В `src/shorts/shorts.module.spec.ts`: импорт `import { ShortsDoctorService } from './shorts-doctor.service';`; в тесте `'AppModule: все провайдеры роликов в графе'` в список классов после `ShortsWriterService,` добавить `ShortsDoctorService,`, а в конец теста:

```ts
    // Доктор — последним @Optional() разбора упавших: проверяем, что Nest его подставил, а не оставил undefined.
    expect((find(container, ShortsApprovalService) as any).doctor).toBeInstanceOf(ShortsDoctorService);
```

В `src/shorts/shorts.integration.spec.ts`: импорт `import { ShortsDoctorService } from './shorts-doctor.service';` и в `describe` с живыми тестами `notifyFailures` (или рядом с ними) тест:

```ts
  it('доктор на живом SQL: «позже» уводит упавший ролик в очередь этапа с паузой и историей', async () => {
    const v = await insert({
      status: 'failed', failed_from: 'animating', failed_code: 'google_quota', last_error: 'оживление: лимит',
      failure_notified: true, format: 'skit', capture: { answerText: 'a', paragraphs: [] },
    });
    const row = (await pool.query('SELECT * FROM short_video WHERE id = $1', [v.id])).rows[0];
    expect(await new ShortsDoctorService(pgLike() as any).treat(rowToShort(row))).toBe('took');
    const r = (
      await pool.query(
        `SELECT status, attempts, failed_from, failed_code, failure_notified, auto_recoveries, recoveries,
                lease_until > now() + interval '29 minutes' AS paused
           FROM short_video WHERE id = $1`,
        [v.id],
      )
    ).rows[0];
    expect(r).toMatchObject({ status: 'animate_queued', attempts: 0, failed_from: null, failed_code: null, failure_notified: false, auto_recoveries: 1, paused: true });
    expect(r.recoveries).toHaveLength(1);
    expect(r.recoveries[0]).toMatchObject({ from: 'animating', code: 'google_quota', action: 'later', delayMin: 30 });
  });
```

(`insert` и `pgLike` — помощники этого файла; поля, которых `insert` не знает, взять из соседних тестов.)

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-doctor.service.spec.ts src/shorts/shorts.module.spec.ts src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): доктор — записи, выключатель, провайдер (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-doctor.service.spec.ts src/shorts/shorts.module.spec.ts 2>&1 | grep -E 'Cannot find module|✕|Tests:|Test Suites:'"
```

Ожидается: оба набора не грузятся — `Cannot find module './shorts-doctor.service'`.

- [ ] **Step 3: Код**

`src/shorts/short-env.ts`, в конец файла:

```ts
/**
 * Доктор упавших роликов (самопочинка, ShortsDoctorService). В отличие от
 * флагов выше включён по умолчанию: выключает только SHORTS_AUTO_HEAL=false.
 */
export const autoHealEnabled = (): boolean => String(process.env.SHORTS_AUTO_HEAL ?? '').trim().toLowerCase() !== 'false';
```

`.env.example`: после блока флагов роликов (`SHORTS_ENABLED`, `SHORTS_AUTO_TOPICS`, `SHORTS_STAND` и примечания «включаются только строкой true») добавить:

```
# Доктор упавших роликов: сам повторяет этап, берёт новую сцену или собирает
# ролик без сценок и пишет владельцу, только когда не справился. В отличие от
# флагов выше включён по умолчанию; выключить — false.
# SHORTS_AUTO_HEAL=false
```

Создать `src/shorts/shorts-doctor.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { newSceneNote, prescribe, recoveryEntry } from './short-doctor';
import { autoHealEnabled } from './short-env';
import { ShortVideo, appendOwnerNote, retryTarget } from './shorts.types';

/** took — самопочинка записана; gave_up — не взялся (сообщение владельцу); gone — ролик ушёл из failed: владелец успел сам. */
export type TreatOutcome = 'took' | 'gave_up' | 'gone';

/**
 * Доктор упавших роликов (спека самовосстановления, «Доктор»). Разбор упавших
 * (ShortsApprovalService.notifyFailures) спрашивает его до сообщения владельцу.
 * Решение — prescribe (short-doctor.ts), здесь — запись.
 *
 * Каждая запись — по захваченному сбою (status = 'failed', failed_from,
 * failure_notified): владелец мог нажать кнопку, пока решали, — тогда доктор
 * ничего не пишет, а разбор молчит. Выход из failed — как у «Повторить»
 * (shorts.controller.ts, retry): попытки, ошибка, этап и код сбоя обнуляются,
 * failure_notified = false — следующий сбой снова дойдёт до разбора. Причина и
 * код остаются в истории (recoveries). Публикацию доктор не трогает, поэтому
 * общего кода с retry нет: у него свои три записи.
 */
@Injectable()
export class ShortsDoctorService {
  private readonly logger = new Logger(ShortsDoctorService.name);

  constructor(private readonly pg: PgService) {}

  async treat(v: ShortVideo, now: Date = new Date()): Promise<TreatOutcome> {
    if (!autoHealEnabled() || v.status !== 'failed') return 'gave_up';
    const p = prescribe(v);
    if (p.action === 'never') return 'gave_up';
    const entry = JSON.stringify([recoveryEntry(v, p, now)]);
    const done = `attempts = 0, last_error = NULL, failed_from = NULL, failed_code = NULL, failure_notified = false,
            auto_recoveries = auto_recoveries + 1, recoveries = recoveries || $3::jsonb, updated_at = now()`;
    const where = `WHERE id = $1 AND status = 'failed' AND failed_from = $2 AND failure_notified`;
    let r: { rowCount?: number | null };
    if (p.action === 'later') {
      // Тот же этап в его очередь; пауза — аренда: claimStage и студия не берут ролик до её конца.
      r = await this.pg.query(
        `UPDATE short_video SET status = $4, lease_until = now() + make_interval(mins => $5), ${done} ${where}`,
        [v.id, v.failedFrom, entry, retryTarget(v), p.delayMin],
      );
    } else if (p.action === 'new_scene') {
      // Формат прежний: собранный без сценок ролик сам к сценкам не вернётся (кнопка владельца берёт формат из настроек).
      r = await this.pg.query(
        `UPDATE short_video SET status = 'directing', lease_until = NULL, writer_rounds = 0, owner_note = $4,
                writer_feedback = NULL, skit_feedback = NULL, ${done} ${where}`,
        [v.id, v.failedFrom, entry, appendOwnerNote(v.ownerNote, newSceneNote(v))],
      );
    } else {
      // Оживление (animation, счёт секунд Omni) не трогается: деньги ролика считаются за всё время.
      r = await this.pg.query(
        `UPDATE short_video SET status = 'writing', format = 'chat', lease_until = NULL, writer_rounds = 0,
                writer_feedback = NULL, skit_feedback = NULL, ${done} ${where}`,
        [v.id, v.failedFrom, entry],
      );
    }
    if (!r.rowCount) return 'gone';
    const pause = p.action === 'later' ? ` через ${p.delayMin} мин` : '';
    this.logger.log(`ролик ${v.id}: сам — ${p.action}${pause} (${v.failedFrom}, ${v.failedCode ?? 'без кода'})`);
    return 'took';
  }
}
```

`src/shorts/shorts.module.ts`: импорт `import { ShortsDoctorService } from './shorts-doctor.service';`, в `providers` перед `ShortsApprovalService,` — `ShortsDoctorService,`.

`src/shorts/shorts-approval.service.ts`: импорт `Optional` из `@nestjs/common` (`import { Injectable, Logger, Optional } from '@nestjs/common';`) и `import { ShortsDoctorService } from './shorts-doctor.service';`; в конструкторе после `private readonly topics: ShortsTopicService,` добавить:

```ts
    // Последним и @Optional(): прежние тесты строят сервис без доктора. Что Nest его подставляет — сторожит shorts.module.spec.ts.
    @Optional() private readonly doctor?: ShortsDoctorService,
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/short-env.ts .env.example src/shorts/shorts-doctor.service.ts src/shorts/shorts.module.ts src/shorts/shorts-approval.service.ts
git commit -m "feat(shorts): доктор — записи самопочинок, выключатель SHORTS_AUTO_HEAL" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: оба `Tests:` без `failed`, `TSC_OK`.

- [ ] **Step 5 (попутно): «Сам:» в счёте просьб сценариста и хвосты ревью задачи 3**

Строка доктора «Сам: прошлая сцена не удалась — …» (`newSceneNote`) дописывается в замечания перед новой сценой. Сценарист считает свои просьбы о новой сцене хвостом строк «Сценарист: …» (`recapturesInRow`), и чужая строка этот хвост обрывала бы: после новой сцены доктора сценарист мог бы попросить ещё две — до трёх новых сцен вместо одной. Строка доктора — не замечание владельца: счёт она не обнуляет и сама в него не входит. Плюс сторожа из ревью задачи 3.

`src/shorts/shorts-writer.service.spec.ts` — импорт `import { newSceneNote } from './short-doctor';` и после теста `'новое замечание владельца после просьб сценариста — счёт просьб заново'`:

```ts
  it('строка доктора «Сам: …» — не замечание владельца: счёт просьб сценариста не обнуляет', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    // Строка — как её пишет доктор (newSceneNote): тест не разойдётся с префиксом.
    const note = `про субаренду\nСценарист: нужен вопрос про субаренду\nСценарист: всё ещё не про субаренду\n${newSceneNote({ lastError: 'съёмка: ответ не годится', failedCode: 'answer_rejected' })}`;
    const err = await svc.write(video({ owner_note: note })).catch((e) => e);
    expect(err).toMatchObject({ name: 'StageFatalError', code: 'recapture' });
    expect(pg.query).not.toHaveBeenCalled();
  });
```

`src/shorts/shorts-director.service.spec.ts` — импорт `StageFatalError` снова в деле: в тесте `'кривой ответ режиссёра — обычная ошибка: этап повторится'` после ожидания `rejects.toThrow(/режиссёр: не нашёл JSON/)` добавить `expect(await svc.direct(video()).catch((e) => e)).not.toBeInstanceOf(StageFatalError);`, в тесте `'провокационная подача, ассистент не задан, режиссёр выбрал ассистента здоровья — отклоняем'` после ожидания `rejects.toThrow(…)` — `expect(await svc.direct(video({ angle: 'roast', assistant_id: null })).catch((e) => e)).not.toBeInstanceOf(StageFatalError);` (обычная ошибка — этап повторится, фатальная — сразу к доктору: это решает его действие).

`src/shorts/short-jobs.spec.ts`, в `describe('stageFailed', …)`:

```ts
  it('ошибка со своим code (сеть, pg) — в failed_code всё равно relay: код берётся только у StageFatalError', async () => {
    const p = pg();
    await stageFailed(p, video(3), 'режиссёр', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    expect(p.calls[0].params[4]).toBe('relay');
  });
```

`src/shorts/shorts.integration.spec.ts`: в тесте этапа, где третья неудача даёт `failed` (последняя проверка — `expect([row.status, row.failed_from, row.failure_notified, row.last_error]).toEqual(['failed', 'directing', false, 'режиссёр: релей молчит']);`), добавить `expect(row.failed_code).toBe('relay');`; в тесте `'аренда истекла посреди работы: …'` последний запрос `SELECT status, failed_from, failure_notified FROM short_video WHERE id = $1` → `SELECT status, failed_from, failure_notified, failed_code FROM short_video WHERE id = $1`, ожидание → `{ status: 'failed', failed_from: 'directing', failure_notified: false, failed_code: 'lease' }`.

```bash
git add src/shorts/shorts-writer.service.spec.ts src/shorts/shorts-director.service.spec.ts src/shorts/short-jobs.spec.ts src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): «Сам:» не обнуляет счёт просьб сценариста; сторожа кодов этапов (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts src/shorts/shorts-director.service.spec.ts src/shorts/short-jobs.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `Tests: 1 failed` — тест «Сам:» (хвост оборван строкой доктора → ролик ушёл к режиссёру, `pg.query` вызван). Остальные новые проверки — сторожа, зелёные сразу.

`src/shorts/shorts-writer.service.ts`, строки

```ts
const RECAPTURE_NOTE = 'Сценарист:';

/** Просьбы «Сценарист: …» в хвосте замечаний — после последнего замечания владельца. */
function recapturesInRow(ownerNote: string | null): number {
  const lines = String(ownerNote ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let n = 0;
  while (n < lines.length && lines[lines.length - 1 - n].startsWith(RECAPTURE_NOTE)) n++;
  return n;
}
```

заменить на (и импорт `import { DOCTOR_NOTE_PREFIX } from './short-doctor';` — общий префикс строки доктора, задача 5, шаг 5)

```ts
const RECAPTURE_NOTE = 'Сценарист:';

/**
 * Просьбы «Сценарист: …» в хвосте замечаний — после последнего замечания
 * владельца. Строки доктора «Сам: …» не в счёт и счёт не рвут: иначе после
 * новой сцены доктора сценарист попросил бы ещё две.
 */
function recapturesInRow(ownerNote: string | null): number {
  const lines = String(ownerNote ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(DOCTOR_NOTE_PREFIX)) continue;
    if (!lines[i].startsWith(RECAPTURE_NOTE)) break;
    n++;
  }
  return n;
}
```

`src/shorts/short-jobs.ts`: в комментарии над `StageFatalCode` `* Код детерминированного сбоя этапа API — по нему доктор (short-doctor.ts)` → `* Код сбоя этапа API, который повтором не лечится, — по нему доктор (short-doctor.ts)`; в описании `stageFailed` строку `* relay (истёкшая аренда — lease, claimStage).` → `* relay — любой не фатальный сбой после исчерпанных попыток: релей, разбор ответа, срок этапа, база (истёкшая аренда — lease, claimStage).`

```bash
git add src/shorts/shorts-writer.service.ts src/shorts/short-jobs.ts
git commit -m "fix(shorts): строка доктора «Сам:» не обнуляет счёт просьб сценариста; точнее комментарии кодов этапов" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'"
```

Ожидается: оба `Tests:` без `failed`.

---

### Task 7: Доктор в разборе упавших; «Сам пробовал»

**Files:**
- Modify: `src/shorts/shorts-approval.service.ts` (`notifyFailures`)
- Test: `src/shorts/shorts-approval.service.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts-approval.service.spec.ts` функцию `setup` расширить вторым параметром — доктором:

```ts
function setup(dbRow: any = row(), doctor?: any) {
```

и в ней `new ShortsApprovalService(pg as any, tg as any, storage as any, settings as any, topics as any, doctor)`.

В `describe('сообщения о сбоях', …)` в конец добавить:

```ts
    /** Разбор захватит один упавший ролик — этот. */
    const failedOnce = (pg: any, over: Record<string, any>) => {
      let given = false;
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', ...over })] };
        }
        return { rows: [] };
      });
    };

    it('доктор взялся — сообщения нет; ролик доктору — захваченный, с кодом сбоя', async () => {
      const doctor = { treat: jest.fn(async () => 'took') };
      const { svc, tg, pg } = setup(row(), doctor);
      failedOnce(pg, { last_error: 'оживление: лимит', failed_from: 'animating', failed_code: 'google_quota' });
      await svc.notifyFailures();
      expect(doctor.treat).toHaveBeenCalledTimes(1);
      expect((doctor.treat.mock.calls[0] as any[])[0]).toMatchObject({ id: ID, failedFrom: 'animating', failedCode: 'google_quota' });
      expect(tg.sendMessage).not.toHaveBeenCalled();
    });

    it('владелец успел нажать кнопку (gone) — сообщения нет', async () => {
      const doctor = { treat: jest.fn(async () => 'gone') };
      const { svc, tg, pg } = setup(row(), doctor);
      failedOnce(pg, { last_error: 'оживление: лимит', failed_from: 'animating', failed_code: 'google_quota' });
      await svc.notifyFailures();
      expect(tg.sendMessage).not.toHaveBeenCalled();
    });

    it('доктор не взялся — сообщение и строка «Сам пробовал» по текущему кругу, прошлые круги не в счёт', async () => {
      const doctor = { treat: jest.fn(async () => 'gave_up') };
      const { svc, tg, pg } = setup(row(), doctor);
      failedOnce(pg, {
        last_error: 'оживление: лимит', failed_from: 'animating', failed_code: 'google_quota', auto_recoveries: 2,
        recoveries: [
          { at: '2030-01-01T07:00:00.000Z', from: 'capturing', code: 'answer_rejected', action: 'new_scene', reason: 'прошлый круг' },
          { at: '2030-01-01T08:00:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'r' },
          { at: '2030-01-01T08:30:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 120, reason: 'r' },
        ],
      });
      await svc.notifyFailures();
      const text = (tg.sendMessage.mock.calls[0] as any[])[1];
      expect(text).toContain('не собрался: оживление: лимит\nСам пробовал: повтор через 30 мин (google_quota), повтор через 2 ч (google_quota).\nЧто дальше');
      expect(text).not.toContain('answer_rejected');
    });

    it('без самопочинок в круге — строки «Сам пробовал» нет', async () => {
      const doctor = { treat: jest.fn(async () => 'gave_up') };
      const { svc, tg, pg } = setup(row(), doctor);
      failedOnce(pg, { last_error: 'режиссёр: ассистента нет', failed_from: 'directing', failed_code: 'no_assistant' });
      await svc.notifyFailures();
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).not.toContain('Сам пробовал');
    });

    it('доктор упал — сообщение уходит, как без него: сбой не прячется', async () => {
      const doctor = { treat: jest.fn(async () => { throw new Error('база недоступна'); }) };
      const { svc, tg, pg } = setup(row(), doctor);
      failedOnce(pg, { last_error: 'оживление: лимит', failed_from: 'animating', failed_code: 'google_quota' });
      await svc.notifyFailures();
      expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('упавшая публикация — доктора не спрашивают', async () => {
      const doctor = { treat: jest.fn(async () => 'took') };
      const { svc, tg, pg } = setup(row(), doctor);
      failedOnce(pg, { last_error: 'публикация: telegram: chat not found', failed_from: 'publishing', tg_unsent: true });
      await svc.notifyFailures();
      expect(doctor.treat).not.toHaveBeenCalled();
      expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-approval.service.spec.ts
git commit -m "test(shorts): доктор в разборе упавших, «Сам пробовал» (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-approval.service.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `Tests: 3 failed` — красные «доктор взялся», «gone» и «Сам пробовал». Тесты «без самопочинок», «доктор упал» и «упавшая публикация» проходят и сейчас: доктора пока не зовут ни для кого, а последний тест сторожит, что публикацию и потом не позовут.

- [ ] **Step 3: Код**

В `src/shorts/shorts-approval.service.ts` импорт `import { currentCircle, recoveryWords } from './short-doctor';`.

Описание `notifyFailures`:

```ts
  /**
   * Упавшие ролики — владельцу, каждый один раз (захват по failure_notified).
   * Telegram сообщение не принял — флаг назад, и из цикла вон: иначе тот же
   * ролик забрался бы снова в этом же вызове. Повторит следующий тик.
   * BLOG_APPROVER_TG_ID не задан — флаг остаётся: писать некому.
   */
```

заменить на

```ts
  /**
   * Упавшие ролики — владельцу, каждый один раз (захват по failure_notified).
   * Сначала — доктор (ShortsDoctorService): взялся — ролик ушёл из failed,
   * сообщения нет; владелец успел нажать кнопку — тоже молчим. Не взялся —
   * сообщение и строка «Сам пробовал», если в круге были самопочинки. Доктор
   * упал — сообщение уходит, как без него: сбой не прячется. Публикацию доктор
   * не лечит.
   * Telegram сообщение не принял — флаг назад, и из цикла вон: иначе тот же
   * ролик забрался бы снова в этом же вызове. Повторит следующий тик.
   * BLOG_APPROVER_TG_ID не задан — флаг остаётся: писать некому.
   */
```

В теле `notifyFailures` (не `sendPendingReviews` и не `handleReplyEdit` — там та же строка) после `      const v = rowToShort(r.rows[0]);` вставить:

```ts
      if (this.doctor && v.failedFrom !== 'publishing') {
        try {
          if ((await this.doctor.treat(v)) !== 'gave_up') continue;
        } catch (e: any) {
          this.logger.error(`доктор: ролик ${v.id} — ${e?.message ?? e}`);
        }
      }
```

и строку

```ts
      const text = `${isStand() ? STAND_MARK : ''}Ролик${quoted(v)} ${what}: ${clip(v.lastError || 'причина не записана', 600)}\n${next}`;
```

заменить на

```ts
      // Публикацию доктор не лечит — его прошлые самопочинки этого круга к её сбою не относятся.
      const tried = v.failedFrom === 'publishing' ? '' : recoveryWords(currentCircle(v));
      const text = `${isStand() ? STAND_MARK : ''}Ролик${quoted(v)} ${what}: ${clip(v.lastError || 'причина не записана', 600)}\n${tried ? `Сам пробовал: ${tried}.\n` : ''}${next}`;
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/shorts-approval.service.ts
git commit -m "feat(shorts): разбор упавших сначала спрашивает доктора; «Сам пробовал» в сообщении" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'"
```

Ожидается: оба `Tests:` без `failed` (живые тесты `notifyFailures` строят сервис без доктора — поведение прежнее).

---

### Task 8: Кнопки владельца начинают новый круг

**Files:**
- Modify: `src/shorts/shorts.controller.ts` (`retry`), `src/shorts/short-review.ts` (`leaveReview`, `noteForReview`)
- Test: `src/shorts/shorts.controller.spec.ts`, `src/shorts/short-review.spec.ts`

«Повторить», «Новая сцена», «Новый текст» (все — `retry`), «Замечание» (`noteForReview`) и «Переснять»/«Отклонить» готового (`leaveReview`) обнуляют счётчик круга; история остаётся. «Повторить» заодно стирает код сбоя — как ошибку и этап.

- [ ] **Step 1: Падающие тесты**

`src/shorts/shorts.controller.spec.ts`, в тесте `'retry { from: directing, note } — с режиссёра, а не с этапа падения; замечание дописано к прежним'` после `const upd = retryWrite(client);` добавить:

```ts
    // Кнопка владельца — новый круг: самопочинки доктора считаются заново, код сбоя стирается вместе с ошибкой.
    expect(String(upd[0])).toMatch(/failed_code = NULL/);
    expect(String(upd[0])).toMatch(/auto_recoveries = 0/);
```

`src/shorts/short-review.spec.ts`:

- в тесте `'без версии — SQL и параметры кнопок лички: статус, откуда, «не вышел»'` (`leaveReview`) после `expect(sql).toContain('SET status = $2');` добавить `expect(sql).toContain('auto_recoveries = 0');`;
- в тесте `'замечание дописано к прежним, ролик — к сценаристу; без версии параметры прежние'` (`noteForReview`) после `expect(sql).toContain("status = 'writing'");` добавить `expect(sql).toContain('auto_recoveries = 0');`.

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts
git commit -m "test(shorts): кнопки владельца обнуляют круг самопочинок (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: три красных теста.

- [ ] **Step 3: Код**

`src/shorts/shorts.controller.ts`, в `retry` строки

```ts
            SET status = $2, attempts = 0, lease_until = NULL, last_error = NULL, failed_from = NULL,
                failure_notified = false, writer_rounds = 0, owner_note = COALESCE($4::text, owner_note),
```

заменить на

```ts
            SET status = $2, attempts = 0, lease_until = NULL, last_error = NULL, failed_from = NULL, failed_code = NULL,
                failure_notified = false, writer_rounds = 0, auto_recoveries = 0, owner_note = COALESCE($4::text, owner_note),
```

и в описание `retry` после абзаца про `from` и формат добавить:

```ts
   *
   * Кнопка владельца начинает новый круг: самопочинки доктора считаются заново
   * (auto_recoveries = 0), история (recoveries) остаётся.
```

`src/shorts/short-review.ts`:

- `leaveReview`: `SET status = $2, approved_at = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()` → `SET status = $2, approved_at = NULL, attempts = 0, lease_until = NULL, last_error = NULL, auto_recoveries = 0, updated_at = now()`;
- `noteForReview`: `SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0,` → `SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0, auto_recoveries = 0,`;
- в описание `noteForReview` после `автоматических переписок студии заново.` дописать ` Самопочинки доктора — тоже (auto_recoveries = 0).`; в описание `leaveReview` — строку ` * Новый круг: самопочинки доктора считаются заново (auto_recoveries = 0).` перед закрывающей `*/`.

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/shorts.controller.ts src/shorts/short-review.ts
git commit -m "feat(shorts): кнопки владельца — новый круг самопочинок" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'"
```

Ожидается: оба `Tests:` без `failed`.

---

### Task 9: «Сам восстанавливался» и «Собран без сценок» в подписи на проверку

**Files:**
- Modify: `src/shorts/short-captions.ts`, `src/shorts/shorts-approval.service.ts` (`sendForReview`)
- Test: `src/shorts/short-captions.spec.ts`, `src/shorts/shorts-approval.service.spec.ts`

- [ ] **Step 1: Падающие тесты**

`src/shorts/short-captions.spec.ts`, в `describe` подписи на проверку (`buildReviewCaption`) добавить (вход — как у соседних тестов этого блока; если там есть общий образец входа — взять его вместо `base`):

```ts
  it('самопочинки круга и «без сценок» — строками шапки перед «Выйдет»; без них строк нет', () => {
    const base = {
      stand: false, rubric: 'assistant' as const, angle: 'calm' as const, assistantName: 'Алексей', question: 'Вопрос', when: 'завтра в 18:00',
      captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'T', description: 'D', tags: [] } },
    };
    const { caption } = buildReviewCaption({ ...base, selfHealed: 'повтор через 30 мин (google_quota), без сценок (omni_budget)', noSkitsReason: 'оживление: предел секунд' });
    expect(caption).toContain('Сам восстанавливался: повтор через 30 мин (google_quota), без сценок (omni_budget)\nСобран без сценок: оживление: предел секунд\nВыйдет: завтра в 18:00');
    expect(buildReviewCaption(base).caption).not.toMatch(/Сам восстанавливался|Собран без сценок/);
  });
```

`src/shorts/shorts-approval.service.spec.ts`, в `describe('отправка владельцу', …)`:

```ts
    it('самопочинки текущего круга — в подписи: «Сам восстанавливался» и «Собран без сценок» с причиной', async () => {
      const recoveries = [
        { at: '2030-01-01T08:00:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'оживление: лимит' },
        { at: '2030-01-01T08:40:00.000Z', from: 'animating', code: 'omni_budget', action: 'no_skits', reason: 'оживление: предел секунд' },
      ];
      const v = fresh({ format: 'chat', auto_recoveries: 2, recoveries });
      const { svc, tg } = setup(v);
      await svc.sendForReview(rowToShort(v), LEASE);
      const caption = (tg.sendVideo.mock.calls[0] as any[])[2].caption;
      expect(caption).toContain('Сам восстанавливался: повтор через 30 мин (google_quota), без сценок (omni_budget)');
      expect(caption).toContain('Собран без сценок: оживление: предел секунд');
    });
```

(Если `rowToShort` не импортирован в спеке — импортировать из `./shorts.types`; если соседние тесты отправки зовут `sendForReview` иначе — так же, как они.)

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/short-captions.spec.ts src/shorts/shorts-approval.service.spec.ts
git commit -m "test(shorts): самопочинки в подписи на проверку (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-captions.spec.ts src/shorts/shorts-approval.service.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: два красных теста.

- [ ] **Step 3: Код**

`src/shorts/short-captions.ts`, в `ReviewCaptionInput` после поля `skits?` добавить:

```ts
  /** Самопочинки текущего круга словами (recoveryWords, short-doctor.ts). */
  selfHealed?: string;
  /** Доктор собрал ролик без сценок — почему: причина сбоя из истории. */
  noSkitsReason?: string;
```

в `buildReviewCaption` строку

```ts
    `Выйдет: ${i.when}`,
```

заменить на

```ts
    ...(i.selfHealed ? [`Сам восстанавливался: ${clip(i.selfHealed, 300)}`] : []),
    ...(i.noSkitsReason ? [`Собран без сценок: ${clip(i.noSkitsReason, 200)}`] : []),
    `Выйдет: ${i.when}`,
```

`src/shorts/shorts-approval.service.ts`, в `sendForReview` перед `const { caption, extra } = buildReviewCaption({` вставить:

```ts
    // Самопочинки текущего круга — владельцу на проверке: что ролик пережил и почему он без сценок.
    const circle = currentCircle(v);
    const noSkits = circle.find((r) => r.action === 'no_skits');
```

и в объект `buildReviewCaption({…})` после блока `...(v.script?.skits ? {…} : {}),` добавить:

```ts
      ...(circle.length ? { selfHealed: recoveryWords(circle) } : {}),
      ...(noSkits ? { noSkitsReason: noSkits.reason || noSkits.code || 'причина не записана' } : {}),
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/short-captions.ts src/shorts/shorts-approval.service.ts
git commit -m "feat(shorts): «Сам восстанавливался» и «Собран без сценок» в подписи на проверку" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | grep -E '✕|^Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: `Tests:` без `failed`, `TSC_OK`.

---

### Task 10: Кабинет — история самопочинок в карточке ролика

**Репозиторий:** `spirits_front`. Воркдерево: `git -C ~/Downloads/spirits_front fetch -q origin && git -C ~/Downloads/spirits_front worktree add -b feat/shorts-doctor-card ~/Downloads/spirits_front/.worktrees/shorts-doctor-card origin/main` (локальный `main` кабинета отстаёт — только от `origin/main`).

**Files:**
- Modify: `src/components/admin/shortStatus.ts`, `src/components/admin/ShortCard.tsx`
- Test: `src/components/admin/ShortCard.test.tsx`, `src/components/admin/shortStatus.test.ts`

Тексты админки — по-русски прямо в коде (админку проверки переводов не трогают: `check-no-hardcoded.mjs`, `check-locales.mjs`, `check-no-hardcoded-locale.mjs`). Новые поля — необязательные: кабинет может выехать раньше бэка.

Прогоны кабинета — на ноде, в отдельном воркдереве CI-клона на точном sha. Каждая команда — целиком одним вызовом: переменные оболочки между вызовами не живут, а пустой `$SHA` молча оставил бы прогон на старом коммите (`test -n` это ловит):

```bash
SHA=$(git rev-parse HEAD) && test -n "$SHA" && git push -q -u origin feat/shorts-doctor-card && ssh -o ConnectTimeout=15 dv@85.192.61.231 "set -e; cd ~/ci/spirits_front && git fetch -q origin && { [ -d ~/ci/wt/sh2b-front ] || git worktree add -q --detach ~/ci/wt/sh2b-front $SHA; } && cd ~/ci/wt/sh2b-front && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && pnpm install --frozen-lockfile >/dev/null 2>&1 && npx vitest run src/components/admin/ShortCard.test.tsx src/components/admin/shortStatus.test.ts 2>&1 | tail -8"
```

- [ ] **Step 1: Падающие тесты**

`src/components/admin/shortStatus.test.ts` — в импорт из `./shortStatus` добавить `ShortRecovery, currentRecoveries, recoveryText` (тесты кабинета проходят и через `tsc -p tsconfig.app.json`: `include: ["src"]`, поэтому помощник типизирован) и в конец файла:

```ts
describe('самопочинки', () => {
  const r = (action: ShortRecovery['action'], over: Partial<ShortRecovery> = {}): ShortRecovery => ({
    at: '2030-01-01T08:00:00.000Z', from: 'animating', code: 'google_quota', action, reason: 'r', ...over,
  });

  it('текущий круг — последние autoRecoveries записей; полей нет — пусто', () => {
    const all = [r('later', { delayMin: 30 }), r('no_skits')];
    expect(currentRecoveries({ recoveries: all, autoRecoveries: 1 })).toEqual([all[1]]);
    expect(currentRecoveries({ recoveries: all, autoRecoveries: 0 })).toEqual([]);
    expect(currentRecoveries({})).toEqual([]);
  });

  it('запись словами: этап, действие, код', () => {
    expect(recoveryText(r('later', { delayMin: 30 }))).toBe('оживление: повтор через 30 мин (google_quota)');
    expect(recoveryText(r('later', { delayMin: 120 }))).toBe('оживление: повтор через 2 ч (google_quota)');
    expect(recoveryText(r('new_scene', { from: 'capturing', code: 'answer_rejected' }))).toBe('съёмка: новая сцена (answer_rejected)');
    expect(recoveryText(r('no_skits', { code: null }))).toBe('оживление: без сценок (без кода)');
  });
});
```

`src/components/admin/ShortCard.test.tsx`, в `describe('раскрытая карточка', …)`:

```ts
  it('самопочинки — история в раскрытой карточке, новые сверху, с причиной; «без сценок» доктора — пометка в строке', () => {
    const recoveries = [
      { at: '2030-01-01T08:00:00.000Z', from: 'animating' as const, code: 'google_quota', action: 'later' as const, delayMin: 30, reason: 'оживление: лимит' },
      { at: '2030-01-01T08:40:00.000Z', from: 'animating' as const, code: 'omni_budget', action: 'no_skits' as const, reason: 'оживление: предел секунд' },
    ];
    render({
      item: item({ format: 'chat', autoRecoveries: 2, recoveries }),
      open: true,
      detail: detail({ format: 'chat', autoRecoveries: 2, recoveries }),
    });
    const list = q('short-recoveries-s1')!.textContent!;
    expect(list).toContain('оживление: без сценок (omni_budget): оживление: предел секунд');
    expect(list.indexOf('без сценок')).toBeLessThan(list.indexOf('повтор через 30 мин'));
    expect(m.container.textContent).toContain('без сценок — сам');
  });

  it('без самопочинок и без полей нового бэка — ни истории, ни пометки', () => {
    render({ open: true, detail: detail() });
    expect(q('short-recoveries-s1')).toBeNull();
    expect(m.container.textContent).not.toContain('без сценок — сам');
  });

  it('отзыв студии сценаристу — в раскрытой карточке', () => {
    render({ open: true, detail: detail({ writerFeedback: 'сценка 2 (развязка): реплика 2 не прозвучала' }) });
    expect(m.container.textContent).toContain('Отзыв студии сценаристу');
    expect(m.container.textContent).toContain('реплика 2 не прозвучала');
  });
```

```bash
git add src/components/admin/shortStatus.test.ts src/components/admin/ShortCard.test.tsx
git commit -m "test(admin): ролики — история самопочинок в карточке (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

и прогон (команда выше). Ожидается: `shortStatus.test.ts` падает (`currentRecoveries` не экспортирован); в `ShortCard.test.tsx` красных два — «самопочинки — история…» и «отзыв студии…»; «без самопочинок…» зелёный и до кода.

- [ ] **Step 2: Код**

`src/components/admin/shortStatus.ts` — перед `/** Ролик в списке (`list`): … */` вставить:

```ts
/** Самопочинка упавшего ролика (доктор API): что сделал и почему. */
export interface ShortRecovery {
  at: string;
  from: ShortStatus;
  code: string | null;
  action: 'later' | 'new_scene' | 'no_skits';
  delayMin?: number;
  reason: string;
}
```

в `ShortItem` после `ownerNote: string | null;`:

```ts
  /** Код последнего сбоя — у упавшего. Поля нет — бэк ещё без доктора. */
  failedCode?: string | null;
  /** Самопочинки текущего круга; кнопка владельца обнуляет. */
  autoRecoveries?: number;
  /** Вся история самопочинок; текущий круг — последние autoRecoveries. */
  recoveries?: ShortRecovery[];
```

в `ShortDetail` после `coverUrl: string | null;`:

```ts
  /** Отзыв студии сценаристу (длина озвучки, сценка, которую не снять). */
  writerFeedback?: string | null;
```

после `STAGE_TITLES` (после его закрывающей `};`):

```ts

const RECOVERY_WORDS: Record<ShortRecovery['action'], (r: ShortRecovery) => string> = {
  later: (r) => `повтор через ${r.delayMin && r.delayMin >= 60 ? `${r.delayMin / 60} ч` : `${r.delayMin ?? 30} мин`}`,
  new_scene: () => 'новая сцена',
  no_skits: () => 'без сценок',
};

/** Самопочинки текущего круга — последние autoRecoveries записей истории. */
export function currentRecoveries(i: Pick<ShortItem, 'recoveries' | 'autoRecoveries'>): ShortRecovery[] {
  const n = i.autoRecoveries ?? 0;
  return n > 0 ? (i.recoveries ?? []).slice(-n) : [];
}

/** Запись истории словами: «оживление: повтор через 30 мин (google_quota)». */
export function recoveryText(r: ShortRecovery): string {
  return `${STAGE_TITLES[r.from] ?? r.from}: ${RECOVERY_WORDS[r.action]?.(r) ?? r.action} (${r.code ?? 'без кода'})`;
}
```

`src/components/admin/ShortCard.tsx`:

- импорт из `./shortStatus` дополнить `currentRecoveries, recoveryText`, и `import { formatSlotAt } from './blogSlotFormat';`;
- строку `const meta = [RUBRIC_TITLES[item.rubric], angle, assistantName, FORMAT_TITLES[item.format]].filter(Boolean).join(' · ');` заменить на:

```tsx
  // Доктор собрал ролик без сценок в этом круге — формат «только чат» не выбирал владелец.
  const selfNoSkits = currentRecoveries(item).some((r) => r.action === 'no_skits');
  const meta = [RUBRIC_TITLES[item.rubric], angle, assistantName, selfNoSkits ? 'без сценок — сам' : FORMAT_TITLES[item.format]]
    .filter(Boolean).join(' · ');
```

- после строки `{detail.lastError && <div className="text-xs text-red-700 break-words">Последняя ошибка: {detail.lastError}</div>}` вставить:

```tsx
                  {detail.writerFeedback && <Field label="Отзыв студии сценаристу">{detail.writerFeedback}</Field>}
                  {(detail.recoveries?.length ?? 0) > 0 && (
                    <div data-testid={`short-recoveries-${item.id}`}>
                      <div className="text-xs text-gray-500">Сам восстанавливался</div>
                      <ul className="text-xs space-y-0.5">
                        {[...(detail.recoveries ?? [])].reverse().map((r) => (
                          <li key={`${r.at}-${r.action}`} className="break-words">
                            {formatSlotAt(r.at, now)} — {recoveryText(r)}{r.reason ? `: ${r.reason}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
```

```bash
git add src/components/admin/shortStatus.ts src/components/admin/ShortCard.tsx
git commit -m "admin: ролики — история самопочинок и «без сценок — сам» в карточке" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Прогоны кабинета на ноде**

Тесты карточки (команда выше), затем полные — в том же воркдереве ноды на новом sha, тоже одним вызовом:

```bash
SHA=$(git rev-parse HEAD) && test -n "$SHA" && git push -q origin feat/shorts-doctor-card && ssh -o ConnectTimeout=15 dv@85.192.61.231 "set -e; cd ~/ci/wt/sh2b-front && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && pnpm install --frozen-lockfile >/dev/null 2>&1 && npx vitest run 2>&1 | grep -E 'Test Files|Tests ' ; npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c 'error TS'; node scripts/check-locales.mjs >/dev/null && echo LOCALES_OK; pnpm build >/dev/null 2>&1 && echo BUILD_OK"
```

Ожидается: vitest без падений, ошибок `tsc` не больше базы `origin/main` (сверить тем же счётом на `origin/main`), `LOCALES_OK`, `BUILD_OK`.

---

### Task 11: Предел секунд Omni — 48 с на круг владельца

**Решение владельца (01.11, после сбоя ролика 889b6423):** предел «Предел секунд Omni» считается на круг владельца, а не на ролик за всё время. Кнопка владельца («Повторить», «Новая сцена», «Новый текст», «Замечание», «Переснять») начинает новый круг и для секунд: `omni_base` = потраченное на этот момент. Внутри круга предел держит повторы студии и доктора, вместе с его новыми сценами. Общий счёт секунд ролика (`animation.omniSeconds`) не трогается — он в подписи на проверку. Причина: 31.10 ложные отказы сверки съели весь предел ролика, и 01.11 доработка по замечанию владельца («сделать плавно» — новое действие развязки, новый клип) упала на пределе, не потратив ни секунды.

**Files:**
- Modify: `src/shorts/migrations/005_doctor.sql` (четвёртая колонка `omni_base`), `src/shorts/shorts.controller.ts` (`LIST_COLUMNS`, `retry`), `src/shorts/short-review.ts`, `src/shorts/shorts.types.ts`, `src/shorts/short-captions.ts`, `src/shorts/shorts-approval.service.ts`, `studio/src/worker/db.ts`, `studio/src/worker/jobs.ts`, `studio/src/worker/worker.ts`, `studio/src/animate/run-animate.ts`
- Test: `src/shorts/shorts-schema.spec.ts`, `src/shorts/shorts.types.spec.ts`, `src/shorts/shorts.controller.spec.ts`, `src/shorts/short-review.spec.ts`, `src/shorts/short-captions.spec.ts`, `src/shorts/shorts.integration.spec.ts`, `src/shorts/shorts.contract.spec.ts`, `studio/src/animate/run-animate.test.ts`, `studio/src/worker/jobs.test.ts`, `studio/src/worker/db.integration.ts`

Миграция 005 ещё нигде не выкачена, поэтому колонка дописывается в неё, а не в новую 006.

- [ ] **Step 1: Падающие тесты**

`src/shorts/shorts-schema.spec.ts`, тест `'три колонки — каждая под проверкой information_schema, умолчания — константы'`: название — `'четыре колонки — …'` (дальше как было), ожидаемый список —

```ts
    expect(adds.map(([, t, c]) => `${t}.${c}`).sort()).toEqual([
      'short_video.auto_recoveries', 'short_video.failed_code', 'short_video.omni_base', 'short_video.recoveries',
    ]);
```

и после проверки `recoveries jsonb …` добавить `expect(sql).toContain('ADD COLUMN omni_base integer NOT NULL DEFAULT 0;');`.

Там же, в тесте `'весь файл — один DO-блок под advisory-локом и lock_timeout'` (005), — порядок «замок → lock_timeout → ALTER» и единственный DO-блок (ревью задачи 1: `toContain` пропустил бы `set_config` после ALTER — первый накат ждал бы замок без предела):

```ts
    const lock = sql.indexOf("pg_advisory_xact_lock(hashtext('shorts/005'))");
    const timeout = sql.indexOf("set_config('lock_timeout', '5s', true)");
    expect(lock).toBeGreaterThan(0);
    expect(timeout).toBeGreaterThan(lock);
    expect(sql.indexOf('ALTER TABLE')).toBeGreaterThan(timeout);
    expect(sql.match(/\$shorts\$/g)).toHaveLength(2);
```

`src/shorts/shorts.integration.spec.ts`, в тесте `'002 поверх базы после 001…'` (накат поверх существующих строк) сразу после `await migrate(pool)` — умолчания 005 на старых строках:

```ts
    expect((await pool.query('SELECT DISTINCT failed_code, auto_recoveries, recoveries, omni_base FROM short_video')).rows)
      .toEqual([{ failed_code: null, auto_recoveries: 0, recoveries: [], omni_base: 0 }]);
```

`src/shorts/shorts.types.spec.ts`, рядом с тестом самопочинок:

```ts
  it('начало круга владельца по секундам Omni — omni_base; без колонки — 0', () => {
    expect(rowToShort({ id: 'x', omni_base: 48 }).omniBase).toBe(48);
    expect(rowToShort({ id: 'y' }).omniBase).toBe(0);
  });
```

`src/shorts/shorts.controller.spec.ts`, в тесте `'retry { from: directing, note } — …'` после проверок задачи 8 (`auto_recoveries = 0`):

```ts
    expect(String(upd[0])).toMatch(/omni_base = COALESCE\(\(animation->>'omniSeconds'\)::int, 0\)/);
```

`src/shorts/short-review.spec.ts`: в тестах `leaveReview` (`'без версии — SQL и параметры кнопок лички: …'`) и `noteForReview` (`'замечание дописано к прежним, …'`) после проверки `auto_recoveries = 0` (задача 8) добавить `expect(sql).toContain("omni_base = COALESCE((animation->>'omniSeconds')::int, 0)");`.

`src/shorts/short-captions.spec.ts`, в `describe('skitCastLine и omniSpendLine', …)`:

```ts
  it('omniSpendLine: начат круг владельца — всего и в этом круге', () => {
    expect(omniSpendLine({ omniSeconds: 56, keyframes: 3, skits: {} }, 48, 48)).toBe('Omni: 56 с, в этом круге 8 из 48 с, кадров 3 ≈ $5,99');
    expect(omniSpendLine({ omniSeconds: 16, keyframes: 2, skits: {} }, 48, 0)).toBe('Omni: 16 из 48 с, кадров 2 ≈ $1,86');
  });
```

`src/shorts/shorts.integration.spec.ts`, тест `'list: тонкий SELECT …'`: в `insert({…})` после строки `recoveries: JSON.stringify(…),` (задача 2) добавить `omni_base: 16,`; над строкой `failed_code: 'код-тест', …` — комментарий `// jsonb-массив — строкой (JSON.stringify): помощник отдаёт массивы как есть, node-pg сделал бы из них массив Postgres.`; после строки `expected.publications = [];` — самопроверку фикстуры (тест сравнивает `rowToShort` с `rowToShort`: если обе стороны скатятся в запасные значения, поля совпадут вхолостую):

```ts
    expect([expected.failedCode, expected.autoRecoveries, expected.recoveries.length, expected.omniBase]).toEqual(['код-тест', 2, 1, 16]);
```

`src/shorts/shorts.contract.spec.ts`, тест `'очередь студии — те же статусы и колонки'`: после `'failed_code',` (задача 4) добавить `'omni_base',`.

`studio/src/animate/run-animate.test.ts`, в конец файла:

```ts
test('предел — на круг владельца: секунды до начала круга не в счёт', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Га-га… ладно.'];
  writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
  const next = fakes(env, { heard: (kind) => (kind === 'punchline' ? lines.join(' ') : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, { ...next.deps, maxOmniSeconds: 8, omniBase: 16 });
  assert.deepEqual(next.calls.start, ['punchline']);
  assert.equal(anim.omniSeconds, 24);
});

test('предел — на круг владельца: круг исчерпан — omni_budget со счётом круга', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Га-га… ладно.'];
  writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
  const next = fakes(env);
  await assert.rejects(
    animateRun(env.runDir, { ...next.deps, maxOmniSeconds: 8, omniBase: 8 }),
    (e: unknown) => isErr('omni_budget', false)(e) && /на ролик ушло 16 с Omni вместе с запущенными, в этом круге — 8 с, предел — 8 с на круг/.test((e as Error).message),
  );
  assert.deepEqual(next.calls.start, []);
});
```

`studio/src/worker/jobs.test.ts`: в помощнике `job` строку `id: ID, kind, attempts: 1, writerRounds: 0, scene, capture: null, script: null, animation: null, ...over,` заменить на `id: ID, kind, attempts: 1, writerRounds: 0, omniBase: 0, scene, capture: null, script: null, animation: null, ...over,`; в тесте `'оживление: счёт денег — из базы, готовое — из MinIO; …'` задание — `job('animate', { capture: skitCapture, script: skitScript, animation: stored, omniBase: 16 })`, а после `assert.equal(hooks.maxOmniSeconds, 48);` — `assert.equal(hooks.omniBase, 16);`.

`studio/src/worker/db.integration.ts`, рядом с тестами захвата:

```ts
  it('задание оживления несёт начало круга владельца по секундам Omni (omni_base)', async () => {
    await insert('animate_queued', { omni_base: 16 });
    const job = await claimJob(pool, 'animate');
    assert.equal(job!.omniBase, 16);
  });
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-schema.spec.ts src/shorts/shorts.types.spec.ts src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts src/shorts/short-captions.spec.ts src/shorts/shorts.integration.spec.ts src/shorts/shorts.contract.spec.ts studio/src/animate/run-animate.test.ts studio/src/worker/jobs.test.ts studio/src/worker/db.integration.ts
git commit -m "test(shorts): предел Omni — на круг владельца (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts src/shorts/shorts.types.spec.ts src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts src/shorts/short-captions.spec.ts src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:'"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts src/worker/jobs.test.ts 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'; STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
```

Ожидается: красные — тест колонок 005, `omniBase` в типах, три проверки SQL кнопок (контроллер, `leaveReview`, `noteForReview`), строка подписи, контракт (`omni_base` нет в `db.ts`); в студии — оба теста предела на круг (`omniBase` пока не читается: 16 + 8 > 8; в сообщении нет «в этом круге»), `hooks.omniBase` в `jobs.test.ts` и захват в живой базе (`omniBase` — `undefined`). Живой тест списка (`omni_base: 16`) проходит: `rowToShort` колонку пока не читает ни там, ни там.

- [ ] **Step 3: Код**

`src/shorts/migrations/005_doctor.sql`:

- первая строка шапки — `-- 005_doctor.sql — самопочинка упавших роликов: код сбоя, счётчик круга и история; начало круга владельца по секундам Omni.`;
- блок `-- ОТКАТ: …` (до строки `--   ALTER TABLE short_video DROP COLUMN …` включительно) заменить на:

```sql
-- ОТКАТ: колонки читают и пишут claimStage API и claimJob студии (failed_code — на
-- каждом такте), разбор упавших и доктор, кнопки владельца, LIST_COLUMNS вкладки
-- «Ролики». Порядок: весь код очереди 2б — API и студия — на старый (кабинету откат
-- не нужен: новые поля он читает как необязательные); колонки можно оставить — старый
-- код их не видит. Колонки оставлены и 2б выкатывается снова — сначала стереть хвосты:
-- старый код не обнулял счётчик круга и код сбоя, доктор принял бы их за свежие:
--   UPDATE short_video SET failed_code = NULL, auto_recoveries = 0, omni_base = COALESCE((animation->>'omniSeconds')::int, 0)
--    WHERE failed_code IS NOT NULL OR auto_recoveries <> 0;
-- Снимать колонки — только после отката кода: убрать 005 из ShortsSchemaService, затем
--   SET lock_timeout = '5s';
--   ALTER TABLE short_video DROP COLUMN failed_code, DROP COLUMN auto_recoveries, DROP COLUMN recoveries, DROP COLUMN omni_base;
--
-- У failed_code нет CHECK — нарочно: набор кодов открытый (незнакомый код — «позже»),
-- CHECK уронил бы запись сбоя студии на первом же новом коде, и сбой потерялся бы.
-- Дописывать колонки в 005 можно, пока она не выкачена; после — только 006: проверка
-- по имени колонки молча пропустит правку уже существующей.
```
- перед `END` (после блока `recoveries`) добавить:

```sql
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'omni_base') THEN
        ALTER TABLE short_video ADD COLUMN omni_base integer NOT NULL DEFAULT 0;
    END IF;
```

`src/shorts/short-review.ts`, после `export const RELEASED_SQL …` (или рядом с другими экспортами SQL этого файла):

```ts
/**
 * Кнопка владельца начинает новый круг и для секунд Omni: предел («Предел
 * секунд Omni») — на круг, студия считает его от omni_base. Общий счёт ролика
 * (animation.omniSeconds) не трогается — он в подписи на проверку.
 */
export const NEW_OMNI_CIRCLE_SQL = "omni_base = COALESCE((animation->>'omniSeconds')::int, 0)";
```

и в записях: `leaveReview` — `…, last_error = NULL, auto_recoveries = 0, updated_at = now()` → `…, last_error = NULL, auto_recoveries = 0, ${NEW_OMNI_CIRCLE_SQL}, updated_at = now()`; `noteForReview` — `SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0, auto_recoveries = 0,` → `SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0, auto_recoveries = 0, ${NEW_OMNI_CIRCLE_SQL},`.

`src/shorts/shorts.controller.ts`: в импорт из `./short-review` добавить `NEW_OMNI_CIRCLE_SQL`; в `retry` `failure_notified = false, writer_rounds = 0, auto_recoveries = 0, owner_note = COALESCE($4::text, owner_note),` → `failure_notified = false, writer_rounds = 0, auto_recoveries = 0, ${NEW_OMNI_CIRCLE_SQL}, owner_note = COALESCE($4::text, owner_note),`; в описании `retry` абзац задачи 8 («Кнопка владельца начинает новый круг: …») дополнить: ` Новый круг — и для секунд Omni: предел считается от omni_base.`; в `LIST_COLUMNS` — `'failed_code', 'auto_recoveries', 'recoveries', 'omni_base', 'published_at', …`.

`src/shorts/shorts.types.ts`: в `ShortVideo` после `recoveries: ShortRecovery[];` —

```ts
  /** Секунды Omni на начало круга владельца: предел оживления — на круг (кнопка владельца переставляет). */
  omniBase: number;
```

в `rowToShort` после `recoveries: …,` — `omniBase: Number(row.omni_base || 0),`.

`src/shorts/short-captions.ts`: в `ReviewCaptionInput.skits` добавить `omniBase?: number` (`skits?: { cast: string; animation: ShortAnimation | null; maxOmniSeconds?: number; omniBase?: number };`); функцию `omniSpendLine` с её описанием заменить на:

```ts
/**
 * Траты на оживление: «Omni: 16 из 48 с, кадров 2 ≈ $1,86» — с пределом, если он
 * передан; начат круг владельца (omni_base) — «Omni: 56 с, в этом круге 8 из 48 с, …».
 */
export function omniSpendLine(a: ShortAnimation | null, maxOmniSeconds?: number, omniBase = 0): string {
  const seconds = a?.omniSeconds ?? 0;
  const frames = a?.keyframes ?? 0;
  const usd = (seconds * OMNI_USD_PER_SEC + frames * KEYFRAME_USD).toFixed(2).replace('.', ',');
  // Предел — рядом: владелец видит, сколько пересъёмок ещё осталось в этом круге.
  const of = Number.isInteger(maxOmniSeconds) ? ` из ${maxOmniSeconds}` : '';
  const spent = omniBase > 0 ? `${seconds} с, в этом круге ${seconds - omniBase}${of} с` : `${seconds}${of} с`;
  return `Omni: ${spent}, кадров ${frames} ≈ $${usd}`;
}
```

в `buildReviewCaption` — `omniSpendLine(i.skits.animation, i.skits.maxOmniSeconds, i.skits.omniBase)`.

`src/shorts/shorts-approval.service.ts`, в `sendForReview` объект `skits` — `{ cast: skitCastLine(v.script.skits), animation: v.animation, maxOmniSeconds: (await this.settings.get()).maxOmniSeconds, omniBase: v.omniBase }`.

`studio/src/worker/db.ts`: в `Job` после `writerRounds: number;` —

```ts
  /** Секунды Omni на начало круга владельца (omni_base): предел оживления — на круг. */
  omniBase: number;
```

в `claimJob` (возврат задания) после `writerRounds: Number(row.writer_rounds ?? 0),` — `omniBase: Number(row.omni_base ?? 0),`.

`studio/src/worker/jobs.ts`: в `AnimateHooks` после `maxOmniSeconds: number;` — `/** Секунды Omni на начало круга владельца: предел — на круг. */` и `omniBase: number;`; в вызове `d.animate(runDir, {` после `maxOmniSeconds: await d.queue.maxOmniSeconds(),` — `omniBase: job.omniBase,`.

`studio/src/worker/worker.ts`: после `maxOmniSeconds: hooks.maxOmniSeconds,` — `omniBase: hooks.omniBase,`.

`studio/src/animate/run-animate.ts`:

- в `AnimateDeps` после `maxOmniSeconds?: number;` —

```ts
  /** Секунды Omni на начало круга владельца: предел — на круг, считается от них (0 — с начала ролика, как в CLI). */
  omniBase?: number;
```

- после проверки `budget` (блок с `предел секунд Omni — «${budget}»`) —

```ts
  const base = deps.omniBase ?? 0;
  if (typeof base !== 'number' || !Number.isFinite(base) || base < 0) {
    throw new StudioError('no_input', `animate: начало круга по секундам Omni — «${base}», нужно неотрицательное число`, false);
  }
```

- `assertBudget` целиком заменить на:

```ts
  const assertBudget = (): void => {
    if (anim.omniSeconds - base + CLIP_SEC > budget) {
      // Круг владельца начат (omni_base) — предел на круг; общий счёт ролика — рядом, для владельца.
      const circle = base > 0 ? `, в этом круге — ${anim.omniSeconds - base} с` : '';
      throw new StudioError(
        'omni_budget',
        `на ролик ушло ${anim.omniSeconds} с Omni вместе с запущенными${circle}, предел — ${budget} с${base > 0 ? ' на круг' : ''}: лимит пересъёмок сценок; поднять — настройка «Предел секунд Omni» (update_settings maxOmniSeconds; в CLI — MAX_OMNI_SECONDS=<секунды> npm run animate)`,
        false,
      );
    }
  };
```

(При `base = 0` текст прежний: тесты с `/предел — 8 с/` и `/на ролик ушло 24 с Omni/` не меняются.)

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/migrations/005_doctor.sql src/shorts/short-review.ts src/shorts/shorts.controller.ts src/shorts/shorts.types.ts src/shorts/short-captions.ts src/shorts/shorts-approval.service.ts studio/src/worker/db.ts studio/src/worker/jobs.ts studio/src/worker/worker.ts studio/src/animate/run-animate.ts
git commit -m "feat(shorts): предел Omni — на круг владельца (omni_base)" -m "Кнопка владельца начинает новый круг и для секунд; общий счёт ролика — в подписи." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npm test 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'; npm run typecheck; STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | grep -E '✕|^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '✕|^Tests:'; out=\$(mktemp); npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1 && echo TSC_OK || { echo TSC_FAIL; tail -20 \$out; }"
```

Ожидается: студия и живая база `# fail 0`, `tsc` студии пуст; бэк — оба `Tests:` без `failed`, `TSC_OK`.

---

### Task 12: Полный прогон, учения на стенде, выкат

**Files:** нет правок кода.

- [ ] **Step 1: Всё на ноде** — бэк и студия на финальном sha ветки 2б:

```bash
studio/scripts/node-run.sh "npm test 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'; npm run typecheck >/dev/null 2>&1 && echo TYPECHECK_OK || echo TYPECHECK_FAIL; STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | grep -E '^Tests:|^Test Suites:|✕' | head -20; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '^Tests:|✕'; out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi; if npm run build >\$out 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; tail -20 \$out; fi"
```

(Разделитель между командами в zsh — не строкой из одних `=`: zsh принимает её за подстановку и обрывает весь список.)

Ожидается: студия `# fail 0`, `TYPECHECK_OK`, живая база `# fail 0`; бэк — `Tests:` без `failed`, `TSC_OK`, `BUILD_OK`. Перед этим — `git merge origin/main` в ветку, если `main` ушёл (2а к этому времени должна быть в `main`).

- [ ] **Step 2 (контролёр, OK владельца на выкат на стенд): учения** — выкатить обе ветки на стенд (`TEST_ONLY=1 SKIP_BOTS=1` с ноды из свежих клонов веток: бэк `--branch feat/shorts-self-healing-2b`, кабинет `--branch feat/shorts-doctor-card`). Без Omni: «без сценок» — сборка чатом.

1. **Без сценок по коду** — ролик стенда со сценками в `pending_review` (как в учении 2а: `SELECT … WHERE format = 'skit' AND status = 'pending_review'`), записать `writer_rounds`, `omniSeconds`, затем (только стенд!):

```sql
UPDATE short_video
   SET status = 'failed', failed_from = 'animating', failed_code = 'omni_budget', attempts = 0, lease_until = NULL,
       last_error = 'оживление: учение — на пересъёмку нет секунд', failure_notified = false, auto_recoveries = 0
 WHERE id = '<id>' AND status = 'pending_review';
```

Ожидается в течение пары минут (крон работы — раз в минуту): сообщения о сбое в личке стенда нет; ролик — `writing`, `format = 'chat'`, `auto_recoveries = 1`, `recoveries` — одна запись `no_skits`; дальше `render_queued` → `pending_review`; в подписи на проверку — «Сам восстанавливался: без сценок (omni_budget)» и «Собран без сценок: оживление: учение — …»; `omniSeconds` прежний; в карточке админки стенда — история и «без сценок — сам».

2. **Позже** — другой ролик стенда в `pending_review` (или тот же после шага 1):

```sql
UPDATE short_video
   SET status = 'failed', failed_from = 'rendering', failed_code = 'tts', attempts = 1, lease_until = NULL,
       last_error = 'сборка: учение — SpeechKit не ответил', failure_notified = false, auto_recoveries = 0
 WHERE id = '<id>' AND status = 'pending_review';
```

Ожидается: сообщения нет; ролик — `render_queued`, `lease_until` ≈ сейчас + 30 мин, запись `later` с `delayMin = 30`. Ждать не нужно: вернуть `lease_until = now()` и убедиться, что сборка забрала ролик и он снова в `pending_review`.

3. **Никак** — ролик стенда в `pending_review` (можно тот же; `auto_recoveries = 0` обязателен, иначе строка «Сам пробовал» появится по прошлым учениям):

```sql
UPDATE short_video
   SET status = 'failed', failed_from = 'directing', failed_code = 'no_assistant', attempts = 1, lease_until = NULL,
       last_error = 'режиссёр: учение — ассистента нет среди активных', failure_notified = false, auto_recoveries = 0
 WHERE id = '<id>' AND status = 'pending_review';
```

Ожидается: сообщение о сбое в личке стенда, без строки «Сам пробовал»; ролик остаётся `failed`. Вернуть ролик кнопкой «Повторить» (или «Отклонить») в админке стенда.

Итог учений — в заметку памяти: что проверено, что нет (выключатель, пределы круга вживую — только тестами).

- [ ] **Step 3 (контролёр, OK владельца): слияние и выкат** — 2б сливается после 2а. Бэк: `merge --no-ff feat/shorts-self-healing-2b` в свежий `origin/main`; кабинет: `merge --no-ff feat/shorts-doctor-card` в свежий `origin/main` кабинета. `deploy.sh` с ноды из свежих клонов обоих `main`, `SKIP_BOTS=1` (фронт меняется — без `BACK_ONLY`). Перед запуском (только чтение): на проде нет ролика в `capturing`, `animating`, `rendering`; не окно ночного бэкапа (pg_dump в 03:00 UTC держит замок на чтение `short_video` всё время дампа — первый накат 005 его не дождётся); нет транзакций старше 5 с:

```sql
SELECT pid, application_name, state, now() - xact_start AS age, left(query, 80)
  FROM pg_stat_activity WHERE xact_start < now() - interval '5 seconds' AND pid <> pg_backend_pid();
```

Сразу после — колонки 005 на месте (`SELECT column_name FROM information_schema.columns WHERE table_name = 'short_video' AND column_name IN ('failed_code','auto_recoveries','recoveries','omni_base')` — четыре строки; `deploy.sh` после рестарта ждёт только `/webhook/agents`, smoke ролики не трогает — сорванный накат выкат не покажет), `linkeon-studio` перезапущена, хеш бандла кабинета — новый. Колонок нет — первый накат не дождался замка (`lock_timeout` 5 с, в журнале API `shorts migration 005_doctor.sql failed … lock timeout`): без них встаёт весь конвейер — первые запросы `claimStage` (режиссёр, сценарист) и `claimJob` студии пишут `failed_code` и падают на каждом тике; падают и разбор упавших, список «Ролики», «Повторить» и `failJob`. Порядок, каждое действие на проде — с OK владельца: `pm2 stop linkeon-studio` → блокирующая сессия в `pg_stat_activity` → рестарт API без живых ходов → колонки появились → `pm2 start linkeon-studio`.

- [ ] **Step 4: Заметка памяти и рабочее состояние** — очередь 2б на проде (sha бэка и кабинета), итог учений, выключатель `SHORTS_AUTO_HEAL`.
