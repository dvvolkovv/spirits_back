# Реальные кейсы в автоблоге — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец заводит в автоблог реальную историю — из админки или командой `/case` в личке бота, — и редактор пересказывает её без вымысла.

**Architecture:** Реальный кейс — пост рубрики `case` с новым источником `source = 'real'`. Материал истории лежит в `topic_hint`. Редактор выбирает набор правил по паре (рубрика, источник), реальный кейс получает свой блок REAL_CASE. Валидация материала и ключ темы — чистые функции в `blog-real-case.ts`; их зовут контроллер админки и `BlogApprovalService.handleCaseCommand`, а в эту команду бот отдаёт `/case` первой строкой `handleDmCommand`. Апрув, слоты и картинки не меняются.

**Tech Stack:** NestJS 10 + TypeScript + jest (spirits_back), React 18 + vitest (spirits_front), PostgreSQL, Telegram через `TgGrammyClient`.

**Спек:** `docs/superpowers/specs/2026-10-01-blog-real-cases-design.md`

---

## Как работать с этим планом

**Репозитории и ветки.** Работа идёт в двух воркдеревьях на ветке `feat/blog-real-cases`:

- бэк — `~/Downloads/spirits_back/.worktrees/blog-real-cases` (уже создано, в нём закоммичен спек);
- фронт — `~/Downloads/spirits_front/.worktrees/blog-real-cases` (создаётся в задаче 0).

Общие чекауты `~/Downloads/spirits_back` и `~/Downloads/spirits_front` не трогать: в них работают другие сессии, а `deploy.sh` пушит их локальный `main`.

**Тесты — только на тестовой ноде** `dv@85.192.61.231`: мак не тянет jest и сборки (CLAUDE.md). Код попадает на ноду через `git push` и встаёт на sha. Отсюда цикл каждого шага с прогоном: **закоммитить → прогнать скриптом из задачи 0**. Скрипт пушит ветку и гоняет тесты на sha текущего HEAD, поэтому незакоммиченное он не видит. Красный тест тоже коммитится — ветка своя.

**Перед каждым коммитом** — `git branch --show-current` должен ответить `feat/blog-real-cases`. Добавлять файлы только поимённо (`git add <файл>`), не `-A`.

**Ловушки, на которых уже теряли время:**

- В бэке `strictNullChecks: false`, и `if (!prep.ok)` не сужает союз — `prep.reason` после такой проверки не скомпилируется (TS2339). Сужать только через `prep.ok === false`.
- jest в бэке типы не проверяет. Гейт для кода в сборке — `npx tsc --noEmit -p tsconfig.build.json`, на `main` он чистый (задача 11).
- Прогон, нашедший ноль тестов, выглядит как обычная сводка. После каждого прогона смотреть строку `Tests:`: число тестов должно быть больше нуля и сходиться с ожидаемым.
- Подпись коммита — последней строкой сообщения: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Карта файлов

**spirits_back:**

| Файл | Что | Зачем |
|---|---|---|
| `src/blog/migrations/005_real_case_source.sql` | создать | `'real'` в `blog_post_source_check` |
| `src/blog/blog.types.ts` | правка | `BlogSource` += `'real'` |
| `src/blog/blog-editor.prompt.ts` | правка | `EditorKind`, `editorKind`, блок REAL_CASE, перенос правила о реальных пользователях, материал в сообщении |
| `src/blog/blog-editor.service.ts` | правка | набор правил — по рубрике и источнику поста |
| `src/blog/blog-real-case.ts` | создать | чистые функции: проверка материала, ключ темы по хешу, история из команды |
| `src/blog/blog-topic.service.ts` | правка | `takeNextIdea`: реальный кейс сразу за новостями |
| `src/blog/blog.controller.ts` | правка | `add_topic` с `kind: 'real'` |
| `src/blog/blog-approval.service.ts` | правка | зависимость `BlogTopicService`, метод `handleCaseCommand` |
| `src/tg-bot/tg-bot.service.ts` | правка | `/case` первой строкой `handleDmCommand` |
| спеки рядом с каждым файлом | правка/создать | тесты |

**spirits_front:**

| Файл | Что | Зачем |
|---|---|---|
| `src/components/admin/blogStatus.ts` | правка | `rubricLabel`, `REAL_CASE_MAX_CHARS` |
| `src/components/admin/AdminBlogView.tsx` | правка | пункт «Реальный кейс», многострочное поле, подпись в списке |
| `src/components/admin/blogStatus.test.ts`, `AdminBlogView.test.tsx` | правка | тесты |

---

## Задача 0: Подготовка — воркдеревья, прогоны на ноде, точка отсчёта

**Files:** ничего в репозиториях; служебные скрипты в `~/.cache/blog-real-cases/`.

- [ ] **Шаг 1: Запушить ветку бэка и завести под неё воркдерево на ноде**

```bash
git -C ~/Downloads/spirits_back/.worktrees/blog-real-cases push -u origin feat/blog-real-cases
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add --detach ~/ci/wt/blog-real-cases origin/feat/blog-real-cases && cd ~/ci/wt/blog-real-cases && . ~/.nvm/nvm.sh && npm ci --no-audit --no-fund 2>&1 | tail -2'
```

Expected: `added … packages`, без `ERR!`. Бэк ставится только `npm ci`, не pnpm.

- [ ] **Шаг 2: Воркдерево фронта на маке и на ноде**

```bash
git -C ~/Downloads/spirits_front fetch -q origin
git -C ~/Downloads/spirits_front worktree add ~/Downloads/spirits_front/.worktrees/blog-real-cases -b feat/blog-real-cases origin/main
git -C ~/Downloads/spirits_front/.worktrees/blog-real-cases push -u origin feat/blog-real-cases
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add --detach ~/ci/wt/blog-real-cases-front origin/feat/blog-real-cases && cd ~/ci/wt/blog-real-cases-front && . ~/.nvm/nvm.sh && pnpm install 2>&1 | tail -2'
```

Expected: воркдеревья созданы, `pnpm install` без ошибок.

- [ ] **Шаг 3: Одноразовая база для интеграционных тестов блога**

Рецепт — из шапки `src/blog/blog-approval.integration.spec.ts`. На 01.10.2026 на ноде нет ни роли `blognotes`, ни базы `blog_notes`. База приложения стенда не затрагивается: заводится отдельная база со своей ролью.

```bash
ssh dv@85.192.61.231 'sudo -n -u postgres psql -qc "CREATE ROLE blognotes LOGIN PASSWORD '"'"'blognotes'"'"'" ; sudo -n -u postgres psql -qc "CREATE DATABASE blog_notes OWNER blognotes" ; psql "postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes" -X -At -c "select 1"'
```

Expected: последняя строка `1`. Если роль или база уже есть, `CREATE` ругнётся «already exists» — это не ошибка, важна только последняя строка.

- [ ] **Шаг 4: Скрипты прогона**

```bash
mkdir -p ~/.cache/blog-real-cases
cat > ~/.cache/blog-real-cases/ci-back.sh <<'EOF'
#!/usr/bin/env bash
# ci-back.sh <шаблон-пути-jest> [env-префикс]
# Пушит ветку бэка и гоняет jest на ноде на sha текущего HEAD воркдерева.
set -euo pipefail
WT=~/Downloads/spirits_back/.worktrees/blog-real-cases
SHA=$(git -C "$WT" rev-parse HEAD)
git -C "$WT" push -q origin feat/blog-real-cases
ssh dv@85.192.61.231 "cd ~/ci/wt/blog-real-cases && git fetch -q origin && git checkout -q $SHA && echo \"HEAD: \$(git log --oneline -1)\" && . ~/.nvm/nvm.sh && ${2:-} npx jest --testPathPattern='$1' 2>&1 | tail -45"
EOF
cat > ~/.cache/blog-real-cases/ci-front.sh <<'EOF'
#!/usr/bin/env bash
# ci-front.sh <файл-или-каталог-vitest>
# Пушит ветку фронта и гоняет vitest на ноде на sha текущего HEAD воркдерева.
set -euo pipefail
WT=~/Downloads/spirits_front/.worktrees/blog-real-cases
SHA=$(git -C "$WT" rev-parse HEAD)
git -C "$WT" push -q origin feat/blog-real-cases
ssh dv@85.192.61.231 "cd ~/ci/wt/blog-real-cases-front && git fetch -q origin && git checkout -q $SHA && echo \"HEAD: \$(git log --oneline -1)\" && . ~/.nvm/nvm.sh && npx vitest run $1 2>&1 | tail -45"
EOF
chmod +x ~/.cache/blog-real-cases/*.sh
```

- [ ] **Шаг 5: Точка отсчёта — записать, что красное до нас**

```bash
~/.cache/blog-real-cases/ci-back.sh 'src/(blog|tg-bot)' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
ssh dv@85.192.61.231 'cd ~/ci/wt/blog-real-cases && . ~/.nvm/nvm.sh && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tail -5; echo "tsc exit: $?"'
~/.cache/blog-real-cases/ci-front.sh src/components/admin
ssh dv@85.192.61.231 'cd ~/ci/wt/blog-real-cases-front && . ~/.nvm/nvm.sh && npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c "error TS"'
```

Записать в заметки сессии: число пройденных и упавших тестов в каждом прогоне, вывод `tsc` бэка (ожидается пусто) и число ошибок `tsc` фронта (на `main` их около 45). Дальше всё меряется дельтой от этих чисел.

---

## Задача 1: Миграция 005 и источник `'real'`

**Files:**
- Create: `src/blog/migrations/005_real_case_source.sql`
- Modify: `src/blog/blog.types.ts:2`
- Test: `src/blog/blog-approval.integration.spec.ts` (новый блок в конце файла)

- [ ] **Шаг 1: Падающий тест — живой Postgres принимает `real`**

Дописать в конец `src/blog/blog-approval.integration.spec.ts`. Все блоки живут в одном файле намеренно: jest гоняет файлы параллельно, и второй файл на той же базе стирал бы строки этого.

```ts
/**
 * Реальный кейс (005_real_case_source.sql): история владельца — это пост
 * рубрики case с источником real. Проверка источника в базе — CHECK, и
 * заглушка его не воспроизведёт.
 */
maybe('Реальный кейс против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  let ours = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    await prepareDisposableDb(pool);
    ours = true;
  });

  afterAll(async () => {
    if (ours) await pool.query('TRUNCATE blog_post');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE blog_post');
  });

  it('пост с источником real база принимает', async () => {
    await pool.query(
      `INSERT INTO blog_post (rubric, source, topic_key, topic_hint)
       VALUES ('case', 'real', 'реальный-кейс-0123456789ab', 'история')`,
    );
    const r = await pool.query(`SELECT count(*)::int AS n FROM blog_post WHERE source = 'real'`);
    expect(r.rows[0].n).toBe(1);
  });

  it('неизвестный источник база по-прежнему не пускает', async () => {
    await expect(pool.query(
      `INSERT INTO blog_post (rubric, source, topic_key) VALUES ('case', 'bogus', 'k')`,
    )).rejects.toThrow(/blog_post_source_check/);
  });

  // prepareDisposableDb катит все миграции в каждом блоке файла заново —
  // повторный прогон для неё штатный путь, а не краевой случай.
  it('миграция переживает повторный прогон', async () => {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', '005_real_case_source.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });
});
```

- [ ] **Шаг 2: Закоммитить и убедиться, что тест красный**

```bash
cd ~/Downloads/spirits_back/.worktrees/blog-real-cases
git branch --show-current
git add src/blog/blog-approval.integration.spec.ts
git commit -q -m "test(blog): реальный кейс — источник real в живом Postgres (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-approval.integration' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: FAIL. «пост с источником real» падает на `violates check constraint "blog_post_source_check"`, тест повторного прогона — на ENOENT (файла ещё нет). Если блок оказался в `skipped`, значит не доехал `BLOG_PG_URL` — чинить прогон, а не тест.

- [ ] **Шаг 3: Миграция и тип**

Создать `src/blog/migrations/005_real_case_source.sql`:

```sql
-- 005_real_case_source.sql
-- Реальный кейс — новый источник темы: историю приносит владелец, и редактор
-- пересказывает её без вымысла (блок REAL_CASE в blog-editor.prompt.ts).
--
-- Рубрика остаётся 'case', поэтому вся логика рубрик — новость вытесняет кейс,
-- протухают только новости, подписи — работает для реального кейса без
-- изменений. Меняется только набор допустимых источников.
--
-- Миграция лишь расширяет допустимое, старый код с ней совместим — поэтому
-- катится раньше кода. BEGIN/COMMIT здесь нет намеренно: раннер катит каждый
-- файл в своей транзакции, а руками — `psql --single-transaction`. Иначе между
-- DROP и ADD таблица на миг осталась бы вовсе без проверки источника.
--
-- Повторный прогон безопасен: DROP ... IF EXISTS снимает ограничение, ADD
-- ставит его заново.

ALTER TABLE blog_post DROP CONSTRAINT IF EXISTS blog_post_source_check;
ALTER TABLE blog_post ADD CONSTRAINT blog_post_source_check
  CHECK (source IN ('backlog','git','stats','manual','real'));
```

В `src/blog/blog.types.ts` заменить строку 2:

```ts
export type BlogSource = 'backlog' | 'git' | 'stats' | 'manual';
```

на:

```ts
/** `real` — реальный кейс: историю принёс владелец, редактор её только пересказывает. */
export type BlogSource = 'backlog' | 'git' | 'stats' | 'manual' | 'real';
```

- [ ] **Шаг 4: Закоммитить и убедиться, что тест зелёный**

```bash
git add src/blog/migrations/005_real_case_source.sql src/blog/blog.types.ts
git commit -q -m "feat(blog): источник real — реальный кейс (миграция 005)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-approval.integration' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: PASS, весь файл зелёный, `skipped` нет.

---

## Задача 2: Правила редактора для реального кейса

**Files:**
- Modify: `src/blog/blog-editor.prompt.ts`
- Test: `src/blog/blog-editor.service.spec.ts`

- [ ] **Шаг 1: Падающие тесты**

В `src/blog/blog-editor.service.spec.ts` заменить строку 2:

```ts
import { buildEditorMessage, buildEditorPrompt } from './blog-editor.prompt';
```

на:

```ts
import { buildEditorMessage, buildEditorPrompt, editorKind } from './blog-editor.prompt';
```

В блоке `describe('ответ редактора — всегда JSON'` заменить:

```ts
  it.each(['news', 'case'] as const)('%s: всегда JSON, без встречных вопросов; мало данных — короче', (rubric) => {
```

на:

```ts
  it.each(['news', 'case', 'real'] as const)('%s: всегда JSON, без встречных вопросов; мало данных — короче', (rubric) => {
```

Сразу перед `describe('BlogEditorService', () => {` вставить:

```ts
/**
 * Реальный кейс — правда, а не выдумка: владелец приносит историю, и редактор
 * обязан её пересказать, а не сочинить новую. Прежний промпт знал только
 * выдумку, и реальная история владельца превратилась бы в очередную «Лену».
 */
describe('промпт реального кейса', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const REAL = () => flat(buildEditorPrompt('real', ['Как мы рисовали логотип']));

  it('отличается от промптов новости и выдуманного кейса', () => {
    expect(buildEditorPrompt('real', [])).not.toBe(buildEditorPrompt('case', []));
    expect(buildEditorPrompt('real', [])).not.toBe(buildEditorPrompt('news', []));
  });

  it('не велит выдумывать и запрещает помечать историю придуманной', () => {
    const p = REAL();
    expect(p).not.toMatch(/вымышлен/i);
    expect(p).not.toMatch(/придумай/i);
    expect(p).toMatch(/не пиши, что история придумана/i);
  });

  it('пишет только по материалу и не додумывает', () => {
    const p = REAL();
    expect(p).toMatch(/только то, что есть в материале/i);
    expect(p).toMatch(/не добавляй деталей, чисел, сроков/i);
  });

  it('герой и рассказчик — как в материале, и уже из первого абзаца видно, чья это история', () => {
    const p = REAL();
    expect(p).toMatch(/ровно как в материале/i);
    expect(p).toMatch(/из первого абзаца/i);
  });

  it('строит пост вокруг сути, если она названа', () => {
    expect(REAL()).toMatch(/суть/i);
  });

  it('не переносит персональные данные и не называет чужие организации', () => {
    const p = REAL();
    expect(p).toMatch(/ИНН/);
    expect(p).toMatch(/даже если они есть в материале/i);
    expect(p).toMatch(/не называй/i);
  });

  it('не обобщает до обещания', () => {
    expect(REAL()).toMatch(/не обобщай до обещания/i);
  });

  it('статистику и популярность запрещает, как и выдуманный кейс', () => {
    expect(REAL()).toMatch(/никогда не упоминай статистику/i);
  });
});

/**
 * Правило «не ссылайся на реальных пользователей» жило в общем блоке — то есть
 * и в промпте реального кейса, где оно спорило бы с самой задачей.
 */
describe('правило про реальных пользователей', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it.each(['news', 'case'] as const)('%s: по-прежнему запрещает ссылаться на реальных пользователей', (kind) => {
    expect(flat(buildEditorPrompt(kind, []))).toMatch(/не ссылайся на реальных пользователей/i);
  });

  it('real: такого запрета нет — история и есть реальная', () => {
    expect(flat(buildEditorPrompt('real', []))).not.toMatch(/не ссылайся на реальных пользователей/i);
  });

  it.each(['news', 'case', 'real'] as const)('%s: выдуманное за реальное не выдавать', (kind) => {
    expect(flat(buildEditorPrompt(kind, []))).toMatch(/не выдавай выдуманное за реальное/i);
  });
});

describe('editorKind', () => {
  it('новость — новость, откуда бы она ни пришла', () => {
    expect(editorKind('news', 'git')).toBe('news');
    expect(editorKind('news', 'manual')).toBe('news');
  });

  it('кейс с источником real — реальный кейс', () => {
    expect(editorKind('case', 'real')).toBe('real');
  });

  it('прочие кейсы — выдуманные, как и раньше', () => {
    expect(editorKind('case', 'stats')).toBe('case');
    expect(editorKind('case', 'manual')).toBe('case');
  });
});

describe('buildEditorMessage для реального кейса', () => {
  const STORY = 'Рассказчик — Дмитрий, основатель Linkeon. Роман разобрал полис КАСКО.';
  const KEY = 'реальный-кейс-0123456789ab';

  it('материал подан как материал, а не как подсказка', () => {
    const m = buildEditorMessage(KEY, STORY, [], 'real');
    expect(m).toContain('Материал реального кейса');
    expect(m).toContain(STORY);
    expect(m).not.toMatch(/Подсказка от источника/);
  });

  it('хеш-ключ темы редактору не показывается — он ни о чём не говорит', () => {
    expect(buildEditorMessage(KEY, STORY, [], 'real')).not.toContain('0123456789ab');
  });

  it('замечания владельца доезжают и до реального кейса', () => {
    const m = buildEditorMessage(KEY, STORY, ['короче'], 'real');
    expect(m).toContain('короче');
    expect(m.replace(/\s+/g, ' ')).toMatch(/главного редактора/i);
  });

  it('без kind — прежнее поведение', () => {
    expect(buildEditorMessage('аренда', 'про аренду', [])).toContain('Подсказка от источника: про аренду');
  });
});

```

- [ ] **Шаг 2: Закоммитить и убедиться, что тесты красные**

```bash
git add src/blog/blog-editor.service.spec.ts
git commit -q -m "test(blog): правила редактора для реального кейса (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-editor.service'
```

Expected: FAIL — `editorKind is not a function`, промпт `'real'` совпадает с промптом кейса, нет «Материал реального кейса».

- [ ] **Шаг 3: Реализация в `src/blog/blog-editor.prompt.ts`**

3a. Заменить строку 1:

```ts
import { BlogRubric } from './blog.types';
```

на:

```ts
import { BlogRubric, BlogSource } from './blog.types';
```

3b. В `COMMON` заменить строку:

```
- Не ссылайся на реальных пользователей и не выдавай выдуманное за реальный отзыв.
```

на:

```
- Не выдавай выдуманное за реальное: ни придуманную историю за случай из жизни, ни придуманную фразу за отзыв.
```

3c. Заменить блок `NEWS` целиком:

```ts
const NEWS = `
Рубрика: НОВИНКА. Тебе дают описание того, что мы выпустили.
Расскажи, что изменилось и зачем это человеку, а не какой код мы написали.
Начни с пользы, а не с названия фичи.
Не ссылайся на реальных пользователей.
`.trim();
```

3d. В блоке `CASE` заменить две строки:

```
История вымышленная и должна читаться как типичная ситуация, а не как
свидетельство конкретного человека. Не приписывай продукту результатов,
которых он не даёт.
```

на:

```
История вымышленная и должна читаться как типичная ситуация, а не как
свидетельство конкретного человека. Не ссылайся на реальных пользователей.
Не приписывай продукту результатов, которых он не даёт.
```

3e. Сразу после блока `CASE` (после его `.trim();`) вставить:

```ts

/**
 * Реальный кейс: историю принёс её герой (см. blog-real-case.ts), и редактор
 * её только пересказывает. Правило «не ссылайся на реальных пользователей»
 * здесь нет намеренно — история и есть реальная, а два противоречащих правила
 * в одном промпте модель разрешила бы как придётся.
 *
 * Названия организаций и персональные данные запрещены даже тогда, когда они
 * есть в материале: материал пишется для редактора, а пост — для всех.
 */
const REAL_CASE = `
Рубрика: РЕАЛЬНЫЙ КЕЙС. Тебе дают материал — реальную историю, которую
рассказал её герой. Это всё, что ты о ней знаешь.
Пиши только то, что есть в материале. Не добавляй деталей, чисел, сроков,
диалогов, цитат и чувств героя, которых в нём нет. Не меняй порядок событий и
не дописывай финал: история кончается там, где кончается материал.
Рассказчик и герой — ровно как в материале: имя, роль, от какого лица
рассказывать. Уже из первого абзаца читатель должен понять, что история
реальная и чья она.
Если в материале названа суть истории — строй пост вокруг неё.
Организации называй общими словами («налоговая», «банк», «страховая»): по
названию не называй никого, кроме Linkeon и ассистента. Людей, кроме героя и
ассистента, тоже не называй. Персональные данные — ИНН, номера документов,
решений и полисов, адреса, телефоны — в пост не переноси, даже если они есть в
материале.
Ассистенту приписывай только то, что он сделал в этой истории, и не обобщай до
обещания («Роман разблокирует любые счета»).
Не пиши, что история придумана: она настоящая.
Никогда не упоминай статистику и популярность: ни «чаще всего писали», ни
«самый популярный ассистент», ни числа обращений или пользователей.
`.trim();

/** Какой набор правил получает редактор. */
export type EditorKind = 'news' | 'case' | 'real';

const RUBRIC_BLOCKS: Record<EditorKind, string> = { news: NEWS, case: CASE, real: REAL_CASE };

/**
 * Рубрика решает «новость или кейс», источник — «выдумка или правда»:
 * реальный кейс остаётся кейсом во всём, кроме пересказа.
 */
export function editorKind(rubric: BlogRubric, source: BlogSource): EditorKind {
  if (rubric === 'news') return 'news';
  return source === 'real' ? 'real' : 'case';
}
```

3f. Заменить функцию `buildEditorPrompt` целиком:

```ts
export function buildEditorPrompt(kind: EditorKind, recentTitles: string[]): string {
  // Незнакомый kind — выдуманный кейс, как было до появления реального:
  // `undefined` в тексте промпта хуже любого из трёх блоков.
  const rubricBlock = RUBRIC_BLOCKS[kind] ?? CASE;
  return `${COMMON}\n\n${rubricBlock}\n\n${readerContext(recentTitles)}`;
}
```

3g. Заменить функцию `buildEditorMessage` целиком (комментарий над ней оставить):

```ts
export function buildEditorMessage(
  topicKey: string,
  topicHint: string | null,
  editorNotes: string[],
  kind: EditorKind = 'case',
): string {
  const parts = [topicLine(topicKey, topicHint, kind)];

  const notes = Array.isArray(editorNotes) ? editorNotes : [];
  if (notes.length) {
    parts.push(
      `ПРАВКА ГЛАВНОГО РЕДАКТОРА. Прошлый вариант этого поста забракован, ниже — что\n` +
      `именно в нём не так. Это не пожелания, а требования: пост не выйдет, пока каждое\n` +
      `из них не выполнено. Напиши текст заново с нуля, а не подправь прошлый — и не\n` +
      `упоминай в посте сам факт правки. Замечания, от самого раннего к самому свежему:\n` +
      notes.map((n, i) => `${i + 1}. ${n}`).join('\n'),
    );
  }

  return parts.join('\n\n');
}

/**
 * Реальный кейс подаётся как материал, а не как подсказка: подсказку редактор
 * вправе развить, а материал — только пересказать. Ключ темы у реального кейса
 * — хеш, редактору он ни о чём не говорит, поэтому в сообщение не идёт.
 */
function topicLine(topicKey: string, topicHint: string | null, kind: EditorKind): string {
  if (kind === 'real' && topicHint) {
    return `Материал реального кейса — это всё, что ты о нём знаешь:\n\n${topicHint}`;
  }
  return topicHint ? `Тема: ${topicKey}\n\nПодсказка от источника: ${topicHint}` : `Тема: ${topicKey}`;
}
```

- [ ] **Шаг 4: Закоммитить и убедиться, что тесты зелёные**

```bash
git add src/blog/blog-editor.prompt.ts
git commit -q -m "feat(blog): правила редактора для реального кейса

Блок REAL_CASE: пересказ только по материалу, без вымысла, без персональных
данных и названий организаций. Правило «не ссылайся на реальных
пользователей» переехало из общего блока в новости и выдуманные кейсы — иначе
оно спорило бы с реальным кейсом в одном промпте.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-editor.service'
```

Expected: PASS, весь файл, включая старые тесты кейса и контекста читателя.

---

## Задача 3: Редактор берёт правила по источнику поста

**Files:**
- Modify: `src/blog/blog-editor.service.ts`
- Test: `src/blog/blog-editor.service.spec.ts`, `src/blog/blog.cron.spec.ts`

> По ходу исполнения (ревью) задача выросла: к двум сервисным тестам добавлены тест «новость по-прежнему пишется по правилам новости» (мутация `editorKind('case', post.source)` иначе выживала) и сквозной тест крона «реальный кейс без материала — failed с причиной, до релея дело не доходит». В красном прогоне — два упавших: реальный кейс в сервисе и тест крона.

- [ ] **Шаг 1: Падающие тесты**

В `describe('BlogEditorService'` после теста «пост без замечаний уходит редактору без блока правок» добавить:

```ts
  it('реальный кейс уходит редактору с правилами реального кейса и материалом', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({
      ...POST, source: 'real', topicKey: 'реальный-кейс-0123456789ab',
      topicHint: 'Рассказчик — Дмитрий, основатель Linkeon.', editorNotes: [],
    });

    const [systemPrompt, message] = relay.ask.mock.calls[0];
    expect(String(systemPrompt)).toMatch(/РЕАЛЬНЫЙ КЕЙС/);
    expect(String(message)).toContain('Материал реального кейса');
  });

  it('кейс из статистики по-прежнему пишется выдумкой', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);

    await svc.draft({ ...POST, source: 'stats', editorNotes: [] });

    const systemPrompt = String(relay.ask.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(systemPrompt).not.toMatch(/РЕАЛЬНЫЙ КЕЙС/);
    expect(systemPrompt).toMatch(/История вымышленная/);
  });
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
git add src/blog/blog-editor.service.spec.ts
git commit -q -m "test(blog): редактор выбирает правила по источнику поста (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-editor.service'
```

Expected: FAIL только у «реальный кейс уходит редактору…»: сервис пока зовёт `buildEditorPrompt(post.rubric, …)`.

- [ ] **Шаг 3: Реализация**

В `src/blog/blog-editor.service.ts` заменить импорт:

```ts
import { buildEditorMessage, buildEditorPrompt } from './blog-editor.prompt';
```

на:

```ts
import { buildEditorMessage, buildEditorPrompt, editorKind } from './blog-editor.prompt';
```

и тело `draft` целиком:

```ts
  async draft(post: BlogPost): Promise<EditorDraft> {
    const recent = await this.topics.recentTitles(20);
    // Набор правил решают рубрика и источник: реальный кейс — тоже кейс, но
    // пересказывается без вымысла (блок REAL_CASE).
    const kind = editorKind(post.rubric, post.source);
    const systemPrompt = buildEditorPrompt(kind, recent);

    // Замечания владельца идут в СООБЩЕНИЕ, а не в системный промпт: это
    // правка конкретно к этому посту, а не правило канала. Сессия у каждого
    // поста своя и одноразовая, так что помнить прошлую итерацию релею нечем
    // — замечания обязаны приезжать заново каждый раз.
    const message = buildEditorMessage(post.topicKey, post.topicHint, post.editorNotes, kind);

    // Сессия привязана к id поста: изолированная и одноразовая.
    const raw = await this.relay.ask(systemPrompt, message, `blog-${post.id}`);
    return parseEditorReply(raw);
  }
```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный**

```bash
git add src/blog/blog-editor.service.ts
git commit -q -m "feat(blog): редактор берёт правила по рубрике и источнику поста

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-editor.service'
```

Expected: PASS.

---

## Задача 4: Материал реального кейса — чистые функции

**Files:**
- Create: `src/blog/blog-real-case.ts`
- Test: `src/blog/blog-real-case.spec.ts`

- [ ] **Шаг 1: Падающий тест**

Создать `src/blog/blog-real-case.spec.ts`:

```ts
import {
  REAL_CASE_MAX_CHARS, REAL_CASE_MIN_CHARS,
  caseCommandStory, prepareRealCase, realCaseTopicKey,
} from './blog-real-case';
import { normalizeTopicKey } from './blog-topic.service';

const STORY = 'Рассказчик — Дмитрий, основатель Linkeon. Роман прочитал полис КАСКО и нашёл франшизу на замену стекла.';

describe('prepareRealCase', () => {
  it('годный материал — реальный кейс: рубрика case, источник real, материал целиком в подсказке', () => {
    expect(prepareRealCase(`  ${STORY}\n`)).toEqual({
      ok: true,
      topic: { rubric: 'case', source: 'real', topicKey: realCaseTopicKey(STORY), topicHint: STORY },
    });
  });

  it('пусто и тема одной строкой — отказ с объяснением, что нужно', () => {
    for (const raw of ['', '   ', undefined, null, 'кейс про налоговую']) {
      const prep = prepareRealCase(raw);
      expect(prep.ok).toBe(false);
      if (prep.ok === false) {
        expect(prep.reason).toContain(String(REAL_CASE_MIN_CHARS));
        expect(prep.reason).toMatch(/что сделал ассистент/);
      }
    }
  });

  it('нижняя граница: 40 знаков годятся, 39 — нет', () => {
    expect(prepareRealCase('а'.repeat(REAL_CASE_MIN_CHARS)).ok).toBe(true);
    expect(prepareRealCase('а'.repeat(REAL_CASE_MIN_CHARS - 1)).ok).toBe(false);
  });

  it('длиннее 4000 знаков — отказ, а не обрезка', () => {
    const prep = prepareRealCase('а'.repeat(REAL_CASE_MAX_CHARS + 1));
    expect(prep.ok).toBe(false);
    if (prep.ok === false) {
      expect(prep.reason).toContain(String(REAL_CASE_MAX_CHARS));
      expect(prep.reason).toMatch(/не буду/);
    }
    expect(prepareRealCase('а'.repeat(REAL_CASE_MAX_CHARS)).ok).toBe(true);
  });

  // `.length` считает эмодзи за два знака — и отказал бы истории ровно на пределе.
  it('знаки считаются символами, а не UTF-16', () => {
    const atLimit = 'а'.repeat(REAL_CASE_MAX_CHARS - 1) + '😀';
    expect(atLimit.length).toBe(REAL_CASE_MAX_CHARS + 1);
    expect(prepareRealCase(atLimit).ok).toBe(true);
  });
});

describe('realCaseTopicKey', () => {
  it('тот же текст — тот же ключ: повтор отсечёт дедупликация', () => {
    expect(realCaseTopicKey(STORY)).toBe(realCaseTopicKey(STORY));
  });

  // Материалы владельца начинаются одинаково — ключ по началу склеил бы разные истории.
  it('разные истории с одинаковым началом — разные ключи', () => {
    expect(realCaseTopicKey(`${STORY} Отказался от полиса.`))
      .not.toBe(realCaseTopicKey(`${STORY} Страховая вписала условие.`));
  });

  it('ключ переживает нормализацию addTopic без изменений', () => {
    const key = realCaseTopicKey(STORY);
    expect(key).toMatch(/^реальный-кейс-[0-9a-f]{12}$/);
    expect(normalizeTopicKey(key)).toBe(key);
  });
});

describe('caseCommandStory', () => {
  it('история — всё после команды; регистр и переносы строк сохранены', () => {
    expect(caseCommandStory('/case Дмитрий, основатель Linkeon.\nРоман прочитал полис.'))
      .toBe('Дмитрий, основатель Linkeon.\nРоман прочитал полис.');
  });

  it('история может начинаться со следующей строки', () => {
    expect(caseCommandStory('/case\nДмитрий рассказывает')).toBe('Дмитрий рассказывает');
  });

  it('команда с именем бота', () => {
    expect(caseCommandStory('/case@LinkeonAgentBot История')).toBe('История');
  });

  it('команда без истории — пустая строка, а не null: команда наша, просто пустая', () => {
    expect(caseCommandStory('/case')).toBe('');
    expect(caseCommandStory('/case   ')).toBe('');
  });

  it('другие команды и обычный текст — не наши', () => {
    expect(caseCommandStory('/cases история')).toBeNull();
    expect(caseCommandStory('/help')).toBeNull();
    expect(caseCommandStory('расскажи /case')).toBeNull();
    expect(caseCommandStory(undefined)).toBeNull();
  });
});
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
git add src/blog/blog-real-case.spec.ts
git commit -q -m "test(blog): материал реального кейса — проверка, ключ, команда (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-real-case'
```

Expected: FAIL — `Cannot find module './blog-real-case'`.

- [ ] **Шаг 3: Реализация**

Создать `src/blog/blog-real-case.ts`:

```ts
import { createHash } from 'crypto';
import type { AddTopicInput } from './blog-topic.service';

/**
 * Реальный кейс: историю приносит владелец — из админки или командой `/case`
 * в личке бота, — и редактор пересказывает её без вымысла (REAL_CASE в
 * blog-editor.prompt.ts).
 *
 * Здесь всё, что о заведении такого кейса можно сказать без базы и без
 * Telegram: годится ли материал, какой у темы ключ, где в команде история.
 * Админка и бот зовут одно и то же, поэтому и отказы у них одинаковые.
 */

/**
 * Меньше — уже не история, а тема одной строкой («кейс про налоговую»).
 * Реальный кейс редактор пересказывает только по материалу, и из одной
 * строки вышел бы пост из одной строки — или додуманный, что хуже.
 */
export const REAL_CASE_MIN_CHARS = 40;

/**
 * Больше — уже не материал на пост в 900 знаков, а стенограмма. Предел к тому
 * же ниже потолка сообщения Telegram (4096), так что история, присланная
 * командой, в него помещается целиком.
 */
export const REAL_CASE_MAX_CHARS = 4000;

/** Отказ на повтор той же истории — один на админку и бота. */
export const REAL_CASE_DUPLICATE = 'такую историю уже заводили за последние 90 дней';

export type RealCasePrep =
  | { ok: true; topic: AddTopicInput }
  | { ok: false; reason: string };

/**
 * Материал → тема для `addTopic` или причина отказа.
 *
 * Длинный материал отклоняется, а не обрезается: обрезка срезала бы конец
 * истории, то есть чаще всего финал — ради него кейс и пишется.
 *
 * Знаки считаются символами, а не UTF-16 (как в `hasClearProfile`): эмодзи —
 * один знак, а не два.
 */
export function prepareRealCase(raw: unknown): RealCasePrep {
  const story = String(raw ?? '').trim();
  const chars = Array.from(story).length;
  if (chars < REAL_CASE_MIN_CHARS) {
    return {
      ok: false,
      reason: `история слишком короткая: нужно хотя бы ${REAL_CASE_MIN_CHARS} знаков — ` +
        'кто рассказывает, что случилось, что сделал ассистент, чем кончилось',
    };
  }
  if (chars > REAL_CASE_MAX_CHARS) {
    return {
      ok: false,
      reason: `история длиннее ${REAL_CASE_MAX_CHARS} знаков (сейчас ${chars}) — сократите её: ` +
        'обрезать сам не буду, иначе пропадёт финал',
    };
  }
  return {
    ok: true,
    topic: { rubric: 'case', source: 'real', topicKey: realCaseTopicKey(story), topicHint: story },
  };
}

/**
 * Ключ темы — по хешу всего материала, а не по первым словам.
 *
 * Материалы владельца начинаются одинаково («Рассказчик — Дмитрий, основатель
 * Linkeon…»), и ключ по началу объявил бы вторую историю дублем первой. Хеш
 * совпадает ровно у того же текста — это двойное нажатие или повтор команды,
 * их и должна отсечь дедупликация `addTopic`.
 *
 * `normalizeTopicKey` ключ не меняет: в нём только буквы, цифры и дефисы.
 */
export function realCaseTopicKey(story: string): string {
  return `реальный-кейс-${createHash('sha1').update(story).digest('hex').slice(0, 12)}`;
}

/**
 * История из команды `/case <история>` (или `/case@<бот> <история>`).
 *
 * Берётся из исходного текста сообщения: общий разбор команд бота переводит
 * текст в нижний регистр и режет его по пробелу — история приехала бы
 * строчными буквами и одним словом. Переносы строк сохраняются.
 *
 * @returns текст после команды (пустая строка, если его нет) или null, если
 *          сообщение — не эта команда
 */
export function caseCommandStory(text: unknown): string | null {
  const m = String(text ?? '').match(/^\/case(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  return m ? (m[1] ?? '').trim() : null;
}
```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный**

```bash
git add src/blog/blog-real-case.ts
git commit -q -m "feat(blog): материал реального кейса — проверка, ключ по хешу, история из /case

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog-real-case'
```

Expected: PASS, 13 тестов.

---

## Задача 5: Реальный кейс берётся в работу сразу за новостями

**Files:**
- Modify: `src/blog/blog-topic.service.ts` (метод `takeNextIdea` и комментарий над ним)
- Test: `src/blog/blog-topic.service.spec.ts`, `src/blog/blog-approval.integration.spec.ts`

- [ ] **Шаг 1: Падающие тесты**

В `src/blog/blog-topic.service.spec.ts`, в `describe('BlogTopicService.takeNextIdea'`, сразу после теста «новость по-прежнему вытесняет кейс» добавить:

```ts
  it('реальный кейс идёт сразу после новостей — раньше синтетических кейсов', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain("ORDER BY (rubric = 'news') DESC, (source = 'real') DESC, created_at ASC");
  });
```

В `src/blog/blog-approval.integration.spec.ts`, внутри блока `maybe('Реальный кейс против живого Postgres'` из задачи 1, после теста «миграция переживает повторный прогон» добавить:

```ts
  // Порядок — дело ORDER BY в живой базе: заглушка вернула бы что подложили.
  it('очередь тем: новость, потом реальный кейс, потом синтетический — даже более старый', async () => {
    const add = (rubric: string, source: string, key: string, minutesAgo: number) => pool.query(
      `INSERT INTO blog_post (rubric, source, topic_key, created_at)
       VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
      [rubric, source, key, minutesAgo],
    );
    await add('case', 'stats', 'синтетика', 30);
    await add('case', 'real', 'реальный', 20);
    await add('news', 'git', 'новость', 10);

    const topics = new BlogTopicService({ query: (sql: string, params?: any[]) => pool.query(sql, params) } as any);

    expect((await topics.takeNextIdea())?.topicKey).toBe('новость');
    await pool.query(`DELETE FROM blog_post WHERE topic_key = 'новость'`);
    expect((await topics.takeNextIdea())?.topicKey).toBe('реальный');
    await pool.query(`DELETE FROM blog_post WHERE topic_key = 'реальный'`);
    expect((await topics.takeNextIdea())?.topicKey).toBe('синтетика');
  });
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
git add src/blog/blog-topic.service.spec.ts src/blog/blog-approval.integration.spec.ts
git commit -q -m "test(blog): реальный кейс в очереди тем сразу за новостями (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/(blog-topic.service|blog-approval.integration)' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: FAIL у обоих новых тестов. Интеграционный падает на втором шаге: после новости приходит `синтетика`, она старше.

- [ ] **Шаг 3: Реализация**

В `src/blog/blog-topic.service.ts`, в методе `takeNextIdea`, заменить строку:

```sql
        ORDER BY (rubric = 'news') DESC, created_at ASC
```

на:

```sql
        ORDER BY (rubric = 'news') DESC, (source = 'real') DESC, created_at ASC
```

В комментарии над `takeNextIdea` заменить первые две строки:

```ts
   * Следующая тема в работу. Новость всегда вытесняет кейс — новости
   * скоропортящиеся, кейс полежит.
```

на:

```ts
   * Следующая тема в работу. Новость всегда вытесняет кейс — новости
   * скоропортящиеся, кейс полежит. Реальный кейс идёт сразу за новостями:
   * историю владелец принёс сам, и ждать за неделей синтетических кейсов ей
   * незачем.
```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный**

```bash
git add src/blog/blog-topic.service.ts
git commit -q -m "feat(blog): реальный кейс берётся в работу сразу за новостями

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/(blog-topic.service|blog-approval.integration)' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: PASS, `skipped` нет.

---

## Задача 6: Админка — `add_topic` с `kind: 'real'`

**Files:**
- Modify: `src/blog/blog.controller.ts` (импорты; `case 'add_topic'`)
- Test: `src/blog/blog.controller.spec.ts`

- [ ] **Шаг 1: Падающие тесты**

В `src/blog/blog.controller.spec.ts`, в `describe('BlogController'`, после теста «add_topic с пустой темой — 400…» добавить:

```ts
  describe('add_topic: реальный кейс', () => {
    const STORY = 'Рассказчик — Дмитрий, основатель Linkeon. Роман прочитал полис КАСКО целиком.';

    it('заводит тему источника real: материал целиком, ключ по хешу', async () => {
      const d = deps(); const r = res();
      await make(d).action({ action: 'add_topic', kind: 'real', topic: `  ${STORY}  ` }, r);
      expect(d.topics.addTopic).toHaveBeenCalledWith({
        rubric: 'case', source: 'real', topicHint: STORY,
        topicKey: expect.stringMatching(/^реальный-кейс-[0-9a-f]{12}$/),
      });
      expect(r.status).toHaveBeenCalledWith(200);
    });

    it('рубрику из запроса не слушает: реальный кейс всегда кейс', async () => {
      const d = deps(); const r = res();
      await make(d).action({ action: 'add_topic', kind: 'real', rubric: 'news', topic: STORY }, r);
      expect(d.topics.addTopic).toHaveBeenCalledWith(expect.objectContaining({ rubric: 'case', source: 'real' }));
    });

    it('короткая история — 400 с объяснением, тема не заводится', async () => {
      const d = deps(); const r = res();
      await expect(make(d).action({ action: 'add_topic', kind: 'real', topic: 'кейс про налоговую' }, r))
        .rejects.toThrow(/хотя бы 40 знаков/);
      expect(d.topics.addTopic).not.toHaveBeenCalled();
    });

    it('повтор той же истории — 200 со skipped, как у обычной темы', async () => {
      const d = deps(); const r = res();
      d.topics.addTopic.mockResolvedValueOnce(null);
      await make(d).action({ action: 'add_topic', kind: 'real', topic: STORY }, r);
      expect(r.json).toHaveBeenCalledWith({ skipped: 'такую историю уже заводили за последние 90 дней' });
    });
  });
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
git add src/blog/blog.controller.spec.ts
git commit -q -m "test(blog): add_topic с kind real (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog.controller'
```

Expected: FAIL — тема заводится как `manual`, на короткую историю 400 нет.

- [ ] **Шаг 3: Реализация**

В `src/blog/blog.controller.ts` после строки `import { LeaveOutcome, leaveQueue, shiftToJson } from './blog-queue';` добавить:

```ts
import { REAL_CASE_DUPLICATE, prepareRealCase } from './blog-real-case';
```

В `case 'add_topic': {` первой строкой блока, перед комментарием «Пустая тема дала бы идею…», вставить:

```ts
        // Реальный кейс — история целиком, а не тема одной строкой: свои
        // границы длины и свой ключ (blog-real-case.ts). Рубрику из запроса
        // не читаем — реальный кейс всегда кейс.
        if (data.kind === 'real') {
          const prep = prepareRealCase(data.topic);
          // `=== false`, а не `!prep.ok`: в бэке strictNullChecks выключен,
          // и отрицание союз не сужает — `prep.reason` не скомпилировался бы.
          if (prep.ok === false) throw new BadRequestException(prep.reason);
          const post = await this.topics.addTopic(prep.topic);
          return res.status(200).json(post ?? { skipped: REAL_CASE_DUPLICATE });
        }

```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный**

```bash
git add src/blog/blog.controller.ts
git commit -q -m "feat(blog): реальный кейс из админки — add_topic с kind real

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/blog.controller'
```

Expected: PASS, включая старый «add_topic заводит ручную тему с источником manual».

---

## Задача 7: `/case` — заведение кейса в `BlogApprovalService`

**Files:**
- Modify: `src/blog/blog-approval.service.ts` (импорты, конструктор, новый метод)
- Modify: `src/blog/blog-approval.service.spec.ts`, `src/blog/blog-queue.spec.ts`, `src/blog/blog-approval.integration.spec.ts` — конструктор в тестах
- Test: `src/blog/blog-approval.service.spec.ts`

- [ ] **Шаг 1: Конструктор в существующих тестах получает четвёртый аргумент**

Сервису понадобится `BlogTopicService`. Тридцать с лишним мест в тестах собирают его руками тремя аргументами. jest типы не проверяет и промолчал бы, но `tsc -p tsconfig.json` получил бы три десятка новых ошибок — правим сразу:

```bash
cd ~/Downloads/spirits_back/.worktrees/blog-real-cases
perl -pi -e 's/new BlogApprovalService\(pg as any, tg as any, \{ get: jest\.fn\(\) \} as any\)/new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any, {} as any)/g; s/new BlogApprovalService\(pg as any, tg as any, settings as any\)/new BlogApprovalService(pg as any, tg as any, settings as any, {} as any)/g; s/new BlogApprovalService\(pg as any, tg as any, settings\)/new BlogApprovalService(pg as any, tg as any, settings, {} as any)/g' src/blog/blog-approval.service.spec.ts src/blog/blog-queue.spec.ts src/blog/blog-approval.integration.spec.ts
```

Многострочную сборку в `src/blog/blog-approval.integration.spec.ts` (около строки 156) поправить руками — заменить:

```ts
    svc = new BlogApprovalService(
      { query: (sql: string, params?: any[]) => pool.query(sql, params) } as any,
      tg as any,
      { get: jest.fn() } as any,
    );
```

на:

```ts
    svc = new BlogApprovalService(
      { query: (sql: string, params?: any[]) => pool.query(sql, params) } as any,
      tg as any,
      { get: jest.fn() } as any,
      {} as any, // topics — замечаниям не нужен
    );
```

Проверка — трёхаргументных сборок не осталось:

```bash
grep -rn "new BlogApprovalService(" src | grep -v "{} as any)"
```

Expected: одна строка — многострочная сборка `svc = new BlogApprovalService(` (её четвёртый аргумент на отдельной строке). Других строк нет.

- [ ] **Шаг 2: Падающие тесты команды**

В конец `src/blog/blog-approval.service.spec.ts` добавить:

```ts
/**
 * `/case <история>` в личке — реальный кейс в блог. Команда владельца блога и
 * только его: чужой `/case` блог не трогает, и бот отвечает на него как на
 * любую неизвестную команду.
 */
describe('handleCaseCommand: реальный кейс командой в личке', () => {
  const OWNER = 37948399;
  const STORY = 'Рассказчик — Дмитрий, основатель Linkeon. Роман прочитал полис КАСКО целиком.';
  const OLD = process.env.BLOG_APPROVER_TG_ID;

  beforeEach(() => { process.env.BLOG_APPROVER_TG_ID = String(OWNER); });
  afterEach(() => {
    if (OLD === undefined) delete process.env.BLOG_APPROVER_TG_ID;
    else process.env.BLOG_APPROVER_TG_ID = OLD;
  });

  const setup = (addTopic: jest.Mock = jest.fn().mockResolvedValue({ id: 'new' })) => {
    const tg = { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) };
    const topics = { addTopic };
    const svc = new BlogApprovalService({ query: jest.fn() } as any, tg as any, { get: jest.fn() } as any, topics as any);
    return { svc, tg, topics };
  };
  const dm = (text: string, from = OWNER) => ({ text, from: { id: from }, chat: { id: from, type: 'private' } });

  it('владелец заводит кейс: источник real, история как написана', async () => {
    const { svc, tg, topics } = setup();
    expect(await svc.handleCaseCommand(dm(`/case ${STORY}`))).toBe(true);
    expect(topics.addTopic).toHaveBeenCalledWith(
      expect.objectContaining({ rubric: 'case', source: 'real', topicHint: STORY }),
    );
    expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, expect.stringContaining('Принял реальный кейс'));
  });

  it('чужой /case — не наш: ни темы, ни ответа от блога', async () => {
    const { svc, tg, topics } = setup();
    expect(await svc.handleCaseCommand(dm(`/case ${STORY}`, 42))).toBe(false);
    expect(topics.addTopic).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('без BLOG_APPROVER_TG_ID команда ничья', async () => {
    delete process.env.BLOG_APPROVER_TG_ID;
    const { svc, topics } = setup();
    expect(await svc.handleCaseCommand(dm(`/case ${STORY}`))).toBe(false);
    expect(topics.addTopic).not.toHaveBeenCalled();
  });

  it('другие команды и обычный текст — не наши', async () => {
    const { svc } = setup();
    expect(await svc.handleCaseCommand(dm('/help'))).toBe(false);
    expect(await svc.handleCaseCommand(dm(STORY))).toBe(false);
  });

  it('пустая и короткая история — объяснение, как писать, тема не заводится', async () => {
    const { svc, tg, topics } = setup();
    expect(await svc.handleCaseCommand(dm('/case'))).toBe(true);
    expect(await svc.handleCaseCommand(dm('/case кейс про налоговую'))).toBe(true);
    expect(topics.addTopic).not.toHaveBeenCalled();
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    for (const [, text] of tg.sendMessage.mock.calls) {
      expect(text).toMatch(/\/case/);
      expect(text).toMatch(/40 знаков/);
    }
  });

  it('повтор — владелец узнаёт, что такую историю уже заводили', async () => {
    const { svc, tg } = setup(jest.fn().mockResolvedValue(null));
    await svc.handleCaseCommand(dm(`/case ${STORY}`));
    expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, expect.stringContaining('уже заводили'));
  });

  it('сбой базы — владельцу причина, а не молчание', async () => {
    const { svc, tg } = setup(jest.fn().mockRejectedValue(new Error('connection refused')));
    expect(await svc.handleCaseCommand(dm(`/case ${STORY}`))).toBe(true);
    expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, expect.stringContaining('connection refused'));
  });

  // Бот получает правки сообщений (edited_message) тем же путём, что и новые.
  // Исправленный текст — другой хеш: правка опечатки завела бы второй кейс, и
  // первым в работу ушёл бы старый текст — вместе с тем, что владелец убрал.
  it('правка сообщения с /case не заводит второй кейс — владельцу объяснено, как поправить', async () => {
    const { svc, tg, topics } = setup();
    expect(await svc.handleCaseCommand({ ...dm(`/case ${STORY}`), edit_date: 1727790000 })).toBe(true);
    expect(topics.addTopic).not.toHaveBeenCalled();
    expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, expect.stringMatching(/замечани/));
  });
});
```

- [ ] **Шаг 3: Закоммитить и убедиться, что красный — и что старое не сломано**

```bash
git add src/blog/blog-approval.service.spec.ts src/blog/blog-queue.spec.ts src/blog/blog-approval.integration.spec.ts
git commit -q -m "test(blog): /case в личке — реальный кейс от владельца (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog/(blog-approval|blog-queue)' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: FAIL только у нового `describe` — `svc.handleCaseCommand is not a function`. Всё остальное в трёх файлах зелёное: лишний аргумент конструктора ничего не ломает.

- [ ] **Шаг 4: Реализация**

В `src/blog/blog-approval.service.ts` после строки `import { QueueShift, formatQueueShift, leaveQueue } from './blog-queue';` добавить:

```ts
import { BlogTopicService } from './blog-topic.service';
import { REAL_CASE_DUPLICATE, caseCommandStory, prepareRealCase } from './blog-real-case';
```

Конструктор заменить на:

```ts
  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly settings: BlogSettingsService,
    // Заводить реальный кейс командой `/case` (см. handleCaseCommand).
    private readonly topics: BlogTopicService,
  ) {}
```

Сразу перед документирующим комментарием метода `handleReplyEdit` («Замечание к черновику реплаем.») вставить метод:

```ts
  /**
   * `/case <история>` в личке — реальный кейс в блог (blog-real-case.ts).
   *
   * Команда владельца блога и только его: чужой `/case` — не наш (false), и
   * бот отвечает на него как на любую неизвестную команду, как и до появления
   * этой. Владелец — тот же `BLOG_APPROVER_TG_ID`, которому приходят
   * черновики: команда заводит только тему, а в канал пост без его решения
   * всё равно не уйдёт.
   *
   * Ответ владельцу — всегда, и через `notify`: Telegram, не принявший ответ,
   * не повод ронять обработку команды, а молчание после команды — повод
   * прислать её второй раз.
   *
   * @returns true, если это команда владельца (кейс заведён или владельцу
   *          объяснено, почему нет)
   */
  async handleCaseCommand(msg: any): Promise<boolean> {
    const story = caseCommandStory(msg?.text);
    if (story === null) return false;
    const owner = approverChatId();
    if (!owner || Number(msg?.from?.id) !== owner) return false;

    const chatId = Number(msg?.chat?.id) || owner;

    // Правка уже отправленного сообщения приходит тем же путём (edited_message).
    // Исправленный текст — другой хеш, дедупликация его не узнает: правка
    // опечатки завела бы второй кейс, и первым в работу ушёл бы старый текст.
    // Факты реального кейса правятся замечанием к черновику — для него
    // замечание тоже материал (REAL_CASE в blog-editor.prompt.ts).
    if (msg?.edit_date) {
      await this.notify(
        chatId,
        'Правку сообщения не применяю: кейс уже заведён по первому тексту. ' +
          'Поправить факты можно замечанием к черновику, когда он придёт, — для реального кейса замечание тоже материал.',
      );
      return true;
    }

    const prep = prepareRealCase(story);
    if (prep.ok === false) {
      await this.notify(
        chatId,
        `Не завёл: ${prep.reason}.\n\nКак писать: /case и следом история — можно в несколько строк.`,
      );
      return true;
    }

    try {
      const post = await this.topics.addTopic(prep.topic);
      await this.notify(
        chatId,
        post
          ? 'Принял реальный кейс. Черновик пришлю сюда, когда до него дойдёт очередь.'
          : `Не завёл: ${REAL_CASE_DUPLICATE}.`,
      );
    } catch (e: any) {
      this.logger.error(`реальный кейс не заведён: ${e.message}`);
      await this.notify(chatId, `Не завёл реальный кейс: ${e.message}`);
    }
    return true;
  }

```

- [ ] **Шаг 5: Закоммитить и убедиться, что зелёный, а граф Nest сходится**

```bash
git add src/blog/blog-approval.service.ts
git commit -q -m "feat(blog): /case в личке — реальный кейс командой владельца блога

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/blog' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: PASS всего `src/blog`. Отдельно убедиться, что зелёный `blog.module.spec.ts`: он поднимает граф зависимостей Nest, и новая зависимость `BlogApprovalService` от `BlogTopicService` должна в нём разрешиться.

---

## Задача 8: Бот отдаёт `/case` блогу первым

**Files:**
- Modify: `src/tg-bot/tg-bot.service.ts` (начало `handleDmCommand`)
- Test: `src/tg-bot/tg-bot.blog-routing.spec.ts`

- [ ] **Шаг 1: Падающие тесты**

В `src/tg-bot/tg-bot.blog-routing.spec.ts` заменить строку:

```ts
  const blog = { handleCallback: jest.fn(), handleReplyEdit: jest.fn() };
```

на:

```ts
  const blog = { handleCallback: jest.fn(), handleReplyEdit: jest.fn(), handleCaseCommand: jest.fn() };
```

и в конец этого же `describe('роутинг блога в живом обработчике'` добавить:

```ts
  /**
   * `/case` — команда владельца блога. Блог смотрит её ПЕРВЫМ, до разбора
   * команд: тот переводит текст в нижний регистр и режет по пробелу, а
   * историю нужно взять целиком.
   */
  it('/case владельца забирает блог — ответа про неизвестную команду нет', async () => {
    blog.handleCaseCommand.mockResolvedValue(true);
    const msg = { chat: { id: 37948399, type: 'private' }, from: { id: 37948399 }, text: '/case Дмитрий рассказывает' };

    await (svc as any).handleDmCommand(msg);

    expect(blog.handleCaseCommand).toHaveBeenCalledWith(msg);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой /case блог не берёт — бот отвечает как на неизвестную команду, как раньше', async () => {
    blog.handleCaseCommand.mockResolvedValue(false);

    await (svc as any).handleDmCommand({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/case история' });

    expect(grammy.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Не знаю такой команды'));
  });
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
git add src/tg-bot/tg-bot.blog-routing.spec.ts
git commit -q -m "test(tg-bot): /case уходит в блог раньше разбора команд (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/tg-bot/tg-bot.blog-routing'
```

Expected: FAIL у «/case владельца забирает блог» — бот отвечает «Не знаю такой команды», `handleCaseCommand` не вызван.

- [ ] **Шаг 3: Реализация**

В `src/tg-bot/tg-bot.service.ts`, в начале `private async handleDmCommand(msg: any): Promise<void> {`, перед строкой `const text = msg.text.toLowerCase().trim();` вставить:

```ts
    // `/case <история>` — реальный кейс в блог, команда владельца блога. Стоит
    // первой: разбор ниже переводит текст в нижний регистр и режет по пробелу,
    // а историю надо взять целиком и как написана. Чужой `/case` блог не берёт
    // (false) — он доходит до ответа про неизвестную команду, как и до
    // появления этой. В /help и в меню команд её нет намеренно.
    if (await this.blogApproval.handleCaseCommand(msg)) return;

```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный весь бот**

```bash
git add src/tg-bot/tg-bot.service.ts
git commit -q -m "feat(tg-bot): /case в личке уходит в блог

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-back.sh 'src/tg-bot'
```

Expected: PASS, число падений не больше точки отсчёта из задачи 0. В `tg-bot.private-text.spec.ts` заглушка блога без `handleCaseCommand`, но `handleDmCommand` там подменён целиком — новая строка до него не доходит.

---

## Задача 9: Фронт — подпись «Реальный кейс» и предел длины

Все команды — в `~/Downloads/spirits_front/.worktrees/blog-real-cases`.

**Files:**
- Modify: `src/components/admin/blogStatus.ts` (в конец файла)
- Test: `src/components/admin/blogStatus.test.ts`

- [ ] **Шаг 1: Падающий тест**

В `src/components/admin/blogStatus.test.ts` в импорт из `'./blogStatus'` добавить `rubricLabel,`, `REAL_CASE_MAX_CHARS,` и `realCaseChars,`, а в конец файла — тесты:

```ts
describe('rubricLabel', () => {
  it('реальный кейс подписан словами — код источника наружу не торчит', () => {
    expect(rubricLabel({ rubric: 'case', source: 'real' })).toBe('Реальный кейс');
  });

  it('остальные — как раньше: рубрика и источник', () => {
    expect(rubricLabel({ rubric: 'case', source: 'stats' })).toBe('Кейс · stats');
    expect(rubricLabel({ rubric: 'news', source: 'git' })).toBe('Новинка · git');
  });
});

describe('REAL_CASE_MAX_CHARS и realCaseChars', () => {
  it('предел совпадает с бэком (blog-real-case.ts)', () => {
    expect(REAL_CASE_MAX_CHARS).toBe(4000);
  });

  // Бэк считает символы, а не UTF-16, и обрезает пробелы по краям — счётчик в
  // форме обязан считать так же, иначе кнопка пускала бы то, что бэк отклонит.
  it('считает символы без пробелов по краям, эмодзи — за один', () => {
    expect(realCaseChars('  абв\n')).toBe(3);
    expect(realCaseChars('😀')).toBe(1);
  });
});
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
cd ~/Downloads/spirits_front/.worktrees/blog-real-cases
git branch --show-current
git add src/components/admin/blogStatus.test.ts
git commit -q -m "test(admin): подпись реального кейса в блоге (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-front.sh src/components/admin/blogStatus.test.ts
```

Expected: FAIL — `rubricLabel is not a function`.

- [ ] **Шаг 3: Реализация — в конец `src/components/admin/blogStatus.ts`**

```ts
/**
 * Подпись поста в очереди и архиве. Реальный кейс подписан словами: «Кейс ·
 * real» выдавал бы наружу внутренний код источника.
 */
export function rubricLabel(post: { rubric: string; source: string }): string {
  if (post.source === 'real') return 'Реальный кейс';
  return `${post.rubric === 'news' ? 'Новинка' : 'Кейс'} · ${post.source}`;
}

/**
 * Предел длины истории реального кейса — копия бэка (`REAL_CASE_MAX_CHARS` в
 * `src/blog/blog-real-case.ts`).
 *
 * Полем он не навязывается: `maxLength` молча режет вставленный текст, и у
 * истории пропал бы конец — чаще всего финал, ради которого кейс и пишется.
 * Форма вместо этого показывает счётчик и не даёт отправить лишнее.
 */
export const REAL_CASE_MAX_CHARS = 4000;

/** Длина истории так, как её меряет бэк: символы, а не UTF-16, без пробелов по краям. */
export function realCaseChars(text: string): number {
  return Array.from(text.trim()).length;
}
```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный**

```bash
git add src/components/admin/blogStatus.ts
git commit -q -m "feat(admin): подпись «Реальный кейс» и предел длины истории

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-front.sh src/components/admin/blogStatus.test.ts
```

Expected: PASS.

---

## Задача 10: Фронт — «Реальный кейс» во вкладке «Блог»

**Files:**
- Modify: `src/components/admin/AdminBlogView.tsx`
- Test: `src/components/admin/AdminBlogView.test.tsx`

- [ ] **Шаг 1: Падающие тесты — в конец `src/components/admin/AdminBlogView.test.tsx`**

```tsx
describe('реальный кейс', () => {
  const STORY = 'Рассказчик — Дмитрий, основатель Linkeon.\nРоман прочитал полис КАСКО целиком.';

  /** Выбор в списке — React слушает change, а значение ставится через прототип. */
  const choose = async (testid: string, value: string) => {
    const el = q(testid) as HTMLSelectElement;
    if (!el) throw new Error(`нет списка ${testid}`);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    await act(async () => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const setup = (posts: any[] = []) => {
    post.mockImplementation(async (_url: string, payload: any) => {
      if (payload.action === 'list') return res(200, posts);
      if (payload.action === 'add_topic') return res(200, { id: 'new' });
      throw new Error(`неожиданное действие ${payload.action}`);
    });
  };

  it('«Реальный кейс» превращает строку темы в многострочное поле', async () => {
    setup();
    await mount();
    expect(q('blog-new-topic')!.tagName).toBe('INPUT');

    await choose('blog-new-rubric', 'real');

    expect(q('blog-new-topic')!.tagName).toBe('TEXTAREA');
  });

  it('история уходит целиком, с переносами строк, как реальный кейс — без рубрики', async () => {
    setup();
    await mount();
    await choose('blog-new-rubric', 'real');
    await type('blog-new-topic', STORY);
    await click('blog-add-topic');

    expect(sentActions().find((a) => a.action === 'add_topic')).toEqual({ action: 'add_topic', kind: 'real', topic: STORY });
  });

  it('обычная тема уходит как раньше — с рубрикой и без kind', async () => {
    setup();
    await mount();
    await type('blog-new-topic', 'про аренду');
    await click('blog-add-topic');

    expect(sentActions().find((a) => a.action === 'add_topic')).toEqual({ action: 'add_topic', rubric: 'case', topic: 'про аренду' });
  });

  // Сверяем саму подпись поста, а не весь экран: в списке рубрик над очередью
  // есть пункт «Реальный кейс», и проверка по textContent зеленела бы без правки.
  it('реальный кейс в очереди подписан словами, а не кодом источника', async () => {
    setup([{ ...basePost, source: 'real', status: 'idea', title: null, body: null }]);
    await mount();

    expect(q('blog-rubric-p1')?.textContent).toBe('Реальный кейс');
  });

  it('у остальных постов подпись прежняя — рубрика и источник', async () => {
    setup([{ ...basePost, source: 'stats', status: 'idea', title: null, body: null }]);
    await mount();

    expect(q('blog-rubric-p1')?.textContent).toBe('Кейс · stats');
  });

  // maxLength молча режет вставку — у истории пропал бы финал. Вместо него
  // счётчик и неактивная кнопка: лишнее не уходит, но и не теряется.
  it('длинная история не обрезается: счётчик краснеет, кнопка неактивна', async () => {
    setup();
    await mount();
    await choose('blog-new-rubric', 'real');
    await type('blog-new-topic', 'а'.repeat(4001));

    expect((q('blog-new-topic') as HTMLTextAreaElement).value).toHaveLength(4001);
    expect(q('blog-new-topic')!.hasAttribute('maxlength')).toBe(false);
    expect(q('blog-real-case-count')!.textContent).toContain('4001 / 4000');
    expect((q('blog-add-topic') as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Шаг 2: Закоммитить и убедиться, что красный**

```bash
git add src/components/admin/AdminBlogView.test.tsx
git commit -q -m "test(admin): реальный кейс во вкладке блога (красный)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-front.sh src/components/admin/AdminBlogView.test.tsx
```

Expected: FAIL у пяти из шести новых тестов: нет пункта `real` (поле остаётся `INPUT`), `kind` не уходит, у подписи нет `data-testid`, нет счётчика. «Обычная тема уходит как раньше» зелёный уже сейчас — он сторожит старое поведение.

- [ ] **Шаг 3: Реализация в `src/components/admin/AdminBlogView.tsx`**

3a. В импорт из `'./blogStatus'` добавить `rubricLabel,`, `REAL_CASE_MAX_CHARS,` и `realCaseChars,`.

3b. После `interface BlogSettings { … }` добавить:

```ts
/** Что заводит форма над очередью: рубрика обычной темы или реальный кейс. */
type NewTopicKind = 'news' | 'case' | 'real';

const toNewTopicKind = (v: string): NewTopicKind => (v === 'news' || v === 'real' ? v : 'case');
```

3c. Заменить строку состояния:

```ts
  const [newRubric, setNewRubric] = useState<'news' | 'case'>('case');
```

на:

```ts
  const [newRubric, setNewRubric] = useState<NewTopicKind>('case');
```

3d. Заменить функцию `addTopic` целиком:

```ts
  const addTopic = async () => {
    const topic = newTopic.trim();
    if (!topic) return;
    // Реальный кейс — история целиком: бэк сам знает, что это кейс, и рубрику
    // для него не читает.
    const payload = newRubric === 'real'
      ? { action: 'add_topic', kind: 'real', topic }
      : { action: 'add_topic', rubric: newRubric, topic };
    if (await act(payload)) setNewTopic('');
  };

  // Сверх предела история не уходит: бэк её отклонит, а резать её мы не
  // станем — пропал бы финал.
  const realCaseTooLong = newRubric === 'real' && realCaseChars(newTopic) > REAL_CASE_MAX_CHARS;
```

3e. В форме над очередью (`{screen === 'queue' && (`) заменить `<input data-testid="blog-new-topic" … />` и `<select data-testid="blog-new-rubric" …>…</select>` на:

```tsx
          {newRubric === 'real' ? (
            <div className="w-full">
              <textarea
                data-testid="blog-new-topic"
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                rows={6}
                placeholder="Кто рассказывает, что случилось, что сделал ассистент, чем кончилось, в чём суть"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-forest-500"
              />
              <div
                data-testid="blog-real-case-count"
                className={clsx('text-xs text-right', realCaseTooLong ? 'text-red-600' : 'text-gray-500')}
              >
                {realCaseChars(newTopic)} / {REAL_CASE_MAX_CHARS}
              </div>
            </div>
          ) : (
            <input
              data-testid="blog-new-topic"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="Своя тема одной строкой"
              className="flex-1 min-w-[12rem] border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-forest-500"
            />
          )}
          <select
            data-testid="blog-new-rubric"
            value={newRubric}
            onChange={(e) => setNewRubric(toNewTopicKind(e.target.value))}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm bg-white"
          >
            <option value="case">Кейс</option>
            <option value="real">Реальный кейс</option>
            <option value="news">Новинка</option>
          </select>
```

У кнопки `blog-add-topic` заменить `disabled={!newTopic.trim() || busy}` на `disabled={!newTopic.trim() || busy || realCaseTooLong}`; остальное в ней не трогать.

3f. Заменить подпись поста в списке:

```tsx
                      <span className="text-xs text-gray-500">
                        {p.rubric === 'news' ? 'Новинка' : 'Кейс'} · {p.source}
                      </span>
```

на:

```tsx
                      <span data-testid={`blog-rubric-${p.id}`} className="text-xs text-gray-500">
                        {rubricLabel(p)}
                      </span>
```

- [ ] **Шаг 4: Закоммитить и убедиться, что зелёный весь админ-каталог**

```bash
git add src/components/admin/AdminBlogView.tsx
git commit -q -m "feat(admin): «Реальный кейс» во вкладке блога — многострочная история

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
~/.cache/blog-real-cases/ci-front.sh src/components/admin
```

Expected: PASS, падений не больше, чем в точке отсчёта.

---

## Задача 11: Полная проверка на ноде

- [ ] **Шаг 1: Бэк — тесты блога и бота, с живым Postgres**

```bash
~/.cache/blog-real-cases/ci-back.sh 'src/(blog|tg-bot)' 'BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes'
```

Expected: падений не больше, чем в точке отсчёта (задача 0, шаг 5); пройденных больше на число новых тестов; `skipped` нет.

- [ ] **Шаг 2: Бэк — гейт типов для кода в сборке и сама сборка**

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/blog-real-cases && . ~/.nvm/nvm.sh && npx tsc --noEmit -p tsconfig.build.json; echo "tsc exit: $?"; npm run build 2>&1 | tail -3'
```

Expected: `tsc exit: 0` без вывода; сборка без ошибок.

- [ ] **Шаг 3: Фронт — сборка и дельта типов**

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/blog-real-cases-front && . ~/.nvm/nvm.sh && pnpm build 2>&1 | tail -3; npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c "error TS"'
```

Expected: сборка зелёная; число ошибок `tsc` — ровно как в точке отсчёта.

- [ ] **Шаг 4: Сломать проверку нарочно**

Прогон, который не может покраснеть, ничего не доказывает. Во временной ветке вернуть выбор блока к прежнему «новость или выдуманный кейс» и убедиться, что тесты это ловят:

```bash
cd ~/Downloads/spirits_back/.worktrees/blog-real-cases
git switch -q -c tmp/break-check
perl -pi -e "s/const rubricBlock = RUBRIC_BLOCKS\[kind\] \?\? CASE;/const rubricBlock = kind === 'news' ? NEWS : CASE;/" src/blog/blog-editor.prompt.ts
git diff --stat   # ровно один файл, одна строка
git commit -qam "tmp: сломать выбор блока"
SHA=$(git rev-parse HEAD); git push -q origin tmp/break-check
ssh dv@85.192.61.231 "cd ~/ci/wt/blog-real-cases && git fetch -q origin && git checkout -q $SHA && . ~/.nvm/nvm.sh && npx jest --testPathPattern='src/blog/blog-editor' 2>&1 | grep -E 'Tests:'"
git switch -q feat/blog-real-cases && git branch -D tmp/break-check && git push -q origin --delete tmp/break-check
```

Expected: `Tests: N failed` (N ≥ 5: «промпт реального кейса», «правило про реальных пользователей», «реальный кейс уходит редактору…»). Затем убедиться, что ветка `feat/blog-real-cases` чистая (`git status --short` пуст) и её HEAD — последний коммит задачи 8.

---

## Задача 12: Ревью

- [ ] **Шаг 1:** Запросить ревью скиллом superpowers:requesting-code-review по диффам `origin/main..feat/blog-real-cases` в обоих репозиториях. Акценты для ревьюера:
  - REAL_CASE не противоречит COMMON;
  - чужой `/case` идёт прежним путём;
  - DI-граф;
  - нет утечек персональных данных в логи (`handleCaseCommand` логирует только текст ошибки, не историю).
- [ ] **Шаг 2:** Замечания — исправить по тому же циклу (тест → красный → код → зелёный → коммит), повторить задачу 11.

---

## Задача 13: Миграция на test и prod

**Выполняет основная сессия, не сабагент. Прод — только после OK владельца.** Миграция только расширяет допустимое, старый код с ней совместим, поэтому катится до выката кода. Раннер миграций на проде сломан, а `deploy.sh` миграции не катает — отсюда ручной `psql` с записью в `schema_migrations`.

**Почему `lock_timeout`.** DROP/ADD CHECK берут ACCESS EXCLUSIVE. Если накат совпадёт с долгим держателем блокировки — например, с ночным `pg_dump`, — ALTER встанет за ним в очередь и до конца дампа заблокирует любой запрос к `blog_post`: тики крона, админку, кнопки в личке. С таймаутом в 5 секунд накат просто откажет, и его можно повторить позже.

**Почему проверяются все CHECK таблицы, а не одно по имени.** Если исходное ограничение на какой-то базе называется иначе, `DROP … IF EXISTS` молча ничего не снимет, а ADD добавит второе. Старое продолжит отклонять `real`, а проверка по имени покажет новое определение и будет зелёной.

**Стенд:** в его `schema_migrations` нет ни одной строки `blog/%`, хотя объекты 001–004 на месте. Отсутствие записи там не значит «не накатано»; строка 005 станет единственной записью блога.

- [ ] **Шаг 1: Test (стенд на ноде, база приложения из живого чекаута — только чтение `.env`)**

Миграция и запись о ней идут одним вызовом `psql --single-transaction`, как в `scripts/migrate.ts`. Две отдельные команды записали бы 005 как накатанную и тогда, когда сам накат откатился по таймауту.

```bash
{ cat ~/Downloads/spirits_back/.worktrees/blog-real-cases/src/blog/migrations/005_real_case_source.sql; echo "INSERT INTO schema_migrations (filename) VALUES ('blog/005_real_case_source.sql') ON CONFLICT DO NOTHING;"; } | ssh dv@85.192.61.231 'cd ~/spirits_back && U=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | tr -d "\"'"'"'"); PGOPTIONS="-c lock_timeout=5s" psql "$U" -X -v ON_ERROR_STOP=1 --single-transaction -f -'
echo "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'blog_post'::regclass AND contype = 'c' ORDER BY conname;" | ssh dv@85.192.61.231 'cd ~/spirits_back && U=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | tr -d "\"'"'"'"); psql "$U" -X -v ON_ERROR_STOP=1 -At -f -'
```

Expected: `ALTER TABLE` ×2 и `INSERT 0 1` (на повторе — `INSERT 0 0`); затем ровно три строки ограничений:
- `blog_post_rubric_check`;
- `blog_post_source_check` — `CHECK ((source = ANY (ARRAY['backlog'::text, 'git'::text, 'stats'::text, 'manual'::text, 'real'::text])))`;
- `blog_post_status_check`.

Четыре строки или вторая проверка по `source` означают, что старое ограничение звалось иначе и осталось на месте. Тогда — стоп, разбираться.

Отказ `canceling statement due to lock timeout` — не ошибка миграции: кто-то держит таблицу. Повторить через несколько минут.

- [ ] **Шаг 2: Prod — те же две команды с хостом `dvolkov@212.113.106.202`.** Перед этим спросить владельца. Expected — тот же.

---

## Задача 14: Мерж в main и выкат

**Выполняет основная сессия. `deploy.sh` — только после явного «катим» владельца.**

- [ ] **Шаг 1: Мерж бэка в `origin/main` мимо общего чекаута**

```bash
cd ~/Downloads/spirits_back && git fetch -q origin
git worktree add --detach .worktrees/merge-real-cases origin/main
cd .worktrees/merge-real-cases
git merge --no-ff feat/blog-real-cases -m "Merge feat/blog-real-cases: реальные кейсы в автоблоге

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q origin HEAD:refs/heads/verify/blog-real-cases
```

Прогнать на ноде `src/(blog|tg-bot)` и сборку на sha мержа (как в задаче 11, шаги 1–2, с `git checkout <sha мержа>`). Отдельным шагом, с выходом при живом деплое. Деплой могут вести и с мака, и с ноды. Квадратные скобки в шаблоне не дают grep найти сам себя и командную строку ssh, в которой тоже есть «deploy.sh»:

```bash
test "$(ps -eo command | grep -c '[s]cripts/deploy.sh')" = 0 && test "$(ssh dv@85.192.61.231 'ps -eo command | grep -c "[s]cripts/deploy.sh"')" = 0 && echo "деплоев нет"
```

Только после «деплоев нет»:

```bash
git push origin HEAD:main
```

Если `origin/main` за это время сдвинулся, push откажет — это правильно. Тогда повторить шаг с новой базы.

- [ ] **Шаг 2: Мерж фронта — та же процедура** в `~/Downloads/spirits_front`, воркдерево `.worktrees/merge-real-cases`, ветка проверки `verify/blog-real-cases`, прогон `src/components/admin` и `pnpm build` на sha мержа.

- [ ] **Шаг 3: Общие чекауты — на `origin/main`**

`deploy.sh` пушит локальный `main` из `LOCAL_BACK_DIR`/`LOCAL_FRONT_DIR`, и отстающий `main` откажет push.
- Если `git -C <чекаут> status --porcelain` пуст и ветка `main` — `git -C <чекаут> merge --ff-only origin/main`.
- Если в чекауте чужая работа — не трогать. Выкатить через чистый клон: `git clone --branch main` в scratchpad, затем `LOCAL_FRONT_DIR=<клон>`. Для бэка `LOCAL_BACK_DIR` из клона не подходит: smoke берёт `tests/node_modules` из чекаута.

- [ ] **Шаг 4: Спросить владельца и выкатить отвязанно**

После явного OK:

```bash
mkdir -p ~/deploy-logs
cd ~/Downloads/spirits_back
( nohup bash scripts/deploy.sh > ~/deploy-logs/real-cases-$(date +%Y%m%d-%H%M).log 2>&1 < /dev/null & )
```

Без `| tail`: конвейер копит вывод до конца. Следить `Monitor`-ом по логу до `ALL PHASES GREEN`.

- [ ] **Шаг 5: Проверить, что доехало, — по артефактам, а не по коду возврата**

Маркеры — ASCII-имена, которых до этой работы не было: кириллицу в минифицированном JS сборщик может экранировать, и грепу по ней верить нельзя. Сироты прошлых выкатов здесь проверку не зеленят: нового имени в старых файлах быть не может.

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && git log --oneline -1 && grep -c "editorKind" dist/blog/blog-editor.prompt.js && git reflog -3'
ssh dvolkov@212.113.106.202 'grep -rl "blog-rubric-" ~/spirits_front --include="*.js" | head -2'
```

Expected:
- на проде sha мержа;
- `editorKind` в собранном `dist` — число больше нуля;
- в `reflog` нет `reset: moving to <старый sha>` после выката — это был бы след отката;
- во фронте есть файл с `blog-rubric-`.

---

## Задача 15: Живая проверка и первые два кейса

**Выполняет основная сессия.**

- [ ] **Шаг 1: Материалы — на согласование владельцу**

Собрать из переписки владельца с Романом (прод, `custom_chat_history`, `session_id = '79030169187_12'`; ФНС — 04.09–30.09, КАСКО — 30.09) два материала. В каждом:
- рассказчик («Дмитрий, основатель Linkeon»);
- что случилось;
- что сделал Роман;
- что сделал Дмитрий;
- чем кончилось — для КАСКО: отказался от полиса;
- суть — самому изучать такие документы долго, а здесь отдал большой документ, и Роман вытащил суть.

Без ИНН, номеров решений и полисов, названий банков и страховой, имени агента, города. Показать владельцу текстом в чате и ждать OK. В репозиторий материалы не кладутся.

- [ ] **Шаг 2: Живая проверка на стенде.** Завести на test реальный кейс с одобренным материалом КАСКО через `POST /webhook/admin/blog {action: 'add_topic', kind: 'real', topic}`.
  - Нужен JWT админа на стенде: debug-OTP для `79030169187`, Basic Auth из `scripts/test-server.env.local`.
  - Черновик — дождаться тика `prepareDrafts` (≤ 5 мин при `BLOG_ENABLED=true` на стенде) или дёрнуть его вручную через контекст Nest (см. заметку о блоге).
  - Прочитать `title`/`body` черновика из базы стенда и показать владельцу.
  - Сверить: факты только из материала; нет названий организаций и персональных данных; из первого абзаца видно, что это история основателя; нет «история придумана».
  - Если редактор нарушает правило — поправить блок REAL_CASE тем же циклом, что в задаче 2, и выкатить заново.

- [ ] **Шаг 3: Прод.** Предложить владельцу прислать `/case <материал>` в личку @LinkeonAgentBot самому — заодно живая проверка команды. Если не хочет — завести оба кейса за него. Черновики придут ему в личку по очереди; при одобрении встанут в ближайшие свободные слоты.
