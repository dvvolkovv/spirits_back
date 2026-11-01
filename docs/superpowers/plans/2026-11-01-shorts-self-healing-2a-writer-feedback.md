# Самовосстановление роликов, очередь 2а — «два промаха → сценарист»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** сценку, которую Omni не может снять с этими репликами (два клипа с одним текстом сценки не прошли сверку речи, или фильтр Google трижды отказал), студия не роняет в «Упал», а возвращает сценаристу с разбором — тот переписывает реплики и действие только этой сценки, кадр и вторая сценка остаются.

**Architecture:** студия (`studio/`) после второго клипа с одним текстом сценки, не прошедшего сверку речи (или трёх отказов фильтра), бросает `SkitFeedbackError` с разбором (`SkitFeedback`: сценка, код, номера реплик, услышанное, причина) и пояснением для сценариста; места на пересъёмку нет — `omni_budget`, как раньше. `failJob` пишет ролик в `writing` с `writer_feedback` (текст) и новой колонкой `skit_feedback` (разбор), пока кругов сценариста меньше `MAX_WRITER_ROUNDS`. Сценарист (`shorts-writer.service.ts`) при `skitFeedback` берёт из ответа только `lines` и `action` названной сценки, остальное — из принятой (отпечаток кадра не меняется). Спека: `docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md`, «Очередь 2 → Студия: два промаха — сценаристу», «Сценарист по отзыву студии о сценке», «Данные». Доктор упавших — план 2б.

**Tech Stack:** NestJS 10 + Postgres (jest, ts-jest `isolatedModules`, `strictNullChecks: false`); студия — TypeScript ESM, `tsx --test`, ffmpeg в тестах оживления; прогоны — на тестовой ноде через `studio/scripts/node-run.sh`.

---

## Общие правила

- **Дерево:** `~/Downloads/spirits_back/.worktrees/shorts-self-healing`, ветка `feat/shorts-self-healing-2` (от `origin/main` `504278b5`). Перед коммитом — `git branch --show-current`.
- **Тесты — только на ноде.** Из корня дерева:
  - студия: `studio/scripts/node-run.sh "<команда>"` (выполняется в `studio/`);
  - бэкенд: `NODE_RUN_DIR=. studio/scripts/node-run.sh "<команда>"` (в корне бэкенда).
  Bash timeout 600000. Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит; **незакоммиченное на ноду не уезжает — коммитить перед каждым прогоном** (красный тест — с «(красный)» в теме). Коды выхода: 75 — воркдерево занято (повторить через 2 минуты), 255 — сбой ssh (повторить через 1–2 минуты), 3 — дерево не встало на коммит (сообщить контролёру). `Cannot find module` — добавить `npm ci && ` перед командой (студия) или `npm ci --no-audit --no-fund && ` (бэкенд).
- Сводка node:test по ssh приходит в формате tap: `# tests` / `# pass` / `# fail` вместо `ℹ …`; у jest — строки `Tests:`.
- Импорты в студии — **без расширений**.
- `git add` — только поимённо. В `main` не пушить, не сливать, не выкатывать — это задача 7, её ведёт контролёр с OK владельца. Каждый коммит заканчивается `-m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"`.
- Репозиторий публичный — в тестах только выдуманные значения.
- Стиль кода и комментариев — как в окружающем коде (комментарии по-русски). Блоки «заменить X на Y» — X ищется дословно; не нашёлся ровно таким — остановиться и спросить, не угадывать.

---

### Task 1: Колонка `skit_feedback` — миграция 004

**Files:**
- Create: `src/shorts/migrations/004_skit_feedback.sql`
- Modify: `src/shorts/shorts-schema.service.ts` (`onModuleInit`)
- Modify: `src/shorts/shorts.controller.ts` (`LIST_COLUMNS`)
- Modify: `src/shorts/shorts.integration.spec.ts` (`MIGRATIONS` — живой прогон катит миграции своим списком, не сервисом)
- Test: `src/shorts/shorts-schema.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/shorts/shorts-schema.spec.ts` сразу после функции `appliedYoutubeSql` добавить:

```ts
async function appliedSkitFeedbackSql(): Promise<string> {
  const text = (await applied()).find((q) => q.includes("hashtext('shorts/004')"));
  if (!text) throw new Error('миграция 004 не применена');
  return text;
}
```

В `describe('ShortsSchemaService', …)` сразу после теста `it('катит 003 после 002', …)` добавить:

```ts
  it('катит 004 после 003', async () => {
    const qs = await applied();
    const third = qs.findIndex((q) => q.includes("hashtext('shorts/003')"));
    const fourth = qs.findIndex((q) => q.includes("hashtext('shorts/004')"));
    expect(third).toBeGreaterThanOrEqual(0);
    expect(fourth).toBeGreaterThan(third);
  });
```

В конец файла:

```ts
describe('текст 004_skit_feedback.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedSkitFeedbackSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql.endsWith('$shorts$;')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/004'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('колонка skit_feedback jsonb — под проверкой information_schema, без ADD COLUMN IF NOT EXISTS', async () => {
    const sql = await appliedSkitFeedbackSql();
    expect((sql.match(/ALTER TABLE/g) ?? []).length).toBe(1);
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns\s+WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'skit_feedback'\) THEN\s+ALTER TABLE short_video ADD COLUMN skit_feedback jsonb;/,
    );
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS/);
  });
});
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-schema.spec.ts
git commit -m "test(shorts): миграция 004 — колонка skit_feedback (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts 2>&1 | tail -15"
```

Ожидается: падают три новых теста («миграция 004 не применена»).

- [ ] **Step 3: Миграция**

`src/shorts/migrations/004_skit_feedback.sql` — целиком:

```sql
-- 004_skit_feedback.sql — отзыв студии о сценке, которую Omni не снять с этими репликами.
--
-- Спека: docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md, «Очередь 2 → Данные».
-- План: docs/superpowers/plans/2026-11-01-shorts-self-healing-2a-writer-feedback.md, задача 1.
--
-- КАК КАТИТСЯ — как 001–003: ShortsSchemaService выполняет файл при КАЖДОМ
-- старте API, весь файл — один DO-блок (одна транзакция) под advisory-локом,
-- чужих замков ждём не дольше 5 с. Колонка — под проверкой information_schema:
-- ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT EXISTS и на каждом старте
-- ждал бы открытые записи (шапка 001).
--
-- ОТКАТ: сначала весь код очереди 2а — API и студия (linkeon-studio перезапущена на
-- старом коде): LIST_COLUMNS, сценарист, «Повторить» и failJob студии читают и пишут
-- колонку. Колонку можно и оставить — старый код её не видит. Снять: убрать 004 из
-- ShortsSchemaService, затем
--   SET lock_timeout = '5s'; ALTER TABLE short_video DROP COLUMN skit_feedback;
DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/004'));
    PERFORM set_config('lock_timeout', '5s', true);
    -- Разбор отзыва студии о сценке (SkitFeedback студии, ShortSkitFeedback API): какая
    -- сценка, код, непрозвучавшие реплики, услышанное, причина отказа фильтра. Пишет студия
    -- вместе с writer_feedback (failJob), стирают сценарист, записав сценарий, новая сцена
    -- и «Повторить» с замечанием.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'skit_feedback') THEN
        ALTER TABLE short_video ADD COLUMN skit_feedback jsonb;
    END IF;
END
$shorts$;
```

- [ ] **Step 4: Накат при старте и колонка в списке**

В `src/shorts/shorts-schema.service.ts` заменить

```ts
  /** По порядку: 002 и 003 правят таблицы, которые создаёт 001. */
  async onModuleInit() {
    await this.applyMigration('001_shorts.sql');
    await this.applyMigration('002_skits.sql');
    await this.applyMigration('003_youtube.sql');
  }
```

на

```ts
  /** По порядку: 002–004 правят таблицы, которые создаёт 001. */
  async onModuleInit() {
    await this.applyMigration('001_shorts.sql');
    await this.applyMigration('002_skits.sql');
    await this.applyMigration('003_youtube.sql');
    await this.applyMigration('004_skit_feedback.sql');
  }
```

В `src/shorts/shorts.controller.ts`, в `LIST_COLUMNS`, заменить `'slot_at', 'approved_at', 'owner_note', 'writer_feedback', 'writer_rounds', 'review_chat_id',` на `'slot_at', 'approved_at', 'owner_note', 'writer_feedback', 'skit_feedback', 'writer_rounds', 'review_chat_id',` (интеграционный тест сверяет `LIST_COLUMNS` с колонками таблицы — забытая колонка его роняет).

В `src/shorts/shorts.integration.spec.ts` заменить `const MIGRATIONS = ['001_shorts.sql', '002_skits.sql', '003_youtube.sql'].map(` на `const MIGRATIONS = ['001_shorts.sql', '002_skits.sql', '003_youtube.sql', '004_skit_feedback.sql'].map(` — живая база теста катит миграции этим списком, а не `ShortsSchemaService` (при исполнении 01.11 это всплыло на прогоне: без 004 падали `LIST_COLUMNS ∪ тяжёлые поля` и оба `list:`).

- [ ] **Step 5: Закоммитить и прогнать**

```bash
git add src/shorts/migrations/004_skit_feedback.sql src/shorts/shorts-schema.service.ts src/shorts/shorts.controller.ts src/shorts/shorts.integration.spec.ts
git commit -m "feat(shorts): миграция 004 — skit_feedback, отзыв студии о сценке" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts 2>&1 | tail -6; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '^Tests:'"
```

Ожидается: оба `Tests:` без `failed`; в интеграционном — тест «LIST_COLUMNS ∪ тяжёлые поля — ровно все колонки short_video» зелёный (миграция 004 накатана на `shorts_it` списком `MIGRATIONS`).

---

### Task 2: Тип `ShortSkitFeedback` и поле ролика

**Files:**
- Modify: `src/shorts/shorts.types.ts`
- Test: `src/shorts/shorts.types.spec.ts`, `src/shorts/shorts.integration.spec.ts` (фикстура «тонкого SELECT»)

- [ ] **Step 1: Написать падающий тест**

В `src/shorts/shorts.types.spec.ts`, в `describe('rowToShort', …)`, после теста `it('формат: skit — только явно; …', …)` добавить:

```ts
  it('отзыв студии о сценке — как в базе; нет — null', () => {
    const feedback = { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard: 'это только символика', reason: null };
    expect(rowToShort({ skit_feedback: feedback }).skitFeedback).toEqual(feedback);
    expect(rowToShort({}).skitFeedback).toBeNull();
  });
```

В `src/shorts/shorts.integration.spec.ts`, в фикстуре теста про тонкий SELECT списка (вставка с `owner_note: 'замечание-тест', writer_feedback: 'отзыв-тест', writer_rounds: 3,`), заменить эту строку на

```ts
      owner_note: 'замечание-тест', writer_feedback: 'отзыв-тест', writer_rounds: 3,
      skit_feedback: { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard: 'услышано-тест', reason: null },
```

— правило теста: каждое лёгкое поле не NULL и не умолчание `rowToShort`, иначе тонкий SELECT без колонки прошёл бы незамеченным.

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts.types.spec.ts src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): ролик несёт отзыв студии о сценке (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts 2>&1 | tail -12"
```

Ожидается: падает новый тест (`undefined` вместо отзыва).

- [ ] **Step 3: Тип и поле**

В `src/shorts/shorts.types.ts` сразу перед JSDoc-комментарием `ShortAnimation` (блок «Итог задания animate (зеркало ShortAnimation в studio/src/types.ts): …» над `export interface ShortAnimation {`) вставить — не между этим комментарием и интерфейсом:

```ts
/**
 * Отзыв студии о сценке, которую Omni не снять с этими репликами (skit_feedback):
 * два клипа с одним текстом сценки не прошли сверку речи или фильтр Google трижды
 * отказал. Сценарист переписывает реплики и действие только этой сценки. Зеркало
 * SkitFeedback студии (studio/src/types.ts), пояснение для сценариста — в writer_feedback.
 */
export interface ShortSkitFeedback {
  kind: SkitKind;
  code: 'speech_mismatch' | 'omni_rejected';
  /** Номера реплик (с 1), которых не услышали в последнем клипе, — у speech_mismatch; пусто, если речь не сошлась по доле слов, а не по репликам. */
  lines: number[];
  /** Что распознал SpeechKit в последнем клипе — у speech_mismatch. */
  heard: string | null;
  /** Причина отказа фильтра Google — у omni_rejected. */
  reason: string | null;
}

```

В `interface ShortVideo` заменить строку

```ts
  writerFeedback: string | null;
```

на

```ts
  writerFeedback: string | null;
  /** Отзыв студии о сценке — какую переписать; пояснение — в writerFeedback. */
  skitFeedback: ShortSkitFeedback | null;
```

В `rowToShort` заменить строку

```ts
    writerFeedback: row.writer_feedback ?? null,
```

на

```ts
    writerFeedback: row.writer_feedback ?? null,
    skitFeedback: row.skit_feedback ?? null,
```

В шапке файла заменить ` * Поля jsonb (`scene`, `capture`, `script`, `animation`) пишут две стороны:` на ` * Поля jsonb (`scene`, `capture`, `script`, `animation`, `skit_feedback`) пишут две стороны:` и ` * API — сцену и сценарий, студия (`studio/`) — съёмку и оживление. Их форма —` на ` * API — сцену и сценарий, студия (`studio/`) — съёмку, оживление и отзыв о сценке. Их форма —`.

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/shorts.types.ts
git commit -m "feat(shorts): ShortSkitFeedback — отзыв студии о сценке в ролике" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts src/shorts/shorts.controller.spec.ts 2>&1 | grep -E '^Tests:'; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '^Tests:'"
```

Ожидается: обе строки `Tests:` без `failed`.

---

### Task 3: Сценарист переписывает названную сценку

**Files:**
- Modify: `src/shorts/short-prompts.ts` (`WRITER_SKIT_SYSTEM`)
- Modify: `src/shorts/shorts-writer.service.ts`
- Test: `src/shorts/shorts-writer.service.spec.ts`, `src/shorts/short-prompts.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/shorts/shorts-writer.service.spec.ts`, в `describe('ShortsWriterService.write — ролик со сценками', …)`, сразу перед последним тестом (`it('у ролика со сценками нет сценки 1 — StageFatalError: нужен режиссёр', …)`) добавить:

```ts
  const STUDIO_ABOUT_PUNCHLINE = {
    writer_feedback: 'сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи; в последнем не услышаны: реплика 2 (galina) «Га-га… ладно.», услышано: «нормальный износ не повреждение залог верните». Перепиши реплики и действие этой сценки.',
    skit_feedback: { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard: 'нормальный износ не повреждение залог верните', reason: null },
  };

  it('отзыв студии о развязке: из ответа — только реплики и действие развязки; место, начало, герои — принятые, кадр не перерисуется, конфликт не переснимется', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const fresh = {
      ...PUNCHLINE,
      setting: 'a completely different kitchen',
      opening: 'Everyone sits at a table.',
      action: 'The capybara speaks calmly, the goose nods and puts the keys on the table.',
      lines: [PUNCHLINE.lines[0], { hero: 'galina', text: 'Ладно, убедил. Забирай залог.' }],
    };
    const { svc, pg, relay } = setup([{ ...SKIT_GOOD, punchline: fresh }]);
    await svc.write(skitVideo({ ...STUDIO_ABOUT_PUNCHLINE, script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
    expect(relay.ask.mock.calls[0][1]).toContain('Студия: сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи');
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/skit_feedback = NULL/);
    const script = JSON.parse(params[1]);
    expect(script.skits.punchline.skit).toEqual({ ...PUNCHLINE, action: fresh.action, lines: fresh.lines });
    expect(script.skits.punchline.keyframeFingerprint).toBe(accepted.punchline.keyframeFingerprint);
    expect(script.skits.punchline.fingerprint).not.toBe(accepted.punchline.fingerprint);
    expect(script.skits.conflict.fingerprint).toBe(accepted.conflict.fingerprint);
  });

  it('отзыв студии о конфликте: переписываются реплики и действие конфликта; кадры обеих сценок и развязка — прежние', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const fresh = { ...CONFLICT, setting: 'a garage', action: 'The goose taps the scuff and frowns.', lines: [{ hero: 'galina', text: 'Обои испорчены! Залог не верну!' }, CONFLICT.lines[1]] };
    const { svc, pg } = setup([{ ...SKIT_GOOD, conflict: fresh }]);
    await svc.write(skitVideo({
      writer_feedback: 'сценка 1 (конфликт): фильтр Google 3 раза не пропустил клип (omni: отказ фильтра). Перепиши реплики и действие этой сценки.',
      skit_feedback: { kind: 'conflict', code: 'omni_rejected', lines: [], heard: null, reason: 'omni: отказ фильтра' },
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.conflict.skit).toEqual({ ...CONFLICT, action: fresh.action, lines: fresh.lines });
    expect(script.skits.conflict.keyframeFingerprint).toBe(accepted.conflict.keyframeFingerprint);
    expect(script.skits.conflict.fingerprint).not.toBe(accepted.conflict.fingerprint);
    expect(script.skits.punchline.keyframeFingerprint).toBe(accepted.punchline.keyframeFingerprint);
    expect(script.skits.punchline.fingerprint).toBe(accepted.punchline.fingerprint);
  });

  it('отзыв студии о сценке, а сценарист её не переписал (нет в ответе или те же реплики и действие) — переписка с нарушением', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const { punchline, ...noPunchline } = SKIT_GOOD;
    const fixed = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [PUNCHLINE.lines[0], { hero: 'galina', text: 'Ладно, убедил.' }] } };
    const { svc, pg, relay } = setup([noPunchline, { ...SKIT_GOOD, punchline: PUNCHLINE }, fixed]);
    await svc.write(skitVideo({ ...STUDIO_ABOUT_PUNCHLINE, script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
    expect(relay.ask).toHaveBeenCalledTimes(3);
    expect(relay.ask.mock.calls[1][1]).toContain('сценка 2 (развязка): отзыв студии — перепиши реплики и действие этой сценки (в ответе её нет)');
    expect(relay.ask.mock.calls[2][1]).toContain('сценка 2 (развязка): отзыв студии — перепиши реплики и действие этой сценки (они те же, что Omni не озвучил)');
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.punchline.skit.lines[1].text).toBe('Ладно, убедил.');
  });

```

В тесте `it('просит переснять — ролик к режиссёру с причиной в замечаниях', …)` (в первом `describe`) после строки `expect(sql).toMatch(/writer_feedback = NULL/);` добавить:

```ts
    expect(sql).toMatch(/skit_feedback = NULL/);
```

В `src/shorts/short-prompts.spec.ts`, в тесте `it('сценарист сценок: надпись до 6 слов, 1–2 реплики, развязка с box, конфликт — только по замечанию, правила 1–15', …)`, заменить строку списка

```ts
    for (const s of ['до 6 слов', '1–2 реплики', 'с его номером в box', 'conflict — только если замечания или нарушения', 'и для реплик героев', 'принятая сценка 2', 'Отзыв студии — о длине озвучки', 'Замечание, которое принятая сценка 2 уже учла, — не повод']) {
```

на

```ts
    for (const s of ['до 6 слов', '1–2 реплики', 'с его номером в box', 'conflict — только если замечания, нарушения или отзыв студии касаются сценки 1', 'и для реплик героев', 'принятая сценка 2', 'Отзыв студии о длине озвучки — не повод трогать сценки', 'Отзыв студии о сценке', 'Место, начало, героев и роли оставь прежними', 'Замечание, которое принятая сценка 2 уже учла, — не повод']) {
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-writer.service.spec.ts src/shorts/short-prompts.spec.ts
git commit -m "test(shorts): сценарист по отзыву студии переписывает названную сценку (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts src/shorts/short-prompts.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: падают пять тестов — три новых сценариста, «просит переснять…» (нет `skit_feedback = NULL`) и тест промпта сценок (новых строк ещё нет).

- [ ] **Step 3: Промпт**

В `src/shorts/short-prompts.ts`, в `WRITER_SKIT_SYSTEM`, заменить две строки

```ts
  '  Если в сообщении есть принятая сценка 2, пиши punchline, только если её касаются замечания или нарушения либо ты переписал конфликт: её клип, возможно, уже снят за деньги. Замечание, которое принятая сценка 2 уже учла, — не повод её переписывать. Отзыв студии — о длине озвучки: из-за него сценки не трогай.',
  '- conflict — только если замечания или нарушения касаются сценки 1; иначе поле не пиши. Замечание, которое сценка 1 уже учла, — не повод её переписывать.',
```

на

```ts
  '  Если в сообщении есть принятая сценка 2, пиши punchline, только если её касаются замечания, нарушения или отзыв студии о сценке либо ты переписал конфликт: её клип, возможно, уже снят за деньги. Замечание, которое принятая сценка 2 уже учла, — не повод её переписывать. Отзыв студии о длине озвучки — не повод трогать сценки.',
  '- conflict — только если замечания, нарушения или отзыв студии касаются сценки 1; иначе поле не пиши. Замечание, которое сценка 1 уже учла, — не повод её переписывать.',
  '- Отзыв студии о сценке («Студия: сценка 1 …» или «Студия: сценка 2 …»): Omni не озвучил её реплики или фильтр Google не пропустил клип. Перепиши реплики и действие ЭТОЙ сценки (поле conflict или punchline) — короче и проще, обычными словами; пока герой говорит, ничто не закрывает ему рот. Место, начало, героев и роли оставь прежними: их всё равно возьмут из принятой сценки. У развязки утверждение по существу — по-прежнему в реплике с box.',
```

- [ ] **Step 4: Сценарист**

В `src/shorts/shorts-writer.service.ts`:

1. Импорты — заменить строку

```ts
import { WriterCaptions, checkScriptRules, checkSkitRules } from './short-rules';
```

на

```ts
import { SKIT_LABELS, WriterCaptions, checkScriptRules, checkSkitRules } from './short-rules';
```

и строку

```ts
import { Skit, SkitKind, SkitPlan, planSkits } from './short-skit-prompts';
```

на

```ts
import { SKIT_KINDS, Skit, SkitKind, SkitPlan, planSkits } from './short-skit-prompts';
```

2. Сразу после функции `recapturesInRow` (перед `@Injectable()`) вставить:

```ts
/**
 * Принятые сценки с новыми репликами и действием одной из них — по отзыву студии.
 * Место, начало, герои и роли — принятые: отпечаток кадра сценки не меняется, кадр
 * не перерисуется. В ответе сценки нет — принятые как есть (нарушение назовёт
 * studioRewriteViolation).
 */
function withNewLines(accepted: Record<SkitKind, Skit>, kind: SkitKind, fresh: Skit | null): Record<SkitKind, Skit> {
  if (!fresh) return accepted;
  return { ...accepted, [kind]: { ...accepted[kind], action: fresh.action, lines: fresh.lines } };
}

/** Сценка по отзыву студии не переписана: её нет в ответе или реплики и действие те же — Omni не снимет и их. */
function studioRewriteViolation(kind: SkitKind, accepted: Skit, fresh: Skit | null): string | null {
  const same = (s: Skit) => JSON.stringify([s.action, s.lines.map((l) => [l.hero, l.text])]);
  if (fresh && same(fresh) !== same(accepted)) return null;
  return `${SKIT_LABELS[kind]}: отзыв студии — перепиши реплики и действие этой сценки (${fresh ? 'они те же, что Omni не озвучил' : 'в ответе её нет'})`;
}

```

3. Заменить строки

```ts
    const keepSkits = skitFormat && !!v.writerFeedback && !!v.script?.skits?.conflict && !!acceptedPunchline;
```

на

```ts
    const keepSkits = skitFormat && !!v.writerFeedback && !v.skitFeedback && !!v.script?.skits?.conflict && !!acceptedPunchline;
    // Отзыв студии о сценке: Omni её не снять с этими репликами. Переписываются только
    // реплики и действие названной сценки, база — принятые сценки, а не варианты кругов
    // переписки: сравнивать «то же или нет» надо с тем, что Omni не озвучил.
    // Вид сценки из базы проверяется: испорченное значение — обычная переписка, а не TypeError.
    const fixKind: SkitKind | null =
      skitFormat && v.skitFeedback && SKIT_KINDS.includes(v.skitFeedback.kind) && conflict && acceptedPunchline ? v.skitFeedback.kind : null;
    const fixBase: Record<SkitKind, Skit> | null = fixKind ? { conflict: conflict!, punchline: acceptedPunchline! } : null;
```

4. Заменить вычисление сценок

```ts
      const skits = !skitFormat
        ? null
        : keepSkits
          ? { conflict, punchline: acceptedPunchline }
          : { conflict: reply.skits.conflict ?? conflict, punchline: reply.skits.punchline ?? acceptedPunchline };
```

на

```ts
      const skits = !skitFormat
        ? null
        : fixKind
          ? withNewLines(fixBase!, fixKind, reply.skits[fixKind])
          : keepSkits
            ? { conflict, punchline: acceptedPunchline }
            : { conflict: reply.skits.conflict ?? conflict, punchline: reply.skits.punchline ?? acceptedPunchline };
```

5. Сразу после строки `if (planError) violations.push(planError);` вставить:

```ts
      if (fixKind) {
        const notRewritten = studioRewriteViolation(fixKind, fixBase![fixKind], reply.skits[fixKind]);
        if (notRewritten) violations.push(notRewritten);
      }
```

6. В ветке нарушений заменить

```ts
        if (skits) {
          conflict = skits.conflict;
          rejectedPunchline = reply.skits.punchline;
        }
```

на

```ts
        // По отзыву студии база — принятые сценки: следующий круг снова видит то, что Omni не озвучил.
        if (skits && !fixKind) {
          conflict = skits.conflict;
          rejectedPunchline = reply.skits.punchline;
        }
```

7. В записи сценария заменить

```ts
                writer_feedback = NULL, writer_rounds = writer_rounds + 1,
```

на

```ts
                writer_feedback = NULL, skit_feedback = NULL, writer_rounds = writer_rounds + 1,
```

8. В `backToDirector` заменить

```ts
          SET status = 'directing', owner_note = $2, writer_feedback = NULL, writer_rounds = 0,
```

на

```ts
          SET status = 'directing', owner_note = $2, writer_feedback = NULL, skit_feedback = NULL, writer_rounds = 0,
```

и в его описании фразу `отзыв студии о прошлой озвучке и счёт её` заменить на `отзыв студии о прошлой озвучке и сценке и счёт их`.

9. В описании `write` (комментарий над методом) после абзаца про сценки дописать строку:

```ts
   * Отзыв студии о сценке (skitFeedback) — переписываются реплики и действие только
   * названной сценки (withNewLines), остальное — принятое.
```

- [ ] **Step 5: Закоммитить и прогнать**

```bash
git add src/shorts/short-prompts.ts src/shorts/shorts-writer.service.ts
git commit -m "feat(shorts): сценарист по отзыву студии переписывает реплики и действие названной сценки" -m "Место, начало и герои — из принятой сценки: кадр не перерисуется, вторая сценка не переснимется. skit_feedback стирается вместе с writer_feedback." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts src/shorts/short-prompts.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `Tests:` без `failed`.

- [ ] **Step 6: Второй круг по ревью качества (01.11) — тесты**

Ревью нашло: на кругах переписки по отзыву модель не видела свой отвергнутый вариант сценки (только нарушения); в формат «Только чат» уходил отзыв о сценке («перепиши реплики… короче» — урезал бы озвучку; в плане 2б это штатный путь «без сценок»); «тот же текст» сравнивался по сырым строкам, а клип — по отпечатку (точка в конце действия его не меняет, лишний клип стоит денег); тесты не закрепляли, что вторая сценка из ответа отбрасывается, что состав — из принятой, что база не сдвигается, что испорченный вид — обычная переписка.

В `src/shorts/shorts-writer.service.spec.ts`:
- в тесте «отзыв студии о развязке…» ответ несёт и переписанный конфликт (`otherConflict` — должен быть отброшен), у `fresh` другой состав (`cast: [{ hero: 'galina', role: 'соседка' }, { hero: 'kesha', role: 'жилец' }]` — должен остаться принятый), и проверяется метка `'Сценка 2 (развязка), которую Omni не снял, — перепиши её реплики и действие:\n<<<СЦЕНКА 2\n'`;
- в тесте «отзыв студии о конфликте…» ответ несёт переписанную развязку (`action: 'The goose faints theatrically onto the suitcase.'` — отбрасывается) и проверяется метка `'Сценка 1 (конфликт) — открывает ролик; её Omni не снял — перепиши реплики и действие:'`;
- тест «…не переписал (нет в ответе или те же реплики и действие)…» заменён двумя: «прошлый вариант — перед моделью на следующем круге, база не сдвигается; тот же клип (точка в конце действия не в счёт) — нарушение» (ответы: развязка без `box` → нарушение правила 18; развязка с действием без точки → «клип вышел бы тем же, что студия не смогла снять»; исправленная → запись; во втором сообщении — `'Твой прошлый вариант сценки 2 — исправь по нарушениям:\n<<<ПРОШЛАЯ СЦЕНКА 2\n'` с «Это износ.» и метка «которую Omni не снял» с «Га-га… ладно.») и «в ответе её нет — переписка с нарушением»;
- новый тест «отзыв о сценке с испорченным видом (`kind: 'bogus'`) — обычная переписка, а не падение»;
- в первый `describe` — тест «формат «Только чат» после отзыва о сценке: отзыв студии о сценке сценаристу чата не уходит» (в сообщении нет `Студия:`).

В `src/shorts/short-prompts.spec.ts` в список строк теста сценариста сценок — `'Вторую сценку не пиши — останется принятая'` и `'в конце Кеша по-прежнему обещает спросить ассистента'`.

- [ ] **Step 7: Второй круг по ревью качества — код**

`src/shorts/short-prompts.ts`: `WriterInput.skit.fix?: { kind: SkitKind; rejected: Skit | null }`; в `buildWriterMessage` при `fix` — метка у сценки, которую Omni не снял (у конфликта — «; её Omni не снял — перепиши реплики и действие», у развязки — «Сценка 2 (развязка), которую Omni не снял, — перепиши её реплики и действие:» вместо «Принятая сценка 2…»), и блок «Твой прошлый вариант сценки N — исправь по нарушениям:» (`ПРОШЛАЯ СЦЕНКА N`) при `fix.rejected`; в `WRITER_SKIT_SYSTEM` строка про отзыв о сценке кончается «…У развязки утверждение по существу — по-прежнему в реплике с box, у конфликта в конце Кеша по-прежнему обещает спросить ассистента. Вторую сценку не пиши — останется принятая.».

`src/shorts/shorts-writer.service.ts`: `studioRewriteViolation(kind, fresh, sameClip)` — нарушение, если сценки нет в ответе или `planned[fixKind].fingerprint` совпал с отпечатком принятой (`v.script.skits[fixKind].fingerprint`), текст «(клип вышел бы тем же, что студия не смогла снять)»; `rejectedFix` — слитая сценка круга с нарушениями, если в ответе она была; `buildWriterMessage(… writerFeedback: !skitFormat && v.skitFeedback ? null : v.writerFeedback, skit: { …, fix: { kind: fixKind, rejected: rejectedFix } })`; строка журнала при `fixKind` и `warn`, когда отзыв о сценке есть, а применить его нельзя.

Коммиты: красный — оба spec-файла; зелёный — оба файла кода. Ожидается: `Tests:` без `failed`, `tsc -p tsconfig.build.json` пусто.

- [ ] **Step 8: Третий круг по повторному ревью (01.11) — закрепления и две строки кода**

Тесты: в «прошлый вариант — перед моделью…» — `expect(second).not.toContain('Прошлый вариант сценки 2:')`; в «в ответе её нет…» — `not.toContain('Твой прошлый вариант')`; новый тест «отзыв студии о конфликте, круг с нарушением: исходный конфликт — под «её Omni не снял», отвергнутый — «твоим прошлым вариантом»» (1-й ответ — реплика Бориса, которого нет в составе; во 2-м сообщении под меткой «её Omni не снял» — исходное «Обои потёрли! Залог мой!», блок «Твой прошлый вариант сценки 1 — исправь по нарушениям:» и нарушение «говорит «boris», а его нет в составе»; запись — исправленный конфликт). Код: `fixKind` — только при `v.script?.skits?.[kind]` (сравнивать «тот же клип» не с чем — обычная переписка); в `WRITER_SKIT_SYSTEM` «либо ты переписал конфликт (кроме отзыва студии о сценке 1 — тогда развязку не пиши):».

---

### Task 4: Новая сцена и «Повторить» с замечанием стирают отзыв о сценке

**Files:**
- Modify: `src/shorts/shorts-director.service.ts`
- Modify: `src/shorts/shorts.controller.ts` (`retry`)
- Test: `src/shorts/shorts-director.service.spec.ts`, `src/shorts/shorts.controller.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/shorts/shorts-director.service.spec.ts`, в тесте `it('новая сцена — новый круг сценариста: …', …)`, после строки `expect(sql).toMatch(/writer_feedback = NULL/);` добавить:

```ts
    expect(sql).toMatch(/skit_feedback = NULL/);
```

В `src/shorts/shorts.controller.spec.ts`, в тесте `it('retry { from: directing, note } — с режиссёра, …', …)`, после строки `expect(String(upd[0])).toContain('writer_feedback = CASE WHEN $4::text IS NULL THEN writer_feedback ELSE NULL END');` добавить:

```ts
    expect(String(upd[0])).toContain('skit_feedback = CASE WHEN $4::text IS NULL THEN skit_feedback ELSE NULL END');
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts-director.service.spec.ts src/shorts/shorts.controller.spec.ts
git commit -m "test(shorts): новая сцена и замечание стирают отзыв о сценке (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-director.service.spec.ts src/shorts/shorts.controller.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: падают два теста.

- [ ] **Step 3: Код**

В `src/shorts/shorts-director.service.ts` заменить

```ts
              capture = NULL, script = NULL, captions = NULL, writer_feedback = NULL, writer_rounds = 0,
```

на

```ts
              capture = NULL, script = NULL, captions = NULL, writer_feedback = NULL, skit_feedback = NULL, writer_rounds = 0,
```

и в комментарии над записью фразу `отзыв студии о прошлой озвучке и счёт её переписок — тоже.` заменить на `отзыв студии о прошлой озвучке и сценке и счёт переписок — тоже.`

В `src/shorts/shorts.controller.ts`, в `retry`, заменить

```ts
                writer_feedback = CASE WHEN $4::text IS NULL THEN writer_feedback ELSE NULL END,
```

на

```ts
                writer_feedback = CASE WHEN $4::text IS NULL THEN writer_feedback ELSE NULL END,
                skit_feedback = CASE WHEN $4::text IS NULL THEN skit_feedback ELSE NULL END,
```

и в описании метода фразу `Замечание сбрасывает и отзыв студии о прошлой озвучке:` заменить на `Замечание сбрасывает и отзыв студии о прошлой озвучке и сценке:`.

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add src/shorts/shorts-director.service.ts src/shorts/shorts.controller.ts
git commit -m "feat(shorts): новая сцена и «Повторить» с замечанием стирают отзыв студии о сценке" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts 2>&1 | grep -E '^Tests:'"
```

Ожидается: `Tests:` без `failed`.

---

### Task 5: Студия — «два промаха → сценарист»

**Files:**
- Modify: `studio/src/types.ts` (тип `SkitFeedback`)
- Modify: `studio/src/errors.ts` (`SkitFeedbackError`)
- Modify: `studio/src/animate/run-animate.ts`
- Modify: `src/shorts/shorts.contract.spec.ts` (сторож контракта полей)
- Test: `studio/src/animate/run-animate.test.ts`

- [ ] **Step 1: Сторож контракта**

В `src/shorts/shorts.contract.spec.ts`, в `describe('контракт API и студии', …)`, после теста `it('сценки: студия и бэкенд объявляют одни и те же поля, …', …)` добавить:

```ts
  it('отзыв студии о сценке: SkitFeedback студии и ShortSkitFeedback API — одни и те же поля', () => {
    const types = studio('types.ts');
    const back = fs.readFileSync(path.join(__dirname, 'shorts.types.ts'), 'utf8');
    expect(fields(types, 'studio/src/types.ts', 'SkitFeedback')).toEqual(fields(back, 'shorts.types.ts', 'ShortSkitFeedback'));
  });
```

- [ ] **Step 2: Написать падающие тесты студии**

В `studio/src/animate/run-animate.test.ts` заменить строку импорта

```ts
import { StudioError } from '../errors';
```

на

```ts
import { SkitFeedbackError, StudioError } from '../errors';
```

Тест `'три несовпадения речи — сдаётся с причиной и сводкой попыток'` заменить целиком на:

```ts
test('два несовпадения речи на одном тексте — сценаристу, а не третий клип', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind) => (kind === 'conflict' ? 'совсем другое' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) =>
      e instanceof SkitFeedbackError &&
      e.feedback.kind === 'conflict' &&
      JSON.stringify(e.feedback.lines) === '[1,2]' &&
      /не услышаны реплики 1, 2/.test(e.message),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 24);
});
```

В конец файла:

```ts
test('два клипа с одним текстом не прошли сверку речи — сценаристу: отзыв с номером реплики и услышанным, третий клип не снимается', { timeout: 120_000 }, async () => {
  const env = setup();
  const heard = 'три года нормальный износ';
  const { deps, calls } = fakes(env, { heard: (kind) => (kind === 'punchline' ? heard : LINES[kind].join(' ')) });
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => {
    assert.ok(e instanceof SkitFeedbackError, String(e));
    assert.equal(e.code, 'speech_mismatch');
    assert.equal(e.retryable, false);
    assert.deepEqual(e.feedback, { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard, reason: null });
    assert.match(e.writerText, /^сценка 2 \(развязка\): 2 клипа с этими репликами не прошли сверку речи; в последнем не услышаны: реплика 2 \(kesha\) «Га-га… ладно\.», услышано: «три года нормальный износ»\./);
    assert.match(e.writerText, /место, начало и героев не меняй/);
    return true;
  });
  assert.equal(calls.start.filter((k) => k === 'punchline').length, 2);
  assert.equal(readAnim(env.runDir).omniSeconds, 24);
});

test('на пересъёмку переписанной сценки нет секунд — omni_budget, а не сценаристу', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind) => (kind === 'punchline' ? 'три года нормальный износ' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, { ...deps, maxOmniSeconds: 24 }),
    (e: unknown) => isErr('omni_budget', false)(e) && !(e instanceof SkitFeedbackError),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 24);
});

test('фильтр Google трижды отказал — сценаристу с причиной; секунды возвращены', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind) => {
      if (kind === 'punchline') throw new StudioError('omni_rejected', 'omni: отказ фильтра — violence', true);
    },
  });
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => {
    assert.ok(e instanceof SkitFeedbackError, String(e));
    assert.deepEqual(e.feedback, { kind: 'punchline', code: 'omni_rejected', lines: [], heard: null, reason: 'omni: отказ фильтра — violence' });
    assert.match(e.writerText, /^сценка 2 \(развязка\): фильтр Google 3 раза не пропустил клип \(omni: отказ фильтра — violence\)\./);
    return true;
  });
  assert.equal(calls.start.filter((k) => k === 'punchline').length, 3);
  assert.equal(readAnim(env.runDir).omniSeconds, 8);
});

test('обе сценки упали: намертво упавшая важнее отзыва сценаристу', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, {
    heard: (kind) => (kind === 'punchline' ? 'три года нормальный износ' : LINES[kind].join(' ')),
    start: (kind) => {
      if (kind === 'conflict') throw new StudioError('google_quota', 'omni: лимит Google исчерпан', false);
    },
  });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) => isErr('google_quota', false)(e) && !(e instanceof SkitFeedbackError) && /сценка 2 \(развязка\)/.test((e as Error).message),
  );
});
```

- [ ] **Step 3: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts.contract.spec.ts studio/src/animate/run-animate.test.ts
git commit -m "test(studio): два промаха речи и отказы фильтра — сценаристу (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Ожидается: файл не загружается — `SyntaxError: The requested module '../errors' does not provide an export named 'SkitFeedbackError'`.

- [ ] **Step 4: Тип отзыва**

В `studio/src/types.ts` сразу после строки `export const SKIT_KINDS: readonly SkitKind[] = ['conflict', 'punchline'];` добавить:

```ts

/**
 * Отзыв студии о сценке, которую Omni не снять с этими репликами (skit_feedback):
 * два клипа с одним текстом сценки не прошли сверку речи или фильтр Google трижды
 * отказал. Сценарист переписывает реплики и действие только этой сценки. Зеркало
 * ShortSkitFeedback бэкенда; пояснение для сценариста — в writer_feedback.
 */
export interface SkitFeedback {
  kind: SkitKind;
  code: 'speech_mismatch' | 'omni_rejected';
  /** Номера реплик (с 1), которых не услышали в последнем клипе, — у speech_mismatch; пусто, если речь не сошлась по доле слов, а не по репликам. */
  lines: number[];
  /** Что распознал SpeechKit в последнем клипе — у speech_mismatch. */
  heard: string | null;
  /** Причина отказа фильтра Google — у omni_rejected. */
  reason: string | null;
}
```

- [ ] **Step 5: Ошибка «к сценаристу»**

В `studio/src/errors.ts` первой строкой добавить импорт:

```ts
import type { SkitFeedback } from './types';
```

и после класса `StudioError` (после его закрывающей `}`) вставить:

```ts

/**
 * Сценку не снять с этими репликами: два клипа с одним текстом не прошли сверку
 * речи или фильтр Google трижды отказал. Без повтора: рабочий процесс (db.ts, failJob)
 * возвращает ролик сценаристу — пояснение `writerText` в writer_feedback, разбор
 * `feedback` в skit_feedback.
 */
export class SkitFeedbackError extends StudioError {
  readonly feedback: SkitFeedback;
  readonly writerText: string;

  constructor(feedback: SkitFeedback, writerText: string, message: string) {
    super(feedback.code, message, false);
    this.name = 'SkitFeedbackError';
    this.feedback = feedback;
    this.writerText = writerText;
  }
}
```

- [ ] **Step 6: Оживление**

В `studio/src/animate/run-animate.ts`:

1. Импорт ошибок — заменить

```ts
import { failText, StudioError, toStudioError, type StudioErrorCode } from '../errors';
```

на

```ts
import { failText, SkitFeedbackError, StudioError, toStudioError, type StudioErrorCode } from '../errors';
```

и импорт типов — добавить `type SkitFeedback` в список из `'../types'` (рядом с `type SkitClip`).

2. После строки `export const MAX_SKIT_ATTEMPTS = 3;` вставить:

```ts
/** Столько клипов одного текста сценки не прошли сверку речи — дальше клипы не снимаются, сценка уходит сценаристу. */
export const MAX_SPEECH_MISSES = 2;
```

3. После класса `StorageError` (строка `class StorageError extends StudioError {}`) вставить:

```ts

/** Клип забракован сверкой речи: что услышано и какие реплики молчат — для отзыва сценаристу. */
class SpeechMismatchError extends StudioError {
  readonly heard: string;
  readonly silentLines: number[];

  constructor(message: string, heard: string, silentLines: number[]) {
    super('speech_mismatch', message, true);
    this.heard = heard;
    this.silentLines = silentLines;
  }
}
```

4. В `finish` заменить начало `reject`

```ts
    const reject = async (code: RejectedMeta['code'], msg: string, speech?: Required<Pick<RejectedMeta, 'heard' | 'share'>>): Promise<never> => {
```

на

```ts
    const reject = async (code: RejectedMeta['code'], msg: string, speech?: { heard: string; share: number; silentLines: number[] }): Promise<never> => {
```

в нём же заменить

```ts
      writeRejectedMeta(abs(`${base}.json`), { code, matcher: MATCHER_VERSION, ...speech });
```

на

```ts
      writeRejectedMeta(abs(`${base}.json`), speech ? { code, matcher: MATCHER_VERSION, heard: speech.heard, share: speech.share } : { code, matcher: MATCHER_VERSION });
```

и последнюю строку `reject`

```ts
      throw new StudioError(code, msg, true);
```

на

```ts
      throw speech ? new SpeechMismatchError(msg, speech.heard, speech.silentLines) : new StudioError(code, msg, true);
```

Ниже, при несовпадении речи, заменить

```ts
        await reject('speech_mismatch', `${why}, услышано: «${heard.slice(0, 200)}»`, { heard, share: check.share });
```

на

```ts
        await reject('speech_mismatch', `${why}, услышано: «${heard.slice(0, 200)}»`, { heard, share: check.share, silentLines: check.silentLines });
```

5. Сразу перед строкой `const animateSkit = async (kind: SkitKind): Promise<SkitClip> => {` вставить:

```ts
  /** Пояснение сценаристу (writer_feedback): какая сценка, что не так, что переписать. */
  const writerText = (kind: SkitKind, fb: Omit<SkitFeedback, 'kind'>): string => {
    const lines = plans[kind].skit.lines;
    const what =
      fb.code === 'speech_mismatch'
        ? `${MAX_SPEECH_MISSES} клипа с этими репликами не прошли сверку речи; в последнем ${
            fb.lines.length
              ? `не услышаны: ${fb.lines.map((n) => `реплика ${n} (${lines[n - 1]?.hero ?? '?'}) «${lines[n - 1]?.text ?? ''}»`).join(', ')}`
              : 'речь не сошлась с репликами'
          }, услышано: «${(fb.heard ?? '').slice(0, 200)}»`
        : `фильтр Google ${MAX_SKIT_ATTEMPTS} раза не пропустил клип (${fb.reason ?? 'причина не названа'})`;
    return `${SCENE[kind]}: ${what}. Перепиши реплики и действие этой сценки — короче и проще, обычными словами; пока герой говорит, ничто не закрывает ему рот; место, начало и героев не меняй.`;
  };

  /**
   * Сценку не снять с этими репликами — сценаристу. Переписанную сценку снимут заново:
   * нужен хотя бы один клип в пределе секунд; места нет — omni_budget (assertBudget),
   * без круга сценариста.
   */
  const toWriter = (kind: SkitKind, fb: Omit<SkitFeedback, 'kind'>, message: string): SkitFeedbackError => {
    assertBudget();
    return new SkitFeedbackError({ kind, ...fb }, writerText(kind, fb), message);
  };

```

6. В `animateSkit` заменить

```ts
    let last: StudioError | null = null;
    const codes: string[] = [];
```

на

```ts
    let last: StudioError | null = null;
    const codes: string[] = [];
    let speechMisses = 0;
```

в `catch` цикла заменить

```ts
        last = err;
        codes.push(err.code);
        if (!err.retryable) throw err;
```

на

```ts
        last = err;
        codes.push(err.code);
        if (!err.retryable) throw err;
        // Два клипа с этим текстом не прошли сверку речи — промахи на одном тексте повторяются:
        // сценаристу, а не третий клип (брак из перепроверки сюда не попадает — он судится в reviveRejected).
        if (e instanceof SpeechMismatchError && ++speechMisses >= MAX_SPEECH_MISSES) {
          throw toWriter(kind, { code: 'speech_mismatch', lines: e.silentLines.map((i) => i + 1), heard: e.heard, reason: null }, `${err.message} — ${MAX_SPEECH_MISSES} клипа с этим текстом не прошли сверку`);
        }
```

и строку после цикла

```ts
    throw new StudioError(last!.code, `${last!.message} — после ${MAX_SKIT_ATTEMPTS} попыток (${codes.join(', ')})`, false);
```

на

```ts
    const summary = `${last!.message} — после ${MAX_SKIT_ATTEMPTS} попыток (${codes.join(', ')})`;
    // Фильтр Google так и не пропустил клип — причина в тексте сценки, а не в удаче: сценаристу.
    if (last!.code === 'omni_rejected') throw toWriter(kind, { code: 'omni_rejected', lines: [], heard: null, reason: last!.message }, summary);
    throw new StudioError(last!.code, summary, false);
```

7. В сводке сбоев сценок заменить

```ts
    if (failures.length) {
      // Если упали обе сценки, код и признак повтора — у той, что без повтора.
      const main = failures.find((f) => !f.err.retryable) ?? failures[0];
      throw new StudioError(main.err.code, failures.map((f) => `${SCENE[f.kind]}: ${f.err.message}`).join('; '), main.err.retryable);
    }
```

на

```ts
    if (failures.length) {
      // Если упали обе сценки, код и признак повтора — у той, что без повтора. Отзыв
      // сценаристу — только если другая сценка не упала намертво: переписка ту не вылечит.
      const hard = failures.find((f) => !f.err.retryable && !(f.err instanceof SkitFeedbackError));
      const toWriterFailure = failures.find((f) => f.err instanceof SkitFeedbackError);
      const main = hard ?? toWriterFailure ?? failures[0];
      const message = failures.map((f) => `${SCENE[f.kind]}: ${f.err.message}`).join('; ');
      if (main.err instanceof SkitFeedbackError) throw new SkitFeedbackError(main.err.feedback, main.err.writerText, message);
      throw new StudioError(main.err.code, message, main.err.retryable);
    }
```

- [ ] **Step 7: Закоммитить и прогнать**

```bash
git add studio/src/types.ts studio/src/errors.ts studio/src/animate/run-animate.ts
git commit -m "feat(studio): два промаха речи или три отказа фильтра на одном тексте — сценка сценаристу" -m "SkitFeedbackError с разбором и пояснением; места на пересъёмку нет — omni_budget; намертво упавшая вторая сценка важнее отзыва." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts src/worker/animate-money.test.ts && npm run typecheck"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `# fail 0` у студии (тестов оживления — 52), пустой `tsc`; контракт — `Tests:` без `failed`.

---

### Task 6: Студия — ролик сценаристу с разбором

**Files:**
- Modify: `studio/src/worker/db.ts` (`failJob`, описание `MAX_WRITER_ROUNDS`)
- Modify: `src/shorts/shorts.contract.spec.ts` (колонка в контракте очереди)
- Test: `studio/src/worker/db.integration.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/shorts/shorts.contract.spec.ts`, в тесте `it('очередь студии — те же статусы и колонки', …)`, в список строк после `'writer_feedback',` добавить `'skit_feedback',`.

В `studio/src/worker/db.integration.ts`:
- импорт ошибок заменить на `import { SkitFeedbackError, StudioError } from '../errors';`;
- список миграций заменить на `const MIGRATIONS = ['001_shorts.sql', '002_skits.sql', '004_skit_feedback.sql'].map(…)` (то же `.map`, что сейчас);
- после теста `it('сценарий, отвергнутый студией (script_invalid), — назад сценаристу; …', …)` добавить:

```ts
  it('сценку не снять с этими репликами — сценаристу с разбором; после третьего круга — failed с этапа сценариста', async () => {
    const id = await insert('animate_queued', { writer_rounds: 2 });
    const job = await claimJob(pool, 'animate');
    const feedback = { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard: 'это только символика периода', reason: null } as const;
    const err = new SkitFeedbackError({ ...feedback, lines: [...feedback.lines] }, 'сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи', 'сценка 2 (развязка): не услышаны реплики 2 — 2 клипа с этим текстом не прошли сверку');
    assert.equal(await failJob(pool, job!, err), 'writer');
    const r = await row(id);
    assert.deepEqual(
      [r.status, r.writer_feedback, r.skit_feedback, r.attempts, r.lease_until, r.last_error],
      ['writing', err.writerText, feedback, 0, null, `оживление: ${err.message}`],
    );

    // Сценарист сдал третий вариант: writer_rounds + 1, отзывы студии стёрты (shorts-writer.service.ts).
    await pool.query(`UPDATE short_video SET status = 'animate_queued', writer_rounds = 3, writer_feedback = NULL, skit_feedback = NULL WHERE id = $1`, [id]);
    const last = await claimJob(pool, 'animate');
    assert.equal(await failJob(pool, last!, err), 'failed');
    const f = await row(id);
    assert.deepEqual(
      [f.status, f.failed_from, f.writer_feedback, f.skit_feedback, f.failure_notified, f.lease_until],
      ['failed', 'writing', err.writerText, feedback, false, null],
    );
  });
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add src/shorts/shorts.contract.spec.ts studio/src/worker/db.integration.ts
git commit -m "test(studio): сценку не снять — ролик сценаристу с разбором (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | tail -15"
```

Ожидается: падает новый тест (`'failed'` вместо `'writer'`: без своей ветки отзыв уходит в общий путь «без повтора»).

- [ ] **Step 3: Код**

В `studio/src/worker/db.ts`:

1. Импорт — заменить

```ts
import { WRITER_FEEDBACK_CODES, type StudioError, type StudioErrorCode } from '../errors';
```

на

```ts
import { SkitFeedbackError, WRITER_FEEDBACK_CODES, type StudioError, type StudioErrorCode } from '../errors';
```

2. Описание `MAX_WRITER_ROUNDS` — фразу `Сколько кругов сценариста выдерживает ролик из-за длины озвучки:` заменить на `Сколько кругов сценариста выдерживает ролик из-за отзывов студии (длина озвучки, сценка, которую не снять):`.

3. В `failJob` сразу после определения `write` (перед `if (job.kind === 'render' && WRITER_FEEDBACK_CODES.has(err.code)) {`) вставить:

```ts
  // Сценку не снять с этими репликами (run-animate.ts, toWriter): сценаристу — пояснение
  // в writer_feedback и разбор в skit_feedback, пока круги есть; кончились — failed с этапа
  // сценариста с тем же отзывом: «Повторить» вернёт ролик ему же.
  if (job.kind === 'animate' && err instanceof SkitFeedbackError) {
    const params = [err.writerText, JSON.stringify(err.feedback), message];
    if (job.writerRounds < MAX_WRITER_ROUNDS) {
      return write(
        `UPDATE short_video
            SET status = 'writing', writer_feedback = $4, skit_feedback = $5::jsonb, last_error = $6,
                attempts = 0, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND status = $2 AND attempts = $3`,
        params,
        'writer',
      );
    }
    return write(
      `UPDATE short_video
          SET status = 'failed', failed_from = 'writing', writer_feedback = $4, skit_feedback = $5::jsonb,
              lease_until = NULL, last_error = $6, failure_notified = false, updated_at = now()
        WHERE id = $1 AND status = $2 AND attempts = $3`,
      params,
      'failed',
    );
  }
```

4. В описании `failJob` после пункта про озвучку вставить пункт:

```ts
 * - сценку не снять с этими репликами (SkitFeedbackError: два клипа одного текста
 *   не прошли сверку речи или три отказа фильтра) — сценаристу с пояснением и разбором (skit_feedback), пока
 *   кругов меньше MAX_WRITER_ROUNDS; круги кончились — failed с этапа сценариста;
```

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git add studio/src/worker/db.ts
git commit -m "feat(studio): сценку не снять — ролик сценаристу с пояснением и разбором" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | tail -6"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts 2>&1 | grep -E '✕|Tests:'"
```

Ожидается: `# fail 0` у живой базы студии; контракт — `Tests:` без `failed`.

---

### Task 7: Полный прогон, учения на стенде, выкат

**Files:** нет правок кода.

- [ ] **Step 1: Всё на ноде**

```bash
studio/scripts/node-run.sh "s=0; npm test > ~/ci/sh2a-test.log 2>&1 || s=\$?; tail -8 ~/ci/sh2a-test.log; test \$s -eq 0; npm run typecheck; STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db 2>&1 | grep -E '^# (tests|pass|fail)'"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | tail -8; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '^Tests:'; out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi; if npm run build >\$out 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; tail -20 \$out; fi"
```

Ожидается: студия `# fail 0`, `tsc` пусто, живая база `# fail 0`; бэкенд — `Tests:` без `failed`, `TSC_OK`, `BUILD_OK`. Красное — разобрать, не двигаться дальше.

- [ ] **Step 2 (контролёр, OK владельца на выкат на стенд): отзыв о сценке на стенде**

Учение без подделки распознавания: ролик стенда со снятыми сценками переводится в `writing` с отзывом студии о развязке — как будто студия его прислала. Ожидается: сценарист переписал только реплики и действие развязки (отпечаток кадра развязки прежний), оживление переснимает только развязку (одна генерация Omni ≈ $0,8 на ключе стенда), конфликт берётся готовым, ролик приходит на проверку в канал стенда.

1. Выкатить ветку на стенд: `TEST_ONLY=1 BACK_ONLY=1 SKIP_BOTS=1` с ноды из свежих клонов ветки (рецепт — как в задаче 6 плана очереди 1, клоны `--branch feat/shorts-self-healing-2`).
2. Выбрать на стенде ролик со сценками в `pending_review`, `approved` или `published` (psql стенда на ноде): `SELECT id, status, script->'skits'->'punchline'->>'keyframeFingerprint' AS kf, script->'skits'->'punchline'->>'fingerprint' AS fp FROM short_video WHERE format = 'skit' AND script->'skits' IS NOT NULL ORDER BY updated_at DESC LIMIT 3;`
3. Перевести (только стенд!):

```sql
UPDATE short_video
   SET status = 'writing', attempts = 0, lease_until = NULL,
       writer_feedback = 'сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи — учение. Перепиши реплики и действие этой сценки — короче и проще, обычными словами; место, начало и героев не меняй.',
       skit_feedback = '{"kind":"punchline","code":"speech_mismatch","lines":[2],"heard":"учение","reason":null}'::jsonb
 WHERE id = '<id>';
```

4. Следить за роликом (раз в 30 с): `writing` → `animate_queued` → `render_queued` → `pending_review`. Проверить: `script->'skits'->'punchline'->>'keyframeFingerprint'` = прежний `kf`, `fingerprint` ≠ прежний `fp`, `animation->>'omniSeconds'` вырос на 8, в журнале студии стенда — один `startClip` развязки и «готово с попытки 1» только у `punchline`; `skit_feedback` и `writer_feedback` — `NULL`.

- [ ] **Step 3 (контролёр, OK владельца): слияние и выкат** — как задача 6 плана очереди 1: `merge --no-ff` в свежий `origin/main`, `deploy.sh` с ноды `BACK_ONLY=1 SKIP_BOTS=1` из свежих клонов, проверка прода (`MAX_SPEECH_MISSES` в `studio/src/animate/run-animate.ts`, колонка `skit_feedback` в `short_video`, `linkeon-studio` перезапущена). Колонки нет — первый накат не дождался замка (`lock_timeout` 5 с): в журнале API `shorts migration 004_skit_feedback.sql failed … lock timeout`, блокирующую сессию — в `pg_stat_activity`, затем рестарт API (проверив, что нет живых ходов); без колонки список «Ролики» в админке отвечает 500, а каждый этап сценариста падает на записи сценария и возврате к режиссёру (обе ссылаются на `skit_feedback`).

- [ ] **Step 4: Заметка памяти и рабочее состояние** — очередь 2а на проде (sha), дальше — план 2б (доктор упавших).
