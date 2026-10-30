# Ролики в админке: экран «Ролики» во вкладке «Блог» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** во вкладке «Блог» админки появляется экран «Ролики». На нём очередь и архив роликов, видео, заказ, запуск, повтор, настройки и решение по готовому ролику: «Одобрить», «Замечание», «Переснять», «Отклонить». Каждое решение проверяет версию ролика.

**Architecture:**
- **Бэк.** Записи решений по ролику переезжают из `ShortsApprovalService` в общий модуль `src/shorts/short-review.ts`: кнопки лички и админка зовут один и тот же код. Версия ролика (`updated_at::text`) попадает в условие записи, только когда её передали. Поэтому для лички SQL и параметры остаются прежними. В `admin/shorts` добавляются `approve`, `redo` и `note`, `reject` расширяется, `list` облегчается, а `get` отдаёт ссылки на файлы с меткой версии.
- **Фронт.** Экран `AdminShortsView` собирается из `ShortCard`, `ShortActions`, `ShortsOrderForm` и `ShortsSettingsForm`. Чистые правила лежат в `shortStatus.ts`, вызовы сервера — в `shortsApi.ts`. `AdminBlogView` получает четвёртую кнопку «Ролики».

**Tech Stack:**
- бэк — NestJS 10 (commonjs, `strictNullChecks: false`), jest с ts-jest, Postgres 16;
- фронт — React 18 и TypeScript 5 (`strict`, `noUnusedLocals`, `noUnusedParameters`), Tailwind, vitest с jsdom; помощники для тестов — свои, `src/test/dom.tsx`, без @testing-library.

**Спека:** `docs/superpowers/specs/2026-10-30-admin-shorts-in-blog-design.md`, коммиты `a80ca25f` и `7115386c` в ветке `feat/admin-shorts`.

---

## Правила для исполнителя

- **Два рабочих дерева, ветка в обоих — `feat/admin-shorts`:**
  - бэк — `~/Downloads/spirits_back/.worktrees/admin-shorts` (уже заведено, от `origin/main` `bb6ab49c`);
  - фронт — `~/Downloads/spirits_front/.worktrees/admin-shorts` (заводится в задаче 9).

  Пути в задачах указаны от корня своего дерева. Перед каждым коммитом проверяйте `git branch --show-current`: должна быть `feat/admin-shorts`. Параллельные сессии переключают общие чекауты.
- **Тесты бэка — только на ноде, не на маке (CLAUDE.md).** Команда запускается из корня дерева бэка: `NODE_RUN_DIR=. studio/scripts/node-run.sh "<команда>"`. Скрипт пушит ветку, ставит `~/ci/wt/promo-shorts` на точный коммит и гонит команду там. Незакоммиченное на ноду не уезжает: красный тест коммитить с пометкой «(красный)», как принято в модуле роликов. Коды выхода:
  - 75 — дерево занято, повторить через пару минут;
  - 255 — сбой ssh, повторить через 1–2 минуты;
  - 3 — дерево ноды не встало на коммит, сообщить контролёру.
- **Тесты фронта по одному файлу — на маке.** CLAUDE.md разрешает точечный `vitest run`. Запускать из корня дерева фронта под Node 22 (у Node 26 на маке свой `localStorage`, он ломает jsdom):
  `PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run <файл>`.
  Полный прогон, `tsc` и сборка фронта — на ноде, задача 18.
- **`git add` — только поимённо, не `-A`.** В чекауте фронта лежит чужой неотслеживаемый `pnpm-workspace.yaml`, его не коммитить.
- **Секреты.** Репозитории Linkeon публичные. В тестах — только выдуманные значения.
- **Слияние в `main`, выкаты, правки на серверах — только с явного OK владельца** (задачи 20–22). Выкат — только `scripts/deploy.sh`.
- **Стиль.** Комментарии — по-русски, как в соседних файлах. Подписи админки — по-русски прямо в коде: админка не переводится, `scripts/check-no-hardcoded.mjs` её не проверяет по решению из спеки. Писать «ассистент», а не «агент».
- **`pnpm lint` фронта сломан** (плагин i18next, см. память). Его падение — не от этой правки, гейтом он не служит.

## Файлы

| Файл | Ответственность |
|---|---|
| **бэк** `src/shorts/short-review.ts` (новый) | `RELEASED_SQL`, `LEAVE_FROM`, `versionClause`, `explainRefusal`, `leaveReview`, `noteForReview` — записи решений, общие для лички и админки |
| `src/shorts/short-slot-claim.ts` | `approveShortIntoSlot` — необязательная версия |
| `src/shorts/shorts-approval.service.ts` | кнопки лички на общем модуле; тексты называют кнопки экрана |
| `src/shorts/shorts-publisher.service.ts` | `POST_MAY_BE_OUT`, `YOUTUBE_MAY_BE_OUT` — кнопки экрана вместо `retry`/`mark_published` |
| `src/shorts/shorts.controller.ts` | лёгкий `list`, `get` с версией, `approve`/`redo`/`note`, расширенный `reject` |
| спеки рядом, `src/shorts/shorts.integration.spec.ts` | тесты |
| **фронт** `src/components/admin/shortStatus.ts` (новый) | типы ответа, подписи, группы, строка ролика, кнопки по статусу, запросы, итоги, черновик настроек |
| `src/components/admin/shortFixtures.ts` (новый) | образцы роликов для тестов (в сборку не попадает) |
| `src/components/admin/shortsApi.ts` (новый) | `callShorts`, `ShortsApiError`, `loadAgents` |
| `src/components/admin/ShortsOrderForm.tsx` (новый) | заказ ролика, «Пополнить темы недели» |
| `src/components/admin/ShortsSettingsForm.tsx` (новый) | настройки роликов |
| `src/components/admin/ShortActions.tsx` (новый) | кнопки раскрытого ролика, поля замечания и ссылки на пост |
| `src/components/admin/ShortCard.tsx` (новый) | строка ролика и раскрытая карточка с видео |
| `src/components/admin/AdminShortsView.tsx` (новый) | экран: загрузка, переключатель, группы, решения, плашки |
| `src/components/admin/AdminBlogView.tsx` | кнопка «Ролики», экран вместо постов |
| `src/components/webvisorPrivacy.test.ts` | строка для поля истории в заказе |
| тесты `*.test.ts(x)` рядом | тесты |

---

## Часть A. Бэк (`~/Downloads/spirits_back/.worktrees/admin-shorts`)

### Task 0: Базовая линия бэка на ноде

**Files:** нет.

- [ ] **Step 1: Прогон модуля роликов и бота на исходном коммите**

```bash
cd ~/Downloads/spirits_back/.worktrees/admin-shorts
git branch --show-current
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | tail -30"
```

Expected: ветка `feat/admin-shorts`, сводка jest. Записать в отчёт число сюит и тестов и все красные сюиты, если они есть. Это база для задачи 8.

- [ ] **Step 2: tsc сборки на исходном коммите**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi"
```

Expected: `TSC_OK`. Если `TSC_FAIL` — записать ошибки как базу, правка их не трогает.

---

### Task 1: Общий модуль решений `short-review.ts`

**Files:**
- Create: `src/shorts/short-review.ts`
- Test: `src/shorts/short-review.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-review.spec.ts`:

```ts
import { LEAVE_FROM, RELEASED_SQL, explainRefusal, leaveReview, noteForReview, versionClause } from './short-review';
import { rowToShort } from './shorts.types';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const VERSION = '2026-10-30 12:34:56.123456+00';
const row = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', status: 'pending_review', ...over,
});

/** Пул-заглушка: UPDATE — заданным ответом, чтение причины — заданной строкой (или пусто). */
function fakePg(update: { rows: any[] }, after: any = null) {
  return {
    query: jest.fn(async (sql: string) => (sql.startsWith('UPDATE') ? update : { rows: after ? [after] : [] })),
  };
}

describe('versionClause', () => {
  it('без версии — ни условия, ни параметра', () => {
    const params: any[] = [ID];
    expect(versionClause(params, undefined)).toBe('');
    expect(versionClause(params, null)).toBe('');
    expect(params).toEqual([ID]);
  });

  it('с версией — условие на следующий номер параметра', () => {
    const params: any[] = [ID, 'x'];
    expect(versionClause(params, VERSION)).toBe(' AND updated_at = $3::timestamptz');
    expect(params).toEqual([ID, 'x', VERSION]);
  });
});

describe('leaveReview', () => {
  it('без версии — SQL и параметры кнопок лички: статус, откуда, «не вышел»', async () => {
    const pg = fakePg({ rows: [row({ status: 'directing' })] });
    const out = await leaveReview(pg as any, ID, 'directing');
    expect(out).toMatchObject({ ok: true, short: { id: ID, status: 'directing' } });
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain('SET status = $2');
    expect(sql).toContain(`AND NOT ${RELEASED_SQL}`);
    expect(sql).not.toContain('updated_at = $');
    expect(params).toEqual([ID, 'directing', LEAVE_FROM]);
  });

  it('с версией — условие версии в самой записи', async () => {
    const pg = fakePg({ rows: [row({ status: 'rejected' })] });
    await leaveReview(pg as any, ID, 'rejected', VERSION);
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain('AND updated_at = $4::timestamptz');
    expect(params).toEqual([ID, 'rejected', LEAVE_FROM, VERSION]);
  });

  it('не записалось — причина чтением после: вышел, не тот статус, версия устарела, строки нет', async () => {
    const cases: [any, string, string | null][] = [
      [{ status: 'approved', released: true }, 'released', 'approved'],
      [{ status: 'writing', released: false }, 'status', 'writing'],
      [{ status: 'pending_review', released: false }, 'stale', 'pending_review'],
      [null, 'not_found', null],
    ];
    for (const [after, reason, status] of cases) {
      const pg = fakePg({ rows: [] }, after);
      expect(await leaveReview(pg as any, ID, 'rejected', VERSION)).toEqual({ ok: false, reason, status });
    }
  });
});

describe('noteForReview', () => {
  it('замечание дописано к прежним, ролик — к сценаристу; без версии параметры прежние', async () => {
    const pg = fakePg({ rows: [row({ status: 'writing' })] });
    const out = await noteForReview(pg as any, rowToShort(row({ owner_note: 'короче' })), 'без цифр');
    expect(out.ok).toBe(true);
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain("status = 'writing'");
    expect(sql).toContain("WHERE id = $1 AND status = 'pending_review'");
    expect(params).toEqual([ID, 'короче\nбез цифр']);
  });

  it('с версией — условие версии; не записалось — причина', async () => {
    const pg = fakePg({ rows: [] }, { status: 'pending_review', released: false });
    const out = await noteForReview(pg as any, rowToShort(row()), 'без цифр', VERSION);
    expect(out).toEqual({ ok: false, reason: 'stale', status: 'pending_review' });
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toContain('AND updated_at = $3::timestamptz');
    expect(params).toEqual([ID, 'без цифр', VERSION]);
  });
});

describe('explainRefusal', () => {
  it('«вышел» важнее статуса', async () => {
    const pg = fakePg({ rows: [] }, { status: 'published', released: true });
    expect(await explainRefusal(pg as any, ID, ['pending_review'])).toEqual({ reason: 'released', status: 'published' });
  });
});
```

- [ ] **Step 2: Закоммитить красный и убедиться, что падает**

```bash
git add src/shorts/short-review.spec.ts
git commit -m "test(shorts): общий модуль решений по ролику — версия, «вышел», замечание (красный)"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-review.spec.ts 2>&1 | tail -15"
```

Expected: FAIL, `Cannot find module './short-review'`.

- [ ] **Step 3: Написать модуль**

`src/shorts/short-review.ts`:

```ts
import type { SlotQueryable } from '../blog/blog-slot-claim';
import { ShortStatus, ShortVideo, appendOwnerNote, rowToShort } from './shorts.types';

/**
 * Решения по готовому ролику — общие для кнопок в личке (ShortsApprovalService)
 * и админки (ShortsController, экран «Блог» → «Ролики»): «Переснять»,
 * «Отклонить», замечание. Одобрение со слотом — approveShortIntoSlot
 * (short-slot-claim.ts), версию оно берёт отсюда же (versionClause).
 *
 * Спека: docs/superpowers/specs/2026-10-30-admin-shorts-in-blog-design.md.
 *
 * Версия — `updated_at::text` из list/get админки, с микросекундами: через Date
 * JS они теряются, и сверка `updated_at = $версия` не сошлась бы никогда (так же
 * устроен токен аренды отправки в личку, `lease_until::text`). С версией запись
 * проходит, только если ролик с тех пор не менялся: файл пересобранного ролика
 * лежит по тому же адресу, и без версии админка одобрила бы видео, которого
 * владелец не видел. Кнопки лички версию не передают — их сторожит «кнопка под
 * текущим сообщением» (review_message_id), — и для них SQL и параметры прежние.
 */

/**
 * Ролик уже вышел хоть на одной площадке: пост в канале есть или набор YouTube
 * ушёл владельцу. Между попытками публикации такой ролик лежит в approved.
 * Им же сторожит `reject` упавшего ролика в админке (shorts.controller.ts).
 */
export const RELEASED_SQL =
  `EXISTS (SELECT 1 FROM short_publication p WHERE p.short_id = short_video.id AND p.status IN ('published', 'manual_pending', 'manual_done'))`;

/** Откуда готовый ролик можно «Переснять» и «Отклонить». */
export const LEAVE_FROM: readonly ShortStatus[] = ['pending_review', 'approved'];

export type ReviewRefusal = 'not_found' | 'released' | 'status' | 'stale';

export type ReviewResult =
  | { ok: true; short: ShortVideo }
  | { ok: false; reason: ReviewRefusal; status: ShortStatus | null };

/**
 * Условие версии к записи — только если версия передана: без неё SQL и
 * параметры прежние (на этом держатся тесты лички). Параметр дописывается в
 * `params` — вызывать до запроса, а не внутри его шаблонной строки.
 */
export function versionClause(params: any[], version?: string | null): string {
  if (version == null) return '';
  params.push(version);
  return ` AND updated_at = $${params.length}::timestamptz`;
}

/**
 * Почему запись не прошла — чтением после неё. «Уже вышел» важнее статуса,
 * как у кнопок лички: между попытками публикации вышедший ролик лежит в
 * approved, из которого «Переснять» в остальном разрешён. Статус подходящий и
 * ролик не вышел — значит, разошлась версия.
 */
export async function explainRefusal(
  pg: SlotQueryable,
  id: string,
  allowed: readonly ShortStatus[],
): Promise<{ reason: ReviewRefusal; status: ShortStatus | null }> {
  const r = await pg.query(`SELECT status, ${RELEASED_SQL} AS released FROM short_video WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return { reason: 'not_found', status: null };
  if (row.released) return { reason: 'released', status: row.status };
  if (!allowed.includes(row.status)) return { reason: 'status', status: row.status };
  return { reason: 'stale', status: row.status };
}

/**
 * «Переснять» (`directing`) или «Отклонить» (`rejected`) готового ролика — из
 * pending_review или approved, если он нигде не вышел. Одобренный теряет
 * одобрение (`approved_at = NULL`): новую версию человек ещё не видел.
 * Условие на статус и «не вышел» — в самой записи, а не чтением перед ней:
 * пока решали, ролик мог уйти в публикацию. «Переснять» вышедшего отправил бы
 * новую версию только в YouTube, «Отклонить» — сделал бы rejected ролик с
 * живым постом.
 */
export async function leaveReview(
  pg: SlotQueryable,
  id: string,
  target: 'directing' | 'rejected',
  version?: string | null,
): Promise<ReviewResult> {
  const params: any[] = [id, target, LEAVE_FROM];
  const clause = versionClause(params, version);
  const r = await pg.query(
    `UPDATE short_video SET status = $2, approved_at = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = ANY($3::text[])
        AND NOT ${RELEASED_SQL}${clause}
      RETURNING *`,
    params,
  );
  if (r.rows.length) return { ok: true, short: rowToShort(r.rows[0]) };
  return { ok: false, ...(await explainRefusal(pg, id, LEAVE_FROM)) };
}

/**
 * Замечание к ролику на проверке: дописывается к прежним (appendOwnerNote) и
 * уводит ролик к сценаристу. writer_rounds = 0 — новый круг владельца, счётчик
 * автоматических переписок студии заново.
 */
export async function noteForReview(
  pg: SlotQueryable,
  short: ShortVideo,
  text: string,
  version?: string | null,
): Promise<ReviewResult> {
  const params: any[] = [short.id, appendOwnerNote(short.ownerNote, text)];
  const clause = versionClause(params, version);
  const r = await pg.query(
    `UPDATE short_video
        SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0,
            lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending_review'${clause}
      RETURNING *`,
    params,
  );
  if (r.rows.length) return { ok: true, short: rowToShort(r.rows[0]) };
  return { ok: false, ...(await explainRefusal(pg, short.id, ['pending_review'])) };
}
```

- [ ] **Step 4: Закоммитить и убедиться, что проходит**

```bash
git add src/shorts/short-review.ts
git commit -m "feat(shorts): общий модуль решений по ролику — версия в условии записи, причина отказа"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-review.spec.ts 2>&1 | tail -15"
```

Expected: PASS, 8 тестов.

---

### Task 2: Одобрение со слотом — версия из админки

**Files:**
- Modify: `src/shorts/short-slot-claim.ts`
- Test: `src/shorts/short-slot-claim.spec.ts`

- [ ] **Step 1: Написать падающий тест**

В `src/shorts/short-slot-claim.spec.ts` внутрь `describe('approveShortIntoSlot', …)` последним тестом:

```ts
  it('версия из админки — условие в записи одобрения; без версии SQL и параметры прежние', async () => {
    const VERSION = '2026-10-30 12:34:56.123456+00';
    const calls: any[][] = [];
    const client = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push([sql, params]);
        return sql.trim().startsWith('UPDATE') ? { rowCount: 1 } : { rows: [] };
      }),
      release: jest.fn(),
    };
    const pg = { getClient: async () => client };
    const update = () => calls.find(([sql]) => String(sql).trim().startsWith('UPDATE')) as any[];

    await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW, VERSION);
    expect(update()[0]).toContain("WHERE id = $1 AND status = 'pending_review' AND updated_at = $3::timestamptz");
    expect(update()[1]).toEqual(['v1', THU.toISOString(), VERSION]);

    calls.length = 0;
    await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW);
    expect(update()[0]).not.toContain('updated_at = $');
    expect(update()[1]).toEqual(['v1', THU.toISOString()]);
  });
```

- [ ] **Step 2: Закоммитить красный и убедиться, что падает**

```bash
git add src/shorts/short-slot-claim.spec.ts
git commit -m "test(shorts): одобрение со слотом — версия из админки в условии записи (красный)"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-slot-claim.spec.ts 2>&1 | tail -15"
```

Expected: FAIL — в SQL нет `AND updated_at = $3::timestamptz`.

- [ ] **Step 3: Добавить версию**

В `src/shorts/short-slot-claim.ts` к импортам:

```ts
import { versionClause } from './short-review';
```

Комментарий и функцию `approveShortIntoSlot` заменить целиком:

```ts
/**
 * Одобрить ролик в слот. Запись — только из `pending_review`: двойное
 * касание «Одобрить» — два обработчика, и второй не должен переставить ролик
 * на другой слот. `approved_at` отмечает, что ролик одобрял человек: только
 * такой можно вернуть в `approved` повтором публикации (`retryTarget`).
 *
 * `version` — версия ролика из админки (`updated_at::text`, short-review.ts):
 * запись пройдёт, только если ролик с тех пор не менялся. Кнопка лички её не
 * передаёт — её сторожит «кнопка под текущим сообщением», и SQL для неё прежний.
 *
 * @returns слот — или null, если ролик успел уйти из `pending_review` или разошлась версия
 * @throws NoFreeSlotError — слот уводили MAX_SLOT_ATTEMPTS раз подряд
 */
export async function approveShortIntoSlot(
  pg: TxSource,
  id: string,
  planned: Date | null,
  schedule: Schedule,
  clock: () => Date = () => new Date(),
  version?: string | null,
): Promise<ApprovedSlot | null> {
  for (let attempt = 1; attempt <= MAX_SLOT_ATTEMPTS; attempt++) {
    try {
      return await inTransaction(pg, async (tx) => {
        const now = clock();
        const slot = chooseApprovalSlot(now, planned, schedule, await takenSlots(tx, now, { lock: true }));
        const params: any[] = [id, slot.toISOString()];
        const clause = versionClause(params, version);
        const r = await tx.query(
          `UPDATE short_video SET status = 'approved', slot_at = $2, approved_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'pending_review'${clause}`,
          params,
        );
        return r.rowCount === 0 ? null : { slot, now };
      });
    } catch (e: any) {
      if (!isShortSlotConflict(e)) throw e;
      // Слот заняли между чтением и записью — новый круг прочтёт его занятым.
    }
  }
  throw new NoFreeSlotError(`слот ${MAX_SLOT_ATTEMPTS} раз подряд занимали одновременно с нами — попробуйте ещё раз`);
}
```

- [ ] **Step 4: Закоммитить и убедиться, что проходит**

```bash
git add src/shorts/short-slot-claim.ts
git commit -m "feat(shorts): одобрение со слотом принимает версию из админки"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-slot-claim.spec.ts src/shorts/shorts-approval.service.spec.ts 2>&1 | tail -15"
```

Expected: PASS обеих сюит. Тест лички «Одобрить — слот и дата владельцу» проверяет вызов ровно с четырьмя аргументами, и он тоже зелёный.

---

### Task 3: Личка на общем модуле

Ожидания тестов здесь не правятся. Проверка рефакторинга в том, что прежние тесты лички и контроллера остаются зелёными.

**Files:**
- Modify: `src/shorts/shorts-approval.service.ts`
- Modify: `src/shorts/shorts.controller.ts:9` (импорт `RELEASED_SQL`)

- [ ] **Step 1: Импорты сервиса лички**

В `src/shorts/shorts-approval.service.ts` заменить

```ts
import { approveShortIntoSlot } from './short-slot-claim';
```

на

```ts
import { LEAVE_FROM, leaveReview, noteForReview } from './short-review';
import { approveShortIntoSlot } from './short-slot-claim';
```

и заменить

```ts
import {
  MAX_NOTE_PROMPTS, ShortStatus, ShortVideo, appendOwnerNote, canTransition, rowToShort, shortsBucket,
} from './shorts.types';
```

на

```ts
import {
  MAX_NOTE_PROMPTS, ShortStatus, ShortVideo, canTransition, rowToShort, shortsBucket,
} from './shorts.types';
```

- [ ] **Step 2: Убрать `RELEASED_SQL` из сервиса лички (он переехал в `short-review.ts`)**

Удалить целиком блок:

```ts
/**
 * Ролик уже вышел хоть на одной площадке: пост в канале есть или набор YouTube
 * ушёл владельцу. Между попытками публикации такой ролик лежит в approved.
 * Им же сторожит `reject` админки (shorts.controller.ts).
 */
export const RELEASED_SQL =
  `EXISTS (SELECT 1 FROM short_publication p WHERE p.short_id = short_video.id AND p.status IN ('published', 'manual_pending', 'manual_done'))`;

```

- [ ] **Step 3: Метод `leave` — на `leaveReview`**

Метод `leave` вместе с его комментарием заменить на:

```ts
  /**
   * «Переснять» (новая сцена на ту же тему) и «Отклонить». Запись — общая с
   * админкой (leaveReview, short-review.ts): из pending_review и approved,
   * одобренный теряет одобрение, вышедший хоть где-то не трогается. Здесь —
   * отказ без записи для заведомо неподходящего статуса и слова владельцу.
   */
  private async leave(v: ShortVideo, cb: any, chatId: number, target: 'directing' | 'rejected'): Promise<void> {
    if (!LEAVE_FROM.includes(v.status) || !canTransition(v.status, target)) {
      await this.answer(cb, buttonRefusal(v.status));
      return;
    }
    const out = await leaveReview(this.pg, v.id, target);
    if (out.ok === false) {
      await this.answer(
        cb,
        out.reason === 'released' ? 'Ролик уже вышел на площадке — переснять или отклонить нельзя' : buttonRefusal(out.status ?? undefined),
      );
      return;
    }
    if (target === 'directing') {
      const text = 'Пересниму: новая сцена на ту же тему. Пришлю, когда будет готово.';
      await this.answer(cb, text);
      await this.notify(chatId, `Ролик${quoted(v)}: ${text}`);
    } else {
      await this.answer(cb, 'Отклонено');
    }
  }
```

- [ ] **Step 4: Замечание в `handleReplyEdit` — на `noteForReview`**

Фрагмент

```ts
    // writer_rounds = 0: новый круг владельца, счётчик автоматических переписок студии — заново.
    const w = await this.pg.query(
      `UPDATE short_video
          SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0,
              lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review'`,
      [v.id, appendOwnerNote(v.ownerNote, text)],
    );
    if (w.rowCount === 0) {
      const now = await this.load(v.id);
      await this.tg.sendMessage(chatId, noteRefusal(now?.status ?? v.status));
      return true;
    }
```

заменить на

```ts
    // Запись — общая с админкой (noteForReview, short-review.ts).
    const out = await noteForReview(this.pg, v, text);
    if (out.ok === false) {
      await this.tg.sendMessage(chatId, noteRefusal(out.status ?? v.status));
      return true;
    }
```

- [ ] **Step 5: Импорт `RELEASED_SQL` в контроллере**

В `src/shorts/shorts.controller.ts` заменить

```ts
import { RELEASED_SQL } from './shorts-approval.service';
```

на

```ts
import { RELEASED_SQL } from './short-review';
```

- [ ] **Step 6: Прогон — прежние тесты без правки ожиданий**

```bash
git add src/shorts/shorts-approval.service.ts src/shorts/shorts.controller.ts
git commit -m "refactor(shorts): кнопки лички — на общем модуле решений; RELEASED_SQL — в short-review"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-approval.service.spec.ts src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts src/shorts/short-slot-claim.spec.ts 2>&1 | tail -15"
NODE_RUN_DIR=. studio/scripts/node-run.sh "out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi"
```

Expected: PASS всех четырёх сюит и `TSC_OK`. У ts-jest включён `isolatedModules`, и типы он не проверяет — поэтому `tsc` отдельно, после каждой правки бэка. Если красные «кнопки» или «ответы реплаем» — рефакторинг поменял поведение: чинить код, а не тест.

---

### Task 4: `list` и `get` — лёгкий список, версия, метка в ссылках

**Files:**
- Modify: `src/shorts/shorts.controller.ts`
- Test: `src/shorts/shorts.controller.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/shorts/shorts.controller.spec.ts` после `const ID = …` добавить:

```ts
const VERSION = '2026-10-30 12:34:56.123456+00';
```

В `describe('POST admin/shorts', …)` после теста `get — ссылки на видео…`:

```ts
  it('list — без тяжёлых полей, с версией строкой из базы', async () => {
    const { ctl, pg } = setup((sql) =>
      sql.includes('FROM short_publication')
        ? { rows: [] }
        : {
            rows: [video({
              status: 'pending_review', version: VERSION,
              capture: { answerText: 'x' }, script: { hook: 'h' }, animation: { omniSeconds: 16 }, captions: { telegram: 'TG' },
            })],
          });
    const r = res();
    await ctl.action({ action: 'list' }, r);
    expect(String(pg.query.mock.calls[0][0])).toContain('updated_at::text AS version');
    expect(r.body[0].version).toBe(VERSION);
    for (const heavy of ['capture', 'script', 'animation', 'captions']) expect(r.body[0]).not.toHaveProperty(heavy);
    expect(r.body[0]).toMatchObject({ id: ID, status: 'pending_review', publications: [] });
  });

  it('get — версия и ссылки на файлы с меткой версии', async () => {
    const { ctl } = setup((sql) =>
      sql.includes('FROM short_video') ? { rows: [video({ version: VERSION, cover_key: 'shorts/v/cover.jpg' })] } : { rows: [] });
    const r = res();
    await ctl.action({ action: 'get', id: ID }, r);
    expect(r.body.version).toBe(VERSION);
    expect(r.body.videoUrl).toBe(`https://minio.test/linkeon-smm-videos/shorts/v/video.mp4?v=${encodeURIComponent(VERSION)}`);
    expect(r.body.coverUrl).toBe(`https://minio.test/linkeon-smm-videos/shorts/v/cover.jpg?v=${encodeURIComponent(VERSION)}`);
  });
```

- [ ] **Step 2: Закоммитить красный и убедиться, что падает**

```bash
git add src/shorts/shorts.controller.spec.ts
git commit -m "test(shorts): admin list без тяжёлых полей, версия; get — метка версии в ссылках (красный)"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts 2>&1 | tail -20"
```

Expected: FAIL двух новых тестов: нет `version`, есть `capture`, нет `?v=`.

- [ ] **Step 3: Реализовать**

В `src/shorts/shorts.controller.ts` после строки `type RetryFrom = (typeof RETRY_FROM)[number];`:

```ts

/** Тяжёлые поля ролика (около 35 КБ на собранный): в list не отдаём — они приходят в get. */
function light(v: ShortVideo): Partial<ShortVideo> {
  const out: Partial<ShortVideo> = { ...v };
  delete out.capture;
  delete out.script;
  delete out.animation;
  delete out.captions;
  return out;
}

/**
 * Метка версии в ссылке на файл: пересобранный ролик лежит по тому же адресу
 * (`shorts/<id>/video.mp4`), и без метки браузер покажет прежнюю версию из кэша.
 * nginx прода (`/smm-media/`) срезает строку запроса до MinIO.
 */
function withVersion(url: string, version: string | null): string {
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}
```

Методы `list` и `getOne` заменить целиком:

```ts
  private async list() {
    const r = await this.pg.query(`SELECT *, updated_at::text AS version FROM short_video ORDER BY created_at DESC LIMIT 100`);
    const pubs = r.rows.length
      ? await this.pg.query(`SELECT * FROM short_publication WHERE short_id = ANY($1::uuid[])`, [r.rows.map((row: any) => row.id)])
      : { rows: [] };
    const byVideo = new Map<string, ShortPublication[]>();
    for (const p of pubs.rows.map(rowToPublication)) byVideo.set(p.shortId, [...(byVideo.get(p.shortId) ?? []), p]);
    return r.rows.map((row: any) => ({
      ...light(rowToShort(row)),
      version: row.version ?? null,
      publications: byVideo.get(row.id) ?? [],
    }));
  }

  private async getOne(id: string) {
    const { short: v, version } = await this.loadVersioned(id);
    const pubs = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    const bucket = shortsBucket();
    const url = (key: string | null) => (key ? withVersion(this.storage.publicUrl(bucket, key), version) : null);
    return {
      ...v,
      version,
      publications: pubs.rows.map(rowToPublication),
      videoUrl: url(v.videoKey),
      coverUrl: url(v.coverKey),
    };
  }
```

Перед методом `load` добавить:

```ts
  /** Ролик и его версия (`updated_at::text`) — для get: ею админка подписывает решения. */
  private async loadVersioned(id: string): Promise<{ short: ShortVideo; version: string | null }> {
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const r = await this.pg.query(`SELECT *, updated_at::text AS version FROM short_video WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException('ролик не найден');
    return { short: rowToShort(r.rows[0]), version: r.rows[0].version ?? null };
  }

```

- [ ] **Step 4: Закоммитить и убедиться, что проходит**

```bash
git add src/shorts/shorts.controller.ts
git commit -m "feat(shorts): admin list лёгкий и с версией, get — версия и метка версии в ссылках на файлы"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts 2>&1 | tail -20"
NODE_RUN_DIR=. studio/scripts/node-run.sh "out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi"
```

Expected: PASS всей сюиты, включая прежние `list` и `get`; `TSC_OK`.

---

### Task 5: Решения из админки — `approve`, `redo`, `note`, `reject`

**Files:**
- Modify: `src/shorts/shorts.controller.ts`
- Test: `src/shorts/shorts.controller.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

В самый верх `src/shorts/shorts.controller.spec.ts`, перед импортами:

```ts
jest.mock('./short-slot-claim', () => ({
  ...jest.requireActual('./short-slot-claim'),
  approveShortIntoSlot: jest.fn(),
}));

```

Импорт `import { SHORT_SLOT_INDEX } from './short-slot-claim';` заменить на

```ts
import { NoFreeSlotError } from '../blog/blog-slots';
import { SHORT_SLOT_INDEX, approveShortIntoSlot } from './short-slot-claim';
```

Тест `reject — ролик уже вышел на площадке — 409; не упавший — 409` заменить целиком: ждущий решения ролик теперь отклоняется через общий модуль, без версии это 400.

```ts
  it('reject — ролик уже вышел на площадке — 409; в работе — 409; ждущий решения без версии — 400', async () => {
    const released = setup((sql) => {
      if (sql.includes('RETURNING')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'failed', released: true }] };
      return { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] };
    });
    await expect(released.ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(/уже вышел/);

    const writing = setup(() => ({ rows: [video({ status: 'writing', failed_from: null })] }));
    await expect(writing.ctl.action({ action: 'reject', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
    expect(writing.pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);

    const review = setup(() => ({ rows: [video({ status: 'pending_review', failed_from: null })] }));
    await expect(review.ctl.action({ action: 'reject', id: ID }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(review.pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
```

В конец файла — новый блок:

```ts
describe('POST admin/shorts — решение по готовому ролику', () => {
  const review = (over: Record<string, any> = {}) =>
    video({ status: 'pending_review', failed_from: null, slot_at: '2030-01-03T15:00:00.000Z', ...over });
  beforeEach(() => (approveShortIntoSlot as jest.Mock).mockReset());

  it('approve — общая запись одобрения со слотом и версией; ответ — перечитанный ролик', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue({
      slot: new Date('2030-01-03T15:00:00.000Z'), now: new Date('2030-01-01T00:00:00.000Z'),
    });
    let loads = 0;
    const { ctl, pg } = setup((sql) =>
      sql.includes('FROM short_video') ? { rows: [review(loads++ ? { status: 'approved' } : {})] } : { rows: [] });
    const r = res();
    await ctl.action({ action: 'approve', id: ID, version: VERSION }, r);
    expect(approveShortIntoSlot).toHaveBeenCalledWith(
      pg, ID, new Date('2030-01-03T15:00:00.000Z'), expect.objectContaining({ slotDays: [2, 4, 6] }), undefined, VERSION,
    );
    expect(r.body.status).toBe('approved');
  });

  it('approve — без версии или с кривой — 400, запись не зовётся', async () => {
    const { ctl } = setup(() => ({ rows: [review()] }));
    await expect(ctl.action({ action: 'approve', id: ID }, res())).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.action({ action: 'approve', id: ID, version: '2026-10-30' }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(approveShortIntoSlot).not.toHaveBeenCalled();
  });

  it('approve — версия разошлась — 409 version_conflict', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue(null);
    const { ctl } = setup((sql) =>
      sql.includes('AS released') ? { rows: [{ status: 'pending_review', released: false }] } : { rows: [review()] });
    const err: any = await ctl.action({ action: 'approve', id: ID, version: VERSION }, res()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      error: 'version_conflict', message: 'Ролик изменился, пока был открыт: на экране устаревшая версия',
    });
  });

  it('approve — ролик уже не ждёт решения — 409 словами, без внутренних статусов', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue(null);
    const { ctl } = setup((sql) =>
      sql.includes('AS released') ? { rows: [{ status: 'approved', released: false }] } : { rows: [review()] });
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toThrow(
      'Одобрить можно только ролик, который ждёт решения; этот — одобрен. Обновите список.',
    );
  });

  it('версия похожа на дату, но невозможна (месяц 13) — 400, а не 500 от Postgres', async () => {
    (approveShortIntoSlot as jest.Mock).mockRejectedValue(
      Object.assign(new Error('date/time field value out of range'), { code: '22008' }),
    );
    const { ctl } = setup(() => ({ rows: [review()] }));
    await expect(ctl.action({ action: 'approve', id: ID, version: '2026-13-45 12:34:56+00' }, res()))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('approve — ролик уже вышел (состояние, до которого сейчас не дойти) — свой текст, без «этот — ждёт решения»', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue(null);
    const { ctl } = setup((sql) =>
      sql.includes('AS released') ? { rows: [{ status: 'pending_review', released: true }] } : { rows: [review()] });
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toThrow(
      'Ролик уже вышел на площадке — решение по нему не принять',
    );
  });

  it('approve — нет свободного слота — 409 с причиной', async () => {
    (approveShortIntoSlot as jest.Mock).mockRejectedValue(new NoFreeSlotError('все 60 ближайших слотов расписания заняты'));
    const { ctl } = setup(() => ({ rows: [review()] }));
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toThrow(/не одобрил: все 60/);
  });

  it('redo — к режиссёру через общую запись, версия — в условии записи', async () => {
    const { ctl, pg } = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [review({ status: 'directing' })] } : { rows: [review()] }));
    const r = res();
    await ctl.action({ action: 'redo', id: ID, version: VERSION }, r);
    const [sql, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(sql).toContain('AND updated_at = $4::timestamptz');
    expect(params).toEqual([ID, 'directing', ['pending_review', 'approved'], VERSION]);
    expect(r.body.status).toBe('directing');
  });

  it('redo — ролик уже вышел — 409 «уже вышел на площадке»', async () => {
    const { ctl } = setup((sql) => {
      if (sql.startsWith('UPDATE')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'approved', released: true }] };
      return { rows: [review({ status: 'approved' })] };
    });
    await expect(ctl.action({ action: 'redo', id: ID, version: VERSION }, res())).rejects.toThrow(
      'Ролик уже вышел на площадке — переснять или отклонить нельзя',
    );
  });

  it('reject ждущего решения — через общую запись с версией', async () => {
    const { ctl, pg } = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [review({ status: 'rejected' })] } : { rows: [review()] }));
    const r = res();
    await ctl.action({ action: 'reject', id: ID, version: VERSION }, r);
    const [, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(params).toEqual([ID, 'rejected', ['pending_review', 'approved'], VERSION]);
    expect(r.body.status).toBe('rejected');
  });

  it('note — замечание дописано к прежним, ролик у сценариста; пустое — 400', async () => {
    const { ctl, pg } = setup((sql) =>
      sql.startsWith('UPDATE') ? { rows: [review({ status: 'writing' })] } : { rows: [review({ owner_note: 'короче' })] });
    const r = res();
    await ctl.action({ action: 'note', id: ID, version: VERSION, text: '  без цифр  ' }, r);
    const [sql, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(sql).toContain("status = 'writing'");
    expect(params).toEqual([ID, 'короче\nбез цифр', VERSION]);
    expect(r.body.status).toBe('writing');
    await expect(ctl.action({ action: 'note', id: ID, version: VERSION, text: '   ' }, res())).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: Закоммитить красный и убедиться, что падает**

```bash
git add src/shorts/shorts.controller.spec.ts
git commit -m "test(shorts): admin approve/redo/note и reject ждущего решения — с версией (красный)"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts 2>&1 | tail -25"
```

Expected: FAIL новых тестов с «неизвестное действие: approve» и прочими; новый тест `reject — …` тоже красный.

- [ ] **Step 3: Реализовать**

В `src/shorts/shorts.controller.ts`:

1. Импорты. Заменить

```ts
import { isShortSlotConflict } from './short-slot-claim';
import { RELEASED_SQL } from './short-review';
```

на

```ts
import { NoFreeSlotError } from '../blog/blog-slots';
import { LEAVE_FROM, RELEASED_SQL, ReviewRefusal, explainRefusal, leaveReview, noteForReview, versionClause } from './short-review';
import { approveShortIntoSlot, isShortSlotConflict } from './short-slot-claim';
```

2. После функции `withVersion` (задача 4) добавить:

```ts

/** Версия ролика из list/get — `updated_at::text` Postgres, например «2026-10-30 12:34:56.123456+00». */
const VERSION_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const NEED_VERSION = 'нужна версия ролика (поле version из list или get)';
const STALE_SHORT = 'Ролик изменился, пока был открыт: на экране устаревшая версия';
const RELEASED_TEXT = 'Ролик уже вышел на площадке — переснять или отклонить нельзя';
/** Коды Postgres для невозможной даты (месяц 13, 30 февраля, смещение +99): форма версии верна, значение — нет. */
const BAD_TIMESTAMP_CODES = ['22007', '22008', '22009'];

/** Статус ролика словами — для отказов админки, без внутренних имён. */
const STATUS_WORDS: Record<ShortStatus, string> = {
  idea: 'идея',
  directing: 'у режиссёра',
  capture_queued: 'ждёт съёмки',
  capturing: 'снимается',
  writing: 'у сценариста',
  animate_queued: 'ждёт оживления',
  animating: 'оживляется',
  render_queued: 'ждёт сборки',
  rendering: 'собирается',
  pending_review: 'ждёт решения',
  approved: 'одобрен',
  publishing: 'публикуется',
  published: 'опубликован',
  rejected: 'отклонён',
  failed: 'упал',
};

/** Что разрешено решению — первая половина отказа «не тот статус». */
const ALLOWED_WORDS = {
  approve: 'Одобрить можно только ролик, который ждёт решения',
  note: 'Замечание можно только к ролику, который ждёт решения',
  leave: 'Переснять или отклонить можно только ролик, который ждёт решения или запланирован',
} as const;
type ReviewKind = keyof typeof ALLOWED_WORDS;
```

3. Комментарий класса: строку `* Админка роликов: действия в одном POST, как admin/blog. Вкладка кабинета` и следующую `* появится в плане 3. На стенде это единственный способ запустить ролик` заменить на

```ts
 * Админка роликов: действия в одном POST, как admin/blog; экран — «Блог» →
 * «Ролики» в кабинете (AdminShortsView). На стенде это единственный способ запустить ролик
```

4. В `switch (action)` перед `case 'publish_now':` добавить:

```ts
      case 'approve':
        return res.status(200).json(await this.versioned(() => this.approve(String(data.id ?? ''), data.version)));
      case 'redo':
        return res.status(200).json(await this.versioned(() => this.leave(String(data.id ?? ''), 'directing', data.version)));
      case 'note':
        return res.status(200).json(await this.versioned(() => this.note(String(data.id ?? ''), data.text, data.version)));
```

и строку `return res.status(200).json(await this.reject(String(data.id ?? '')));` заменить на

```ts
        return res.status(200).json(await this.versioned(() => this.reject(String(data.id ?? ''), data.version)));
```

5. Метод `reject` вместе с его комментарием заменить на:

```ts
  /** Версия решения: без неё — 400, если она обязательна; кривая — 400, а не 500 от Postgres. */
  private version(raw: unknown, required: boolean): string | null {
    if (raw === undefined || raw === null || raw === '') {
      if (required) throw new BadRequestException(NEED_VERSION);
      return null;
    }
    if (typeof raw !== 'string' || !VERSION_RE.test(raw)) {
      throw new BadRequestException(`version — метка версии из list или get, получено «${String(raw).slice(0, 60)}»`);
    }
    return raw;
  }

  /**
   * Регулярка версии проверяет только форму: «2026-13-45 12:34:56+00» она
   * пропустит, а Postgres ответит 22008. Это ошибка запроса (400), а не сервера.
   */
  private async versioned<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e: any) {
      if (BAD_TIMESTAMP_CODES.includes(e?.code)) throw new BadRequestException('version — метка версии из list или get');
      throw e;
    }
  }

  /** Отказ общего модуля решений — 409 со словами для человека (404 — строки нет). */
  private refused(kind: ReviewKind, out: { reason: ReviewRefusal; status: ShortStatus | null }): never {
    if (out.reason === 'not_found') throw new NotFoundException('ролик не найден');
    if (out.reason === 'stale') {
      throw new ConflictException({ statusCode: 409, error: 'version_conflict', message: STALE_SHORT });
    }
    if (out.reason === 'released') {
      // Одобрение и замечание «вышел» в записи не проверяют — до такого ролика сейчас не дойти,
      // но и «этот — ждёт решения» в отказе было бы противоречием.
      throw new ConflictException(kind === 'leave' ? RELEASED_TEXT : 'Ролик уже вышел на площадке — решение по нему не принять');
    }
    const now = out.status ? STATUS_WORDS[out.status] : 'в неизвестном статусе';
    throw new ConflictException(`${ALLOWED_WORDS[kind]}; этот — ${now}. Обновите список.`);
  }

  /**
   * «Одобрить» из админки — та же запись, что у кнопки в личке
   * (approveShortIntoSlot), с версией: файл пересобранного ролика лежит по
   * тому же адресу, и одобрить можно только ту версию, что владелец видел.
   */
  private async approve(id: string, rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, true);
    const v = await this.load(id);
    let approved: unknown;
    try {
      approved = await approveShortIntoSlot(this.pg, v.id, v.slotAt, await this.settings.get(), undefined, version);
    } catch (e: any) {
      if (e instanceof NoFreeSlotError) throw new ConflictException(`не одобрил: ${e.message}`);
      throw e;
    }
    if (!approved) return this.refused('approve', await explainRefusal(this.pg, v.id, ['pending_review']));
    return this.load(v.id);
  }

  /** «Переснять» и «Отклонить» ждущего решения или запланированного — общей записью, с версией. */
  private async leave(id: string, target: 'directing' | 'rejected', rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, true);
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const out = await leaveReview(this.pg, id, target, version);
    if (out.ok === false) return this.refused('leave', out);
    return out.short;
  }

  /** Замечание к ролику, который ждёт решения: дописывается к прежним, ролик — к сценаристу. */
  private async note(id: string, rawText: unknown, rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, true);
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw new BadRequestException('text — замечание строкой');
    const v = await this.load(id);
    const out = await noteForReview(this.pg, v, text, version);
    if (out.ok === false) return this.refused('note', out);
    return out.short;
  }

  /**
   * «Отклонить». Ждущий решения и запланированный — общей записью, как кнопка
   * в личке, с обязательной версией. Упавший — как раньше: нельзя, если он уже
   * вышел хоть на одной площадке (пост в канале, набор YouTube у владельца),
   * иначе rejected оказался бы ролик с живым постом; версия здесь
   * необязательна, а если пришла — проверяется. Условие — в самом UPDATE, а не
   * чтением перед ним.
   */
  private async reject(id: string, rawVersion: unknown): Promise<ShortVideo> {
    const v = await this.load(id);
    if (LEAVE_FROM.includes(v.status)) return this.leave(id, 'rejected', rawVersion);
    const version = this.version(rawVersion, false);
    if (v.status !== 'failed' || !canTransition(v.status, 'rejected')) {
      throw new ConflictException(
        `отклонить можно упавший, ждущий решения или запланированный ролик, а он в статусе ${STATUS_WORDS[v.status] ?? v.status}`,
      );
    }
    const params: any[] = [id];
    const clause = versionClause(params, version);
    const r = await this.pg.query(
      `UPDATE short_video SET status = 'rejected', approved_at = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'failed'
          AND NOT ${RELEASED_SQL}${clause}
        RETURNING *`,
      params,
    );
    if (r.rows.length) return rowToShort(r.rows[0]);
    // Почему не записалось — тем же чтением, что у решений по готовому ролику.
    const why = await explainRefusal(this.pg, id, ['failed']);
    if (why.reason === 'released') {
      throw new ConflictException('ролик уже вышел на площадке — отклонить нельзя; оставшиеся площадки повторит «Повторить»');
    }
    if (why.reason === 'not_found') throw new NotFoundException('ролик не найден');
    // «stale» без версии — гонка (ролик ушёл из failed и вернулся), а не устаревшая карточка.
    if (why.reason === 'stale' && version) {
      throw new ConflictException({ statusCode: 409, error: 'version_conflict', message: STALE_SHORT });
    }
    throw new ConflictException('ролик успел уйти из failed — обновите список');
  }
```

- [ ] **Step 4: Закоммитить и убедиться, что проходит**

```bash
git add src/shorts/shorts.controller.ts
git commit -m "feat(shorts): решения по ролику из админки — approve, redo, note, reject ждущего решения; версия, отказы словами"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts 2>&1 | tail -20"
NODE_RUN_DIR=. studio/scripts/node-run.sh "out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi"
```

Expected: PASS обеих сюит, включая прежние тесты `reject упавшего`, `retry`, `mark_published` и `publish_now`; `TSC_OK`.

---

### Task 6: Тексты бота называют кнопки экрана

**Files:**
- Modify: `src/shorts/shorts-approval.service.ts`, `src/shorts/shorts-publisher.service.ts`
- Test: `src/shorts/shorts-approval.service.spec.ts`, `src/shorts/shorts-publisher.service.spec.ts`

- [ ] **Step 1: Сначала ожидания тестов (красные)**

В `src/shorts/shorts-approval.service.spec.ts`:

1. В тесте `отказы кнопок — человеческими словами…` строку

```ts
        ['failed', 'redo', /^Ролик упал — повторить или отклонить его можно из админки роликов$/],
```

заменить на

```ts
        ['failed', 'redo', /^Ролик упал — повторить или отклонить его можно в админке: Блог → Ролики$/],
```

2. Тест `замечание к упавшему ролику — куда его передать, без ссылки на несуществующую вкладку` заменить на:

```ts
    it('замечание к упавшему ролику — куда его передать: кнопки экрана «Ролики»', async () => {
      const { svc, tg } = setup(row({ status: 'failed', failed_from: 'writing' }));
      await svc.handleReplyEdit(reply());
      const text = String((tg.sendMessage.mock.calls[0] as any[])[1]);
      expect(text).toContain('в админке: Блог → Ролики — «Повторить», «Новая сцена» или «Новый текст» (можно с замечанием), либо «Отклонить»');
      expect(text).not.toMatch(/retry|reject|from=/);
    });
```

3. В тесте `упавший ролик — владельцу с причиной, один раз` две последние проверки

```ts
      expect(text).toContain('Повторить можно из админки роликов: retry (можно с from=directing|writing и замечанием) или reject.');
      expect(text).not.toMatch(/кнопкой «Повторить»|раздел «Ролики»/);
```

заменить на

```ts
      expect(text).toContain('Повторить можно в админке: Блог → Ролики — «Повторить», «Новая сцена» или «Новый текст» (можно с замечанием), либо «Отклонить».');
      expect(text).not.toMatch(/retry|reject|from=/);
```

4. В тесте `упавшая публикация — владельцу без from…` строку

```ts
      expect(text).toContain('В админке роликов: retry — повторить публикацию, reject — отклонить.');
```

заменить на

```ts
      expect(text).toContain('В админке: Блог → Ролики — «Повторить» или «Отклонить».');
```

В `src/shorts/shorts-publisher.service.spec.ts` строки

```ts
    // Что делать — тем же текстом, что уйдёт владельцу: действия админки роликов, а не несуществующая кнопка.
    expect(db.v.last_error).toContain('если пост вышел — mark_published со ссылкой на пост, иначе retry');
```

заменить на

```ts
    // Что делать — тем же текстом, что уйдёт владельцу: кнопки экрана «Ролики» во вкладке «Блог».
    expect(db.v.last_error).toContain('если пост вышел — отметьте «Пост вышел» со ссылкой на пост, иначе «Повторить»');
```

```bash
git add src/shorts/shorts-approval.service.spec.ts src/shorts/shorts-publisher.service.spec.ts
git commit -m "test(shorts): тексты владельцу называют кнопки экрана «Ролики» (красный)"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-approval.service.spec.ts src/shorts/shorts-publisher.service.spec.ts 2>&1 | tail -20"
```

Expected: FAIL пяти изменённых проверок.

- [ ] **Step 2: Тексты в сервисе лички**

В `src/shorts/shorts-approval.service.ts`:

```ts
/**
 * Что делать с упавшим роликом. Вкладки «Ролики» в кабинете пока нет (план 3) —
 * есть действия API admin/shorts, их и называем.
 */
const RETRY_HINT = 'из админки роликов: retry (можно с from=directing|writing и замечанием) или reject';
```

заменить на

```ts
/** Что делать с упавшим роликом — кнопки экрана «Ролики» во вкладке «Блог» админки (AdminShortsView). */
const RETRY_HINT = 'в админке: Блог → Ролики — «Повторить», «Новая сцена» или «Новый текст» (можно с замечанием), либо «Отклонить»';
```

В `BUTTON_REFUSALS` строки

```ts
  // Всплывашка — без имён действий API (сторожит спека): их владелец получил в сообщении о сбое.
  failed: 'Ролик упал — повторить или отклонить его можно из админки роликов',
```

заменить на

```ts
  // Всплывашка — до 200 знаков и без латиницы (сторожит спека): кнопки — на экране «Ролики».
  failed: 'Ролик упал — повторить или отклонить его можно в админке: Блог → Ролики',
```

В `handleShortCommand`:

```ts
        : 'Автозапуск выключен — запустите ролик из админки роликов: start_now.';
```

заменить на

```ts
        : 'Автозапуск выключен — запустите ролик кнопкой «Запустить сейчас» в админке: Блог → Ролики.';
```

В `notifyFailures`:

```ts
        ? 'В админке роликов: retry — повторить публикацию, reject — отклонить.'
```

заменить на

```ts
        ? 'В админке: Блог → Ролики — «Повторить» или «Отклонить».'
```

- [ ] **Step 3: Тексты в публикаторе**

В `src/shorts/shorts-publisher.service.ts` строки

```ts
 * Действия названы по API admin/shorts: вкладки «Ролики» в кабинете пока нет.
 */
export const POST_MAY_BE_OUT = 'пост мог выйти — проверьте канал; если пост вышел — mark_published со ссылкой на пост, иначе retry';
```

заменить на

```ts
 * Действия названы кнопками экрана «Ролики» во вкладке «Блог» админки
 * (`mark_published` — «Пост вышел», `retry` — «Повторить»).
 */
export const POST_MAY_BE_OUT = 'пост мог выйти — проверьте канал; если пост вышел — отметьте «Пост вышел» со ссылкой на пост, иначе «Повторить»';
```

В `YOUTUBE_MAY_BE_OUT` два `retry` заменить на `«Повторить»`, а «безопасен» — на «безопасно». Итог:

```ts
export const YOUTUBE_MAY_BE_OUT =
  'YouTube не ответил, дошла ли загрузка; «Повторить» безопасно — перед новой загрузкой спрошу YouTube о прошлой, а если он её уже не помнит, пришлю набор с просьбой проверить канал. ' +
  'Если повтор упрётся в то же: /youtube вручную, затем «Повторить» — придёт набор с предупреждением проверить канал; потом верните режим.';
```

Не писать «Повторить публикацию»: подсказка склеивается с причиной Google и режется до 500 знаков, и тест «короткая причина укладывается целиком» покраснеет (спека, «Тексты бота»).

- [ ] **Step 4: Закоммитить и убедиться, что проходит**

```bash
git add src/shorts/shorts-approval.service.ts src/shorts/shorts-publisher.service.ts
git commit -m "feat(shorts): тексты владельцу называют кнопки экрана «Блог → Ролики» вместо действий API"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-approval.service.spec.ts src/shorts/shorts-publisher.service.spec.ts src/shorts/youtube 2>&1 | tail -20"
```

Expected: PASS, включая `403 без явного лимита… — last_error содержит подсказку выхода и причину 403`.

---

### Task 7: Против живого Postgres

**Files:**
- Modify: `src/shorts/shorts.integration.spec.ts`

- [ ] **Step 1: Проверить одноразовую базу на ноде**

```bash
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "psql 'postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it' -tAc 'select 1' 2>&1 | head -2"
```

Expected: `1`. Если базы нет — завести по рецепту из шапки файла:

```bash
ssh dv@85.192.61.231 "sudo -u postgres psql -qc \"CREATE ROLE shortsit LOGIN PASSWORD 'shortsit'\"; sudo -u postgres psql -qc \"CREATE DATABASE shorts_it OWNER shortsit\""
```

- [ ] **Step 2: Написать тесты**

В `src/shorts/shorts.integration.spec.ts` к импортам:

```ts
import { leaveReview, noteForReview } from './short-review';
import { BAD_TIMESTAMP_CODES, VERSION_RE } from './shorts.controller';
```

Внутрь `maybe('ролики против живого Postgres', …)` перед `describe('YouTube против живой базы', …)`:

```ts
  describe('решения из админки — версия и «вышел» на живом SQL', () => {
    const VERSION = '2030-01-01 10:00:00.123456+00';
    const daily = { slotDays: [1, 2, 3, 4, 5, 6, 7], slotHourMsk: 18 };

    it('версия строкой из базы сверяется с микросекундами; округлённая до миллисекунд — нет', async () => {
      const v = await insert({ status: 'pending_review', updated_at: VERSION });
      const version = (await pool.query(`SELECT updated_at::text AS version FROM short_video WHERE id = $1`, [v.id])).rows[0].version;
      // Через Date JS: …10:00:00.123Z — микросекунды потеряны.
      const rounded = v.updatedAt.toISOString();
      expect(await approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, rounded)).toBeNull();
      expect(await approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, version)).not.toBeNull();
      const row = (await pool.query(`SELECT status, approved_at FROM short_video WHERE id = $1`, [v.id])).rows[0];
      expect(row.status).toBe('approved');
      expect(row.approved_at).not.toBeNull();
    });

    it('вышедший ролик не переснять и не отклонить — даже с верной версией', async () => {
      const v = await insert({
        status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() + 86_400_000), updated_at: VERSION,
      });
      await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'telegram', 'published')`, [v.id]);
      for (const target of ['directing', 'rejected'] as const) {
        expect(await leaveReview(pgLike() as any, v.id, target, VERSION)).toEqual({ ok: false, reason: 'released', status: 'approved' });
      }
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('approved');
    });

    it('одобрение из админки и кнопка лички одновременно — ролик одобрен один раз', async () => {
      const v = await insert({ status: 'pending_review', updated_at: VERSION });
      const [a, b] = await Promise.all([
        approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, VERSION),
        approveShortIntoSlot(pgLike() as any, v.id, null, daily),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('approved');
    });

    it('замечание с устаревшей версией не пишется; с верной — дописано к прежним, ролик у сценариста', async () => {
      const v = await insert({ status: 'pending_review', owner_note: 'короче', updated_at: VERSION });
      expect(await noteForReview(pgLike() as any, v, 'без цифр', '2030-01-01 10:00:00.123+00'))
        .toEqual({ ok: false, reason: 'stale', status: 'pending_review' });
      expect(await noteForReview(pgLike() as any, v, 'без цифр', VERSION))
        .toMatchObject({ ok: true, short: { status: 'writing', ownerNote: 'короче\nбез цифр', writerRounds: 0 } });
    });

    it('одобрение обнуляет счётчик, аренду и ошибку отправки в личку — публикатору достаётся полный бюджет', async () => {
      const v = await insert({
        status: 'pending_review', updated_at: VERSION, attempts: 2,
        lease_until: new Date(Date.now() + 600_000), last_error: 'отправка владельцу: Bad Gateway',
      });
      expect(await approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, VERSION)).not.toBeNull();
      const row = (await pool.query(`SELECT status, attempts, lease_until, last_error FROM short_video WHERE id = $1`, [v.id])).rows[0];
      expect(row).toMatchObject({ status: 'approved', attempts: 0, lease_until: null, last_error: null });
    });

    it('версия из базы подходит под VERSION_RE; невозможные даты правильной формы Postgres отвергает кодами из BAD_TIMESTAMP_CODES', async () => {
      const v = await insert({ status: 'pending_review' });
      const version = (await pool.query(`SELECT updated_at::text AS version FROM short_video WHERE id = $1`, [v.id])).rows[0].version;
      expect(VERSION_RE.test(version)).toBe(true);
      for (const bad of ['2026-13-45 12:34:56+00', '2026-02-30 12:34:56+00', '2026-10-30 12:34:56+99']) {
        // Форма верна — регулярка пропустит, и решать будет база.
        expect(VERSION_RE.test(bad)).toBe(true);
        const err: any = await pool.query('SELECT $1::timestamptz', [bad]).catch((e) => e);
        expect(BAD_TIMESTAMP_CODES).toContain(err.code);
      }
    });
  });
```

- [ ] **Step 3: Прогон на живой базе**

```bash
git add src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): решения из админки на живом Postgres — версия с микросекундами, «вышел», одно одобрение"
NODE_RUN_DIR=. studio/scripts/node-run.sh "SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | tail -25"
```

Expected: PASS всей сюиты, включая шесть новых тестов; skipped быть не должно. Красный новый тест означает, что SQL расходится с ожиданием: разобрать причину, а не ослаблять проверку.

---

### Task 8: Гейты бэка на ноде

**Files:** нет.

- [ ] **Step 1: jest модуля и бота против базы из задачи 0**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | tail -30"
```

Expected: красных сюит не больше, чем в базе задачи 0. Тестов больше на число новых.

- [ ] **Step 2: tsc и сборка**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi; if npm run build >\$out 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; tail -20 \$out; fi"
```

Expected: `TSC_OK` и `BUILD_OK`.

---

## Часть B. Фронт (`~/Downloads/spirits_front/.worktrees/admin-shorts`)

### Task 9: Рабочее дерево фронта и база

**Files:** нет.

- [ ] **Step 1: Завести дерево от свежего `origin/main`**

```bash
cd ~/Downloads/spirits_front
git fetch -q origin
git worktree add -b feat/admin-shorts .worktrees/admin-shorts origin/main
cd .worktrees/admin-shorts
git branch --unset-upstream
ln -s ../../node_modules node_modules
git status --short
git branch --show-current
```

Expected: `git status` пустой (`node_modules` в `.gitignore`), ветка `feat/admin-shorts`. Upstream снят, чтобы случайный `git push` не целился в `origin/main`.

- [ ] **Step 2: Локальный прогон работает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/blogStatus.test.ts
```

Expected: PASS.

- [ ] **Step 3: Дерево фронта на ноде и база полного прогона**

```bash
cd ~/Downloads/spirits_front/.worktrees/admin-shorts
SHA=$(git rev-parse HEAD)
git push -q origin HEAD:refs/heads/feat/admin-shorts
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "set -e; git -C ~/ci/spirits_front fetch -q origin refs/heads/feat/admin-shorts; test -d ~/ci/wt/admin-shorts-front || git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/admin-shorts-front ${SHA}; cd ~/ci/wt/admin-shorts-front; git checkout -q --detach ${SHA}; source ~/.nvm/nvm.sh >/dev/null; pnpm install --frozen-lockfile >/dev/null 2>&1; ./node_modules/.bin/vitest run 2>&1 | tail -8; echo TSC_ERRORS=\$(npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c 'error TS' || true); if pnpm build >/dev/null 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; fi"
```

Expected: сводка vitest, `TSC_ERRORS=<N>` и `BUILD_OK`. Записать в отчёт число тестов, красные файлы и N — это база для задачи 18. По памяти на 24.09 было 45 ошибок tsc в чужих файлах.

---

### Task 10: `shortStatus.ts` — типы, подписи, группы, строка ролика

**Files:**
- Create: `src/components/admin/shortStatus.ts`
- Create: `src/components/admin/shortFixtures.ts` (образцы роликов для тестов; в сборку не попадает — его никто из кода не импортирует)
- Test: `src/components/admin/shortStatus.test.ts`

- [ ] **Step 1: Образцы для тестов и падающий тест**

`src/components/admin/shortFixtures.ts`:

```ts
import type { ShortDetail, ShortItem } from './shortStatus';

/** Образцы роликов для тестов экрана «Ролики» — общие у тестов правил и карточки. */
export const item = (over: Partial<ShortItem> = {}): ShortItem => ({
  id: 's1', rubric: 'assistant', angle: 'roast', angleLocked: false, source: 'catalog', topicKey: 'catalog:2030-W01:1',
  topicHint: 'Залог при аренде', title: null, assistantId: 10, format: 'skit',
  scene: { assistantName: 'Алексей' }, status: 'pending_review', slotAt: null, approvedAt: null, failedFrom: null,
  lastError: null, attempts: 0, ownerNote: null, durationMs: null, publishedAt: null,
  createdAt: '2030-01-01T10:00:00.000Z', updatedAt: '2030-01-01T10:00:00.000Z', version: '2030-01-01 10:00:00.123456+00',
  publications: [], ...over,
});

export const detail = (over: Partial<ShortDetail> = {}): ShortDetail => ({
  ...item(), capture: null, script: null, captions: null, animation: null, videoUrl: null, coverUrl: null, ...over,
});

/** Вторник, 1 января 2030, 12:00 МСК. */
export const NOW = new Date('2030-01-01T09:00:00.000Z');
```

`src/components/admin/shortStatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NOW, item } from './shortFixtures';
import {
  GROUP_ORDER, ShortStatus, archiveOf, groupOf, isReleased, noteChars, orderChars, publicationLabel,
  queueGroups, screenCounts, screenOf, shortTitle, statusLine,
} from './shortStatus';

describe('экраны и группы', () => {
  it('каждый статус — на своём экране и в своей группе', () => {
    const table: [ShortStatus, string, string | null][] = [
      ['pending_review', 'queue', 'review'], ['failed', 'queue', 'failed'],
      ['approved', 'queue', 'scheduled'], ['publishing', 'queue', 'scheduled'], ['idea', 'queue', 'ideas'],
      ['directing', 'queue', 'working'], ['capture_queued', 'queue', 'working'], ['capturing', 'queue', 'working'],
      ['writing', 'queue', 'working'], ['animate_queued', 'queue', 'working'], ['animating', 'queue', 'working'],
      ['render_queued', 'queue', 'working'], ['rendering', 'queue', 'working'],
      ['published', 'published', null], ['rejected', 'rejected', null],
    ];
    for (const [status, screen, group] of table) {
      expect([status, screenOf(status), groupOf(status)]).toEqual([status, screen, group]);
    }
  });

  it('очередь — группы по срочности, пустых нет; внутри по слоту, без слота — после, по созданию', () => {
    const groups = queueGroups([
      item({ id: 'idea', status: 'idea' }),
      item({ id: 'late', slotAt: '2030-01-04T15:00:00.000Z' }),
      item({ id: 'soon', slotAt: '2030-01-02T15:00:00.000Z' }),
      item({ id: 'noslot-old', createdAt: '2029-12-30T10:00:00.000Z' }),
      item({ id: 'noslot-new', createdAt: '2029-12-31T10:00:00.000Z' }),
      item({ id: 'pub', status: 'published' }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['review', 'ideas']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['soon', 'late', 'noslot-old', 'noslot-new']);
    expect(GROUP_ORDER).toEqual(['review', 'failed', 'scheduled', 'working', 'ideas']);
  });

  it('архив — новые сверху; числа экранов', () => {
    const items = [
      item({ id: 'a', status: 'published', publishedAt: '2030-01-01T15:00:00.000Z' }),
      item({ id: 'b', status: 'published', publishedAt: '2030-01-03T15:00:00.000Z' }),
      item({ id: 'c', status: 'rejected' }),
      item({ id: 'd', status: 'writing' }),
    ];
    expect(archiveOf(items, 'published').map((i) => i.id)).toEqual(['b', 'a']);
    expect(archiveOf(items, 'rejected').map((i) => i.id)).toEqual(['c']);
    expect(screenCounts(items)).toEqual({ queue: 1, published: 2, rejected: 1 });
  });
});

describe('строка ролика', () => {
  it('название, иначе тема, иначе ключ темы', () => {
    expect(shortTitle(item({ title: 'Залог' }))).toBe('Залог');
    expect(shortTitle(item({ title: '  ' }))).toBe('Залог при аренде');
    expect(shortTitle(item({ title: null, topicHint: null }))).toBe('catalog:2030-W01:1');
  });

  it('что сказать по статусу — та же фраза о слоте, что у постов', () => {
    const slot = '2030-01-02T15:00:00.000Z';
    expect(statusLine(item({ status: 'pending_review', slotAt: slot }), NOW)).toBe('под слот завтра в 18:00 МСК');
    expect(statusLine(item({ status: 'approved', slotAt: slot }), NOW)).toBe('выйдет завтра в 18:00 МСК');
    expect(statusLine(item({ status: 'failed', failedFrom: 'animating' }), NOW)).toBe('упал: оживление');
    expect(statusLine(item({ status: 'writing', slotAt: slot }), NOW)).toBe('сценарий · под слот завтра в 18:00 МСК');
    expect(statusLine(item({ status: 'idea', source: 'manual' }), NOW)).toBe('идея · заказ');
    expect(statusLine(item({ status: 'rejected' }), NOW)).toBe('отклонён');
  });

  it('площадки словами; «уже вышел» — пост в канале или набор YouTube', () => {
    const pub = (status: any, platform: any = 'telegram') => ({ platform, status, url: null, lastError: null });
    expect(publicationLabel(pub('published'))).toBe('вышел');
    expect(publicationLabel(pub('manual_pending', 'youtube'))).toBe('набор отправлен');
    expect(publicationLabel(pub('manual_done', 'youtube'))).toBe('ссылка записана');
    expect(publicationLabel(pub('publishing'))).toBe('отправляется');
    expect(publicationLabel(pub('failed'))).toBe('упал');
    expect(publicationLabel(pub('pending'))).toBe('ждёт');
    expect(isReleased(item())).toBe(false);
    for (const status of ['published', 'manual_pending', 'manual_done']) {
      expect(isReleased(item({ publications: [pub(status, 'youtube')] }))).toBe(true);
    }
    expect(isReleased(item({ publications: [pub('failed')] }))).toBe(false);
  });

  it('длина заказа и замечания — символы без пробелов по краям, как на бэке', () => {
    expect(orderChars('  тема  ')).toBe(4);
    expect(orderChars('😀😀')).toBe(2);
    expect(noteChars(' коротко ')).toBe(7);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortStatus.test.ts
```

Expected: FAIL, `Failed to resolve import "./shortStatus"`.

- [ ] **Step 3: Написать модуль**

`src/components/admin/shortStatus.ts`:

```ts
import { formatSlotAt } from './blogSlotFormat';
import { realCaseChars } from './blogStatus';

/**
 * Ролики — экран «Ролики» вкладки «Блог» (спека spirits_back
 * docs/superpowers/specs/2026-10-30-admin-shorts-in-blog-design.md): типы
 * ответа `admin/shorts`, подписи, группы и правила кнопок.
 *
 * Правила — копия бэка (`src/shorts/shorts.types.ts`, `short-review.ts`,
 * `shorts.controller.ts`), как `blogStatus.ts` у постов: источник правды —
 * бэк, а здесь они нужны, только чтобы не рисовать кнопку, которая заведомо
 * получит 409.
 */

export type ShortStatus =
  | 'idea' | 'directing' | 'capture_queued' | 'capturing' | 'writing'
  | 'animate_queued' | 'animating' | 'render_queued' | 'rendering'
  | 'pending_review' | 'approved' | 'publishing' | 'published' | 'rejected' | 'failed';
export type ShortRubric = 'assistant' | 'feature' | 'news' | 'case';
export type ShortAngle = 'uncomfortable' | 'roast' | 'myth' | 'calm';
export type ShortFormat = 'skit' | 'chat';
export type ShortSource = 'catalog' | 'git' | 'manual';
export type ShortPlatform = 'telegram' | 'vk' | 'youtube';
export type PublicationStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'manual_pending' | 'manual_done';
export type YoutubeMode = 'manual' | 'unlisted' | 'public';

export interface ShortPublication {
  platform: ShortPlatform;
  status: PublicationStatus;
  url: string | null;
  lastError: string | null;
}

/** Ролик в списке (`list`): без съёмки, сценария, подписей и оживления. */
export interface ShortItem {
  id: string;
  rubric: ShortRubric;
  angle: ShortAngle;
  /** Подача задана заказом; нет — её поставит ритм недели при запуске. */
  angleLocked: boolean;
  source: ShortSource;
  topicKey: string;
  topicHint: string | null;
  title: string | null;
  assistantId: number | null;
  format: ShortFormat;
  scene: { assistantName?: string; question?: string } | null;
  status: ShortStatus;
  slotAt: string | null;
  approvedAt: string | null;
  failedFrom: ShortStatus | null;
  lastError: string | null;
  attempts: number;
  ownerNote: string | null;
  durationMs: number | null;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** `updated_at::text` из базы — ею админка подписывает решения. */
  version: string | null;
  publications: ShortPublication[];
}

/** Ролик целиком (`get`) — для раскрытой карточки. */
export interface ShortDetail extends ShortItem {
  capture: { answerText?: string } | null;
  script: { hook?: string; lines?: { id: string; scene: string; text: string }[] } | null;
  captions: { telegram?: string; youtube?: { title?: string } } | null;
  animation: { omniSeconds?: number } | null;
  videoUrl: string | null;
  coverUrl: string | null;
}

export interface ShortSettings {
  slotDays: number[];
  slotHourMsk: number;
  prepareLeadHours: number;
  minAnswerChars: number;
  tgChannelChatId: string | null;
  platforms: ShortPlatform[];
  narratorVoice: string;
  format: ShortFormat;
  maxOmniSeconds: number;
  youtubeMode: YoutubeMode;
}

export const RUBRICS: ShortRubric[] = ['assistant', 'feature', 'news', 'case'];
export const RUBRIC_TITLES: Record<ShortRubric, string> = {
  assistant: 'Ассистент за работой',
  feature: 'Возможность Linkeon',
  news: 'Новинка',
  case: 'Реальный кейс',
};
export const ANGLES: ShortAngle[] = ['uncomfortable', 'roast', 'myth', 'calm'];
export const ANGLE_TITLES: Record<ShortAngle, string> = {
  uncomfortable: 'Неудобный вопрос',
  roast: 'Разнос',
  myth: 'ИИ против мифа',
  calm: 'Как это работает',
};
export const FORMAT_TITLES: Record<ShortFormat, string> = { skit: 'сценки', chat: 'только чат' };
export const SOURCE_TITLES: Record<ShortSource, string> = { catalog: 'каталог', git: 'новость', manual: 'заказ' };
export const PLATFORM_TITLES: Record<ShortPlatform, string> = { telegram: 'Telegram', youtube: 'YouTube', vk: 'VK' };
export const YOUTUBE_MODE_TITLES: Record<YoutubeMode, string> = {
  manual: 'набор владельцу',
  unlisted: 'по ссылке',
  public: 'публично',
};

export const STATUS_TITLES: Record<ShortStatus, string> = {
  idea: 'Идея',
  directing: 'В работе',
  capture_queued: 'В работе',
  capturing: 'В работе',
  writing: 'В работе',
  animate_queued: 'В работе',
  animating: 'В работе',
  render_queued: 'В работе',
  rendering: 'В работе',
  pending_review: 'Ждёт решения',
  approved: 'Запланирован',
  publishing: 'Публикуется',
  published: 'Вышел',
  rejected: 'Отклонён',
  failed: 'Упал',
};

const WORKING_TONE = 'bg-blue-100 text-blue-700';
const STATUS_TONES: Record<ShortStatus, string> = {
  idea: 'bg-gray-100 text-gray-700',
  directing: WORKING_TONE,
  capture_queued: WORKING_TONE,
  capturing: WORKING_TONE,
  writing: WORKING_TONE,
  animate_queued: WORKING_TONE,
  animating: WORKING_TONE,
  render_queued: WORKING_TONE,
  rendering: WORKING_TONE,
  pending_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-forest-100 text-forest-700',
  publishing: WORKING_TONE,
  published: 'bg-green-100 text-green-700',
  rejected: 'bg-gray-100 text-gray-500',
  failed: 'bg-red-100 text-red-700',
};

export function statusTone(s: ShortStatus): string {
  return STATUS_TONES[s] ?? 'bg-gray-100 text-gray-700';
}

/** Этап словами — у ролика в работе и в «упал: …». */
export const STAGE_TITLES: Partial<Record<ShortStatus, string>> = {
  idea: 'идея',
  directing: 'режиссёр',
  capture_queued: 'съёмка в очереди',
  capturing: 'съёмка',
  writing: 'сценарий',
  animate_queued: 'оживление в очереди',
  animating: 'оживление',
  render_queued: 'сборка в очереди',
  rendering: 'сборка',
  publishing: 'публикация',
};

export type ShortsScreen = 'queue' | 'published' | 'rejected';
export type ShortGroup = 'review' | 'failed' | 'scheduled' | 'working' | 'ideas';

export const GROUP_ORDER: ShortGroup[] = ['review', 'failed', 'scheduled', 'working', 'ideas'];
export const GROUP_TITLES: Record<ShortGroup, string> = {
  review: 'Ждут решения',
  failed: 'Упали',
  scheduled: 'Запланированы',
  working: 'В работе',
  ideas: 'Идеи',
};

export function screenOf(s: ShortStatus): ShortsScreen {
  if (s === 'published') return 'published';
  if (s === 'rejected') return 'rejected';
  return 'queue';
}

/** Группа очереди; у вышедшего и отклонённого её нет — они в архиве. */
export function groupOf(s: ShortStatus): ShortGroup | null {
  if (s === 'pending_review') return 'review';
  if (s === 'failed') return 'failed';
  if (s === 'approved' || s === 'publishing') return 'scheduled';
  if (s === 'idea') return 'ideas';
  if (s === 'published' || s === 'rejected') return null;
  return 'working';
}

/** Момент для сортировки; нет даты — после всех (бесконечность). */
const time = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/** По слоту; ролики без слота — после, между собой по времени создания. */
function bySlot(a: ShortItem, b: ShortItem): number {
  return time(a.slotAt) - time(b.slotAt) || time(a.createdAt) - time(b.createdAt);
}

/** Очередь по группам срочности; пустых групп нет. */
export function queueGroups(items: ShortItem[]): { group: ShortGroup; items: ShortItem[] }[] {
  return GROUP_ORDER
    .map((group) => ({ group, items: items.filter((i) => groupOf(i.status) === group).sort(bySlot) }))
    .filter((g) => g.items.length > 0);
}

/** Архив — новые сверху: по выходу, иначе по последнему изменению. */
export function archiveOf(items: ShortItem[], screen: 'published' | 'rejected'): ShortItem[] {
  const latest = (i: ShortItem) => {
    const t = Date.parse(i.publishedAt ?? i.updatedAt ?? i.createdAt ?? '');
    return Number.isNaN(t) ? 0 : t;
  };
  return items.filter((i) => screenOf(i.status) === screen).sort((a, b) => latest(b) - latest(a));
}

export function screenCounts(items: ShortItem[]): Record<ShortsScreen, number> {
  const out: Record<ShortsScreen, number> = { queue: 0, published: 0, rejected: 0 };
  for (const i of items) out[screenOf(i.status)] += 1;
  return out;
}

/** Как назвать ролик: название, иначе тема, иначе ключ темы. */
export function shortTitle(i: Pick<ShortItem, 'title' | 'topicHint' | 'topicKey'>): string {
  return i.title?.trim() || i.topicHint?.trim() || i.topicKey;
}

/** Что сказать о ролике в свёрнутой строке. Даты — той же фразой, что у постов и в Telegram. */
export function statusLine(i: ShortItem, now: Date): string {
  const slot = i.slotAt ? formatSlotAt(i.slotAt, now) : null;
  switch (i.status) {
    case 'pending_review':
      return slot ? `под слот ${slot}` : 'ждёт решения';
    case 'approved':
      return slot ? `выйдет ${slot}` : 'одобрен, слот не назначен';
    case 'publishing':
      return 'отправляется на площадки';
    case 'failed': {
      const stage = i.failedFrom ? STAGE_TITLES[i.failedFrom] ?? i.failedFrom : null;
      return stage ? `упал: ${stage}` : 'упал';
    }
    case 'idea':
      return `идея · ${SOURCE_TITLES[i.source] ?? i.source}`;
    case 'published':
      return i.publishedAt ? `вышел ${formatSlotAt(i.publishedAt, now)}` : 'вышел';
    case 'rejected':
      return 'отклонён';
    default: {
      const stage = STAGE_TITLES[i.status] ?? i.status;
      return slot ? `${stage} · под слот ${slot}` : stage;
    }
  }
}

export function publicationLabel(p: ShortPublication): string {
  switch (p.status) {
    case 'published':
      return 'вышел';
    case 'manual_pending':
      return 'набор отправлен';
    case 'manual_done':
      return 'ссылка записана';
    case 'publishing':
      return 'отправляется';
    case 'failed':
      return 'упал';
    default:
      return 'ждёт';
  }
}

/** Вышел хоть на одной площадке: пост в канале есть или набор YouTube ушёл владельцу (RELEASED_SQL бэка). */
const RELEASED: PublicationStatus[] = ['published', 'manual_pending', 'manual_done'];

export function isReleased(i: Pick<ShortItem, 'publications'>): boolean {
  return i.publications.some((p) => RELEASED.includes(p.status));
}

/** Пределы заказа и замечания — копия бэка (MIN/MAX_ORDER_CHARS, MAX_OWNER_NOTE_CHARS). */
export const MIN_ORDER_CHARS = 10;
export const MAX_ORDER_CHARS = 4000;
export const MAX_NOTE_CHARS = 2000;

/** Длина заказа так, как её меряет бэк: символы без пробелов по краям (тот же подсчёт, что у истории кейса блога). */
export function orderChars(text: string): number {
  return realCaseChars(text);
}

export function noteChars(text: string): number {
  return Array.from(text.trim()).length;
}
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortStatus.test.ts
git branch --show-current
git add src/components/admin/shortStatus.ts src/components/admin/shortStatus.test.ts src/components/admin/shortFixtures.ts
git commit -m "admin: ролики — типы, подписи, группы очереди и строка ролика"
```

Expected: PASS, 7 тестов.

---

### Task 11: `shortStatus.ts` — кнопки, запросы, итоги, настройки

**Files:**
- Modify: `src/components/admin/shortStatus.ts`
- Test: `src/components/admin/shortStatus.test.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/components/admin/shortStatus.test.ts` оба импорта заменить на:

```ts
import { NOW, detail, item } from './shortFixtures';
import {
  GROUP_ORDER, ShortSettings, ShortStatus, actionRequest, actionsFor, archiveOf, draftErrors,
  draftToPatch, groupOf, isReleased, isTelegramPostUrl, noteChars, orderChars, publicationLabel, queueGroups,
  screenCounts, screenOf, shortTitle, statusLine, successText, toDraft,
} from './shortStatus';
```

В конец файла:

```ts
describe('кнопки по статусу', () => {
  const tg = (status: any) => ({ platform: 'telegram' as const, status, url: null, lastError: null });

  it('ждёт решения — одобрить, замечание, переснять, отклонить', () => {
    expect(actionsFor(detail({ status: 'pending_review' }))).toEqual(['approve', 'note', 'redo', 'reject']);
  });

  it('запланирован — опубликовать, переснять, отклонить; вышел хоть где-то — только опубликовать', () => {
    expect(actionsFor(detail({ status: 'approved' }))).toEqual(['publish_now', 'redo', 'reject']);
    expect(actionsFor(detail({ status: 'approved', publications: [tg('published')] }))).toEqual(['publish_now']);
  });

  it('упал до публикации — повтор с этапа, новая сцена, новый текст при съёмке, отклонить', () => {
    expect(actionsFor(detail({ status: 'failed', failedFrom: 'rendering', capture: { answerText: 'x' } })))
      .toEqual(['retry', 'retry_directing', 'retry_writing', 'reject']);
    expect(actionsFor(detail({ status: 'failed', failedFrom: 'capturing' }))).toEqual(['retry', 'retry_directing', 'reject']);
    expect(actionsFor(detail({ status: 'failed', failedFrom: null }))).toEqual(['reject']);
  });

  it('упала публикация — «Повторить» и «Пост вышел» только у одобрявшегося; вышел — без «Отклонить»', () => {
    const approvedAt = '2030-01-01T11:00:00.000Z';
    expect(actionsFor(detail({ status: 'failed', failedFrom: 'publishing', approvedAt }))).toEqual(['retry', 'mark_published', 'reject']);
    expect(actionsFor(detail({ status: 'failed', failedFrom: 'publishing', approvedAt, publications: [tg('published')] })))
      .toEqual(['retry', 'mark_published']);
    expect(actionsFor(detail({ status: 'failed', failedFrom: 'publishing', approvedAt: null }))).toEqual(['reject']);
  });

  it('идея — запустить; в работе, публикуется, вышел, отклонён — ничего', () => {
    expect(actionsFor(detail({ status: 'idea' }))).toEqual(['start_now']);
    for (const status of ['writing', 'publishing', 'published', 'rejected'] as const) {
      expect(actionsFor(detail({ status }))).toEqual([]);
    }
  });
});

describe('запросы и итоги', () => {
  const d = item({ title: 'Залог при аренде', version: 'V1' });

  it('решения по готовому ролику подписаны версией; одобрение и публикация — под замком', () => {
    expect(actionRequest('approve', d)).toEqual({ payload: { action: 'approve', id: 's1', version: 'V1' }, confirm: null, lock: true });
    expect(actionRequest('note', d, { text: '  короче  ' }).payload).toEqual({ action: 'note', id: 's1', version: 'V1', text: 'короче' });
    expect(actionRequest('redo', d).payload).toEqual({ action: 'redo', id: 's1', version: 'V1' });
    expect(actionRequest('reject', d).payload).toEqual({ action: 'reject', id: 's1', version: 'V1' });
    const pub = actionRequest('publish_now', d);
    expect(pub.payload).toEqual({ action: 'publish_now', id: 's1' });
    expect(pub.lock).toBe(true);
    expect(pub.confirm).toContain('Опубликовать ролик «Залог при аренде» сейчас?');
  });

  it('необратимое и тратящее Omni — с подтверждением, остальное — без', () => {
    for (const kind of ['redo', 'reject', 'publish_now', 'retry_directing'] as const) expect(actionRequest(kind, d).confirm).toBeTruthy();
    for (const kind of ['approve', 'note', 'retry', 'retry_writing', 'mark_published', 'start_now'] as const) {
      expect(actionRequest(kind, d).confirm).toBeNull();
    }
  });

  it('повтор — этап и необязательное замечание; ссылка на пост — без пробелов', () => {
    expect(actionRequest('retry', d, { note: '  ' }).payload).toEqual({ action: 'retry', id: 's1' });
    expect(actionRequest('retry_directing', d, { note: 'другой вопрос' }).payload)
      .toEqual({ action: 'retry', id: 's1', from: 'directing', note: 'другой вопрос' });
    expect(actionRequest('retry_writing', d).payload).toEqual({ action: 'retry', id: 's1', from: 'writing' });
    expect(actionRequest('mark_published', d, { url: ' https://t.me/ainomira/90 ' }).payload)
      .toEqual({ action: 'mark_published', id: 's1', url: 'https://t.me/ainomira/90' });
    expect(actionRequest('start_now', d).payload).toEqual({ action: 'start_now', id: 's1' });
  });

  it('итог словами; одобрение — когда выйдет', () => {
    expect(successText('approve', d, { slotAt: '2030-01-02T15:00:00.000Z' }, NOW)).toBe('Одобрено. Выйдет завтра в 18:00 МСК.');
    expect(successText('approve', d, null, NOW)).toBe('Одобрено.');
    expect(successText('retry', item({ failedFrom: 'publishing' }), null, NOW)).toBe('Публикация повторится в ближайшие 5 минут.');
    expect(successText('retry', item({ failedFrom: 'rendering' }), null, NOW)).toBe('Ролик снова в работе.');
  });

  it('ссылка на пост канала — как на бэке', () => {
    expect(isTelegramPostUrl('https://t.me/ainomira/90')).toBe(true);
    expect(isTelegramPostUrl('https://t.me/c/3046204962/90')).toBe(true);
    expect(isTelegramPostUrl('https://t.me/ainomira')).toBe(false);
    expect(isTelegramPostUrl('http://t.me/ainomira/90')).toBe(false);
  });
});

describe('настройки', () => {
  const s: ShortSettings = {
    slotDays: [1, 2, 3, 4, 5, 6, 7], slotHourMsk: 18, prepareLeadHours: 24, minAnswerChars: 400,
    tgChannelChatId: '-1003046204962', platforms: ['telegram', 'youtube'], narratorVoice: 'alena', format: 'skit',
    maxOmniSeconds: 48, youtubeMode: 'unlisted',
  };

  it('черновик туда и обратно — те же значения, без режима YouTube', () => {
    expect(draftErrors(toDraft(s))).toEqual({});
    expect(draftToPatch(toDraft(s))).toEqual({
      slotDays: [1, 2, 3, 4, 5, 6, 7], slotHourMsk: 18, prepareLeadHours: 24, minAnswerChars: 400,
      tgChannelChatId: '-1003046204962', platforms: ['telegram', 'youtube'], narratorVoice: 'alena', format: 'skit',
      maxOmniSeconds: 48,
    });
  });

  it('пределы — как у бэка; пустой канал — null; площадки — в порядке Telegram, YouTube', () => {
    const bad = {
      ...toDraft(s), slotDays: [], slotHourMsk: '24', platforms: [], maxOmniSeconds: '7', narratorVoice: ' ',
      minAnswerChars: '99', prepareLeadHours: '0', tgChannelChatId: '@ainomira',
    };
    expect(Object.keys(draftErrors(bad)).sort()).toEqual([
      'maxOmniSeconds', 'minAnswerChars', 'narratorVoice', 'platforms', 'prepareLeadHours', 'slotDays', 'slotHourMsk', 'tgChannelChatId',
    ]);
    expect(draftErrors({ ...toDraft(s), slotHourMsk: '' }).slotHourMsk).toBeTruthy();
    expect(draftToPatch({ ...toDraft(s), tgChannelChatId: '  ' }).tgChannelChatId).toBeNull();
    expect(draftToPatch({ ...toDraft(s), platforms: ['youtube', 'telegram'] }).platforms).toEqual(['telegram', 'youtube']);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortStatus.test.ts
```

Expected: FAIL, `actionsFor is not a function` и аналогичные ошибки.

- [ ] **Step 3: Дописать модуль**

В `src/components/admin/shortStatus.ts` импорт `realCaseChars` заменить на:

```ts
import { normalizeSlotDays, realCaseChars } from './blogStatus';
```

В конец файла:

```ts
export type ShortAction =
  | 'approve' | 'note' | 'redo' | 'reject' | 'publish_now'
  | 'retry' | 'retry_directing' | 'retry_writing' | 'mark_published' | 'start_now';

/** С каких этапов «Повторить» возвращает упавший ролик (RESUME_FROM бэка). */
const RESUMABLE: ShortStatus[] = ['directing', 'capturing', 'writing', 'animating', 'rendering'];

/**
 * Какие кнопки показать — по правилам бэка: «Переснять» и «Отклонить» не у
 * вышедшего хоть где-то; повтор публикации и «Пост вышел» — только у ролика,
 * который владелец одобрял; «Новый текст» — только при съёмке.
 */
export function actionsFor(
  d: Pick<ShortDetail, 'status' | 'failedFrom' | 'approvedAt' | 'publications' | 'capture'>,
): ShortAction[] {
  const released = isReleased(d);
  const leave: ShortAction[] = released ? [] : ['redo', 'reject'];
  switch (d.status) {
    case 'pending_review':
      return ['approve', 'note', ...leave];
    case 'approved':
      return ['publish_now', ...leave];
    case 'idea':
      return ['start_now'];
    case 'failed': {
      const reject: ShortAction[] = released ? [] : ['reject'];
      if (d.failedFrom === 'publishing') return d.approvedAt ? ['retry', 'mark_published', ...reject] : reject;
      if (!d.failedFrom) return reject;
      const out: ShortAction[] = [];
      if (RESUMABLE.includes(d.failedFrom)) out.push('retry');
      out.push('retry_directing');
      if (d.capture) out.push('retry_writing');
      return [...out, ...reject];
    }
    default:
      return [];
  }
}

/** Пост канала — как TG_POST_URL бэка (shorts.controller.ts). */
const TG_POST_URL = /^https:\/\/t\.me\/(?:c\/\d+|[A-Za-z0-9_]{3,32})\/(\d+)$/;

export function isTelegramPostUrl(url: string): boolean {
  return TG_POST_URL.test(url.trim());
}

export interface ActionExtra {
  /** Текст замечания к ролику на проверке. */
  text?: string;
  /** Ссылка на вышедший пост — для «Пост вышел». */
  url?: string;
  /** Необязательное замечание к повтору. */
  note?: string;
}

export interface ActionRequest {
  payload: Record<string, unknown>;
  /** Текст подтверждения; null — без него. */
  confirm: string | null;
  /** Под замком от двойного нажатия: одобрение и публикация. */
  lock: boolean;
}

type Target = Pick<ShortItem, 'id' | 'version' | 'title' | 'topicHint' | 'topicKey'>;

function named(d: Target): string {
  const chars = Array.from(shortTitle(d));
  return `ролик «${chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : chars.join('')}»`;
}

/** Запрос решения. Решения по готовому ролику подписаны версией той карточки, что видел владелец. */
export function actionRequest(kind: ShortAction, d: Target, extra: ActionExtra = {}): ActionRequest {
  const note = extra.note?.trim() ? { note: extra.note.trim() } : {};
  switch (kind) {
    case 'approve':
      return { payload: { action: 'approve', id: d.id, version: d.version }, confirm: null, lock: true };
    case 'note':
      return { payload: { action: 'note', id: d.id, version: d.version, text: (extra.text ?? '').trim() }, confirm: null, lock: false };
    case 'redo':
      return {
        payload: { action: 'redo', id: d.id, version: d.version },
        confirm: `Переснять ${named(d)}?\n\nБудет новая сцена на ту же тему — это снова секунды Omni. Текущая версия пропадёт.`,
        lock: false,
      };
    case 'reject':
      return {
        payload: { action: 'reject', id: d.id, version: d.version },
        confirm: `Отклонить ${named(d)}?\n\nРолик не выйдет, вернуть его нельзя.`,
        lock: false,
      };
    case 'publish_now':
      return {
        payload: { action: 'publish_now', id: d.id },
        confirm: `Опубликовать ${named(d)} сейчас?\n\nРолик уйдёт на площадки в ближайшие 5 минут. Отменить публикацию нельзя.`,
        lock: true,
      };
    case 'retry':
      return { payload: { action: 'retry', id: d.id, ...note }, confirm: null, lock: false };
    case 'retry_directing':
      return {
        payload: { action: 'retry', id: d.id, from: 'directing', ...note },
        confirm: `Переснять ${named(d)} с новой сценой?\n\nРежиссёр придумает сцену заново — это снова секунды Omni.`,
        lock: false,
      };
    case 'retry_writing':
      return { payload: { action: 'retry', id: d.id, from: 'writing', ...note }, confirm: null, lock: false };
    case 'mark_published':
      return { payload: { action: 'mark_published', id: d.id, url: (extra.url ?? '').trim() }, confirm: null, lock: false };
    case 'start_now':
      return { payload: { action: 'start_now', id: d.id }, confirm: null, lock: false };
  }
}

/** Итог удачного решения — плашкой над списком: карточка после него закрывается. */
export function successText(kind: ShortAction, d: Pick<ShortItem, 'failedFrom'>, res: unknown, now: Date): string {
  switch (kind) {
    case 'approve': {
      const slotAt = (res as { slotAt?: unknown } | null)?.slotAt;
      return typeof slotAt === 'string' ? `Одобрено. Выйдет ${formatSlotAt(slotAt, now)}.` : 'Одобрено.';
    }
    case 'note':
      return 'Замечание принято: ролик ушёл на переписку, новая версия придёт сюда и в личку.';
    case 'redo':
      return 'Пересниму: новая сцена на ту же тему. Новая версия придёт сюда и в личку.';
    case 'reject':
      return 'Ролик отклонён.';
    case 'publish_now':
      return 'Ролик уйдёт на площадки в ближайшие 5 минут.';
    case 'retry':
      return d.failedFrom === 'publishing' ? 'Публикация повторится в ближайшие 5 минут.' : 'Ролик снова в работе.';
    case 'retry_directing':
      return 'Ролик снова в работе: режиссёр придумает новую сцену.';
    case 'retry_writing':
      return 'Ролик снова в работе: сценарист напишет новый текст по той же съёмке.';
    case 'mark_published':
      return 'Пост отмечен вышедшим — остальные площадки публикатор доделает сам.';
    case 'start_now':
      return 'Ролик запущен: появится в «Ждут решения», когда соберётся.';
  }
}

/** Черновик формы настроек: числа — строками, как их набирает человек. */
export interface SettingsDraft {
  slotDays: number[];
  slotHourMsk: string;
  format: ShortFormat;
  platforms: ShortPlatform[];
  maxOmniSeconds: string;
  narratorVoice: string;
  minAnswerChars: string;
  prepareLeadHours: string;
  tgChannelChatId: string;
}

/** Площадки этого экрана в каноническом порядке: VK ещё не готов (SUPPORTED_PLATFORMS бэка). */
export const SETTINGS_PLATFORMS: ShortPlatform[] = ['telegram', 'youtube'];

export function toDraft(s: ShortSettings): SettingsDraft {
  return {
    slotDays: [...s.slotDays],
    slotHourMsk: String(s.slotHourMsk),
    format: s.format,
    platforms: SETTINGS_PLATFORMS.filter((p) => s.platforms.includes(p)),
    maxOmniSeconds: String(s.maxOmniSeconds),
    narratorVoice: s.narratorVoice,
    minAnswerChars: String(s.minAnswerChars),
    prepareLeadHours: String(s.prepareLeadHours),
    tgChannelChatId: s.tgChannelChatId ?? '',
  };
}

/** Целое в пределах. Пустая строка — не ноль: стёртое поле не должно молча значить «0». */
const intIn = (raw: string, min: number, max: number): boolean =>
  /^\d+$/.test(raw.trim()) && Number(raw) >= min && Number(raw) <= max;

/** Ошибки до отправки — те же пределы, что у validateSettingsPatch бэка. Пусто — можно сохранять. */
export function draftErrors(d: SettingsDraft): Partial<Record<keyof SettingsDraft, string>> {
  const e: Partial<Record<keyof SettingsDraft, string>> = {};
  if (!d.slotDays.length) e.slotDays = 'Нужен хотя бы один день.';
  if (!intIn(d.slotHourMsk, 0, 23)) e.slotHourMsk = 'Целое число от 0 до 23.';
  if (!d.platforms.length) e.platforms = 'Нужна хотя бы одна площадка.';
  if (!intIn(d.maxOmniSeconds, 8, 400)) e.maxOmniSeconds = 'Целое число от 8 до 400: клип Omni — 8 секунд.';
  if (!d.narratorVoice.trim()) e.narratorVoice = 'Голос SpeechKit, например alena.';
  if (!intIn(d.minAnswerChars, 100, 5000)) e.minAnswerChars = 'Целое число от 100 до 5000.';
  if (!intIn(d.prepareLeadHours, 1, 96)) e.prepareLeadHours = 'Целое число от 1 до 96.';
  const ch = d.tgChannelChatId.trim();
  if (ch && !/^-100\d{6,}$/.test(ch)) e.tgChannelChatId = 'Числовой id канала вида -100… или пусто.';
  return e;
}

/** Тело update_settings: все поля, кроме режима YouTube — его меняет своя кнопка. */
export function draftToPatch(d: SettingsDraft): Omit<ShortSettings, 'youtubeMode'> {
  return {
    slotDays: normalizeSlotDays(d.slotDays),
    slotHourMsk: Number(d.slotHourMsk),
    prepareLeadHours: Number(d.prepareLeadHours),
    minAnswerChars: Number(d.minAnswerChars),
    tgChannelChatId: d.tgChannelChatId.trim() || null,
    platforms: SETTINGS_PLATFORMS.filter((p) => d.platforms.includes(p)),
    narratorVoice: d.narratorVoice.trim(),
    format: d.format,
    maxOmniSeconds: Number(d.maxOmniSeconds),
  };
}
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortStatus.test.ts
git branch --show-current
git add src/components/admin/shortStatus.ts src/components/admin/shortStatus.test.ts
git commit -m "admin: ролики — кнопки по статусу, запросы решений с версией, итоги, черновик настроек"
```

Expected: PASS, 19 тестов.

---

### Task 12: `shortsApi.ts`

**Files:**
- Create: `src/components/admin/shortsApi.ts`
- Test: `src/components/admin/shortsApi.test.ts`

- [ ] **Step 1: Написать падающий тест**

`src/components/admin/shortsApi.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { post, get } }));

import { ShortsApiError, callShorts, loadAgents } from './shortsApi';

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe('callShorts', () => {
  it('шлёт действие в admin/shorts и отдаёт тело', async () => {
    post.mockResolvedValue(res(200, [{ id: 's1' }]));
    expect(await callShorts({ action: 'list' })).toEqual([{ id: 's1' }]);
    expect(post).toHaveBeenCalledWith('/webhook/admin/shorts', { action: 'list' });
  });

  it('отказ — текст сервера, код ответа и машинный код', async () => {
    post.mockResolvedValue(res(409, {
      statusCode: 409, error: 'version_conflict', message: 'Ролик изменился, пока был открыт: на экране устаревшая версия',
    }));
    const e = await callShorts({ action: 'approve' }).catch((x) => x);
    expect(e).toBeInstanceOf(ShortsApiError);
    expect(e).toMatchObject({ status: 409, code: 'version_conflict', message: 'Ролик изменился, пока был открыт: на экране устаревшая версия' });
  });

  it('тело не json — «сервер ответил N»', async () => {
    post.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError('html'); } });
    await expect(callShorts({ action: 'list' })).rejects.toMatchObject({ status: 502, message: 'сервер ответил 502' });
  });
});

describe('loadAgents', () => {
  it('активные ассистенты на русском; кривые строки и сбой — мимо', async () => {
    get.mockResolvedValue(res(200, [{ id: 10, name: 'Алексей', displayName: 'Алексей — юрист' }, { id: 'x' }]));
    expect(await loadAgents()).toEqual([{ id: 10, name: 'Алексей', displayName: 'Алексей — юрист' }]);
    expect(get).toHaveBeenCalledWith('/webhook/agents?lang=ru');
    get.mockRejectedValue(new Error('offline'));
    expect(await loadAgents()).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortsApi.test.ts
```

Expected: FAIL, `Failed to resolve import "./shortsApi"`.

- [ ] **Step 3: Написать модуль**

`src/components/admin/shortsApi.ts`:

```ts
import { apiClient } from '../../services/apiClient';

/**
 * Ошибка `admin/shorts` с кодом ответа и машинным кодом из поля `error` тела:
 * `version_conflict` — ролик изменился, пока был открыт. Текст — всегда с
 * сервера: только он знает, что разошлось.
 */
export class ShortsApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ShortsApiError';
  }
}

/** Как readError вкладки «Блог»: причина — в `message` (строкой или массивом), код — в `error`. */
const readError = async (r: Response): Promise<{ message: string | null; code: string | null }> => {
  try {
    const body = await r.json();
    const code = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null;
    const m = body?.message;
    if (Array.isArray(m) && m.length) return { message: m.join('; '), code };
    if (typeof m === 'string' && m.trim()) return { message: m.trim(), code };
    return { message: code, code };
  } catch {
    // Тело не json (прокси, html-заглушка) — останется код ответа.
    return { message: null, code: null };
  }
};

export async function callShorts<T = any>(payload: Record<string, unknown>): Promise<T> {
  const r = await apiClient.post('/webhook/admin/shorts', payload);
  if (!r.ok) {
    const { message, code } = await readError(r);
    throw new ShortsApiError(message || `сервер ответил ${r.status}`, r.status, code);
  }
  return r.json();
}

export interface AgentOption {
  id: number;
  name: string;
  displayName: string;
}

/** Активные ассистенты для заказа — тот же список, что видит кабинет. Сбой — пустой список: «Любой» остаётся. */
export async function loadAgents(): Promise<AgentOption[]> {
  try {
    const r = await apiClient.get('/webhook/agents?lang=ru');
    if (!r.ok) return [];
    const rows: unknown = await r.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((a) => a && Number.isInteger(Number(a.id)))
      .map((a) => ({ id: Number(a.id), name: String(a.name ?? ''), displayName: String(a.displayName ?? a.name ?? a.id) }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortsApi.test.ts
git branch --show-current
git add src/components/admin/shortsApi.ts src/components/admin/shortsApi.test.ts
git commit -m "admin: ролики — вызовы admin/shorts с причиной отказа и список ассистентов"
```

Expected: PASS, 4 теста.

---

### Task 13: `ShortsOrderForm.tsx` и Вебвизор

**Files:**
- Create: `src/components/admin/ShortsOrderForm.tsx`
- Test: `src/components/admin/ShortsOrderForm.test.tsx`
- Modify: `src/components/webvisorPrivacy.test.ts`

- [ ] **Step 1: Написать падающие тесты**

`src/components/admin/ShortsOrderForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { clickAsync, flush, mount, type, Mounted } from '../../test/dom';
import ShortsOrderForm from './ShortsOrderForm';

const agents = [{ id: 10, name: 'Алексей', displayName: 'Алексей — юрист' }];
let m: Mounted;
afterEach(() => m?.unmount());
const q = (id: string) => m.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const choose = (id: string, value: string) => {
  const el = q(id) as HTMLSelectElement;
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('заказ ролика', () => {
  it('тема одной строкой; «Заказать» — от 10 знаков; после заказа поле пустеет', async () => {
    const onOrder = vi.fn(async () => true);
    m = mount(<ShortsOrderForm agents={agents} busy={false} onOrder={onOrder} onRefill={vi.fn()} />);
    const submit = q('shorts-order-submit') as HTMLButtonElement;
    type(q('shorts-order-topic')!, 'коротко');
    expect(submit.disabled).toBe(true);
    type(q('shorts-order-topic')!, 'Разнос плохого договора аренды');
    expect(submit.disabled).toBe(false);
    await clickAsync(submit);
    // Ответ onOrder и очистка поля — ещё пара оборотов микрозадач после клика.
    await flush();
    await flush();
    expect(onOrder).toHaveBeenCalledWith({ action: 'order', topic: 'Разнос плохого договора аренды', rubric: 'assistant' });
    expect((q('shorts-order-topic') as HTMLInputElement).value).toBe('');
  });

  it('подача и ассистент уходят, только если выбраны', async () => {
    const onOrder = vi.fn(async () => true);
    m = mount(<ShortsOrderForm agents={agents} busy={false} onOrder={onOrder} onRefill={vi.fn()} />);
    type(q('shorts-order-topic')!, 'Разнос плохого договора аренды');
    choose('shorts-order-angle', 'roast');
    choose('shorts-order-assistant', '10');
    await clickAsync(q('shorts-order-submit')!);
    expect(onOrder).toHaveBeenCalledWith({
      action: 'order', topic: 'Разнос плохого договора аренды', rubric: 'assistant', angle: 'roast', assistantId: 10,
    });
  });

  it('«Реальный кейс» — многострочная история со счётчиком; сверх 4000 знаков — не отправить', () => {
    m = mount(<ShortsOrderForm agents={[]} busy={false} onOrder={vi.fn(async () => true)} onRefill={vi.fn()} />);
    choose('shorts-order-rubric', 'case');
    expect(q('shorts-order-topic')).toBeNull();
    type(q('shorts-order-story')!, 'одна\nдве');
    expect(q('shorts-order-count')!.textContent).toBe('8 / 4000');
    type(q('shorts-order-story')!, 'я'.repeat(4001));
    expect((q('shorts-order-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('«Пополнить темы недели» зовёт пополнение', async () => {
    const onRefill = vi.fn();
    m = mount(<ShortsOrderForm agents={[]} busy={false} onOrder={vi.fn(async () => true)} onRefill={onRefill} />);
    await clickAsync(q('shorts-refill')!);
    expect(onRefill).toHaveBeenCalledTimes(1);
  });
});
```

В `src/components/webvisorPrivacy.test.ts` после строки `const TokenPackages = …`:

```ts
const ShortsOrderForm = readFileSync(join(__dirname, 'admin', 'ShortsOrderForm.tsx'), 'utf8');
```

и последним тестом внутри `describe('поля ввода сообщений скрыты от записи Вебвизора (ym-disable-keys)', …)`:

```ts
  it('админка роликов — история реального кейса в заказе', () => {
    expect(classesOf(ShortsOrderForm, 'shorts-order-story', 'textarea')).toContain('ym-disable-keys');
  });
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortsOrderForm.test.tsx src/components/webvisorPrivacy.test.ts
```

Expected: FAIL. Нет `./ShortsOrderForm`, `readFileSync` падает с ENOENT.

- [ ] **Step 3: Написать форму**

`src/components/admin/ShortsOrderForm.tsx`:

```tsx
import React, { useState } from 'react';
import { clsx } from 'clsx';
import type { AgentOption } from './shortsApi';
import {
  ANGLES, ANGLE_TITLES, MAX_ORDER_CHARS, MIN_ORDER_CHARS, RUBRICS, RUBRIC_TITLES, ShortAngle, ShortRubric, orderChars,
} from './shortStatus';

interface Props {
  agents: AgentOption[];
  busy: boolean;
  /** true — заказ принят (или такой уже был), поле можно чистить. */
  onOrder: (payload: Record<string, unknown>) => Promise<boolean>;
  onRefill: () => void;
}

const toRubric = (v: string): ShortRubric => (RUBRICS.includes(v as ShortRubric) ? (v as ShortRubric) : 'assistant');
const toAngle = (v: string): ShortAngle | '' => (ANGLES.includes(v as ShortAngle) ? (v as ShortAngle) : '');

const FIELD = 'border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-forest-500';

/**
 * Заказ ролика — как «Своя тема» у постов: тема одной строкой или история
 * реального кейса, рубрика, подача (по умолчанию — ритм недели) и ассистент
 * (по умолчанию — любой). Ложится идеей; запустить сразу — «Запустить сейчас»
 * в её строке.
 */
const ShortsOrderForm: React.FC<Props> = ({ agents, busy, onOrder, onRefill }) => {
  const [topic, setTopic] = useState('');
  // История — своё поле: однострочный input вырезает переносы, и при смене
  // рубрики абзацы истории склеились бы молча (как у реального кейса блога).
  const [story, setStory] = useState('');
  const [rubric, setRubric] = useState<ShortRubric>('assistant');
  const [angle, setAngle] = useState<ShortAngle | ''>('');
  const [assistantId, setAssistantId] = useState('');
  const isCase = rubric === 'case';
  const text = isCase ? story : topic;
  const n = orderChars(text);
  const ok = n >= MIN_ORDER_CHARS && n <= MAX_ORDER_CHARS;

  const submit = async () => {
    if (!ok || busy) return;
    const sent = text;
    const payload: Record<string, unknown> = { action: 'order', topic: sent.trim(), rubric };
    if (angle) payload.angle = angle;
    if (assistantId) payload.assistantId = Number(assistantId);
    // Пока шёл запрос, поле редактируемо: стираем, только если текст не меняли.
    const clear = (cur: string) => (cur === sent ? '' : cur);
    if (await onOrder(payload)) (isCase ? setStory : setTopic)(clear);
  };

  return (
    <div data-testid="shorts-order" className="mb-4 bg-white border border-gray-200 rounded-lg p-3 space-y-2">
      <div className="text-sm font-medium text-gray-700">Заказать ролик</div>
      {isCase ? (
        <div>
          <textarea
            data-testid="shorts-order-story"
            value={story}
            onChange={(e) => setStory(e.target.value)}
            rows={5}
            placeholder="История: кто, что случилось, что сделал ассистент, чем кончилось — без имён, организаций и сумм"
            aria-label="История реального кейса"
            className="ym-disable-keys w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-forest-500"
          />
          <div
            data-testid="shorts-order-count"
            className={clsx('text-xs text-right', n > MAX_ORDER_CHARS ? 'text-red-600' : 'text-gray-500')}
          >
            {n} / {MAX_ORDER_CHARS}
          </div>
        </div>
      ) : (
        <input
          data-testid="shorts-order-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Тема ролика одной строкой"
          aria-label="Тема ролика"
          className={clsx(FIELD, 'w-full')}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <select
          data-testid="shorts-order-rubric"
          value={rubric}
          aria-label="Рубрика"
          onChange={(e) => setRubric(toRubric(e.target.value))}
          className={clsx(FIELD, 'bg-white')}
        >
          {RUBRICS.map((r) => (
            <option key={r} value={r}>{RUBRIC_TITLES[r]}</option>
          ))}
        </select>
        <select
          data-testid="shorts-order-angle"
          value={angle}
          aria-label="Подача"
          onChange={(e) => setAngle(toAngle(e.target.value))}
          className={clsx(FIELD, 'bg-white')}
        >
          <option value="">По ритму недели</option>
          {ANGLES.map((a) => (
            <option key={a} value={a}>{ANGLE_TITLES[a]}</option>
          ))}
        </select>
        <select
          data-testid="shorts-order-assistant"
          value={assistantId}
          aria-label="Ассистент"
          onChange={(e) => setAssistantId(e.target.value)}
          className={clsx(FIELD, 'bg-white')}
        >
          <option value="">Любой ассистент</option>
          {agents.map((a) => (
            <option key={a.id} value={String(a.id)}>{a.displayName}</option>
          ))}
        </select>
        <button
          type="button"
          data-testid="shorts-order-submit"
          onClick={submit}
          disabled={busy || !ok}
          className="px-4 py-2 bg-forest-600 text-white text-sm font-medium rounded-md hover:bg-forest-700 disabled:opacity-50"
        >
          Заказать
        </button>
        <button
          type="button"
          data-testid="shorts-refill"
          onClick={onRefill}
          disabled={busy}
          title="Каталог тем на неделю сейчас, не дожидаясь воскресенья"
          className="ml-auto px-3 py-2 bg-white text-gray-600 text-sm rounded-md border border-gray-200 hover:border-forest-300 disabled:opacity-50"
        >
          Пополнить темы недели
        </button>
      </div>
      {n > 0 && n < MIN_ORDER_CHARS && (
        <div className="text-xs text-gray-500">Тема — от {MIN_ORDER_CHARS} знаков.</div>
      )}
    </div>
  );
};

export default ShortsOrderForm;
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortsOrderForm.test.tsx src/components/webvisorPrivacy.test.ts
git branch --show-current
git add src/components/admin/ShortsOrderForm.tsx src/components/admin/ShortsOrderForm.test.tsx src/components/webvisorPrivacy.test.ts
git commit -m "admin: ролики — заказ ролика и пополнение тем; история кейса скрыта от Вебвизора"
```

Expected: PASS обоих файлов.

---

### Task 14: `ShortsSettingsForm.tsx`

**Files:**
- Create: `src/components/admin/ShortsSettingsForm.tsx`
- Test: `src/components/admin/ShortsSettingsForm.test.tsx`

- [ ] **Step 1: Написать падающий тест**

`src/components/admin/ShortsSettingsForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { click, clickAsync, flush, mount, type, Mounted } from '../../test/dom';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { post } }));

import ShortsSettingsForm from './ShortsSettingsForm';

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settings = {
  slotDays: [1, 2, 3, 4, 5, 6, 7], slotHourMsk: 18, prepareLeadHours: 24, minAnswerChars: 400,
  tgChannelChatId: '-1003046204962', platforms: ['telegram', 'youtube'], narratorVoice: 'alena', format: 'skit',
  maxOmniSeconds: 48, youtubeMode: 'unlisted',
};

let m: Mounted;
const q = (id: string) => m.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** Цепочка post → json → setState — несколько оборотов микрозадач. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

beforeEach(() => {
  post.mockReset();
  post.mockImplementation(async (_url: string, p: any) => {
    if (p.action === 'get_settings') return res(200, settings);
    if (p.action === 'update_settings') return res(200, { ...settings, ...p.settings });
    throw new Error(`неожиданное действие ${p.action}`);
  });
});
afterEach(() => m?.unmount());

describe('настройки роликов', () => {
  it('сохраняет все поля, кроме режима YouTube; числа — числами', async () => {
    m = mount(<ShortsSettingsForm />);
    await settle();
    type(q('shorts-hour')!, '19');
    click(q('shorts-day-7')!);
    await clickAsync(q('shorts-save-settings')!);
    await settle();
    expect(post).toHaveBeenLastCalledWith('/webhook/admin/shorts', {
      action: 'update_settings',
      settings: {
        slotDays: [1, 2, 3, 4, 5, 6], slotHourMsk: 19, prepareLeadHours: 24, minAnswerChars: 400,
        tgChannelChatId: '-1003046204962', platforms: ['telegram', 'youtube'], narratorVoice: 'alena', format: 'skit',
        maxOmniSeconds: 48,
      },
    });
    expect(q('shorts-settings-notice')!.textContent).toBe('Настройки сохранены');
  });

  it('кривой час — «Сохранить» гаснет, причина под полем', async () => {
    m = mount(<ShortsSettingsForm />);
    await settle();
    type(q('shorts-hour')!, '24');
    expect((q('shorts-save-settings') as HTMLButtonElement).disabled).toBe(true);
    expect(m.container.textContent).toContain('Целое число от 0 до 23.');
  });

  it('режим YouTube показан; «Перевести в ручной» — с подтверждением и только режимом', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    m = mount(<ShortsSettingsForm />);
    await settle();
    expect(q('shorts-youtube-mode')!.textContent).toBe('по ссылке');
    await clickAsync(q('shorts-youtube-manual')!);
    await settle();
    expect(confirm).toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith('/webhook/admin/shorts', { action: 'update_settings', settings: { youtubeMode: 'manual' } });
    expect(q('shorts-youtube-manual')).toBeNull();
    confirm.mockRestore();
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortsSettingsForm.test.tsx
```

Expected: FAIL, `Failed to resolve import "./ShortsSettingsForm"`.

- [ ] **Step 3: Написать форму**

`src/components/admin/ShortsSettingsForm.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Loader } from 'lucide-react';
import { SLOT_DAYS } from './blogStatus';
import { callShorts } from './shortsApi';
import {
  PLATFORM_TITLES, SETTINGS_PLATFORMS, SettingsDraft, ShortFormat, ShortSettings, YOUTUBE_MODE_TITLES,
  draftErrors, draftToPatch, toDraft,
} from './shortStatus';

const FORMAT_BUTTONS: { value: ShortFormat; label: string }[] = [
  { value: 'skit', label: 'Сценки' },
  { value: 'chat', label: 'Только чат' },
];
const FIELD = 'mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-forest-500';
const pill = (on: boolean) =>
  clsx(
    'px-3 py-1.5 text-sm font-medium rounded-md border transition-colors',
    on ? 'bg-forest-600 text-white border-forest-600' : 'bg-white text-gray-600 border-gray-300 hover:border-forest-300',
  );
const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

const Hint: React.FC<{ text?: string }> = ({ text }) =>
  text ? <span className="mt-1 block text-xs text-rose-600">{text}</span> : null;

/**
 * Настройки роликов (`get_settings` / `update_settings`). Режим YouTube только
 * показан: включить загрузку можно лишь командой /youtube в боте (спека
 * YouTube, бэк иное отклоняет), а отсюда — только аварийный перевод в ручной.
 */
const ShortsSettingsForm: React.FC = () => {
  const [saved, setSaved] = useState<ShortSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = (s: ShortSettings) => {
    setSaved(s);
    setDraft(toDraft(s));
  };

  useEffect(() => {
    let alive = true;
    callShorts<ShortSettings>({ action: 'get_settings' })
      .then((s) => {
        if (alive) apply(s);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error && e.message ? e.message : 'не загрузил настройки');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (settings: object, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      apply(await callShorts<ShortSettings>({ action: 'update_settings', settings }));
      setNotice(done);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'неизвестная ошибка');
    } finally {
      setBusy(false);
    }
  };

  if (!draft || !saved) {
    return (
      <div data-testid="shorts-settings" className="mb-4 bg-white border border-gray-200 rounded-lg p-4 text-sm">
        {error ? (
          <span className="text-rose-700">{error}</span>
        ) : (
          <span className="flex items-center gap-2 text-gray-500">
            <Loader className="w-4 h-4 animate-spin" />
            Загружаю настройки…
          </span>
        )}
      </div>
    );
  }

  const errors = draftErrors(draft);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft({ ...draft, [key]: value });
  const toManual = () => {
    const ask =
      'Перевести YouTube в ручной режим? Ролики перестанут загружаться сами — в личку будет приходить набор для выкладки. ' +
      'Включить загрузку снова — командой /youtube в боте.';
    if (window.confirm(ask)) save({ youtubeMode: 'manual' }, 'YouTube переведён в ручной режим');
  };

  return (
    <div data-testid="shorts-settings" className="mb-4 space-y-4 max-w-lg bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-sm font-medium text-gray-700">Настройки роликов</div>

      <div className="text-sm">
        <span className="text-gray-600">Дни слотов</span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {SLOT_DAYS.map((d) => {
            const on = draft.slotDays.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                data-testid={`shorts-day-${d.value}`}
                aria-pressed={on}
                onClick={() => set('slotDays', toggleIn(draft.slotDays, d.value))}
                className={clsx(
                  'w-11 py-1.5 text-sm font-medium rounded-md border transition-colors',
                  on ? 'bg-forest-600 text-white border-forest-600' : 'bg-white text-gray-600 border-gray-300 hover:border-forest-300',
                )}
              >
                {d.label}
              </button>
            );
          })}
        </div>
        <Hint text={errors.slotDays} />
      </div>

      <label className="block text-sm">
        <span className="text-gray-600">Час слота по Москве</span>
        <input data-testid="shorts-hour" type="number" min={0} max={23} step={1} value={draft.slotHourMsk}
          onChange={(e) => set('slotHourMsk', e.target.value)} className={FIELD} />
        <Hint text={errors.slotHourMsk} />
      </label>

      <div className="text-sm">
        <span className="text-gray-600">Формат новых роликов</span>
        <div className="mt-1 flex gap-1.5">
          {FORMAT_BUTTONS.map((f) => (
            <button key={f.value} type="button" data-testid={`shorts-format-${f.value}`} aria-pressed={draft.format === f.value}
              onClick={() => set('format', f.value)} className={pill(draft.format === f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="text-sm">
        <span className="text-gray-600">Площадки</span>
        <div className="mt-1 flex gap-1.5">
          {SETTINGS_PLATFORMS.map((p) => (
            <button key={p} type="button" data-testid={`shorts-platform-${p}`} aria-pressed={draft.platforms.includes(p)}
              onClick={() => set('platforms', toggleIn(draft.platforms, p))} className={pill(draft.platforms.includes(p))}>
              {PLATFORM_TITLES[p]}
            </button>
          ))}
        </div>
        <Hint text={errors.platforms} />
      </div>

      <label className="block text-sm">
        <span className="text-gray-600">Предел секунд Omni на ролик (клип — 8 с)</span>
        <input data-testid="shorts-max-omni" type="number" min={8} max={400} step={8} value={draft.maxOmniSeconds}
          onChange={(e) => set('maxOmniSeconds', e.target.value)} className={FIELD} />
        <Hint text={errors.maxOmniSeconds} />
      </label>

      <label className="block text-sm">
        <span className="text-gray-600">Голос финала (SpeechKit)</span>
        <input data-testid="shorts-voice" value={draft.narratorVoice}
          onChange={(e) => set('narratorVoice', e.target.value)} className={FIELD} />
        <Hint text={errors.narratorVoice} />
      </label>

      <label className="block text-sm">
        <span className="text-gray-600">Порог длины ответа ассистента, знаков</span>
        <input data-testid="shorts-min-answer" type="number" min={100} max={5000} step={50} value={draft.minAnswerChars}
          onChange={(e) => set('minAnswerChars', e.target.value)} className={FIELD} />
        <Hint text={errors.minAnswerChars} />
      </label>

      <label className="block text-sm">
        <span className="text-gray-600">Готовить ролик за, часов до слота</span>
        <input data-testid="shorts-lead" type="number" min={1} max={96} step={1} value={draft.prepareLeadHours}
          onChange={(e) => set('prepareLeadHours', e.target.value)} className={FIELD} />
        <Hint text={errors.prepareLeadHours} />
      </label>

      <label className="block text-sm">
        <span className="text-gray-600">Канал Telegram (id вида -100…)</span>
        <input data-testid="shorts-channel" value={draft.tgChannelChatId}
          onChange={(e) => set('tgChannelChatId', e.target.value)} className={FIELD} />
        <Hint text={errors.tgChannelChatId} />
      </label>

      <div className="text-sm">
        <span className="text-gray-600">YouTube: </span>
        <span data-testid="shorts-youtube-mode" className="font-medium">{YOUTUBE_MODE_TITLES[saved.youtubeMode]}</span>
        <span className="block text-xs text-gray-500">Включить загрузку — командой /youtube в боте.</span>
        {saved.youtubeMode !== 'manual' && (
          <button type="button" data-testid="shorts-youtube-manual" onClick={toManual} disabled={busy}
            className="mt-1 px-3 py-1 text-xs bg-rose-50 text-rose-700 rounded hover:bg-rose-100 disabled:opacity-50">
            Перевести в ручной
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="button" data-testid="shorts-save-settings" onClick={() => save(draftToPatch(draft), 'Настройки сохранены')}
          disabled={busy || !valid}
          className="px-4 py-2 bg-forest-600 text-white text-sm font-medium rounded-md hover:bg-forest-700 disabled:opacity-50">
          Сохранить
        </button>
        {notice && <span data-testid="shorts-settings-notice" className="text-sm text-green-700">{notice}</span>}
      </div>
      {error && <div data-testid="shorts-settings-error" className="text-sm text-rose-700">{error}</div>}
    </div>
  );
};

export default ShortsSettingsForm;
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortsSettingsForm.test.tsx
git branch --show-current
git add src/components/admin/ShortsSettingsForm.tsx src/components/admin/ShortsSettingsForm.test.tsx
git commit -m "admin: ролики — настройки; режим YouTube только показан, аварийно — в ручной"
```

Expected: PASS, 3 теста.

---

### Task 15: `ShortCard.tsx` и `ShortActions.tsx`

**Files:**
- Create: `src/components/admin/ShortActions.tsx`, `src/components/admin/ShortCard.tsx`
- Test: `src/components/admin/ShortCard.test.tsx`

- [ ] **Step 1: Написать падающий тест**

`src/components/admin/ShortCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { click, mount, type, Mounted } from '../../test/dom';
import ShortCard from './ShortCard';
import { NOW, detail as baseDetail, item } from './shortFixtures';

const detail = (over: Parameters<typeof baseDetail>[0] = {}) =>
  baseDetail({
    title: 'Залог при аренде', durationMs: 44000, animation: { omniSeconds: 16 },
    captions: { telegram: 'Подпись в канал', youtube: { title: 'Заголовок YouTube' } },
    script: { hook: 'Зацепка', lines: [{ id: 'l1', scene: 'answer', text: 'Реплика' }] },
    videoUrl: 'https://my.linkeon.io/smm-media/linkeon-smm-videos/shorts/s1/video.mp4?v=V1',
    coverUrl: 'https://my.linkeon.io/smm-media/linkeon-smm-videos/shorts/s1/cover.jpg?v=V1',
    ...over,
  });

let m: Mounted;
afterEach(() => m?.unmount());
const q = (id: string) => m.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const render = (props: Partial<ComponentProps<typeof ShortCard>> = {}) => {
  const onAction = vi.fn();
  const onToggle = vi.fn();
  m = mount(
    <ShortCard item={item()} assistantName="Алексей — юрист" open={false} detail={null} detailLoading={false}
      detailError={null} busy={false} now={NOW} onToggle={onToggle} onAction={onAction} {...props} />,
  );
  return { onAction, onToggle };
};

describe('строка ролика', () => {
  it('статус, название, рубрика, подача, ассистент, формат, когда; детали скрыты', () => {
    render({ item: item({ title: 'Залог при аренде', slotAt: '2030-01-02T15:00:00.000Z' }) });
    const text = m.container.textContent!;
    expect(text).toContain('Ждёт решения');
    expect(text).toContain('Залог при аренде');
    expect(text).toContain('Ассистент за работой · Разнос · Алексей — юрист · сценки');
    expect(q('short-line-s1')!.textContent).toBe('под слот завтра в 18:00 МСК');
    expect(q('short-details-s1')).toBeNull();
  });

  it('идея — «Запустить сейчас» прямо в строке; подача по ритму, если не задана', () => {
    const { onAction } = render({ item: item({ status: 'idea', angleLocked: false }) });
    expect(m.container.textContent).toContain('подача по ритму недели');
    click(q('short-start-s1')!);
    expect(onAction).toHaveBeenCalledWith('start_now');
  });

  it('площадки — ссылка на вышедшее, причина у упавшего', () => {
    render({
      item: item({
        status: 'published',
        publications: [
          { platform: 'telegram', status: 'published', url: 'https://t.me/ainomira/90', lastError: null },
          { platform: 'youtube', status: 'failed', url: null, lastError: 'quota' },
        ],
      }),
    });
    expect(q('short-pub-s1-telegram')!.getAttribute('href')).toBe('https://t.me/ainomira/90');
    expect(q('short-pub-s1-youtube')!.textContent).toBe('YouTube: упал');
    expect(q('short-pub-s1-youtube')!.getAttribute('title')).toBe('quota');
  });
});

describe('раскрытая карточка', () => {
  it('видео грузится только по нажатию; подпись в канал, сценарий, цифры', () => {
    render({ open: true, detail: detail() });
    const video = q('short-video-s1') as HTMLVideoElement;
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('src')).toBe(detail().videoUrl);
    expect(video.getAttribute('poster')).toBe(detail().coverUrl);
    expect(m.container.textContent).toContain('Подпись в канал');
    expect(m.container.textContent).toContain('Зацепка');
    expect(q('short-stats-s1')!.textContent).toBe('44 с · Omni: 16 с');
  });

  it('видео не загрузилось — ссылка на файл', () => {
    render({ open: true, detail: detail() });
    act(() => {
      q('short-video-s1')!.dispatchEvent(new Event('error'));
    });
    expect(q('short-video-broken-s1')!.querySelector('a')!.getAttribute('href')).toBe(detail().videoUrl);
  });

  it('ждёт решения — кнопки решения; пустое замечание не отправить', () => {
    const { onAction } = render({ open: true, detail: detail({ status: 'pending_review' }) });
    expect(q('short-approve')).toBeTruthy();
    expect(q('short-publish-now')).toBeNull();
    const send = q('short-send-note') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(q('short-note')!, 'короче');
    expect(send.disabled).toBe(false);
    click(send);
    expect(onAction).toHaveBeenCalledWith('note', { text: 'короче' });
  });

  it('упала публикация — «Пост вышел» только со ссылкой на пост; замечания к повтору нет', () => {
    const { onAction } = render({
      open: true, item: item({ status: 'failed' }),
      detail: detail({ status: 'failed', failedFrom: 'publishing', approvedAt: '2030-01-01T11:00:00.000Z' }),
    });
    const mark = q('short-mark-published') as HTMLButtonElement;
    type(q('short-post-url')!, 'https://t.me/ainomira');
    expect(mark.disabled).toBe(true);
    type(q('short-post-url')!, 'https://t.me/ainomira/90');
    expect(mark.disabled).toBe(false);
    click(mark);
    expect(onAction).toHaveBeenCalledWith('mark_published', { url: 'https://t.me/ainomira/90' });
    expect(q('short-retry-note')).toBeNull();
  });

  it('упал до публикации — повтор с необязательным замечанием', () => {
    const { onAction } = render({
      open: true, item: item({ status: 'failed' }),
      detail: detail({ status: 'failed', failedFrom: 'rendering', capture: { answerText: 'x' } }),
    });
    type(q('short-retry-note')!, 'другой вопрос');
    click(q('short-retry-directing')!);
    expect(onAction).toHaveBeenCalledWith('retry_directing', { note: 'другой вопрос' });
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortCard.test.tsx
```

Expected: FAIL, `Failed to resolve import "./ShortCard"`.

- [ ] **Step 3: Написать `ShortActions.tsx`**

```tsx
import React, { useState } from 'react';
import { ActionExtra, MAX_NOTE_CHARS, ShortAction, ShortDetail, actionsFor, isTelegramPostUrl, noteChars } from './shortStatus';

interface Props {
  detail: ShortDetail;
  busy: boolean;
  onAction: (kind: ShortAction, extra?: ActionExtra) => void;
}

const BTN = 'px-3 py-1 text-xs rounded disabled:opacity-50';
const PRIMARY = `${BTN} bg-forest-600 text-white hover:bg-forest-700`;
const SECONDARY = `${BTN} bg-gray-100 hover:bg-gray-200`;
const DANGER = `${BTN} bg-rose-50 text-rose-700 hover:bg-rose-100`;
const FIELD = 'flex-1 min-w-0 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-forest-500';

/** Кнопки раскрытого ролика — по статусу (actionsFor), с полями замечания и ссылки на пост. */
const ShortActions: React.FC<Props> = ({ detail, busy, onAction }) => {
  const [note, setNote] = useState('');
  const [retryNote, setRetryNote] = useState('');
  const [postUrl, setPostUrl] = useState('');
  const actions = actionsFor(detail);
  if (!actions.length) return null;
  const has = (a: ShortAction) => actions.includes(a);
  const noteLen = noteChars(note);
  // У упавшей публикации повтор только отправляет заново — замечание сценаристу ни к чему.
  const retryWithNote = detail.failedFrom !== 'publishing' && (has('retry') || has('retry_directing') || has('retry_writing'));
  const retryExtra = { note: retryNote };

  return (
    <div data-testid={`short-actions-${detail.id}`} className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {has('approve') && (
          <button type="button" data-testid="short-approve" onClick={() => onAction('approve')} disabled={busy} className={PRIMARY}>
            Одобрить
          </button>
        )}
        {has('publish_now') && (
          <button type="button" data-testid="short-publish-now" onClick={() => onAction('publish_now')} disabled={busy} className={PRIMARY}>
            Опубликовать сейчас
          </button>
        )}
        {has('retry') && (
          <button type="button" data-testid="short-retry" onClick={() => onAction('retry', retryExtra)} disabled={busy} className={PRIMARY}>
            Повторить
          </button>
        )}
        {has('retry_directing') && (
          <button type="button" data-testid="short-retry-directing" onClick={() => onAction('retry_directing', retryExtra)}
            disabled={busy} className={SECONDARY}>
            Новая сцена
          </button>
        )}
        {has('retry_writing') && (
          <button type="button" data-testid="short-retry-writing" onClick={() => onAction('retry_writing', retryExtra)}
            disabled={busy} className={SECONDARY}>
            Новый текст
          </button>
        )}
        {has('redo') && (
          <button type="button" data-testid="short-redo" onClick={() => onAction('redo')} disabled={busy} className={SECONDARY}>
            Переснять
          </button>
        )}
        {has('reject') && (
          <button type="button" data-testid="short-reject" onClick={() => onAction('reject')} disabled={busy} className={DANGER}>
            Отклонить
          </button>
        )}
      </div>

      {has('note') && (
        <div className="flex flex-col sm:flex-row gap-2">
          <textarea data-testid="short-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder="Что поправить в ролике — уйдёт сценаристу" aria-label="Замечание к ролику" className={FIELD} />
          <button type="button" data-testid="short-send-note" onClick={() => onAction('note', { text: note })}
            disabled={busy || noteLen === 0 || noteLen > MAX_NOTE_CHARS} className={`${SECONDARY} self-start`}>
            Отправить замечание
          </button>
        </div>
      )}
      {noteLen > MAX_NOTE_CHARS && <div className="text-xs text-rose-600">Замечание длиннее {MAX_NOTE_CHARS} знаков.</div>}

      {retryWithNote && (
        <input data-testid="short-retry-note" value={retryNote} onChange={(e) => setRetryNote(e.target.value)}
          placeholder="Замечание к повтору — необязательно" aria-label="Замечание к повтору" className={`${FIELD} w-full`} />
      )}

      {has('mark_published') && (
        <div className="flex flex-col sm:flex-row gap-2">
          <input data-testid="short-post-url" value={postUrl} onChange={(e) => setPostUrl(e.target.value)}
            placeholder="https://t.me/ainomira/123 — если пост всё-таки вышел" aria-label="Ссылка на вышедший пост" className={FIELD} />
          <button type="button" data-testid="short-mark-published" onClick={() => onAction('mark_published', { url: postUrl })}
            disabled={busy || !isTelegramPostUrl(postUrl)} className={`${SECONDARY} self-start`}>
            Пост вышел
          </button>
        </div>
      )}
    </div>
  );
};

export default ShortActions;
```

- [ ] **Step 4: Написать `ShortCard.tsx`**

```tsx
import React, { useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Loader } from 'lucide-react';
import ShortActions from './ShortActions';
import {
  ANGLE_TITLES, ActionExtra, FORMAT_TITLES, PLATFORM_TITLES, RUBRIC_TITLES, STATUS_TITLES,
  ShortAction, ShortDetail, ShortItem, publicationLabel, shortTitle, statusLine, statusTone,
} from './shortStatus';

interface Props {
  item: ShortItem;
  assistantName: string | null;
  open: boolean;
  detail: ShortDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  busy: boolean;
  now: Date;
  onToggle: () => void;
  onAction: (kind: ShortAction, extra?: ActionExtra) => void;
}

/** Видео ролика: файл грузится только по нажатию (preload="none"); не загрузилось — ссылка на файл. */
const ShortVideo: React.FC<{ detail: ShortDetail }> = ({ detail }) => {
  const [broken, setBroken] = useState(false);
  if (!detail.videoUrl) return <div className="text-xs text-gray-500">Видео ещё нет — ролик не собран.</div>;
  if (broken) {
    return (
      <div data-testid={`short-video-broken-${detail.id}`} className="text-xs text-gray-600">
        Видео недоступно.{' '}
        <a href={detail.videoUrl} target="_blank" rel="noreferrer" className="underline text-forest-700">
          Открыть файл
        </a>
      </div>
    );
  }
  return (
    <video
      data-testid={`short-video-${detail.id}`}
      src={detail.videoUrl}
      poster={detail.coverUrl ?? undefined}
      controls
      playsInline
      preload="none"
      onError={() => setBroken(true)}
      className="w-full max-w-[220px] aspect-[9/16] rounded bg-black"
    />
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="text-xs text-gray-500">{label}</div>
    <div className="whitespace-pre-wrap break-words">{children}</div>
  </div>
);

/**
 * Ролик в списке: свёрнутая строка — статус, что за ролик и когда; по клику —
 * видео, подпись в канал, сценарий и кнопки. Подробности — только по клику:
 * в разделах админки владелец ждёт итогов, а не ленты подробностей.
 */
const ShortCard: React.FC<Props> = ({
  item, assistantName, open, detail, detailLoading, detailError, busy, now, onToggle, onAction,
}) => {
  const broken = item.status === 'failed';
  const angle = item.status === 'idea' && !item.angleLocked ? 'подача по ритму недели' : ANGLE_TITLES[item.angle];
  const meta = [RUBRIC_TITLES[item.rubric], angle, assistantName, FORMAT_TITLES[item.format]].filter(Boolean).join(' · ');
  const stats = detail
    ? [
        detail.durationMs ? `${Math.round(detail.durationMs / 1000)} с` : null,
        detail.animation?.omniSeconds ? `Omni: ${detail.animation.omniSeconds} с` : null,
        detail.attempts ? `попыток: ${detail.attempts}` : null,
      ].filter(Boolean).join(' · ')
    : '';

  return (
    <div
      data-testid={`short-${item.id}`}
      data-status={item.status}
      className={clsx('border rounded-lg p-3', broken ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white')}
    >
      <div className="flex items-start gap-2">
        <button type="button" data-testid={`short-toggle-${item.id}`} onClick={onToggle} aria-expanded={open}
          className="flex-1 min-w-0 flex items-start gap-2 text-left">
          {open ? (
            <ChevronDown className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
          )}
          <span className="min-w-0">
            <span className="flex items-center gap-2 flex-wrap">
              <span className={clsx('px-2 py-0.5 text-xs rounded', statusTone(item.status))}>{STATUS_TITLES[item.status]}</span>
              <span className="text-sm font-medium text-gray-900 break-words">{shortTitle(item)}</span>
            </span>
            <span className="block mt-0.5 text-xs text-gray-500">{meta}</span>
            <span data-testid={`short-line-${item.id}`}
              className={clsx('block mt-0.5 text-xs', broken ? 'text-red-700 font-medium' : 'text-gray-600')}>
              {statusLine(item, now)}
            </span>
            {broken && item.lastError && (
              <span className="block mt-0.5 text-xs text-red-700 break-words line-clamp-2">{item.lastError}</span>
            )}
          </span>
        </button>
        {item.status === 'idea' && (
          <button type="button" data-testid={`short-start-${item.id}`} onClick={() => onAction('start_now')} disabled={busy}
            className="flex-shrink-0 px-3 py-1 text-xs bg-forest-600 text-white rounded hover:bg-forest-700 disabled:opacity-50">
            Запустить сейчас
          </button>
        )}
      </div>

      {item.publications.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.publications.map((p) => {
            const label = `${PLATFORM_TITLES[p.platform]}: ${publicationLabel(p)}`;
            return p.url ? (
              <a key={p.platform} data-testid={`short-pub-${item.id}-${p.platform}`} href={p.url} target="_blank" rel="noreferrer"
                className="px-2 py-0.5 text-xs rounded bg-green-50 text-green-800 underline">
                {label} ↗
              </a>
            ) : (
              <span key={p.platform} data-testid={`short-pub-${item.id}-${p.platform}`} title={p.lastError ?? undefined}
                className={clsx('px-2 py-0.5 text-xs rounded', p.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600')}>
                {label}
              </span>
            );
          })}
        </div>
      )}

      {open && (
        <div data-testid={`short-details-${item.id}`} className="mt-3 pt-3 border-t border-gray-100">
          {detailLoading && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Loader className="w-3.5 h-3.5 animate-spin" />
              Загружаю ролик…
            </div>
          )}
          {detailError && <div className="text-xs text-rose-700">Не загрузил ролик: {detailError}</div>}
          {detail && (
            <>
              <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
                <ShortVideo detail={detail} />
                <div className="min-w-0 space-y-2 text-sm text-gray-700">
                  {detail.captions?.telegram && <Field label="Подпись в канал">{detail.captions.telegram}</Field>}
                  {detail.captions?.youtube?.title && <Field label="Заголовок YouTube">{detail.captions.youtube.title}</Field>}
                  {detail.scene?.question && <Field label="Вопрос ассистенту">{detail.scene.question}</Field>}
                  {Boolean(detail.script?.hook || detail.script?.lines?.length) && (
                    <div>
                      <div className="text-xs text-gray-500">Сценарий</div>
                      {detail.script?.hook && <div className="font-medium break-words">{detail.script.hook}</div>}
                      <ol className="list-decimal pl-5 space-y-0.5">
                        {(detail.script?.lines ?? []).map((l) => (
                          <li key={l.id} className="break-words">{l.text}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {detail.ownerNote && <Field label="Замечания">{detail.ownerNote}</Field>}
                  {detail.lastError && <div className="text-xs text-red-700 break-words">Последняя ошибка: {detail.lastError}</div>}
                  <div data-testid={`short-stats-${item.id}`} className="text-xs text-gray-500">{stats}</div>
                </div>
              </div>
              <ShortActions detail={detail} busy={busy} onAction={onAction} />
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ShortCard;
```

- [ ] **Step 5: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortCard.test.tsx
git branch --show-current
git add src/components/admin/ShortActions.tsx src/components/admin/ShortCard.tsx src/components/admin/ShortCard.test.tsx
git commit -m "admin: ролики — строка и раскрытая карточка: видео по нажатию, подпись в канал, кнопки по статусу"
```

Expected: PASS, 8 тестов.

---

### Task 16: `AdminShortsView.tsx`

**Files:**
- Create: `src/components/admin/AdminShortsView.tsx`
- Test: `src/components/admin/AdminShortsView.test.tsx`

- [ ] **Step 1: Написать падающий тест**

`src/components/admin/AdminShortsView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { actAsync, clickAsync, doubleClick, flush, mount, type, Mounted } from '../../test/dom';

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { post, get } }));

import AdminShortsView from './AdminShortsView';

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const VERSION = '2026-10-30 12:34:56.123456+00';
const item = (over: Record<string, unknown> = {}) => ({
  id: 's1', rubric: 'assistant', angle: 'roast', angleLocked: false, source: 'catalog', topicKey: 'catalog:2030-W01:1',
  topicHint: 'Залог при аренде', title: 'Залог при аренде', assistantId: 10, format: 'skit',
  scene: { assistantName: 'Алексей', question: 'Проверьте договор' }, status: 'pending_review',
  slotAt: '2030-01-05T15:00:00.000Z', approvedAt: null, failedFrom: null, lastError: null, attempts: 0,
  ownerNote: null, durationMs: 44000, publishedAt: null, createdAt: '2030-01-01T10:00:00.000Z',
  updatedAt: '2030-01-01T10:00:00.000Z', version: VERSION, publications: [], ...over,
});
const detailOf = (over: Record<string, unknown> = {}) => ({
  ...item(over), capture: { answerText: 'ответ' }, script: { hook: 'Зацепка', lines: [] },
  captions: { telegram: 'Подпись в канал', youtube: { title: 'Заголовок YouTube' } }, animation: { omniSeconds: 16 },
  videoUrl: `https://my.linkeon.io/smm-media/linkeon-smm-videos/shorts/s1/video.mp4?v=${encodeURIComponent(VERSION)}`,
  coverUrl: null,
});

let m: Mounted;
const q = (id: string) => m.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sent = () => post.mock.calls.map((c) => c[1]);
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};
/** Сервер по таблице действий; незнакомое действие — ошибка теста. */
function serve(table: Record<string, (payload: any) => unknown>) {
  post.mockImplementation(async (_url: string, payload: any) => {
    const h = table[payload.action];
    if (!h) throw new Error(`неожиданное действие ${payload.action}`);
    return h(payload);
  });
}
const open = async () => {
  m = mount(<AdminShortsView />);
  await settle();
};
const openCard = async () => {
  await clickAsync(q('short-toggle-s1')!);
  await settle();
};

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  get.mockResolvedValue(res(200, [{ id: 10, name: 'Алексей', displayName: 'Алексей — юрист' }]));
});
afterEach(() => m?.unmount());

describe('экран «Ролики»', () => {
  it('очередь — группы по срочности, числа на переключателе, архив отдельно', async () => {
    serve({
      list: () => res(200, [
        item({ id: 'a', status: 'idea', slotAt: null }),
        item({ id: 'b', status: 'writing' }),
        item({ id: 'c', status: 'approved' }),
        item({ id: 'd', status: 'failed', failedFrom: 'animating', lastError: 'Omni 429' }),
        item({ id: 'e', status: 'pending_review' }),
        item({
          id: 'f', status: 'published', publishedAt: '2030-01-02T15:00:00.000Z',
          publications: [{ platform: 'telegram', status: 'published', url: 'https://t.me/ainomira/90', lastError: null }],
        }),
        item({ id: 'g', status: 'rejected' }),
      ]),
    });
    await open();
    const groups = [...m.container.querySelectorAll('[data-testid^="shorts-group-"]')].map((el) => el.getAttribute('data-testid'));
    expect(groups).toEqual(['shorts-group-review', 'shorts-group-failed', 'shorts-group-scheduled', 'shorts-group-working', 'shorts-group-ideas']);
    expect(q('shorts-screen-queue')!.textContent).toBe('В очереди 5');
    expect(q('shorts-screen-published')!.textContent).toBe('Вышли 1');
    expect(q('short-line-d')!.textContent).toBe('упал: оживление');
    await clickAsync(q('shorts-screen-published')!);
    expect(q('short-f')).toBeTruthy();
    expect(q('short-e')).toBeNull();
  });

  it('раскрытие зовёт get; видео — по нажатию, с меткой версии', async () => {
    serve({ list: () => res(200, [item()]), get: () => res(200, detailOf()) });
    await open();
    await openCard();
    expect(sent()).toContainEqual({ action: 'get', id: 's1' });
    const video = q('short-video-s1') as HTMLVideoElement;
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('src')).toContain('?v=');
    expect(m.container.textContent).toContain('Подпись в канал');
  });

  it('«Одобрить» — с версией открытой карточки; итог — когда выйдет; список перечитан, карточка закрыта', async () => {
    serve({
      list: () => res(200, [item()]),
      get: () => res(200, detailOf()),
      approve: () => res(200, item({ status: 'approved', slotAt: '2030-01-05T15:00:00.000Z' })),
    });
    await open();
    await openCard();
    await clickAsync(q('short-approve')!);
    await settle();
    expect(sent()).toContainEqual({ action: 'approve', id: 's1', version: VERSION });
    expect(q('shorts-notice')!.textContent).toMatch(/^Одобрено\. Выйдет /);
    expect(sent().filter((p) => p.action === 'list')).toHaveLength(2);
    expect(q('short-details-s1')).toBeNull();
  });

  it('409 — жёлтая плашка с причиной, сам список не перечитывается; «Загрузить заново» — список и карточка', async () => {
    serve({
      list: () => res(200, [item()]),
      get: () => res(200, detailOf()),
      approve: () => res(409, {
        statusCode: 409, error: 'version_conflict', message: 'Ролик изменился, пока был открыт: на экране устаревшая версия',
      }),
    });
    await open();
    await openCard();
    await clickAsync(q('short-approve')!);
    await settle();
    const banner = q('shorts-error')!;
    expect(banner.getAttribute('data-conflict')).toBe('true');
    expect(banner.textContent).toContain('Ролик изменился, пока был открыт');
    expect(sent().filter((p) => p.action === 'list')).toHaveLength(1);
    await clickAsync(q('shorts-conflict-reload')!);
    await settle();
    expect(sent().filter((p) => p.action === 'list')).toHaveLength(2);
    expect(sent().filter((p) => p.action === 'get')).toHaveLength(2);
  });

  it('двойное нажатие «Одобрить» — один запрос', async () => {
    let release: () => void = () => {};
    serve({
      list: () => res(200, [item()]),
      get: () => res(200, detailOf()),
      approve: () => new Promise((resolve) => {
        release = () => resolve(res(200, item({ status: 'approved' })));
      }),
    });
    await open();
    await openCard();
    doubleClick(q('short-approve')!);
    expect(sent().filter((p) => p.action === 'approve')).toHaveLength(1);
    await actAsync(() => release());
    await settle();
  });

  it('«Опубликовать сейчас» — только после подтверждения', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const approved = { status: 'approved', approvedAt: '2030-01-01T11:00:00.000Z' };
    serve({ list: () => res(200, [item(approved)]), get: () => res(200, detailOf(approved)) });
    await open();
    await openCard();
    await clickAsync(q('short-publish-now')!);
    expect(confirm).toHaveBeenCalled();
    expect(sent().some((p) => p.action === 'publish_now')).toBe(false);
    confirm.mockRestore();
  });

  it('«Запустить сейчас» у идеи — прямо в строке', async () => {
    serve({ list: () => res(200, [item({ status: 'idea', slotAt: null })]), start_now: () => res(200, item({ status: 'directing' })) });
    await open();
    await clickAsync(q('short-start-s1')!);
    await settle();
    expect(sent()).toContainEqual({ action: 'start_now', id: 's1' });
    expect(q('shorts-notice')!.textContent).toContain('Ролик запущен');
  });

  it('замечание уходит с версией и текстом', async () => {
    serve({ list: () => res(200, [item()]), get: () => res(200, detailOf()), note: () => res(200, item({ status: 'writing' })) });
    await open();
    await openCard();
    type(q('short-note')!, '  короче и без цифр ');
    await clickAsync(q('short-send-note')!);
    await settle();
    expect(sent()).toContainEqual({ action: 'note', id: 's1', version: VERSION, text: 'короче и без цифр' });
  });

  it('нет внятного ответа на решение — «Не подтверждено», без вывода о результате', async () => {
    serve({ list: () => res(200, [item()]), get: () => res(200, detailOf()), approve: () => res(502, '<html>') });
    await open();
    await openCard();
    await clickAsync(q('short-approve')!);
    await settle();
    expect(q('shorts-error')!.textContent).toBe('Не подтверждено: сервер ответил 502. Нажмите «Обновить», прежде чем повторять.');
    expect(q('shorts-notice')).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/AdminShortsView.test.tsx
```

Expected: FAIL, `Failed to resolve import "./AdminShortsView"`.

- [ ] **Step 3: Написать экран**

`src/components/admin/AdminShortsView.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, Loader, RefreshCw, Settings } from 'lucide-react';
import ShortCard from './ShortCard';
import ShortsOrderForm from './ShortsOrderForm';
import ShortsSettingsForm from './ShortsSettingsForm';
import { AgentOption, ShortsApiError, callShorts, loadAgents } from './shortsApi';
import {
  ActionExtra, GROUP_TITLES, ShortAction, ShortDetail, ShortItem, ShortsScreen,
  actionRequest, archiveOf, queueGroups, screenCounts, successText,
} from './shortStatus';

const SCREENS: ShortsScreen[] = ['queue', 'published', 'rejected'];
const SCREEN_TITLES: Record<ShortsScreen, string> = { queue: 'В очереди', published: 'Вышли', rejected: 'Отклонены' };
const EMPTY_TEXT: Record<ShortsScreen, string> = {
  queue: 'Очередь роликов пуста',
  published: 'Вышедших роликов пока нет',
  rejected: 'Отклонённых роликов нет',
};

interface Banner {
  text: string;
  /** 409: на экране устаревшее — плашка жёлтая, с «Загрузить заново». */
  conflict: boolean;
}

/**
 * Экран «Ролики» вкладки «Блог» (спека spirits_back
 * docs/superpowers/specs/2026-10-30-admin-shorts-in-blog-design.md).
 *
 * Решения по ролику подписаны версией, с которой открыта карточка. На 409
 * экран сам ничего не перечитывает: свежая версия сняла бы защиту, и следующее
 * нажатие одобрило бы ролик, которого владелец не видел. Перечитывает
 * «Загрузить заново» — по решению человека.
 */
const AdminShortsView: React.FC = () => {
  const [items, setItems] = useState<ShortItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [screen, setScreen] = useState<ShortsScreen>('queue');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Banner | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShortDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  /** Замок одобрения и публикации: кнопка гаснет с перерисовкой, а нажатие, успевшее раньше неё, держит он. */
  const lock = useRef(false);
  /** Ответ на раскрытие, пришедший после закрытия или раскрытия другого ролика, отбрасывается. */
  const detailTicket = useRef(0);

  /** `decision` — сбой решения: без внятного ответа результат неизвестен, и об этом надо сказать. */
  const fail = (e: unknown, decision = false) => {
    if (e instanceof ShortsApiError && e.status === 409) {
      setError({ text: e.message, conflict: true });
    } else if (e instanceof ShortsApiError && e.status < 500) {
      setError({ text: e.message, conflict: false });
    } else {
      const why = e instanceof Error && e.message ? e.message : 'нет ответа';
      setError({
        text: decision ? `Не подтверждено: ${why}. Нажмите «Обновить», прежде чем повторять.` : why,
        conflict: false,
      });
    }
  };

  const load = async () => {
    setBusy(true);
    try {
      const list = await callShorts<ShortItem[]>({ action: 'list' });
      setItems(Array.isArray(list) ? list : []);
      setLoaded(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const loadDetail = async (id: string) => {
    const ticket = ++detailTicket.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const d = await callShorts<ShortDetail>({ action: 'get', id });
      if (ticket === detailTicket.current) setDetail(d);
    } catch (e) {
      if (ticket === detailTicket.current) setDetailError(e instanceof Error && e.message ? e.message : 'неизвестная ошибка');
    } finally {
      if (ticket === detailTicket.current) setDetailLoading(false);
    }
  };

  const closeCard = () => {
    detailTicket.current += 1;
    setOpenId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  };

  useEffect(() => {
    load();
    loadAgents().then(setAgents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    if (openId === id) {
      closeCard();
      return;
    }
    setOpenId(id);
    setDetail(null);
    loadDetail(id);
  };

  /** Решение по ролику. Версия — с раскрытой карточки; у «Запустить сейчас» идеи её нет и не нужно. */
  const act = async (kind: ShortAction, short: ShortItem, extra?: ActionExtra) => {
    const target = detail && detail.id === short.id ? detail : short;
    const request = actionRequest(kind, target, extra);
    if (request.lock && lock.current) return;
    if (request.confirm && !window.confirm(request.confirm)) return;
    if (request.lock) lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await callShorts(request.payload);
      setNotice(successText(kind, target, res, new Date()));
      closeCard();
      await load();
    } catch (e) {
      fail(e, true);
    } finally {
      if (request.lock) lock.current = false;
      setBusy(false);
    }
  };

  const order = async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await callShorts(payload);
      setNotice(res ? 'Ролик заказан — он в «Идеях». Запустить сразу — «Запустить сейчас» в его строке.' : 'Такой ролик уже заказан');
      await load();
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const refill = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await callShorts<{ added?: number }>({ action: 'refill_topics' });
      const added = Number(res?.added ?? 0);
      setNotice(added > 0 ? `Добавлено тем: ${added}` : 'Темы на неделю уже есть');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** После 409 — решение человека: и список, и открытая карточка с новой версией. */
  const reloadAll = async () => {
    setError(null);
    await load();
    if (openId) await loadDetail(openId);
  };

  const refresh = () => {
    setError(null);
    setNotice(null);
    load();
  };

  const counts = screenCounts(items);
  const now = new Date();
  const groups = queueGroups(items);
  const archive = screen === 'queue' ? [] : archiveOf(items, screen);
  const empty = loaded && (screen === 'queue' ? groups.length === 0 : archive.length === 0);
  const agentName = (i: ShortItem): string | null => {
    if (i.scene?.assistantName) return i.scene.assistantName;
    const a = i.assistantId != null ? agents.find((x) => x.id === i.assistantId) : undefined;
    return a ? a.displayName : null;
  };
  const card = (i: ShortItem) => (
    <ShortCard
      key={i.id}
      item={i}
      assistantName={agentName(i)}
      open={openId === i.id}
      detail={openId === i.id ? detail : null}
      detailLoading={openId === i.id && detailLoading}
      detailError={openId === i.id ? detailError : null}
      busy={busy}
      now={now}
      onToggle={() => toggle(i.id)}
      onAction={(kind, extra) => act(kind, i, extra)}
    />
  );

  return (
    <div data-testid="admin-shorts">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {SCREENS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`shorts-screen-${s}`}
            onClick={() => setScreen(s)}
            className={clsx(
              'px-3 py-1.5 text-sm font-medium rounded-full border transition-colors',
              screen === s ? 'bg-forest-600 text-white border-forest-600' : 'bg-white text-gray-600 border-gray-200 hover:border-forest-300',
            )}
          >
            {SCREEN_TITLES[s]} {counts[s]}
          </button>
        ))}
        <button
          type="button"
          data-testid="shorts-settings-toggle"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-white text-gray-600 text-sm font-medium rounded-md border border-gray-200 hover:border-forest-300 hover:text-forest-700 transition-colors"
        >
          <Settings className="w-4 h-4" />
          <span className="hidden sm:inline">Настройки роликов</span>
        </button>
        <button
          type="button"
          data-testid="shorts-refresh"
          onClick={refresh}
          disabled={busy}
          title="Обновить"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-gray-600 text-sm font-medium rounded-md border border-gray-200 hover:border-forest-300 hover:text-forest-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={clsx('w-4 h-4', busy && 'animate-spin')} />
          <span className="hidden sm:inline">Обновить</span>
        </button>
      </div>

      {error && (
        <div
          data-testid="shorts-error"
          data-conflict={error.conflict ? 'true' : 'false'}
          className={clsx(
            'mb-3 px-3 py-2 rounded-md border text-sm',
            error.conflict ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-rose-50 border-rose-200 text-rose-700',
          )}
        >
          {error.conflict ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{error.text.replace(/[.\s]+$/, '')}. Ничего не записано.</span>
              <button
                type="button"
                data-testid="shorts-conflict-reload"
                onClick={reloadAll}
                className="px-2 py-0.5 text-xs font-medium rounded border border-amber-400 bg-white hover:bg-amber-100"
              >
                Загрузить заново
              </button>
            </div>
          ) : (
            error.text
          )}
        </div>
      )}

      {notice && (
        <div data-testid="shorts-notice" className="mb-3 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm text-gray-600">
          {notice}
        </div>
      )}

      {showSettings && <ShortsSettingsForm />}

      {screen === 'queue' && <ShortsOrderForm agents={agents} busy={busy} onOrder={order} onRefill={refill} />}

      {busy && !loaded && (
        <div className="mb-3 flex items-center gap-2 text-sm text-gray-500">
          <Loader className="w-4 h-4 animate-spin" />
          Загрузка…
        </div>
      )}

      {empty && <div className="text-sm text-gray-500 text-center py-12">{EMPTY_TEXT[screen]}</div>}

      {screen === 'queue' ? (
        groups.map(({ group, items: list }) => (
          <section key={group} data-testid={`shorts-group-${group}`} className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {GROUP_TITLES[group]} · {list.length}
            </h3>
            <div className="space-y-2">{list.map(card)}</div>
          </section>
        ))
      ) : (
        <div className="space-y-2">{archive.map(card)}</div>
      )}
    </div>
  );
};

export default AdminShortsView;
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/AdminShortsView.test.tsx
git branch --show-current
git add src/components/admin/AdminShortsView.tsx src/components/admin/AdminShortsView.test.tsx
git commit -m "admin: экран «Ролики» — очередь по срочности, архив, решения с версией, 409 без перечитывания"
```

Expected: PASS, 9 тестов.

---

### Task 17: Экран «Ролики» во вкладке «Блог»

**Files:**
- Modify: `src/components/admin/AdminBlogView.tsx`
- Test: `src/components/admin/AdminBlogView.test.tsx`

- [ ] **Step 1: Написать падающий тест**

В `src/components/admin/AdminBlogView.test.tsx` после строки `vi.mock('../../services/apiClient', () => ({ apiClient: { post } }));`:

```tsx
vi.mock('./AdminShortsView', () => ({ default: () => <div data-testid="admin-shorts-stub" /> }));
```

В конец файла:

```tsx
describe('экран «Ролики»', () => {
  it('кнопка «Ролики» показывает ролики; посты при этом не грузятся, своего «Обновить» у вкладки нет', async () => {
    post.mockImplementation(async (_url: string, payload: any) => {
      if (payload.action === 'list') return res(200, [basePost]);
      throw new Error(`неожиданное действие ${payload.action}`);
    });
    await mount();
    const before = post.mock.calls.length;
    await click('blog-screen-shorts');
    expect(q('admin-shorts-stub')).toBeTruthy();
    expect(q('blog-post-p1')).toBeNull();
    expect(post.mock.calls.length).toBe(before);
    expect(container.textContent).not.toContain('Обновить');
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/AdminBlogView.test.tsx
```

Expected: FAIL нового теста, `нет элемента blog-screen-shorts`.

- [ ] **Step 3: Реализовать**

В `src/components/admin/AdminBlogView.tsx`:

1. После `import { formatSlotAt } from './blogSlotFormat';`:

```tsx
import AdminShortsView from './AdminShortsView';
```

2. Тип и подписи экранов:

```tsx
type Screen = 'queue' | 'archive' | 'settings';

const SCREEN_LABEL: Record<Screen, string> = {
  queue: 'Очередь',
  archive: 'Архив',
  settings: 'Настройки',
};
```

заменить на

```tsx
/** «Ролики» — свой экран (AdminShortsView): у роликов свои статусы, кнопки и «Обновить». */
type Screen = 'queue' | 'archive' | 'shorts' | 'settings';

const SCREEN_LABEL: Record<Screen, string> = {
  queue: 'Очередь',
  archive: 'Архив',
  shorts: 'Ролики',
  settings: 'Настройки',
};
```

3. В `load` первой строкой тела (перед `setBusy(true);`):

```tsx
    if (screen === 'shorts') return;
```

4. Кнопки экранов: `{(['queue', 'archive', 'settings'] as Screen[]).map((s) => (` заменить на

```tsx
        {(['queue', 'archive', 'shorts', 'settings'] as Screen[]).map((s) => (
```

5. Кнопку «Обновить» вкладки (`<button onClick={() => load()} …>` до её `</button>`) обернуть условием `{screen !== 'shorts' && ( … )}`:

```tsx
        {screen !== 'shorts' && (
          <button
            onClick={() => load()}
            disabled={busy}
            title="Обновить"
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-white text-gray-600 text-sm font-medium rounded-md border border-gray-200 hover:border-forest-300 hover:text-forest-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={clsx('w-4 h-4', busy && 'animate-spin')} />
            <span className="hidden sm:inline">Обновить</span>
          </button>
        )}
```

6. Перед `{screen === 'queue' && (` (форма темы) вставить:

```tsx
      {screen === 'shorts' && <AdminShortsView />}

```

7. Условие списка постов `{screen !== 'settings' && (` заменить на

```tsx
      {screen !== 'settings' && screen !== 'shorts' && (
```

- [ ] **Step 4: Убедиться, что проходит, и закоммитить**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/AdminBlogView.test.tsx src/components/admin/AdminShortsView.test.tsx
git branch --show-current
git add src/components/admin/AdminBlogView.tsx src/components/admin/AdminBlogView.test.tsx
git commit -m "admin: вкладка «Блог» — экран «Ролики» рядом с очередью и архивом постов"
```

Expected: PASS обоих файлов, прежние тесты блога зелёные.

---

### Task 18: Гейты фронта на ноде

**Files:** нет.

- [ ] **Step 1: Полный прогон, tsc, сборка на точном коммите**

```bash
cd ~/Downloads/spirits_front/.worktrees/admin-shorts
SHA=$(git rev-parse HEAD)
git push -q origin HEAD:refs/heads/feat/admin-shorts
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "set -e; cd ~/ci/wt/admin-shorts-front; git fetch -q origin refs/heads/feat/admin-shorts; git checkout -q --detach ${SHA}; source ~/.nvm/nvm.sh >/dev/null; pnpm install --frozen-lockfile >/dev/null 2>&1; ./node_modules/.bin/vitest run 2>&1 | tail -15; echo TSC_ERRORS=\$(npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c 'error TS' || true); npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E 'admin/(Short|shortS|shorts|AdminShorts|AdminBlogView)' || echo OWN_TSC_CLEAN; if pnpm build >/dev/null 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; fi"
```

Expected:
- vitest — красных файлов не больше, чем в базе задачи 9, новые файлы зелёные;
- `TSC_ERRORS` не больше базы и `OWN_TSC_CLEAN` (в своих файлах ни одной ошибки);
- `BUILD_OK`.

---

## Часть C. Ревью, слияние, выкат

### Task 19: Ревью обеих веток

**Files:** по итогам ревью.

- [ ] **Step 1: Ревью бэка и фронта**

Запустить субагента `superpowers:code-reviewer` на каждый дифф: `git -C ~/Downloads/spirits_back/.worktrees/admin-shorts diff origin/main...HEAD` и `git -C ~/Downloads/spirits_front/.worktrees/admin-shorts diff origin/main...HEAD`. Мерило — спека и этот план. Особое внимание:
- версия в условии записи и её сверка с микросекундами;
- что тесты кнопок лички не правились;
- что `list` не отдаёт тяжёлого;
- 409 без перечитывания;
- замок двойного нажатия;
- `preload="none"`.

- [ ] **Step 2: Исправить Critical и Important**

Каждую правку — тест, потом код. Затем повторить гейты задач 8 и 18.

### Task 20 (OK владельца): Слияние в `main` и выкат на стенд

**Files:** нет.

- [ ] **Step 1: Спросить OK владельца на слияние и выкат на стенд** (`TEST_ONLY=1`)

- [ ] **Step 2: Не идёт ли чужой выкат — отдельным шагом, на обеих машинах**

```bash
ps -eo pid,command | grep -E "^\s*[0-9]+ (bash|/bin/bash) .*deploy\.sh" || echo "мак: выката нет"
ssh dv@85.192.61.231 'ps -eo pid,command | grep -E "^\s*[0-9]+ (bash|/bin/bash) .*deploy\.sh" || echo "нода: выката нет"'
```

Идёт чужой выкат — ждать его конца, в `main` не пушить.

- [ ] **Step 3: Ветки — на свежий `origin/main`, гейты заново, перемотка `main`**

В каждом дереве:
1. `git fetch -q origin && git rebase origin/main`.
2. Если `origin/main` сдвинулся — повторить гейты: задачу 8 для бэка, задачу 18 для фронта.
3. `SHA=$(git rev-parse HEAD) && git push origin "${SHA}:refs/heads/main"`. В zsh refspec писать только в фигурных скобках, иначе `$SHA:r` съест модификатор.

Пуш отказал (non-fast-forward) — значит, кто-то успел в `main`: повторить шаг 3. Совсем свежий `origin/main` с чужим незаконченным кодом — повод спросить владельца.

- [ ] **Step 4: Выкат на стенд**

Как последние выкаты роликов: свежий клон `main` на ноде, запуск `scripts/deploy.sh` с `TEST_ONLY=1` отвязанно (`setsid -f`) с логом в `~/deploy-logs/admin-shorts-test.log`, без `| tail`. Флаги пропуска фаз взять у последнего зелёного выката: `ls -t ~/deploy-logs/*.sh | head -3` на ноде, прочитать скрипт запуска (27–28.10 это были `SKIP_BOTS=1 SKIP_PRODUCTS_HOST=1`). Следить по логу до `ALL PHASES GREEN` или до отказа.

- [ ] **Step 5: Проверить, что на стенде именно эта сборка**

Сверить хеш бандла: `curl -s -u "$TEST_BASIC_USER:$TEST_BASIC_PASS" https://test.linkeon.io/ | grep -o 'index-[A-Za-z0-9_-]*\.js'` против сборки из `main`. Логин и пароль Basic Auth лежат в `~/Downloads/spirits_back/scripts/test-server.env.local`: прочитать в переменные (`source`), не печатать и не коммитить. Затем `admin/shorts list` на стенде, админом через debug-OTP. В ответе должно быть поле `version` вида `YYYY-MM-DD HH:MM:SS[.ffffff]±HH` (его ждёт `VERSION_RE` контроллера; вид зависит от `DateStyle` сервера Postgres — на кластере ноды `ISO, MDY`, проверено 30.10) и не должно быть `capture`.

### Task 21: Живая проверка на стенде с владельцем

**Files:** нет. Ролики со сценками — ≈ $1,86 за версию, версий две (OK владельца 30.10).

- [ ] **Step 1: Сценарий спеки, вместе с владельцем**

1. Админка стенда → «Блог» → «Ролики». Заказать ролик и нажать «Запустить сейчас» у его идеи.
2. Дождаться «Ждут решения» (около 9 минут), раскрыть ролик, посмотреть видео и подпись. Предупредить владельца: в первую минуту-две после появления ролика отправка в личку меняет его версию, и первое решение может получить 409 при том же видео — это ожидаемо (спека, «list и get»): «Загрузить заново», и решение проходит. Чтобы шаг 4 проверял именно новую версию видео, раскрывать карточку после того, как ролик пришёл в личку.
3. Во второй вкладке админки отправить «Замечание»; первую вкладку не обновлять. Дождаться новой версии — она приходит и в админку, и в личку @LinkeonTestBot.
4. «Одобрить» в первой, устаревшей вкладке → 409 и жёлтая плашка. «Загрузить заново» → в карточке новое видео, не из кэша: сверить, что это вторая версия.
5. «Одобрить», затем «Опубликовать сейчас» → пост в @linkeontest.
6. «Одобрить» под этим роликом в личке @LinkeonTestBot → «Ролик уже одобрен» или «Ролик уже опубликован».
7. «Настройки роликов» → «Сохранить» без изменений → «Настройки сохранены», режим YouTube прежний.

- [ ] **Step 2: Записать итог и замечания владельца**

Замечания владельца по экрану (лишнее, непонятное) — правками по циклу тест → код → гейты → снова стенд.

### Task 22 (OK владельца): Выкат на прод

**Files:** нет.

- [ ] **Step 1: OK владельца на прод**
- [ ] **Step 2: Проверка, что чужого выката нет (как в задаче 20, шаг 2), и полный `deploy.sh`** отвязанно, флаги — как в задаче 20, без `TEST_ONLY`.
- [ ] **Step 3: Проверка прода**
  - хеш бандла `https://my.linkeon.io/` равен сборке `main`;
  - админка прода → «Блог» → «Ролики»: список показывает ролики прода, раскрытие показывает видео;
  - только чтением: `version` из `admin/shorts list` прода — вида `YYYY-MM-DD HH:MM:SS[.ffffff]±HH`. Другой вид (`DateStyle` прода не ISO) — все решения из админки получат 400: тогда не отдавать экран владельцу, а чинить выдачу версии (`to_char(updated_at AT TIME ZONE 'UTC', …)`);
  - ничего не одобрять за владельца.
- [ ] **Step 4: Убрать за собой**
  - рабочее дерево ноды: `git -C ~/ci/spirits_front worktree remove ~/ci/wt/admin-shorts-front`;
  - рабочие деревья мака `.worktrees/admin-shorts` в обоих репозиториях — после слияния, `git worktree remove`.
