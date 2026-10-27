# Автопубликация роликов на YouTube — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** одобренный ролик в свой слот сам загружается на канал @Linkeons. Канал подключается и режим переключается командой `/youtube` в личке бота. Набор для ручной выкладки остаётся запасным путём.

**Architecture:** модуль `src/shorts/youtube/` — чистые функции поверх инъекции HTTP: `state`, OAuth, resumable-загрузка. `ShortsYoutubeService` хранит аккаунт (refresh-токен зашифрован `src/calendar/crypto.ts`), ведёт команду и подключение, грузит ролик для публикатора. Ветка youtube в `ShortsPublisherService` выбирает загрузку или набор. Миграция `003_youtube.sql` добавляет режим, адрес сессии загрузки и таблицу аккаунта. Публичный `GET /webhook/shorts/youtube/oauth/callback` завершает вход.

**Tech Stack:** NestJS 10 (commonjs, `strictNullChecks: false`), jest + ts-jest, Postgres 16, axios 1.x (уже в зависимостях), YouTube Data API v3 (resumable upload), Google OAuth 2.0.

**Спека:** `docs/superpowers/specs/2026-10-27-shorts-youtube-autopublish-design.md` (коммиты `c79190e`, `b337bbf`).

---

## Правила для исполнителя

- **Рабочее дерево:** `~/Downloads/spirits_back/.worktrees/shorts-youtube`, ветка `feat/shorts-youtube`. Все пути ниже — от его корня.
- **Тесты, `tsc` и сборка — только на ноде, не на маке (CLAUDE.md).** Команда прогона из корня рабочего дерева:
  `NODE_RUN_DIR=. studio/scripts/node-run.sh "<команда>"`.
  Скрипт пушит ветку, ставит `~/ci/wt/promo-shorts` на точный коммит и гонит команду в корне бэкенда. Незакоммиченное на ноду не уезжает: перед прогоном коммитить (красный тест — коммит с пометкой «(красный)», как в модуле роликов).
  Код выхода 75 — дерево занято (повторить через пару минут), 255 — ssh (повторить через 1–2 минуты), 3 — дерево ноды не встало на коммит (сообщить контролёру).
- **Секреты:** репозитории Linkeon публичные. Не печатать и не коммитить `.env`, токены, секрет клиента. В тестах — только выдуманные значения.
- **Слияние в `main`, выкат, правки `.env` на серверах — только с явного OK владельца** (задачи 13–14). Выкат — только `scripts/deploy.sh`.
- Параллельно работает сессия роликов (ветка `feat/shorts-prod`, план 5: `deploy.sh`, `studio/`). Её файлы не трогать. Перед слиянием — rebase на свежий `origin/main`.
- Стиль: комментарии и сообщения — по-русски, как в соседних файлах модуля; «ассистент», не «агент».

## Файлы

| Файл | Ответственность |
|---|---|
| `src/shorts/migrations/003_youtube.sql` (новый) | `short_settings.youtube_mode`, `short_publication.upload_session`, `short_youtube_account` |
| `src/shorts/shorts-schema.service.ts` | катить 003 после 002 |
| `src/shorts/shorts.types.ts` | `YoutubeMode`, `YOUTUBE_MODES` (адрес сессии загрузки в `ShortPublication` не выносится — это ключ на загрузку) |
| `src/shorts/shorts-settings.service.ts` | `youtubeMode` в настройках и в правке |
| `src/shorts/youtube/youtube-http.ts` (новый) | тип `Http`, адаптер axios, `googleReason` |
| `src/shorts/youtube/youtube-errors.ts` (новый) | `YoutubeAuthError`, `YoutubeNotUploaded`, `YoutubeMaybeUploaded` |
| `src/shorts/youtube/youtube-state.ts` (новый) | подпись и проверка `state` |
| `src/shorts/youtube/youtube-oauth.ts` (новый) | конфиг клиента, адрес входа, обмен кода, обновление токена, канал |
| `src/shorts/youtube/youtube-upload.ts` (новый) | начать сессию, отправить файл, спросить о сессии |
| `src/shorts/shorts-youtube.service.ts` (новый) | аккаунт, `/youtube`, подключение, план, загрузка, сообщение о загрузке |
| `src/shorts/shorts-youtube.controller.ts` (новый) | адрес возврата Google |
| `src/shorts/shorts-publisher.service.ts` | ветка youtube: загрузка или набор |
| `src/shorts/shorts.module.ts` | провайдер, контроллер, экспорт |
| `src/tg-bot/tg-bot.service.ts` | `/youtube` в `handleDmCommand` |
| спеки рядом с каждым файлом, `src/shorts/shorts.integration.spec.ts` | тесты |

---

### Task 0: Базовая линия на ноде

**Files:** нет.

- [ ] **Step 1: Прогон модуля и бота на исходном коммите**

```bash
cd ~/Downloads/spirits_back/.worktrees/shorts-youtube
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | tail -25"
```

Expected: сводка jest. Записать в отчёт число сюит и тестов и все красные сюиты (если есть) — это база для задачи 11.

- [ ] **Step 2: Гейт типов на исходном коммите**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```

Expected: `TSC_OK`. Если нет — записать ошибки в отчёт как базовые.

---

### Task 1: Данные — миграция 003, режим, сессия загрузки

**Files:**
- Create: `src/shorts/migrations/003_youtube.sql`
- Modify: `src/shorts/shorts-schema.service.ts`, `src/shorts/shorts.types.ts`, `src/shorts/shorts-settings.service.ts`
- Test: `src/shorts/shorts-schema.spec.ts`, `src/shorts/shorts-settings.service.spec.ts`, `src/shorts/shorts.types.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts-schema.spec.ts`:
- в строку импорта из `./shorts.types` добавить `YOUTUBE_MODES`;
- после функции `appliedSkitsSql` добавить:

```ts
async function appliedYoutubeSql(): Promise<string> {
  const text = (await applied()).find((q) => q.includes("hashtext('shorts/003')"));
  if (!text) throw new Error('миграция 003 не применена');
  return text;
}
```

- в `describe('ShortsSchemaService', …)` после теста «катит 002 после 001» добавить:

```ts
  it('катит 003 после 002', async () => {
    const qs = await applied();
    const second = qs.findIndex((q) => q.includes("hashtext('shorts/002')"));
    const third = qs.findIndex((q) => q.includes("hashtext('shorts/003')"));
    expect(second).toBeGreaterThanOrEqual(0);
    expect(third).toBeGreaterThan(second);
  });
```

- в конец файла:

```ts
describe('текст 003_youtube.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedYoutubeSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/003'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('каждый ALTER TABLE — под проверкой information_schema, таблица — под to_regclass', async () => {
    const sql = await appliedYoutubeSql();
    const alters = sql.match(/ALTER TABLE/g) ?? [];
    const guarded = sql.match(/IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns[\s\S]*?\) THEN\s+ALTER TABLE/g) ?? [];
    expect(alters.length).toBe(2);
    expect(guarded.length).toBe(alters.length);
    expect(sql).toMatch(/IF to_regclass\('public\.short_youtube_account'\) IS NULL THEN\s+CREATE TABLE short_youtube_account/);
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS/);
  });

  it('режимы в CHECK — ровно YOUTUBE_MODES, умолчание manual', async () => {
    const m = (await appliedYoutubeSql()).match(/youtube_mode text NOT NULL DEFAULT 'manual'\s+CHECK \(youtube_mode IN \(([^)]*)\)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...YOUTUBE_MODES].sort());
  });
});
```

В `src/shorts/shorts-settings.service.spec.ts`:
- в тесте «строка базы — числами и списками» добавить в `row` поле `youtube_mode: 'public'`, а в ожидаемый объект — `youtubeMode: 'public'`;
- в конец `describe('ShortsSettingsService', …)`:

```ts
  it('незнакомый режим YouTube в базе — manual (набор)', async () => {
    const svc = new ShortsSettingsService({ query: jest.fn(async () => ({ rows: [{ youtube_mode: 'private' }] })) } as any);
    expect((await svc.get()).youtubeMode).toBe('manual');
  });

  it('режим YouTube пишется своей колонкой', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await new ShortsSettingsService({ query } as any).update({ youtubeMode: 'unlisted' });
    const [sql, args] = query.mock.calls[0] as any[];
    expect(sql).toBe('UPDATE short_settings SET youtube_mode = $1, updated_at = now() WHERE id = 1');
    expect(args).toEqual(['unlisted']);
  });
```

- в конец файла:

```ts
describe('youtubeMode в правке настроек', () => {
  it('по умолчанию — manual; три режима принимаются; прочее — ошибка с именем поля', () => {
    expect(SETTINGS_DEFAULTS.youtubeMode).toBe('manual');
    for (const mode of ['manual', 'unlisted', 'public']) {
      expect(validateSettingsPatch({ youtubeMode: mode })).toEqual({ youtubeMode: mode });
    }
    for (const bad of ['private', 'PUBLIC', '', null, 1]) {
      expect(() => validateSettingsPatch({ youtubeMode: bad })).toThrow(/youtubeMode/);
    }
  });
});
```

В конец `src/shorts/shorts.types.spec.ts` (если `rowToPublication` уже импортирован из `./shorts.types` — не дублировать импорт):

```ts
import { rowToPublication } from './shorts.types';

describe('rowToPublication: сессия загрузки YouTube', () => {
  it('upload_session → uploadSession; без колонки — null', () => {
    expect(rowToPublication({ short_id: 'x', platform: 'youtube', status: 'failed', upload_session: 'https://upload/abc' }).uploadSession)
      .toBe('https://upload/abc');
    expect(rowToPublication({ short_id: 'x', platform: 'youtube', status: 'failed' }).uploadSession).toBeNull();
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "test(shorts): 003 — режим YouTube, сессия загрузки, аккаунт канала (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts src/shorts/shorts-settings.service.spec.ts src/shorts/shorts.types.spec.ts 2>&1 | tail -30"
```

Expected: FAIL — нет 003, нет `YOUTUBE_MODES`, `youtubeMode`, `uploadSession`.

- [ ] **Step 3: Миграция**

Создать `src/shorts/migrations/003_youtube.sql`:

```sql
-- 003_youtube.sql — автопубликация роликов на YouTube: режим, сессия загрузки, аккаунт канала.
--
-- Спека: docs/superpowers/specs/2026-10-27-shorts-youtube-autopublish-design.md, «Данные».
-- План: docs/superpowers/plans/2026-10-27-shorts-youtube-autopublish.md, задача 1.
--
-- КАК КАТИТСЯ — как 001 и 002: ShortsSchemaService выполняет файл при КАЖДОМ
-- старте API, весь файл — один DO-блок (одна транзакция) под advisory-локом,
-- чужих замков ждём не дольше 5 с. Колонки — под проверкой information_schema,
-- таблица — под to_regclass: ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT
-- EXISTS и на каждом старте ждал бы открытые записи (шапка 001).
--
-- ОТКАТ (код без YouTube этих колонок не читает): убрать 003 из ShortsSchemaService, затем
--   DROP TABLE short_youtube_account;
--   ALTER TABLE short_publication DROP COLUMN upload_session;
--   ALTER TABLE short_settings DROP COLUMN youtube_mode;
DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/003'));
    PERFORM set_config('lock_timeout', '5s', true);
    -- Режим YouTube: manual — набор владельцу, как до этой миграции; unlisted — «по ссылке»; public — «публично».
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_settings' AND column_name = 'youtube_mode') THEN
        ALTER TABLE short_settings ADD COLUMN youtube_mode text NOT NULL DEFAULT 'manual'
            CHECK (youtube_mode IN ('manual', 'unlisted', 'public'));
    END IF;
    -- Адрес resumable-сессии текущей загрузки: пишется до отправки файла, стирается после успеха.
    -- По нему повтор спрашивает YouTube, дошла ли прошлая загрузка, — без дублей на канале.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'short_publication' AND column_name = 'upload_session') THEN
        ALTER TABLE short_publication ADD COLUMN upload_session text;
    END IF;
    -- Подключённый канал — одна строка. Refresh-токен — AES-256-GCM (src/calendar/crypto.ts), как у Taler ID.
    IF to_regclass('public.short_youtube_account') IS NULL THEN
        CREATE TABLE short_youtube_account (
            id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            channel_id         text NOT NULL,
            channel_title      text,
            refresh_token_enc  text NOT NULL,
            scopes             text,
            status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'revoked')),
            last_error         text,
            connected_at       timestamptz NOT NULL DEFAULT now(),
            updated_at         timestamptz NOT NULL DEFAULT now()
        );
    END IF;
END
$shorts$;
```

В `src/shorts/shorts-schema.service.ts` заменить `onModuleInit` на:

```ts
  /** По порядку: 002 и 003 правят таблицы, которые создаёт 001. */
  async onModuleInit() {
    await this.applyMigration('001_shorts.sql');
    await this.applyMigration('002_skits.sql');
    await this.applyMigration('003_youtube.sql');
  }
```

- [ ] **Step 4: Типы**

В `src/shorts/shorts.types.ts` рядом с `ShortPlatform` добавить:

```ts
/** Режим YouTube (003): manual — набор владельцу, unlisted — «по ссылке», public — «публично». */
export type YoutubeMode = 'manual' | 'unlisted' | 'public';
export const YOUTUBE_MODES: readonly YoutubeMode[] = ['manual', 'unlisted', 'public'];
```

В `interface ShortPublication` после `lastError` добавить:

```ts
  /** Адрес resumable-сессии незавершённой загрузки YouTube (003); после успеха — null. */
  uploadSession: string | null;
```

В `rowToPublication` после `lastError: row.last_error ?? null,` добавить:

```ts
    uploadSession: row.upload_session ?? null,
```

- [ ] **Step 5: Настройки**

В `src/shorts/shorts-settings.service.ts`:
- импорт: `import { FORMATS, ShortFormat, ShortPlatform, YOUTUBE_MODES, YoutubeMode } from './shorts.types';`
- в `interface ShortSettings` после `maxOmniSeconds`:

```ts
  /** YouTube: manual — набор владельцу, unlisted/public — загрузка с этим доступом (спека YouTube). */
  youtubeMode: YoutubeMode;
```

- в `SETTINGS_DEFAULTS` после `maxOmniSeconds: 48,` — `youtubeMode: 'manual',`
- в `COLUMNS` после `maxOmniSeconds: 'max_omni_seconds',` — `youtubeMode: 'youtube_mode',`
- в `validateSettingsPatch` перед `return p;`:

```ts
  if (b.youtubeMode !== undefined) {
    if (!YOUTUBE_MODES.includes(b.youtubeMode)) throw new Error('youtubeMode — manual (набор), unlisted («по ссылке») или public');
    p.youtubeMode = b.youtubeMode;
  }
```

- в `get()` после `maxOmniSeconds: …,`:

```ts
      youtubeMode: YOUTUBE_MODES.includes(row.youtube_mode) ? row.youtube_mode : SETTINGS_DEFAULTS.youtubeMode,
```

- [ ] **Step 6: Зелёный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "feat(shorts): 003 — режим YouTube, адрес сессии загрузки, аккаунт канала

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts src/shorts/shorts-settings.service.spec.ts src/shorts/shorts.types.spec.ts 2>&1 | tail -15"
```

Expected: PASS, все три сюиты.

**Поправки ревью качества (27.10, сделаны в задаче 1):**
- `uploadSession` убран из `ShortPublication` и `rowToPublication`: объект площадки отдаёт админ-API, а адрес resumable-сессии работает как ключ на загрузку. Колонку `upload_session` читают и пишут прямым SQL (задача 6). Тест типов проверяет, что адрес наружу не попадает.
- Тест защиты ALTER в 003 сверяет пары «таблица.колонка», DO-блок проверяется и по концу файла, умолчание режима связано с `SETTINGS_DEFAULTS.youtubeMode`.
- Откат в шапке 003: перед `DROP COLUMN upload_session` — найти незавершённые загрузки и проверить канал; `DROP TABLE` не отзывает доступ у Google.
- Админ-API (`update_settings`) может поставить только `youtubeMode: 'manual'` — аварийная остановка. `unlisted` и `public` включает только владелец командой `/youtube` (бот пишет режим через `settings.update()`, мимо валидации правки).

---

### Task 2: Общие куски YouTube — HTTP, ошибки, подпись state

**Files:**
- Create: `src/shorts/youtube/youtube-http.ts`, `src/shorts/youtube/youtube-errors.ts`, `src/shorts/youtube/youtube-state.ts`
- Test: `src/shorts/youtube/youtube-http.spec.ts`, `src/shorts/youtube/youtube-state.spec.ts`

- [ ] **Step 1: Падающие тесты**

`src/shorts/youtube/youtube-http.spec.ts`:

```ts
import { googleReason } from './youtube-http';

describe('googleReason', () => {
  it('ошибка API: reason и message', () => {
    expect(googleReason({
      status: 403, headers: {},
      data: { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } },
    })).toBe('HTTP 403 quotaExceeded: The request cannot be completed because you have exceeded your quota.');
  });

  it('ошибка OAuth: error и error_description', () => {
    expect(googleReason({ status: 400, headers: {}, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }))
      .toBe('HTTP 400 invalid_grant: Token has been expired or revoked.');
  });

  it('тело не JSON — только статус; длинная причина — не длиннее 300 знаков', () => {
    expect(googleReason({ status: 502, headers: {}, data: '<html>' })).toBe('HTTP 502');
    expect(googleReason({ status: 400, headers: {}, data: { error: { message: 'x'.repeat(1000) } } })).toHaveLength(300);
  });
});
```

`src/shorts/youtube/youtube-state.spec.ts`:

```ts
import { STATE_TTL_MS, signState, verifyState } from './youtube-state';

const SECRET = 'GOCSPX-test-secret';
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('state входа YouTube', () => {
  it('свой state в срок — чат владельца', () => {
    expect(verifyState(SECRET, signState(SECRET, 37948399, NOW), NOW + 60_000)).toEqual({ chatId: 37948399 });
  });

  it('срок вышел — null', () => {
    expect(verifyState(SECRET, signState(SECRET, 1, NOW), NOW + STATE_TTL_MS)).toBeNull();
  });

  it('подписан другим секретом — null', () => {
    expect(verifyState(SECRET, signState('другой', 1, NOW), NOW)).toBeNull();
  });

  it('подменённый чат при старой подписи — null', () => {
    const [, sig] = signState(SECRET, 1, NOW).split('.');
    const forged = Buffer.from(JSON.stringify({ c: 2, e: NOW + STATE_TTL_MS, n: 'x' })).toString('base64url');
    expect(verifyState(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
  });

  it('мусор и пустой секрет — null, без исключений', () => {
    for (const bad of [undefined, '', 'abc', 'a.b.c', '.', 123]) expect(verifyState(SECRET, bad, NOW)).toBeNull();
    expect(verifyState('', signState(SECRET, 1, NOW), NOW)).toBeNull();
  });

  it('два state подряд различаются', () => {
    expect(signState(SECRET, 1, NOW)).not.toBe(signState(SECRET, 1, NOW));
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts/youtube && git commit -q -m "test(shorts): YouTube — причина отказа Google и подпись state (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/youtube 2>&1 | tail -20"
```

Expected: FAIL — модулей нет.

- [ ] **Step 3: Реализация**

`src/shorts/youtube/youtube-http.ts`:

```ts
import axios from 'axios';

/** Ответ без исключения на статус: решения по статусам принимает вызывающий. */
export interface HttpResponse {
  status: number;
  headers: Record<string, any>;
  data: any;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: any;
  /** Таймаут, мс. */
  timeout: number;
}

/** Обрыв сети, таймаут, DNS — исключение; любой статус — ответ. Тесты подставляют свою функцию. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const axiosHttp: Http = async (req) => {
  const r = await axios.request({
    method: req.method,
    url: req.url,
    headers: req.headers,
    params: req.params,
    data: req.data,
    timeout: req.timeout,
    // Файл ролика — десятки МБ: без снятия пределов axios отказал бы до отправки.
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  return { status: r.status, headers: r.headers as Record<string, any>, data: r.data };
};

/**
 * Причина отказа Google коротко, не длиннее 300 знаков. Тело ошибки API —
 * `{error: {message, errors: [{reason}]}}`, тело OAuth — `{error, error_description}`.
 * Токенов в этих телах нет.
 */
export function googleReason(r: HttpResponse): string {
  const d = r.data;
  const err = d && typeof d === 'object' ? d.error : undefined;
  const reason =
    typeof err === 'string'
      ? [err, d.error_description].filter(Boolean).join(': ')
      : [err?.errors?.[0]?.reason, err?.message].filter(Boolean).join(': ');
  return `HTTP ${r.status}${reason ? ` ${reason}` : ''}`.slice(0, 300);
}
```

`src/shorts/youtube/youtube-errors.ts`:

```ts
/** Доступа к каналу нет: Google ответил invalid_grant (доступ отозван) или 401 на свежий токен. Нужно переподключить. */
export class YoutubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeAuthError';
  }
}

/** Ролика на YouTube точно нет: отказ до или вместо загрузки. Повтор безопасен. */
export class YoutubeNotUploaded extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'YoutubeNotUploaded';
  }
}

/** Файл ушёл, а ответа нет: ролик мог загрузиться. Новая загрузка — только после вопроса о сессии. */
export class YoutubeMaybeUploaded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeMaybeUploaded';
  }
}
```

`src/shorts/youtube/youtube-state.ts`:

```ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Ссылка на вход живёт 15 минут (спека, «Сценарий владельца»). */
export const STATE_TTL_MS = 15 * 60 * 1000;

/** Свой ключ из секрета клиента: сам секрет уходит Google при обмене кода, а подпись state — наша. */
function key(secret: string): Buffer {
  return createHash('sha256').update(`linkeon-shorts-youtube-state:${secret}`).digest();
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', key(secret)).update(payload).digest('base64url');
}

/** state для адреса входа: чат владельца, срок, случайное число — и подпись. */
export function signState(secret: string, chatId: number, now = Date.now(), nonce = randomBytes(9).toString('base64url')): string {
  const payload = Buffer.from(JSON.stringify({ c: chatId, e: now + STATE_TTL_MS, n: nonce })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Чат владельца из state или null: подпись не сошлась, срок вышел, форма чужая. */
export function verifyState(secret: string, state: unknown, now = Date.now()): { chatId: number } | null {
  if (!secret || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, sig] = parts;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let body: any;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Number.isFinite(body?.c) || !Number.isFinite(body?.e) || body.e <= now) return null;
  return { chatId: Number(body.c) };
}
```

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts/youtube && git commit -q -m "feat(shorts): YouTube — HTTP с инъекцией, классы ошибок, подписанный state

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/youtube 2>&1 | tail -15"
```

Expected: PASS.

---

### Task 3: OAuth Google

**Files:**
- Create: `src/shorts/youtube/youtube-oauth.ts`
- Test: `src/shorts/youtube/youtube-oauth.spec.ts`

- [ ] **Step 1: Падающий тест**

`src/shorts/youtube/youtube-oauth.spec.ts`:

```ts
import { YoutubeAuthError, YoutubeNotUploaded } from './youtube-errors';
import { HttpRequest, HttpResponse } from './youtube-http';
import { YOUTUBE_SCOPES, authorizeUrl, exchangeCode, fetchMyChannel, refreshAccessToken, youtubeOAuthConfig } from './youtube-oauth';

const CFG = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec', redirectUri: 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback' };
const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });

function fakeHttp(...responses: Array<HttpResponse | Error>) {
  const calls: HttpRequest[] = [];
  const http = jest.fn(async (req: HttpRequest) => {
    calls.push(req);
    const next = responses.shift();
    if (!next) throw new Error(`лишний запрос: ${req.method} ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { http, calls };
}

describe('youtubeOAuthConfig', () => {
  it('без клиента — null', () => {
    expect(youtubeOAuthConfig({})).toBeNull();
    expect(youtubeOAuthConfig({ YOUTUBE_OAUTH_CLIENT_ID: 'x' })).toBeNull();
  });

  it('адрес возврата — от PUBLIC_BASE_URL, без двойного слэша', () => {
    expect(youtubeOAuthConfig({ YOUTUBE_OAUTH_CLIENT_ID: 'id', YOUTUBE_OAUTH_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://test.linkeon.io/' }))
      .toEqual({ clientId: 'id', clientSecret: 's', redirectUri: 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback' });
  });

  it('без PUBLIC_BASE_URL — прод', () => {
    expect(youtubeOAuthConfig({ YOUTUBE_OAUTH_CLIENT_ID: 'id', YOUTUBE_OAUTH_CLIENT_SECRET: 's' })?.redirectUri)
      .toBe('https://my.linkeon.io/webhook/shorts/youtube/oauth/callback');
  });
});

describe('authorizeUrl', () => {
  it('offline, consent, оба scope и state', () => {
    const u = new URL(authorizeUrl(CFG, 'st.ate'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe(CFG.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(CFG.redirectUri);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')?.split(' ')).toEqual(YOUTUBE_SCOPES);
    expect(u.searchParams.get('state')).toBe('st.ate');
  });
});

describe('exchangeCode', () => {
  it('код → токены; запрос формой с секретом и адресом возврата', async () => {
    const { http, calls } = fakeHttp(reply(200, { access_token: 'at', refresh_token: 'rt', scope: 'a b' }));
    expect(await exchangeCode(http, CFG, 'code-1')).toEqual({ accessToken: 'at', refreshToken: 'rt', scope: 'a b' });
    const body = new URLSearchParams(calls[0].data);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://oauth2.googleapis.com/token' });
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_secret')).toBe('sec');
    expect(body.get('redirect_uri')).toBe(CFG.redirectUri);
  });

  it('нет refresh-токена — понятная ошибка', async () => {
    await expect(exchangeCode(fakeHttp(reply(200, { access_token: 'at' })).http, CFG, 'c')).rejects.toThrow(/refresh-токен/);
  });

  it('отказ Google — причина в ошибке', async () => {
    const { http } = fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Bad Request' }));
    await expect(exchangeCode(http, CFG, 'c')).rejects.toThrow('обмен кода: HTTP 400 invalid_grant: Bad Request');
  });
});

describe('refreshAccessToken', () => {
  it('свежий access-токен', async () => {
    const { http, calls } = fakeHttp(reply(200, { access_token: 'fresh' }));
    expect(await refreshAccessToken(http, CFG, 'rt')).toBe('fresh');
    expect(new URLSearchParams(calls[0].data).get('grant_type')).toBe('refresh_token');
  });

  it('invalid_grant — YoutubeAuthError с причиной', async () => {
    const { http } = fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    await expect(refreshAccessToken(http, CFG, 'rt')).rejects.toThrow(new YoutubeAuthError('HTTP 400 invalid_grant: Token has been expired or revoked.'));
  });

  it('5xx и обрыв — YoutubeNotUploaded: до загрузки не дошло', async () => {
    await expect(refreshAccessToken(fakeHttp(reply(503, {})).http, CFG, 'rt')).rejects.toBeInstanceOf(YoutubeNotUploaded);
    await expect(refreshAccessToken(fakeHttp(new Error('ECONNRESET')).http, CFG, 'rt')).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });
});

describe('fetchMyChannel', () => {
  it('канал с названием и псевдонимом', async () => {
    const { http, calls } = fakeHttp(reply(200, { items: [{ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', snippet: { title: 'Linkeon', customUrl: '@linkeons' } }] }));
    expect(await fetchMyChannel(http, 'at')).toEqual({ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', title: 'Linkeon', handle: '@linkeons' });
    expect(calls[0].headers?.Authorization).toBe('Bearer at');
    expect(calls[0].params).toEqual({ part: 'snippet', mine: 'true' });
  });

  it('у аккаунта нет канала — ошибка с подсказкой', async () => {
    await expect(fetchMyChannel(fakeHttp(reply(200, { items: [] })).http, 'at')).rejects.toThrow(/нет канала YouTube/);
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts/youtube && git commit -q -m "test(shorts): YouTube — OAuth: адрес входа, обмен кода, обновление токена, канал (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/youtube/youtube-oauth.spec.ts 2>&1 | tail -15"
```

Expected: FAIL — `Cannot find module './youtube-oauth'`.

- [ ] **Step 3: Реализация**

`src/shorts/youtube/youtube-oauth.ts`:

```ts
import { YoutubeAuthError, YoutubeNotUploaded } from './youtube-errors';
import { Http, HttpResponse, googleReason } from './youtube-http';

/** Загрузка и чтение своего канала: channels.list?mine=true — узнать, какой канал подключил владелец. */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

/** Под глобальным префиксом webhook; ровно этот путь зарегистрирован в Google Cloud для теста и прода. */
export const CALLBACK_PATH = '/webhook/shorts/youtube/oauth/callback';

export interface YoutubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Клиент OAuth из .env или null, если на этой среде YouTube не настроен. */
export function youtubeOAuthConfig(env: NodeJS.ProcessEnv = process.env): YoutubeOAuthConfig | null {
  const clientId = (env.YOUTUBE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (env.YOUTUBE_OAUTH_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const base = (env.PUBLIC_BASE_URL || 'https://my.linkeon.io').trim().replace(/\/+$/, '');
  return { clientId, clientSecret, redirectUri: `${base}${CALLBACK_PATH}` };
}

/** offline — чтобы Google выдал refresh-токен; consent — чтобы выдал его и при повторном подключении. */
export function authorizeUrl(cfg: YoutubeOAuthConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${q}`;
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

export async function exchangeCode(
  http: Http,
  cfg: YoutubeOAuthConfig,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const r = await http({
    method: 'POST',
    url: TOKEN_URL,
    headers: FORM,
    timeout: 15_000,
    data: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, code, grant_type: 'authorization_code' }),
  });
  if (r.status !== 200 || !r.data?.access_token) throw new Error(`обмен кода: ${googleReason(r)}`);
  if (!r.data.refresh_token) {
    throw new Error('Google не выдал refresh-токен — уберите доступ приложения в настройках аккаунта Google и подключите снова');
  }
  return { accessToken: r.data.access_token, refreshToken: r.data.refresh_token, scope: String(r.data.scope || '') };
}

/**
 * Свежий access-токен. invalid_grant — доступ отозван или протух: YoutubeAuthError,
 * нужно переподключение. Прочие сбои (сеть, 5xx) — YoutubeNotUploaded: до загрузки
 * не дошло, повтор безопасен.
 */
export async function refreshAccessToken(http: Http, cfg: YoutubeOAuthConfig, refreshToken: string): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'POST',
      url: TOKEN_URL,
      headers: FORM,
      timeout: 15_000,
      data: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
  } catch (e: any) {
    throw new YoutubeNotUploaded(`обновление токена: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (r.status === 200 && r.data?.access_token) return r.data.access_token;
  if (r.data?.error === 'invalid_grant' || r.data?.error === 'unauthorized_client') throw new YoutubeAuthError(googleReason(r));
  throw new YoutubeNotUploaded(`обновление токена: ${googleReason(r)}`, r.status);
}

/** Канал, который владелец выбрал при входе. */
export async function fetchMyChannel(http: Http, accessToken: string): Promise<{ id: string; title: string; handle: string | null }> {
  const r = await http({
    method: 'GET',
    url: CHANNELS_URL,
    params: { part: 'snippet', mine: 'true' },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15_000,
  });
  const ch = r.status === 200 ? r.data?.items?.[0] : null;
  if (!ch?.id) {
    throw new Error(r.status === 200 ? 'у аккаунта нет канала YouTube — выберите при входе канал Linkeon' : `канал: ${googleReason(r)}`);
  }
  return { id: ch.id, title: ch.snippet?.title ?? ch.id, handle: ch.snippet?.customUrl ?? null };
}
```

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts/youtube && git commit -q -m "feat(shorts): YouTube — OAuth Google без googleapis

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/youtube 2>&1 | tail -15"
```

Expected: PASS.

---

### Task 4: Resumable-загрузка

**Files:**
- Create: `src/shorts/youtube/youtube-upload.ts`
- Test: `src/shorts/youtube/youtube-upload.spec.ts`

- [ ] **Step 1: Падающий тест**

`src/shorts/youtube/youtube-upload.spec.ts`:

```ts
import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
import { HttpRequest, HttpResponse } from './youtube-http';
import { UploadMeta, checkUpload, sendFile, startUpload } from './youtube-upload';

const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });
function fakeHttp(...responses: Array<HttpResponse | Error>) {
  const calls: HttpRequest[] = [];
  const http = jest.fn(async (req: HttpRequest) => {
    calls.push(req);
    const next = responses.shift();
    if (!next) throw new Error(`лишний запрос: ${req.method} ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { http, calls };
}

const META: UploadMeta = { title: 'Залог', description: 'Описание', tags: ['аренда'], categoryId: '27', language: 'ru', privacy: 'unlisted' };
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc';

describe('startUpload', () => {
  it('сессия: параметры, заголовки размера, метаданные; 200 + Location → адрес', async () => {
    const { http, calls } = fakeHttp(reply(200, {}, { location: SESSION }));
    expect(await startUpload(http, 'at', META, 1234)).toBe(SESSION);
    const req = calls[0];
    expect(req).toMatchObject({ method: 'POST', url: 'https://www.googleapis.com/upload/youtube/v3/videos' });
    expect(req.params).toEqual({ uploadType: 'resumable', part: 'snippet,status' });
    expect(req.headers).toMatchObject({ Authorization: 'Bearer at', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': '1234' });
    expect(req.data).toEqual({
      snippet: { title: 'Залог', description: 'Описание', tags: ['аренда'], categoryId: '27', defaultLanguage: 'ru', defaultAudioLanguage: 'ru' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
    });
  });

  it('401 — YoutubeAuthError; 403 квота — YoutubeNotUploaded с причиной и статусом; обрыв — YoutubeNotUploaded', async () => {
    await expect(startUpload(fakeHttp(reply(401, { error: { message: 'Invalid Credentials' } })).http, 'at', META, 1)).rejects.toBeInstanceOf(YoutubeAuthError);
    const quota = startUpload(fakeHttp(reply(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } })).http, 'at', META, 1);
    await expect(quota).rejects.toThrow(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    await expect(startUpload(fakeHttp(new Error('ENOTFOUND')).http, 'at', META, 1)).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });

  it('200 без Location — YoutubeNotUploaded', async () => {
    await expect(startUpload(fakeHttp(reply(200, {})).http, 'at', META, 1)).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });
});

describe('sendFile', () => {
  it('201 с id — ролик загружен; файл байтами в PUT на адрес сессии', async () => {
    const { http, calls } = fakeHttp(reply(201, { id: 'abcdefghijk' }));
    expect(await sendFile(http, SESSION, Buffer.from('12345'))).toBe('abcdefghijk');
    expect(calls[0]).toMatchObject({ method: 'PUT', url: SESSION });
    expect(calls[0].headers).toMatchObject({ 'Content-Type': 'video/mp4', 'Content-Length': '5' });
    expect(Buffer.isBuffer(calls[0].data)).toBe(true);
  });

  it('обрыв, 408, 5xx, 308 — YoutubeMaybeUploaded; прочие 4xx — YoutubeNotUploaded', async () => {
    for (const r of [new Error('socket hang up'), reply(408), reply(503), reply(308)]) {
      await expect(sendFile(fakeHttp(r).http, SESSION, Buffer.from('x'))).rejects.toBeInstanceOf(YoutubeMaybeUploaded);
    }
    await expect(sendFile(fakeHttp(reply(400, { error: { message: 'bad' } })).http, SESSION, Buffer.from('x'))).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });
});

describe('checkUpload', () => {
  it('вопрос без тела с размером; 200/201 с id — загружено', async () => {
    const { http, calls } = fakeHttp(reply(200, { id: 'abcdefghijk' }));
    expect(await checkUpload(http, SESSION, 77)).toEqual({ state: 'complete', videoId: 'abcdefghijk' });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: SESSION });
    expect(calls[0].headers).toEqual({ 'Content-Range': 'bytes */77', 'Content-Length': '0' });
    expect(calls[0].data).toBeUndefined();
  });

  it('308 — не догружено; 404 и 410 — сессии нет', async () => {
    expect(await checkUpload(fakeHttp(reply(308)).http, SESSION, 1)).toEqual({ state: 'incomplete' });
    expect(await checkUpload(fakeHttp(reply(404)).http, SESSION, 1)).toEqual({ state: 'gone' });
    expect(await checkUpload(fakeHttp(reply(410)).http, SESSION, 1)).toEqual({ state: 'gone' });
  });

  it('обрыв и прочие ответы — YoutubeMaybeUploaded', async () => {
    await expect(checkUpload(fakeHttp(new Error('ETIMEDOUT')).http, SESSION, 1)).rejects.toBeInstanceOf(YoutubeMaybeUploaded);
    await expect(checkUpload(fakeHttp(reply(500)).http, SESSION, 1)).rejects.toBeInstanceOf(YoutubeMaybeUploaded);
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts/youtube && git commit -q -m "test(shorts): YouTube — resumable: сессия, файл, вопрос о сессии (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/youtube/youtube-upload.spec.ts 2>&1 | tail -15"
```

Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализация**

`src/shorts/youtube/youtube-upload.ts`:

```ts
import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
import { Http, HttpResponse, googleReason } from './youtube-http';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
/** Файл ролика — 10–50 МБ: выгрузка с запасом укладывается в срок живости публикации (10 мин). */
export const SEND_TIMEOUT_MS = 8 * 60 * 1000;

export interface UploadMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  language: string;
  privacy: 'unlisted' | 'public';
}

const short = (e: any): string => String(e?.message ?? e).slice(0, 200);

/** Начать resumable-загрузку: метаданные → адрес сессии. Ролика ещё нет: любой сбой безопасен для повтора. */
export async function startUpload(http: Http, accessToken: string, meta: UploadMeta, size: number): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'POST',
      url: UPLOAD_URL,
      params: { uploadType: 'resumable', part: 'snippet,status' },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(size),
      },
      data: {
        snippet: {
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
          categoryId: meta.categoryId,
          defaultLanguage: meta.language,
          defaultAudioLanguage: meta.language,
        },
        status: {
          privacyStatus: meta.privacy,
          selfDeclaredMadeForKids: false,
          // Анимацию YouTube отмечать не требует — только реалистичные сцены и настоящих людей.
          containsSyntheticMedia: false,
        },
      },
      timeout: 30_000,
    });
  } catch (e: any) {
    throw new YoutubeNotUploaded(`начало загрузки: ${short(e)}`);
  }
  if (r.status === 401) throw new YoutubeAuthError(`начало загрузки: ${googleReason(r)}`);
  const location = r.headers?.location;
  if (r.status === 200 && typeof location === 'string' && location) return location;
  throw new YoutubeNotUploaded(`начало загрузки: ${googleReason(r)}`, r.status);
}

/** Ответ с загруженным роликом — id из тела, иначе null. */
function uploadedId(r: HttpResponse): string | null {
  return (r.status === 200 || r.status === 201) && typeof r.data?.id === 'string' && r.data.id ? r.data.id : null;
}

/**
 * Отправить файл одним запросом. 200/201 — загружен. Обрыв, таймаут, 408, 5xx и
 * 308 — исход неизвестен (YoutubeMaybeUploaded): решает вопрос о сессии. Прочие
 * 4xx — YouTube файл не принял, ролика нет.
 */
export async function sendFile(http: Http, sessionUrl: string, body: Buffer): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'PUT',
      url: sessionUrl,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
      data: body,
      timeout: SEND_TIMEOUT_MS,
    });
  } catch (e: any) {
    throw new YoutubeMaybeUploaded(`отправка файла оборвалась: ${short(e)}`);
  }
  const id = uploadedId(r);
  if (id) return id;
  if (r.status === 308 || r.status === 408 || r.status >= 500) throw new YoutubeMaybeUploaded(`отправка файла: ${googleReason(r)}`);
  throw new YoutubeNotUploaded(`отправка файла: ${googleReason(r)}`, r.status);
}

export type UploadState = { state: 'complete'; videoId: string } | { state: 'incomplete' } | { state: 'gone' };

/**
 * Спросить YouTube о сессии: PUT без тела, Content-Range со звёздочкой и размером
 * файла. 200/201 — загружено (в теле ролик), 308 — не догружено, 404/410 — сессии
 * нет. Обрыв и прочие ответы — YoutubeMaybeUploaded: ответа нет, решать нельзя.
 */
export async function checkUpload(http: Http, sessionUrl: string, size: number): Promise<UploadState> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'PUT',
      url: sessionUrl,
      headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
      timeout: 30_000,
    });
  } catch (e: any) {
    throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${short(e)}`);
  }
  const id = uploadedId(r);
  if (id) return { state: 'complete', videoId: id };
  if (r.status === 308) return { state: 'incomplete' };
  if (r.status === 404 || r.status === 410) return { state: 'gone' };
  throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${googleReason(r)}`);
}
```

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts/youtube && git commit -q -m "feat(shorts): YouTube — resumable-загрузка и вопрос о сессии

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/youtube 2>&1 | tail -15"
```

Expected: PASS.

**Поправки ревью качества задач 2–4 (27.10, сделаны отдельным коммитом):** «ролика нет» в `sendFile` — только явный отказ 4xx; `checkUpload`: 308 с полным `Range` — исход неизвестен, итоговый 4xx — `failed`, 404/410 — `gone` (спросить не у кого); токен на PUT; адрес сессии только `https://*.googleapis.com`; `startUpload` 401 — `YoutubeNotUploaded`; свой экземпляр axios с общим сроком, без редиректов, ошибки без `config`; `clip`; `YoutubeAuthError.pendingUpload`, `YoutubeMaybeUploaded.status`, `YoutubeUploadExpired`; `signState`/`verifyState` с адресом возврата среды; `exchangeCode` проверяет выданные разрешения. Полный текст — в коде ветки.

---

### Task 5: Сервис — аккаунт, `/youtube`, подключение

**Files:**
- Create: `src/shorts/shorts-youtube.service.ts`
- Test: `src/shorts/shorts-youtube.service.spec.ts`

- [ ] **Step 1: Падающий тест**

`src/shorts/shorts-youtube.service.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { decryptSecret } from '../calendar/crypto';
import { ShortsYoutubeService, connectPage, parseYoutubeCommand } from './shorts-youtube.service';
import { HttpRequest, HttpResponse } from './youtube/youtube-http';
import { verifyState } from './youtube/youtube-state';

const OWNER = 37948399;
const SECRET = 'GOCSPX-test-secret-0123456789';
const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });

/** База в миниатюре: ровно те запросы, что делает сервис YouTube. */
function fakeDb(init: { account?: any; mode?: string; session?: string | null; published?: string | null } = {}) {
  const st: any = {
    account: init.account ?? null,
    mode: init.mode ?? 'manual',
    session: init.session ?? null,
    published: init.published ?? null,
  };
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM short_youtube_account')) return { rows: st.account ? [{ ...st.account }] : [] };
    if (s.startsWith('INSERT INTO short_youtube_account')) {
      st.account = {
        channel_id: p[0], channel_title: p[1], refresh_token_enc: p[2], scopes: p[3],
        status: 'connected', last_error: null, connected_at: new Date().toISOString(),
      };
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_settings SET youtube_mode = CASE")) {
      if (st.mode === 'manual') st.mode = 'unlisted';
      return { rows: [{ youtube_mode: st.mode }], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_youtube_account SET status = 'revoked'")) {
      if (st.account) Object.assign(st.account, { status: 'revoked', last_error: p[0] });
      return { rows: [], rowCount: st.account ? 1 : 0 };
    }
    if (s.startsWith('SELECT upload_session FROM short_publication')) return { rows: [{ upload_session: st.session }] };
    if (s.startsWith('UPDATE short_publication SET upload_session')) {
      st.session = p[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT url FROM short_publication')) return { rows: st.published ? [{ url: st.published }] : [] };
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, st };
}

function fakeHttp(...responses: Array<HttpResponse | Error>) {
  const calls: HttpRequest[] = [];
  const http = jest.fn(async (req: HttpRequest) => {
    calls.push(req);
    const next = responses.shift();
    if (!next) throw new Error(`лишний запрос: ${req.method} ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { http, calls };
}

function setup(db = fakeDb(), http = fakeHttp()) {
  const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
  const storage = { download: jest.fn(async () => Buffer.from('video-bytes')) };
  const settings = {
    get: jest.fn(async () => ({ youtubeMode: db.st.mode })),
    update: jest.fn(async (patch: any) => {
      if (patch.youtubeMode) db.st.mode = patch.youtubeMode;
      return { youtubeMode: db.st.mode };
    }),
  };
  const svc = new ShortsYoutubeService({ query: db.query } as any, tg as any, storage as any, settings as any);
  svc.http = http.http;
  const said = (): string[] => tg.sendMessage.mock.calls.map((c: any[]) => c[1] as string);
  return { svc, tg, storage, settings, db, http, said };
}

const dm = (text: string, from = OWNER) => ({ text, chat: { id: from, type: 'private' }, from: { id: from }, message_id: 10 });

const env = { ...process.env };
beforeEach(() => {
  process.env.BLOG_APPROVER_TG_ID = String(OWNER);
  process.env.YOUTUBE_OAUTH_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.YOUTUBE_OAUTH_CLIENT_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = 'https://test.linkeon.io';
  process.env.CALENDAR_SECRET_KEY = 'k'.repeat(32);
  delete process.env.SHORTS_STAND;
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = env;
});

describe('parseYoutubeCommand', () => {
  it('режимы по-русски; регистр, лишние пробелы и @Бот не мешают', () => {
    expect(parseYoutubeCommand('/youtube')).toEqual({ mode: null, arg: '' });
    expect(parseYoutubeCommand('/youtube@LinkeonAgentBot по  ссылке')).toEqual({ mode: 'unlisted', arg: 'по ссылке' });
    expect(parseYoutubeCommand('/YouTube Публично')).toEqual({ mode: 'public', arg: 'публично' });
    expect(parseYoutubeCommand('/youtube вручную')).toEqual({ mode: 'manual', arg: 'вручную' });
    expect(parseYoutubeCommand('/youtube громко')).toEqual({ mode: null, arg: 'громко' });
  });

  it('другие команды и не текст — null', () => {
    for (const t of ['/youtubex', '/short тема', 'youtube', undefined, 42]) expect(parseYoutubeCommand(t)).toBeNull();
  });
});

describe('команда /youtube', () => {
  it('чужой, группа, другая команда — не наше, бот молчит', async () => {
    const { svc, tg } = setup();
    expect(await svc.handleCommand(dm('/youtube', 1))).toBe(false);
    expect(await svc.handleCommand({ ...dm('/youtube'), chat: { id: -100, type: 'supergroup' } })).toBe(false);
    expect(await svc.handleCommand(dm('/start'))).toBe(false);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('канал не подключён — статус и ссылка на вход; state подписан на чат владельца', async () => {
    const { svc, said } = setup();
    expect(await svc.handleCommand(dm('/youtube'))).toBe(true);
    const text = said()[0];
    expect(text).toContain('канал не подключён — ролики идут набором');
    expect(text).toContain('«Дополнительно» → «Перейти»');
    const url = new URL(text.match(/https:\/\/accounts\.google\.com\S+/)[0]);
    expect(url.searchParams.get('redirect_uri')).toBe('https://test.linkeon.io/webhook/shorts/youtube/oauth/callback');
    expect(verifyState(SECRET, 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback', url.searchParams.get('state')))
      .toEqual({ chatId: OWNER });
  });

  it('подключён — канал, режим и как сменить', async () => {
    const db = fakeDb({ mode: 'public', account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toMatch(/^YouTube: подключён канал «Linkeon», режим — публично\./);
    expect(said()[0]).toContain('/youtube по ссылке');
  });

  it('доступ пропал — причина и ссылка на переподключение', async () => {
    const db = fakeDb({
      mode: 'public',
      account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'revoked', last_error: 'HTTP 400 invalid_grant' },
    });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toContain('доступ к каналу «Linkeon» пропал (HTTP 400 invalid_grant) — ролики идут набором');
    expect(said()[0]).toContain('https://accounts.google.com/');
  });

  it('режим без подключённого канала — сохраняется, но с предупреждением и ссылкой', async () => {
    const { svc, settings, said, db } = setup();
    await svc.handleCommand(dm('/youtube публично'));
    expect(settings.update).toHaveBeenCalledWith({ youtubeMode: 'public' });
    expect(db.st.mode).toBe('public');
    expect(said()[0]).toMatch(/^Готово: ролики на YouTube — публично\. Но канал не подключён, поэтому пока набор\./);
    expect(said()[0]).toContain('https://accounts.google.com/');
  });

  it('режим при подключённом канале — коротко; «вручную» — про набор', async () => {
    const db = fakeDb({ account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube по ссылке'));
    await svc.handleCommand(dm('/youtube вручную'));
    expect(said()).toEqual(['Готово: ролики на YouTube — по ссылке.', 'Готово: YouTube — вручную, буду присылать набор.']);
  });

  it('незнакомый режим — подсказка, настройки не трогаем', async () => {
    const { svc, settings, said } = setup();
    expect(await svc.handleCommand(dm('/youtube громко'))).toBe(true);
    expect(settings.update).not.toHaveBeenCalled();
    expect(said()[0]).toBe('Не понял режим. Можно: /youtube публично, /youtube по ссылке, /youtube вручную.');
  });

  it('нет клиента OAuth на сервере — так и говорим', async () => {
    delete process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
    const { svc, said } = setup();
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toMatch(/^YouTube не настроен на этом сервере/);
  });

  it('стенд — пометка в сообщении', async () => {
    process.env.SHORTS_STAND = 'true';
    const { svc, said } = setup();
    await svc.handleCommand(dm('/youtube громко'));
    expect(said()[0].startsWith('[СТЕНД] ')).toBe(true);
  });
});

describe('адрес возврата Google', () => {
  const stateFor = (chat = OWNER): string => new URL(setup().svc.connectUrl(chat)).searchParams.get('state');
  const tokensOk = () =>
    reply(200, {
      access_token: 'access-xyz',
      refresh_token: 'refresh-xyz',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    });
  const channelOk = (title = 'Linkeon') => reply(200, { items: [{ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', snippet: { title, customUrl: '@linkeons' } }] });

  it('успех: канал с зашифрованным токеном, «вручную» → «по ссылке», сообщение владельцу, страница без токенов', async () => {
    const db = fakeDb();
    const { svc, said } = setup(db, fakeHttp(tokensOk(), channelOk()));
    const page = await svc.completeConnect({ code: 'code-1', state: stateFor() });
    expect(page.status).toBe(200);
    expect(page.html).toContain('Канал подключён');
    expect(page.html).not.toContain('refresh-xyz');
    expect(page.html).not.toContain('access-xyz');
    expect(db.st.account.channel_id).toBe('UCu_Pq4rFXmTT8CDG27O_i2A');
    expect(db.st.account.refresh_token_enc).not.toContain('refresh-xyz');
    expect(decryptSecret(db.st.account.refresh_token_enc)).toBe('refresh-xyz');
    expect(db.st.mode).toBe('unlisted');
    expect(said()[0]).toBe(
      'YouTube подключён: канал «Linkeon» (@linkeons). Ролики будут загружаться сами, режим — по ссылке. ' +
        'Проверьте первый ролик: если открывается по ссылке и не стал приватным — /youtube публично.',
    );
  });

  it('режим «публично» подключение не трогает', async () => {
    const db = fakeDb({ mode: 'public' });
    const { svc, said } = setup(db, fakeHttp(tokensOk(), channelOk()));
    await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(db.st.mode).toBe('public');
    expect(said()[0]).toContain('режим — публично.');
  });

  it('отмена на экране Google — страница, без запросов и сообщений', async () => {
    const { svc, http, tg } = setup();
    const page = await svc.completeConnect({ error: 'access_denied', state: stateFor() });
    expect(page.html).toContain('Подключение отменено');
    expect(http.http).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой или битый state — 400, без запросов', async () => {
    const { svc, http } = setup();
    for (const state of [undefined, 'x.y', stateFor(OWNER + 1)]) {
      const page = await svc.completeConnect({ code: 'c', state });
      expect(page.status).toBe(400);
      expect(page.html).toContain('Ссылка устарела');
    }
    expect(http.http).not.toHaveBeenCalled();
  });

  it('Google отказал в обмене — 502 и причина владельцу', async () => {
    const { svc, said } = setup(fakeDb(), fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Bad Request' })));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(502);
    expect(said()[0]).toBe('YouTube не подключён: обмен кода: HTTP 400 invalid_grant: Bad Request');
  });

  it('браузер повторил адрес возврата сразу после подключения — «уже подключён», бот молчит', async () => {
    const db = fakeDb({
      account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected', connected_at: new Date().toISOString() },
    });
    const { svc, tg } = setup(db, fakeHttp(reply(400, { error: 'invalid_grant' })));
    const page = await svc.completeConnect({ code: 'used', state: stateFor() });
    expect(page.status).toBe(200);
    expect(page.html).toContain('Канал уже подключён');
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('нет клиента OAuth — 503', async () => {
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const { svc } = setup();
    expect((await svc.completeConnect({ code: 'c', state: 'x' })).status).toBe(503);
  });

  it('текст страницы экранируется', () => {
    expect(connectPage(200, 'Канал <b>', 'a & "b"').html).toContain('Канал &lt;b&gt;</h1><p>a &amp; &quot;b&quot;</p>');
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "test(shorts): YouTube — команда /youtube и подключение канала (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-youtube.service.spec.ts 2>&1 | tail -15"
```

Expected: FAIL — `Cannot find module './shorts-youtube.service'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-youtube.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { approverChatId } from '../blog/blog-approval.service';
import { encryptSecret } from '../calendar/crypto';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { STAND_MARK } from './short-captions';
import { isStand } from './short-env';
import { ShortsSettingsService } from './shorts-settings.service';
import { YoutubeMode } from './shorts.types';
import { Http, axiosHttp } from './youtube/youtube-http';
import { authorizeUrl, exchangeCode, fetchMyChannel, youtubeOAuthConfig } from './youtube/youtube-oauth';
import { signState, verifyState } from './youtube/youtube-state';

/** Слова режимов — в командах и в сообщениях владельцу. */
export const MODE_WORDS: Record<YoutubeMode, string> = { manual: 'вручную', unlisted: 'по ссылке', public: 'публично' };

/** Повторный заход браузера на адрес возврата в эти минуты после подключения — не ошибка. */
const RECONNECT_GRACE_MS = 10 * 60 * 1000;

export interface YoutubeAccount {
  channelId: string;
  channelTitle: string | null;
  refreshTokenEnc: string;
  status: 'connected' | 'revoked';
  lastError: string | null;
  connectedAt: Date | null;
}

export interface ConnectPage {
  status: number;
  html: string;
}

/**
 * `/youtube [режим]` (и `/youtube@Бот`). null — не эта команда. arg пустой —
 * запрос статуса; arg непустой при mode null — режим не узнан.
 */
export function parseYoutubeCommand(text: unknown): { mode: YoutubeMode | null; arg: string } | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\/youtube(?:@[A-Za-z0-9_]+)?(?=\s|$)([\s\S]*)$/i);
  if (!m) return null;
  const arg = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  const mode = (Object.keys(MODE_WORDS) as YoutubeMode[]).find((k) => MODE_WORDS[k] === arg) ?? null;
  return { mode, arg };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Страница для браузера после входа в Google: заголовок и одна фраза, без токенов. */
export function connectPage(status: number, title: string, text: string): ConnectPage {
  return {
    status,
    html:
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Linkeon — YouTube</title></head>' +
      '<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">' +
      `<h1 style="font-size:22px">${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
  };
}

/**
 * YouTube роликов (спека 2026-10-27-shorts-youtube-autopublish-design.md):
 * подключение канала владельцем, режим, команда `/youtube`, загрузка ролика для
 * публикатора. Refresh-токен — в short_youtube_account, зашифрован
 * src/calendar/crypto.ts (как у Taler ID); access-токен живёт только в памяти.
 */
@Injectable()
export class ShortsYoutubeService {
  private readonly logger = new Logger(ShortsYoutubeService.name);
  /** HTTP к Google; тесты подставляют свой. */
  http: Http = axiosHttp;

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
  ) {}

  async account(): Promise<YoutubeAccount | null> {
    const r = await this.pg.query(`SELECT * FROM short_youtube_account WHERE id = 1`);
    const row = r.rows[0];
    if (!row) return null;
    return {
      channelId: row.channel_id,
      channelTitle: row.channel_title ?? null,
      refreshTokenEnc: row.refresh_token_enc,
      status: row.status === 'revoked' ? 'revoked' : 'connected',
      lastError: row.last_error ?? null,
      connectedAt: row.connected_at ? new Date(row.connected_at) : null,
    };
  }

  /** Ссылка на вход для владельца; null — на этой среде нет клиента OAuth. */
  connectUrl(chatId: number): string | null {
    const cfg = youtubeOAuthConfig();
    return cfg ? authorizeUrl(cfg, signState(cfg.clientSecret, cfg.redirectUri, chatId)) : null;
  }

  /**
   * `/youtube` — только владелец (`BLOG_APPROVER_TG_ID`) и только в личке, как
   * `/short`. Чужая команда не наша (false): бот ответит как на неизвестную.
   */
  async handleCommand(msg: any): Promise<boolean> {
    const cmd = parseYoutubeCommand(msg?.text);
    if (!cmd || msg?.chat?.type !== 'private') return false;
    const owner = approverChatId();
    if (!owner || Number(msg?.from?.id) !== owner) return false;
    const chatId = Number(msg?.chat?.id) || owner;
    try {
      if (cmd.arg && !cmd.mode) {
        await this.say(chatId, 'Не понял режим. Можно: /youtube публично, /youtube по ссылке, /youtube вручную.');
      } else if (cmd.mode) {
        await this.settings.update({ youtubeMode: cmd.mode });
        await this.say(chatId, await this.modeChanged(cmd.mode, chatId));
      } else {
        await this.say(chatId, await this.statusText(chatId));
      }
    } catch (e: any) {
      await this.say(chatId, `YouTube: не получилось — ${String(e?.message ?? e).slice(0, 300)}`);
    }
    return true;
  }

  /** Адрес возврата Google: проверить state, обменять код, запомнить канал, сказать владельцу. */
  async completeConnect(q: { code?: string; state?: string; error?: string }): Promise<ConnectPage> {
    const cfg = youtubeOAuthConfig();
    if (!cfg) return connectPage(503, 'YouTube не настроен', 'На этом сервере нет клиента OAuth YouTube.');
    if (q.error) return connectPage(200, 'Подключение отменено', 'Канал не подключён. Чтобы попробовать снова, пришлите боту /youtube.');
    const st = verifyState(cfg.clientSecret, cfg.redirectUri, q.state);
    const owner = approverChatId();
    if (!st || !owner || st.chatId !== owner) {
      return connectPage(400, 'Ссылка устарела', 'Пришлите боту /youtube и откройте новую ссылку.');
    }
    if (!q.code) return connectPage(400, 'Нет кода от Google', 'Пришлите боту /youtube и попробуйте ещё раз.');
    try {
      const tokens = await exchangeCode(this.http, cfg, q.code);
      const ch = await fetchMyChannel(this.http, tokens.accessToken);
      await this.pg.query(
        `INSERT INTO short_youtube_account
                (id, channel_id, channel_title, refresh_token_enc, scopes, status, last_error, connected_at, updated_at)
         VALUES (1, $1, $2, $3, $4, 'connected', NULL, now(), now())
         ON CONFLICT (id) DO UPDATE
            SET channel_id = EXCLUDED.channel_id, channel_title = EXCLUDED.channel_title,
                refresh_token_enc = EXCLUDED.refresh_token_enc, scopes = EXCLUDED.scopes,
                status = 'connected', last_error = NULL, connected_at = now(), updated_at = now()`,
        [ch.id, ch.title, encryptSecret(tokens.refreshToken), tokens.scope],
      );
      // Подключение при «вручную» включает «по ссылке»: первый ролик — проверка (спека, «Сценарий владельца»).
      // Канал хранится только в short_youtube_account; short_settings.youtube_channel_id не трогаем — одна правда.
      const r = await this.pg.query(
        `UPDATE short_settings
            SET youtube_mode = CASE WHEN youtube_mode = 'manual' THEN 'unlisted' ELSE youtube_mode END,
                updated_at = now()
          WHERE id = 1
          RETURNING youtube_mode`,
      );
      const mode: YoutubeMode = r.rows[0]?.youtube_mode ?? 'unlisted';
      const handle = ch.handle ? ` (${ch.handle})` : '';
      const check = mode === 'unlisted' ? ' Проверьте первый ролик: если открывается по ссылке и не стал приватным — /youtube публично.' : '';
      await this.say(st.chatId, `YouTube подключён: канал «${ch.title}»${handle}. Ролики будут загружаться сами, режим — ${MODE_WORDS[mode]}.${check}`);
      return connectPage(200, 'Канал подключён', `Канал «${ch.title}» подключён к роликам Linkeon. Вкладку можно закрыть — подтверждение пришло в Telegram.`);
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 300);
      const acc = await this.account().catch((): YoutubeAccount | null => null);
      if (acc?.status === 'connected' && acc.connectedAt && Date.now() - acc.connectedAt.getTime() < RECONNECT_GRACE_MS) {
        // Браузер повторил адрес возврата: код уже обменян, канал подключён только что.
        return connectPage(200, 'Канал уже подключён', `Канал «${acc.channelTitle ?? acc.channelId}» подключён. Вкладку можно закрыть.`);
      }
      this.logger.error(`подключение YouTube не удалось: ${reason}`);
      await this.say(st.chatId, `YouTube не подключён: ${reason}`);
      return connectPage(502, 'Не получилось подключить канал', `${reason}. Пришлите боту /youtube и попробуйте ещё раз.`);
    }
  }

  private async statusText(chatId: number): Promise<string> {
    const link = this.connectUrl(chatId);
    if (!link) return 'YouTube не настроен на этом сервере: нет YOUTUBE_OAUTH_CLIENT_ID и YOUTUBE_OAUTH_CLIENT_SECRET в .env.';
    const [acc, s] = await Promise.all([this.account(), this.settings.get()]);
    const howTo =
      'Подключить: откройте ссылку (действует 15 минут), войдите в Google и выберите канал Linkeon. ' +
      `На экране «Google не проверил это приложение» нажмите «Дополнительно» → «Перейти».\n${link}`;
    if (!acc) return `YouTube: канал не подключён — ролики идут набором.\n\n${howTo}`;
    const name = `«${acc.channelTitle ?? acc.channelId}»`;
    if (acc.status === 'revoked') {
      return `YouTube: доступ к каналу ${name} пропал${acc.lastError ? ` (${acc.lastError})` : ''} — ролики идут набором.\n\n${howTo}`;
    }
    return (
      `YouTube: подключён канал ${name}, режим — ${MODE_WORDS[s.youtubeMode]}.\n\n` +
      'Сменить режим: /youtube публично · /youtube по ссылке · /youtube вручную\n' +
      `Переподключить (ссылка действует 15 минут):\n${link}`
    );
  }

  private async modeChanged(mode: YoutubeMode, chatId: number): Promise<string> {
    if (mode === 'manual') return 'Готово: YouTube — вручную, буду присылать набор.';
    const done = `Готово: ролики на YouTube — ${MODE_WORDS[mode]}.`;
    const acc = await this.account();
    if (acc?.status === 'connected') return done;
    const link = this.connectUrl(chatId);
    return `${done} Но канал не подключён, поэтому пока набор.${link ? `\n\nПодключить (ссылка действует 15 минут):\n${link}` : ''}`;
  }

  /** Сообщение владельцу. Сбой Telegram глотаем: он не повод ронять команду, подключение или публикацию. */
  private async say(chatId: number | null, text: string): Promise<void> {
    if (!chatId) {
      this.logger.warn(`BLOG_APPROVER_TG_ID не задан — сообщить некому: ${text.slice(0, 200)}`);
      return;
    }
    try {
      await this.tg.sendMessage(chatId, `${isStand() ? STAND_MARK : ''}${text}`, { link_preview_options: { is_disabled: true } });
    } catch (e: any) {
      this.logger.warn(`не смог написать ${chatId}: ${e?.message ?? e}`);
    }
  }
}
```

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "feat(shorts): YouTube — команда /youtube, подключение канала, страница возврата

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-youtube.service.spec.ts 2>&1 | tail -15"
```

Expected: PASS.

---

### Task 6: Сервис — план, загрузка, сообщение о загрузке

**Files:**
- Modify: `src/shorts/shorts-youtube.service.ts`
- Test: `src/shorts/shorts-youtube.service.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts-youtube.service.spec.ts`:
- импорт крипто: `import { decryptSecret, encryptSecret } from '../calendar/crypto';`
- новый импорт: `import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';`
- в импорт сервиса добавить `PENDING_UPLOAD_NOTE`: `import { PENDING_UPLOAD_NOTE, ShortsYoutubeService, connectPage, parseYoutubeCommand } from './shorts-youtube.service';`
- в конец файла:

```ts
describe('загрузка ролика', () => {
  const CONNECTED = { channel_id: 'UCx', channel_title: 'Linkeon', status: 'connected' };
  const connected = (extra: any = {}) => fakeDb({ mode: 'public', account: { ...CONNECTED, refresh_token_enc: encryptSecret('refresh-xyz') }, ...extra });
  const video: any = {
    id: 'v1', videoKey: 'shorts/v1/video.mp4', lang: 'ru', attempts: 1,
    captions: { youtube: { title: 'Как не потерять залог', description: 'Описание\n\nhttps://my.linkeon.io/?utm_source=youtube', tags: ['аренда', 'залог'] } },
  };
  const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc';
  const TOKEN = reply(200, { access_token: 'access-xyz' });
  const alive = () => jest.fn(async () => true);
  const caught = (p: Promise<unknown>): Promise<any> => p.then(() => null, (e) => e);

  it('план: вручную — набор без заметки; нет канала, доступ пропал, нет клиента — набор с заметкой; иначе загрузка', async () => {
    expect(await setup(fakeDb({ mode: 'manual' })).svc.uploadPlan('v1')).toEqual({ kind: 'kit', note: null });
    expect(await setup(fakeDb({ mode: 'public' })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube' });
    expect(await setup(fakeDb({ mode: 'unlisted', account: { ...CONNECTED, refresh_token_enc: 'e', status: 'revoked' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: 'Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube' });
    expect(await setup(fakeDb({ mode: 'unlisted', account: { ...CONNECTED, refresh_token_enc: 'e' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'upload', privacy: 'unlisted' });
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    expect(await setup(fakeDb({ mode: 'public' })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: 'YouTube не настроен на сервере — набор вместо загрузки.' });
  });

  it('набор при живой сессии загрузки — с предупреждением проверить канал', async () => {
    expect(await setup(fakeDb({ mode: 'manual', session: SESSION })).svc.uploadPlan('v1')).toEqual({ kind: 'kit', note: PENDING_UPLOAD_NOTE });
    expect(await setup(fakeDb({ mode: 'public', session: SESSION, account: { ...CONNECTED, refresh_token_enc: 'e', status: 'revoked' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: `Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube ${PENDING_UPLOAD_NOTE}` });
  });

  it('загрузка: токен, сессия с метаданными, адрес лёг в базу до файла, файл с токеном, адрес стёрт', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), reply(201, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    const seen: any[] = [];
    const keepAlive = jest.fn(async () => {
      seen.push(db.st.session);
      return true;
    });
    expect(await svc.upload(video, 'public', keepAlive)).toEqual({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk' });
    expect(seen).toEqual([SESSION]);
    expect(db.st.session).toBeNull();
    const start = http.calls[1];
    expect(start.headers?.Authorization).toBe('Bearer access-xyz');
    expect(start.data.snippet).toEqual({
      title: 'Как не потерять залог', description: 'Описание\n\nhttps://my.linkeon.io/?utm_source=youtube', tags: ['аренда', 'залог'],
      categoryId: '27', defaultLanguage: 'ru', defaultAudioLanguage: 'ru',
    });
    expect(start.data.status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    expect(http.calls[2]).toMatchObject({ method: 'PUT', url: SESSION });
    expect(http.calls[2].headers?.Authorization).toBe('Bearer access-xyz');
    expect(Buffer.isBuffer(http.calls[2].data)).toBe(true);
  });

  it('прошлая сессия загружена — тот же ролик, без новой загрузки', async () => {
    const db = connected({ session: SESSION });
    const http = fakeHttp(TOKEN, reply(200, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    expect((await svc.upload(video, 'public', alive())).videoId).toBe('abcdefghijk');
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1].headers).toMatchObject({ Authorization: 'Bearer access-xyz', 'Content-Range': 'bytes */11' });
    expect(db.st.session).toBeNull();
  });

  it('прошлая сессия не догружена или кончилась отказом — адрес стёрт, новая загрузка', async () => {
    for (const answer of [reply(308), reply(400, { error: { message: 'bad metadata' } })]) {
      const db = connected({ session: SESSION });
      const http = fakeHttp(TOKEN, answer, reply(200, {}, { location: `${SESSION}2` }), reply(200, { id: 'newvideo123' }));
      const { svc } = setup(db, http);
      expect((await svc.upload(video, 'public', alive())).videoId).toBe('newvideo123');
      expect(http.calls).toHaveLength(4);
      expect(db.st.session).toBeNull();
    }
  });

  it('прошлая сессия истекла (404) — YoutubeUploadExpired, адрес остаётся (повтор снова пришлёт набор), новой загрузки нет', async () => {
    const db = connected({ session: SESSION });
    const http = fakeHttp(TOKEN, reply(404));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive()))).toBeInstanceOf(YoutubeUploadExpired);
    expect(db.st.session).toBe(SESSION);
    expect(http.calls).toHaveLength(2);
  });

  it('при живой сессии сбой токена или хранилища — YoutubeMaybeUploaded: прошлая загрузка не проверена, адрес остаётся', async () => {
    const a = connected({ session: SESSION });
    expect(await caught(setup(a, fakeHttp(reply(503, {}))).svc.upload(video, 'public', alive()))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(a.st.session).toBe(SESSION);
    const b = connected({ session: SESSION });
    const s = setup(b, fakeHttp(TOKEN));
    s.storage.download.mockRejectedValueOnce(new Error('minio down'));
    expect(await caught(s.svc.upload(video, 'public', alive()))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(b.st.session).toBe(SESSION);
  });

  it('о прошлой сессии нет ответа — YoutubeMaybeUploaded, адрес остаётся, новой загрузки нет', async () => {
    const db = connected({ session: SESSION });
    const http = fakeHttp(TOKEN, new Error('ETIMEDOUT'));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive()))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(db.st.session).toBe(SESSION);
    expect(http.calls).toHaveLength(2);
  });

  it('invalid_grant — YoutubeAuthError, аккаунт отозван с причиной; при живой сессии — pendingUpload', async () => {
    const a = connected();
    const ea = await caught(setup(a, fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))).svc.upload(video, 'public', alive()));
    expect(ea).toBeInstanceOf(YoutubeAuthError);
    expect(ea.pendingUpload).toBe(false);
    expect(a.st.account).toMatchObject({ status: 'revoked', last_error: 'HTTP 400 invalid_grant: Token has been expired or revoked.' });
    const b = connected({ session: SESSION });
    const eb = await caught(setup(b, fakeHttp(reply(400, { error: 'invalid_grant' }))).svc.upload(video, 'public', alive()));
    expect(eb).toBeInstanceOf(YoutubeAuthError);
    expect(eb.pendingUpload).toBe(true);
    expect(b.st.session).toBe(SESSION);
  });

  it('401 при начале сессии — YoutubeNotUploaded, аккаунт не отзываем', async () => {
    const db = connected();
    const { svc } = setup(db, fakeHttp(TOKEN, reply(401, { error: { message: 'Invalid Credentials' } })));
    const e = await caught(svc.upload(video, 'public', alive()));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(e).toMatchObject({ status: 401 });
    expect(db.st.account.status).toBe('connected');
  });

  it('токен не расшифровался — YoutubeAuthError и отзыв, без запросов к Google', async () => {
    const db = fakeDb({ mode: 'public', account: { ...CONNECTED, refresh_token_enc: 'битый' } });
    const { svc, http } = setup(db, fakeHttp());
    const e = await caught(svc.upload(video, 'public', alive()));
    expect(e).toBeInstanceOf(YoutubeAuthError);
    expect(e.message).toMatch(/не расшифровался/);
    expect(db.st.account.status).toBe('revoked');
    expect(http.http).not.toHaveBeenCalled();
  });

  it('файл оборвался, а YouTube говорит «загружено» — успех', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), reply(201, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    expect((await svc.upload(video, 'public', alive())).videoId).toBe('abcdefghijk');
    expect(db.st.session).toBeNull();
  });

  it('файл оборвался, YouTube говорит «не догружено» — YoutubeNotUploaded, адрес стёрт', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), reply(308));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive()))).toBeInstanceOf(YoutubeNotUploaded);
    expect(db.st.session).toBeNull();
  });

  it('файл оборвался, а сессия кончилась отказом — YoutubeNotUploaded с причиной Google, адрес стёрт', async () => {
    const db = connected();
    const http = fakeHttp(
      TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'),
      reply(403, { error: { message: 'limit', errors: [{ reason: 'uploadLimitExceeded' }] } }),
    );
    const { svc } = setup(db, http);
    const e = await caught(svc.upload(video, 'public', alive()));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(e).toMatchObject({ status: 403, message: 'отправка файла: HTTP 403 uploadLimitExceeded: limit' });
    expect(db.st.session).toBeNull();
  });

  it('файл оборвался и о сессии нет ответа — YoutubeMaybeUploaded, адрес остаётся', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), new Error('ECONNRESET'));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive()))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(db.st.session).toBe(SESSION);
  });

  it('файл: явный отказ 4xx — YoutubeNotUploaded, адрес стёрт (сессия на повторе повторила бы отказ)', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), reply(400, { error: { message: 'bad' } }));
    const { svc } = setup(db, http);
    const e = await caught(svc.upload(video, 'public', alive()));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(e).toMatchObject({ status: 400 });
    expect(db.st.session).toBeNull();
  });

  it('ролик ушёл из publishing до файла — YoutubeNotUploaded, файл не отправлен', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', jest.fn(async () => false)))).toBeInstanceOf(YoutubeNotUploaded);
    expect(http.calls).toHaveLength(2);
  });

  it('нет файла или подписей — YoutubeNotUploaded без запросов', async () => {
    const { svc, http } = setup(connected());
    expect(await caught(svc.upload({ ...video, videoKey: null }, 'public', alive()))).toBeInstanceOf(YoutubeNotUploaded);
    expect(await caught(svc.upload({ ...video, captions: null }, 'public', alive()))).toBeInstanceOf(YoutubeNotUploaded);
    expect(http.http).not.toHaveBeenCalled();
  });
});

describe('сообщение о загрузке', () => {
  it('«по ссылке» — ссылка и подсказка про «публично»', async () => {
    const { svc, said } = setup(fakeDb({ mode: 'unlisted', published: 'https://youtube.com/shorts/abcdefghijk' }));
    await svc.notifyUploaded('v1');
    expect(said()).toEqual(['Вышло на YouTube (по ссылке): https://youtube.com/shorts/abcdefghijk\nЕсли ролик открывается и не стал приватным — /youtube публично.']);
  });

  it('«публично» — без подсказки; набор (строки published нет) — молчим', async () => {
    const a = setup(fakeDb({ mode: 'public', published: 'https://youtube.com/shorts/abcdefghijk' }));
    await a.svc.notifyUploaded('v1');
    expect(a.said()).toEqual(['Вышло на YouTube (публично): https://youtube.com/shorts/abcdefghijk']);
    const b = setup(fakeDb({ mode: 'public' }));
    await b.svc.notifyUploaded('v1');
    expect(b.tg.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "test(shorts): YouTube — план публикации, загрузка без дублей, сообщение о загрузке (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-youtube.service.spec.ts 2>&1 | tail -20"
```

Expected: FAIL — `svc.uploadPlan is not a function` и т. п.

- [ ] **Step 3: Реализация**

В `src/shorts/shorts-youtube.service.ts` импорты привести к виду:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { approverChatId } from '../blog/blog-approval.service';
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { STAND_MARK } from './short-captions';
import { isStand } from './short-env';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortVideo, YoutubeMode, shortsBucket } from './shorts.types';
import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';
import { Http, axiosHttp, clip } from './youtube/youtube-http';
import { YoutubeOAuthConfig, authorizeUrl, exchangeCode, fetchMyChannel, refreshAccessToken, youtubeOAuthConfig } from './youtube/youtube-oauth';
import { signState, verifyState } from './youtube/youtube-state';
import { UploadMeta, checkUpload, sendFile, startUpload } from './youtube/youtube-upload';
```

После `interface ConnectPage` добавить:

```ts
/** «Образование»: ролики — короткие разборы житейских вопросов. */
export const YOUTUBE_CATEGORY_ID = '27';

/** Что делать с роликом на YouTube: набор владельцу (с заметкой — почему) или загрузка с этим доступом. */
export type YoutubePlan = { kind: 'kit'; note: string | null } | { kind: 'upload'; privacy: 'unlisted' | 'public' };

/** К набору, когда у ролика жива сессия загрузки: прошлая загрузка могла дойти (спека, «Публикация», п. 7). */
export const PENDING_UPLOAD_NOTE = 'Прошлая загрузка этого ролика на YouTube могла дойти — проверьте канал, прежде чем выкладывать вручную.';
```

В класс перед `private async statusText` добавить:

```ts
  /**
   * Загрузка — только когда режим не «вручную», клиент OAuth есть и канал подключён;
   * иначе набор. Набор при живой сессии загрузки ролика — с предупреждением: прошлая
   * загрузка могла дойти, и ручная выкладка дала бы дубль.
   */
  async uploadPlan(shortId: string): Promise<YoutubePlan> {
    const mode = (await this.settings.get()).youtubeMode;
    let note: string | null;
    if (mode === 'manual') {
      note = null;
    } else if (!youtubeOAuthConfig()) {
      note = 'YouTube не настроен на сервере — набор вместо загрузки.';
    } else {
      const acc = await this.account();
      if (acc?.status === 'connected') return { kind: 'upload', privacy: mode };
      note = acc
        ? 'Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube'
        : 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube';
    }
    if (await this.session(shortId)) note = [note, PENDING_UPLOAD_NOTE].filter(Boolean).join(' ');
    return { kind: 'kit', note };
  }

  /**
   * Загрузить ролик (спека, «Публикация»). Порядок: свежий access-токен (доступа нет —
   * YoutubeAuthError, с признаком живой сессии), вопрос о прошлой сессии, новая загрузка.
   * Новая загрузка начинается, только когда YouTube подтвердил, что прошлая не дошла:
   * не догружена (incomplete) или кончилась отказом (failed). Истёкшая сессия (gone) —
   * YoutubeUploadExpired: спросить не у кого, вслепую не грузим. Ответа нет —
   * YoutubeMaybeUploaded, адрес сессии остаётся для следующей попытки.
   */
  async upload(v: ShortVideo, privacy: 'unlisted' | 'public', keepAlive: () => Promise<boolean>): Promise<{ videoId: string; url: string }> {
    const yt = v.captions?.youtube;
    if (!v.videoKey || !yt) throw new YoutubeNotUploaded('у ролика нет файла или подписей YouTube');
    const cfg = youtubeOAuthConfig();
    if (!cfg) throw new YoutubeNotUploaded('YouTube не настроен на сервере');
    const acc = await this.account();
    const previous = await this.session(v.id);
    if (!acc || acc.status !== 'connected') throw new YoutubeAuthError('канал YouTube не подключён', !!previous);
    let accessToken: string;
    let video: Buffer;
    try {
      accessToken = await this.accessToken(cfg, acc, !!previous);
      video = await this.storage.download({ bucket: shortsBucket(), key: v.videoKey });
    } catch (e: any) {
      // Прошлая загрузка ещё не проверена — сказать «ролика нет» нельзя (спека, «Публикация», п. 7).
      if (previous && !(e instanceof YoutubeAuthError)) {
        throw new YoutubeMaybeUploaded(`прошлая загрузка не проверена: ${clip(String(e?.message ?? e), 200)}`);
      }
      throw e;
    }

    if (previous) {
      // Нет ответа — YoutubeMaybeUploaded наверх, адрес остаётся.
      const st = await checkUpload(this.http, previous, accessToken, video.length);
      if (st.state === 'complete') return this.done(v.id, st.videoId);
      // Истекла: адрес не стираем — повтор снова получит 404 и снова пришлёт набор, а не загрузит вслепую.
      if (st.state === 'gone') throw new YoutubeUploadExpired('YouTube уже не помнит прошлую загрузку этого ролика');
      // incomplete или failed — прошлая загрузка не дошла: грузим заново.
      await this.setSession(v.id, null);
    }

    const meta: UploadMeta = {
      title: yt.title,
      description: yt.description,
      tags: yt.tags ?? [],
      categoryId: YOUTUBE_CATEGORY_ID,
      language: v.lang || 'ru',
      privacy,
    };
    const sessionUrl = await startUpload(this.http, accessToken, meta, video.length);
    await this.setSession(v.id, sessionUrl);
    if (!(await keepAlive())) throw new YoutubeNotUploaded('ролик ушёл из publishing до отправки файла — не отправляю');
    try {
      return await this.done(v.id, await sendFile(this.http, sessionUrl, accessToken, video));
    } catch (e: any) {
      if (e instanceof YoutubeNotUploaded) {
        // Явный отказ — итог сессии: на повторе она повторила бы его, спрашивать незачем.
        await this.setSession(v.id, null);
        throw e;
      }
      if (!(e instanceof YoutubeMaybeUploaded)) throw e;
      // Снова без ответа — YoutubeMaybeUploaded наверх, адрес остаётся.
      const st = await checkUpload(this.http, sessionUrl, accessToken, video.length);
      if (st.state === 'complete') return this.done(v.id, st.videoId);
      if (st.state === 'gone') throw new YoutubeUploadExpired('YouTube уже не помнит загрузку этого ролика');
      await this.setSession(v.id, null);
      if (st.state === 'failed') throw new YoutubeNotUploaded(`отправка файла: ${st.reason}`, st.status);
      throw new YoutubeNotUploaded(`файл не дошёл до YouTube (${e.message})`);
    }
  }

  /** Свежий access-токен. Доступа нет — аккаунт отозван с причиной и YoutubeAuthError (pending — у ролика жива сессия). */
  private async accessToken(cfg: YoutubeOAuthConfig, acc: YoutubeAccount, pending: boolean): Promise<string> {
    let refreshToken: string;
    try {
      refreshToken = decryptSecret(acc.refreshTokenEnc);
    } catch {
      await this.revoke('токен не расшифровался — сменился CALENDAR_SECRET_KEY?');
      throw new YoutubeAuthError('токен канала не расшифровался — переподключите: /youtube', pending);
    }
    try {
      return await refreshAccessToken(this.http, cfg, refreshToken);
    } catch (e: any) {
      if (!(e instanceof YoutubeAuthError)) throw e;
      await this.revoke(e.message);
      throw new YoutubeAuthError(e.message, pending);
    }
  }

  /** После записи published: ссылка владельцу; при «по ссылке» — подсказка про «публично». Набор молчит: строки published нет. */
  async notifyUploaded(shortId: string): Promise<void> {
    try {
      const r = await this.pg.query(
        `SELECT url FROM short_publication WHERE short_id = $1 AND platform = 'youtube' AND status = 'published'`,
        [shortId],
      );
      const url = r.rows[0]?.url;
      if (!url) return;
      const mode = (await this.settings.get()).youtubeMode;
      const hint = mode === 'unlisted' ? '\nЕсли ролик открывается и не стал приватным — /youtube публично.' : '';
      await this.say(approverChatId(), `Вышло на YouTube (${MODE_WORDS[mode]}): ${url}${hint}`);
    } catch (e: any) {
      this.logger.warn(`ролик ${shortId}: сообщение о YouTube не отправлено: ${e?.message ?? e}`);
    }
  }

  /** Ролик на YouTube: стереть адрес сессии. Сбой стирания успех не отменяет. */
  private async done(shortId: string, videoId: string): Promise<{ videoId: string; url: string }> {
    await this.setSession(shortId, null).catch((e: any) => this.logger.warn(`ролик ${shortId}: адрес сессии не стёрт: ${e?.message ?? e}`));
    return { videoId, url: `https://youtube.com/shorts/${videoId}` };
  }

  private async session(shortId: string): Promise<string | null> {
    const r = await this.pg.query(`SELECT upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [shortId]);
    return r.rows[0]?.upload_session ?? null;
  }

  private async setSession(shortId: string, url: string | null): Promise<void> {
    await this.pg.query(
      `UPDATE short_publication SET upload_session = $2, updated_at = now() WHERE short_id = $1 AND platform = 'youtube'`,
      [shortId, url],
    );
  }

  private async revoke(reason: string): Promise<void> {
    await this.pg.query(
      `UPDATE short_youtube_account SET status = 'revoked', last_error = $1, updated_at = now() WHERE id = 1`,
      [clip(reason, 300)],
    );
  }
```

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "feat(shorts): YouTube — план публикации, загрузка без дублей по сессии, сообщение о загрузке

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-youtube.service.spec.ts src/shorts/youtube 2>&1 | tail -15"
```

Expected: PASS.

---

### Task 7: Адрес возврата Google

**Files:**
- Create: `src/shorts/shorts-youtube.controller.ts`
- Test: `src/shorts/shorts-youtube.controller.spec.ts`

- [ ] **Step 1: Падающий тест**

`src/shorts/shorts-youtube.controller.spec.ts`:

```ts
import 'reflect-metadata';
import { ShortsYoutubeController } from './shorts-youtube.controller';

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.set = jest.fn(() => r);
  r.type = jest.fn(() => r);
  r.send = jest.fn(() => r);
  return r;
}

describe('ShortsYoutubeController', () => {
  it('отдаёт страницу сервиса: статус, html, без кеша', async () => {
    const youtube = { completeConnect: jest.fn(async () => ({ status: 200, html: '<h1>ok</h1>' })) };
    const r = res();
    await new ShortsYoutubeController(youtube as any).callback({ code: 'c', state: 's' }, r);
    expect(youtube.completeConnect).toHaveBeenCalledWith({ code: 'c', state: 's', error: undefined });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(r.type).toHaveBeenCalledWith('html');
    expect(r.send).toHaveBeenCalledWith('<h1>ok</h1>');
  });

  it('повторённые параметры (массивы) не передаются', async () => {
    const youtube = { completeConnect: jest.fn(async () => ({ status: 400, html: 'x' })) };
    await new ShortsYoutubeController(youtube as any).callback({ code: ['a', 'b'], state: ['s'], error: 'access_denied' }, res());
    expect(youtube.completeConnect).toHaveBeenCalledWith({ code: undefined, state: undefined, error: 'access_denied' });
  });

  it('маршрут — GET shorts/youtube/oauth/callback, без guard', () => {
    expect(Reflect.getMetadata('path', ShortsYoutubeController)).toBe('shorts/youtube');
    expect(Reflect.getMetadata('path', ShortsYoutubeController.prototype.callback)).toBe('oauth/callback');
    expect(Reflect.getMetadata('method', ShortsYoutubeController.prototype.callback)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata('__guards__', ShortsYoutubeController.prototype.callback)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', ShortsYoutubeController)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "test(shorts): YouTube — адрес возврата Google (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-youtube.controller.spec.ts 2>&1 | tail -12"
```

Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-youtube.controller.ts`:

```ts
import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ShortsYoutubeService } from './shorts-youtube.service';

const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

/**
 * Адрес возврата Google после входа владельца (спека YouTube, «Сценарий
 * владельца»). Публичный: браузер приходит без токена кабинета, всё решает
 * подписанный state. С глобальным префиксом — /webhook/shorts/youtube/oauth/callback,
 * ровно так он зарегистрирован в Google Cloud.
 */
@Controller('shorts/youtube')
export class ShortsYoutubeController {
  constructor(private readonly youtube: ShortsYoutubeService) {}

  @Get('oauth/callback')
  async callback(@Query() q: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const page = await this.youtube.completeConnect({ code: str(q?.code), state: str(q?.state), error: str(q?.error) });
    res.status(page.status).set('Cache-Control', 'no-store').type('html').send(page.html);
  }
}
```

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "feat(shorts): YouTube — публичный адрес возврата Google

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-youtube.controller.spec.ts 2>&1 | tail -10"
```

Expected: PASS.

---

### Task 8: Публикатор — загрузка или набор

**Files:**
- Modify: `src/shorts/shorts-publisher.service.ts`
- Test: `src/shorts/shorts-publisher.service.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts-publisher.service.spec.ts`:
- импорт публикатора: `import { MAX_PUBLISH_ATTEMPTS, STUCK_PUBLISHING_MINUTES, ShortsPublisherService, YOUTUBE_MAY_BE_OUT } from './shorts-publisher.service';`
- новые импорты:
  `import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';`
  `import { PENDING_UPLOAD_NOTE } from './shorts-youtube.service';`
  `import { SEND_TIMEOUT_MS } from './youtube/youtube-upload';`
- функцию `setup` заменить на (добавлен пятый аргумент — сервис YouTube):

```ts
function setup(db = fakeDb(), channel: string | null = '-1003290853538', platforms: string[] = ['telegram', 'youtube'], youtube: any = undefined) {
  const tg = {
    // Бот поднят: TgGrammyClient создаёт его в onModuleInit, только если задан TG_BOT_TOKEN.
    getBot: jest.fn((): any => ({})),
    sendVideo: jest.fn(async (): Promise<any> => SENT),
    sendDocument: jest.fn(async () => ({ message_id: 601 })),
    sendMessage: jest.fn(async () => ({ message_id: 602 })),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ platforms, tgChannelChatId: channel })) };
  const svc = new ShortsPublisherService({ query: db.query } as any, tg as any, storage as any, settings as any, youtube);
  return { svc, tg, storage, db };
}
```

- в конец файла:

```ts
describe('ShortsPublisherService.publish — YouTube загрузкой', () => {
  const youtube = (plan: any) => ({
    uploadPlan: jest.fn(async () => plan),
    upload: jest.fn(),
    notifyUploaded: jest.fn(async () => undefined),
  });
  const UPLOAD = { kind: 'upload', privacy: 'unlisted' };
  const kitText = (tg: any): string => (tg.sendMessage.mock.calls[0] as any[])[1];

  it('загрузка: строка youtube published с id и ссылкой, владельцу — сообщение, набора нет', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk' });
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.uploadPlan).toHaveBeenCalledWith(ID);
    expect(yt.upload).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), 'unlisted', expect.any(Function));
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'published', external_id: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk' });
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(yt.notifyUploaded).toHaveBeenCalledWith(ID);
    expect(db.v.status).toBe('published');
  });

  it('продление живости из загрузки — то же, что у публикатора', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockImplementation(async (_v: any, _p: any, keepAlive: () => Promise<boolean>) => {
      expect(await keepAlive()).toBe(true);
      return { videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk' };
    });
    const { svc, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(db.v.status).toBe('published');
  });

  it('план — набор: заметка плана первой строкой, загрузки нет', async () => {
    const yt = youtube({ kind: 'kit', note: 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube' });
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.upload).not.toHaveBeenCalled();
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(kitText(tg).startsWith('Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube\n\nYouTube — заголовок:\nYT-заголовок')).toBe(true);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending' });
  });

  it('доступ пропал при загрузке — набор с причиной, ролик опубликован', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeAuthError('HTTP 400 invalid_grant: Token has been expired or revoked.'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(kitText(tg)).toMatch(/^Доступ к каналу YouTube пропал \(HTTP 400 invalid_grant: Token has been expired or revoked\.\) — набор вместо загрузки\. Переподключить: \/youtube/);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending' });
    expect(db.v.status).toBe('published');
  });

  it('отказ YouTube не на последней попытке — строка failed, ролик в approved, набора нет', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'published' });
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed', last_error: 'начало загрузки: HTTP 403 quotaExceeded: quota' });
    expect(db.v.status).toBe('approved');
  });

  it('отказ YouTube на последней попытке — набор с причиной, ролик опубликован', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    const { svc, tg, db } = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(kitText(tg)).toMatch(/^Не смог загрузить на YouTube: начало загрузки: HTTP 403 quotaExceeded: quota\. Выложите вручную\./);
    expect(db.v.status).toBe('published');
  });

  it('исход загрузки неизвестен не на последней попытке — повтор, набора нет', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeMaybeUploaded('отправка файла оборвалась: socket hang up'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube').last_error).toMatch(/спрошу YouTube о прошлой загрузке/);
    expect(db.v.status).toBe('approved');
  });

  it('исход неизвестен на последней попытке — набора нет, ролик failed с причиной про безопасный retry', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeMaybeUploaded('отправка файла оборвалась: socket hang up'));
    const { svc, tg, db } = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed' });
    expect(db.v.status).toBe('failed');
    expect(db.v.last_error).toContain(YOUTUBE_MAY_BE_OUT);
  });

  it('доступ пропал при живой сессии — к набору предупреждение проверить канал', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeAuthError('HTTP 400 invalid_grant', true));
    const { svc, tg } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(kitText(tg)).toContain(PENDING_UPLOAD_NOTE);
  });

  it('YouTube не помнит прошлую загрузку — набор с предупреждением, ролик опубликован', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeUploadExpired('YouTube уже не помнит прошлую загрузку этого ролика'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(kitText(tg).startsWith(`YouTube уже не помнит прошлую загрузку этого ролика — набор вместо загрузки. ${PENDING_UPLOAD_NOTE}`)).toBe(true);
    expect(db.v.status).toBe('published');
  });

  it('срок выгрузки файла с запасом меньше порога сторожа: живую выгрузку сторож не заберёт', () => {
    expect(SEND_TIMEOUT_MS + 60_000).toBeLessThan(STUCK_PUBLISHING_MINUTES * 60_000);
  });

  it('Telegram не вышел — к YouTube не идём', async () => {
    const yt = youtube(UPLOAD);
    const { svc, db } = setup(fakeDb(), null, ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.uploadPlan).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'pending' });
  });
});
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "test(shorts): публикатор — YouTube загрузкой, набор запасным путём (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-publisher.service.spec.ts 2>&1 | tail -25"
```

Expected: FAIL — нет `YOUTUBE_MAY_BE_OUT`, загрузка не вызывается. Прежние тесты набора — зелёные (без пятого аргумента — набор).

- [ ] **Step 3: Реализация**

В `src/shorts/shorts-publisher.service.ts`:

1. Импорты:

```ts
import { Injectable, Logger, Optional } from '@nestjs/common';
```

и после импорта `./shorts-settings.service`:

```ts
import { PENDING_UPLOAD_NOTE, ShortsYoutubeService, YoutubePlan } from './shorts-youtube.service';
```

после импорта `./shorts.types`:

```ts
import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';
import { clip } from './youtube/youtube-http';
```

2. После константы `STUCK_OTHER` добавить:

```ts
/**
 * Причина для владельца, когда на последней попытке YouTube не ответил, дошла ли
 * загрузка. Набора нет — ручная выкладка дала бы дубль. Повтор безопасен: перед
 * новой загрузкой сервис YouTube спрашивает о сохранённой сессии (upload_session);
 * если YouTube её уже не помнит (срок сессии не опубликован), придёт набор с
 * просьбой проверить канал.
 */
export const YOUTUBE_MAY_BE_OUT =
  'YouTube не ответил, дошла ли загрузка; retry безопасен — перед новой загрузкой спрошу YouTube о прошлой, а если он её уже не помнит, пришлю набор с просьбой проверить канал';
```

3. Конструктор:

```ts
  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
    // Последним и @Optional: спеки собирают публикатор позиционно. Без сервиса — набор,
    // как до автопубликации; что Nest его подставляет, сторожит shorts.module.spec.ts.
    @Optional() private readonly youtube?: ShortsYoutubeService,
  ) {}
```

4. В `publish()` блок YouTube заменить на:

```ts
    if (platforms.includes('youtube') && telegramDone) {
      if (!(await this.keepAlive(v.id))) return;
      const out = await this.platform(v, 'youtube', () => this.toYoutube(v));
      if (out === 'unrecorded') return;
      // Ссылку владельцу — только после записи published; про набор сервис молчит сам.
      if (out === 'done') await this.youtube?.notifyUploaded(v.id);
    }
```

5. Перед методом `youtubeKit` добавить:

```ts
  /**
   * YouTube: загрузка, когда владелец подключил канал и выбрал режим, иначе набор.
   * Набор вместо загрузки — и когда доступ пропал, и когда YouTube отказал на
   * последней попытке: ролик доходит до канала хотя бы руками. Если же на
   * последней попытке неизвестно, дошла ли загрузка, набора нет (дал бы дубль):
   * отказ с YOUTUBE_MAY_BE_OUT, ролик уходит в failed.
   */
  private async toYoutube(v: ShortVideo): Promise<PlatformResult> {
    const plan: YoutubePlan = this.youtube ? await this.youtube.uploadPlan(v.id) : { kind: 'kit', note: null };
    if (plan.kind === 'kit') return this.youtubeKit(v, plan.note);
    const last = v.attempts >= MAX_PUBLISH_ATTEMPTS;
    try {
      const up = await this.youtube.upload(v, plan.privacy, () => this.keepAlive(v.id));
      return { status: 'published', externalId: up.videoId, url: up.url };
    } catch (e: any) {
      if (e instanceof YoutubeAuthError) {
        const pending = e.pendingUpload ? ` ${PENDING_UPLOAD_NOTE}` : '';
        return this.youtubeKit(v, `Доступ к каналу YouTube пропал (${e.message}) — набор вместо загрузки. Переподключить: /youtube${pending}`);
      }
      if (e instanceof YoutubeUploadExpired) {
        return this.youtubeKit(v, `${e.message} — набор вместо загрузки. ${PENDING_UPLOAD_NOTE}`);
      }
      if (e instanceof YoutubeMaybeUploaded) {
        throw new Error(last ? `${YOUTUBE_MAY_BE_OUT} (${e.message})` : `${e.message} — повторю, сначала спрошу YouTube о прошлой загрузке`);
      }
      if (last) return this.youtubeKit(v, `Не смог загрузить на YouTube: ${clip(String(e?.message ?? e), 300)}. Выложите вручную.`);
      throw e;
    }
  }
```

6. Сигнатуру и текст набора: `private async youtubeKit(v: ShortVideo, note: string | null = null): Promise<PlatformResult> {` и в `sendMessage` первым куском текста — заметка:

```ts
    const msg: any = await this.tg.sendMessage(
      chatId,
      `${mark}${note ? `${note}\n\n` : ''}YouTube — заголовок:\n${yt.title}\n\nОписание:\n${yt.description}\n\nТеги: ${yt.tags.join(', ')}\n\n` +
        'Когда выложите, нажмите кнопку и пришлите ссылку ответом.',
      { reply_markup: buildYoutubeKeyboard(v.id) },
    );
```

Комментарий над `youtubeKit` заменить на: `YouTube набором: владельцу — файл документом (без пережатия), заголовок, описание, теги и кнопка «Выложил на YouTube». Заметка — почему набор вместо загрузки. Повторяется как обычно: дубль набора в личке безвреден.`

7. В комментарии над `rearmStuck` строку про «прочие (набор YouTube в личку — дубль безвреден)» заменить на: `прочие: набор YouTube в личку — дубль безвреден; загрузка YouTube перед повтором спрашивает YouTube о прошлой сессии (upload_session) — дубля на канале нет. Строка failed, ролик`.

- [ ] **Step 4: Зелёный прогон и коммит**

```bash
git add -A src/shorts && git commit -q -m "feat(shorts): публикатор — YouTube загрузкой, набор запасным путём

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-publisher.service.spec.ts 2>&1 | tail -15"
```

Expected: PASS, включая прежние тесты набора.

---

### Task 9: Модуль и бот

**Files:**
- Modify: `src/shorts/shorts.module.ts`, `src/tg-bot/tg-bot.service.ts`
- Test: `src/shorts/shorts.module.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/shorts/shorts.module.spec.ts`:
- импорты:

```ts
import { ShortsYoutubeController } from './shorts-youtube.controller';
import { ShortsYoutubeService } from './shorts-youtube.service';
```

- в тесте «AppModule: все провайдеры роликов в графе» в список классов добавить `ShortsYoutubeService, ShortsYoutubeController`;
- после теста «бот получает сервис роликов…»:

```ts
  it('бот и публикатор получают сервис YouTube — @Optional не прячет разрыв графа', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    const youtube = find(container, ShortsYoutubeService);
    expect(youtube).toBeInstanceOf(ShortsYoutubeService);
    expect(find(container, TgBotService).shortsYoutube).toBe(youtube);
    expect(find(container, ShortsPublisherService).youtube).toBe(youtube);
  });
```

- [ ] **Step 2: Красный прогон и коммит**

```bash
git add -A src && git commit -q -m "test(shorts): YouTube в графе Nest — бот и публикатор (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.module.spec.ts 2>&1 | tail -15"
```

Expected: FAIL — провайдера нет в графе.

- [ ] **Step 3: Модуль**

В `src/shorts/shorts.module.ts`:
- импорты `ShortsYoutubeController` и `ShortsYoutubeService`;
- `controllers: [ShortsController, ShortsYoutubeController],`
- в `providers` перед `ShortsPublisherService` — `ShortsYoutubeService,`
- `exports: [ShortsApprovalService, ShortsYoutubeService],`
- в JSDoc модуля добавить строку: `YouTube (спека 2026-10-27-shorts-youtube-autopublish-design.md): ShortsYoutubeService — боту для /youtube, публикатору для загрузки.`

- [ ] **Step 4: Бот**

В `src/tg-bot/tg-bot.service.ts`:
- после импорта `ShortsApprovalService`: `import { ShortsYoutubeService } from '../shorts/shorts-youtube.service';`
- в конструкторе после параметра `productActionsTg`:

```ts
    // YouTube роликов: команда /youtube владельца. Последним и @Optional, как ролики выше:
    // спеки собирают сервис позиционно. Что Nest его подставляет, сторожит shorts.module.spec.ts.
    @Optional() @Inject(forwardRef(() => ShortsYoutubeService))
    private readonly shortsYoutube?: ShortsYoutubeService,
```

- в `handleDmCommand` сразу после строки с `handleShortCommand`:

```ts
    // `/youtube [режим]` — подключение канала и режим автозагрузки роликов; только владелец.
    if (await this.shortsYoutube?.handleCommand(msg)) return;
```

- [ ] **Step 5: Зелёный прогон и коммит**

```bash
git add -A src && git commit -q -m "feat(shorts,tg-bot): YouTube в модуле роликов и команда /youtube в боте

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.module.spec.ts src/tg-bot 2>&1 | tail -20"
```

Expected: PASS; сюиты `src/tg-bot` — как в базе задачи 0.

---

### Task 10: Против живого Postgres

**Files:**
- Modify: `src/shorts/shorts.integration.spec.ts`

- [ ] **Step 1: Тесты**

В `src/shorts/shorts.integration.spec.ts`:
- `const MIGRATIONS = ['001_shorts.sql', '002_skits.sql', '003_youtube.sql'].map(…)` — дописать 003 в список;
- импорты:

```ts
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsYoutubeService } from './shorts-youtube.service';
```

- внутрь `maybe('ролики против живого Postgres', …)`, в конец:

```ts
  describe('YouTube против живой базы', () => {
    const OWNER = 37948399;
    const saved = { ...process.env };
    const reply = (status: number, data: any = {}, headers: any = {}) => ({ status, data, headers });
    const reset = async () => {
      await pool.query('TRUNCATE short_youtube_account');
      await pool.query(`UPDATE short_settings SET youtube_mode = 'manual' WHERE id = 1`);
    };

    beforeAll(() => {
      Object.assign(process.env, {
        BLOG_APPROVER_TG_ID: String(OWNER),
        YOUTUBE_OAUTH_CLIENT_ID: 'cid',
        YOUTUBE_OAUTH_CLIENT_SECRET: 'GOCSPX-it-secret',
        PUBLIC_BASE_URL: 'https://test.linkeon.io',
        CALENDAR_SECRET_KEY: 'k'.repeat(32),
      });
    });
    beforeEach(reset);
    afterAll(async () => {
      await reset();
      process.env = saved;
    });

    function service(responses: any[]) {
      const http = jest.fn(async () => {
        const n = responses.shift();
        if (!n) throw new Error('лишний запрос');
        if (n instanceof Error) throw n;
        return n;
      });
      const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
      const storage = { download: jest.fn(async () => Buffer.from('video-bytes')) };
      const svc = new ShortsYoutubeService(pgLike() as any, tg as any, storage as any, new ShortsSettingsService(pgLike() as any));
      svc.http = http as any;
      return { svc, http, tg };
    }

    it('003: умолчание manual, CHECK режима, колонка сессии', async () => {
      const def = await pool.query(
        `SELECT column_default FROM information_schema.columns WHERE table_name = 'short_settings' AND column_name = 'youtube_mode'`,
      );
      expect(def.rows[0].column_default).toContain('manual');
      await expect(pool.query(`UPDATE short_settings SET youtube_mode = 'private' WHERE id = 1`)).rejects.toThrow();
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'short_publication' AND column_name = 'upload_session'`,
      );
      expect(col.rowCount).toBe(1);
    });

    it('подключение пишет аккаунт и режим; повторное — та же единственная строка', async () => {
      const ok = () => [
        reply(200, { access_token: 'a', refresh_token: 'refresh-xyz', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' }),
        reply(200, { items: [{ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', snippet: { title: 'Linkeon' } }] }),
      ];
      const { svc } = service([...ok(), ...ok()]);
      const state = () => new URL(svc.connectUrl(OWNER)).searchParams.get('state');
      expect((await svc.completeConnect({ code: 'c1', state: state() })).status).toBe(200);
      expect((await svc.completeConnect({ code: 'c2', state: state() })).status).toBe(200);
      const acc = await pool.query('SELECT * FROM short_youtube_account');
      expect(acc.rowCount).toBe(1);
      expect(acc.rows[0]).toMatchObject({ id: 1, channel_id: 'UCu_Pq4rFXmTT8CDG27O_i2A', status: 'connected' });
      expect(decryptSecret(acc.rows[0].refresh_token_enc)).toBe('refresh-xyz');
      const s = await pool.query('SELECT youtube_mode FROM short_settings WHERE id = 1');
      expect(s.rows[0]).toEqual({ youtube_mode: 'unlisted' });
    });

    it('сессия загрузки: адрес в строке youtube до файла, после успеха — стёрт', async () => {
      await pool.query(`INSERT INTO short_youtube_account (id, channel_id, refresh_token_enc) VALUES (1, 'UCx', $1)`, [encryptSecret('refresh-xyz')]);
      const v = await insert({
        status: 'publishing',
        video_key: 'shorts/v/video.mp4',
        captions: { telegram: 't', vk: 'v', youtube: { title: 'T', description: 'D', tags: [] } },
      });
      await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'youtube', 'publishing')`, [v.id]);
      const SESSION = 'https://upload.example/s1';
      const read = async () =>
        (await pool.query(`SELECT upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [v.id])).rows[0].upload_session;
      let seen: string | null = null;
      const { svc } = service([reply(200, { access_token: 'a' }), reply(200, {}, { location: SESSION }), reply(201, { id: 'abcdefghijk' })]);
      const out = await svc.upload(v, 'unlisted', async () => {
        seen = await read();
        return true;
      });
      expect(out.videoId).toBe('abcdefghijk');
      expect(seen).toBe(SESSION);
      expect(await read()).toBeNull();
    });
  });
```

- [ ] **Step 2: Прогон на живой базе и коммит**

```bash
git add -A src/shorts && git commit -q -m "test(shorts): YouTube против живого Postgres — 003, подключение, сессия загрузки

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. studio/scripts/node-run.sh "SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | tail -25"
```

Expected: PASS, включая прежние живые тесты (в том числе «повторный накат не ждёт открытую пишущую транзакцию» — он теперь катит и 003). Если база `shorts_it` отсутствует — создать по рецепту из шапки спеки и повторить.

---

### Task 11: Гейты на ноде

**Files:** нет.

- [ ] **Step 1: Модуль и бот**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | tail -25"
```

Expected: число красных сюит — не больше базы задачи 0; новые сюиты зелёные.

- [ ] **Step 2: Типы и сборка**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx tsc -p tsconfig.build.json --noEmit && npm run build >/dev/null && echo GATES_OK"
```

Expected: `GATES_OK`.

- [ ] **Step 3: Отчёт контролёру** — числа тестов до и после, sha последнего коммита.

---

### Task 12: Ревью ветки

**Files:** по замечаниям.

- [ ] **Step 1:** ревью диффа `origin/main...feat/shorts-youtube` (навык superpowers:requesting-code-review): корректность, дубли на канале, утечки токенов, тексты владельцу, соответствие спеке.
- [ ] **Step 2:** исправить подтверждённое — каждое исправление с тестом, прогон задачи 11 повторить.

---

### Task 13 (OK): Слияние в main и выкат

**Files:** нет. **Только с явного OK владельца и после выката роликов на прод (план 5) и продуктов (очередь 2).**

- [ ] **Step 1: Сверка очереди.** `git fetch origin && git log --oneline -5 origin/main` — в main уже есть слияния `feat/shorts-prod` и очереди 2 продуктов, и владелец сказал, что их выкат завершён. Иначе — ждать.
- [ ] **Step 2: Rebase и гейты.** В рабочем дереве: `git rebase origin/main`, при конфликтах — разрешить и сообщить. Повторить задачу 11 и живые тесты задачи 10.
- [ ] **Step 3: Слияние из свежего клона на ноде:**

```bash
ssh dv@85.192.61.231 'set -e; rm -rf ~/ci/merge-shorts-youtube; git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git ~/ci/merge-shorts-youtube; cd ~/ci/merge-shorts-youtube; git fetch -q origin feat/shorts-youtube; git merge -q --no-ff FETCH_HEAD -m "Merge feat/shorts-youtube: автопубликация роликов на YouTube"; source ~/.nvm/nvm.sh >/dev/null; npm ci --silent; npx jest src/shorts src/tg-bot 2>&1 | tail -5; npx tsc -p tsconfig.build.json --noEmit && npm run build >/dev/null && echo MERGE_GATES_OK'
```

Expected: `MERGE_GATES_OK`.

- [ ] **Step 4: Пуш main** — только если origin/main не ушёл вперёд:

```bash
ssh dv@85.192.61.231 'cd ~/ci/merge-shorts-youtube && git fetch -q origin main && git merge-base --is-ancestor origin/main HEAD && git push -q origin HEAD:main && git log --oneline -1'
```

- [ ] **Step 5: Выкат** — `scripts/deploy.sh` без флагов, отвязанно, из того же свежего клона:

```bash
ssh dv@85.192.61.231 'cd ~/ci/merge-shorts-youtube && nohup bash scripts/deploy.sh > ~/ci/deploy-shorts-youtube.log 2>&1 < /dev/null & echo started'
```

Следить по логу, без `tail -f` в той же команде. Expected: обе фазы и оба smoke зелёные.

- [ ] **Step 6: Проверка выката:**
  - прод: `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://my.linkeon.io/webhook/shorts/youtube/oauth/callback` → `400 text/html…` (страница «Ссылка устарела»), а не 404 JSON. С мака прод может быть не виден — тогда с ноды или через релей по правилам памяти;
  - тест: то же с Basic Auth из `scripts/test-server.env.local`;
  - в логах API на обеих средах — `shorts migration 003_youtube.sql applied`.

---

### Task 14: Живая проверка с владельцем — стенд, затем прод

**Files:** нет.

- [ ] **Step 1: Стенд — подключение.** Владелец пишет `/youtube` боту @LinkeonTestBot, открывает ссылку, выбирает канал Linkeon, проходит экран «не проверено». Expected: страница «Канал подключён», в боте «YouTube подключён: канал «Linkeon» … режим — по ссылке».
- [ ] **Step 2: Стенд — ролик.** На ноде из `~/ci/wt/promo-shorts/studio` (`studio/.env` стенда):
  `npx tsx scripts/stand-admin.ts order topic='Как не потерять залог при аренде' rubric=assistant assistantId:=10`, затем `npx tsx scripts/stand-admin.ts start_now id=<id>`. Владелец одобряет ролик в боте, затем `npx tsx scripts/stand-admin.ts publish_now id=<id>`.
- [ ] **Step 3: Проверка.** Expected: пост в @linkeontest, в боте «Вышло на YouTube (по ссылке): https://youtube.com/shorts/<id>». Ролик не стал приватным: oEmbed отвечает 200 — `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=<id>` (WebFetch или curl с ноды; приватный ролик даёт 401/403/404). Владелец открывает ссылку в окне инкогнито.
- [ ] **Step 4: Стенд — назад в «вручную».** Владелец пишет тестовому боту `/youtube вручную`, чтобы стенд не грузил пробные ролики на настоящий канал. Пробный ролик владелец удаляет в YouTube Studio.
- [ ] **Step 5: Прод.** Владелец пишет `/youtube` боту @LinkeonAgentBot и подключает канал. Если на стенде ролик не заперт — `/youtube публично`; иначе остаётся «по ссылке» до решения владельца (запасной путь — аудит YouTube API, тексты заявки готовит исполнитель).
- [ ] **Step 6: Итоги.** Обновить память (`project_youtube_upload_unverified_not_private.md`: заперт или нет, режим прода) и спеку роликов (`2026-10-24-promo-shorts-design.md`, «Публикация»: YouTube — загрузкой).
