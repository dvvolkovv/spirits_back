# Автоматический блог Linkeon в Telegram — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Модуль, который сам собирает темы, пишет пост с картинкой, показывает его владельцу на апрув и публикует в Telegram-канал Linkeon три раза в неделю.

**Architecture:** Отдельный модуль `src/blog/` в `spirits_back` — не трогает клиентский SMM. Чистые функции (слоты, машина состояний, разбор ответов) отделены от сервисов с побочными эффектами, поэтому тестируются без моков. Управление — вкладка «Блог» в админке `spirits_front` плюс кнопки в личке Telegram.

**Tech Stack:** NestJS 10, PostgreSQL через `PgService`, `@nestjs/schedule` для крона, `@napi-rs/canvas` для наложения текста, релей `r.linkeon.io` для генерации текста, grammy-клиент для Telegram. Тесты — jest (бэк) и vitest (фронт).

**Спека:** `docs/superpowers/specs/2026-09-21-telegram-blog-design.md`

---

## Что нужно знать до старта

**Сборки и тесты гоняются на тестовой ноде, не на маке.** Мак не тянет: прогоны уходят в таймаут. Порядок для любой проверки в этом плане:

```bash
# локально
git push -u origin <ветка>
# на ноде
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q <sha>'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npm ci && npx jest src/blog --silent'
```

`source ~/.nvm/nvm.sh` обязателен в каждой ssh-команде. Работать только в `~/ci/`, никогда в `~/spirits_back` — оттуда живёт API тестового стенда.

**Полный `npm test` на бэке красный by design** — свою работу мерить дельтой, гонять точечно `npx jest src/blog`.

**Jest на бэке типы не проверяет** (`isolatedModules`), поэтому после каждой пачки задач отдельно:

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx tsc --noEmit -p tsconfig.build.json'
```

**Коммиты** — после каждой задачи, в ветку `feat/tg-blog`. Пушить в `origin`, сливать в `main`: коллега держит свою ветку основной, и работа из неё перезатирается.

---

## Файловая структура

**Бэкенд — `spirits_back/src/blog/`:**

| Файл | Ответственность |
|---|---|
| `migrations/001_blog.sql` | Схема `blog_post` и `blog_settings` |
| `blog.types.ts` | Типы поста, `rowToPost`, таблица допустимых переходов |
| `blog-slots.ts` | Чистые функции: следующий слот, протухла ли новость |
| `blog-text.ts` | Подгонка текста под лимит подписи Telegram |
| `blog-editor.parse.ts` | Разбор JSON-ответа редактора |
| `blog-callback.ts` | Разбор `callback_data` кнопок |
| `blog-settings.service.ts` | Чтение и запись строки настроек |
| `blog-topic.service.ts` | Источники тем, дедупликация |
| `blog-git.source.ts` | Недельный дайджест по git-логу |
| `blog-relay.client.ts` | Один вызов релея, без стрима наружу |
| `blog-editor.prompt.ts` | Промпт редактора |
| `blog-editor.service.ts` | Тема → заголовок, текст, промпт картинки |
| `blog-image.service.ts` | Картинка с фолбэком без модели |
| `blog-publisher.service.ts` | Атомарный захват и отправка в канал |
| `blog-approval.service.ts` | Черновик в личку, обработка кнопок и реплая |
| `blog.cron.ts` | Расписание: пополнение тем, подготовка, публикация, напоминания |
| `blog.controller.ts` | `POST /webhook/admin/blog` под админским гардом |
| `blog.module.ts` | Сборка модуля |

**Фронт — `spirits_front/src/`:**

> **Две неточности этого раздела, выясненные при исполнении.**
>
> 1. `isArchive('failed')` возвращает `true`, поэтому гейт кнопок по
>    `isQueue(p.status)` (как написано в Task 20) оставил бы сорвавшийся пост
>    в очереди **вообще без кнопок** — ни переписать, ни выбросить. Кнопки
>    гейтятся зеркалом машины состояний бэкенда, а не группировкой.
> 2. Ключ `admin.tabs.blog` добавляется только в `ru`, `en`, `pt`. Требование
>    «во все семь локалей» неверно: в `scripts/check-locales.mjs` записана
>    обратная политика (`UNTRANSLATED_PREFIXES = ['admin.']`), админка не
>    локализуется, а у `de/es/fr/zh` секции `admin` нет вовсе — одинокий
>    переведённый ярлык среди английских соседей выглядел бы недоделкой.

| Файл | Ответственность |
|---|---|
| `components/admin/blogStatus.ts` | Ярлыки и цвета статусов, группировка очереди |
| `components/admin/AdminBlogView.tsx` | Вкладка: очередь, архив, настройки |
| `pages/AdminPage.tsx` | Модификация: новая вкладка |
| `i18n/locales/*.json` | Ключ `admin.tabs.blog` в семи локалях |

---

## Task 1: Схема базы

**Files:**
- Create: `src/blog/migrations/001_blog.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- src/blog/migrations/001_blog.sql
-- Автоблог Linkeon в Telegram. Одна таблица постов: идея — это тот же пост
-- без текста, отдельной очереди идей нет.

CREATE TABLE IF NOT EXISTS blog_post (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric         text NOT NULL CHECK (rubric IN ('news','case')),
  source         text NOT NULL CHECK (source IN ('backlog','git','stats','manual')),
  source_ref     text,
  topic_key      text NOT NULL,
  topic_hint     text,
  lang           text NOT NULL DEFAULT 'ru',
  title          text,
  body           text,
  image_prompt   text,
  image_url      text,
  status         text NOT NULL DEFAULT 'idea'
                   CHECK (status IN ('idea','drafting','pending_review','approved',
                                     'publishing','published','rejected','failed')),
  slot_at        timestamptz,
  published_at   timestamptz,
  review_chat_id     bigint,
  review_message_id  bigint,
  tg_message_id  bigint,
  tg_url         text,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_post_status_slot ON blog_post (status, slot_at);
CREATE INDEX IF NOT EXISTS idx_blog_post_topic_created ON blog_post (topic_key, created_at DESC);
-- Поиск черновика по сообщению в личке: нужен для правки реплаем.
CREATE INDEX IF NOT EXISTS idx_blog_post_review_msg ON blog_post (review_chat_id, review_message_id);

CREATE TABLE IF NOT EXISTS blog_settings (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  channel_chat_id text,
  slot_days       int[] NOT NULL DEFAULT '{1,3,5}',
  slot_hour_msk   int   NOT NULL DEFAULT 10,
  image_style     text  NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO blog_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

`topic_hint` — подсказка темы от источника (например «на этой неделе часто спрашивали юриста про аренду»). Редактор получает её на вход; в спеке она упомянута как «отдаёт подсказку темы, не текст».

`review_chat_id` / `review_message_id` — координаты сообщения-черновика в личке. Без них правку реплаем не с чем сопоставить.

- [ ] **Step 2: Коммит**

```bash
git add src/blog/migrations/001_blog.sql
git commit -m "feat(blog): схема blog_post и blog_settings"
```

- [ ] **Step 3: Применить на тестовой базе**

Раннер миграций на проде застрял на `base/001` и ничего после себя не докатывает, поэтому применяем через psql руками. На тестовой ноде:

```bash
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -f ~/ci/spirits_back/src/blog/migrations/001_blog.sql'
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -c "\d blog_post"'
```

Ожидается: таблица с 21 колонкой, три индекса. Если `\d blog_post` не показывает `idx_blog_post_review_msg` — миграция применилась частично, разбираться до следующей задачи.

---

## Task 2: Типы и машина состояний

**Files:**
- Create: `src/blog/blog.types.ts`
- Test: `src/blog/blog.types.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog.types.spec.ts
import { canTransition, rowToPost } from './blog.types';

describe('canTransition', () => {
  it('idea → drafting разрешён', () => {
    expect(canTransition('idea', 'drafting')).toBe(true);
  });

  it('pending_review → drafting разрешён (кнопка «переписать»)', () => {
    expect(canTransition('pending_review', 'drafting')).toBe(true);
  });

  it('approved → publishing → published — рабочий путь публикации', () => {
    expect(canTransition('approved', 'publishing')).toBe(true);
    expect(canTransition('publishing', 'published')).toBe(true);
  });

  it('idea → published запрещён: пост не может выйти минуя апрув', () => {
    expect(canTransition('idea', 'published')).toBe(false);
  });

  it('published — терминальный статус, из него никуда', () => {
    expect(canTransition('published', 'drafting')).toBe(false);
    expect(canTransition('published', 'approved')).toBe(false);
  });

  it('rejected — терминальный статус', () => {
    expect(canTransition('rejected', 'drafting')).toBe(false);
  });

  it('failed → drafting разрешён: отказ можно перезапустить руками', () => {
    expect(canTransition('failed', 'drafting')).toBe(true);
  });
});

describe('rowToPost', () => {
  it('переводит snake_case строку БД в camelCase объект', () => {
    const post = rowToPost({
      id: 'abc', rubric: 'case', source: 'stats', source_ref: null,
      topic_key: 'arenda', topic_hint: 'про аренду', lang: 'ru',
      title: 'Заголовок', body: 'Текст', image_prompt: 'сцена', image_url: null,
      status: 'pending_review', slot_at: null, published_at: null,
      review_chat_id: '77', review_message_id: '12',
      tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
      created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
    });
    expect(post.topicKey).toBe('arenda');
    expect(post.reviewMessageId).toBe(12);
    expect(post.tgMessageId).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog.types.spec.ts`
Expected: FAIL — `Cannot find module './blog.types'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog.types.ts
export type BlogRubric = 'news' | 'case';
export type BlogSource = 'backlog' | 'git' | 'stats' | 'manual';
export type BlogStatus =
  | 'idea' | 'drafting' | 'pending_review' | 'approved'
  | 'publishing' | 'published' | 'rejected' | 'failed';

export interface BlogPost {
  id: string;
  rubric: BlogRubric;
  source: BlogSource;
  sourceRef: string | null;
  topicKey: string;
  topicHint: string | null;
  lang: string;
  title: string | null;
  body: string | null;
  imagePrompt: string | null;
  imageUrl: string | null;
  status: BlogStatus;
  slotAt: string | null;
  publishedAt: string | null;
  reviewChatId: number | null;
  reviewMessageId: number | null;
  tgMessageId: number | null;
  tgUrl: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Допустимые переходы. Главное, что здесь закрыто: пост не может попасть
 * в канал минуя pending_review — автопостинг без человека не предусмотрен
 * ни одним путём, а не «просто не вызывается».
 */
export const ALLOWED_TRANSITIONS: Record<BlogStatus, BlogStatus[]> = {
  idea:           ['drafting', 'rejected'],
  drafting:       ['pending_review', 'failed'],
  pending_review: ['approved', 'drafting', 'rejected'],
  approved:       ['publishing', 'drafting', 'rejected'],
  publishing:     ['published', 'failed'],
  published:      [],
  rejected:       [],
  failed:         ['drafting', 'rejected'],
};

export function canTransition(from: BlogStatus, to: BlogStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToPost(row: any): BlogPost {
  return {
    id: row.id,
    rubric: row.rubric,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    topicKey: row.topic_key,
    topicHint: row.topic_hint ?? null,
    lang: row.lang,
    title: row.title ?? null,
    body: row.body ?? null,
    imagePrompt: row.image_prompt ?? null,
    imageUrl: row.image_url ?? null,
    status: row.status,
    slotAt: row.slot_at ?? null,
    publishedAt: row.published_at ?? null,
    reviewChatId: num(row.review_chat_id),
    reviewMessageId: num(row.review_message_id),
    tgMessageId: num(row.tg_message_id),
    tgUrl: row.tg_url ?? null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

`num()` нужен потому, что `bigint` драйвер pg отдаёт строкой — сравнение `reviewMessageId === msg.message_id` без приведения молча не совпадёт.

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog.types.spec.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog.types.ts src/blog/blog.types.spec.ts
git commit -m "feat(blog): типы поста и машина состояний"
```

---

## Task 3: Слоты публикации

**Files:**
- Create: `src/blog/blog-slots.ts`
- Test: `src/blog/blog-slots.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-slots.spec.ts
import { nextSlotAfter, isStaleNews, STALE_NEWS_DAYS } from './blog-slots';

const DAYS = [1, 3, 5];   // пн, ср, пт
const HOUR = 10;          // 10:00 МСК = 07:00 UTC

describe('nextSlotAfter', () => {
  it('вторник днём → ближайшая среда 10:00 МСК', () => {
    // вт 2026-09-22 12:00 UTC
    const slot = nextSlotAfter(new Date('2026-09-22T12:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-23T07:00:00.000Z');
  });

  it('понедельник до слота → сегодня же', () => {
    const slot = nextSlotAfter(new Date('2026-09-21T05:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-21T07:00:00.000Z');
  });

  it('понедельник после слота → среда, а не сегодня задним числом', () => {
    const slot = nextSlotAfter(new Date('2026-09-21T08:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-23T07:00:00.000Z');
  });

  it('суббота → понедельник следующей недели', () => {
    const slot = nextSlotAfter(new Date('2026-09-26T12:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-28T07:00:00.000Z');
  });

  it('один слот в неделю тоже работает', () => {
    const slot = nextSlotAfter(new Date('2026-09-22T12:00:00Z'), [4], HOUR);
    expect(slot.toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });
});

describe('isStaleNews', () => {
  it('новость моложе двух недель — свежая', () => {
    expect(isStaleNews(new Date('2026-09-10T10:00:00Z'), new Date('2026-09-21T10:00:00Z'))).toBe(false);
  });

  it('новость старше двух недель — протухла', () => {
    expect(isStaleNews(new Date('2026-09-01T10:00:00Z'), new Date('2026-09-21T10:00:00Z'))).toBe(true);
  });

  it('ровно на границе не считается протухшей', () => {
    const created = new Date('2026-09-07T10:00:00Z');
    const now = new Date(created.getTime() + STALE_NEWS_DAYS * 86400_000);
    expect(isStaleNews(created, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-slots.spec.ts`
Expected: FAIL — `Cannot find module './blog-slots'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-slots.ts

/** Москва круглый год UTC+3 — перевода часов в России нет, зона фиксированная. */
const MSK_OFFSET_HOURS = 3;

/** Новость старше этого срока не публикуется: «а ещё месяц назад мы выпустили» никому не нужно. */
export const STALE_NEWS_DAYS = 14;

/**
 * Ближайший слот строго после `from`.
 * @param days дни недели по ISO-нумерации: 1 = понедельник … 7 = воскресенье
 * @param hourMsk час слота по Москве
 */
export function nextSlotAfter(from: Date, days: number[], hourMsk: number): Date {
  if (!days.length) throw new Error('blog: список дней слотов пуст');
  const utcHour = hourMsk - MSK_OFFSET_HOURS;

  for (let shift = 0; shift <= 14; shift++) {
    const day = new Date(Date.UTC(
      from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + shift,
      utcHour, 0, 0, 0,
    ));
    const isoDow = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (days.includes(isoDow) && day.getTime() > from.getTime()) return day;
  }
  throw new Error('blog: не нашёл слот за две недели вперёд');
}

export function isStaleNews(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > STALE_NEWS_DAYS * 86400_000;
}
```

Оговорка по часовому поясу: `utcHour` может уйти в минус, если час слота меньше трёх. `Date.UTC` с отрицательным часом корректно откатывает дату на предыдущие сутки, так что отдельная обработка не нужна — но и день недели тогда сместится, что и есть правильное поведение.

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-slots.spec.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-slots.ts src/blog/blog-slots.spec.ts
git commit -m "feat(blog): расчёт слотов публикации и протухания новостей"
```

---

## Task 4: Подгонка текста под подпись Telegram

**Files:**
- Create: `src/blog/blog-text.ts`
- Test: `src/blog/blog-text.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-text.spec.ts
import { buildCaption, CAPTION_LIMIT } from './blog-text';

describe('buildCaption', () => {
  it('короткий пост склеивается заголовком и текстом', () => {
    expect(buildCaption('Заголовок', 'Тело поста')).toBe('Заголовок\n\nТело поста');
  });

  it('длинный пост обрезается до лимита', () => {
    const body = 'я'.repeat(2000);
    const caption = buildCaption('Заголовок', body);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  });

  it('обрезка идёт по границе предложения, а не посреди слова', () => {
    const body = 'Первое предложение. ' + 'а'.repeat(CAPTION_LIMIT) + '. Хвост.';
    const caption = buildCaption('Т', body);
    expect(caption.endsWith('Первое предложение.')).toBe(true);
  });

  it('если границы предложения нет — обрезает по слову и ставит многоточие', () => {
    const body = Array(400).fill('слово').join(' ');
    const caption = buildCaption('Т', body);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption.endsWith('…')).toBe(true);
    expect(caption).not.toMatch(/сло…$/);
  });

  it('заголовок без тела не падает', () => {
    expect(buildCaption('Только заголовок', '')).toBe('Только заголовок');
  });

  it('реалистичная проза обрезается по концу предложения, а не посреди фразы', () => {
    const body = Array(30).fill('Человек приходит с конкретной задачей и получает разбор по шагам.').join(' ');
    const caption = buildCaption('Заголовок', body);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption.endsWith('.')).toBe(true);
    expect(caption.endsWith('…')).toBe(false);
  });
});
```

Последний тест обязателен. Без него проходит и реализация, которая границу предложения вообще не ищет, — она режет по последнему пробелу и обрывает обычный пост на середине фразы.

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-text.spec.ts`
Expected: FAIL — `Cannot find module './blog-text'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-text.ts

/**
 * У Telegram подпись к фото — 1024 символа. Берём 1000 с запасом: пост
 * «картинка + история» не должен разъезжаться на два сообщения.
 */
export const CAPTION_LIMIT = 1000;

export function buildCaption(title: string, body: string): string {
  const head = (title || '').trim();
  const tail = (body || '').trim();
  const full = tail ? `${head}\n\n${tail}` : head;
  if (full.length <= CAPTION_LIMIT) return full;

  const cut = full.slice(0, CAPTION_LIMIT);

  // Сначала пробуем закончить на границе предложения — обрыв на середине
  // мысли читается как баг, а не как тизер. Порога «не ближе половины
  // лимита» здесь быть не должно: если весь остаток текста — один
  // неразрывный кусок, единственная осмысленная точка обрыва может стоять
  // и на двадцатом символе.
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd > 0) return cut.slice(0, sentenceEnd + 1).trim();

  // Границы предложения нет вовсе — режем по слову. Многоточие не нужно,
  // если обрез и так пришёлся на терминальную пунктуацию.
  const wordEnd = cut.lastIndexOf(' ');
  const safe = (wordEnd > 0 ? cut.slice(0, wordEnd) : cut.slice(0, CAPTION_LIMIT - 1)).trim();
  return /[.!?]$/.test(safe) ? safe : `${safe}…`;
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-text.spec.ts`
Expected: PASS, 5 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-text.ts src/blog/blog-text.spec.ts
git commit -m "feat(blog): подгонка текста под лимит подписи Telegram"
```

---

## Task 5: Разбор ответа редактора

**Files:**
- Create: `src/blog/blog-editor.parse.ts`
- Test: `src/blog/blog-editor.parse.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-editor.parse.spec.ts
import { parseEditorReply } from './blog-editor.parse';

describe('parseEditorReply', () => {
  it('чистый JSON разбирается', () => {
    const out = parseEditorReply('{"title":"З","body":"Т","imagePrompt":"сцена"}');
    expect(out).toEqual({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
  });

  it('JSON в markdown-заборе разбирается', () => {
    const raw = 'Вот пост:\n```json\n{"title":"З","body":"Т","imagePrompt":"сцена"}\n```\nГотово.';
    expect(parseEditorReply(raw).title).toBe('З');
  });

  it('JSON без языка в заборе разбирается', () => {
    const raw = '```\n{"title":"З","body":"Т","imagePrompt":"сцена"}\n```';
    expect(parseEditorReply(raw).body).toBe('Т');
  });

  it('пустой ответ — ошибка, а не пустой пост', () => {
    expect(() => parseEditorReply('')).toThrow(/пустой ответ/i);
  });

  it('текст без JSON — ошибка', () => {
    expect(() => parseEditorReply('Извини, не могу помочь')).toThrow(/не нашёл json/i);
  });

  it('JSON без обязательного поля — ошибка с именем поля', () => {
    expect(() => parseEditorReply('{"title":"З","body":"Т"}')).toThrow(/imagePrompt/);
  });

  it('пробельные значения считаются отсутствующими', () => {
    expect(() => parseEditorReply('{"title":"  ","body":"Т","imagePrompt":"с"}')).toThrow(/title/);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-editor.parse.spec.ts`
Expected: FAIL — `Cannot find module './blog-editor.parse'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-editor.parse.ts

export interface EditorDraft {
  title: string;
  body: string;
  imagePrompt: string;
}

/**
 * Релей иногда оборачивает JSON в markdown-забор или добавляет вежливую
 * обвязку до и после. Разбираем терпимо, но отсутствие полей — ошибка:
 * пустой пост лучше не выпускать вовсе, чем выпустить наполовину.
 */
export function parseEditorReply(raw: string): EditorDraft {
  const text = (raw || '').trim();
  if (!text) throw new Error('blog: пустой ответ редактора');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : sliceOuterObject(text);
  if (!candidate) throw new Error('blog: не нашёл JSON в ответе редактора');

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('blog: не нашёл JSON в ответе редактора');
  }

  for (const field of ['title', 'body', 'imagePrompt'] as const) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(`blog: в ответе редактора нет поля ${field}`);
    }
  }

  return {
    title: parsed.title.trim(),
    body: parsed.body.trim(),
    imagePrompt: parsed.imagePrompt.trim(),
  };
}

function sliceOuterObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-editor.parse.spec.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-editor.parse.ts src/blog/blog-editor.parse.spec.ts
git commit -m "feat(blog): разбор ответа редактора"
```

---

## Task 6: Разбор данных кнопок

**Files:**
- Create: `src/blog/blog-callback.ts`
- Test: `src/blog/blog-callback.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-callback.spec.ts
import { parseBlogCallback, buildBlogKeyboard } from './blog-callback';

const ID = '11111111-2222-3333-4444-555555555555';

describe('parseBlogCallback', () => {
  it('разбирает одобрение', () => {
    expect(parseBlogCallback(`blog:ok:${ID}`)).toEqual({ action: 'ok', postId: ID });
  });

  it('разбирает переписать и в мусор', () => {
    expect(parseBlogCallback(`blog:redo:${ID}`)!.action).toBe('redo');
    expect(parseBlogCallback(`blog:no:${ID}`)!.action).toBe('no');
  });

  it('чужой префикс — null, чтобы не перехватывать кнопки ассистентов', () => {
    expect(parseBlogCallback(`agent:${ID}`)).toBeNull();
    expect(parseBlogCallback('lang:ru')).toBeNull();
  });

  it('неизвестное действие — null', () => {
    expect(parseBlogCallback(`blog:drop:${ID}`)).toBeNull();
  });

  it('пустая строка — null', () => {
    expect(parseBlogCallback('')).toBeNull();
  });
});

describe('buildBlogKeyboard', () => {
  it('три кнопки в одном ряду с id поста', () => {
    const kb = buildBlogKeyboard(ID);
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      `blog:ok:${ID}`, `blog:redo:${ID}`, `blog:no:${ID}`,
    ]);
  });

  it('callback_data укладывается в лимит Telegram в 64 байта', () => {
    for (const btn of buildBlogKeyboard(ID).inline_keyboard[0]) {
      expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-callback.spec.ts`
Expected: FAIL — `Cannot find module './blog-callback'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-callback.ts

export type BlogCallbackAction = 'ok' | 'redo' | 'no';

export interface BlogCallback {
  action: BlogCallbackAction;
  postId: string;
}

const ACTIONS: BlogCallbackAction[] = ['ok', 'redo', 'no'];

export function parseBlogCallback(data: string): BlogCallback | null {
  const parts = String(data || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'blog') return null;
  const action = parts[1] as BlogCallbackAction;
  if (!ACTIONS.includes(action) || !parts[2]) return null;
  return { action, postId: parts[2] };
}

export function buildBlogKeyboard(postId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [[
      { text: '✅ Опубликовать', callback_data: `blog:ok:${postId}` },
      { text: '🔄 Переписать',  callback_data: `blog:redo:${postId}` },
      { text: '🗑 В мусор',      callback_data: `blog:no:${postId}` },
    ]],
  };
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-callback.spec.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-callback.ts src/blog/blog-callback.spec.ts
git commit -m "feat(blog): кнопки апрува и разбор callback_data"
```

---

## Task 7: Настройки

**Files:**
- Create: `src/blog/blog-settings.service.ts`
- Test: `src/blog/blog-settings.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-settings.service.spec.ts
import { BlogSettingsService } from './blog-settings.service';

const pgMock = () => ({ query: jest.fn() });

describe('BlogSettingsService', () => {
  it('читает строку настроек и приводит типы', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{
      channel_chat_id: '-1001234567890', slot_days: [1, 3, 5],
      slot_hour_msk: 10, image_style: 'плоская иллюстрация',
    }] });
    const svc = new BlogSettingsService(pg as any);
    const s = await svc.get();
    expect(s.channelChatId).toBe('-1001234567890');
    expect(s.slotDays).toEqual([1, 3, 5]);
    expect(s.slotHourMsk).toBe(10);
  });

  it('если строки нет — отдаёт дефолты, а не падает', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [] });
    const svc = new BlogSettingsService(pg as any);
    const s = await svc.get();
    expect(s.slotDays).toEqual([1, 3, 5]);
    expect(s.channelChatId).toBeNull();
  });

  it('обновление пишет только переданные поля', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{
      channel_chat_id: '-100', slot_days: [2, 4], slot_hour_msk: 9, image_style: '',
    }] });
    const svc = new BlogSettingsService(pg as any);
    await svc.update({ slotDays: [2, 4] });
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toContain('slot_days');
    expect(sql).not.toContain('channel_chat_id');
  });

  it('пустое обновление не ходит в базу', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{ slot_days: [1, 3, 5], slot_hour_msk: 10, image_style: '' }] });
    const svc = new BlogSettingsService(pg as any);
    await svc.update({});
    expect(pg.query.mock.calls[0][0]).toContain('SELECT');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-settings.service.spec.ts`
Expected: FAIL — `Cannot find module './blog-settings.service'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-settings.service.ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

export interface BlogSettings {
  channelChatId: string | null;
  slotDays: number[];
  slotHourMsk: number;
  imageStyle: string;
}

export interface BlogSettingsPatch {
  channelChatId?: string | null;
  slotDays?: number[];
  slotHourMsk?: number;
  imageStyle?: string;
}

const DEFAULTS: BlogSettings = {
  channelChatId: null,
  slotDays: [1, 3, 5],
  slotHourMsk: 10,
  imageStyle: '',
};

@Injectable()
export class BlogSettingsService {
  constructor(private readonly pg: PgService) {}

  async get(): Promise<BlogSettings> {
    const r = await this.pg.query(
      `SELECT channel_chat_id, slot_days, slot_hour_msk, image_style
         FROM blog_settings WHERE id = 1`,
    );
    const row = r.rows[0];
    if (!row) return { ...DEFAULTS };
    return {
      channelChatId: row.channel_chat_id ?? null,
      slotDays: Array.isArray(row.slot_days) && row.slot_days.length
        ? row.slot_days.map(Number)
        : DEFAULTS.slotDays,
      slotHourMsk: Number(row.slot_hour_msk ?? DEFAULTS.slotHourMsk),
      imageStyle: row.image_style ?? '',
    };
  }

  async update(patch: BlogSettingsPatch): Promise<BlogSettings> {
    const sets: string[] = [];
    const args: any[] = [];
    const put = (col: string, value: any) => {
      args.push(value);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.channelChatId !== undefined) put('channel_chat_id', patch.channelChatId);
    if (patch.slotDays !== undefined) put('slot_days', patch.slotDays);
    if (patch.slotHourMsk !== undefined) put('slot_hour_msk', patch.slotHourMsk);
    if (patch.imageStyle !== undefined) put('image_style', patch.imageStyle);

    if (sets.length) {
      await this.pg.query(
        `UPDATE blog_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`,
        args,
      );
    }
    return this.get();
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-settings.service.spec.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-settings.service.ts src/blog/blog-settings.service.spec.ts
git commit -m "feat(blog): настройки блога в БД"
```

---

## Task 8: Темы и дедупликация

**Files:**
- Create: `src/blog/blog-topic.service.ts`
- Test: `src/blog/blog-topic.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-topic.service.spec.ts
import { BlogTopicService, normalizeTopicKey, DEDUP_WINDOW_DAYS } from './blog-topic.service';

const pgMock = () => ({ query: jest.fn() });

describe('normalizeTopicKey', () => {
  it('схлопывает регистр и пробелы', () => {
    expect(normalizeTopicKey('  Аренда   Квартиры ')).toBe('аренда-квартиры');
  });

  it('разная пунктуация даёт один ключ', () => {
    expect(normalizeTopicKey('Аренда: квартиры!')).toBe(normalizeTopicKey('аренда квартиры'));
  });
});

describe('BlogTopicService.addTopic', () => {
  it('новая тема вставляется', async () => {
    const pg = pgMock();
    pg.query
      .mockResolvedValueOnce({ rows: [] })                    // проверка дубля
      .mockResolvedValueOnce({ rows: [{ id: 'new-id', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    const post = await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда', topicHint: 'про аренду' });
    expect(post).not.toBeNull();
    expect(pg.query.mock.calls[1][0]).toContain('INSERT INTO blog_post');
  });

  it('кейс с тем же ключом в окне дедупликации не вставляется', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'old' }] });
    const svc = new BlogTopicService(pg as any);
    const post = await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(post).toBeNull();
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('окно дедупликации — 90 дней', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(pg.query.mock.calls[0][1]).toContain(DEDUP_WINDOW_DAYS);
  });

  it('отклонённая тема не блокирует повтор: дубль ищется только среди живых и опубликованных', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(pg.query.mock.calls[0][0]).toContain("status <> 'rejected'");
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-topic.service.spec.ts`
Expected: FAIL — `Cannot find module './blog-topic.service'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-topic.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { BlogPost, BlogRubric, BlogSource, rowToPost } from './blog.types';

/**
 * Без этого окна синтетические кейсы пойдут по кругу примерно на третий
 * месяц: тем конечное число, а генератор про прошлые посты не помнит.
 */
export const DEDUP_WINDOW_DAYS = 90;

export function normalizeTopicKey(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

export interface AddTopicInput {
  rubric: BlogRubric;
  source: BlogSource;
  topicKey: string;
  topicHint?: string;
  sourceRef?: string;
}

@Injectable()
export class BlogTopicService {
  private readonly logger = new Logger(BlogTopicService.name);

  constructor(private readonly pg: PgService) {}

  /** @returns созданный пост-идею или null, если тема отбракована дедупликацией */
  async addTopic(input: AddTopicInput): Promise<BlogPost | null> {
    const key = normalizeTopicKey(input.topicKey);

    // Отклонённые темы из проверки исключены намеренно: если владелец отправил
    // пост в мусор, тема не «занята» — её можно попробовать заново.
    const dup = await this.pg.query(
      `SELECT id FROM blog_post
        WHERE topic_key = $1
          AND status <> 'rejected'
          AND created_at > now() - ($2 || ' days')::interval
        LIMIT 1`,
      [key, DEDUP_WINDOW_DAYS],
    );
    if (dup.rows.length) {
      this.logger.log(`тема "${key}" пропущена: дубль за ${DEDUP_WINDOW_DAYS} дней`);
      return null;
    }

    const r = await this.pg.query(
      `INSERT INTO blog_post (rubric, source, source_ref, topic_key, topic_hint, status)
       VALUES ($1, $2, $3, $4, $5, 'idea') RETURNING *`,
      [input.rubric, input.source, input.sourceRef ?? null, key, input.topicHint ?? null],
    );
    return rowToPost(r.rows[0]);
  }

  /**
   * Следующая тема в работу. Новость всегда вытесняет кейс — новости
   * скоропортящиеся, кейс полежит.
   */
  async takeNextIdea(): Promise<BlogPost | null> {
    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE status = 'idea'
        ORDER BY (rubric = 'news') DESC, created_at ASC
        LIMIT 1`,
    );
    return r.rows[0] ? rowToPost(r.rows[0]) : null;
  }

  /**
   * Темы для кейсов: какие ассистенты реально востребованы за неделю.
   * Колонка в `custom_chat_history` называется `agent` (integer) и ведёт в
   * `agents.id` — имя ассистента берём оттуда, иначе подсказка редактору
   * выглядела бы как «ассистент 12». Считаем только реплики человека:
   * ответы ассистента удвоили бы каждый ход.
   */
  async topAssistants(limit = 5): Promise<Array<{ agentId: string; agentName: string; turns: number }>> {
    const r = await this.pg.query(
      `SELECT a.id::text AS agent_id,
              coalesce(a.display_name, a.name) AS agent_name,
              count(*)::int AS turns
         FROM custom_chat_history h
         JOIN agents a ON a.id = h.agent
        WHERE h.created_at > now() - interval '7 days'
          AND h.sender_type = 'human'
        GROUP BY a.id, agent_name
        ORDER BY turns DESC
        LIMIT $1`,
      [limit],
    );
    return r.rows.map((x: any) => ({
      agentId: x.agent_id, agentName: x.agent_name, turns: Number(x.turns),
    }));
  }

  /** Заголовки последних постов — уходят редактору, чтобы он не повторялся. */
  async recentTitles(limit = 20): Promise<string[]> {
    const r = await this.pg.query(
      `SELECT title FROM blog_post
        WHERE title IS NOT NULL AND status IN ('published','approved','pending_review')
        ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x: any) => x.title);
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-topic.service.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Проверить, что колонки для статистики существуют**

`topAssistants` читает `custom_chat_history`. Прежде чем полагаться на неё:

```bash
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -c "\d custom_chat_history" | head -20'
```

Ожидается колонка с идентификатором ассистента и `created_at`. Если имя колонки другое — поправить SQL в `topAssistants` и добавить тест на фактическое имя. Пустой результат запроса тоже валиден: значит, за неделю обращений не было, и кейс-темы на этой неделе не появятся.

- [ ] **Step 6: Коммит**

```bash
git add src/blog/blog-topic.service.ts src/blog/blog-topic.service.spec.ts
git commit -m "feat(blog): источники тем и дедупликация"
```

---

## Task 9: Недельный дайджест по git

**Files:**
- Create: `src/blog/blog-git.source.ts`
- Test: `src/blog/blog-git.source.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-git.source.spec.ts
import { parseGitLog, filterUserFacing } from './blog-git.source';

describe('parseGitLog', () => {
  it('разбирает строки sha\\tsubject', () => {
    const out = parseGitLog('abc123\tfeat(chat): голосовой ввод\ndef456\tfix: опечатка');
    expect(out).toEqual([
      { sha: 'abc123', subject: 'feat(chat): голосовой ввод' },
      { sha: 'def456', subject: 'fix: опечатка' },
    ]);
  });

  it('пустой вывод — пустой список, не падение', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('filterUserFacing', () => {
  it('feat остаётся', () => {
    expect(filterUserFacing([{ sha: 'a', subject: 'feat(chat): голосовой ввод' }])).toHaveLength(1);
  });

  it('chore, docs, test, ci, refactor отбрасываются', () => {
    const noise = ['chore: бамп', 'docs(spec): дизайн', 'test: моки', 'ci: пайплайн', 'refactor: вынес хелпер']
      .map((subject, i) => ({ sha: String(i), subject }));
    expect(filterUserFacing(noise)).toHaveLength(0);
  });

  it('merge-коммиты отбрасываются', () => {
    expect(filterUserFacing([{ sha: 'a', subject: "Merge branch 'feat/x'" }])).toHaveLength(0);
  });

  it('fix остаётся: починка видимой поломки — это тоже новость', () => {
    expect(filterUserFacing([{ sha: 'a', subject: 'fix(auth): вход по почте' }])).toHaveLength(1);
  });

  it('ревёрт отбрасывается: откаченная фича — не новость', () => {
    expect(filterUserFacing([{ sha: 'a', subject: 'Revert "feat(chat): голосовой ввод"' }])).toHaveLength(0);
  });

  it('fixup и squash отбрасываются: это технический довесок к другому коммиту', () => {
    const noise = ['fixup! feat: что-то', 'squash! feat: что-то']
      .map((subject, i) => ({ sha: String(i), subject }));
    expect(filterUserFacing(noise)).toHaveLength(0);
  });
});
```

Два последних теста — не педантизм. `Revert "feat(...)"` без них проходит фильтр как обычная новость, и канал анонсирует фичу, которую уже откатили; владелец, одобривший её выкат месяц назад, такой черновик пропустит.

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-git.source.spec.ts`
Expected: FAIL — `Cannot find module './blog-git.source'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-git.source.ts
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface GitCommit { sha: string; subject: string; }

export function parseGitLog(stdout: string): GitCommit[] {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    .filter((c) => c.sha && c.subject);
}

const NOISE = /^(chore|docs|test|tests|ci|build|refactor|style|perf)[(:]/i;

/**
 * Служебные префиксы. `Revert` здесь по отдельной причине: откаченная фича
 * не должна уехать в канал как новая — владелец, одобривший её выкат месяц
 * назад, вряд ли вспомнит про откат и пропустит такой черновик.
 */
const SERVICE_PREFIXES = ['Merge ', 'Revert "', 'fixup! ', 'squash! '];

export function filterUserFacing(commits: GitCommit[]): GitCommit[] {
  return commits.filter((c) => {
    if (SERVICE_PREFIXES.some((p) => c.subject.startsWith(p))) return false;
    return !NOISE.test(c.subject);
  });
}

@Injectable()
export class BlogGitSource {
  private readonly logger = new Logger(BlogGitSource.name);

  /**
   * Пути к чекаутам через BLOG_GIT_REPOS (через запятую), по умолчанию — текущий.
   * Если .git нет — источник молча пуст. Это ожидаемо: на некоторых серверах
   * код раскладывается без истории, и тогда новости идут только из бэклога.
   */
  private repos(): string[] {
    const raw = process.env.BLOG_GIT_REPOS || process.cwd();
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async weeklyCommits(): Promise<GitCommit[]> {
    const out: GitCommit[] = [];
    for (const repo of this.repos()) {
      if (!fs.existsSync(path.join(repo, '.git'))) {
        this.logger.warn(`${repo}: нет .git, git-источник для него пуст`);
        continue;
      }
      try {
        const { stdout } = await exec(
          'git',
          ['-C', repo, 'log', '--since=7.days', '--no-merges', '--format=%h%x09%s'],
          { timeout: 15_000 },
        );
        out.push(...filterUserFacing(parseGitLog(stdout)));
      } catch (e: any) {
        this.logger.warn(`${repo}: git log не отработал — ${e.message}`);
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-git.source.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-git.source.ts src/blog/blog-git.source.spec.ts
git commit -m "feat(blog): недельный дайджест по git-логу"
```

---

## Task 10: Клиент релея

**Files:**
- Create: `src/blog/blog-relay.client.ts`
- Test: `src/blog/blog-relay.client.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-relay.client.spec.ts
import { collectRelayText } from './blog-relay.client';

describe('collectRelayText', () => {
  it('склеивает delta-события', () => {
    const sse = 'data: {"type":"delta","text":"При"}\ndata: {"type":"delta","text":"вет"}\ndata: {"type":"done"}\n';
    expect(collectRelayText(sse)).toBe('Привет');
  });

  it('берёт result, если delta не было', () => {
    const sse = 'data: {"type":"result","text":"Готовый ответ"}\ndata: {"type":"done"}\n';
    expect(collectRelayText(sse)).toBe('Готовый ответ');
  });

  it('result игнорируется, если delta уже были: иначе ответ задвоится', () => {
    const sse = 'data: {"type":"delta","text":"А"}\ndata: {"type":"result","text":"А"}\n';
    expect(collectRelayText(sse)).toBe('А');
  });

  it('битые строки пропускаются, а не роняют разбор', () => {
    const sse = 'data: не json\ndata: {"type":"delta","text":"Б"}\nмусор\n';
    expect(collectRelayText(sse)).toBe('Б');
  });

  it('пустой поток даёт пустую строку', () => {
    expect(collectRelayText('')).toBe('');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-relay.client.spec.ts`
Expected: FAIL — `Cannot find module './blog-relay.client'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-relay.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Разбор SSE-потока релея. Вынесен отдельной чистой функцией, чтобы
 * тестироваться без сети.
 */
export function collectRelayText(raw: string): string {
  const chunks: string[] = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'delta' || ev.type === 'text') chunks.push(ev.text || '');
      else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
    } catch { /* битую строку пропускаем: поток важнее одной записи */ }
  }
  return chunks.join('');
}

@Injectable()
export class BlogRelayClient {
  private readonly logger = new Logger(BlogRelayClient.name);

  /**
   * Один вызов релея. sessionId — новый на каждый пост: длинные сессии
   * у нас глючат посторонним текстом в ответе, а память здесь не нужна —
   * прошлые заголовки передаются прямо в промпте.
   */
  async ask(systemPrompt: string, message: string, sessionId: string): Promise<string> {
    const agentUrl = process.env.AGENT_URL || 'https://r.linkeon.io';
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('message', message);
    fd.append('systemPrompt', systemPrompt);
    fd.append('sessionId', sessionId);

    const resp = await axios.post(`${agentUrl}/chat`, fd, {
      headers: fd.getHeaders(),
      responseType: 'stream',
      timeout: 300_000,
    });

    const raw = await new Promise<string>((resolve, reject) => {
      let buf = '';
      resp.data.on('data', (c: Buffer) => { buf += c.toString(); });
      resp.data.on('end', () => resolve(buf));
      resp.data.on('error', reject);
    });

    const text = collectRelayText(raw).trim();
    if (!text) throw new Error('blog: релей вернул пустой ответ');
    return text;
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-relay.client.spec.ts`
Expected: PASS, 5 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-relay.client.ts src/blog/blog-relay.client.spec.ts
git commit -m "feat(blog): клиент релея для редактора"
```

---

## Task 11: Промпт и сервис редактора

**Files:**
- Create: `src/blog/blog-editor.prompt.ts`
- Create: `src/blog/blog-editor.service.ts`
- Test: `src/blog/blog-editor.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-editor.service.spec.ts
import { BlogEditorService } from './blog-editor.service';
import { buildEditorPrompt } from './blog-editor.prompt';

const relayMock = (reply: string) => ({ ask: jest.fn().mockResolvedValue(reply) });
const topicsMock = () => ({ recentTitles: jest.fn().mockResolvedValue(['Старый пост']) });

const POST: any = {
  id: 'p1', rubric: 'case', topicKey: 'аренда', topicHint: 'часто спрашивают про аренду',
};

describe('buildEditorPrompt', () => {
  it('в промпт попадают прошлые заголовки — чтобы редактор не повторялся', () => {
    const p = buildEditorPrompt('case', ['Заголовок А', 'Заголовок Б']);
    expect(p).toContain('Заголовок А');
    expect(p).toContain('Заголовок Б');
  });

  it('промпт требует JSON с тремя полями', () => {
    const p = buildEditorPrompt('news', []);
    expect(p).toContain('title');
    expect(p).toContain('body');
    expect(p).toContain('imagePrompt');
  });

  it('для новостей и кейсов промпты разные', () => {
    expect(buildEditorPrompt('news', [])).not.toBe(buildEditorPrompt('case', []));
  });
});

describe('BlogEditorService', () => {
  it('возвращает разобранный черновик', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"сцена"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);
    const draft = await svc.draft(POST);
    expect(draft).toEqual({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
  });

  it('sessionId свой на каждый пост', async () => {
    const relay = relayMock('{"title":"З","body":"Т","imagePrompt":"с"}');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);
    await svc.draft(POST);
    expect(relay.ask.mock.calls[0][2]).toContain('p1');
  });

  it('мусорный ответ релея — ошибка наверх, а не пустой пост', async () => {
    const relay = relayMock('извини, не могу');
    const svc = new BlogEditorService(relay as any, topicsMock() as any);
    await expect(svc.draft(POST)).rejects.toThrow(/не нашёл json/i);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-editor.service.spec.ts`
Expected: FAIL — `Cannot find module './blog-editor.service'`

- [ ] **Step 3: Промпт**

```typescript
// src/blog/blog-editor.prompt.ts
import { BlogRubric } from './blog.types';

const COMMON = `
Ты — редактор Telegram-канала Linkeon (my.linkeon.io). Linkeon — это платформа,
где люди общаются с AI-ассистентами: психолог, коуч, юрист, SMM и другие.

Правила:
- Пиши по-русски, живо, без канцелярита и без рекламного пафоса.
- В продукте это «Ассистент», никогда не «агент».
- Не придумывай фактов о продукте: если чего-то не знаешь — не пиши об этом.
- Не ссылайся на реальных пользователей и не выдавай выдуманное за реальный отзыв.
- Текст поста — не длиннее 900 символов, это подпись к картинке в Telegram.
- Никакой markdown-разметки кроме обычных абзацев.

Ответ верни СТРОГО одним JSON-объектом без каких-либо пояснений вокруг:
{"title": "заголовок до 80 символов",
 "body": "текст поста",
 "imagePrompt": "описание сцены для картинки на английском, без текста и надписей в кадре"}
`.trim();

const NEWS = `
Рубрика: НОВИНКА. Тебе дают описание того, что мы выпустили.
Расскажи, что изменилось и зачем это человеку, а не какой код мы написали.
Начни с пользы, а не с названия фичи.
`.trim();

const CASE = `
Рубрика: КЕЙС. Тебе дают подсказку — какая тема сейчас востребована.
Придумай короткую узнаваемую историю: у человека есть конкретная бытовая или
рабочая проблема, он приходит к ассистенту, получает разбор и делает шаг.
История вымышленная и должна читаться как типичная ситуация, а не как
свидетельство конкретного человека. Не приписывай продукту результатов,
которых он не даёт.
`.trim();

export function buildEditorPrompt(rubric: BlogRubric, recentTitles: string[]): string {
  const rubricBlock = rubric === 'news' ? NEWS : CASE;
  const recent = recentTitles.length
    ? `\n\nВот заголовки последних постов канала — не повторяй их темы и интонацию:\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `${COMMON}\n\n${rubricBlock}${recent}`;
}
```

- [ ] **Step 4: Сервис**

```typescript
// src/blog/blog-editor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { BlogRelayClient } from './blog-relay.client';
import { BlogTopicService } from './blog-topic.service';
import { buildEditorPrompt } from './blog-editor.prompt';
import { parseEditorReply, EditorDraft } from './blog-editor.parse';
import { BlogPost } from './blog.types';

@Injectable()
export class BlogEditorService {
  private readonly logger = new Logger(BlogEditorService.name);

  constructor(
    private readonly relay: BlogRelayClient,
    private readonly topics: BlogTopicService,
  ) {}

  async draft(post: BlogPost): Promise<EditorDraft> {
    const recent = await this.topics.recentTitles(20);
    const systemPrompt = buildEditorPrompt(post.rubric, recent);
    const message = post.topicHint
      ? `Тема: ${post.topicKey}\n\nПодсказка от источника: ${post.topicHint}`
      : `Тема: ${post.topicKey}`;

    // Сессия привязана к id поста: изолированная и одноразовая.
    const raw = await this.relay.ask(systemPrompt, message, `blog-${post.id}`);
    return parseEditorReply(raw);
  }
}
```

- [ ] **Step 5: Запустить тест**

Run: `npx jest src/blog/blog-editor.service.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 6: Коммит**

```bash
git add src/blog/blog-editor.prompt.ts src/blog/blog-editor.service.ts src/blog/blog-editor.service.spec.ts
git commit -m "feat(blog): редактор постов через релей"
```

---

## Task 12: Картинка с фолбэком

**Files:**
- Modify: `src/misc/misc.service.ts` (снять `private` с двух методов)
- Create: `src/blog/blog-image.service.ts`
- Test: `src/blog/blog-image.service.spec.ts`

- [ ] **Step 1: Открыть два метода MiscService**

`generateBanner` не подходит: он проверяет баланс токенов пользователя и списывает их. У блога нет пользователя и биллинг ему не нужен, поэтому собираем картинку из тех же кирпичей напрямую.

В `src/misc/misc.service.ts` заменить:

```typescript
  private async uploadAssetImage(buffer: Buffer, ext: string): Promise<string> {
```

на:

```typescript
  // public: блог собирает баннер из этих кирпичей напрямую, минуя биллинг —
  // у него нет пользователя, с которого списывать токены.
  async uploadAssetImage(buffer: Buffer, ext: string): Promise<string> {
```

и заменить:

```typescript
  private async generateRawImage(
```

на:

```typescript
  async generateRawImage(
```

- [ ] **Step 2: Написать падающий тест**

```typescript
// src/blog/blog-image.service.spec.ts
import { BlogImageService, buildBackgroundPrompt } from './blog-image.service';

const settingsMock = (imageStyle = 'плоская иллюстрация') => ({
  get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1], slotHourMsk: 10, imageStyle }),
});

describe('buildBackgroundPrompt', () => {
  it('добавляет запрет текста в кадре', () => {
    const p = buildBackgroundPrompt('котик у окна', 'акварель');
    expect(p.toLowerCase()).toContain('no text');
  });

  it('подмешивает фирменный стиль из настроек', () => {
    expect(buildBackgroundPrompt('котик', 'акварель')).toContain('акварель');
  });

  it('пустой стиль не ломает промпт', () => {
    expect(buildBackgroundPrompt('котик', '')).toContain('котик');
  });
});

describe('BlogImageService.render', () => {
  it('нормальный путь: генерация фона, наложение текста, загрузка', async () => {
    const misc = {
      generateRawImage: jest.fn().mockResolvedValue({ b64Image: 'AAA', mimeType: 'image/png' }),
      uploadAssetImage: jest.fn().mockResolvedValue('https://minio/img.png'),
    };
    const svc = new BlogImageService(misc as any, settingsMock() as any);
    (svc as any).overlay = jest.fn().mockResolvedValue(Buffer.from('banner'));

    const url = await svc.render('Заголовок', 'сцена');
    expect(url).toBe('https://minio/img.png');
    expect(misc.generateRawImage).toHaveBeenCalledTimes(1);
  });

  it('отказ генерации → фолбэк на фон без модели, пост всё равно выходит', async () => {
    const misc = {
      generateRawImage: jest.fn().mockRejectedValue(new Error('IMAGE_RECITATION')),
      uploadAssetImage: jest.fn().mockResolvedValue('https://minio/fallback.png'),
    };
    const svc = new BlogImageService(misc as any, settingsMock() as any);
    (svc as any).overlay = jest.fn().mockResolvedValue(Buffer.from('banner'));

    const url = await svc.render('Заголовок', 'сцена');
    expect(url).toBe('https://minio/fallback.png');
    // Два захода в модель: основной промпт и упрощённый — и только потом фолбэк.
    expect(misc.generateRawImage).toHaveBeenCalledTimes(2);
  });

  it('если и загрузка упала — ошибка наверх', async () => {
    const misc = {
      generateRawImage: jest.fn().mockRejectedValue(new Error('нет ключа')),
      uploadAssetImage: jest.fn().mockRejectedValue(new Error('minio недоступен')),
    };
    const svc = new BlogImageService(misc as any, settingsMock() as any);
    (svc as any).overlay = jest.fn().mockResolvedValue(Buffer.from('banner'));

    await expect(svc.render('З', 'сцена')).rejects.toThrow(/minio/);
  });
});
```

- [ ] **Step 3: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-image.service.spec.ts`
Expected: FAIL — `Cannot find module './blog-image.service'`

- [ ] **Step 4: Реализация**

```typescript
// src/blog/blog-image.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import { MiscService } from '../misc/misc.service';
import { renderBannerOverlay } from '../misc/banner-overlay';
import { BlogSettingsService } from './blog-settings.service';

const ASPECT = '1:1';

export function buildBackgroundPrompt(scene: string, style: string): string {
  const styleLine = style.trim() ? `${style.trim()}. ` : '';
  return (
    `${scene}\n\n${styleLine}` +
    `СТРОГО: на изображении НЕ должно быть текста, букв, слов, надписей, цифр, ` +
    `логотипов и водяных знаков. Оставь спокойную область в нижней части кадра ` +
    `под наложение заголовка. ` +
    `No text, no letters, no words, no captions, no watermark, no logo.`
  );
}

@Injectable()
export class BlogImageService {
  private readonly logger = new Logger(BlogImageService.name);

  constructor(
    private readonly misc: MiscService,
    private readonly settings: BlogSettingsService,
  ) {}

  /** Вынесено методом, чтобы тест мог подменить рендер без canvas-зависимостей. */
  protected overlay(bg: Buffer, title: string): Promise<Buffer> {
    return renderBannerOverlay(bg, { title, subtitle: '', cta: '', position: 'bottom', theme: 'dark' });
  }

  /**
   * @returns URL готовой картинки. Генерация может отвалиться тремя разными
   * способами (Google снял Imagen, IMAGE_RECITATION роняет запрос молча,
   * квоты), поэтому после двух попыток рисуем фон сами — канал не должен
   * замолкать из-за чужого сервиса.
   */
  async render(title: string, scene: string): Promise<string> {
    const { imageStyle } = await this.settings.get();

    const attempts = [
      buildBackgroundPrompt(scene, imageStyle),
      buildBackgroundPrompt(scene.split('.')[0] || scene, ''),
    ];

    for (const prompt of attempts) {
      try {
        const { b64Image } = await this.misc.generateRawImage(prompt, ASPECT);
        const banner = await this.overlay(Buffer.from(b64Image, 'base64'), title);
        return await this.misc.uploadAssetImage(banner, 'png');
      } catch (e: any) {
        this.logger.warn(`генерация фона не удалась: ${e.message}`);
      }
    }

    this.logger.warn('фолбэк: рисую фон без модели');
    const banner = await this.overlay(this.flatBackground(), title);
    return await this.misc.uploadAssetImage(banner, 'png');
  }

  /** Фирменный градиент 1024×1024 — не требует ни сети, ни ключей. */
  private flatBackground(): Buffer {
    const size = 1024;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#0f2f24');
    grad.addColorStop(1, '#1f5c45');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return canvas.toBuffer('image/png');
  }
}
```

- [ ] **Step 5: Запустить тест**

Run: `npx jest src/blog/blog-image.service.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 6: Проверить типы после правки MiscService**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: без ошибок. Jest типы не проверяет, а мы только что поменяли видимость методов в чужом файле — это ровно тот случай, когда зелёный прогон ничего не доказывает.

- [ ] **Step 7: Коммит**

```bash
git add src/misc/misc.service.ts src/blog/blog-image.service.ts src/blog/blog-image.service.spec.ts
git commit -m "feat(blog): картинка поста с фолбэком без модели"
```

---

## Task 13: Публикация с атомарным захватом

**Files:**
- Create: `src/blog/blog-publisher.service.ts`
- Test: `src/blog/blog-publisher.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-publisher.service.spec.ts
import { BlogPublisherService, buildPostUrl } from './blog-publisher.service';

const post = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', sourceRef: null, topicKey: 'k', topicHint: null,
  lang: 'ru', title: 'Заголовок', body: 'Текст', imagePrompt: null,
  imageUrl: 'https://minio/i.png', status: 'approved', slotAt: null, publishedAt: null,
  reviewChatId: null, reviewMessageId: null, tgMessageId: null, tgUrl: null,
  attempts: 0, lastError: null, createdAt: '', updatedAt: '', ...over,
});

const settingsMock = () => ({ get: jest.fn().mockResolvedValue({ channelChatId: '-1001234567890', slotDays: [1], slotHourMsk: 10, imageStyle: '' }) });

describe('buildPostUrl', () => {
  it('публичный канал — ссылка по username', () => {
    expect(buildPostUrl({ username: 'linkeon', id: -100123 }, 42)).toBe('https://t.me/linkeon/42');
  });

  it('приватный канал — ссылка вида t.me/c/<id>', () => {
    expect(buildPostUrl({ id: -1001234567890 }, 42)).toBe('https://t.me/c/1234567890/42');
  });
});

describe('BlogPublisherService.publish', () => {
  it('захватывает пост и отправляет фото в канал', async () => {
    const pg = { query: jest.fn() };
    pg.query
      .mockResolvedValueOnce({ rows: [{ ...rawRow() }] })   // захват
      .mockResolvedValueOnce({ rows: [] });                  // финальный апдейт
    const tg = { sendPhoto: jest.fn().mockResolvedValue({ message_id: 42, chat: { id: -1001234567890 } }) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());
    expect(res).toEqual({ ok: true, tgMessageId: 42, tgUrl: 'https://t.me/c/1234567890/42' });
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('проигравший захват не отправляет ничего — защита от двойной публикации', async () => {
    const pg = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    const tg = { sendPhoto: jest.fn() };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());
    expect(res.ok).toBe(false);
    expect(tg.sendPhoto).not.toHaveBeenCalled();
    // Без этой строки тест проходит даже если убрать условие статуса из
    // захвата: моки отдают заданные rows независимо от текста SQL.
    expect(pg.query.mock.calls[0][0] as string).toContain("status = 'approved'");
  });

  it('пост без картинки не захватывается и не публикуется — иначе сгорят все три попытки', async () => {
    const pg = { query: jest.fn() };
    const tg = { sendPhoto: jest.fn() };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post({ imageUrl: null }));
    expect(res.ok).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
    expect(tg.sendPhoto).not.toHaveBeenCalled();
  });

  it('канал не настроен — не захватываем и не публикуем', async () => {
    const pg = { query: jest.fn() };
    const tg = { sendPhoto: jest.fn() };
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: null, slotDays: [1], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogPublisherService(pg as any, tg as any, settings as any);

    const res = await svc.publish(post());
    expect(res.ok).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
    expect(tg.sendPhoto).not.toHaveBeenCalled();
  });

  it('отказ Telegram переводит пост в failed с причиной', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValueOnce({ rows: [] });
    const tg = { sendPhoto: jest.fn().mockRejectedValue(new Error('CHAT_WRITE_FORBIDDEN')) };
    const svc = new BlogPublisherService(pg as any, tg as any, settingsMock() as any);

    const res = await svc.publish(post());
    expect(res.ok).toBe(false);
    const lastSql = pg.query.mock.calls[1][0] as string;
    expect(lastSql).toContain("status = 'failed'");
    expect(pg.query.mock.calls[1][1]).toContain('CHAT_WRITE_FORBIDDEN');
  });
});

function rawRow() {
  return {
    id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
    lang: 'ru', title: 'Заголовок', body: 'Текст', image_prompt: null, image_url: 'https://minio/i.png',
    status: 'publishing', slot_at: null, published_at: null, review_chat_id: null, review_message_id: null,
    tg_message_id: null, tg_url: null, attempts: 1, last_error: null, created_at: '', updated_at: '',
  };
}
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-publisher.service.spec.ts`
Expected: FAIL — `Cannot find module './blog-publisher.service'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-publisher.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost } from './blog.types';
import { buildCaption } from './blog-text';

export interface PublishResult {
  ok: boolean;
  tgMessageId?: number;
  tgUrl?: string;
  error?: string;
}

export function buildPostUrl(chat: { id: number; username?: string }, messageId: number): string {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const cleaned = String(chat.id).replace(/^-100/, '');
  return `https://t.me/c/${cleaned}/${messageId}`;
}

@Injectable()
export class BlogPublisherService {
  private readonly logger = new Logger(BlogPublisherService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly settings: BlogSettingsService,
  ) {}

  async publish(post: BlogPost): Promise<PublishResult> {
    const { channelChatId } = await this.settings.get();
    if (!channelChatId) {
      this.logger.warn('канал не настроен — публикация пропущена');
      return { ok: false, error: 'канал не настроен' };
    }

    // Проверка ДО захвата. Иначе пост уходит в publishing, падает внутри
    // grammy невнятным TypeError, и крон сжигает на этом все три попытки —
    // причём last_error не скажет разбирающему очереди ничего о том, что
    // дело всего лишь в отсутствующей картинке.
    if (!post.imageUrl) {
      this.logger.warn(`пост ${post.id} без картинки — публикация пропущена`);
      return { ok: false, error: 'у поста нет картинки' };
    }

    // Атомарный захват: выигрывает ровно один вызов. Без этого два тика крона
    // или ретрай после таймаута дают в канал два одинаковых поста.
    const claim = await this.pg.query(
      `UPDATE blog_post
          SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'approved'
        RETURNING *`,
      [post.id],
    );
    if (!claim.rows.length) {
      this.logger.log(`пост ${post.id} уже захвачен другим вызовом — пропускаю`);
      return { ok: false, error: 'уже публикуется' };
    }

    const caption = buildCaption(post.title || '', post.body || '');

    try {
      const msg: any = await this.tg.sendPhoto(Number(channelChatId), post.imageUrl!, { caption });
      const messageId = Number(msg.message_id);
      const url = buildPostUrl({ id: Number(msg.chat?.id ?? channelChatId), username: msg.chat?.username }, messageId);

      await this.pg.query(
        `UPDATE blog_post
            SET status = 'published', published_at = now(),
                tg_message_id = $2, tg_url = $3, last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [post.id, messageId, url],
      );
      this.logger.log(`пост ${post.id} опубликован: ${url}`);
      return { ok: true, tgMessageId: messageId, tgUrl: url };
    } catch (e: any) {
      await this.pg.query(
        `UPDATE blog_post SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [post.id, String(e.message).slice(0, 500)],
      );
      this.logger.error(`публикация ${post.id} сорвалась: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
}
```

Ретраи Telegram здесь не в цикле, а в кроне: статус `failed` подхватывается следующим тиком, пока `attempts < 3`. Так ретрай переживает рестарт процесса, а не живёт в памяти одного вызова.

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-publisher.service.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-publisher.service.ts src/blog/blog-publisher.service.spec.ts
git commit -m "feat(blog): публикация в канал с атомарным захватом"
```

---

## Task 14: Апрув в личке

**Files:**
- Create: `src/blog/blog-approval.service.ts`
- Test: `src/blog/blog-approval.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog-approval.service.spec.ts
import { BlogApprovalService } from './blog-approval.service';

const rawRow = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
  lang: 'ru', title: 'З', body: 'Т', image_prompt: null, image_url: 'https://minio/i.png',
  status: 'pending_review', slot_at: null, published_at: null,
  review_chat_id: '77', review_message_id: '12', tg_message_id: null, tg_url: null,
  attempts: 0, last_error: null, created_at: '', updated_at: '', ...over,
});

describe('BlogApprovalService.handleCallback', () => {
  it('одобрение переводит пост в approved и назначает слот', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    const sql = pg.query.mock.calls[1][0] as string;
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('slot_at');
  });

  it('устаревшая кнопка по уже опубликованному посту ничего не меняет', async () => {
    const pg = { query: jest.fn().mockResolvedValueOnce({ rows: [rawRow({ status: 'published' })] }) };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const settings = { get: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    expect(pg.query).toHaveBeenCalledTimes(1);      // только чтение
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', expect.objectContaining({ text: expect.stringMatching(/уже/i) }));
  });

  it('«в мусор» переводит в rejected', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:no:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(pg.query.mock.calls[1][0]).toContain("status = 'rejected'");
  });

  it('«переписать» возвращает в drafting', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:redo:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(pg.query.mock.calls[1][0]).toContain("status = 'drafting'");
  });

  it('переход, запрещённый машиной состояний, не пишется в базу', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ status: 'approved' })] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    expect(pg.query).toHaveBeenCalledTimes(1);   // только чтение
  });

  it('чужой callback игнорируется полностью', async () => {
    const pg = { query: jest.fn() };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleCallback({ id: 'cb1', data: 'agent:xyz', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(handled).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
  });
});

describe('BlogApprovalService.handleReplyEdit', () => {
  it('реплай на черновик заменяет текст поста', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit({
      chat: { id: 77 }, text: 'Исправленный текст',
      reply_to_message: { message_id: 12 },
    });

    expect(handled).toBe(true);
    expect(pg.query.mock.calls[1][1]).toContain('Исправленный текст');
  });

  it('реплай на чужое сообщение не перехватывается — текст уйдёт ассистенту', async () => {
    const pg = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit({
      chat: { id: 77 }, text: 'Привет', reply_to_message: { message_id: 999 },
    });
    expect(handled).toBe(false);
  });

  it('обычное сообщение без реплая не перехватывается', async () => {
    const pg = { query: jest.fn() };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit({ chat: { id: 77 }, text: 'Привет' });
    expect(handled).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog-approval.service.spec.ts`
Expected: FAIL — `Cannot find module './blog-approval.service'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog-approval.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost, rowToPost } from './blog.types';
import { parseBlogCallback, buildBlogKeyboard } from './blog-callback';
import { buildCaption } from './blog-text';
import { nextSlotAfter } from './blog-slots';

@Injectable()
export class BlogApprovalService {
  private readonly logger = new Logger(BlogApprovalService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly settings: BlogSettingsService,
  ) {}

  /** Показать черновик владельцу и запомнить координаты сообщения. */
  async sendForReview(post: BlogPost, chatId: number): Promise<void> {
    const caption = buildCaption(post.title || '', post.body || '');
    const msg: any = await this.tg.sendPhoto(chatId, post.imageUrl!, {
      caption,
      reply_markup: buildBlogKeyboard(post.id),
    });
    await this.pg.query(
      `UPDATE blog_post
          SET status = 'pending_review', review_chat_id = $2, review_message_id = $3, updated_at = now()
        WHERE id = $1`,
      [post.id, chatId, Number(msg.message_id)],
    );
  }

  /** @returns true, если callback наш и обработан */
  async handleCallback(cb: any): Promise<boolean> {
    const parsed = parseBlogCallback(String(cb?.data || ''));
    if (!parsed) return false;

    const r = await this.pg.query(`SELECT * FROM blog_post WHERE id = $1`, [parsed.postId]);
    if (!r.rows.length) {
      await this.tg.answerCallbackQuery(cb.id, { text: 'Пост не найден' });
      return true;
    }
    const post = rowToPost(r.rows[0]);

    // Вторая панель управления — админка. Пост мог уехать дальше, пока
    // сообщение висело в личке; тогда кнопка не делает ничего.
    //
    // Проверка идёт через общую машину состояний, а не через сравнение с
    // 'pending_review': иначе `canTransition` остаётся мёртвым кодом с
    // зелёными тестами, который читается как гарантия «пост не выйдет минуя
    // апрув» и не охраняет ни одного перехода.
    const TARGET_STATUS: Record<typeof parsed.action, BlogStatus> = {
      ok: 'approved', redo: 'drafting', no: 'rejected',
    };
    const target = TARGET_STATUS[parsed.action];
    if (!canTransition(post.status, target)) {
      await this.tg.answerCallbackQuery(cb.id, { text: `Пост уже обработан: ${post.status}` });
      return true;
    }

    if (parsed.action === 'ok') {
      const { slotDays, slotHourMsk } = await this.settings.get();
      const slot = nextSlotAfter(new Date(), slotDays, slotHourMsk);
      await this.pg.query(
        `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now() WHERE id = $1`,
        [post.id, slot.toISOString()],
      );
      await this.tg.answerCallbackQuery(cb.id, { text: 'Одобрено' });
      return true;
    }

    if (parsed.action === 'no') {
      await this.pg.query(
        `UPDATE blog_post SET status = 'rejected', updated_at = now() WHERE id = $1`,
        [post.id],
      );
      await this.tg.answerCallbackQuery(cb.id, { text: 'В мусор' });
      return true;
    }

    await this.pg.query(
      `UPDATE blog_post SET status = 'drafting', updated_at = now() WHERE id = $1`,
      [post.id],
    );
    await this.tg.answerCallbackQuery(cb.id, { text: 'Перепишу к следующему тику' });
    return true;
  }

  /**
   * Правка текста реплаем.
   * @returns true, если сообщение — правка черновика. false означает «это не
   * наше», и вызывающий код обязан пустить текст обычным путём к ассистенту.
   */
  async handleReplyEdit(msg: any): Promise<boolean> {
    const replyTo = msg?.reply_to_message?.message_id;
    const text = String(msg?.text || '').trim();
    if (!replyTo || !text) return false;

    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE review_chat_id = $1 AND review_message_id = $2 AND status = 'pending_review'
        LIMIT 1`,
      [Number(msg.chat.id), Number(replyTo)],
    );
    if (!r.rows.length) return false;

    const post = rowToPost(r.rows[0]);
    await this.pg.query(
      `UPDATE blog_post SET body = $2, updated_at = now() WHERE id = $1`,
      [post.id, text],
    );
    await this.tg.sendMessage(Number(msg.chat.id), 'Текст заменил. Жми «Опубликовать», когда готов.');
    return true;
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog-approval.service.spec.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog-approval.service.ts src/blog/blog-approval.service.spec.ts
git commit -m "feat(blog): апрув черновика кнопками и правка реплаем"
```

---

## Task 15: Врезка в бота

**Files:**
- Modify: `src/tg-bot/tg-bot.service.ts`
- Modify: `src/tg-bot/tg-bot.module.ts`
- Test: `src/tg-bot/tg-bot.blog-routing.spec.ts`

Модуль блога импортирует `TgGrammyClient`, а бот вызывает `BlogApprovalService` — получится цикл модулей. Разрываем через `forwardRef` на стороне бота.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-bot.blog-routing.spec.ts
import { shouldRouteToBlog } from './tg-bot.service';

describe('shouldRouteToBlog', () => {
  it('callback с префиксом blog: уходит в блог', () => {
    expect(shouldRouteToBlog('blog:ok:p1')).toBe(true);
  });

  it('callback ассистента не уходит в блог', () => {
    expect(shouldRouteToBlog('agent:5')).toBe(false);
    expect(shouldRouteToBlog('lang:ru')).toBe(false);
    expect(shouldRouteToBlog('agents_page:1')).toBe(false);
  });

  it('пустые данные не уходят в блог', () => {
    expect(shouldRouteToBlog('')).toBe(false);
    expect(shouldRouteToBlog(undefined as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/tg-bot/tg-bot.blog-routing.spec.ts`
Expected: FAIL — `shouldRouteToBlog is not a function`

- [ ] **Step 3: Добавить хелпер и врезки в `tg-bot.service.ts`**

В начало файла, рядом с другими экспортами:

```typescript
/** Кнопки блога приходят тем же вебхуком, что и кнопки ассистентов. */
export function shouldRouteToBlog(data?: string): boolean {
  return String(data || '').startsWith('blog:');
}
```

В `handleCallbackQuery`, **первым** условием — до `agent:` и остальных, и до проверки `ownerId`, потому что владелец блога определяется не через связку ассистентов:

```typescript
  private async handleCallbackQuery(cb: any): Promise<void> {
    const data = String(cb.data || '');

    if (shouldRouteToBlog(data)) {
      await this.blogApproval.handleCallback(cb);
      return;
    }

    const ownerId = await this.identity.getLinkeonIdByTgUserId(cb.from.id);
    if (!ownerId) return;
    // ... существующие ветки без изменений
```

В обработчике личных сообщений — до того, как текст уйдёт ассистенту. Найти место, где приватный текст роутится в `tg-router`, и поставить перед ним:

```typescript
    // Реплай на черновик блога — это правка поста, а не реплика ассистенту.
    if (await this.blogApproval.handleReplyEdit(msg)) return;
```

В конструкторе `TgBotService` добавить зависимость:

```typescript
    @Inject(forwardRef(() => BlogApprovalService))
    private readonly blogApproval: BlogApprovalService,
```

с импортами `Inject, forwardRef` из `@nestjs/common` и `BlogApprovalService` из `../blog/blog-approval.service`.

- [ ] **Step 4: Подключить модуль**

В `src/tg-bot/tg-bot.module.ts` добавить в `imports`:

```typescript
    forwardRef(() => BlogModule),
```

- [ ] **Step 5: Запустить тест**

Run: `npx jest src/tg-bot/tg-bot.blog-routing.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 6: Прогнать соседние тесты бота — врезка не должна ломать роутинг**

Run: `npx jest src/tg-bot --silent`
Expected: столько же зелёных, сколько было до правки. Если что-то покраснело — это регрессия от врезки, чинить до коммита.

- [ ] **Step 7: Коммит**

```bash
git add src/tg-bot/
git commit -m "feat(blog): роутинг кнопок и правок блога в tg-боте"
```

---

## Task 16: Крон

**Files:**
- Create: `src/blog/blog.cron.ts`
- Test: `src/blog/blog.cron.spec.ts`

> **Требование ко всем записям статуса в этой задаче:** переход должен
> проходить через `canTransition` из `./blog.types`, как в
> `BlogApprovalService`. Мёртвая машина состояний с зелёными тестами хуже
> отсутствующей — она создаёт ложную уверенность. Проверяется мутацией.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog.cron.spec.ts
import { BlogCron } from './blog.cron';

const deps = () => ({
  pg: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  topics: { takeNextIdea: jest.fn().mockResolvedValue(null), addTopic: jest.fn(), topAssistants: jest.fn().mockResolvedValue([]), recentTitles: jest.fn().mockResolvedValue([]) },
  editor: { draft: jest.fn() },
  images: { render: jest.fn() },
  publisher: { publish: jest.fn() },
  approval: { sendForReview: jest.fn() },
  settings: { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) },
  git: { weeklyCommits: jest.fn().mockResolvedValue([]) },
});

const make = (d: any) => new BlogCron(d.pg, d.topics, d.editor, d.images, d.publisher, d.approval, d.settings, d.git);

describe('BlogCron при выключенном флаге', () => {
  const OLD = process.env.BLOG_ENABLED;
  afterEach(() => { process.env.BLOG_ENABLED = OLD; });

  it('не делает ничего, когда BLOG_ENABLED не выставлен', async () => {
    process.env.BLOG_ENABLED = '';
    const d = deps();
    await make(d).prepareDrafts();
    await make(d).publishDue();
    expect(d.topics.takeNextIdea).not.toHaveBeenCalled();
    expect(d.publisher.publish).not.toHaveBeenCalled();
  });
});

describe('BlogCron.prepareDrafts', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; process.env.BLOG_APPROVER_TG_ID = '77'; });

  it('берёт идею, просит текст и картинку, отправляет на апрув', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null });
    d.editor.draft.mockResolvedValue({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
    d.images.render.mockResolvedValue('https://minio/i.png');

    await make(d).prepareDrafts();

    expect(d.editor.draft).toHaveBeenCalled();
    expect(d.images.render).toHaveBeenCalledWith('З', 'сцена');
    expect(d.approval.sendForReview).toHaveBeenCalled();
  });

  it('отказ редактора переводит пост в failed и не зовёт картинку', async () => {
    const d = deps();
    d.topics.takeNextIdea.mockResolvedValue({ id: 'p1', rubric: 'case', topicKey: 'k', topicHint: null });
    d.editor.draft.mockRejectedValue(new Error('релей молчит'));

    await make(d).prepareDrafts();

    expect(d.images.render).not.toHaveBeenCalled();
    const sqls = d.pg.query.mock.calls.map((c: any) => String(c[0]));
    expect(sqls.some((s) => s.includes("status = 'failed'"))).toBe(true);
  });

  it('без идей в очереди тихо выходит', async () => {
    const d = deps();
    await make(d).prepareDrafts();
    expect(d.editor.draft).not.toHaveBeenCalled();
  });
});

describe('BlogCron.publishDue', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; });

  it('публикует только посты, у которых слот наступил', async () => {
    const d = deps();
    d.pg.query.mockResolvedValueOnce({ rows: [{ id: 'p1', rubric: 'case', source: 'stats', topic_key: 'k', status: 'approved', attempts: 0, image_url: 'u', title: 'З', body: 'Т' }] });
    d.publisher.publish.mockResolvedValue({ ok: true });

    await make(d).publishDue();

    const sql = String(d.pg.query.mock.calls[0][0]);
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('slot_at <= now()');
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });
});

describe('BlogCron.dropStaleNews', () => {
  beforeEach(() => { process.env.BLOG_ENABLED = 'true'; });

  it('выбрасывает новости старше двух недель', async () => {
    const d = deps();
    await make(d).dropStaleNews();
    const sql = String(d.pg.query.mock.calls[0][0]);
    expect(sql).toContain("rubric = 'news'");
    expect(sql).toContain("status = 'rejected'");
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog.cron.spec.ts`
Expected: FAIL — `Cannot find module './blog.cron'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog.cron.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { BlogTopicService, normalizeTopicKey } from './blog-topic.service';
import { BlogEditorService } from './blog-editor.service';
import { BlogImageService } from './blog-image.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogApprovalService } from './blog-approval.service';
import { BlogSettingsService } from './blog-settings.service';
import { BlogGitSource } from './blog-git.source';
import { rowToPost } from './blog.types';
import { STALE_NEWS_DAYS } from './blog-slots';

const MAX_PUBLISH_ATTEMPTS = 3;

@Injectable()
export class BlogCron {
  private readonly logger = new Logger(BlogCron.name);

  constructor(
    private readonly pg: PgService,
    private readonly topics: BlogTopicService,
    private readonly editor: BlogEditorService,
    private readonly images: BlogImageService,
    private readonly publisher: BlogPublisherService,
    private readonly approval: BlogApprovalService,
    private readonly settings: BlogSettingsService,
    private readonly git: BlogGitSource,
  ) {}

  /**
   * Рубильник уровня деплоя. Намеренно в env, а не в админке: если модуль
   * начнёт чудить, гасить его через ту же админку — плохая идея.
   */
  private enabled(): boolean {
    return String(process.env.BLOG_ENABLED || '').toLowerCase() === 'true';
  }

  private approverChatId(): number | null {
    const raw = process.env.BLOG_APPROVER_TG_ID;
    return raw ? Number(raw) : null;
  }

  /** Воскресенье 09:00 МСК. Порядок важен: сначала темы, потом черновик к понедельнику. */
  @Cron('0 6 * * 0')
  async refillTopics(): Promise<void> {
    if (!this.enabled()) return;
    try {
      for (const c of await this.git.weeklyCommits()) {
        await this.topics.addTopic({
          rubric: 'news', source: 'git', sourceRef: `commit:${c.sha}`,
          topicKey: normalizeTopicKey(c.subject), topicHint: c.subject,
        });
      }
      for (const a of await this.topics.topAssistants(3)) {
        await this.topics.addTopic({
          rubric: 'case', source: 'stats', sourceRef: `stats:${a.agentId}`,
          topicKey: normalizeTopicKey(`кейс ${a.agentName} ${new Date().toISOString().slice(0, 10)}`),
          topicHint: `На этой неделе чаще всего обращались к ассистенту «${a.agentName}» (${a.turns} обращений). Придумай кейс по его профилю.`,
        });
      }
    } catch (e: any) {
      this.logger.error(`пополнение тем сорвалось: ${e.message}`);
    }
  }

  /** Каждый час: если до слота меньше суток, а черновика нет — готовим. */
  @Cron('0 * * * *')
  async prepareDrafts(): Promise<void> {
    if (!this.enabled()) return;

    const pending = await this.pg.query(
      `SELECT count(*)::int AS n FROM blog_post WHERE status IN ('pending_review','approved')`,
    );
    if (Number(pending.rows[0]?.n || 0) > 0) return;

    const idea = await this.topics.takeNextIdea();
    if (!idea) return;

    await this.pg.query(`UPDATE blog_post SET status = 'drafting', updated_at = now() WHERE id = $1`, [idea.id]);

    try {
      const draft = await this.editor.draft(idea);
      const imageUrl = await this.images.render(draft.title, draft.imagePrompt);

      const saved = await this.pg.query(
        `UPDATE blog_post
            SET title = $2, body = $3, image_prompt = $4, image_url = $5, last_error = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [idea.id, draft.title, draft.body, draft.imagePrompt, imageUrl],
      );

      const chatId = this.approverChatId();
      if (!chatId) {
        this.logger.error('BLOG_APPROVER_TG_ID не задан — черновик готов, но показать его некому');
        return;
      }
      await this.approval.sendForReview(rowToPost(saved.rows[0]), chatId);
    } catch (e: any) {
      await this.pg.query(
        `UPDATE blog_post SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [idea.id, String(e.message).slice(0, 500)],
      );
      this.logger.error(`черновик ${idea.id} не собрался: ${e.message}`);
      const chatId = this.approverChatId();
      if (chatId) {
        await this.approval['tg'].sendMessage(chatId, `Блог: черновик не собрался — ${e.message}`).catch(() => {});
      }
    }
  }

  /** Каждые 5 минут: публикуем всё, у чего слот наступил. */
  @Cron('*/5 * * * *')
  async publishDue(): Promise<void> {
    if (!this.enabled()) return;

    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE status = 'approved' AND slot_at IS NOT NULL AND slot_at <= now()
          AND attempts < $1
        ORDER BY slot_at ASC LIMIT 5`,
      [MAX_PUBLISH_ATTEMPTS],
    );
    for (const row of r.rows) {
      await this.publisher.publish(rowToPost(row));
    }
  }

  /** Раз в сутки: протухшие новости в мусор. */
  @Cron('0 4 * * *')
  async dropStaleNews(): Promise<void> {
    if (!this.enabled()) return;
    const r = await this.pg.query(
      `UPDATE blog_post
          SET status = 'rejected', last_error = 'протухла', updated_at = now()
        WHERE rubric = 'news'
          AND status IN ('idea','pending_review','approved')
          AND created_at < now() - ($1 || ' days')::interval
        RETURNING id`,
      [STALE_NEWS_DAYS],
    );
    if (r.rows.length) this.logger.log(`выброшено протухших новостей: ${r.rows.length}`);
  }

  /** За час до слота — напоминание, если решения нет. Молчание не публикует. */
  @Cron('0 * * * *')
  async remindPending(): Promise<void> {
    if (!this.enabled()) return;
    const chatId = this.approverChatId();
    if (!chatId) return;

    const { slotDays, slotHourMsk } = await this.settings.get();
    const r = await this.pg.query(
      `SELECT id, title FROM blog_post WHERE status = 'pending_review' ORDER BY created_at ASC LIMIT 1`,
    );
    if (!r.rows.length) return;

    const { nextSlotAfter } = await import('./blog-slots');
    const slot = nextSlotAfter(new Date(), slotDays, slotHourMsk);
    const minutesLeft = Math.round((slot.getTime() - Date.now()) / 60000);
    if (minutesLeft > 60 || minutesLeft < 0) return;

    await this.approval['tg']
      .sendMessage(chatId, `Блог: через час слот, а пост «${r.rows[0].title}» без решения. Без апрува слот пропустим.`)
      .catch(() => {});
  }
}
```

Обращение `this.approval['tg']` — сознательный компромисс, чтобы не тянуть в крон отдельную зависимость на grammy ради двух сообщений. Если при код-ревью это не понравится, вынести в `BlogApprovalService.notify(chatId, text)` и звать метод.

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog.cron.spec.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog.cron.ts src/blog/blog.cron.spec.ts
git commit -m "feat(blog): расписание — темы, черновики, публикация, напоминания"
```

---

## Task 17: Админский API

**Files:**
- Create: `src/blog/blog.controller.ts`
- Test: `src/blog/blog.controller.spec.ts`

> **Требование ко всем записям статуса в этой задаче:** переход должен
> проходить через `canTransition` из `./blog.types`, как это сделано в
> `BlogApprovalService`. Иначе машина состояний снова превращается в мёртвый
> код с зелёными тестами, который читается как гарантия «пост не выйдет
> минуя апрув» и ничего не охраняет. Проверяется мутацией: `canTransition`,
> всегда возвращающий `true`, обязан покрасить хотя бы один тест.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/blog/blog.controller.spec.ts
import { BlogController } from './blog.controller';
import { ConflictException } from '@nestjs/common';

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const rawRow = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
  lang: 'ru', title: 'З', body: 'Т', image_prompt: 'сцена', image_url: 'u',
  status: 'pending_review', slot_at: null, published_at: null, review_chat_id: null, review_message_id: null,
  tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
  created_at: '2026-09-21T10:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z', ...over,
});

const deps = () => ({
  pg: { query: jest.fn().mockResolvedValue({ rows: [rawRow()] }) },
  topics: { addTopic: jest.fn().mockResolvedValue({ id: 'new' }) },
  settings: { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }), update: jest.fn().mockResolvedValue({}) },
  images: { render: jest.fn().mockResolvedValue('https://minio/new.png') },
});

const make = (d: any) => new BlogController(d.pg, d.topics, d.settings, d.images);

describe('BlogController', () => {
  it('list отдаёт очередь', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'list' }, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('add_topic заводит ручную тему с источником manual', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'add_topic', rubric: 'case', topic: 'про аренду' }, r);
    expect(d.topics.addTopic).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
  });

  it('update_text с верной версией сохраняет текст', async () => {
    const d = deps(); const r = res();
    await make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T10:00:00.000Z',
    }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain('UPDATE blog_post');
  });

  it('update_text с устаревшей версией отдаёт 409, а не затирает чужую правку', async () => {
    const d = deps(); const r = res();
    await expect(make(d).action({
      action: 'update_text', id: 'p1', title: 'Новый', body: 'Новое',
      updatedAt: '2026-09-21T09:00:00.000Z',
    }, r)).rejects.toBeInstanceOf(ConflictException);
  });

  it('approve назначает слот', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'approve', id: 'p1' }, r);
    expect(d.pg.query.mock.calls[1][0]).toContain("status = 'approved'");
  });

  it('неизвестное действие — 400', async () => {
    const d = deps(); const r = res();
    await make(d).action({ action: 'взорви_всё' }, r);
    expect(r.status).toHaveBeenCalledWith(400);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/blog/blog.controller.spec.ts`
Expected: FAIL — `Cannot find module './blog.controller'`

- [ ] **Step 3: Реализация**

```typescript
// src/blog/blog.controller.ts
import { Controller, Post, Body, Res, UseGuards, ConflictException, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PgService } from '../common/services/pg.service';
import { BlogTopicService, normalizeTopicKey } from './blog-topic.service';
import { BlogSettingsService } from './blog-settings.service';
import { BlogImageService } from './blog-image.service';
import { rowToPost } from './blog.types';
import { nextSlotAfter } from './blog-slots';

/**
 * Действия в одном POST — тот же стиль, что у admin/backlog и admin/coupons.
 * Фронтовая вкладка говорит только с этим эндпоинтом.
 */
@Controller('')
export class BlogController {
  constructor(
    private readonly pg: PgService,
    private readonly topics: BlogTopicService,
    private readonly settings: BlogSettingsService,
    private readonly images: BlogImageService,
  ) {}

  @Post('admin/blog')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};

    switch (action) {
      case 'list': {
        const r = await this.pg.query(
          `SELECT * FROM blog_post
            WHERE status NOT IN ('published','rejected')
            ORDER BY (status = 'pending_review') DESC, slot_at NULLS LAST, created_at ASC
            LIMIT 100`,
        );
        return res.status(200).json(r.rows.map(rowToPost));
      }

      case 'archive': {
        const r = await this.pg.query(
          `SELECT * FROM blog_post
            WHERE status IN ('published','rejected','failed')
            ORDER BY coalesce(published_at, updated_at) DESC LIMIT 100`,
        );
        return res.status(200).json(r.rows.map(rowToPost));
      }

      case 'add_topic': {
        const post = await this.topics.addTopic({
          rubric: data.rubric === 'news' ? 'news' : 'case',
          source: 'manual',
          topicKey: normalizeTopicKey(String(data.topic || '')),
          topicHint: String(data.topic || ''),
        });
        return res.status(200).json(post ?? { skipped: 'дубль темы за последние 90 дней' });
      }

      case 'update_text': {
        const post = await this.load(String(data.id));
        this.assertVersion(post.updatedAt, data.updatedAt);
        await this.pg.query(
          `UPDATE blog_post SET title = $2, body = $3, updated_at = now() WHERE id = $1`,
          [post.id, String(data.title || ''), String(data.body || '')],
        );
        return res.status(200).json(await this.load(post.id));
      }

      case 'regenerate_image': {
        const post = await this.load(String(data.id));
        const url = await this.images.render(post.title || '', post.imagePrompt || post.topicKey);
        await this.pg.query(`UPDATE blog_post SET image_url = $2, updated_at = now() WHERE id = $1`, [post.id, url]);
        return res.status(200).json(await this.load(post.id));
      }

      case 'approve': {
        const post = await this.load(String(data.id));
        const { slotDays, slotHourMsk } = await this.settings.get();
        const slot = data.slotAt ? new Date(data.slotAt) : nextSlotAfter(new Date(), slotDays, slotHourMsk);
        await this.pg.query(
          `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now() WHERE id = $1`,
          [post.id, slot.toISOString()],
        );
        return res.status(200).json(await this.load(post.id));
      }

      case 'reject': {
        const post = await this.load(String(data.id));
        await this.pg.query(`UPDATE blog_post SET status = 'rejected', updated_at = now() WHERE id = $1`, [post.id]);
        return res.status(200).json(await this.load(post.id));
      }

      case 'redraft': {
        const post = await this.load(String(data.id));
        await this.pg.query(`UPDATE blog_post SET status = 'drafting', updated_at = now() WHERE id = $1`, [post.id]);
        return res.status(200).json(await this.load(post.id));
      }

      case 'get_settings':
        return res.status(200).json(await this.settings.get());

      case 'update_settings':
        return res.status(200).json(await this.settings.update({
          channelChatId: data.channelChatId,
          slotDays: data.slotDays,
          slotHourMsk: data.slotHourMsk,
          imageStyle: data.imageStyle,
        }));

      default:
        return res.status(400).json({ error: `неизвестное действие: ${action}` });
    }
  }

  private async load(id: string) {
    const r = await this.pg.query(`SELECT * FROM blog_post WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException(`пост ${id} не найден`);
    return rowToPost(r.rows[0]);
  }

  /** Вторая вкладка админки не должна молча затирать правку первой. */
  private assertVersion(current: string, sent?: string): void {
    if (!sent) return;
    if (new Date(current).getTime() !== new Date(sent).getTime()) {
      throw new ConflictException('пост изменился в другом месте — обнови страницу');
    }
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `npx jest src/blog/blog.controller.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/blog/blog.controller.ts src/blog/blog.controller.spec.ts
git commit -m "feat(blog): админский API управления блогом"
```

---

## Task 18: Сборка модуля

**Files:**
- Create: `src/blog/blog.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Модуль**

```typescript
// src/blog/blog.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { BlogController } from './blog.controller';
import { BlogSettingsService } from './blog-settings.service';
import { BlogTopicService } from './blog-topic.service';
import { BlogGitSource } from './blog-git.source';
import { BlogRelayClient } from './blog-relay.client';
import { BlogEditorService } from './blog-editor.service';
import { BlogImageService } from './blog-image.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogApprovalService } from './blog-approval.service';
import { BlogCron } from './blog.cron';

@Module({
  imports: [CommonModule, MiscModule, forwardRef(() => TgBotModule)],
  controllers: [BlogController],
  providers: [
    BlogSettingsService, BlogTopicService, BlogGitSource, BlogRelayClient,
    BlogEditorService, BlogImageService, BlogPublisherService, BlogApprovalService, BlogCron,
  ],
  exports: [BlogApprovalService],
})
export class BlogModule {}
```

- [ ] **Step 2: Подключить в `src/app.module.ts`**

Добавить импорт рядом с `BacklogModule`:

```typescript
import { BlogModule } from './blog/blog.module';
```

и в массив `imports`, после `BacklogModule`:

```typescript
    BlogModule,
```

- [ ] **Step 3: Проверить, что приложение собирается и граф зависимостей сходится**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: без ошибок

Run: `npx jest src/blog --silent`
Expected: все тесты блога зелёные

Циклическая зависимость `BlogModule ↔ TgBotModule` закрыта `forwardRef` с обеих сторон. Если Nest на старте ругается `Nest can't resolve dependencies`, значит `forwardRef` проставлен только с одной — проверить обе.

- [ ] **Step 4: Коммит**

```bash
git add src/blog/blog.module.ts src/app.module.ts
git commit -m "feat(blog): сборка и подключение модуля"
```

---

## Task 23: Источник «бэклог → done»

**Files:**
- Modify: `src/backlog/backlog.service.ts`
- Test: `src/backlog/backlog.blog-topic.spec.ts`

Выполняется сразу после Task 18, до фронтовой части.

Точка врезки — метод `update()`, там уже снимается снимок статуса «до» ради авто-уведомления тикета:

```typescript
    const before = await this.pg.query(
      `SELECT status, title, from_ticket_id FROM backlog_items WHERE id = $1`,
      [id],
    );
```

Тему заводим **прямым SQL**, без инъекции `BlogTopicService`. Это не срезание угла, а следование решению, уже принятому в этом файле: авто-уведомление тикета точно так же пишет в `support_messages` напрямую, чтобы не создавать зависимость `backlog → support`. Зависимость `backlog → blog` была бы ровно такой же лишней связностью.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/backlog/backlog.blog-topic.spec.ts
import { shouldCreateBlogTopic, blogTopicFromBacklog } from './backlog.service';

describe('shouldCreateBlogTopic', () => {
  it('переход в done рождает тему', () => {
    expect(shouldCreateBlogTopic('in_progress', 'done')).toBe(true);
  });

  it('done → done повторно тему не рождает', () => {
    expect(shouldCreateBlogTopic('done', 'done')).toBe(false);
  });

  it('переход в любой другой статус тему не рождает', () => {
    expect(shouldCreateBlogTopic('proposed', 'approved')).toBe(false);
    expect(shouldCreateBlogTopic('in_progress', 'rejected')).toBe(false);
  });

  it('отсутствие прежнего статуса не рождает тему', () => {
    expect(shouldCreateBlogTopic(undefined, 'done')).toBe(false);
  });
});

describe('blogTopicFromBacklog', () => {
  it('подсказка собирается из заголовка и анализа', () => {
    const t = blogTopicFromBacklog('id1', 'Голосовой ввод', 'Длинный анализ фичи');
    expect(t.sourceRef).toBe('backlog:id1');
    expect(t.topicHint).toContain('Голосовой ввод');
    expect(t.topicHint).toContain('Длинный анализ');
  });

  it('анализ обрезается до 500 символов — в промпт не нужен весь отчёт', () => {
    const t = blogTopicFromBacklog('id1', 'Т', 'я'.repeat(2000));
    expect(t.topicHint.length).toBeLessThan(700);
  });

  it('пустой анализ не ломает подсказку', () => {
    expect(blogTopicFromBacklog('id1', 'Заголовок', '').topicHint).toContain('Заголовок');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `npx jest src/backlog/backlog.blog-topic.spec.ts`
Expected: FAIL — `shouldCreateBlogTopic is not a function`

- [ ] **Step 3: Добавить экспортируемые хелперы в `backlog.service.ts`**

Вставить над `@Injectable()`:

```typescript
/**
 * Тема для блога рождается ровно на переходе в done — не на каждом
 * сохранении итема, который уже done, иначе канал получит один и тот же
 * анонс столько раз, сколько владелец правил карточку.
 */
export function shouldCreateBlogTopic(prev: string | undefined, next: string): boolean {
  return !!prev && prev !== 'done' && next === 'done';
}

export function blogTopicFromBacklog(id: string, title: string, analysisMd: string) {
  const analysis = String(analysisMd || '').trim().slice(0, 500);
  return {
    sourceRef: `backlog:${id}`,
    topicKey: String(title || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'),
    topicHint: analysis ? `${title}\n\n${analysis}` : title,
  };
}
```

- [ ] **Step 4: Врезать создание темы в `update()`**

Сразу после блока авто-уведомления тикета, перед `return updated;`:

```typescript
    // Новая тема для блога. Пишем напрямую в blog_post по той же причине,
    // по которой выше пишем прямо в support_messages: модульная зависимость
    // backlog → blog здесь лишняя.
    if (shouldCreateBlogTopic(prev?.status, updated.status)) {
      try {
        const topic = blogTopicFromBacklog(id, updated.title, updated.analysis_md);
        await this.pg.query(
          `INSERT INTO blog_post (rubric, source, source_ref, topic_key, topic_hint, status)
           SELECT 'news', 'backlog', $1, $2, $3, 'idea'
            WHERE NOT EXISTS (
              SELECT 1 FROM blog_post WHERE source_ref = $1
            )`,
          [topic.sourceRef, topic.topicKey, topic.topicHint],
        );
        this.logger.log(`Blog topic queued for backlog ${id}`);
      } catch (e: any) {
        // Блог не должен ронять закрытие задачи в бэклоге.
        this.logger.warn(`Failed to queue blog topic for backlog ${id}: ${e.message}`);
      }
    }
```

`WHERE NOT EXISTS` по `source_ref` — защита от повторного анонса, если итем вернут в работу и снова закроют. Обычная дедупликация по `topic_key` тут не сработает: у неё окно 90 дней, а бэклог-итем может пережить и больше.

- [ ] **Step 5: Запустить тесты**

Run: `npx jest src/backlog --silent`
Expected: новые 7 тестов зелёные, существующие тесты бэклога не покраснели.

- [ ] **Step 6: Проверить типы**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: без ошибок

- [ ] **Step 7: Коммит**

```bash
git add src/backlog/
git commit -m "feat(blog): закрытая задача бэклога рождает тему для канала"
```

---

## Task 19: Фронт — ярлыки статусов

**Files:**
- Create: `spirits_front/src/components/admin/blogStatus.ts`
- Test: `spirits_front/src/components/admin/blogStatus.test.ts`

Дальше работа идёт в репозитории `spirits_front`. Ветка там своя, с тем же именем `feat/tg-blog`.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/components/admin/blogStatus.test.ts
import { describe, it, expect } from 'vitest';
import { statusLabel, statusTone, isQueue, isArchive } from './blogStatus';

describe('statusLabel', () => {
  it('переводит статусы на русский', () => {
    expect(statusLabel('pending_review')).toBe('На апруве');
    expect(statusLabel('published')).toBe('Опубликован');
  });

  it('неизвестный статус отдаёт сам себя, а не падает', () => {
    expect(statusLabel('что-то новое' as any)).toBe('что-то новое');
  });
});

describe('statusTone', () => {
  it('failed красный, published зелёный', () => {
    expect(statusTone('failed')).toContain('red');
    expect(statusTone('published')).toContain('green');
  });
});

describe('группировка', () => {
  it('очередь — всё, что ещё не вышло', () => {
    expect(isQueue('idea')).toBe(true);
    expect(isQueue('pending_review')).toBe(true);
    expect(isQueue('approved')).toBe(true);
    expect(isQueue('published')).toBe(false);
  });

  it('архив — опубликованное, отклонённое и сорвавшееся', () => {
    expect(isArchive('published')).toBe(true);
    expect(isArchive('rejected')).toBe(true);
    expect(isArchive('failed')).toBe(true);
    expect(isArchive('idea')).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что падает**

Run: `pnpm vitest run src/components/admin/blogStatus.test.ts`
Expected: FAIL — файл не найден

- [ ] **Step 3: Реализация**

```typescript
// src/components/admin/blogStatus.ts
export type BlogStatus =
  | 'idea' | 'drafting' | 'pending_review' | 'approved'
  | 'publishing' | 'published' | 'rejected' | 'failed';

const LABELS: Record<BlogStatus, string> = {
  idea: 'Тема',
  drafting: 'Пишется',
  pending_review: 'На апруве',
  approved: 'Запланирован',
  publishing: 'Публикуется',
  published: 'Опубликован',
  rejected: 'В мусоре',
  failed: 'Сорвался',
};

const TONES: Record<BlogStatus, string> = {
  idea: 'bg-gray-100 text-gray-700',
  drafting: 'bg-blue-100 text-blue-700',
  pending_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-forest-100 text-forest-700',
  publishing: 'bg-blue-100 text-blue-700',
  published: 'bg-green-100 text-green-700',
  rejected: 'bg-gray-100 text-gray-500',
  failed: 'bg-red-100 text-red-700',
};

export function statusLabel(status: BlogStatus): string {
  return LABELS[status] ?? String(status);
}

export function statusTone(status: BlogStatus): string {
  return TONES[status] ?? 'bg-gray-100 text-gray-700';
}

const ARCHIVE: BlogStatus[] = ['published', 'rejected', 'failed'];

export function isArchive(status: BlogStatus): boolean {
  return ARCHIVE.includes(status);
}

export function isQueue(status: BlogStatus): boolean {
  return !isArchive(status);
}
```

- [ ] **Step 4: Запустить тест**

Run: `pnpm vitest run src/components/admin/blogStatus.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/components/admin/blogStatus.ts src/components/admin/blogStatus.test.ts
git commit -m "feat(blog): ярлыки статусов постов в админке"
```

---

## Task 20: Фронт — вкладка «Блог»

**Files:**
- Create: `spirits_front/src/components/admin/AdminBlogView.tsx`

- [ ] **Step 1: Компонент**

```tsx
// src/components/admin/AdminBlogView.tsx
import { useEffect, useState } from 'react';
import { apiClient } from '../../services/apiClient';
import { statusLabel, statusTone, isQueue, BlogStatus } from './blogStatus';

interface BlogPost {
  id: string;
  rubric: 'news' | 'case';
  source: string;
  topicKey: string;
  topicHint: string | null;
  title: string | null;
  body: string | null;
  imageUrl: string | null;
  status: BlogStatus;
  slotAt: string | null;
  tgUrl: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface BlogSettings {
  channelChatId: string | null;
  slotDays: number[];
  slotHourMsk: number;
  imageStyle: string;
}

type Screen = 'queue' | 'archive' | 'settings';

const call = async (payload: any) => {
  const r = await apiClient.post('/webhook/admin/blog', payload);
  if (r.status === 409) throw new Error('Пост изменился в другом месте — обнови страницу');
  if (!r.ok) throw new Error(`Ошибка ${r.status}`);
  return r.json();
};

export default function AdminBlogView() {
  const [screen, setScreen] = useState<Screen>('queue');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [settings, setSettings] = useState<BlogSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [editing, setEditing] = useState<Record<string, { title: string; body: string }>>({});

  const load = async () => {
    setBusy(true); setError(null);
    try {
      if (screen === 'settings') setSettings(await call({ action: 'get_settings' }));
      else setPosts(await call({ action: screen === 'queue' ? 'list' : 'archive' }));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  useEffect(() => { load(); }, [screen]);

  const act = async (payload: any) => {
    setBusy(true); setError(null);
    try { await call(payload); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="admin-blog" className="h-full overflow-y-auto p-4">
      <div className="flex gap-2 mb-4">
        {(['queue', 'archive', 'settings'] as Screen[]).map((s) => (
          <button
            key={s}
            data-testid={`blog-screen-${s}`}
            onClick={() => setScreen(s)}
            className={`px-3 py-1.5 text-sm rounded ${screen === s ? 'bg-forest-600 text-white' : 'bg-gray-100 text-gray-700'}`}
          >
            {s === 'queue' ? 'Очередь' : s === 'archive' ? 'Архив' : 'Настройки'}
          </button>
        ))}
      </div>

      {error && <div className="mb-3 p-2 bg-red-50 text-red-700 text-sm rounded">{error}</div>}
      {busy && <div className="mb-3 text-sm text-gray-500">Загрузка…</div>}

      {screen === 'queue' && (
        <div className="mb-4 flex gap-2">
          <input
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            placeholder="Своя тема одной строкой"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
          />
          <button
            onClick={async () => { await act({ action: 'add_topic', rubric: 'case', topic: newTopic }); setNewTopic(''); }}
            disabled={!newTopic.trim() || busy}
            className="px-4 py-2 bg-forest-600 text-white text-sm rounded disabled:opacity-50"
          >
            Добавить
          </button>
        </div>
      )}

      {screen === 'settings' && settings && (
        <div className="space-y-3 max-w-lg">
          <label className="block text-sm">
            <span className="text-gray-600">Канал (chat id или @handle)</span>
            <input
              value={settings.channelChatId ?? ''}
              onChange={(e) => setSettings({ ...settings, channelChatId: e.target.value })}
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Дни слотов (1=пн … 7=вс, через запятую)</span>
            <input
              value={settings.slotDays.join(',')}
              onChange={(e) => setSettings({ ...settings, slotDays: e.target.value.split(',').map((x) => Number(x.trim())).filter(Boolean) })}
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Час слота по Москве</span>
            <input
              type="number" min={0} max={23}
              value={settings.slotHourMsk}
              onChange={(e) => setSettings({ ...settings, slotHourMsk: Number(e.target.value) })}
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Фирменный стиль картинок</span>
            <textarea
              value={settings.imageStyle}
              onChange={(e) => setSettings({ ...settings, imageStyle: e.target.value })}
              rows={3}
              className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={() => act({ action: 'update_settings', ...settings })}
            disabled={busy}
            className="px-4 py-2 bg-forest-600 text-white text-sm rounded disabled:opacity-50"
          >
            Сохранить
          </button>
        </div>
      )}

      {screen !== 'settings' && (
        <div className="space-y-3">
          {posts.length === 0 && !busy && (
            <div className="text-sm text-gray-500">
              {screen === 'queue' ? 'Очередь пуста' : 'Архив пуст'}
            </div>
          )}
          {posts.map((p) => {
            const draft = editing[p.id] ?? { title: p.title ?? '', body: p.body ?? '' };
            return (
              <div key={p.id} data-testid={`blog-post-${p.id}`} className="border border-gray-200 rounded p-3 bg-white">
                <div className="flex items-start gap-3">
                  {p.imageUrl && <img src={p.imageUrl} alt="" className="w-24 h-24 object-cover rounded flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 text-xs rounded ${statusTone(p.status)}`}>{statusLabel(p.status)}</span>
                      <span className="text-xs text-gray-500">{p.rubric === 'news' ? 'Новинка' : 'Кейс'} · {p.source}</span>
                      {p.slotAt && <span className="text-xs text-gray-500">слот {new Date(p.slotAt).toLocaleString('ru-RU')}</span>}
                    </div>

                    {p.status === 'idea' || p.status === 'drafting' ? (
                      <div className="text-sm text-gray-700">{p.topicHint || p.topicKey}</div>
                    ) : (
                      <>
                        <input
                          value={draft.title}
                          onChange={(e) => setEditing({ ...editing, [p.id]: { ...draft, title: e.target.value } })}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-sm font-medium mb-1"
                        />
                        <textarea
                          value={draft.body}
                          onChange={(e) => setEditing({ ...editing, [p.id]: { ...draft, body: e.target.value } })}
                          rows={4}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-sm"
                        />
                        <div className="text-xs text-gray-400 mt-0.5">{draft.body.length} / 1000 символов подписи</div>
                      </>
                    )}

                    {p.lastError && <div className="text-xs text-red-600 mt-1">Ошибка: {p.lastError}</div>}
                    {p.tgUrl && <a href={p.tgUrl} target="_blank" rel="noreferrer" className="text-xs text-forest-600 underline">Пост в канале</a>}
                  </div>
                </div>

                {isQueue(p.status) && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button onClick={() => act({ action: 'update_text', id: p.id, title: draft.title, body: draft.body, updatedAt: p.updatedAt })}
                            disabled={busy} className="px-3 py-1 text-xs bg-gray-100 rounded">Сохранить текст</button>
                    <button onClick={() => act({ action: 'regenerate_image', id: p.id })}
                            disabled={busy} className="px-3 py-1 text-xs bg-gray-100 rounded">Перегенерировать картинку</button>
                    <button onClick={() => act({ action: 'redraft', id: p.id })}
                            disabled={busy} className="px-3 py-1 text-xs bg-gray-100 rounded">Переписать заново</button>
                    <button onClick={() => act({ action: 'approve', id: p.id })}
                            disabled={busy} className="px-3 py-1 text-xs bg-forest-600 text-white rounded">Одобрить</button>
                    <button onClick={() => act({ action: 'reject', id: p.id })}
                            disabled={busy} className="px-3 py-1 text-xs bg-red-50 text-red-700 rounded">В мусор</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `pnpm exec tsc --noEmit -p tsconfig.app.json`
Expected: без ошибок. Голый `tsc --noEmit` во фронте компилирует ноль файлов и всегда зелёный — проверять только с `-p tsconfig.app.json`.

- [ ] **Step 3: Коммит**

```bash
git add src/components/admin/AdminBlogView.tsx
git commit -m "feat(blog): вкладка управления блогом в админке"
```

---

## Task 21: Фронт — подключение вкладки и переводы

**Files:**
- Modify: `spirits_front/src/pages/AdminPage.tsx`
- Modify: `spirits_front/src/i18n/locales/{ru,en,de,es,fr,pt,zh}.json`

- [ ] **Step 1: Ключ во всех семи локалях**

В каждом файле в объект `admin.tabs` добавить строку:

| Файл | Строка |
|---|---|
| `ru.json` | `"blog": "Блог",` |
| `en.json` | `"blog": "Blog",` |
| `pt.json` | `"blog": "Blog",` |

**Только эти три.** В `de`, `es`, `fr`, `zh` секции `admin` нет вовсе, и заводить её ради одного ключа не нужно: в `scripts/check-locales.mjs` записана явная политика `UNTRANSLATED_PREFIXES = ['admin.']` — админка не локализуется, ключи `admin.*` живут в `ru.json`, а `FALLBACK_CHAIN = ['en','ru']` подставит английский ярлык. Одинокая переведённая вкладка среди английских соседей выглядела бы недоделкой, а не заботой.

Обязательный ключ — только в `ru.json`: он источник правды, и его отсутствие ловит `pnpm check-keys`.

- [ ] **Step 2: Врезка в `AdminPage.tsx` — четыре места**

Импорт рядом с остальными:

```tsx
import AdminBlogView from '../components/admin/AdminBlogView';
```

В тип `AdminTab` добавить `| 'blog'`:

```tsx
type AdminTab = 'support' | 'users' | 'payments' | 'tokens' | 'usage' | 'calls' | 'assistants' | 'coupons' | 'referrals' | 'retention' | 'activation' | 'monitoring' | 'product' | 'integrations' | 'blog';
```

В массив `KNOWN_TABS` добавить `'blog'`:

```tsx
  const KNOWN_TABS: AdminTab[] = ['support', 'users', 'payments', 'tokens', 'usage', 'calls', 'assistants', 'coupons', 'referrals', 'retention', 'activation', 'monitoring', 'product', 'integrations', 'blog'];
```

В массив `tabs` — после `integrations`:

```tsx
    { id: 'blog', label: t('admin.tabs.blog') },
```

И в рендер — после строки с `integrations`:

```tsx
        {activeTab === 'blog' && <AdminBlogView />}
```

Все четыре места обязательны. Пропустить `KNOWN_TABS` — самая частая ошибка: вкладка отрисуется, но `?tab=blog` после F5 свалится на «Поддержка», и выглядеть это будет как «раздел пропал».

- [ ] **Step 3: Проверить типы и тесты**

Run: `pnpm exec tsc --noEmit -p tsconfig.app.json`
Expected: без ошибок

Run: `pnpm vitest run src/components/admin/`
Expected: зелено, включая соседние тесты админки

- [ ] **Step 4: Проверить ключ и гейты**

```bash
pnpm check-locales && pnpm check-keys
```

Expected: оба зелёные. `check-locales` не потребует ключ в `de/es/fr/zh` — их спасает исключение `admin.`; `check-keys` проверит, что ключ есть в `ru.json`.

Убедись, что гейт не пустой: временно убери `blog` из `ru.json` и проверь, что `check-keys` краснеет с указанием `admin.tabs.blog ← src/pages/AdminPage.tsx`. Верни обратно.

- [ ] **Step 5: Коммит**

```bash
git add src/pages/AdminPage.tsx src/i18n/locales/
git commit -m "feat(blog): вкладка блога в админке и переводы"
```

---

## Task 22: Прогон на тестовой ноде

**Files:** нет изменений кода — только проверки

- [ ] **Step 1: Запушить обе ветки**

```bash
git -C ~/Downloads/spirits_back push -u origin feat/tg-blog
git -C ~/Downloads/spirits_front push -u origin feat/tg-blog
```

Использовать `git -C`, а не `cd A && ... && cd B`: рабочий каталог переносится между звеньями `&&`, и вторая половина молча отработает в первом репозитории. На этом уже теряли push фронта.

- [ ] **Step 2: Полный прогон бэка на ноде**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q origin/feat/tg-blog && source ~/.nvm/nvm.sh && npm ci && npx jest src/blog src/tg-bot --silent'
```

Expected: все тесты блога и бота зелёные.

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx tsc --noEmit -p tsconfig.build.json'
```

Expected: без вывода.

- [ ] **Step 3: Сборка фронта на ноде**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && git fetch -q origin && git checkout -q origin/feat/tg-blog && source ~/.nvm/nvm.sh && pnpm install && pnpm test && pnpm build'
```

Expected: сборка ~6 секунд, тесты зелёные.

- [ ] **Step 4: Применить миграцию на тестовой базе**

```bash
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -f ~/ci/spirits_back/src/blog/migrations/001_blog.sql && psql "$DATABASE_URL" -c "SELECT * FROM blog_settings"'
```

Expected: одна строка настроек с дефолтами.

- [ ] **Step 5: Слить в main и выкатить на test**

```bash
git -C ~/Downloads/spirits_back checkout main && git -C ~/Downloads/spirits_back merge --no-ff feat/tg-blog && git -C ~/Downloads/spirits_back push origin main
git -C ~/Downloads/spirits_front checkout main && git -C ~/Downloads/spirits_front merge --no-ff feat/tg-blog && git -C ~/Downloads/spirits_front push origin main
```

Прод и test катаются только из `main` — имя ветки в чекауте на серверах не отражает того, что там реально собрано.

**Выкат запускать только после явного согласия владельца** и отвязанно от инструмента: пайплайн идёт дольше лимита, а убитый процесс молча откатывает test на pre-deploy SHA.

```bash
TEST_ONLY=1 bash ~/Downloads/spirits_back/scripts/deploy.sh > /tmp/blog-deploy.log 2>&1 &
```

Не вешать `tail -f` на конвейер: вывод копится до конца, и лог будет пустым все десять минут.

- [ ] **Step 6: Живой цикл на тестовом стенде**

Предусловия, без которых шаг невозможен (закрываются владельцем, см. спеку):
канал существует, бот в нём администратор, известен telegram id получателя апрувов.

На тестовом сервере выставить переменные и перезапустить API:

```bash
ssh dv@85.192.61.231 'cd ~/spirits_back && grep -q BLOG_ENABLED .env || printf "BLOG_ENABLED=true\nBLOG_APPROVER_TG_ID=<id>\nBLOG_GIT_REPOS=/home/dv/spirits_back\n" >> .env && pm2 restart linkeon-api'
```

Записать chat id тестового канала через админку тестового стенда (вкладка «Блог» → Настройки).

Затем прогнать цикл руками:

1. В админке добавить тему одной строкой.
2. Дождаться часового тика либо дёрнуть подготовку вручную через `pm2 logs linkeon-api` и наблюдение за строкой `черновик ... собрался`.
3. Убедиться, что в личке пришла картинка с тремя кнопками.
4. Нажать «Переписать» — проверить, что пост вернулся в `drafting`.
5. Ответить реплаем своим текстом — проверить, что тело поста заменилось, а ассистент на это сообщение **не ответил**.
6. Нажать «Опубликовать» — проверить пост в тестовом канале и ссылку в архиве админки.
7. Нажать ту же кнопку ещё раз — проверить, что приходит «Пост уже обработан», а второго поста в канале нет.

Шаг 7 обязателен. Зелёный результат первых шести ничего не доказывает про защиту от двойной публикации — её нужно ломать нарочно.

- [ ] **Step 7: Прод**

Только после зелёного теста и **отдельного согласия владельца**: `bash ~/Downloads/spirits_back/scripts/deploy.sh` без флагов. Миграцию на проде применить через psql руками с записью в `schema_migrations` — раннер стоит на `base/001`.

`BLOG_ENABLED` на проде включать **последним**, уже после того как прод-канал заведён в настройках и апрувер прописан.

---

## Самопроверка плана

Пройдено по спеке, раздел за разделом:

| Требование спеки | Задача |
|---|---|
| Схема `blog_post`, `blog_settings`, миграция руками через psql | 1, 22 |
| Машина состояний, невозможность публикации минуя апрув | 2 |
| Слоты пн/ср/пт 10:00 МСК, протухание новостей за 14 дней | 3, 16 |
| Лимит подписи Telegram | 4 |
| Новая сессия релея на пост, прошлые заголовки в промпте | 10, 11 |
| Источники: бэклог, git, статистика | 8, 9, 16, 23 |
| Дедупликация кейсов, окно 90 дней | 8 |
| Новость вытесняет кейс | 8 (`takeNextIdea`) |
| Картинка единым стилем, фолбэк без модели | 12 |
| Публикация `sendPhoto`, атомарный захват | 13 |
| Апрув кнопками в личке, устаревшая кнопка | 14, 15 |
| Правка реплаем, отделённая от роутинга ассистенту | 14, 15 |
| Молчание не публикует, напоминание за час | 16 |
| Ретраи Telegram до трёх раз | 13, 16 |
| Админка: очередь, архив, настройки | 17, 20, 21 |
| 409 при конкурентной правке | 17, 20 |
| `BLOG_ENABLED` как рубильник в env | 16, 22 |
| Прогоны на ноде, отдельный `tsc --noEmit` | 12, 18, 22 |
| Живой цикл с попыткой сломать защиту | 22 |

Источник `backlog → done` закрыт задачей 23 ниже — её выполнять **сразу после Task 18**, до выката. Крон (Task 16) его не дёргает: это событийный источник, а не периодический.
