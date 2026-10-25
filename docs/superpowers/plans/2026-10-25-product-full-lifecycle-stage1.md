# Ассистент ведёт продукт целиком — очередь 1. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ассистент создаёт сайты и ботов, удаляет продукты с возвратом в течение 30 дней и откатывает правки. Ключи и удаление подтверждаются защищённой карточкой, которую сервер сам прикрепляет к ответу в вебе и в Telegram.

**Architecture:** все новые действия идут через тот же `manage_product` на `/webhook/mcp/products`. Подтверждения — строки журнала `product_actions`: инструмент заводит ожидающее действие, чат-сервис в конце хода по метке хода из токена дописывает к ответу блок ` ```product-action ``` ` (веб) или ссылку (Flutter), бот Telegram шлёт отдельное сообщение с кнопками. Удаление и возврат ездят на существующих заданиях агента `sleep`/`wake`; агент машины в очереди 1 не меняется.

**Tech Stack:** NestJS 10 + PostgreSQL (бэк `spirits_back`), React 18 + Vite + vitest (фронт `spirits_front`), Telegram (grammy).

**Спека:** `docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md`. Очередь 2 (смена ключей `rekey`, стирание `purge`, `OWNER_TG_ID`, каркас) — отдельным планом после этой.

---

## Отступления от спеки (вносятся в спеку задачей 22)

1. Ручки карточки — `/webhook/product-actions…`, а не `/webhook/products/actions…`: не спорить с маршрутами `products/:id/...` того же контроллера.
2. Отдельного события потока `{type:'product_action'}` нет: карточка едет блоком в ТЕКСТЕ ответа (как метки видео и календаря). Блок рисуется и в потоке, и после перезагрузки из истории — событие ничего не добавляет.
3. В словаре состояний действия есть `working` (взято в работу): «двойное нажатие — один раз» держится переходом `pending → working` одним оператором.
4. Ошибка, которую человек может поправить в той же карточке (Telegram не принял токен, бот уже занят, неверное имя ключа), возвращает действие в `pending` с текстом ошибки.
5. Продукт в `provisioning` удалить нельзя («заводится — через минуту»); возврат отказывает, пока на машине идёт задание продукта.

## Как гонять тесты (обязательно прочитать до первой задачи)

Сборки и тесты — **только на тест-ноде** `dv@85.192.61.231` (CLAUDE.md: мак не тянет). Jest бэка внутри `.worktrees/` не видит ни одного теста (`testPathIgnorePatterns` содержит `/.worktrees/`), поэтому гоняем в CI-клонах ноды `~/ci/wt/pl-back` и `~/ci/wt/pl-front`.

Код на ноду — только через git. Перед каждым прогоном — коммит и пуш. Коммиты не переписываются (без `--amend` и force-push).

```bash
# бэк: коммит уже сделан
B=~/Downloads/spirits_back/.worktrees/product-lifecycle
git -C $B push -q origin HEAD:refs/heads/feat/product-lifecycle
SHA=$(git -C $B rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/pl-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && PROVISIONING_PG_URL='postgres:///pl_test?host=/var/run/postgresql' npx jest --runInBand <файлы через пробел> 2>&1 | grep -E '^(PASS|FAIL)|Tests:|●' | head -60"

# фронт
F=~/Downloads/spirits_front/.worktrees/product-lifecycle
git -C $F push -q origin HEAD:refs/heads/feat/product-lifecycle
SHA=$(git -C $F rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/pl-front && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && npx vitest run <файлы> 2>&1 | tail -25"
```

Ловушки:
- `source ~/.nvm/nvm.sh` — в каждой ssh-команде, иначе node не найдётся.
- Пуш в GitHub с мака сейчас рвётся (VPN): повторить; не помогает — пуш через ноду (`wip/<имя>` из `~/ci`, заметка памяти «Пуш через ноду»).
- SSH к ноде рвётся на рукопожатии (MaxStartups) — повторить через 20–30 с.
- В шаблонах ниже «Run (нода): …» значит: коммит → пуш → команда выше с указанными файлами.
- `PROVISIONING_PG_URL` — одноразовая база `pl_test` (создаётся в задаче 0). Тесты против живого Postgres без неё пропускаются, а не падают — поэтому переменная в команде обязательна.

---

## Структура файлов

**Бэк (`spirits_back`):**

| Файл | Что | Задача |
|---|---|---|
| `src/products/migrations/009_product_actions.sql` | таблица `product_actions`, колонки `purge_after`, `purged_at`, `tg_bot_id`, `first_prompt*` | 1 |
| `src/products/product-slug.ts` | слаг из имени (порт формы Студии) | 2 |
| `src/products/product-tool.token.ts` | метка хода `turn` в токене | 3 |
| `src/chat/products-relay-fields.ts`, `src/products/products-cli-tool.ts` | метка хода в токен | 3 |
| `src/products/bot-token-check.ts` | `getMe` у Telegram | 4 |
| `src/products/product-actions.service.ts` | журнал и ожидающие действия | 5 |
| `src/products/product-lifecycle.service.ts` | создать, удалить, вернуть, откатить; первая правка; гашение удалённых | 6 |
| `src/products/provisioning.service.ts` | выдача `sleep` удалённому, сбой `sleep` не портит `archived` | 7 |
| `src/products/turns.service.ts` | канал у отката | 6 |
| `src/products/product-lifecycle-tool.ts` | новые действия инструмента | 8 |
| `src/products/product-tool.service.ts` | разводка действий, описание, `list` с удалёнными | 8 |
| `src/mcp/products-mcp.controller.ts` | метка хода из токена в `execute` | 9 |
| `src/products/product-actions.controller.ts` | ручки карточки | 10 |
| `src/products/products.module.ts` | регистрация | 10 |
| `src/chat/client-ui.ts`, `src/products/product-action-tail.ts`, `src/chat/chat.service.ts`, `src/chat/chat.module.ts` | карточка к ответу веба и Маши | 11 |
| `src/tg-bot/tg-i18n.ts`, `src/tg-bot/tg-product-actions.service.ts`, `src/tg-bot/tg-router.service.ts`, `src/tg-bot/tg-bot.service.ts`, `src/tg-bot/tg-bot.module.ts` | Telegram | 12 |
| `src/chat/platform-guide.ts`, `relay-agent/server.mjs` | тексты | 13 |

**Фронт (`spirits_front`):**

| Файл | Что | Задача |
|---|---|---|
| `src/services/productActionsApi.ts` (+ `productsApi.ts`: экспорт `problem`) | ручки карточки | 14 |
| `src/utils/productActionBlock.ts`, `src/utils/customMarkdown.tsx` | разбор блока | 15 |
| `src/components/products/ProductActionCard.tsx` | карточка | 16 |
| `src/components/chat/ChatInterface.tsx` | флаг `ui.cards`, карточка в сообщениях, копирование | 17 |
| `src/components/products/PendingProductActions.tsx`, `src/pages/StudioPage.tsx`, `src/utils/pendingDestination.ts` | кабинет | 18 |
| `src/tma/productAction.ts`, `src/tma/App.tsx` | мини-приложение | 19 |
| `src/i18n/locales/*.json` | тексты, 7 языков | 20 |
| `src/components/webvisorPrivacy.test.ts` | сторож Вебвизора | 16 |

---

### Task 0: Подготовка ноды и база для тестов

**Files:** нет изменений в репозиториях.

- [ ] **Step 1: Запушить ветку фронта** (бэк уже на GitHub со спекой)

```bash
git -C ~/Downloads/spirits_front/.worktrees/product-lifecycle push -u origin feat/product-lifecycle
```

- [ ] **Step 2: CI-клоны на ноде**

```bash
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/pl-back origin/feat/product-lifecycle && cd ~/ci/wt/pl-back && source ~/.nvm/nvm.sh >/dev/null && npm ci --no-audit --no-fund >/dev/null && npx tsc -p tsconfig.build.json --noEmit && echo back-ok'
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/pl-front origin/feat/product-lifecycle && cd ~/ci/wt/pl-front && source ~/.nvm/nvm.sh >/dev/null && pnpm install --frozen-lockfile >/dev/null && echo front-ok'
```
Expected: `back-ok`, `front-ok`.

- [ ] **Step 3: Одноразовая база**

```bash
ssh dv@85.192.61.231 'createdb -h /var/run/postgresql pl_test 2>/dev/null; psql -h /var/run/postgresql -d pl_test -tAc "select 1"'
```
Expected: `1`.

- [ ] **Step 4: Базовая линия** — запомнить числа, дальше мерить дельтой

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/pl-back && source ~/.nvm/nvm.sh >/dev/null && PROVISIONING_PG_URL='postgres:///pl_test?host=/var/run/postgresql' npx jest --runInBand src/products src/mcp src/chat src/tg-bot 2>&1 | grep -E '^Tests:|^Test Suites:'"
ssh dv@85.192.61.231 "cd ~/ci/wt/pl-front && source ~/.nvm/nvm.sh >/dev/null && npx vitest run src/components/chat src/components/products src/utils src/tma src/pages 2>&1 | tail -4"
```

---

### Task 1: Миграция 009

**Files:**
- Create: `src/products/migrations/009_product_actions.sql`
- Modify: `src/products/products.service.ts` (константа `MIGRATIONS`, строки ~67–76)
- Modify: `src/products/products.migration.spec.ts` (литеральный список, строки ~372–381)
- Create: `src/products/product-actions.migration.spec.ts`

- [ ] **Step 1: Тест против живой базы**

`src/products/product-actions.migration.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('009_product_actions против живого Postgres', () => {
  let pool: Pool;
  const apply = async () => {
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await apply();
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('второй прогон всего списка проходит без ошибок', async () => {
    await expect(apply()).resolves.toBeUndefined();
  });

  it('у продуктов есть колонки удаления, бота и первой правки', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'
         AND column_name IN ('purge_after','purged_at','tg_bot_id','first_prompt','first_prompt_channel')`,
    );
    expect(r.rows.map((x: any) => x.column_name).sort()).toEqual(
      ['first_prompt', 'first_prompt_channel', 'purge_after', 'purged_at', 'tg_bot_id'],
    );
  });

  it('словари действия держит сама база', async () => {
    const bad = (kind: string, status: string, channel: string) =>
      pool.query(
        `INSERT INTO product_actions (user_id, kind, status, channel) VALUES ('u', $1, $2, $3)`,
        [kind, status, channel],
      );
    await expect(bad('create_bot', 'pending', 'web')).resolves.toBeDefined();
    await expect(bad('nuke', 'pending', 'web')).rejects.toThrow(/check/i);
    await expect(bad('delete', 'maybe', 'web')).rejects.toThrow(/check/i);
    await expect(bad('delete', 'pending', 'fax')).rejects.toThrow(/check/i);
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/products/product-actions.migration.spec.ts && git -C $B commit -q -m "test(products): миграция 009 — журнал действий (красный)"
```
Run (нода): `src/products/product-actions.migration.spec.ts`. Expected: FAIL — нет колонок и таблицы.

- [ ] **Step 3: Миграция**

`src/products/migrations/009_product_actions.sql`:

```sql
-- 009_product_actions.sql
-- Ассистент ведёт продукт целиком. Спека:
-- docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md.
-- Катится на каждом старте вместе со всем списком MIGRATIONS, идемпотентно.
SELECT pg_advisory_xact_lock(hashtext('products/009_product_actions'));

-- Мягкое удаление. archived_at уже есть — по нему считают место в пределе и
-- аренду. purge_after — до какого момента продукт можно вернуть; purged_at —
-- когда стёрт насовсем (очередь 2).
ALTER TABLE products ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS purged_at timestamptz;
-- Идентификатор бота Telegram — не секрет. Два живых продукта на одном токене
-- отнимают друг у друга обновления.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tg_bot_id bigint;
-- Первая правка, переданная при создании: ставится, как только продукт поднялся.
ALTER TABLE products ADD COLUMN IF NOT EXISTS first_prompt text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS first_prompt_channel text;

-- Ожидающие действия (карточки) и журнал жизненного цикла. Значений ключей
-- здесь нет: в payload — только имена, secrets_box — шифротекст до конца
-- задания (очередь 2). Словари — встроенными CHECK, а не ADD CONSTRAINT:
-- сторож products.migration.spec ведёт учёт именованных словарей продуктов.
CREATE TABLE IF NOT EXISTS product_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('create_site','create_bot','keys','delete','restore','revert','purge')),
  status        text NOT NULL CHECK (status IN ('pending','working','done','failed','expired','cancelled')),
  channel       text NOT NULL CHECK (channel IN ('web','telegram','system')),
  confirmed_via text CHECK (confirmed_via IN ('chat','telegram','tma','cabinet')),
  turn_nonce    text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets_box   bytea,
  result        jsonb,
  attached_at   timestamptz,
  tg_chat_id    bigint,
  tg_message_id bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  resolved_at   timestamptz
);

-- Индексы — только если их нет: CREATE INDEX IF NOT EXISTS на каждом старте
-- берёт ShareLock на таблицу даже при существующем индексе.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_product_actions_user_pending') THEN
    CREATE INDEX idx_product_actions_user_pending ON product_actions (user_id, created_at) WHERE status = 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_products_purge_after') THEN
    CREATE INDEX idx_products_purge_after ON products (purge_after) WHERE archived_at IS NOT NULL AND purged_at IS NULL;
  END IF;
END $$;
```

- [ ] **Step 4: В список миграций**

В `src/products/products.service.ts` в `MIGRATIONS` после `'008_domains.sql',` добавить строку `'009_product_actions.sql',`. Миграция НЕ обязательная (в `FATAL_MIGRATIONS` не вносится): без неё продукты работают как раньше, а новые действия честно падают.

В `src/products/products.migration.spec.ts` в литеральном массиве ожидаемого порядка после `'008_domains.sql',` добавить `'009_product_actions.sql',`.

- [ ] **Step 5: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: миграция 009 — журнал действий, удаление с возвратом, бот и первая правка"
```
Run (нода): `src/products/product-actions.migration.spec.ts src/products/products.migration.spec.ts`. Expected: PASS.

---

### Task 2: Слаг на сервере

**Files:**
- Create: `src/products/product-slug.ts`
- Test: `src/products/product-slug.spec.ts`

- [ ] **Step 1: Тест**

```ts
import { SLUG_RE } from './provisioning.service';
import { randomSuffix, siteSlugCandidates, slugifyName, slugWithSuffix, SLUG_MAX } from './product-slug';

describe('слаг из имени — как в форме Студии', () => {
  it('кириллица транслитерируется, лишнее — в дефис', () => {
    expect(slugifyName('Магазин цветов')).toBe('magazin-cvetov');
    expect(slugifyName('  Ёжик & Ко!!! ')).toBe('ezhik-ko');
    // «й» после NFD — «и» с кратким знаком: знак срезается, как и в форме.
    expect(slugifyName('Мой бот')).toBe('moi-bot');
  });

  it('пустое и без букв — пустая строка', () => {
    expect(slugifyName('')).toBe('');
    expect(slugifyName('!!! ???')).toBe('');
  });

  it('хвост: основа + 6 знаков, без основы — вид-хвост, всегда годный слаг', () => {
    expect(slugWithSuffix('Магазин цветов', 'abc123', 'bot')).toBe('magazin-cvetov-abc123');
    expect(slugWithSuffix('!!!', 'abc123', 'site')).toBe('site-abc123');
    const long = slugWithSuffix('очень '.repeat(20), 'zz99zz', 'bot');
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(SLUG_RE.test(long)).toBe(true);
  });

  it('случайный хвост — 6 строчных латинских или цифр', () => {
    for (let i = 0; i < 50; i++) expect(randomSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });

  it('сайт: сначала чистая основа (станет адресом), потом три с хвостом', () => {
    expect(siteSlugCandidates('Магазин цветов', () => 'zzzzzz')).toEqual([
      'magazin-cvetov', 'magazin-cvetov-zzzzzz', 'magazin-cvetov-zzzzzz', 'magazin-cvetov-zzzzzz',
    ]);
    expect(siteSlugCandidates('!!!', () => 'q1q1q1')).toEqual(['site-q1q1q1', 'site-q1q1q1', 'site-q1q1q1']);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`Cannot find module './product-slug'`)

- [ ] **Step 3: Реализация**

`src/products/product-slug.ts`:

```ts
import * as crypto from 'crypto';
import { SLUG_RE } from './provisioning.service';

/** Потолок длины — тот же, что у SLUG_RE (1–40). */
export const SLUG_MAX = 40;
const SUFFIX_LEN = 6;
const SUFFIX_ABC = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Та же таблица, что в форме Студии (spirits_front NewProductForm.tsx):
 * слаг, придуманный ассистентом, не должен отличаться от слага из кнопки.
 * Строки «й» и «ё» здесь мёртвые — NFD раскладывает их раньше, — но таблица
 * держится в одном виде с формой.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/** Название → слаг. Пусто, если от названия не осталось ни буквы. */
export function slugifyName(name: string): string {
  const latin = Array.from(String(name ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''))
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('');
  return latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export function randomSuffix(): string {
  return Array.from(crypto.randomBytes(SUFFIX_LEN), (b) => SUFFIX_ABC[b % SUFFIX_ABC.length]).join('');
}

/** Основа из имени и хвост; без основы — `<вид>-<хвост>`. Как deriveBotSlug формы. */
export function slugWithSuffix(name: string, suffix: string, kind: 'site' | 'bot'): string {
  const room = SLUG_MAX - suffix.length - 1;
  const base = slugifyName(name).slice(0, room).replace(/-+$/g, '');
  return base ? `${base}-${suffix}` : `${kind}-${suffix}`;
}

/**
 * Кандидаты слага сайта по порядку. Слаг сайта — это его адрес, поэтому
 * сначала чистая основа; хвост — когда она занята или негодна.
 */
export function siteSlugCandidates(name: string, suffix: () => string = randomSuffix): string[] {
  const base = slugifyName(name);
  const out: string[] = [];
  if (base && SLUG_RE.test(base)) out.push(base);
  for (let i = 0; i < 3; i++) out.push(slugWithSuffix(name, suffix(), 'site'));
  return out;
}
```

`\p{M}` вместо диапазона `̀-ͯ` формы — намеренно: инструмент записи файлов портит `\u`-последовательности (заметка памяти), а для кириллицы и латиницы результат тот же.

- [ ] **Step 4: Коммит, прогон — PASS** (`src/products/product-slug.spec.ts`)

```bash
git -C $B add src/products/product-slug.ts src/products/product-slug.spec.ts && git -C $B commit -q -m "products: слаг из имени на сервере — та же транслитерация, что в форме Студии"
```

---

### Task 3: Метка хода в токене инструмента

**Files:**
- Modify: `src/products/product-tool.token.ts`
- Modify: `src/chat/products-relay-fields.ts`
- Modify: `src/products/products-cli-tool.ts:90-104`
- Modify: `src/products/product-tool.token.spec.ts:33`
- Test: `src/products/product-tool.token.turn.spec.ts`

- [ ] **Step 1: Тест**

`src/products/product-tool.token.turn.spec.ts`:

```ts
import * as jwt from 'jsonwebtoken';
import { signProductToolToken, verifyProductToolToken, PRODUCT_TOOL_TOKEN_TYPE } from './product-tool.token';
import { productsRelayFields } from '../chat/products-relay-fields';
import { productsCliMcp } from './products-cli-tool';

const TURN = '11111111-2222-4333-8444-555555555555';

describe('метка хода в токене инструмента продуктов', () => {
  it('подписанная метка доезжает до проверки', () => {
    expect(verifyProductToolToken(signProductToolToken('u1', 'web', TURN))).toEqual({ userId: 'u1', channel: 'web', turn: TURN });
  });

  it('без метки — null, как у старых токенов', () => {
    expect(verifyProductToolToken(signProductToolToken('u1', 'telegram'))).toEqual({ userId: 'u1', channel: 'telegram', turn: null });
  });

  it('подписать не-uuid нельзя', () => {
    expect(() => signProductToolToken('u1', 'web', 'drop table')).toThrow(/uuid/);
  });

  it('чужая форма метки в подписанном токене — null, а не строка как есть', () => {
    const t = jwt.sign({ userId: 'u1', type: PRODUCT_TOOL_TOKEN_TYPE, channel: 'web', turn: 'x' }, process.env.JWT_SECRET || 'default_secret_change_me');
    expect(verifyProductToolToken(t).turn).toBeNull();
  });

  it('релей и локальный CLI кладут метку в токен', () => {
    const relay = productsRelayFields('u1', TURN).products_token;
    expect(verifyProductToolToken(relay).turn).toBe(TURN);
    const cli = productsCliMcp('u1', 'telegram', TURN);
    const auth = (Object.values(cli.mcpServers)[0] as any).headers.Authorization as string;
    expect(verifyProductToolToken(auth.replace(/^Bearer /, ''))).toEqual({ userId: 'u1', channel: 'telegram', turn: TURN });
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (лишний аргумент, нет поля `turn`)

- [ ] **Step 3: Реализация**

В `src/products/product-tool.token.ts`:

1. Интерфейс:
```ts
export interface ProductToolClaims {
  userId: string;
  channel: ProductToolChannel;
  /**
   * Метка хода чата, в котором выпущен токен. По ней чат-сервис в конце хода
   * находит карточки, заведённые этим ходом. null — у старых токенов и у
   * вызовов вне хода.
   */
  turn: string | null;
}

const TURN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```
2. Подпись:
```ts
export function signProductToolToken(userId: string, channel: ProductToolChannel = 'web', turn?: string): string {
  const ttl = TTL_SECONDS[channel];
  if (!ttl) throw new Error(`Неизвестный канал: ${channel}`);
  if (turn !== undefined && !TURN_RE.test(turn)) throw new Error('Метка хода — не uuid');
  return jwt.sign(
    { userId, type: PRODUCT_TOOL_TOKEN_TYPE, channel, ...(turn ? { turn } : {}) },
    secret(),
    { expiresIn: ttl },
  );
}
```
3. В `verifyProductToolToken` после строки с `const userId = payload?.userId;` и её проверки добавить
```ts
  const turn = typeof payload?.turn === 'string' && TURN_RE.test(payload.turn) ? payload.turn : null;
```
и в обоих `return` вернуть `turn`: `return { userId, channel: 'web', turn };` и `return { userId, channel: raw, turn };`.

В `src/chat/products-relay-fields.ts`:
```ts
export function productsRelayFields(userId: string, turn?: string): { products_token: string; products_mcp_url: string } {
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  return {
    products_token: signProductToolToken(userId, 'web', turn),
    products_mcp_url: `${base}/webhook/mcp/products`,
  };
}
```

В `src/products/products-cli-tool.ts` сигнатура `productsCliMcp(userId: string, channel: ProductToolChannel, turn?: string)`, в заголовке `Bearer ${signProductToolToken(userId, channel, turn)}`.

В `src/products/product-tool.token.spec.ts:33` ожидание `{ userId: '79030169187', channel: 'web' }` → `{ userId: '79030169187', channel: 'web', turn: null }`.

- [ ] **Step 4: Коммит, прогон — PASS**

Run (нода): `src/products/product-tool.token.turn.spec.ts src/products/product-tool.token.spec.ts src/chat/products-relay-fields src/products/products-cli-tool`.

```bash
git -C $B add -A src && git -C $B commit -q -m "products: метка хода в токене инструмента — по ней карточки находят свой ход"
```

---

### Task 4: Проверка токена бота в Telegram

**Files:**
- Create: `src/products/bot-token-check.ts`
- Test: `src/products/bot-token-check.spec.ts`

- [ ] **Step 1: Тест**

```ts
import { checkBotToken } from './bot-token-check';

const TOKEN = '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj';
const res = (status: number, body: any) => ({ status, json: async () => body }) as any;

describe('проверка токена бота', () => {
  it('не похоже на токен — даже не идём в Telegram', async () => {
    const f = jest.fn();
    expect(await checkBotToken('nope', f as any)).toEqual({ ok: false, reason: 'bad_form' });
    expect(f).not.toHaveBeenCalled();
  });

  it('Telegram принял — id и имя бота', async () => {
    const f = jest.fn(async () => res(200, { ok: true, result: { id: 1234567890, username: 'shop_bot' } }));
    expect(await checkBotToken(` ${TOKEN} `, f as any)).toEqual({ ok: true, id: 1234567890, username: 'shop_bot' });
    expect((f.mock.calls[0] as any[])[0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('401 — токен отозван или чужой', async () => {
    expect(await checkBotToken(TOKEN, (async () => res(401, { ok: false })) as any)).toEqual({ ok: false, reason: 'rejected' });
  });

  it('тело без ok: true — не успех (прокси, заглушка)', async () => {
    expect(await checkBotToken(TOKEN, (async () => res(200, {})) as any)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('сетевая ошибка — unreachable, текст с токеном наружу не уходит', async () => {
    const r = await checkBotToken(TOKEN, (async () => { throw new Error(`fetch failed https://api.telegram.org/bot${TOKEN}`); }) as any);
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Реализация**

`src/products/bot-token-check.ts`:

```ts
export type BotTokenCheck =
  | { ok: true; id: number; username: string }
  | { ok: false; reason: 'bad_form' | 'rejected' | 'unreachable' };

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

/**
 * getMe у Telegram: живой ли токен и какой это бот. Ответ проверяется на
 * `ok !== true`, а не на `ok === false` — тело без поля приезжает от прокси и
 * заглушек (то же правило, что в каркасе бота). Текст ошибки fetch содержит
 * адрес с токеном, поэтому наружу уходит только код причины.
 */
export async function checkBotToken(
  token: string,
  fetchFn: (url: string, init?: any) => Promise<any> = fetch as any,
  timeoutMs = 8_000,
): Promise<BotTokenCheck> {
  const t = String(token ?? '').trim();
  if (!TOKEN_RE.test(t)) return { ok: false, reason: 'bad_form' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${t}/getMe`, { signal: ctrl.signal });
    const body: any = await res.json().catch(() => null);
    if (body?.ok === true && typeof body?.result?.id === 'number') {
      return { ok: true, id: body.result.id, username: String(body.result.username ?? '') };
    }
    return { ok: false, reason: res.status === 401 || res.status === 404 ? 'rejected' : 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add src/products/bot-token-check.ts src/products/bot-token-check.spec.ts && git -C $B commit -q -m "products: проверка токена бота у Telegram (getMe) без утечки токена в ошибки"
```

---

### Task 5: Журнал и ожидающие действия

**Files:**
- Create: `src/products/product-actions.service.ts`
- Test: `src/products/product-actions.service.spec.ts` (без базы)
- Test: `src/products/product-actions.pg.spec.ts` (живая база)

- [ ] **Step 1: Тесты**

`src/products/product-actions.service.spec.ts`:

```ts
import { ProductActionsService, toView, ACTION_TTL_MINUTES, type ActionRow } from './product-actions.service';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const row = (over: Partial<ActionRow> = {}): ActionRow => ({
  id: ID, user_id: 'u1', product_id: 'p1', kind: 'delete', status: 'pending', channel: 'web', confirmed_via: null,
  payload: { name: 'Магазин' }, result: null, created_at: new Date('2026-10-25T10:00:00Z'),
  expires_at: new Date('2026-10-25T10:30:00Z'), resolved_at: null, tg_chat_id: null, tg_message_id: null,
  product_name: 'Магазин', purge_after: null, ...over,
});

function make() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pg = { query: jest.fn(async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; }) };
  return { svc: new ProductActionsService(pg as any), calls, pg };
}

describe('вид действия', () => {
  const now = new Date('2026-10-25T10:10:00Z');

  it('ожидающее после срока — expired', () => {
    expect(toView(row(), new Date('2026-10-25T10:31:00Z')).status).toBe('expired');
    expect(toView(row(), now).status).toBe('pending');
  });

  it('ожидающее удаление обещает дату возврата через 30 дней, сделанное — из итога', () => {
    expect(toView(row(), now).restoreUntil).toBe('2026-11-24T10:10:00.000Z');
    expect(toView(row({ status: 'done', result: { restoreUntil: '2026-11-24T10:12:00.000Z' } }), now).restoreUntil)
      .toBe('2026-11-24T10:12:00.000Z');
  });

  it('имена ключей — из payload, значений нет и взять неоткуда', () => {
    const v = toView(row({ kind: 'create_bot', product_id: null, product_name: null, payload: { name: 'Бот', keyNames: ['A'] } }), now);
    expect(v).toMatchObject({ productName: 'Бот', keyNames: ['A'], productId: null });
  });
});

describe('ProductActionsService', () => {
  it('open — ожидающее с меткой хода и сроком', async () => {
    const h = make();
    h.pg.query.mockResolvedValueOnce({ rows: [{ id: ID, expires_at: new Date('2026-10-25T10:30:00Z') }], rowCount: 1 } as any);
    const r = await h.svc.open({ userId: 'u1', productId: null, kind: 'create_bot', channel: 'web', turn: 't-1', payload: { name: 'Бот' } });
    expect(r).toEqual({ id: ID, expiresAt: '2026-10-25T10:30:00.000Z' });
    expect(h.calls[0].sql).toMatch(/'pending'/);
    expect(h.calls[0].params).toEqual(['u1', null, 'create_bot', 'web', 't-1', JSON.stringify({ name: 'Бот' }), ACTION_TTL_MINUTES]);
  });

  it('claim и get с не-uuid не ходят в базу', async () => {
    const h = make();
    expect(await h.svc.claim('u1', 'nope', 'chat')).toBeNull();
    expect(await h.svc.get('u1', 'nope')).toBeNull();
    expect(h.pg.query).not.toHaveBeenCalled();
  });

  it('claim — один оператор: только pending, только до срока, только свой', async () => {
    const h = make();
    await h.svc.claim('u1', ID, 'cabinet');
    expect(h.calls[0].sql).toMatch(/status = 'working'/);
    expect(h.calls[0].sql).toMatch(/status = 'pending'/);
    expect(h.calls[0].sql).toMatch(/expires_at > now\(\)/);
    expect(h.calls[0].params).toEqual([ID, 'u1', 'cabinet']);
  });

  it('takeForTurn — по метке ИЛИ по окну хода, по порядку заведения', async () => {
    const h = make();
    h.pg.query.mockResolvedValueOnce({
      rows: [
        { id: 'b', kind: 'delete', payload: {}, created_at: new Date('2026-10-25T10:02:00Z') },
        { id: 'a', kind: 'create_bot', payload: {}, created_at: new Date('2026-10-25T10:01:00Z') },
      ], rowCount: 2,
    } as any);
    const since = new Date('2026-10-25T10:00:00Z');
    const r = await h.svc.takeForTurn('u1', 't-1', since);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(h.calls[0].sql).toMatch(/attached_at IS NULL/);
    expect(h.calls[0].sql).toMatch(/turn_nonce = \$2 OR created_at >= \$3/);
    expect(h.calls[0].params).toEqual(['u1', 't-1', since]);
  });
});
```

`src/products/product-actions.pg.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProductActionsService } from './product-actions.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('журнал действий против живого Postgres', () => {
  let pool: Pool;
  let svc: ProductActionsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    svc = new ProductActionsService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(() => pool.query('TRUNCATE product_actions RESTART IDENTITY CASCADE'));
  afterAll(async () => { await pool.query('TRUNCATE product_actions RESTART IDENTITY CASCADE'); await pool.end(); });

  it('одновременные нажатия — взять в работу удаётся ровно одному', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
    const got = await Promise.all([1, 2, 3, 4].map(() => svc.claim('u1', id, 'chat')));
    expect(got.filter(Boolean)).toHaveLength(1);
  });

  it('чужой пользователь не видит и не берёт', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
    expect(await svc.get('u2', id)).toBeNull();
    expect(await svc.claim('u2', id, 'chat')).toBeNull();
  });

  it('просроченное не берётся', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
    await pool.query(`UPDATE product_actions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await svc.claim('u1', id, 'chat')).toBeNull();
  });

  it('карточка прикрепляется к ходу один раз: по метке или по окну хода', async () => {
    const since = new Date(Date.now() - 1000);
    const a = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: '11111111-2222-4333-8444-555555555555', payload: {} });
    const b = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: '99999999-2222-4333-8444-555555555555', payload: {} });
    const first = await svc.takeForTurn('u1', '11111111-2222-4333-8444-555555555555', since);
    expect(first.map((x) => x.id).sort()).toEqual([a.id, b.id].sort()); // b — по окну хода
    expect(await svc.takeForTurn('u1', '11111111-2222-4333-8444-555555555555', since)).toEqual([]);
  });

  it('release возвращает в ожидание с ошибкой, finish закрывает', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'create_bot', channel: 'web', turn: null, payload: {} });
    await svc.claim('u1', id, 'chat');
    await svc.release(id, { error: 'Telegram не принял токен' });
    expect((await svc.get('u1', id))!.status).toBe('pending');
    await svc.claim('u1', id, 'chat');
    await svc.finish(id, 'done', { productId: null });
    expect((await svc.get('u1', id))!.status).toBe('done');
    expect(await svc.cancel('u1', id)).toBe(false);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Реализация**

`src/products/product-actions.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

export type ActionKind = 'create_site' | 'create_bot' | 'keys' | 'delete' | 'restore' | 'revert' | 'purge';
export type ActionStatus = 'pending' | 'working' | 'done' | 'failed' | 'expired' | 'cancelled';
export type ActionChannel = 'web' | 'telegram' | 'system';
export type ConfirmedVia = 'chat' | 'telegram' | 'tma' | 'cabinet';
/** Действия, которые ждут человека. Остальные пишутся в журнал сразу итогом. */
export type CardKind = 'create_bot' | 'delete' | 'keys';

export const ACTION_TTL_MINUTES = 30;
const GRACE_DAYS_FOR_VIEW = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActionRow {
  id: string;
  user_id: string;
  product_id: string | null;
  kind: ActionKind;
  status: ActionStatus;
  channel: ActionChannel;
  confirmed_via: ConfirmedVia | null;
  payload: any;
  result: any;
  created_at: Date;
  expires_at: Date | null;
  resolved_at: Date | null;
  tg_chat_id: string | null;
  tg_message_id: string | null;
  product_name?: string | null;
  purge_after?: Date | null;
}

export interface ActionView {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  productId: string | null;
  productName: string | null;
  keyNames: string[];
  expiresAt: string | null;
  restoreUntil: string | null;
  result: Record<string, unknown> | null;
}

const COLUMNS = `a.id, a.user_id, a.product_id, a.kind, a.status, a.channel, a.confirmed_via, a.payload,
                 a.result, a.created_at, a.expires_at, a.resolved_at, a.tg_chat_id, a.tg_message_id,
                 p.name AS product_name, p.purge_after`;

/**
 * Вид для карточки и ассистента. Значений ключей в нём нет по построению: их
 * нет ни в payload, ни в result — в строку пишутся только имена.
 */
export function toView(row: ActionRow, now: Date = new Date()): ActionView {
  const expired = row.status === 'pending' && row.expires_at !== null && new Date(row.expires_at) <= now;
  let restoreUntil: string | null = null;
  if (row.kind === 'delete') {
    restoreUntil = row.status === 'done'
      ? (typeof row.result?.restoreUntil === 'string' ? row.result.restoreUntil : null)
      : new Date(now.getTime() + GRACE_DAYS_FOR_VIEW * 86_400_000).toISOString();
  }
  return {
    id: row.id,
    kind: row.kind,
    status: expired ? 'expired' : row.status,
    productId: row.product_id,
    productName: row.product_name ?? (typeof row.payload?.name === 'string' ? row.payload.name : null),
    keyNames: Array.isArray(row.payload?.keyNames) ? row.payload.keyNames : [],
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    restoreUntil,
    result: row.result ?? null,
  };
}

/**
 * Ожидающие действия (карточки) и журнал жизненного цикла продуктов.
 * Каждый переход — один оператор со своими предусловиями: «двойное нажатие —
 * один раз» держит база, а не проверка в коде между двумя запросами.
 */
@Injectable()
export class ProductActionsService {
  constructor(private readonly pg: PgService) {}

  async open(i: {
    userId: string;
    productId: string | null;
    kind: CardKind;
    channel: ActionChannel;
    turn: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; expiresAt: string }> {
    const r = await this.pg.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, turn_nonce, payload, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6::jsonb, now() + make_interval(mins => $7))
       RETURNING id, expires_at`,
      [i.userId, i.productId, i.kind, i.channel, i.turn, JSON.stringify(i.payload), ACTION_TTL_MINUTES],
    );
    return { id: r.rows[0].id, expiresAt: new Date(r.rows[0].expires_at).toISOString() };
  }

  /** Строка журнала для действия без карточки. К ходу не прикрепляется. */
  async record(i: {
    userId: string;
    productId: string | null;
    kind: ActionKind;
    channel: ActionChannel;
    status: 'done' | 'failed';
    payload?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }): Promise<string> {
    const r = await this.pg.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, result, attached_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now(), now())
       RETURNING id`,
      [i.userId, i.productId, i.kind, i.status, i.channel, JSON.stringify(i.payload ?? {}), JSON.stringify(i.result ?? {})],
    );
    return r.rows[0].id;
  }

  /**
   * Карточки, заведённые ходом: по метке из токена ИЛИ (запасной путь —
   * релей принёс токен прошлого хода) заведённые за время хода. Каждая
   * отдаётся один раз: attached_at ставится тем же оператором.
   */
  async takeForTurn(userId: string, turn: string | null, since: Date): Promise<Array<{ id: string; kind: CardKind; payload: any }>> {
    const r = await this.pg.query(
      `UPDATE product_actions SET attached_at = now()
        WHERE user_id = $1 AND status = 'pending' AND attached_at IS NULL
          AND (turn_nonce = $2 OR created_at >= $3)
       RETURNING id, kind, payload, created_at`,
      [userId, turn, since],
    );
    return [...r.rows]
      .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((x: any) => ({ id: x.id, kind: x.kind, payload: x.payload }));
  }

  async get(userId: string, id: string): Promise<ActionRow | null> {
    if (!UUID_RE.test(String(id))) return null;
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM product_actions a LEFT JOIN products p ON p.id = a.product_id
        WHERE a.id = $1 AND a.user_id = $2`,
      [id, userId],
    );
    return r.rows[0] ?? null;
  }

  /** Без владельца — для кнопок Telegram, где владельца проверяет вызывающий. */
  async getById(id: string): Promise<ActionRow | null> {
    if (!UUID_RE.test(String(id))) return null;
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM product_actions a LEFT JOIN products p ON p.id = a.product_id WHERE a.id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async listPending(userId: string): Promise<ActionRow[]> {
    const r = await this.pg.query(
      `SELECT ${COLUMNS} FROM product_actions a LEFT JOIN products p ON p.id = a.product_id
        WHERE a.user_id = $1 AND a.status = 'pending' AND a.expires_at > now()
        ORDER BY a.created_at`,
      [userId],
    );
    return r.rows;
  }

  /** Взять в работу. Повторное нажатие, чужой и просроченный получают null. */
  async claim(userId: string, id: string, via: ConfirmedVia): Promise<ActionRow | null> {
    if (!UUID_RE.test(String(id))) return null;
    const r = await this.pg.query(
      `UPDATE product_actions SET status = 'working', confirmed_via = $3
        WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now()
       RETURNING *`,
      [id, userId, via],
    );
    return r.rows[0] ?? null;
  }

  /** Вернуть в ожидание с ошибкой — то, что человек поправит в той же карточке. */
  async release(id: string, result: Record<string, unknown>): Promise<void> {
    await this.pg.query(
      `UPDATE product_actions SET status = 'pending', confirmed_via = NULL, result = $2::jsonb
        WHERE id = $1 AND status = 'working'`,
      [id, JSON.stringify(result)],
    );
  }

  async finish(id: string, status: 'done' | 'failed', result: Record<string, unknown>, productId?: string): Promise<void> {
    await this.pg.query(
      `UPDATE product_actions
          SET status = $2, result = $3::jsonb, resolved_at = now(), product_id = COALESCE($4::uuid, product_id)
        WHERE id = $1 AND status = 'working'`,
      [id, status, JSON.stringify(result), productId ?? null],
    );
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    if (!UUID_RE.test(String(id))) return false;
    const r = await this.pg.query(
      `UPDATE product_actions SET status = 'cancelled', resolved_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, userId],
    );
    return r.rows.length > 0;
  }

  async setTelegramMessage(id: string, chatId: number, messageId: number): Promise<void> {
    await this.pg.query(
      `UPDATE product_actions SET tg_chat_id = $2, tg_message_id = $3 WHERE id = $1`,
      [id, chatId, messageId],
    );
  }
}
```

- [ ] **Step 4: Коммит, прогон — PASS**

Run (нода): `src/products/product-actions.service.spec.ts src/products/product-actions.pg.spec.ts`.

```bash
git -C $B add src/products/product-actions.* && git -C $B commit -q -m "products: журнал действий — ожидающие карточки и итоги, переходы одним оператором"
```

---

### Task 6: Жизненный цикл: создать, удалить, вернуть, откатить

**Files:**
- Create: `src/products/product-lifecycle.service.ts`
- Modify: `src/products/turns.service.ts:514-537` (канал у `revert`)
- Test: `src/products/product-lifecycle.service.spec.ts`
- Test: `src/products/turns.revert.spec.ts` (добавить один тест)

- [ ] **Step 1: Тесты**

В конец `src/products/turns.revert.spec.ts` (импорт `TurnsService` в файле уже есть):

```ts
describe('канал отката', () => {
  it('откат несёт канал, из которого попросили; по умолчанию web', async () => {
    const pg = { query: jest.fn(async (sql: string) => (sql.includes('FROM product_turns') ? { rows: [{ id: 't1', sha_before: 'abc' }] } : { rows: [] })) };
    const svc = new TurnsService(pg as any, { checkTokenBalance: jest.fn(), deductTokens: jest.fn() } as any);
    const spy = jest.spyOn(svc, 'enqueue').mockResolvedValue({ id: 'new', status: 'queued' } as any);
    await svc.revert({ productId: 'p1', turnId: 't1', userId: 'u1', channel: 'telegram' });
    await svc.revert({ productId: 'p1', turnId: 't1', userId: 'u1' });
    expect(spy.mock.calls.map((c) => c[0].channel)).toEqual(['telegram', 'web']);
  });
});
```

`src/products/product-lifecycle.service.spec.ts`:

```ts
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ProductLifecycleService, DELETE_GRACE_DAYS } from './product-lifecycle.service';

const ACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN = '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj';

function harness(o: { pg?: (sql: string, params: any[]) => any; createErrors?: any[] } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const custom = o.pg?.(sql, params);
      if (custom) return custom;
      if (sql.includes('FROM ai_profiles_consolidated')) return { rows: [{ isadmin: false }] };
      if (sql.includes('SELECT domain FROM products')) return { rows: [{ domain: 'magazin.c.linkeon.io' }] };
      return { rows: [], rowCount: 0 };
    }),
  };
  const createErrors = [...(o.createErrors ?? [])];
  const provisioning = {
    create: jest.fn(async () => {
      const e = createErrors.shift();
      if (e) throw e;
      return { productId: 'p-new' };
    }),
  };
  const limits = { assertCanCreate: jest.fn(async () => undefined) };
  const turns = { enqueue: jest.fn(async () => ({ id: 't-new', status: 'queued' })), revert: jest.fn(async () => ({ id: 't-rev', status: 'queued' })) };
  const actions = {
    open: jest.fn(async () => ({ id: ACT, expiresAt: '2026-10-25T10:30:00.000Z' })),
    record: jest.fn(async () => 'rec'),
    claim: jest.fn(async () => null as any),
    release: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const svc = new ProductLifecycleService(pg as any, provisioning as any, limits as any, turns as any, actions as any);
  (svc as any).suffix = () => 'zzzzzz';
  (svc as any).checkBot = jest.fn(async () => ({ ok: true, id: 1234567890, username: 'shop_bot' }));
  return { svc, pg, calls, provisioning, limits, turns, actions };
}

describe('создание сайта', () => {
  it('занят чистый слаг — берётся с хвостом; первая правка запоминается; журнал', async () => {
    const h = harness({ createErrors: [new ConflictException('слаг уже занят')] });
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', prompt: 'Лендинг с ценами', channel: 'web' });
    expect(r).toEqual({ ok: true, productId: 'p-new', slug: 'magazin-zzzzzz', domain: 'magazin.c.linkeon.io' });
    expect(h.provisioning.create.mock.calls.map((c: any) => c[0].slug)).toEqual(['magazin', 'magazin-zzzzzz']);
    expect(h.provisioning.create.mock.calls[1][0]).toMatchObject({ kind: 'site', secrets: {}, isAdmin: false });
    expect(h.calls.some((c) => c.sql.includes('SET first_prompt') && c.params[1] === 'Лендинг с ценами' && c.params[2] === 'web')).toBe(true);
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create_site', status: 'done' }));
  });

  it('предел занят — reason limit с текстом заведения', async () => {
    const h = harness({ createErrors: [new UnprocessableEntityException('Предел — 2 продукта на один аккаунт')] });
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', channel: 'web' });
    expect(r).toEqual({ ok: false, reason: 'limit', message: 'Предел — 2 продукта на один аккаунт' });
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create_site', status: 'failed' }));
  });

  it('пустое имя — без заведения', async () => {
    const h = harness();
    expect((await h.svc.createSite({ userId: 'u1', name: '  ', channel: 'web' })).ok).toBe(false);
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });
});

describe('создание бота', () => {
  const claimed = { id: ACT, kind: 'create_bot', product_id: null, channel: 'web', payload: { name: 'Бот магазина', prompt: 'Отчёт в 8:00' }, result: null };

  it('Telegram не принял токен — карточка снова ждёт, с ошибкой; заведения нет', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValue(claimed);
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: false, reason: 'rejected' }));
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'chat' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_token' });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, expect.objectContaining({ field: 'BOT_TOKEN' }));
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('бот уже у другого живого продукта — снова ждёт', async () => {
    const h = harness({ pg: (sql) => (sql.includes('WHERE tg_bot_id = $1') ? { rows: [{ '?column?': 1 }] } : null) });
    h.actions.claim.mockResolvedValue(claimed);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'chat' });
    expect(r).toMatchObject({ ok: false, reason: 'bot_in_use' });
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('успех: бот с ключами, id бота, первая правка, итог done', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValue(claimed);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: ` ${TOKEN} `, OZON_KEY: 'k' }, via: 'tma' });
    expect(r).toEqual({ ok: true, productId: 'p-new' });
    expect(h.provisioning.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'bot', name: 'Бот магазина', slug: 'bot-magazina-zzzzzz', secrets: { BOT_TOKEN: TOKEN, OZON_KEY: 'k' },
    }));
    expect(h.calls.some((c) => c.sql.includes('SET tg_bot_id') && c.params[1] === 1234567890)).toBe(true);
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { productId: 'p-new', botUsername: 'shop_bot' }, 'p-new');
  });

  it('карточка уже закрыта — not_pending', async () => {
    const h = harness();
    expect(await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: {}, via: 'chat' })).toMatchObject({ reason: 'not_pending' });
  });
});

describe('удаление', () => {
  it('заводится — не удаляем', async () => {
    const h = harness({ pg: (sql) => (sql.includes('FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL') ? { rows: [{ id: 'p1', name: 'М', slug: 'm', kind: 'site', status: 'provisioning' }] } : null) });
    expect(await h.svc.openDelete({ userId: 'u1', productId: 'p1', channel: 'web', turn: null })).toMatchObject({ ok: false, reason: 'provisioning' });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('по нажатию: архив на 30 дней, чужие задания сняты, сон поставлен, итог с датой', async () => {
    const until = new Date('2026-11-24T10:00:00Z');
    const h = harness({ pg: (sql) => (sql.includes("SET archived_at = now()") ? { rows: [{ purge_after: until }] } : null) });
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'delete', product_id: 'p1', channel: 'web', payload: {} });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toEqual({ ok: true, restoreUntil: until.toISOString() });
    const archive = h.calls.find((c) => c.sql.includes('SET archived_at = now()'))!;
    expect(archive.params).toEqual(['p1', 'u1', DELETE_GRACE_DAYS]);
    expect(h.calls.some((c) => c.sql.includes("error = 'снято удалением'"))).toBe(true);
    expect(h.calls.some((c) => c.sql.includes("'sleep', 'queued'") && c.params[0] === 'p1')).toBe(true);
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { restoreUntil: until.toISOString() });
  });
});

describe('возврат', () => {
  const deleted = (over: any = {}) => ({ id: 'p1', name: 'М', purge_after: new Date(Date.now() + 86_400_000), block_reason: null, busy: false, ...over });

  it('срок вышел — отказ', async () => {
    const h = harness({ pg: (sql) => (sql.includes('AS busy') ? { rows: [deleted({ purge_after: new Date(Date.now() - 1000) })] } : null) });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('предел занят — отказ текстом предела', async () => {
    const h = harness({ pg: (sql) => (sql.includes('AS busy') ? { rows: [deleted()] } : null) });
    h.limits.assertCanCreate.mockRejectedValue(new UnprocessableEntityException('Предел — 2 продукта'));
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('оплаченный период идёт — снимаем архив и будим', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted()] };
        if (sql.includes('SET archived_at = NULL')) return { rows: [{ status: 'sleeping', paid: true }] };
        if (sql.includes("'wake', 'queued'")) return { rows: [{ product_id: 'p1' }] };
        return null;
      },
    });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toEqual({ ok: true, status: 'sleeping', waking: true });
  });

  it('погашенный администратором возвращается погашенным и не будится', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted({ block_reason: 'жалоба' })] };
        if (sql.includes('SET archived_at = NULL')) return { rows: [{ status: 'blocked', paid: true }] };
        return null;
      },
    });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toEqual({ ok: true, status: 'blocked', waking: false });
    expect(h.calls.some((c) => c.sql.includes("'wake', 'queued'"))).toBe(false);
  });
});

describe('откат и первая правка', () => {
  it('без turnId — последняя применённая; канал доезжает', async () => {
    const h = harness({ pg: (sql) => (sql.includes("status = 'done' AND sha_before IS NOT NULL") ? { rows: [{ id: 't-last' }] } : null) });
    expect(await h.svc.revert({ userId: 'u1', productId: 'p1', channel: 'telegram' })).toEqual({ ok: true, turnId: 't-rev' });
    expect(h.turns.revert).toHaveBeenCalledWith({ productId: 'p1', turnId: 't-last', userId: 'u1', channel: 'telegram' });
  });

  it('первая правка ставится поднявшимся продуктам, сбой одной не роняет остальные', async () => {
    const h = harness({ pg: (sql) => (sql.includes('WITH picked AS') ? { rows: [
      { id: 'p1', user_id: 'u1', first_prompt: 'А', first_prompt_channel: 'telegram' },
      { id: 'p2', user_id: 'u2', first_prompt: 'Б', first_prompt_channel: null },
    ] } : null) });
    h.turns.enqueue.mockRejectedValueOnce(new Error('Недостаточно токенов'));
    expect(await h.svc.firstPromptTick()).toBe(2);
    expect(h.turns.enqueue.mock.calls.map((c: any) => [c[0].productId, c[0].channel, c[0].prompt])).toEqual([['p1', 'telegram', 'А'], ['p2', 'web', 'Б']]);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Канал у отката**

В `src/products/turns.service.ts` сигнатура `async revert(input: { productId: string; turnId: string; userId: string; channel?: 'web' | 'telegram' })`, а строка `channel: 'web',` в вызове `enqueue` внутри `revert` → `channel: input.channel ?? 'web',`.

- [ ] **Step 4: Сервис жизненного цикла**

`src/products/product-lifecycle.service.ts`:

```ts
import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ProvisioningService } from './provisioning.service';
import { LimitsService } from './limits.service';
import { TurnsService, TURN_SILENCE_SQL } from './turns.service';
import { SLEEP_REASON_NO_TOKENS } from './rent.service';
import { ActionChannel, ConfirmedVia, ProductActionsService } from './product-actions.service';
import { BotTokenCheck, checkBotToken } from './bot-token-check';
import { randomSuffix, siteSlugCandidates, slugWithSuffix } from './product-slug';

export const DELETE_GRACE_DAYS = 30;
const NAME_MAX = 80;

export type LifecycleFail = { ok: false; reason: string; message: string };

function cleanName(raw: unknown): string | null {
  const n = String(raw ?? '').trim();
  return n && n.length <= NAME_MAX ? n : null;
}

/** Отказ заведения и прочих сервисов — человеческим текстом и кодом причины. */
function failOf(e: any, fallback: string): LifecycleFail {
  const status = e instanceof HttpException ? e.getStatus() : 0;
  const body: any = e instanceof HttpException ? e.getResponse() : null;
  const raw = typeof body === 'object' && body ? body.message : body;
  const message = String((Array.isArray(raw) ? raw.join('; ') : raw) ?? e?.message ?? fallback);
  const reason = status === 422 ? 'limit' : status === 409 ? 'conflict' : status === 400 ? 'bad_input' : 'failed';
  return { ok: false, reason, message };
}

/**
 * Жизненный цикл продукта по просьбе ассистента: создать, удалить с
 * возвратом, вернуть, откатить правку. Деньги и необратимое — только через
 * ожидающее действие, которое подтверждает человек (product-actions.service).
 *
 * Удаление и возврат ездят на существующих заданиях агента `sleep`/`wake`:
 * агент машины в этой очереди не меняется.
 */
@Injectable()
export class ProductLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductLifecycleService.name);
  /** Поля, а не прямые вызовы: тесты подменяют Telegram и случайный хвост. */
  private checkBot: (token: string) => Promise<BotTokenCheck> = (t) => checkBotToken(t);
  private suffix: () => string = randomSuffix;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly pg: PgService,
    private readonly provisioning: ProvisioningService,
    private readonly limits: LimitsService,
    private readonly turns: TurnsService,
    private readonly actions: ProductActionsService,
  ) {}

  onModuleInit() {
    this.timers.push(setInterval(() => void this.safe('первая правка', () => this.firstPromptTick()), 30_000));
    this.timers.push(setInterval(() => void this.safe('сон удалённых', () => this.sleepDeletedTick()), 60_000));
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  private async safe(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      this.logger.error(`${name}: ${e?.message}`);
    }
  }

  /** Признак администратора — та же колонка, что читает JwtGuard. */
  async isAdmin(userId: string): Promise<boolean> {
    const r = await this.pg.query(`SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1`, [userId]);
    return r.rows[0]?.isadmin === true;
  }

  private async setFirstPrompt(productId: string, prompt: unknown, channel: ActionChannel): Promise<void> {
    const p = String(prompt ?? '').trim();
    if (!p) return;
    await this.pg.query(
      `UPDATE products SET first_prompt = $2, first_prompt_channel = $3 WHERE id = $1`,
      [productId, p, channel === 'telegram' ? 'telegram' : 'web'],
    );
  }

  async createSite(i: { userId: string; name: unknown; prompt?: unknown; channel: ActionChannel }):
    Promise<{ ok: true; productId: string; slug: string; domain: string | null } | LifecycleFail> {
    const name = cleanName(i.name);
    if (!name) return { ok: false, reason: 'bad_name', message: `Имя продукта — от 1 до ${NAME_MAX} знаков` };
    const isAdmin = await this.isAdmin(i.userId);
    let lastError: any = null;
    for (const slug of siteSlugCandidates(name, this.suffix)) {
      try {
        const { productId } = await this.provisioning.create({ userId: i.userId, name, slug, kind: 'site', secrets: {}, isAdmin });
        await this.setFirstPrompt(productId, i.prompt, i.channel);
        const d = await this.pg.query(`SELECT domain FROM products WHERE id = $1`, [productId]);
        await this.actions.record({ userId: i.userId, productId, kind: 'create_site', channel: i.channel, status: 'done', payload: { name, slug } });
        return { ok: true, productId, slug, domain: d.rows[0]?.domain ?? null };
      } catch (e: any) {
        lastError = e;
        if (e instanceof HttpException && e.getStatus() === 409) continue; // слаг занят — следующий кандидат
        break;
      }
    }
    const f = failOf(lastError, 'Сайт не создан');
    await this.actions.record({ userId: i.userId, productId: null, kind: 'create_site', channel: i.channel, status: 'failed', payload: { name }, result: { reason: f.reason, error: f.message } });
    return f;
  }

  async openCreateBot(i: { userId: string; name: unknown; prompt?: unknown; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string } | LifecycleFail> {
    const name = cleanName(i.name);
    if (!name) return { ok: false, reason: 'bad_name', message: `Имя бота — от 1 до ${NAME_MAX} знаков` };
    const prompt = String(i.prompt ?? '').trim();
    const { id, expiresAt } = await this.actions.open({
      userId: i.userId, productId: null, kind: 'create_bot', channel: i.channel, turn: i.turn,
      payload: { name, ...(prompt ? { prompt } : {}) },
    });
    return { ok: true, actionId: id, expiresAt };
  }

  /**
   * Отправка карточки бота. То, что человек может поправить в той же карточке
   * (токен, занятый бот, имя ключа), возвращает её в ожидание с ошибкой.
   */
  async completeCreateBot(i: { userId: string; actionId: string; set: unknown; via: ConfirmedVia }):
    Promise<{ ok: true; productId: string } | LifecycleFail> {
    const row = await this.actions.claim(i.userId, i.actionId, i.via);
    if (!row || row.kind !== 'create_bot') {
      if (row) await this.actions.release(row.id, row.result ?? {});
      return { ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' };
    }
    const secrets: Record<string, string> = {};
    if (i.set && typeof i.set === 'object') {
      for (const [k, v] of Object.entries(i.set as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim() !== '') secrets[k] = k === 'BOT_TOKEN' ? v.trim() : v;
      }
    }
    const check = await this.checkBot(secrets.BOT_TOKEN ?? '');
    if (!check.ok) {
      const message = check.reason === 'unreachable'
        ? 'Не удалось проверить токен в Telegram — попробуйте ещё раз через минуту'
        : 'Telegram не принял токен бота — скопируйте его целиком из @BotFather';
      await this.actions.release(row.id, { error: message, field: 'BOT_TOKEN' });
      return { ok: false, reason: 'bad_token', message };
    }
    const busy = await this.pg.query(`SELECT 1 FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL LIMIT 1`, [check.id]);
    if (busy.rows.length) {
      const message = 'Этот бот уже работает в другом продукте — создайте в @BotFather нового бота';
      await this.actions.release(row.id, { error: message, field: 'BOT_TOKEN' });
      return { ok: false, reason: 'bot_in_use', message };
    }
    const name = String(row.payload?.name ?? '').trim();
    try {
      const { productId } = await this.provisioning.create({
        userId: i.userId, name, slug: slugWithSuffix(name, this.suffix(), 'bot'), kind: 'bot', secrets, isAdmin: await this.isAdmin(i.userId),
      });
      await this.pg.query(`UPDATE products SET tg_bot_id = $2 WHERE id = $1`, [productId, check.id]);
      await this.setFirstPrompt(productId, row.payload?.prompt, row.channel);
      await this.actions.finish(row.id, 'done', { productId, botUsername: check.username }, productId);
      return { ok: true, productId };
    } catch (e: any) {
      const f = failOf(e, 'Бот не создан');
      if (f.reason === 'bad_input' || f.reason === 'conflict') await this.actions.release(row.id, { error: f.message });
      else await this.actions.finish(row.id, 'failed', { error: f.message, reason: f.reason });
      return f;
    }
  }

  async openDelete(i: { userId: string; productId: string; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string } | LifecycleFail> {
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, status FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = r.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Такого продукта нет' };
    if (p.status === 'provisioning') {
      return { ok: false, reason: 'provisioning', message: 'Продукт ещё заводится — удалить его можно через минуту' };
    }
    const { id, expiresAt } = await this.actions.open({
      userId: i.userId, productId: p.id, kind: 'delete', channel: i.channel, turn: i.turn,
      payload: { name: p.name, slug: p.slug, productKind: p.kind },
    });
    return { ok: true, actionId: id, expiresAt };
  }

  async completeDelete(i: { userId: string; actionId: string; via: ConfirmedVia }):
    Promise<{ ok: true; restoreUntil: string } | LifecycleFail> {
    const row = await this.actions.claim(i.userId, i.actionId, i.via);
    if (!row || row.kind !== 'delete' || !row.product_id) {
      if (row) await this.actions.release(row.id, row.result ?? {});
      return { ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' };
    }
    const r = await this.pg.query(
      `UPDATE products
          SET archived_at = now(), purge_after = now() + make_interval(days => $3),
              status = 'archived', first_prompt = NULL, first_prompt_channel = NULL
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND status <> 'provisioning'
        RETURNING purge_after`,
      [row.product_id, i.userId, DELETE_GRACE_DAYS],
    );
    if (!r.rows[0]) {
      await this.actions.finish(row.id, 'failed', { error: 'Продукт уже удалён или ещё заводится' });
      return { ok: false, reason: 'gone', message: 'Продукт уже удалён или ещё заводится' };
    }
    // Пробуждение и прочее в очереди архивному не выдаются и заняли бы место
    // единственного активного задания — снимаем.
    await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = 'снято удалением', finished_at = now()
        WHERE product_id = $1 AND status = 'queued' AND kind <> 'sleep'`,
      [row.product_id],
    );
    await this.queueSleepForDeleted(row.product_id);
    const restoreUntil = new Date(r.rows[0].purge_after).toISOString();
    await this.actions.finish(row.id, 'done', { restoreUntil });
    return { ok: true, restoreUntil };
  }

  /**
   * Сон удалённым, у кого ещё нет сна после удаления. Ждёт тишины правки, как
   * сон за неуплату: погашенный посреди правки контейнер убивает её молча.
   */
  async queueSleepForDeleted(productId?: string): Promise<number> {
    const r = await this.pg.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status)
       SELECT p.id, 'sleep', 'queued' FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.status = 'archived'
          AND ($1::uuid IS NULL OR p.id = $1::uuid)
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.kind = 'sleep'
                             AND j.created_at >= p.archived_at AND j.status IN ('queued','running','done'))
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND NOT EXISTS (SELECT 1 FROM product_turns t
                           WHERE t.product_id = p.id AND t.status IN ('queued','running')
                             AND COALESCE(t.last_progress_at, t.started_at, t.created_at) > now() - ${TURN_SILENCE_SQL})
       ON CONFLICT DO NOTHING
       RETURNING product_id`,
      [productId ?? null],
    );
    return r.rows.length;
  }

  sleepDeletedTick(): Promise<number> {
    return this.queueSleepForDeleted();
  }

  async restore(i: { userId: string; productId: string; channel: ActionChannel }):
    Promise<{ ok: true; status: 'sleeping' | 'blocked'; waking: boolean } | LifecycleFail> {
    const cur = await this.pg.query(
      `SELECT p.id, p.name, p.purge_after, p.block_reason,
              EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.product_id = p.id AND j.status = 'running') AS busy
         FROM products p
        WHERE p.id = $1 AND p.user_id = $2 AND p.archived_at IS NOT NULL AND p.purged_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = cur.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Удалённого продукта с таким именем нет' };
    if (new Date(p.purge_after) <= new Date()) return { ok: false, reason: 'expired', message: 'Срок возврата вышел' };
    if (p.busy) return { ok: false, reason: 'busy', message: 'Машина продукта сейчас занята — попробуйте через минуту' };
    try {
      await this.limits.assertCanCreate(i.userId, await this.isAdmin(i.userId));
    } catch (e: any) {
      const f = failOf(e, 'Нет места в пределе');
      await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'failed', payload: { name: p.name }, result: { reason: f.reason, error: f.message } });
      return f;
    }
    // Сон удаления, ещё не выданный агенту, усыпил бы вернувшийся продукт.
    await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = 'снято возвратом', finished_at = now()
        WHERE product_id = $1 AND status = 'queued'`,
      [p.id],
    );
    const r = await this.pg.query(
      `UPDATE products
          SET archived_at = NULL, purge_after = NULL,
              status = CASE WHEN block_reason IS NOT NULL THEN 'blocked' ELSE 'sleeping' END,
              sleep_reason = CASE WHEN block_reason IS NULL AND paid_until <= now() THEN $3 ELSE sleep_reason END
        WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
        RETURNING status, paid_until > now() AS paid`,
      [p.id, i.userId, SLEEP_REASON_NO_TOKENS],
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'not_found', message: 'Удалённого продукта с таким именем нет' };
    let waking = false;
    if (row.status === 'sleeping' && row.paid) {
      // Оплаченный период ещё идёт — будим сами: подметальщик аренды будит
      // только тех, на кого хватает баланса на новый месяц.
      const w = await this.pg.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'wake', 'queued')
         ON CONFLICT DO NOTHING RETURNING product_id`,
        [p.id],
      );
      waking = w.rows.length > 0;
    }
    await this.actions.record({ userId: i.userId, productId: p.id, kind: 'restore', channel: i.channel, status: 'done', payload: { name: p.name }, result: { status: row.status, waking } });
    return { ok: true, status: row.status, waking };
  }

  /** Откат правки. Отказы очереди правок (сон, блок, баланс) — броском, как у enqueue. */
  async revert(i: { userId: string; productId: string; turnId?: string | null; channel: ActionChannel }):
    Promise<{ ok: true; turnId: string } | LifecycleFail> {
    let target = String(i.turnId ?? '').trim();
    if (!target) {
      const r = await this.pg.query(
        `SELECT id FROM product_turns
          WHERE product_id = $1 AND user_id = $2 AND status = 'done' AND sha_before IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [i.productId, i.userId],
      );
      target = r.rows[0]?.id ?? '';
      if (!target) return { ok: false, reason: 'no_turns', message: 'У продукта нет применённых правок, которые можно откатить' };
    }
    const turn = await this.turns.revert({ productId: i.productId, turnId: target, userId: i.userId, channel: i.channel === 'telegram' ? 'telegram' : 'web' });
    await this.actions.record({ userId: i.userId, productId: i.productId, kind: 'revert', channel: i.channel, status: 'done', payload: { turnId: target }, result: { newTurnId: turn.id } });
    return { ok: true, turnId: turn.id };
  }

  /** Первая правка продуктам, которые поднялись. Сбой одной не роняет остальные. */
  async firstPromptTick(): Promise<number> {
    const r = await this.pg.query(
      `WITH picked AS (
          SELECT id, user_id, first_prompt, first_prompt_channel FROM products
           WHERE first_prompt IS NOT NULL AND status = 'running' AND archived_at IS NULL
           ORDER BY created_at LIMIT 20
             FOR UPDATE SKIP LOCKED
       ), cleared AS (
          UPDATE products p SET first_prompt = NULL, first_prompt_channel = NULL
            FROM picked WHERE p.id = picked.id
       )
       SELECT * FROM picked`,
    );
    for (const row of r.rows) {
      try {
        await this.turns.enqueue({
          productId: row.id, userId: row.user_id, prompt: row.first_prompt,
          channel: row.first_prompt_channel === 'telegram' ? 'telegram' : 'web',
        });
      } catch (e: any) {
        this.logger.warn(`первая правка продукта ${row.id} не поставлена: ${e?.message}`);
      }
    }
    return r.rows.length;
  }
}
```

Слаг бота в тесте: `slugWithSuffix('Бот магазина', 'zzzzzz', 'bot')` = `bot-magazina-zzzzzz` («Бот» → `bot`).

- [ ] **Step 5: Коммит, прогон — PASS**

Run (нода): `src/products/product-lifecycle.service.spec.ts src/products/turns.revert.spec.ts`.

```bash
git -C $B add src/products && git -C $B commit -q -m "products: жизненный цикл — создать, удалить с возвратом, вернуть, откатить; первая правка по описанию"
```

---

### Task 7: Агент получает «сон» удалённого продукта

**Files:**
- Modify: `src/products/provisioning.service.ts` (`claimJob` ~776, ~810, ~864; `completeJob` ~1036, ~1041)
- Test: `src/products/provisioning.archived.spec.ts` (живая база)

- [ ] **Step 1: Тест против живой базы**

`src/products/provisioning.archived.spec.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { SecretsService } from './secrets.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

maybe('сон удалённого продукта против живого Postgres', () => {
  let pool: Pool;
  let svc: ProvisioningService;

  async function seed(o: { status: string; archived?: boolean; purged?: boolean; job: string }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, archived_at, purge_after, purged_at)
       VALUES ($1, 'u1', 'М', $2, 'site', $3, '/product', 'h', 'clients',
               CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN now() + interval '30 days' END, CASE WHEN $5 THEN now() END)`,
      [id, `s-${id.slice(0, 8)}`, o.status, !!o.archived, !!o.purged],
    );
    const j = await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, $2, 'queued') RETURNING id`, [id, o.job]);
    return { id, jobId: j.rows[0].id as string };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);
    svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('сон удалённого выдаётся агенту, домен — на заглушку', async () => {
    const p = await seed({ status: 'archived', archived: true, job: 'sleep' });
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ productId: p.id, jobKind: 'sleep', vhostMode: 'asleep' });
  });

  it('пробуждение удалённого не выдаётся', async () => {
    await seed({ status: 'archived', archived: true, job: 'wake' });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('стёртому не выдаётся даже сон', async () => {
    await seed({ status: 'archived', archived: true, purged: true, job: 'sleep' });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('сбой сна удалённого оставляет его удалённым, а не degraded', async () => {
    const p = await seed({ status: 'archived', archived: true, job: 'sleep' });
    const job = await svc.claimJob('clients');
    await svc.completeJob(job!.jobId, { ok: false, error: 'docker недоступен' });
    const r = await pool.query(`SELECT status FROM products WHERE id = $1`, [p.id]);
    expect(r.rows[0].status).toBe('archived');
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (выдача `null` в первом тесте, `degraded` в последнем)

- [ ] **Step 3: Правка SQL** — точными заменами, со сверкой числа вхождений

```bash
cd ~/Downloads/spirits_back/.worktrees/product-lifecycle && node - <<'EOF'
const fs = require('fs');
const f = 'src/products/provisioning.service.ts';
let s = fs.readFileSync(f, 'utf8');
const pairs = [
  ["WHERE p.id = j.product_id\n                            AND p.archived_at IS NULL",
   "WHERE p.id = j.product_id\n                            AND (p.archived_at IS NULL OR (j.kind = 'sleep' AND p.purged_at IS NULL))"],
  ["WHEN 'sleep' THEN p.status IN ('sleeping','blocked')",
   "WHEN 'sleep' THEN p.status IN ('sleeping','blocked','archived')"],
  [", CASE WHEN p.status = 'blocked' THEN 'asleep'",
   ", CASE WHEN p.status IN ('blocked','archived') THEN 'asleep'"],
  ["CASE WHEN products.status = 'blocked' THEN 'blocked' ELSE 'degraded' END",
   "CASE WHEN products.status IN ('blocked','archived') THEN products.status ELSE 'degraded' END"],
  ["CASE WHEN products.status = 'blocked'\n                                      THEN products.sleep_reason ELSE NULL END",
   "CASE WHEN products.status IN ('blocked','archived')\n                                      THEN products.sleep_reason ELSE NULL END"],
];
for (const [a, b] of pairs) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error(`вхождений ${n}: ${a.slice(0, 70)}`); process.exit(1); }
  s = s.replace(a, b);
}
fs.writeFileSync(f, s);
console.log('ok');
EOF
```
Expected: `ok`. Если какая-то строка не нашлась — сверить отступы в файле (`sed -n 770,870p`), поправить строку в скрипте и повторить.

- [ ] **Step 4: Коммит, прогон — PASS**

Run (нода): `src/products/provisioning.archived.spec.ts src/products/provisioning.integration.spec.ts`. Второй файл — регрессия: число его тестов и PASS как в базовой линии.

```bash
git -C $B add src/products/provisioning.service.ts src/products/provisioning.archived.spec.ts && git -C $B commit -q -m "products: агент получает сон удалённого продукта; сбой сна не превращает удалённый в degraded"
```

---

### Task 8: Новые действия инструмента `manage_product`

**Files:**
- Create: `src/products/product-lifecycle-tool.ts`
- Modify: `src/products/product-tool.service.ts` (`execute`, конструктор, `list`, `edit` not_found, `NO_PRODUCTS_SAY`, `PRODUCT_TOOLS`)
- Modify: `src/products/product-tool.defs.spec.ts`
- Test: `src/products/product-lifecycle-tool.spec.ts`

- [ ] **Step 1: Тесты**

`src/products/product-lifecycle-tool.spec.ts`:

```ts
import { ProductToolService } from './product-tool.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';

const PRODUCT = { id: 'p1', name: 'Магазин', slug: 'magazin', domain: 'magazin.c.linkeon.io', kind: 'site', status: 'running' };

function harness() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('archived_at IS NOT NULL') && sql.includes('purge_after > now()')) {
        return { rows: [{ id: 'p9', name: 'Старый бот', slug: 'old', kind: 'bot', purge_after: '2026-11-24T10:00:00.000Z' }] };
      }
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      if (sql.includes('FROM product_turns')) return { rows: [{ id: 't-rev', status: 'done', result: 'ok', error: null, tokens_spent: '10' }] };
      return { rows: [] };
    }),
  };
  const lifecycle = {
    createSite: jest.fn(async () => ({ ok: true, productId: 'p-new', slug: 'magazin', domain: 'magazin.c.linkeon.io' })),
    openCreateBot: jest.fn(async () => ({ ok: true, actionId: 'a1', expiresAt: '2026-10-25T10:30:00.000Z' })),
    openDelete: jest.fn(async () => ({ ok: true, actionId: 'a2', expiresAt: '2026-10-25T10:30:00.000Z' })),
    restore: jest.fn(async () => ({ ok: true, status: 'sleeping', waking: true })),
    revert: jest.fn(async () => ({ ok: true, turnId: 't-rev' })),
  };
  const actions = { get: jest.fn(async () => null) };
  const tool = new ProductLifecycleTool(pg as any, lifecycle as any, actions as any);
  const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
  (svc as any).waitMs = 0;
  return { svc, lifecycle, actions };
}

describe('новые действия инструмента', () => {
  it('create site — сразу, без карточки', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин', prompt: 'лендинг' }, 'web', 'turn-1');
    expect(r).toMatchObject({ ok: true, created: { kind: 'site', productId: 'p-new' } });
    expect(h.lifecycle.createSite).toHaveBeenCalledWith({ userId: 'u1', name: 'Магазин', prompt: 'лендинг', channel: 'web' });
  });

  it('create bot — карточка с меткой хода, ключи не просить', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'create', kind: 'bot', name: 'Бот' }, 'web', 'turn-1');
    expect(r).toMatchObject({ ok: true, pending: { actionId: 'a1', kind: 'create_bot' } });
    expect(h.lifecycle.openCreateBot).toHaveBeenCalledWith(expect.objectContaining({ turn: 'turn-1', channel: 'web' }));
    expect(r.say).toMatch(/не проси/);
  });

  it('create без вида — подсказка', async () => {
    expect(await harness().svc.execute('u1', { action: 'create', name: 'X' })).toMatchObject({ ok: false, reason: 'bad_kind' });
  });

  it('delete — карточка, «удалил» до done не говорить', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'delete', product: 'магазин' }, 'telegram', 't');
    expect(r).toMatchObject({ ok: true, pending: { kind: 'delete' }, product: PRODUCT });
    expect(h.lifecycle.openDelete).toHaveBeenCalledWith({ userId: 'u1', productId: 'p1', channel: 'telegram', turn: 't' });
    expect(r.say).toMatch(/ниже придёт сообщение/i);
    expect(r.say).toMatch(/Не говори «удалил»/);
  });

  it('restore — по удалённым', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r).toMatchObject({ ok: true, restored: { status: 'sleeping', waking: true } });
    expect(h.lifecycle.restore).toHaveBeenCalledWith({ userId: 'u1', productId: 'p9', channel: 'web' });
  });

  it('revert — исход отката, как у правки', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'revert', product: 'магазин' }, 'web');
    expect(r).toMatchObject({ outcome: 'done', turnId: 't-rev', product: PRODUCT });
  });

  it('status по actionId — вид действия', async () => {
    const h = harness();
    h.actions.get.mockResolvedValue({ id: 'a2', user_id: 'u1', product_id: 'p1', kind: 'delete', status: 'done', channel: 'web', confirmed_via: 'chat', payload: {}, result: { restoreUntil: '2026-11-24T10:00:00.000Z' }, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: new Date(), tg_chat_id: null, tg_message_id: null, product_name: 'Магазин', purge_after: null } as any);
    const r = await h.svc.execute('u1', { action: 'status', actionId: 'a2' });
    expect(r).toMatchObject({ ok: true, action: { status: 'done', restoreUntil: '2026-11-24T10:00:00.000Z' } });
  });

  it('list — с удалёнными, которые можно вернуть', async () => {
    const r = await harness().svc.execute('u1', { action: 'list' });
    expect(r.deleted).toEqual([{ id: 'p9', name: 'Старый бот', slug: 'old', kind: 'bot', purge_after: '2026-11-24T10:00:00.000Z' }]);
  });
});
```

В `src/products/product-tool.defs.spec.ts` заменить пять тестов:

```ts
  it('инструмент ровно один, с восемью действиями', () => {
    expect(PRODUCT_TOOLS).toHaveLength(1);
    expect((tool().input_schema as any).properties.action.enum.slice().sort())
      .toEqual(['create', 'delete', 'domain', 'edit', 'list', 'restore', 'revert', 'status']);
    const p = (tool().input_schema as any).properties;
    expect(p.kind.enum).toEqual(['site', 'bot']);
    expect(p.name.type).toBe('string');
    expect(p.actionId.type).toBe('string');
  });

  it('создание — действием create, с ценой и пределом до вызова', () => {
    expect(tool().description).toMatch(/action="create"/);
    expect(tool().description).toMatch(/первый месяц бесплатно/);
    expect(tool().description).toMatch(/50[\s ]?000 токенов в месяц/);
    expect(tool().description).toMatch(/не больше двух продуктов/);
    expect(NO_PRODUCTS_SAY).toMatch(/action="create"/);
  });

  it('ключи в текст правки не уезжают и в разговоре не просятся', () => {
    const d = tool().description;
    expect(d).toMatch(/КЛЮЧИ, ТОКЕНЫ И ПАРОЛИ в prompt не вписывай/);
    expect(d).toMatch(/Ключи в разговоре не проси/);
    expect(d).toMatch(/защищённую карточку/);
    expect(d).toMatch(/Сменить ключи после создания пока нельзя/);
  });

  it('удаление — только по кнопке пользователя, с возвратом', () => {
    expect(tool().description).toMatch(/только когда пользователь нажмёт/);
    expect(tool().description).toMatch(/вернуть 30 дней/);
    expect(tool().description).toMatch(/Не говори «удалил»/);
  });

  it('каждое действие названо в описании', () => {
    for (const a of ['list', 'edit', 'status', 'domain', 'create', 'delete', 'restore', 'revert']) {
      expect(tool().description).toContain(`action="${a}"`);
    }
  });
```

Тесты «новый продукт — кнопкой в Студии» и «описание говорит, что завести продукт нельзя» — удалить (их место заняли два теста выше).

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Класс новых действий**

`src/products/product-lifecycle-tool.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { DELETE_GRACE_DAYS, ProductLifecycleService } from './product-lifecycle.service';
import { ActionStatus, ProductActionsService, toView } from './product-actions.service';
import type { ProductMatch } from './product-tool.service';
import type { ProductToolChannel } from './product-tool.token';

export interface DeletedProduct {
  id: string;
  name: string;
  slug: string;
  kind: string;
  purge_after: string;
}

const ACTION_SAY: Record<ActionStatus, string> = {
  pending: 'Пользователь ещё не подтвердил карточку.',
  working: 'Действие выполняется — посмотри через минуту.',
  done: 'Готово: действие выполнено.',
  failed: 'Не получилось — причина в action.result.error. Скажи о ней пользователю своими словами.',
  expired: 'Срок карточки вышел. Если пользователь всё ещё хочет, вызови действие заново.',
  cancelled: 'Пользователь отменил действие.',
};

/**
 * Новые действия manage_product: create, delete, restore, revert и статус
 * карточки. Отдельным классом: product-tool.service.ts и так за 650 строк.
 * Решения — в ProductLifecycleService, здесь только выбор и пересказ.
 */
@Injectable()
export class ProductLifecycleTool {
  constructor(
    private readonly pg: PgService,
    private readonly lifecycle: ProductLifecycleService,
    private readonly actions: ProductActionsService,
  ) {}

  async listDeleted(userId: string): Promise<DeletedProduct[]> {
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, purge_after FROM products
        WHERE user_id = $1 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
        ORDER BY archived_at DESC`,
      [userId],
    );
    return r.rows.map((x: any) => ({ ...x, purge_after: new Date(x.purge_after).toISOString() }));
  }

  private async resolveDeleted(userId: string, query: string): Promise<DeletedProduct[]> {
    const raw = String(query ?? '').trim().toLowerCase();
    if (!raw) return [];
    const like = `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, purge_after FROM products
        WHERE user_id = $1 AND archived_at IS NOT NULL AND purged_at IS NULL AND purge_after > now()
          AND (id::text = $2 OR lower(slug) = $2 OR lower(name) LIKE $3)
        ORDER BY archived_at DESC`,
      [userId, raw, like],
    );
    return r.rows.map((x: any) => ({ ...x, purge_after: new Date(x.purge_after).toISOString() }));
  }

  async create(userId: string, input: any, channel: ProductToolChannel, turn: string | null) {
    const kind = String(input?.kind ?? '').trim();
    if (kind === 'site') {
      const r = await this.lifecycle.createSite({ userId, name: input?.name, prompt: input?.prompt, channel });
      if (!r.ok) return { ok: false, reason: r.reason, say: r.message };
      return {
        ok: true,
        created: { kind: 'site', productId: r.productId, slug: r.slug, domain: r.domain },
        say: `Сайт создан и заводится: через минуту-две откроется по адресу https://${r.domain}.` +
          (String(input?.prompt ?? '').trim()
            ? ' Первая правка по описанию поставлена и начнётся, когда сайт поднимется; её исход — действием status по имени продукта.'
            : ' Дальше — правки действием edit.'),
      };
    }
    if (kind === 'bot') {
      const r = await this.lifecycle.openCreateBot({ userId, name: input?.name, prompt: input?.prompt, channel, turn });
      if (!r.ok) return { ok: false, reason: r.reason, say: r.message };
      return {
        ok: true,
        pending: { actionId: r.actionId, kind: 'create_bot', expiresAt: r.expiresAt },
        say: (channel === 'telegram'
          ? 'Ниже придёт сообщение с кнопкой: пользователь откроет защищённую форму'
          : 'Под твоим ответом появится защищённая карточка: пользователь')
          + ' введёт в неё токен бота от @BotFather и ключи сервисов. Ключи в переписке не проси. ' +
          'Бот создастся, когда он отправит карточку; итог — действием status с этим actionId.',
      };
    }
    return { ok: false, reason: 'bad_kind', say: 'Укажи kind: "site" (сайт) или "bot" (телеграм-бот) и name.' };
  }

  async delete(userId: string, product: ProductMatch, channel: ProductToolChannel, turn: string | null) {
    const r = await this.lifecycle.openDelete({ userId, productId: product.id, channel, turn });
    if (!r.ok) return { ok: false, reason: r.reason, product, say: r.message };
    return {
      ok: true,
      pending: { actionId: r.actionId, kind: 'delete', expiresAt: r.expiresAt },
      product,
      say: (channel === 'telegram' ? 'Ниже придёт сообщение с кнопкой «Удалить».' : 'Под твоим ответом появится карточка с кнопкой «Удалить».') +
        ` Продукт удалится, только когда пользователь нажмёт её. Вернуть его можно будет ${DELETE_GRACE_DAYS} дней, оплаченный период не возвращается. ` +
        'Не говори «удалил», пока status не вернёт done.',
    };
  }

  async restore(userId: string, input: any, channel: ProductToolChannel) {
    const matches = await this.resolveDeleted(userId, String(input?.product ?? ''));
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', matches, say: 'Под описание подходит несколько удалённых продуктов. Спроси, какой вернуть.' };
    }
    if (!matches.length) {
      const deleted = await this.listDeleted(userId);
      return {
        ok: false, reason: 'not_found', deleted,
        say: deleted.length ? 'Такого удалённого продукта нет. Вот какие можно вернуть.' : 'Удалённых продуктов, которые можно вернуть, нет.',
      };
    }
    const product = matches[0];
    const r = await this.lifecycle.restore({ userId, productId: product.id, channel });
    if (!r.ok) return { ok: false, reason: r.reason, product, say: r.message };
    return {
      ok: true,
      restored: { productId: product.id, status: r.status, waking: r.waking },
      product,
      say: r.status === 'blocked'
        ? 'Продукт возвращён, но он остановлен администратором: правки не принимаются, пополнение не поможет.'
        : r.waking
          ? 'Продукт возвращён и просыпается — через минуту-две снова заработает.'
          : 'Продукт возвращён, но оплаченный период кончился: он проснётся, когда на балансе хватит токенов на месяц аренды. Предложи пополнить баланс.',
    };
  }

  /** Откат: { ok:true, turnId } — дальше исход ждёт ProductToolService; отказы очереди правок — броском. */
  revert(userId: string, product: ProductMatch, turnId: unknown, channel: ProductToolChannel) {
    return this.lifecycle.revert({ userId, productId: product.id, turnId: turnId ? String(turnId) : null, channel });
  }

  async actionStatus(userId: string, actionId: unknown) {
    const row = await this.actions.get(userId, String(actionId ?? '').trim());
    if (!row) return { ok: false, reason: 'not_found', say: 'Такого действия у пользователя нет.' };
    const action = toView(row);
    const fixable = action.status === 'pending' && typeof action.result?.error === 'string';
    return {
      ok: action.status === 'done',
      action,
      say: fixable
        ? `Пользователь отправил карточку, но её не приняли: ${action.result!.error}. Карточка ждёт исправления.`
        : ACTION_SAY[action.status],
    };
  }
}
```

- [ ] **Step 4: Разводка в `ProductToolService`**

В `src/products/product-tool.service.ts`:

1. Импорты: `import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';` и `import { ProductLifecycleTool } from './product-lifecycle-tool';`.
2. Конструктор — последним параметром:
```ts
    // Новые действия (create, delete, restore, revert). @Optional и последним:
    // спеки собирают сервис позиционно с тремя аргументами.
    @Optional() private readonly lifecycleTool?: ProductLifecycleTool,
```
3. `execute` целиком:
```ts
  async execute(userId: string, input: any, channel: ProductToolChannel = 'web', turn: string | null = null): Promise<any> {
    const action = String(input?.action ?? '').trim();
    if (action === 'list') return this.list(userId);
    if (action === 'edit') return this.edit(userId, input, channel);
    if (action === 'status') {
      if (input?.actionId && this.lifecycleTool) return this.lifecycleTool.actionStatus(userId, input.actionId);
      return this.status(userId, input);
    }
    if (action === 'domain') return this.domain(userId, input);
    if (this.lifecycleTool) {
      if (action === 'create') return this.lifecycleTool.create(userId, input, channel, turn);
      if (action === 'restore') return this.lifecycleTool.restore(userId, input, channel);
      if (action === 'delete' || action === 'revert') {
        const matches = await this.resolve(userId, String(input?.product ?? ''));
        if (matches.length > 1) {
          return { ok: false, reason: 'ambiguous', matches,
            say: 'Под это описание подходит несколько продуктов. СПРОСИ у пользователя, какой именно, и повтори вызов. Не выбирай сам.' };
        }
        if (!matches.length) return { ok: false, reason: 'not_found', products: (await this.list(userId)).products, say: 'Такого продукта у пользователя нет.' };
        const product = matches[0];
        if (action === 'delete') return this.lifecycleTool.delete(userId, product, channel, turn);
        try {
          const r = await this.lifecycleTool.revert(userId, product, input?.turnId, channel);
          if (!r.ok) return { ok: false, reason: r.reason, product, say: r.message };
          return { ...(await this.waitForOutcome(r.turnId)), product };
        } catch (e: any) {
          return this.refusal(e, product);
        }
      }
    }
    return {
      ok: false,
      reason: 'bad_action',
      say: 'Неизвестное действие. Доступны: list, create, edit, status, revert, delete, restore, domain.',
    };
  }
```
4. В `list` перед `if (!products.length)` добавить
```ts
    const deleted = this.lifecycleTool ? await this.lifecycleTool.listDeleted(userId) : [];
```
и в оба `return` добавить поле `deleted`; к `say` непустого списка дописать ` Удалённые (deleted) можно вернуть действием restore до purge_after.` (если `deleted.length`).
5. В `edit` текст ветки not_found без продуктов: `'У пользователя нет ни одного продукта. Создать его можно действием create.'`.
6. `NO_PRODUCTS_SAY`:
```ts
export const NO_PRODUCTS_SAY =
  'У пользователя пока нет продуктов. Создать можешь ты — action="create" (kind "site" или "bot"). ' +
  'До вызова назови условия: первый месяц бесплатно, дальше 50 000 токенов в месяц, не больше двух продуктов на аккаунт.';
```
7. `PRODUCT_TOOLS[0].description` — заменить первые два пункта, пункт `status`, абзацы «ЧЕГО ТЫ НЕ МОЖЕШЬ» и «КЛЮЧИ, ТОКЕНЫ И ПАРОЛИ»; абзацы про `domain`, outcome/reason, ambiguous, sleeping/blocked и «ПРО ДЕНЬГИ» оставить дословно. Новые куски:
```ts
      'Посмотреть, СОЗДАТЬ, ПРАВИТЬ, удалить и вернуть продукты пользователя (сайты и телеграм-боты, которые он разместил в Линкеоне). ' +
      'Ты видишь только продукты этого пользователя — чужих тебе не покажут ни по имени, ни по идентификатору.\n' +
      '• action="list" — его продукты: имя, адрес, состояние; удалённые, которые ещё можно вернуть, — в deleted с датой purge_after. У ботов адреса нет вовсе — это норма.\n' +
      '• action="create" — создать: { kind: "site" | "bot", name, prompt? }. ДО вызова назови условия: первый месяц бесплатно, дальше 50 000 токенов в месяц, ' +
      'не больше двух продуктов на аккаунт, — и получи согласие. Сайт создаётся сразу. Для бота сервер сам прикрепит к ответу защищённую карточку: ' +
      'пользователь введёт в неё токен от @BotFather и ключи сервисов, и бот создастся, когда он её отправит. ' +
      'prompt — что продукт должен делать: эта правка поставится сама, как только продукт поднимется.\n' +
      '• action="edit" — поставить правку: product (как пользователь назвал продукт) + prompt (что именно сделать, ' +
      'своими словами и подробно — правку исполняет ассистент внутри продукта, он видит только его файлы).\n' +
      '• action="status" — узнать, чем кончилась правка (product или turnId) или карточка (actionId).\n' +
      '• action="revert" — откатить правку: product и turnId; без turnId — последнюю применённую. Откат — тоже правка: дождись outcome.\n' +
      '• action="delete" — удалить: product. Сервер прикрепит к ответу карточку с кнопкой «Удалить»; продукт удалится, только когда пользователь нажмёт её. ' +
      'После удаления его можно вернуть 30 дней, оплаченный период не возвращается. Не говори «удалил», пока status не вернёт done.\n' +
      '• action="restore" — вернуть удалённый: product. Нужно свободное место в пределе аккаунта.\n' +
```
вместо «ЧЕГО ТЫ НЕ МОЖЕШЬ…» и «КЛЮЧИ…»:
```ts
      'КАРТОЧКИ: ответ с pending значит, что действие ждёт пользователя. О карточке говори «под ответом карточка» ' +
      '(в Telegram — «ниже сообщение с кнопкой»), не пересказывай её и не выдумывай. ЧЕГО ТЫ НЕ МОЖЕШЬ: загрузить в продукт файлы.\n' +
      'КЛЮЧИ, ТОКЕНЫ И ПАРОЛИ в prompt не вписывай никогда: текст правки хранится в истории и попадает в git продукта. ' +
      'Ключи в разговоре не проси — их вводят только в защищённую карточку при создании бота. Прислал пользователь ключ в чат — ' +
      'никуда его не передавай и посоветуй ключи в переписку не присылать. Сменить ключи после создания пока нельзя.\n' +
```
8. Схема: `action: { type: 'string', enum: ['list', 'edit', 'status', 'domain', 'create', 'delete', 'restore', 'revert'] }`; новые свойства:
```ts
        kind: { type: 'string', enum: ['site', 'bot'], description: 'Для create: "site" — сайт, "bot" — телеграм-бот.' },
        name: { type: 'string', description: 'Для create: название продукта, как его назвал пользователь.' },
        actionId: { type: 'string', description: 'Для status: идентификатор карточки из прошлого ответа (pending.actionId).' },
```
У `product` описание: `'Как пользователь назвал продукт: имя («магазин цветов»), слаг или домен. Для edit, delete, restore, revert обязательно.'`; у `prompt`: `'Что сделать с продуктом (edit) или что он должен делать (create). Подробно и своими словами.'`; у `turnId`: `'Идентификатор правки из прошлого вызова edit: для status вместо product, для revert — какую откатить.'`.

- [ ] **Step 5: Коммит, прогон — PASS**

Run (нода): `src/products/product-lifecycle-tool.spec.ts src/products/product-tool.defs.spec.ts src/products/product-tool.channel.spec.ts src/products/product-tool.spec.ts`.

```bash
git -C $B add src/products && git -C $B commit -q -m "products: manage_product — create, delete, restore, revert и статус карточки"
```

---

### Task 9: Метка хода доезжает до инструмента

**Files:**
- Modify: `src/mcp/products-mcp.controller.ts:95-128`
- Test: `src/mcp/products-mcp.turn.spec.ts`

- [ ] **Step 1: Тест**

```ts
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

const TURN = '11111111-2222-4333-8444-555555555555';

it('метка хода — из подписи токена, а не из аргументов модели', async () => {
  const tool = { execute: jest.fn(async () => ({ ok: true })) };
  const ctrl = new ProductsMcpController(tool as any, {} as any, {} as any, {} as any);
  await ctrl.callTool(`Bearer ${signProductToolToken('u1', 'web', TURN)}`, { action: 'list', turn: 'подделка', userId: 'x' });
  expect(tool.execute).toHaveBeenCalledWith('u1', { action: 'list' }, 'web', TURN);
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Правка**

В `callTool`:
```ts
    const { userId, channel, turn } = this.owner(authHeader);
    const { userId: _drop, channel: _dropChannel, turn: _dropTurn, ...input } = args ?? {};
```
и последняя строка `return this.tool.execute(userId, input, channel, turn);`.

- [ ] **Step 4: Коммит, прогон — PASS** (`src/mcp/products-mcp.turn.spec.ts src/mcp/products-mcp.controller.spec.ts`)

```bash
git -C $B add src/mcp && git -C $B commit -q -m "mcp: метка хода из подписи токена доезжает до инструмента продуктов"
```

---

### Task 10: Ручки карточки и регистрация

**Files:**
- Create: `src/products/product-actions.controller.ts`
- Modify: `src/products/products.module.ts`
- Test: `src/products/product-actions.controller.spec.ts`

- [ ] **Step 1: Тест**

```ts
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { BadRequestException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { ProductActionsController } from './product-actions.controller';
import { ProductsModule } from './products.module';
import { ProductActionsService } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';
import { JwtGuard } from '../common/guards/jwt.guard';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const row = (kind: string) => ({ id: ID, user_id: 'u1', product_id: 'p1', kind, status: 'pending', channel: 'web', confirmed_via: null, payload: { name: 'М' }, result: null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'М', purge_after: null });

function make(kind: string | null) {
  const actions = { get: jest.fn(async () => (kind ? row(kind) : null)), listPending: jest.fn(async () => [row('delete')]), cancel: jest.fn(async () => true) };
  const lifecycle = { completeDelete: jest.fn(async () => ({ ok: true })), completeCreateBot: jest.fn(async () => ({ ok: true })) };
  return { ctrl: new ProductActionsController(actions as any, lifecycle as any), actions, lifecycle };
}
const user = { userId: 'u1', isAdmin: false };

describe('ручки карточки', () => {
  it('закрыты JwtGuard и зарегистрированы в ProductsModule вместе с сервисами', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ProductActionsController)).toContain(JwtGuard);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProductsModule)).toContain(ProductActionsController);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProductsModule);
    for (const p of [ProductActionsService, ProductLifecycleService, ProductLifecycleTool]) expect(providers).toContain(p);
    const exported = Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProductsModule);
    for (const p of [ProductActionsService, ProductLifecycleService]) expect(exported).toContain(p);
  });

  it('чужое или несуществующее — 404', async () => {
    await expect(make(null).ctrl.get(user, ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('удаление — только с confirm: true', async () => {
    const h = make('delete');
    await expect(h.ctrl.submit(user, ID, {})).rejects.toBeInstanceOf(BadRequestException);
    await h.ctrl.submit(user, ID, { confirm: true, via: 'chat' });
    expect(h.lifecycle.completeDelete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, via: 'chat' });
  });

  it('бот — ключи из тела, по умолчанию подтверждено в кабинете', async () => {
    const h = make('create_bot');
    await h.ctrl.submit(user, ID, { set: { BOT_TOKEN: 't' } });
    expect(h.lifecycle.completeCreateBot).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { BOT_TOKEN: 't' }, via: 'cabinet' });
  });

  it('смена ключей — в очереди 2', async () => {
    await expect(make('keys').ctrl.submit(user, ID, { set: {} })).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('ответ — вид без значений ключей', async () => {
    const v = await make('delete').ctrl.get(user, ID);
    expect(v).toMatchObject({ id: ID, kind: 'delete', status: 'pending' });
    expect(JSON.stringify(v)).not.toMatch(/BOT_TOKEN/);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Контроллер**

`src/products/product-actions.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, NotImplementedException, Param, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProductActionsService, toView } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';

export class SubmitActionDto {
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsObject() set?: Record<string, string>;
  @IsOptional() @IsIn(['chat', 'cabinet', 'tma']) via?: 'chat' | 'cabinet' | 'tma';
}

/**
 * Карточка ожидающего действия: веб-чат, кабинет и мини-приложение. Свой
 * префикс `product-actions`, а не `products/actions`: не спорить с маршрутами
 * `products/:id/...` соседнего контроллера. Чужое действие — 404, а не 403:
 * не выдавать его существование. Значения ключей в ответ не попадают никогда —
 * ответ строится из toView, в котором их нет по построению.
 */
@Controller('')
@UseGuards(JwtGuard)
export class ProductActionsController {
  constructor(
    private readonly actions: ProductActionsService,
    private readonly lifecycle: ProductLifecycleService,
  ) {}

  @Get('product-actions')
  async pending(@CurrentUser() user: any) {
    return (await this.actions.listPending(user.userId)).map((r) => toView(r));
  }

  @Get('product-actions/:id')
  async get(@CurrentUser() user: any, @Param('id') id: string) {
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    return toView(row);
  }

  @Post('product-actions/:id')
  @HttpCode(200)
  async submit(@CurrentUser() user: any, @Param('id') id: string, @Body() body: SubmitActionDto) {
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    const via = body?.via ?? 'cabinet';
    if (row.kind === 'delete') {
      if (body?.confirm !== true) throw new BadRequestException('Нужно подтверждение');
      await this.lifecycle.completeDelete({ userId: user.userId, actionId: id, via });
    } else if (row.kind === 'create_bot') {
      await this.lifecycle.completeCreateBot({ userId: user.userId, actionId: id, set: body?.set ?? {}, via });
    } else {
      throw new NotImplementedException('Это действие появится позже');
    }
    return toView((await this.actions.get(user.userId, id))!);
  }

  @Post('product-actions/:id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: any, @Param('id') id: string) {
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    await this.actions.cancel(user.userId, id);
    return toView((await this.actions.get(user.userId, id))!);
  }
}
```

- [ ] **Step 4: Модуль**

В `src/products/products.module.ts`: импорты трёх сервисов и контроллера; `controllers: [ProductsController, RunnerController, HostController, ProductActionsController]`; в `providers` добавить `ProductActionsService, ProductLifecycleService, ProductLifecycleTool`; в `exports` — `ProductActionsService, ProductLifecycleService`.

- [ ] **Step 5: Коммит, прогон — PASS**

Run (нода): `src/products/product-actions.controller.spec.ts src/products/products.routes.spec.ts`; плюс `npx tsc -p tsconfig.build.json --noEmit` — без ошибок.

```bash
git -C $B add src/products && git -C $B commit -q -m "products: ручки карточки /webhook/product-actions; регистрация в модуле"
```

---

### Task 11: Карточка к ответу веба и Маши

**Files:**
- Modify: `src/chat/client-ui.ts`
- Create: `src/products/product-action-tail.ts`
- Modify: `src/chat/chat.service.ts` (конструктор ~408–436; `streamUniversalAgent` ~1810, ~1869, перед `const fullText = chunks.join('');` в конце хода; Маша ~1137, ~1252)
- Modify: `src/chat/chat.module.ts`
- Modify: `src/chat/chat.module.chat-files.spec.ts` (сторож регистрации)
- Test: `src/products/product-action-tail.spec.ts`, `src/chat/chat.product-actions-wiring.spec.ts`

- [ ] **Step 1: Тесты**

`src/products/product-action-tail.spec.ts`:

````ts
import { productActionTail } from './product-action-tail';

const A = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

describe('хвост ответа с карточками', () => {
  it('клиент с карточками — блок product-action с одним id', () => {
    expect(productActionTail([A], true, 'ru')).toBe('\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```');
  });

  it('клиент без карточек — ссылка на кабинет на языке собеседника', () => {
    const t = productActionTail([A], false, 'de');
    expect(t).toBe('\n\nBestätige es in deinem Konto: https://my.linkeon.io/studio?tab=products&action=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('нет карточек — пусто', () => {
    expect(productActionTail([], true, 'ru')).toBe('');
  });
});
````

`src/chat/chat.product-actions-wiring.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { parseClientUi } from './client-ui';
import { ChatModule } from './chat.module';
import { ProductsModule } from '../products/products.module';

const SRC = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');

describe('карточки продуктов в ходе чата', () => {
  it('клиент объявляет карточки полем ui.cards, только строгим true', () => {
    expect(parseClientUi({ activity: true, ask: true, cards: true }).cards).toBe(true);
    expect(parseClientUi({ cards: 'yes' }).cards).toBe(false);
    expect(parseClientUi('{"cards":true}').cards).toBe(true);
  });

  it('метка хода уходит в токен и релея, и Маши', () => {
    expect(SRC).toContain('productsRelayFields(userId, productsTurn)');
    expect(SRC).toContain("productsCliMcp(userId, 'web', productsTurn)");
  });

  it('оба пути забирают карточки своего хода', () => {
    expect(SRC.match(/productActions\?\.takeForTurn\(/g)?.length).toBe(2);
  });

  it('ProductsModule подключён к ChatModule — иначе @Optional молча выключит карточки', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule)).toContain(ProductsModule);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Флаг клиента**

В `src/chat/client-ui.ts`: в интерфейс `cards: boolean;` с комментарием «карточки действий продуктов (блок product-action)»; `NO_CLIENT_UI = Object.freeze({ activity: false, ask: false, cards: false })`; в `parseClientUi` возвращать `{ activity: o.activity === true, ask: o.ask === true, cards: o.cards === true }`. Если существующие спеки `client-ui` сравнивают объекты целиком (`toEqual({ activity, ask })`) — дописать `cards: false`.

- [ ] **Step 4: Хвост**

`src/products/product-action-tail.ts`:

````ts
import { LanguageService } from '../common/services/language.service';

const CONFIRM_IN_CABINET: Record<string, string> = {
  ru: 'Подтвердите в кабинете',
  en: 'Confirm in your account',
  es: 'Confírmalo en tu cuenta',
  de: 'Bestätige es in deinem Konto',
  fr: 'Confirmez dans votre espace',
  pt: 'Confirma na tua conta',
  zh: '请在个人中心确认',
};

/**
 * Хвост ответа ассистента с карточками, заведёнными этим ходом. Клиент с
 * карточками (ui.cards) получает блок ```product-action``` — его рисует и
 * поток, и история. Остальным (Flutter, старые сборки) — строка со ссылкой
 * на это же действие в кабинете: блок они показали бы как код.
 */
export function productActionTail(actions: ReadonlyArray<{ id: string }>, cards: boolean, lang: string | null | undefined): string {
  if (!actions.length) return '';
  if (cards) {
    return actions.map((a) => '\n\n```product-action\n' + JSON.stringify({ id: a.id }) + '\n```').join('');
  }
  const text = CONFIRM_IN_CABINET[LanguageService.normalize(lang)] ?? CONFIRM_IN_CABINET.ru;
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  return actions.map((a) => `\n\n${text}: ${base}/studio?tab=products&action=${a.id}`).join('');
}
````

- [ ] **Step 5: Чат-сервис**

В `src/chat/chat.service.ts`:

1. Импорты: `import { randomUUID } from 'crypto';`, `import { ProductActionsService } from '../products/product-actions.service';`, `import { productActionTail } from '../products/product-action-tail';`.
2. Конструктор — последним параметром после `costGrowth`:
```ts
    // Карточки действий продуктов (создание бота, удаление). Последним и
    // @Optional по той же причине, что chatFiles; что модуль подключён,
    // сторожит chat.product-actions-wiring.spec.ts.
    @Optional() private readonly productActions?: ProductActionsService,
```
3. `streamUniversalAgent`: строкой перед `const callUpstreamOnce = async (): Promise<void> => {` добавить
```ts
      // Метка хода — одна на оба вызова upstream (самолечение пустого потока
      // зовёт его второй раз): карточка не должна потеряться между ними.
      const productsTurn = randomUUID();
```
и `const pf = productsRelayFields(userId);` → `const pf = productsRelayFields(userId, productsTurn);`.
4. Там же, непосредственно перед строкой `const fullText = chunks.join('');` (конец хода, после хвоста озвучки `{{audio:…}}`), добавить
```ts
      // Карточки продуктов, заведённые этим ходом: блок для клиента с
      // карточками, ссылка на кабинет — для остальных.
      try {
        const taken = (await this.productActions?.takeForTurn(userId, productsTurn, new Date(streamStartTime))) ?? [];
        const tail = productActionTail(taken, ui.cards, userLanguage);
        if (tail) {
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      } catch (e: any) {
        this.logger.warn(`product action attach failed: ${e.message}`);
      }
```
Язык — параметр `userLanguage` (тот же, что уходит в `relaySessionKey(userId, assistantId, userLanguage, …)` выше).
5. Маша: `const products = productsCliMcp(userId, 'web');` →
```ts
    const productsTurn = randomUUID();
    const products = productsCliMcp(userId, 'web', productsTurn);
```
и перед строкой `const tokensUsed = inputTokens + outputTokens;`, что идёт перед `res.write(JSON.stringify({ type: 'item', content: fullText })`, добавить
```ts
      try {
        const taken = (await this.productActions?.takeForTurn(userId, productsTurn, new Date(turnStartedAt))) ?? [];
        fullText += productActionTail(taken, ui.cards, userLanguage);
      } catch (e: any) {
        this.logger.warn(`product action attach failed: ${e.message}`);
      }
```
В ветке Маши `fullText` объявлен через `let` (строка ~1229), начало хода — `turnStartedAt = Date.now()` (строка ~1120), язык — `userLanguage` (строка ~1025).

- [ ] **Step 6: Модуль и сторож**

В `src/chat/chat.module.ts` импорт `ProductsModule` и добавить его в `imports`. Кольца нет: `ProductsModule` импортирует только `CommonModule` и `MiscModule`.

- [ ] **Step 7: Коммит, прогон — PASS**

Run (нода): `src/products/product-action-tail.spec.ts src/chat/chat.product-actions-wiring.spec.ts src/chat`; `npx tsc -p tsconfig.build.json --noEmit` — без ошибок.

```bash
git -C $B add src/chat src/products && git -C $B commit -q -m "chat: карточки продуктов дописываются к ответу хода — блоком для веба, ссылкой для остальных"
```

---

### Task 12: Telegram

**Files:**
- Modify: `src/tg-bot/tg-i18n.ts` (ключи в 7 каталогов, `formatTgDate`)
- Create: `src/tg-bot/tg-product-actions.service.ts`
- Modify: `src/tg-bot/tg-router.service.ts:515-541`
- Modify: `src/tg-bot/tg-bot.service.ts` (конструктор ~132–155, `handleCallbackQuery` ~363–380, `handleChatMessage` ~983 и после отправки файлов песочницы)
- Modify: `src/tg-bot/tg-bot.module.ts`
- Test: `src/tg-bot/tg-product-actions.service.spec.ts`
- Modify: `src/tg-bot/tg-bot.blog-routing.spec.ts` (тест маршрута `pa:`)

- [ ] **Step 1: Тесты**

`src/tg-bot/tg-product-actions.service.spec.ts`:

```ts
import { TgProductActionsService, shouldRouteToProductActions } from './tg-product-actions.service';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function harness(o: { owner?: number; action?: any } = {}) {
  const actions = {
    takeForTurn: jest.fn(async () => [{ id: ID, kind: 'delete', payload: { name: 'Магазин' } }]),
    setTelegramMessage: jest.fn(async () => undefined),
    getById: jest.fn(async () => o.action ?? { id: ID, user_id: 'u1', kind: 'delete', status: 'pending', payload: { name: 'Магазин' }, product_name: 'Магазин' }),
    cancel: jest.fn(async () => true),
  };
  const lifecycle = { completeDelete: jest.fn(async () => ({ ok: true, restoreUntil: '2026-11-24T10:00:00.000Z' })) };
  const grammy = {
    sendMessage: jest.fn(async () => ({ message_id: 77 })),
    editMessageText: jest.fn(async () => undefined),
    answerCallbackQuery: jest.fn(async () => undefined),
  };
  const identity = { getIdentityByLinkeonId: jest.fn(async () => ({ tgUserId: o.owner ?? 42, tgUsername: null, tgFirstName: null })) };
  const svc = new TgProductActionsService(actions as any, lifecycle as any, grammy as any, identity as any);
  return { svc, actions, lifecycle, grammy, identity };
}

describe('карточки продуктов в Telegram', () => {
  it('префикс pa: — наш', () => {
    expect(shouldRouteToProductActions(`pa:ok:${ID}`)).toBe(true);
    expect(shouldRouteToProductActions('ins:b:1')).toBe(false);
  });

  it('удаление — сообщение с кнопками «Удалить» и «Отмена»', async () => {
    const h = harness();
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    const [chatId, text, opts] = h.grammy.sendMessage.mock.calls[0] as any[];
    expect(chatId).toBe(100);
    expect(text).toMatch(/Удалить «Магазин»\?/);
    expect(opts.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([`pa:ok:${ID}`, `pa:no:${ID}`]);
    expect(h.actions.setTelegramMessage).toHaveBeenCalledWith(ID, 100, 77);
  });

  it('бот в личке — кнопка мини-приложения; в группе — ссылка на кабинет', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'create_bot', payload: { name: 'Бот' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[0] as any[])[2].reply_markup.inline_keyboard[0][0].web_app.url).toMatch(new RegExp(`/tma/#pa=${ID}$`));
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: -100, isPrivate: false, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[1] as any[])[2].reply_markup.inline_keyboard[0][0].url).toMatch(new RegExp(`/studio\\?tab=products&action=${ID}$`));
  });

  it('нажать «Удалить» может только привязанный Telegram владельца', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 999 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
  });

  it('«Удалить» владельцем — удаление и правка сообщения без кнопок', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42, language_code: 'ru' }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.lifecycle.completeDelete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, via: 'telegram' });
    const [, , text, opts] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/удалён/);
    expect(opts.reply_markup.inline_keyboard).toEqual([]);
  });

  it('«Отмена» — отмена действия', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:no:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.actions.cancel).toHaveBeenCalledWith('u1', ID);
  });
});
```

В `src/tg-bot/tg-bot.blog-routing.spec.ts` добавить после теста про `ins:` (сервис собирается 16 аргументами):

```ts
  it('кнопка карточки продукта уходит в её обработчик и у непривязанного пользователя', async () => {
    const productActionsTg = { handleCallback: jest.fn() };
    const withPa = new TgBotService(
      pg as any, identity as any, {} as any, configs as any, {} as any, {} as any, {} as any,
      commands as any, {} as any, grammy as any, {} as any, {} as any, blog as any,
      undefined, undefined, productActionsTg as any,
    );
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);
    const cb = { id: 'cb4', data: 'pa:ok:11111111-2222-3333-4444-555555555555', from: { id: 42 }, message: { chat: { id: 42 } } };
    await (withPa as any).handleCallbackQuery(cb);
    expect(productActionsTg.handleCallback).toHaveBeenCalledWith(cb);
    expect(identity.getLinkeonIdByTgUserId).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Тексты бота**

В `src/tg-bot/tg-i18n.ts` в каталог `ru` перед закрывающей `};` добавить:
```ts
  // Карточки продуктов (product-actions)
  pa_delete_prompt: 'Удалить «{name}»? Продукт выключится сразу, вернуть его можно до {date} — попросите ассистента. Оплаченный период не возвращается.',
  pa_delete_btn: 'Удалить',
  pa_cancel_btn: 'Отмена',
  pa_deleted: '«{name}» удалён. Вернуть можно до {date} — попросите ассистента.',
  pa_cancelled: 'Удаление отменено.',
  pa_closed: 'Это подтверждение уже закрыто.',
  pa_failed: 'Не получилось: {reason}',
  pa_create_bot_prompt: 'Чтобы создать бота «{name}», введите токен от @BotFather и ключи сервисов в защищённой форме. В переписку их не присылайте.',
  pa_create_bot_btn: 'Ввести ключи',
  pa_open_cabinet_btn: 'Открыть в кабинете',
```
Остальные каталоги (тип `Catalog` требует все ключи):

`en` (двойные кавычки, как в каталоге):
```ts
  pa_delete_prompt: "Delete “{name}”? It will be switched off right away; you can restore it until {date} — just ask the assistant. The paid period is not refunded.",
  pa_delete_btn: "Delete",
  pa_cancel_btn: "Cancel",
  pa_deleted: "“{name}” has been deleted. You can restore it until {date} — just ask the assistant.",
  pa_cancelled: "Deletion cancelled.",
  pa_closed: "This confirmation is already closed.",
  pa_failed: "That didn't work: {reason}",
  pa_create_bot_prompt: "To create the bot “{name}”, enter the token from @BotFather and your service keys in the secure form. Please don't send them in the chat.",
  pa_create_bot_btn: "Enter keys",
  pa_open_cabinet_btn: "Open in your account",
```
`de`:
```ts
  pa_delete_prompt: '„{name}“ löschen? Das Produkt wird sofort abgeschaltet; du kannst es bis {date} zurückholen – frag einfach den Assistenten. Der bezahlte Zeitraum wird nicht erstattet.',
  pa_delete_btn: 'Löschen',
  pa_cancel_btn: 'Abbrechen',
  pa_deleted: '„{name}“ ist gelöscht. Zurückholen kannst du es bis {date} – frag einfach den Assistenten.',
  pa_cancelled: 'Löschen abgebrochen.',
  pa_closed: 'Diese Bestätigung ist bereits geschlossen.',
  pa_failed: 'Das hat nicht geklappt: {reason}',
  pa_create_bot_prompt: 'Um den Bot „{name}“ anzulegen, gib das Token von @BotFather und die Schlüssel deiner Dienste im geschützten Formular ein. Schick sie bitte nicht in den Chat.',
  pa_create_bot_btn: 'Schlüssel eingeben',
  pa_open_cabinet_btn: 'Im Konto öffnen',
```
`fr` (внутри `frenchTypography({ … })`):
```ts
  pa_delete_prompt: 'Supprimer « {name} » ? Le produit sera désactivé tout de suite ; vous pourrez le restaurer jusqu’au {date} — il suffit de le demander à l’assistant. La période déjà payée n’est pas remboursée.',
  pa_delete_btn: 'Supprimer',
  pa_cancel_btn: 'Annuler',
  pa_deleted: '« {name} » a été supprimé. Vous pouvez le restaurer jusqu’au {date} — il suffit de le demander à l’assistant.',
  pa_cancelled: 'Suppression annulée.',
  pa_closed: 'Cette confirmation est déjà close.',
  pa_failed: 'Cela n’a pas marché : {reason}',
  pa_create_bot_prompt: 'Pour créer le bot « {name} », saisissez le jeton de @BotFather et les clés de vos services dans le formulaire sécurisé. Ne les envoyez pas dans la discussion.',
  pa_create_bot_btn: 'Saisir les clés',
  pa_open_cabinet_btn: 'Ouvrir dans votre espace',
```
`es`:
```ts
  pa_delete_prompt: '¿Eliminar «{name}»? Se apagará de inmediato; puedes recuperarlo hasta el {date}, solo pídeselo al asistente. El periodo ya pagado no se reembolsa.',
  pa_delete_btn: 'Eliminar',
  pa_cancel_btn: 'Cancelar',
  pa_deleted: '«{name}» se ha eliminado. Puedes recuperarlo hasta el {date}, solo pídeselo al asistente.',
  pa_cancelled: 'Eliminación cancelada.',
  pa_closed: 'Esta confirmación ya está cerrada.',
  pa_failed: 'No ha funcionado: {reason}',
  pa_create_bot_prompt: 'Para crear el bot «{name}», introduce el token de @BotFather y las claves de tus servicios en el formulario seguro. No las envíes por el chat.',
  pa_create_bot_btn: 'Introducir claves',
  pa_open_cabinet_btn: 'Abrir en tu cuenta',
```
`pt` (европейский):
```ts
  pa_delete_prompt: 'Eliminar «{name}»? O produto é desligado de imediato; podes recuperá-lo até {date} — basta pedires ao assistente. O período já pago não é reembolsado.',
  pa_delete_btn: 'Eliminar',
  pa_cancel_btn: 'Cancelar',
  pa_deleted: '«{name}» foi eliminado. Podes recuperá-lo até {date} — basta pedires ao assistente.',
  pa_cancelled: 'Eliminação cancelada.',
  pa_closed: 'Esta confirmação já está fechada.',
  pa_failed: 'Não resultou: {reason}',
  pa_create_bot_prompt: 'Para criar o bot «{name}», introduz o token do @BotFather e as chaves dos teus serviços no formulário seguro. Não as envies pela conversa.',
  pa_create_bot_btn: 'Introduzir chaves',
  pa_open_cabinet_btn: 'Abrir na tua conta',
```
`zh`:
```ts
  pa_delete_prompt: '删除「{name}」？产品会立即停用；在 {date} 之前可以恢复——告诉助手即可。已支付的期限不予退还。',
  pa_delete_btn: '删除',
  pa_cancel_btn: '取消',
  pa_deleted: '「{name}」已删除。在 {date} 之前可以恢复——告诉助手即可。',
  pa_cancelled: '已取消删除。',
  pa_closed: '此确认已关闭。',
  pa_failed: '未能完成：{reason}',
  pa_create_bot_prompt: '要创建机器人「{name}」，请在安全表单中输入 @BotFather 提供的令牌和各项服务的密钥。请不要在聊天中发送。',
  pa_create_bot_btn: '输入密钥',
  pa_open_cabinet_btn: '在个人中心打开',
```
Рядом с `formatTgNumber`:
```ts
export function formatTgDate(lang: string | null | undefined, iso: string | Date): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[LanguageService.normalize(lang) as TgLang], { day: 'numeric', month: 'long' })
    .format(new Date(iso));
}
```

- [ ] **Step 4: Сервис кнопок**

`src/tg-bot/tg-product-actions.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ProductActionsService } from '../products/product-actions.service';
import { ProductLifecycleService, DELETE_GRACE_DAYS } from '../products/product-lifecycle.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgIdentityService } from './tg-identity.service';
import { formatTgDate, tgText } from './tg-i18n';

const TMA_URL = process.env.TMA_URL || 'https://my.linkeon.io/tma/';
const CABINET = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
const CALLBACK_RE = /^pa:(ok|no):([0-9a-f-]{36})$/i;

export function shouldRouteToProductActions(data: string): boolean {
  return typeof data === 'string' && data.startsWith('pa:');
}

/**
 * Карточки продуктов в Telegram. Удаление — кнопками под отдельным
 * сообщением: нажатие засчитывается, только если нажал привязанный Telegram
 * владельца действия. Ключи бота — только формой мини-приложения (в группе
 * кнопка мини-приложения недоступна — там ссылка на кабинет): в переписку
 * ключи не идут никогда.
 */
@Injectable()
export class TgProductActionsService {
  private readonly logger = new Logger(TgProductActionsService.name);

  constructor(
    private readonly actions: ProductActionsService,
    private readonly lifecycle: ProductLifecycleService,
    private readonly grammy: TgGrammyClient,
    private readonly identity: TgIdentityService,
  ) {}

  async sendForTurn(i: { userId: string; turn: string; since: Date; chatId: number; isPrivate: boolean; lang: string }): Promise<void> {
    const taken = await this.actions.takeForTurn(i.userId, i.turn, i.since);
    for (const a of taken) {
      const name = String(a.payload?.name ?? '');
      let text: string;
      let reply_markup: any;
      if (a.kind === 'delete') {
        const date = formatTgDate(i.lang, new Date(Date.now() + DELETE_GRACE_DAYS * 86_400_000));
        text = tgText(i.lang, 'pa_delete_prompt', { name, date });
        reply_markup = { inline_keyboard: [[
          { text: tgText(i.lang, 'pa_delete_btn'), callback_data: `pa:ok:${a.id}` },
          { text: tgText(i.lang, 'pa_cancel_btn'), callback_data: `pa:no:${a.id}` },
        ]] };
      } else {
        text = tgText(i.lang, 'pa_create_bot_prompt', { name });
        reply_markup = { inline_keyboard: [[
          i.isPrivate
            ? { text: tgText(i.lang, 'pa_create_bot_btn'), web_app: { url: `${TMA_URL}#pa=${a.id}` } }
            : { text: tgText(i.lang, 'pa_open_cabinet_btn'), url: `${CABINET}/studio?tab=products&action=${a.id}` },
        ]] };
      }
      const sent: any = await this.grammy.sendMessage(i.chatId, text, { reply_markup });
      if (sent?.message_id) await this.actions.setTelegramMessage(a.id, i.chatId, sent.message_id);
    }
  }

  async handleCallback(cb: any): Promise<void> {
    const m = CALLBACK_RE.exec(String(cb?.data ?? ''));
    await this.grammy.answerCallbackQuery(cb.id, {}).catch(() => undefined);
    if (!m) return;
    const [, verb, id] = m;
    const action = await this.actions.getById(id);
    if (!action) return;
    const owner = await this.identity.getIdentityByLinkeonId(action.user_id);
    if (!owner || Number(owner.tgUserId) !== Number(cb?.from?.id)) return;
    const lang = cb?.from?.language_code ?? null;
    const chatId = cb?.message?.chat?.id;
    const messageId = cb?.message?.message_id;
    const name = String(action.product_name ?? action.payload?.name ?? '');
    let text: string;
    if (verb === 'no') {
      text = (await this.actions.cancel(action.user_id, id)) ? tgText(lang, 'pa_cancelled') : tgText(lang, 'pa_closed');
    } else if (action.kind === 'delete') {
      const r = await this.lifecycle.completeDelete({ userId: action.user_id, actionId: id, via: 'telegram' });
      text = r.ok
        ? tgText(lang, 'pa_deleted', { name, date: formatTgDate(lang, r.restoreUntil) })
        : r.reason === 'not_pending' ? tgText(lang, 'pa_closed') : tgText(lang, 'pa_failed', { reason: r.message });
    } else {
      return;
    }
    if (chatId && messageId) {
      await this.grammy.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } })
        .catch((e: any) => this.logger.warn(`карточка продукта: сообщение не поправлено: ${e?.message}`));
    }
  }
}
```

Язык кнопки берётся из `language_code` нажавшего: в ответе на нажатие базу языка не читаем; при необходимости позже — `ownerTgLanguage`.

- [ ] **Step 5: Проводка в боте**

`src/tg-bot/tg-router.service.ts`: у `generateReply` в типе `opts` добавить `turn?: string`, и `productsCliMcp(owner.linkeonId, 'telegram')` → `productsCliMcp(owner.linkeonId, 'telegram', opts.turn)`.

`src/tg-bot/tg-bot.service.ts`:
1. Импорты: `import { randomUUID } from 'crypto';` (если ещё нет) и `import { TgProductActionsService, shouldRouteToProductActions } from './tg-product-actions.service';`.
2. Конструктор — 16-м параметром после `insights`:
```ts
    // Карточки продуктов (удаление, ключи бота). Последним и @Optional:
    // спеки собирают сервис позиционно.
    @Optional() private readonly productActionsTg?: TgProductActionsService,
```
3. `handleCallbackQuery`: сразу после ветки `shouldRouteToInsights` и до `getLinkeonIdByTgUserId`:
```ts
    // Кнопки карточки продукта — до проверки привязки: владельца действия
    // сверяет обработчик по привязанному Telegram, а не по связке ассистентов.
    if (shouldRouteToProductActions(data)) {
      await this.productActionsTg?.handleCallback(cb);
      return;
    }
```
4. `handleChatMessage`: строкой перед вызовом `this.router.generateReply(` добавить
```ts
      const productsTurn = randomUUID();
      const productsSince = new Date();
```
а последний аргумент вызова `{ productsOwner }` → `{ productsOwner, turn: productsTurn }`.
5. Там же, сразу после цикла отправки файлов песочницы (`for (const f of sandboxOutputs) { … }`) и до `const totalCostUsd = …`:
```ts
      if (productsOwner && this.productActionsTg) {
        await this.productActionsTg
          .sendForTurn({ userId: productsOwner.linkeonId, turn: productsTurn, since: productsSince, chatId: outMsg.chat.id, isPrivate: msg.chat?.type === 'private', lang: turnLang })
          .catch((e: any) => this.logger.warn(`карточки продуктов не отправлены в чат ${outMsg.chat.id}: ${e?.message}`));
      }
```

`src/tg-bot/tg-bot.module.ts`: импорт `ProductsModule` в `imports`, `TgProductActionsService` — в `providers`.

- [ ] **Step 6: Коммит, прогон — PASS**

Run (нода): `src/tg-bot` целиком (там же i18n-сторожа каталогов: семь языков, «вы» в ru) и `npx tsc -p tsconfig.build.json --noEmit`.

```bash
git -C $B add src/tg-bot && git -C $B commit -q -m "tg-bot: карточки продуктов — кнопки удаления владельцу, форма ключей бота в мини-приложении"
```

---

### Task 13: Тексты «что есть в Linkeon» и промпт релея

**Files:**
- Modify: `src/chat/platform-guide.ts:9`, `:158`
- Modify: `src/chat/platform-guide.spec.ts:63`
- Modify: `relay-agent/server.mjs:350-353` (`PRODUCTS_PROMPT`)

- [ ] **Step 1: Правка справки**

`src/chat/platform-guide.ts:158`: `'по просьбам обычными словами. Новый продукт создаётся только там.',` → `'по просьбам обычными словами. Создать, удалить или вернуть продукт можно и попросив ассистента в чате.',`. Комментарий в строке 9 («хотя продукт заводится только кнопкой в Студии») → «продукт заводится и в Студии, и ассистентом — инструментом manage_product».

`src/chat/platform-guide.spec.ts:63`: ожидание `/Новый продук…/` → `toMatch(/Создать, удалить или вернуть продукт можно и попросив ассистента/)`.

- [ ] **Step 2: Промпт релея** (копия в репозитории; выкат релея — задача 23, только с OK)

В `relay-agent/server.mjs` после строки про `{ action: "domain", … }` (и её продолжения про записи DNS) добавить строки:
```
- { action: "create", kind: "site"|"bot", name, prompt? } — создать продукт. ДО вызова назови условия: первый месяц бесплатно, дальше 50 000 токенов в месяц, не больше двух продуктов. Для бота сервер сам прикрепит к ответу защищённую карточку ключей — ключи в переписке не проси.
- { action: "delete", product } — удалить: сервер прикрепит карточку с кнопкой, удаление только по её нажатию; вернуть можно 30 дней. { action: "restore", product } — вернуть удалённый. { action: "revert", product, turnId? } — откатить правку.
- { action: "status", actionId } — чем кончилась карточка. Не говори «создал» или «удалил», пока status не вернёт done.
```

- [ ] **Step 3: Коммит, прогон — PASS** (`src/chat/platform-guide.spec.ts`; если у релея есть свои тесты — `node --test relay-agent` в CI-клоне)

```bash
git -C $B add src/chat relay-agent && git -C $B commit -q -m "texts: справка и промпт релея — ассистент создаёт, удаляет и возвращает продукты"
```

---

### Task 14: Фронт — ручки карточки

**Files:**
- Modify: `src/services/productsApi.ts:274` (`async function problem` → `export async function problem`)
- Create: `src/services/productActionsApi.ts`
- Test: `src/services/productActionsApi.test.ts`

- [ ] **Step 1: Тест**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiClient', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
import { apiClient } from './apiClient';
import { productActionsApi, isProblem } from './productActionsApi';

const api = vi.mocked(apiClient);
const json = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() }) as any;
const VIEW = { id: 'a1', kind: 'delete', status: 'pending', productId: 'p1', productName: 'М', keyNames: [], expiresAt: null, restoreUntil: null, result: null };

describe('ручки карточки', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get — вид', async () => {
    api.get.mockResolvedValue(json(200, VIEW));
    expect(await productActionsApi.get('a1')).toEqual(VIEW);
    expect(api.get).toHaveBeenCalledWith('/webhook/product-actions/a1');
  });

  it('submit удаления — confirm и источник', async () => {
    api.post.mockResolvedValue(json(200, { ...VIEW, status: 'done' }));
    await productActionsApi.submit('a1', { confirm: true, via: 'chat' });
    expect(api.post).toHaveBeenCalledWith('/webhook/product-actions/a1', { confirm: true, via: 'chat' });
  });

  it('ошибка сервера — Problem, сеть — status 0', async () => {
    api.get.mockResolvedValue(json(404, { message: 'Action not found' }));
    const r = await productActionsApi.get('a1');
    expect(isProblem(r) && r.status).toBe(404);
    api.get.mockRejectedValue(new Error('offline'));
    const n = await productActionsApi.get('a1');
    expect(isProblem(n) && n.status).toBe(0);
  });

  it('pending — массив, при сбое пустой', async () => {
    api.get.mockResolvedValue(json(200, [VIEW]));
    expect(await productActionsApi.pending()).toEqual([VIEW]);
    api.get.mockRejectedValue(new Error('x'));
    expect(await productActionsApi.pending()).toEqual([]);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (Run (нода, фронт): `src/services/productActionsApi.test.ts`)

- [ ] **Step 3: Реализация**

`src/services/productActionsApi.ts`:

```ts
import { apiClient } from './apiClient';
import { problem, type Problem } from './productsApi';

export type ProductActionKind = 'create_site' | 'create_bot' | 'keys' | 'delete' | 'restore' | 'revert' | 'purge';
export type ProductActionStatus = 'pending' | 'working' | 'done' | 'failed' | 'expired' | 'cancelled';

export interface ProductActionView {
  id: string;
  kind: ProductActionKind;
  status: ProductActionStatus;
  productId: string | null;
  productName: string | null;
  keyNames: string[];
  expiresAt: string | null;
  restoreUntil: string | null;
  result: { error?: string; reason?: string; productId?: string; botUsername?: string; restoreUntil?: string } | null;
}

export type ActionSource = 'chat' | 'cabinet' | 'tma';

export function isProblem(x: ProductActionView | Problem): x is Problem {
  return (x as Problem).ok === false;
}

const enc = encodeURIComponent;

async function call(fn: () => Promise<Response>): Promise<ProductActionView | Problem> {
  let res: Response;
  try {
    res = await fn();
  } catch {
    return { ok: false, status: 0, message: '' };
  }
  if (!res.ok) return problem(res);
  return (await res.json()) as ProductActionView;
}

export const productActionsApi = {
  get: (id: string) => call(() => apiClient.get(`/webhook/product-actions/${enc(id)}`)),
  submit: (id: string, body: { confirm?: true; set?: Record<string, string>; via: ActionSource }) =>
    call(() => apiClient.post(`/webhook/product-actions/${enc(id)}`, body)),
  cancel: (id: string) => call(() => apiClient.post(`/webhook/product-actions/${enc(id)}/cancel`)),
  async pending(): Promise<ProductActionView[]> {
    try {
      const res = await apiClient.get('/webhook/product-actions');
      if (!res.ok) return [];
      const j = await res.json();
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  },
};
```

- [ ] **Step 4: Коммит, прогон — PASS** (плюс `src/services/productsApi.test.ts` — регрессия)

```bash
git -C $F add src/services && git -C $F commit -q -m "products: клиент ручек карточки действий"
```

---

### Task 15: Фронт — разбор блока карточки

**Files:**
- Create: `src/utils/productActionBlock.ts`
- Modify: `src/utils/customMarkdown.tsx:73-95` и возврат `:161`
- Test: `src/utils/productActionBlock.test.ts`

- [ ] **Step 1: Тест**

````ts
import { describe, it, expect } from 'vitest';
import { extractProductActions, stripProductActionBlocks } from './productActionBlock';
import { parseCustomMarkdown } from './customMarkdown';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const block = (id = ID) => '```product-action\n{"id":"' + id + '"}\n```';

describe('блок карточки продукта', () => {
  it('блок → маркер, id — в карту', () => {
    const r = extractProductActions(`Готово.\n\n${block()}`);
    expect(r.content).toBe('Готово.\n\n__PACTION_0__');
    expect(r.actions.get('0')).toBe(ID);
  });

  it('не uuid или мусор внутри — блок исчезает без карточки', () => {
    const r = extractProductActions('Текст\n\n```product-action\n{"id":"drop"}\n```');
    expect(r.content).toBe('Текст\n\n');
    expect(r.actions.size).toBe(0);
  });

  it('копирование — без блоков', () => {
    expect(stripProductActionBlocks(`А\n\n${block()}`)).toBe('А\n\n');
  });

  it('parseCustomMarkdown отдаёт карточки и не трогает блок вопросов', () => {
    const r = parseCustomMarkdown(`Ниже карточка.\n\n${block()}`);
    expect(r.content).toContain('__PACTION_0__');
    expect(r.productActions.get('0')).toBe(ID);
    expect(r.asks.size).toBe(0);
  });
});
````

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Реализация**

`src/utils/productActionBlock.ts`:

````ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Блок, который сервер дописывает к ответу ассистента (product-action-tail.ts):
// ```product-action\n{"id":"…"}\n```
const BLOCK_RE = /(^|\n)[ \t]*```[ \t]*product-action[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/g;

/**
 * Блоки карточек → маркеры __PACTION_n__, id — в карту. Блок с негодным id
 * исчезает без карточки: сочинить блок модель не может, но мусору не место в
 * тексте.
 */
export function extractProductActions(content: string): { content: string; actions: Map<string, string> } {
  const actions = new Map<string, string>();
  let n = 0;
  const out = content.replace(BLOCK_RE, (_m: string, lead: string, body: string) => {
    let id: unknown = null;
    try {
      id = JSON.parse(body.trim())?.id;
    } catch {
      id = null;
    }
    if (typeof id !== 'string' || !UUID_RE.test(id)) return lead;
    const key = String(n++);
    actions.set(key, id);
    return `${lead}__PACTION_${key}__`;
  });
  return { content: out, actions };
}

export function stripProductActionBlocks(content: string): string {
  return content.replace(BLOCK_RE, (_m: string, lead: string) => lead);
}
````

В `src/utils/customMarkdown.tsx`:
1. Импорт `import { extractProductActions } from './productActionBlock';`.
2. В тип возврата `parseCustomMarkdown` добавить `productActions: Map<string, string>`.
3. Строку `const { content: withoutAsks, asks } = extractAskBlocks(content, opts);` заменить на
```ts
  // Карточки продуктов — до всего остального: внутри блока JSON.
  const { content: withoutActions, actions: productActions } = extractProductActions(content);
  const { content: withoutAsks, asks } = extractAskBlocks(withoutActions, opts);
```
4. В возвращаемый объект добавить `productActions`.

- [ ] **Step 4: Коммит, прогон — PASS** (`src/utils/productActionBlock.test.ts src/utils` — регрессия разбора)

```bash
git -C $F add src/utils && git -C $F commit -q -m "chat: разбор блока карточки продукта в ответе ассистента"
```

---

### Task 16: Фронт — карточка

**Files:**
- Create: `src/components/products/ProductActionCard.tsx`
- Test: `src/components/products/ProductActionCard.test.tsx`
- Modify: `src/components/webvisorPrivacy.test.ts`

Ключи i18n `products.action.*` добавляются в задаче 20; до неё тест опирается на `tRu`, который возвращает ключ, если перевода нет, — поэтому задача 20 идёт сразу следом, а ожидания теста здесь — по ключам и по `tRu` одновременно (после задачи 20 `tRu` вернёт русский текст, и тест останется зелёным).

- [ ] **Step 1: Тест**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, clickAsync, flush, type, byButton, visibleText, tRu } from '../../test/dom';
import { ProductActionCard } from './ProductActionCard';
import { productActionsApi } from '../../services/productActionsApi';
import type { ProductActionView } from '../../services/productActionsApi';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
vi.mock('../../services/productActionsApi', () => ({
  productActionsApi: { get: vi.fn(), submit: vi.fn(), cancel: vi.fn() },
  isProblem: (x: any) => x?.ok === false,
}));
const api = vi.mocked(productActionsApi);

const view = (over: Partial<ProductActionView> = {}): ProductActionView => ({
  id: 'a1', kind: 'delete', status: 'pending', productId: 'p1', productName: 'Магазин', keyNames: [],
  expiresAt: '2026-10-25T10:30:00.000Z', restoreUntil: '2026-11-24T10:00:00.000Z', result: null, ...over,
});

describe('карточка действия продукта', () => {
  beforeEach(() => vi.clearAllMocks());

  it('удаление: заголовок и дата возврата; «Удалить» шлёт confirm', async () => {
    api.get.mockResolvedValue(view());
    api.submit.mockResolvedValue(view({ status: 'done', result: { restoreUntil: '2026-11-24T10:00:00.000Z' } }));
    const { container } = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    expect(visibleText(container)).toContain(tRu('products.action.delete.title', { name: 'Магазин' }));
    await clickAsync(byButton(container, new RegExp(tRu('products.action.delete.confirm')))!);
    expect(api.submit).toHaveBeenCalledWith('a1', { confirm: true, via: 'chat' });
    expect(visibleText(container)).toContain(tRu('products.action.delete.done', { name: 'Магазин', date: '24 ноября' }));
  });

  it('бот: без токена не отправляет; с токеном — ключи уходят в set, поля очищаются', async () => {
    api.get.mockResolvedValue(view({ kind: 'create_bot', productId: null, productName: 'Бот' }));
    api.submit.mockResolvedValue(view({ kind: 'create_bot', status: 'done', productName: 'Бот', result: { productId: 'p9', botUsername: 'b' } }));
    const { container } = mount(<ProductActionCard actionId="a1" via="tma" />);
    await flush();
    await clickAsync(byButton(container, new RegExp(tRu('products.action.createBot.submit')))!);
    expect(api.submit).not.toHaveBeenCalled();
    expect(visibleText(container)).toContain(tRu('products.action.createBot.tokenRequired'));
    const token = container.querySelector('[data-testid="product-action-token"]') as HTMLInputElement;
    type(token, '123:abc');
    await clickAsync(byButton(container, new RegExp(tRu('products.action.createBot.submit')))!);
    expect(api.submit).toHaveBeenCalledWith('a1', { set: { BOT_TOKEN: '123:abc' }, via: 'tma' });
    expect(container.querySelector('[data-testid="product-action-token"]')).toBeNull();
  });

  it('ошибка, которую можно поправить, — на месте, карточка ждёт', async () => {
    api.get.mockResolvedValue(view({ kind: 'create_bot', result: { error: 'Telegram не принял токен' } }));
    const { container } = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    expect(visibleText(container)).toContain('Telegram не принял токен');
  });

  it('срок вышел и не найдено — свои тексты', async () => {
    api.get.mockResolvedValue(view({ status: 'expired' }));
    const a = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    expect(visibleText(a.container)).toContain(tRu('products.action.expired'));
    api.get.mockResolvedValue({ ok: false, status: 404, message: '' } as any);
    const b = mount(<ProductActionCard actionId="a2" via="chat" />);
    await flush();
    expect(visibleText(b.container)).toContain(tRu('products.action.notFound'));
  });
});
```

В `src/components/webvisorPrivacy.test.ts` — новая константа рядом с остальными `readFileSync`:
```ts
const ProductActionCardSrc = readFileSync(join(__dirname, 'products', 'ProductActionCard.tsx'), 'utf8');
```
и тесты:
```ts
describe('карточка действия продукта скрыта от Вебвизора', () => {
  it('карточка целиком — ym-hide-content', () => {
    expect(classesOf(ProductActionCardSrc, 'product-action-card', 'div')).toContain('ym-hide-content');
  });
  it('токен бота и значения ключей — ym-disable-keys', () => {
    expect(classesOf(ProductActionCardSrc, 'product-action-token', 'input')).toContain('ym-disable-keys');
    expect(classesOf(ProductActionCardSrc, 'product-action-secret-value', 'input')).toContain('ym-disable-keys');
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Компонент**

`src/components/products/ProductActionCard.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { productActionsApi, isProblem, type ActionSource, type ProductActionView } from '../../services/productActionsApi';
import { extraSecretsPayload, validateExtraSecrets, type ExtraSecretError, type ExtraSecretRow, SECRET_NAME_MAX } from './secretNames';

/**
 * Карточка ожидающего действия продукта: удаление (кнопка) и создание бота
 * (токен и ключи). Значения уходят прямо на сервер — ни ассистент, ни история
 * чата их не видят; после отправки поля очищаются. Вся карточка скрыта от
 * Вебвизора (ym-hide-content), поля ключей — ym-disable-keys.
 */
export function ProductActionCard({ actionId, via, onClose }: { actionId: string; via: ActionSource; onClose?: () => void }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<ProductActionView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [rows, setRows] = useState<Array<ExtraSecretRow & { id: number }>>([]);
  const [rowErrors, setRowErrors] = useState<ExtraSecretError[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await productActionsApi.get(actionId);
      if (!alive) return;
      if (isProblem(r)) setLoadFailed(true);
      else {
        setView(r);
        setError(r.status === 'pending' && typeof r.result?.error === 'string' ? r.result.error : null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [actionId]);

  const fmt = (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'long' }).format(new Date(iso)) : '';

  const apply = (r: ProductActionView | { ok: false; message: string }) => {
    if (isProblem(r as any)) {
      setError((r as any).message || t('products.action.failed', { reason: '' }));
      return;
    }
    const v = r as ProductActionView;
    setView(v);
    setError(v.status === 'pending' && typeof v.result?.error === 'string' ? v.result.error : null);
    if (v.status !== 'pending') {
      setToken('');
      setRows([]);
    }
  };

  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      apply(await fn());
    } finally {
      setBusy(false);
    }
  };

  const submitBot = () => {
    if (!token.trim()) {
      setError(t('products.action.createBot.tokenRequired'));
      return;
    }
    const errs = validateExtraSecrets(rows);
    setRowErrors(errs);
    if (errs.some((e) => e.name || e.value)) return;
    void run(() => productActionsApi.submit(actionId, { set: { ...extraSecretsPayload(rows), BOT_TOKEN: token.trim() }, via }));
  };

  const name = view?.productName ?? '';
  let body: React.ReactNode;
  if (loadFailed) body = <p>{t('products.action.notFound')}</p>;
  else if (!view) body = <p className="opacity-60">{t('products.action.loading')}</p>;
  else if (view.status === 'working') body = <p>{t('products.action.working')}</p>;
  else if (view.status === 'expired') body = <p>{t('products.action.expired')}</p>;
  else if (view.status === 'cancelled') body = <p>{t('products.action.cancelled')}</p>;
  else if (view.status === 'failed') body = <p>{t('products.action.failed', { reason: view.result?.error ?? '' })}</p>;
  else if (view.status === 'done') {
    body = view.kind === 'delete'
      ? <p>{t('products.action.delete.done', { name, date: fmt(view.result?.restoreUntil) })}</p>
      : <p>{t('products.action.createBot.done', { name })}</p>;
  } else if (view.kind === 'delete') {
    body = (
      <>
        <p className="font-medium">{t('products.action.delete.title', { name })}</p>
        <p>{t('products.action.delete.body', { date: fmt(view.restoreUntil) })}</p>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void run(() => productActionsApi.submit(actionId, { confirm: true, via }))}
            className="px-4 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium disabled:opacity-50">
            {t('products.action.delete.confirm')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => productActionsApi.cancel(actionId))}
            className="px-4 py-1.5 rounded-lg border border-gray-300 text-xs">
            {t('products.action.cancel')}
          </button>
        </div>
      </>
    );
  } else if (view.kind === 'create_bot') {
    body = (
      <>
        <p className="font-medium">{t('products.action.createBot.title', { name })}</p>
        <p className="text-xs text-gray-600">{t('products.action.createBot.hint')}</p>
        <label className="block text-xs">
          {t('products.action.createBot.token')}
          <input data-testid="product-action-token" type="password" autoComplete="off" spellCheck={false}
            value={token} onChange={(e) => setToken(e.target.value)}
            className="ym-disable-keys mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5" />
        </label>
        <div role="group" className="space-y-2">
          <p className="text-xs font-medium">{t('products.action.createBot.extraTitle')}</p>
          {rows.map((row, i) => (
            <div key={row.id} className="flex gap-2">
              <input type="text" maxLength={SECRET_NAME_MAX} aria-label={t('products.action.createBot.keyName')}
                placeholder="API_KEY" value={row.name}
                onChange={(e) => setRows(rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))}
                className="w-2/5 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
              <input data-testid="product-action-secret-value" type="password" autoComplete="off" spellCheck={false}
                aria-label={t('products.action.createBot.keyValue')} value={row.value}
                onChange={(e) => setRows(rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
                className="ym-disable-keys flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
              <button type="button" onClick={() => setRows(rows.filter((r) => r.id !== row.id))} className="text-xs text-gray-500">
                {t('products.action.createBot.removeKey')}
              </button>
              {(rowErrors[i]?.name || rowErrors[i]?.value) && (
                <span className="text-xs text-red-700">{t((rowErrors[i].name ?? rowErrors[i].value)!)}</span>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setRows([...rows, { id: nextId.current++, name: '', value: '' }])}
            className="text-xs text-forest-700">
            {t('products.action.createBot.addKey')}
          </button>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={submitBot}
            className="px-4 py-1.5 rounded-lg bg-forest-600 text-white text-xs font-medium disabled:opacity-50">
            {busy ? t('products.action.createBot.submitting') : t('products.action.createBot.submit')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => productActionsApi.cancel(actionId))}
            className="px-4 py-1.5 rounded-lg border border-gray-300 text-xs">
            {t('products.action.cancel')}
          </button>
        </div>
      </>
    );
  } else {
    body = <p>{t('products.action.keys.unsupported')}</p>;
  }

  return (
    <div data-testid="product-action-card" className="ym-hide-content not-prose my-2 rounded-xl border border-forest-200 bg-forest-50/40 p-3 space-y-3 text-sm">
      {body}
      {error && <p className="text-xs text-red-700">{error}</p>}
      {onClose && (
        <button type="button" onClick={onClose} className="text-xs text-gray-500">
          {t('products.action.close')}
        </button>
      )}
    </div>
  );
}
```

Проверка «дата 24 ноября» в тесте опирается на `Intl` в jsdom с языком `ru`: `new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(new Date('2026-11-24T10:00:00Z'))` = `24 ноября`.

- [ ] **Step 4: Коммит, прогон — PASS после задачи 20** (`src/components/products/ProductActionCard.test.tsx src/components/webvisorPrivacy.test.ts`). До задачи 20 ожидания по `tRu` совпадают с ключами — тест зелёный и так.

```bash
git -C $F add src/components && git -C $F commit -q -m "products: карточка действия — удаление кнопкой, токен и ключи бота мимо модели"
```

---

### Task 17: Фронт — карточка в чате

**Files:**
- Modify: `src/components/chat/ChatInterface.tsx` (запрос :1400–1418, загрузка :2370, оба отрисовщика, копирование :3131)
- Modify: `src/components/chat/interactivityWiring.test.ts:27,41`

- [ ] **Step 1: Тест** — в `interactivityWiring.test.ts` ожидания строк 27 и 41:

```ts
    expect(send()).toContain('ui: { activity: true, ask: true, cards: true }');
    // …
    expect(upload()).toContain("formData.append('ui', JSON.stringify({ activity: true, ask: true, cards: true }))");
```
и новый тест в конец того же `describe`:
```ts
  it('карточки продуктов рисуются в обоих отрисовщиках, а копирование их вырезает', () => {
    expect(SRC.match(/startsWith\('__PACTION_'\)/g)?.length).toBe(2);
    expect(SRC).toContain('stripProductActionBlocks(message.content)');
  });
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Правка** — скриптом со сверкой числа вхождений

```bash
cd ~/Downloads/spirits_front/.worktrees/product-lifecycle && node - <<'EOF'
const fs = require('fs');
const f = 'src/components/chat/ChatInterface.tsx';
let s = fs.readFileSync(f, 'utf8');
function rep(a, b, n) {
  const k = s.split(a).length - 1;
  if (k !== n) { console.error(`ожидалось ${n}, нашлось ${k}: ${a.slice(0, 80)}`); process.exit(1); }
  s = s.split(a).join(b);
}
rep('ui: { activity: true, ask: true }', 'ui: { activity: true, ask: true, cards: true }', 1);
rep("formData.append('ui', JSON.stringify({ activity: true, ask: true }))", "formData.append('ui', JSON.stringify({ activity: true, ask: true, cards: true }))", 1);
rep('voiceCalls, meetings, asks } = parseCustomMarkdown(', 'voiceCalls, meetings, asks, productActions } = parseCustomMarkdown(', 2);
// Маркеры карточек — рядом с маркерами вопросов, с тем же отступом.
s = s.replace(/^([ \t]*)const askMatches = \[\.\.\.parsedContent\.matchAll\(\/__ASK_\(\\d\+\)__\/g\)\];$/gm,
  (m, ind) => `${m}\n${ind}const paMatches = [...parsedContent.matchAll(/__PACTION_(\\d+)__/g)];`);
rep('...meetingMatches, ...askMatches]', '...meetingMatches, ...askMatches, ...paMatches]', 2);
rep("} else if (match[0].startsWith('__ASK_')) {",
  "} else if (match[0].startsWith('__PACTION_')) {\n" +
  "                        const paId = productActions.get(match[1]);\n" +
  "                        if (paId) parts.push(<ProductActionCard key={`pa-${idx}`} actionId={paId} via=\"chat\" />);\n" +
  "                      } else if (match[0].startsWith('__ASK_')) {", 2);
rep('askBlocksToPlainText(stripCalendarProposalMarkers(stripVideoJobMarkers(message.content)))',
  'askBlocksToPlainText(stripCalendarProposalMarkers(stripVideoJobMarkers(stripProductActionBlocks(message.content))))', 1);
if ((s.match(/const paMatches = /g) || []).length !== 2) { console.error('paMatches не вставились дважды'); process.exit(1); }
s = s.replace("import { AskBlockView", "import { ProductActionCard } from '../products/ProductActionCard';\nimport { stripProductActionBlocks } from '../../utils/productActionBlock';\nimport { AskBlockView");
fs.writeFileSync(f, s);
console.log('ok');
EOF
```
Импорт в файле — `import { AskBlockView, type AskMode } from './AskCard';` (строка 59): замена по началу строки вставит два новых импорта перед ним. Проверить: `grep -n "ProductActionCard\|stripProductActionBlocks" src/components/chat/ChatInterface.tsx` — по одному импорту и два использования карточки.

- [ ] **Step 4: Коммит, прогон — PASS** (`src/components/chat`; плюс `npx tsc -p tsconfig.app.json --noEmit` — число ошибок не выше базовой линии, см. заметку памяти «tsc фронта — с -p», база 45)

```bash
git -C $F add src/components/chat && git -C $F commit -q -m "chat: карточки продуктов в сообщениях ассистента; флаг ui.cards"
```

---

### Task 18: Фронт — кабинет

**Files:**
- Create: `src/components/products/PendingProductActions.tsx`
- Modify: `src/pages/StudioPage.tsx`
- Modify: `src/utils/pendingDestination.ts` (`allowedDestination`)
- Test: `src/components/products/PendingProductActions.test.tsx`, `src/utils/pendingDestination.test.ts` (добавить)

- [ ] **Step 1: Тесты**

`src/components/products/PendingProductActions.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount, flush, visibleText, tRu } from '../../test/dom';
import { PendingProductActions } from './PendingProductActions';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
vi.mock('./ProductActionCard', () => ({ ProductActionCard: ({ actionId }: any) => <div data-card={actionId}>card {actionId}</div> }));
vi.mock('../../services/productActionsApi', () => ({
  productActionsApi: { pending: vi.fn(async () => [{ id: 'p1' }, { id: 'p2' }]) },
}));

describe('ожидающие подтверждения в кабинете', () => {
  it('карточка из ссылки — первой, без повтора; заголовок', async () => {
    const { container } = mount(<PendingProductActions focusId="p2" onCloseFocus={() => {}} />);
    await flush();
    expect([...container.querySelectorAll('[data-card]')].map((e) => e.getAttribute('data-card'))).toEqual(['p2', 'p1']);
    expect(visibleText(container)).toContain(tRu('products.action.pendingTitle'));
  });
});
```

В `src/utils/pendingDestination.test.ts` добавить:
```ts
it('ссылка на карточку переживает вход: action с uuid сохраняется, мусор — нет', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  expect(allowedDestination('/studio', `?tab=products&action=${id}`)).toBe(`/studio?tab=products&action=${id}`);
  expect(allowedDestination('/studio', '?tab=products&action=<script>')).toBe('/studio?tab=products');
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Реализация**

`src/components/products/PendingProductActions.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { productActionsApi } from '../../services/productActionsApi';
import { ProductActionCard } from './ProductActionCard';

/**
 * Действия, которые ждут подтверждения, на вкладке «Продукты»: запасной путь,
 * если карточка не прикрепилась к ответу, и цель ссылки из клиентов без
 * карточек. Карточка из ссылки (?action=) — первой и с кнопкой «Закрыть».
 */
export function PendingProductActions({ focusId, onCloseFocus }: { focusId: string | null; onCloseFocus: () => void }) {
  const { t } = useTranslation();
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void productActionsApi.pending().then((list) => {
      if (alive) setIds(list.map((a) => a.id));
    });
    return () => {
      alive = false;
    };
  }, [focusId]);

  const all = [...(focusId ? [focusId] : []), ...ids.filter((id) => id !== focusId)];
  if (!all.length) return null;
  return (
    <section className="mb-4">
      <h2 className="text-sm font-medium text-gray-700 mb-1">{t('products.action.pendingTitle')}</h2>
      {all.map((id) => (
        <ProductActionCard key={id} actionId={id} via="cabinet" onClose={id === focusId ? onCloseFocus : undefined} />
      ))}
    </section>
  );
}
```

`src/pages/StudioPage.tsx`:
1. Импорт `import { PendingProductActions } from '../components/products/PendingProductActions';`.
2. После вычисления `tab`:
```ts
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawAction = params.get('action');
  const actionId = rawAction && UUID_RE.test(rawAction) ? rawAction : null;
  const closeAction = () => {
    const p = new URLSearchParams(params);
    p.delete('action');
    setParams(p, { replace: true });
  };
```
3. Строку `{tab === 'products' && <ProductsSection embedded />}` →
```tsx
        {tab === 'products' && <PendingProductActions focusId={actionId} onCloseFocus={closeAction} />}
        {tab === 'products' && <ProductsSection embedded />}
```

`src/utils/pendingDestination.ts`, `allowedDestination`:
```ts
const ACTION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function allowedDestination(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  const hit = ALLOWED.find((a) => a.path === pathname && a.tab === tab);
  if (!hit) return null;
  // Карточка действия продукта: ссылка из клиента без карточек ведёт сюда, и
  // вход не должен её терять. Только uuid — остальное по-прежнему отбрасывается.
  const action = q.get('action');
  return `${hit.path}?tab=${hit.tab}` + (action && ACTION_RE.test(action) ? `&action=${action}` : '');
}
```

- [ ] **Step 4: Коммит, прогон — PASS** (`src/components/products src/utils/pendingDestination.test.ts src/pages`)

```bash
git -C $F add src && git -C $F commit -q -m "products: ожидающие подтверждения в Студии; ссылка на карточку переживает вход"
```

---

### Task 19: Фронт — мини-приложение

**Files:**
- Create: `src/tma/productAction.ts`
- Modify: `src/tma/App.tsx`
- Test: `src/tma/productAction.test.ts`

- [ ] **Step 1: Тест**

```ts
import { describe, it, expect } from 'vitest';
import { actionFromHash } from './productAction';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('карточка продукта из адреса мини-приложения', () => {
  it('#pa=<uuid> — карточка; иначе — обычные вкладки', () => {
    expect(actionFromHash(`#pa=${ID}`)).toBe(ID);
    expect(actionFromHash(`#tgWebAppData=x&pa=${ID}`)).toBe(ID);
    expect(actionFromHash('#pa=nope')).toBeNull();
    expect(actionFromHash('')).toBeNull();
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

- [ ] **Step 3: Реализация**

`src/tma/productAction.ts`:
```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Кнопка бота открывает мини-приложение адресом `/tma/#pa=<id>`: карточка
 * ключей бота показывается вместо вкладок. Telegram дописывает во фрагмент
 * свои параметры — ищем свой среди них.
 */
export function actionFromHash(hash: string): string | null {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const id = params.get('pa');
  return id && UUID_RE.test(id) ? id : null;
}
```

`src/tma/App.tsx`:
1. Импорты: `import { ProductActionCard } from '../components/products/ProductActionCard';`, `import { actionFromHash } from './productAction';`, `import { closeApp } from './telegram';`.
2. В начале `App()` после `const [tab, setTab] = …`:
```ts
  const [actionId, setActionId] = useState<string | null>(() => actionFromHash(window.location.hash));
  if (actionId) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <ProductActionCard actionId={actionId} via="tma" onClose={() => { setActionId(null); closeApp(); }} />
      </div>
    );
  }
```
Все хуки (`useTranslation`, оба `useState`) объявлены до `if`, `tabs` — обычное вычисление, не хук: ранний `return` правил хуков не нарушает.

- [ ] **Step 4: Коммит, прогон — PASS** (`src/tma`)

```bash
git -C $F add src/tma && git -C $F commit -q -m "tma: карточка ключей бота по ссылке из Telegram (#pa=<id>)"
```

---

### Task 20: Фронт — тексты на семи языках

**Files:**
- Modify: `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json` (узел `products.action`)

- [ ] **Step 1: Вставка скриптом** (JSON — правится разбором, не текстом)

```bash
cd ~/Downloads/spirits_front/.worktrees/product-lifecycle && node - <<'EOF'
const fs = require('fs');
const T = {
  ru: { loading: 'Загружаю…', notFound: 'Карточка не найдена — возможно, её открыли с другого аккаунта.', working: 'Выполняется…',
    expired: 'Срок подтверждения вышел — попросите ассистента ещё раз.', cancelled: 'Отменено.', failed: 'Не получилось: {{reason}}',
    cancel: 'Отмена', close: 'Закрыть', pendingTitle: 'Ждёт подтверждения',
    delete: { title: 'Удалить «{{name}}»?', body: 'Продукт выключится сразу. Вернуть его можно до {{date}} — попросите ассистента. Оплаченный период не возвращается.', confirm: 'Удалить', done: '«{{name}}» удалён. Вернуть можно до {{date}}.' },
    createBot: { title: 'Ключи для бота «{{name}}»', hint: 'Значения уходят прямо на сервер — ассистент и история чата их не видят.', token: 'Токен бота от @BotFather', extraTitle: 'Ключи сервисов (если нужны)', keyName: 'Имя ключа', keyValue: 'Значение', addKey: 'Добавить ключ', removeKey: 'Убрать', submit: 'Создать бота', submitting: 'Создаю…', tokenRequired: 'Вставьте токен бота', done: 'Бот «{{name}}» создан. Он заводится — через минуту-две ответит в Telegram.' },
    keys: { unsupported: 'Смена ключей появится позже.' } },
  en: { loading: 'Loading…', notFound: 'Card not found — it may have been opened from another account.', working: 'In progress…',
    expired: 'The confirmation has expired — ask the assistant again.', cancelled: 'Cancelled.', failed: "That didn't work: {{reason}}",
    cancel: 'Cancel', close: 'Close', pendingTitle: 'Waiting for your confirmation',
    delete: { title: 'Delete “{{name}}”?', body: 'It will be switched off right away. You can restore it until {{date}} — just ask the assistant. The paid period is not refunded.', confirm: 'Delete', done: '“{{name}}” has been deleted. You can restore it until {{date}}.' },
    createBot: { title: 'Keys for the bot “{{name}}”', hint: 'The values go straight to the server — neither the assistant nor the chat history can see them.', token: 'Bot token from @BotFather', extraTitle: 'Service keys (if needed)', keyName: 'Key name', keyValue: 'Value', addKey: 'Add key', removeKey: 'Remove', submit: 'Create bot', submitting: 'Creating…', tokenRequired: 'Paste the bot token', done: 'The bot “{{name}}” has been created. It is starting up and will reply in Telegram in a minute or two.' },
    keys: { unsupported: 'Changing keys is coming later.' } },
  es: { loading: 'Cargando…', notFound: 'No se encontró la tarjeta: quizá se abrió desde otra cuenta.', working: 'En curso…',
    expired: 'La confirmación ha caducado: pídeselo de nuevo al asistente.', cancelled: 'Cancelado.', failed: 'No ha funcionado: {{reason}}',
    cancel: 'Cancelar', close: 'Cerrar', pendingTitle: 'Pendiente de tu confirmación',
    delete: { title: '¿Eliminar «{{name}}»?', body: 'Se apagará de inmediato. Puedes recuperarlo hasta el {{date}}: solo pídeselo al asistente. El periodo ya pagado no se reembolsa.', confirm: 'Eliminar', done: '«{{name}}» se ha eliminado. Puedes recuperarlo hasta el {{date}}.' },
    createBot: { title: 'Claves para el bot «{{name}}»', hint: 'Los valores van directamente al servidor: ni el asistente ni el historial del chat los ven.', token: 'Token del bot de @BotFather', extraTitle: 'Claves de servicios (si hacen falta)', keyName: 'Nombre de la clave', keyValue: 'Valor', addKey: 'Añadir clave', removeKey: 'Quitar', submit: 'Crear bot', submitting: 'Creando…', tokenRequired: 'Pega el token del bot', done: 'El bot «{{name}}» se ha creado. Se está poniendo en marcha y responderá en Telegram en un par de minutos.' },
    keys: { unsupported: 'El cambio de claves llegará más adelante.' } },
  de: { loading: 'Wird geladen…', notFound: 'Karte nicht gefunden – vielleicht wurde sie von einem anderen Konto geöffnet.', working: 'Läuft…',
    expired: 'Die Bestätigung ist abgelaufen – frag den Assistenten noch einmal.', cancelled: 'Abgebrochen.', failed: 'Das hat nicht geklappt: {{reason}}',
    cancel: 'Abbrechen', close: 'Schließen', pendingTitle: 'Wartet auf deine Bestätigung',
    delete: { title: '„{{name}}“ löschen?', body: 'Das Produkt wird sofort abgeschaltet. Du kannst es bis {{date}} zurückholen – frag einfach den Assistenten. Der bezahlte Zeitraum wird nicht erstattet.', confirm: 'Löschen', done: '„{{name}}“ ist gelöscht. Zurückholen kannst du es bis {{date}}.' },
    createBot: { title: 'Schlüssel für den Bot „{{name}}“', hint: 'Die Werte gehen direkt an den Server – weder der Assistent noch der Chatverlauf sieht sie.', token: 'Bot-Token von @BotFather', extraTitle: 'Schlüssel deiner Dienste (falls nötig)', keyName: 'Name des Schlüssels', keyValue: 'Wert', addKey: 'Schlüssel hinzufügen', removeKey: 'Entfernen', submit: 'Bot anlegen', submitting: 'Wird angelegt…', tokenRequired: 'Füge das Bot-Token ein', done: 'Der Bot „{{name}}“ ist angelegt. Er startet gerade und antwortet in ein, zwei Minuten in Telegram.' },
    keys: { unsupported: 'Schlüssel ändern kommt später.' } },
  fr: { loading: 'Chargement…', notFound: 'Carte introuvable — elle a peut-être été ouverte depuis un autre compte.', working: 'En cours…',
    expired: 'La confirmation a expiré — redemandez à l’assistant.', cancelled: 'Annulé.', failed: 'Cela n’a pas marché : {{reason}}',
    cancel: 'Annuler', close: 'Fermer', pendingTitle: 'En attente de votre confirmation',
    delete: { title: 'Supprimer « {{name}} » ?', body: 'Le produit sera désactivé tout de suite. Vous pourrez le restaurer jusqu’au {{date}} — il suffit de le demander à l’assistant. La période déjà payée n’est pas remboursée.', confirm: 'Supprimer', done: '« {{name}} » a été supprimé. Vous pouvez le restaurer jusqu’au {{date}}.' },
    createBot: { title: 'Clés du bot « {{name}} »', hint: 'Les valeurs vont directement au serveur — ni l’assistant ni l’historique de la discussion ne les voient.', token: 'Jeton du bot fourni par @BotFather', extraTitle: 'Clés de vos services (si besoin)', keyName: 'Nom de la clé', keyValue: 'Valeur', addKey: 'Ajouter une clé', removeKey: 'Retirer', submit: 'Créer le bot', submitting: 'Création…', tokenRequired: 'Collez le jeton du bot', done: 'Le bot « {{name}} » a été créé. Il démarre et répondra sur Telegram d’ici une à deux minutes.' },
    keys: { unsupported: 'Le changement de clés arrivera plus tard.' } },
  pt: { loading: 'A carregar…', notFound: 'Cartão não encontrado — talvez tenha sido aberto noutra conta.', working: 'Em curso…',
    expired: 'A confirmação expirou — pede de novo ao assistente.', cancelled: 'Cancelado.', failed: 'Não resultou: {{reason}}',
    cancel: 'Cancelar', close: 'Fechar', pendingTitle: 'À espera da tua confirmação',
    delete: { title: 'Eliminar «{{name}}»?', body: 'O produto é desligado de imediato. Podes recuperá-lo até {{date}} — basta pedires ao assistente. O período já pago não é reembolsado.', confirm: 'Eliminar', done: '«{{name}}» foi eliminado. Podes recuperá-lo até {{date}}.' },
    createBot: { title: 'Chaves do bot «{{name}}»', hint: 'Os valores vão diretamente para o servidor — nem o assistente nem o histórico da conversa os veem.', token: 'Token do bot do @BotFather', extraTitle: 'Chaves dos serviços (se forem precisas)', keyName: 'Nome da chave', keyValue: 'Valor', addKey: 'Adicionar chave', removeKey: 'Remover', submit: 'Criar bot', submitting: 'A criar…', tokenRequired: 'Cola o token do bot', done: 'O bot «{{name}}» foi criado. Está a arrancar e responde no Telegram dentro de um ou dois minutos.' },
    keys: { unsupported: 'A alteração de chaves chega mais tarde.' } },
  zh: { loading: '加载中…', notFound: '未找到该卡片——可能是在其他账号中打开的。', working: '正在处理…',
    expired: '确认已过期——请再告诉助手一次。', cancelled: '已取消。', failed: '未能完成：{{reason}}',
    cancel: '取消', close: '关闭', pendingTitle: '等待您的确认',
    delete: { title: '删除「{{name}}」？', body: '产品会立即停用。在 {{date}} 之前可以恢复——告诉助手即可。已支付的期限不予退还。', confirm: '删除', done: '「{{name}}」已删除。在 {{date}} 之前可以恢复。' },
    createBot: { title: '机器人「{{name}}」的密钥', hint: '这些值直接发送到服务器——助手和聊天记录都看不到。', token: '@BotFather 提供的机器人令牌', extraTitle: '服务密钥（如需要）', keyName: '密钥名称', keyValue: '值', addKey: '添加密钥', removeKey: '移除', submit: '创建机器人', submitting: '正在创建…', tokenRequired: '请粘贴机器人令牌', done: '机器人「{{name}}」已创建，正在启动，一两分钟后会在 Telegram 中回复。' },
    keys: { unsupported: '更改密钥的功能稍后推出。' } },
};
for (const [lang, action] of Object.entries(T)) {
  const f = `src/i18n/locales/${lang}.json`;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!d.products) { console.error(`${lang}: нет узла products`); process.exit(1); }
  d.products.action = action;
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
}
console.log('ok');
EOF
git diff --stat src/i18n/locales
```
Expected: `ok`; изменения только в узле `products.action` (если `JSON.stringify` переформатировал файл целиком — значит, отступ в файлах не 2 пробела: сверить `head -3 src/i18n/locales/ru.json` и поставить нужный отступ в `JSON.stringify(d, null, N)`).

- [ ] **Step 2: Проверки** (нода): `pnpm check-locales && pnpm check-keys && pnpm check-hardcoded` и `npx vitest run src/components/products src/i18n` (там же сторож европейского pt).

- [ ] **Step 3: Коммит**

```bash
git -C $F add src/i18n && git -C $F commit -q -m "i18n: карточка действия продукта на семи языках"
```

---

### Task 21: Полная проверка

- [ ] **Step 1: Бэк** (нода, `~/ci/wt/pl-back` на последнем sha):
```bash
source ~/.nvm/nvm.sh && npx tsc -p tsconfig.build.json --noEmit && PROVISIONING_PG_URL='postgres:///pl_test?host=/var/run/postgresql' npx jest --runInBand src 2>&1 | grep -E '^Tests:|^Test Suites:|^FAIL'
npm run build >/dev/null && echo build-ok
```
Expected: tsc без ошибок; падений не больше, чем в базовой линии полного прогона (заметка «npm test бэка красный by design — мерить дельтой»); `build-ok`.

- [ ] **Step 2: Фронт** (нода, `~/ci/wt/pl-front`):
```bash
source ~/.nvm/nvm.sh && npx vitest run 2>&1 | tail -5 && pnpm check-locales && pnpm check-keys && pnpm check-hardcoded && pnpm build >/dev/null && echo build-ok
```

- [ ] **Step 3: Поломки нарочно** — каждая должна покраснеть хотя бы одним тестом (вернуть после проверки, `git checkout -- <файл>` в CI-клоне):
  1. `claim` без `AND status = 'pending'` → `product-actions.pg.spec` (одновременные нажатия);
  2. `handleCallback` без сверки `owner.tgUserId` → `tg-product-actions.service.spec`;
  3. `completeDelete` без `make_interval(days => $3)` (`now()` вместо срока) → `product-lifecycle.service.spec`;
  4. `claimJob` без `'archived'` в ветке `sleep` → `provisioning.archived.spec`;
  5. `ProductActionCard` без `ym-disable-keys` у токена → `webvisorPrivacy.test`.

- [ ] **Step 4: Ревью** — субагент `superpowers:code-reviewer` (модель sonnet) по диффу `origin/main..feat/product-lifecycle` обоих репозиториев против спеки; найденное — правками и прогоном.

---

### Task 22: Спека — отступления

**Files:** Modify: `docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md`

- [ ] Ручки — `/webhook/product-actions…`; события потока `product_action` нет (блок в тексте); состояние `working`; поправимые ошибки возвращают карточку в `pending`; удаление при `provisioning` и возврат при идущем задании — отказ. Коммит `docs(spec): отступления очереди 1`.

---

### Task 23: Слияние и выкат (только с OK владельца)

- [ ] **Step 1:** влить `feat/product-lifecycle` в `main` обоих репозиториев (`checkout --detach origin/main`, `merge --no-ff`, пуш `<sha>:refs/heads/main`, сверка merge-base; чужие коммиты в `origin/main` — прогнать задачу 21 на мерже).
- [ ] **Step 2:** с OK владельца — `deploy.sh` с ноды со свежих клонов (`SKIP_BOTS=1`, отвязанно, наблюдатель по логу). Фронт и бэк — одним выкатом: без фронта блок карточки в вебе виден кодом.
- [ ] **Step 3:** с OK владельца — релей: новая `relay-agent/server.mjs` на `r.linkeon.io` по раннбуку релея (заметка памяти «Релей r.linkeon.io»), без живых ходов.
- [ ] **Step 4: Живая проверка на проде тестовым аккаунтом** (`70000000000`, вход через debug-OTP на localhost прода; на test релейные инструменты не работают — заметка «test без BACKEND_URL»):
  1. Маше: «создай сайт „Проверка жизненного цикла“» → после «да» сайт заведён (`products`, `product_actions.kind='create_site'`);
  2. «удали его» → в ответе блок карточки; `POST /webhook/product-actions/<id> {confirm:true,via:'cabinet'}` → `archived`, задание `sleep` выполнено, в списке продуктов его нет;
  3. «верни его» → `sleeping`/`wake`, через минуту-две `running`;
  4. карточка бота с заведомо неверным токеном → карточка снова `pending` с ошибкой «Telegram не принял токен»;
  5. удалить проверочный сайт карточкой; в журнале `product_actions` — шесть строк, ни в одной нет значений ключей.
- [ ] **Step 5:** заметки памяти: продукты — что выкачено; очередь 2 — следующим планом.
