# YouTube роликов: жетон попытки и мелочи финального ревью — план

> **Для исполнителей-агентов:** обязательный навык — superpowers:subagent-driven-development (или superpowers:executing-plans). Шаги — чекбоксы `- [ ]`.

**Цель:** до подключения канала на проде закрыть I1 финального ревью (зависшая попытка публикации может дать второй ролик на канале) и мелочи M1–M9, M11.

**Архитектура:** жетон попытки — значение `attempts`, которое вернул захват: строки площадки (`short_publication.attempts`) и ролика (`short_video.attempts`). Каждая запись попытки после захвата идёт с условием на свой жетон. Попытка, чей жетон уже не совпадает (сторож вернул ролик в очередь, строку захватила новая попытка), ничего не пишет и не шлёт: исход `superseded`, `publish()` выходит молча. Мелочи — строже разбор ответа YouTube о сессии, угловые скобки в заголовке и описании, подключение одной транзакцией, строки лога, тексты и `.env.example`.

**Стек:** NestJS 10, pg, jest + ts-jest; живой Postgres (`SHORTS_PG_URL`) для `shorts.integration.spec.ts`.

**Основание:** финальное ревью ветки `feat/shorts-youtube` (27.10.2026), пункты I1 и M1–M11; краткий список — в конце `docs/superpowers/plans/2026-10-27-shorts-youtube-autopublish.md`. Первая часть уже в main (`33b73f6`) и выкачена 27.10; пробная загрузка на стенде 27.10 прошла (ролик вышел «по ссылке», не заперт в private). Ветка этой работы — `feat/shorts-youtube-2` от `origin/main` `c6de95f`. Параллельных правок `src/shorts` нет (ветка студии роликов `feat/promo-shorts` впереди main по `src/shorts` ни на коммит).

**Вне этой работы:**
- M10 (`RELEASED_SQL` не знает про `upload_session`) — воспроизводится только при `platforms: ['youtube']`, а ссылка на колонку 003 из общего SQL одобрения сделала бы одобрение и «Отклонить» зависимыми от наката 003.
- Ссылку, которую владелец присылает после ручной выкладки, никто не сверяет с каналом (на стенде так попала ссылка на чужой ролик) — заметка на будущее.

## Правила для исполнителя

- **Рабочее дерево:** `~/Downloads/spirits_back/.worktrees/shorts-youtube`, ветка `feat/shorts-youtube-2`. Все пути — от его корня.
- **Тесты, `tsc` и сборка — только на ноде, не на маке (CLAUDE.md).** Из корня дерева: `NODE_RUN_DIR=. studio/scripts/node-run.sh "<команда>"`. Скрипт пушит ветку, ставит дерево ноды на точный коммит и гонит команду в корне бэкенда. Незакоммиченное на ноду не уезжает: перед прогоном коммит (красный тест — с пометкой «(красный)»). Коды выхода: 75 — дерево занято (повторить через пару минут), 255 — ssh (повторить через 1–2 минуты), 3 — дерево ноды не встало на коммит (сообщить контролёру).
- **Живой Postgres:** `SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts` — база одноразовая, на ноде уже есть.
- **Секреты:** репозитории Linkeon публичные. Не печатать и не коммитить `.env`, токены, ключи; в тестах — выдуманные значения.
- **Слияние в `main`, выкат, правки `.env` на серверах — только с явного OK владельца.** Выкат — только `scripts/deploy.sh`.
- **Стиль:** комментарии и сообщения — по-русски, как в соседних файлах модуля; «ассистент», не «агент».

---

### Task 1: Жетон попытки (I1)

**Files:**
- Modify: `src/shorts/youtube/youtube-errors.ts` — класс `YoutubeAttemptSuperseded`
- Modify: `src/shorts/shorts-youtube.service.ts` — `upload(v, privacy, keepAlive, fence)`, чтение и записи сессии с жетоном
- Modify: `src/shorts/shorts-publisher.service.ts` — жетоны в `platform()`, `keepAlive`, `settle`, `finishAttempt`; исход `superseded`
- Test: `src/shorts/shorts-youtube.service.spec.ts`, `src/shorts/shorts-publisher.service.spec.ts`, `src/shorts/shorts.integration.spec.ts`

**Почему.** Сроки HTTP и MinIO ограничены, а у запросов в Postgres срока нет (`src/common/services/pg.service.ts`: только `connectionTimeoutMillis`). Попытка A может «проснуться» уже после того, как сторож (`rearmStuck`, порог `STUCK_PUBLISHING_MINUTES` = 10 мин) вернул ролик в очередь и строку YouTube захватила попытка B. Сейчас записи попытки проверяют только `status = 'publishing'`, а его держит и B. Пути к второму ролику на канале:

1. *(ревью)* A висит до `claimSession`. B захватывает ролик и строку, кладёт свой адрес S_B, шлёт файл. У A `claimSession` не проходит → `YoutubeMaybeUploaded` → `platform()` у A пишет `failed` в строку B, а `finishAttempt` возвращает ролик B в `approved`, пока B шлёт. Попытка C получает `previous = S_B`; YouTube отвечает 308 с неполным `Range` (B ещё шлёт) → C стирает S_B и грузит заново. Загружены оба.
2. *(ревью)* A читает адрес сессии уже после захвата B (`previous = S_B`), 308 неполный → A стирает адрес B; свой `claimSession` проходит (строка в `publishing`, адреса нет); `keepAlive` — true (ролик в `publishing` у B). Две отправки.
3. *(найден при разборе)* A положила свой адрес S_A и зависла в запросе `keepAlive` перед отправкой файла. Сторож отдал ролик B; B спросила YouTube о S_A (байтов нет — 308 без Range), стёрла S_A и начала свою загрузку. Запрос A наконец выполнился: ролик в `publishing` (у B) — `keepAlive` true, A шлёт файл в S_A. Два ролика.

**Жетон.** Захват площадки уже возвращает строку (`RETURNING *`): её `attempts` — жетон попытки на строку. Захват ролика в `publish()` возвращает ролик: `v.attempts` — жетон на ролик. Счётчики растут только при захвате; обнуляют их лишь действия владельца после сбоя (`retry` и `mark_published` в `src/shorts/shorts.controller.ts`). После обнуления первая новая попытка получает тот же счёт, что и зависшая старая, если та была первой, — жетон их не различит. Для этого старая должна провисеть дольше порога сторожа *и* пережить нажатие владельца. Самый правдоподобный источник такого зависания — скачивание файлов из MinIO без срока в `toTelegram` и `youtubeKit` (у загрузки YouTube срок уже есть, `DOWNLOAD_TIMEOUT_MS`): ему — срок (шаг 5b). Остаток — зависший больше 10 минут запрос в Postgres, переживший нажатие владельца, — записать допущением в комментарии у `platform()`.

«Строка моя» = `status = 'publishing' AND attempts = <жетон строки>`. «Ролик мой» = `status = 'publishing' AND attempts = <v.attempts>`.

- [ ] **Step 1: Класс ошибки** — в `src/shorts/youtube/youtube-errors.ts`:

```ts
/**
 * Попытка публикации уже не владеет строкой YouTube: пока она висела, сторож вернул
 * ролик в очередь, и строку захватила новая попытка (жетон — attempts захвата — не
 * совпал), или сторож уже перевёл строку в failed. Такая попытка ничего не пишет и не
 * шлёт: ни файла, ни отказа, ни набора, ни итога ролика — это теперь дело новой попытки.
 */
export class YoutubeAttemptSuperseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeAttemptSuperseded';
  }
}
```

- [ ] **Step 2: Тесты сервиса (красные)** — `src/shorts/shorts-youtube.service.spec.ts`. Фейковая база спеки уже моделирует строку публикации: добавить в неё `attempts` и условия с жетоном (`status = 'publishing' AND attempts = $n` в чтении и записях сессии). Все существующие вызовы `svc.upload(v, privacy, keepAlive)` → `svc.upload(v, privacy, keepAlive, 1)` при строке `status: 'publishing', attempts: 1`. Новые тесты (`describe('жетон попытки')`):
  1. в строке `attempts: 2`, жетон 1 → `YoutubeAttemptSuperseded`; к Google — ни одного запроса (ни токена, ни сессии); записей в строку нет;
  2. строка `status: 'failed'` (сторож забрал), `attempts: 1`, жетон 1 → `YoutubeAttemptSuperseded`, запросов к Google нет;
  3. между началом сессии и `claimSession` жетон в строке сменился (фейк ставит `attempts: 2` в ответ на POST начала сессии) → `YoutubeAttemptSuperseded`; PUT с файлом не уходил; `upload_session` не тронут;
  4. прошлая сессия есть, YouTube отвечает 308 без Range (не догружено), а к стиранию адреса жетон в строке уже 2 → `YoutubeAttemptSuperseded`; адрес не стёрт, новой сессии не начато;
  5. `keepAlive` вернул false → `YoutubeAttemptSuperseded` (раньше — `YoutubeNotUploaded`); файл не отправлен;
  6. сбой чтения базы в начале (запрос строки бросает обычную ошибку) — по-прежнему `YoutubeMaybeUploaded`.

  Красный коммит «test(shorts): YouTube — жетон попытки в загрузке (красный)», прогон `npx jest src/shorts/shorts-youtube.service.spec.ts`: новые тесты красные по нужной причине.

- [ ] **Step 3: Сервис** — `src/shorts/shorts-youtube.service.ts`:
  - сигнатура `async upload(v: ShortVideo, privacy: 'unlisted' | 'public', keepAlive: () => Promise<boolean>, fence: number)`; в doc-комментарий — абзац про жетон;
  - чтение в начале: `acc = await this.account(); previous = await this.ownSession(v.id, fence);` в том же `try`; в его `catch` первой строкой `if (e instanceof YoutubeAttemptSuperseded) throw e;`;
  - новый метод (старый `session()` остаётся для `uploadPlan` — там только чтение):

```ts
  /** Адрес сессии ролика — только пока строку YouTube держит эта попытка (жетон); иначе YoutubeAttemptSuperseded. */
  private async ownSession(shortId: string, fence: number): Promise<string | null> {
    const r = await this.pg.query(
      `SELECT upload_session, status, attempts FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`,
      [shortId],
    );
    const row = r.rows[0];
    if (!row || row.status !== 'publishing' || Number(row.attempts) !== fence) {
      throw new YoutubeAttemptSuperseded(
        `строку YouTube держит другая попытка (жетон ${fence}, в строке ${row ? `${row.status}, попытка ${row.attempts}` : 'строки нет'})`,
      );
    }
    return row.upload_session ?? null;
  }
```

  - `claimSession(shortId, url, fence)`: к условию `AND attempts = $3`; при `false` — `throw new YoutubeAttemptSuperseded('строку YouTube захватила другая попытка — файл не шлю')` вместо `YoutubeMaybeUploaded`. С жетоном адрес в «моей» строке может положить только эта попытка, так что провал значит «строка не моя»; сессия без байтов ролика не создаёт;
  - `clearSession(shortId, url, fence)`: `WHERE short_id = $1 AND platform = 'youtube' AND upload_session = $2 AND status = 'publishing' AND attempts = $3`; `rowCount === 0` → `throw new YoutubeAttemptSuperseded('адрес сессии уже не мой — строку держит другая попытка')`; все три вызова передают `fence`;
  - перед отправкой файла: `if (!(await keepAlive())) throw new YoutubeAttemptSuperseded('ролик или строку YouTube забрала другая попытка до отправки файла — не отправляю');`

  Зелёный прогон `npx jest src/shorts/shorts-youtube.service.spec.ts`, коммит «fix(shorts): YouTube — жетон попытки: сессию читает и пишет только попытка, захватившая строку».

- [ ] **Step 4: Тесты публикатора (красные)** — `src/shorts/shorts-publisher.service.spec.ts`:
  1. загрузка бросила `YoutubeAttemptSuperseded` на последней попытке (`attempts` ролика = `MAX_PUBLISH_ATTEMPTS`): набора нет (`sendDocument` не вызван), строку не трогали (нет `UPDATE short_publication … 'failed'`), ролик не трогали (нет `UPDATE short_video … approved/failed/published`), `notifyUploaded` не вызван;
  2. отказ площадки не записался (фейк отвечает `rowCount: 0` на `UPDATE short_publication SET status = 'failed' …` — жетон строки уже чужой) → `publish()` выходит без `settle` и `finishAttempt`;
  3. SQL продления живости ролика — с `attempts = $2` и `v.attempts`; SQL отказа в `platform()` — с `attempts` строки из захвата; SQL `finishAttempt` и `settle` — с `attempts` ролика (проверять параметры запросов, как соседние тесты);
  4. `keepAlive`, который публикатор передаёт в `upload()`, проверяет и ролик, и строку YouTube: вызвать его из фейкового `upload` и проверить SQL и параметры (`v.id`, `v.attempts`, `'youtube'`, жетон строки); фейковый `upload` получает жетон четвёртым аргументом.

  Красный коммит «test(shorts): публикатор — жетон попытки (красный)», прогон.

- [ ] **Step 5: Публикатор** — `src/shorts/shorts-publisher.service.ts`:
  - `PlatformOutcome` += `'superseded'` (в doc-комментарий: «попытка уже не владеет строкой или роликом — жетон не совпал: ничего не записано, выходим молча»);
  - `platform(v, platform, send: (fence: number) => Promise<PlatformResult>)`: после захвата `const fence = Number(claim.rows[0].attempts);`, `out = await send(fence);`; в `catch` первым:

```ts
      if (e instanceof YoutubeAttemptSuperseded) {
        this.logger.warn(`ролик ${v.id}, ${platform}: попытку сменила новая — ничего не пишу (${e.message})`);
        return 'superseded';
      }
```

  - запись отказа: `… WHERE short_id = $1 AND platform = $2 AND status = 'publishing' AND attempts = $4` с `fence`; `rowCount === 0` → лог `warn` «отказ не записан — строку держит другая попытка или сторож; выхожу» и `return 'superseded'`;
  - ветка `TelegramOutcomeUnknown`: CTE `pub` — с `AND attempts = $5` (жетон строки) и `RETURNING 1`; `UPDATE short_video … WHERE id = $1 AND status = 'publishing' AND attempts = $6 AND EXISTS (SELECT 1 FROM pub)` (`v.attempts`); исход по-прежнему `'unknown'`;
  - `keepAlive(v: ShortVideo)` вместо `keepAlive(id)`: `… WHERE id = $1 AND status = 'publishing' AND attempts = $2 RETURNING 1`; все вызовы (в `publish()` и `toTelegram`) передают `v`;
  - новый метод для отправки файла YouTube:

```ts
  /** Перед отправкой файла: ролик всё ещё у этой попытки и строка площадки — у неё же (оба жетона). */
  private async keepAliveFenced(v: ShortVideo, platform: ShortPlatform, fence: number): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE short_video SET updated_at = now()
        WHERE id = $1 AND status = 'publishing' AND attempts = $2
          AND EXISTS (SELECT 1 FROM short_publication
                       WHERE short_id = $1 AND platform = $3 AND status = 'publishing' AND attempts = $4)
        RETURNING 1`,
      [v.id, v.attempts, platform, fence],
    );
    if (r.rows.length) return true;
    this.logger.warn(`ролик ${v.id}, ${platform}: ролик или строку забрала другая попытка — останавливаюсь`);
    return false;
  }
```

  - `toYoutube(v, fence)`: `yt.upload(v, plan.privacy, () => this.keepAliveFenced(v, 'youtube', fence), fence)`; в `catch` первой строкой `if (e instanceof YoutubeAttemptSuperseded) throw e;` — до веток Auth, Expired, Maybe и `last`, иначе на последней попытке ушёл бы набор;
  - `publish()`: после Telegram — `if (out === 'unknown' || out === 'unrecorded' || out === 'superseded') return;`; после YouTube — `if (out === 'unrecorded' || out === 'superseded') return;`; вызов `this.platform(v, 'youtube', async (fence) => { const r = await this.toYoutube(v, fence); … })`; Telegram — `this.platform(v, 'telegram', () => this.toTelegram(v, settings))` (жетон ему не нужен);
  - `settle`: `… WHERE id = $1 AND status = 'publishing' AND attempts = $2` (`v.attempts`); `finishAttempt`: оба `UPDATE` — с `AND attempts = $3`;
  - `recordSent` — без жетона, намеренно; дописать в его комментарий: «Без жетона: правда о вышедшем посте или загруженном ролике важнее — следующая попытка иначе выложила бы его снова.»;
  - комментарий у `platform()` про допущение обнуления счётчиков (см. «Жетон» выше).

  Зелёный прогон `npx jest src/shorts`, коммит «fix(shorts): публикатор — жетон попытки: отказ, живость и итог ролика пишет только своя попытка, superseded — молча».

- [ ] **Step 5b: Срок скачивания в публикаторе.** `toTelegram` (видео и обложка) и `youtubeKit` (видео) качают из MinIO без срока: зависшее скачивание переживает порог сторожа, а после «Повторить» владельца жетон старой попытки может совпасть с новой (см. «Жетон»). Тест (красный): `storage.download` получает `abortSignal`; если скачивание не завершилось за `DOWNLOAD_TIMEOUT_MS` (фейковые таймеры jest), сигнал прерван и площадка уходит в обычный отказ — строка `failed`, без «исход неизвестен» (отправки ещё не было). Код — приватный метод публикатора по образцу `download()` сервиса YouTube:

```ts
  /** Файл из MinIO со сроком: зависшее скачивание не должно пережить порог сторожа (STUCK_PUBLISHING_MINUTES). */
  private async download(key: string): Promise<Buffer> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      return await this.storage.download({ bucket: shortsBucket(), key, abortSignal: abort.signal });
    } finally {
      clearTimeout(timer);
    }
  }
```

  (`DOWNLOAD_TIMEOUT_MS` — импорт из `./shorts-youtube.service`.) В `toTelegram` и `youtubeKit` — через него. Зелёный прогон, коммит «fix(shorts): публикатор — срок скачивания файлов ролика из MinIO».

- [ ] **Step 6: Живой Postgres** — `src/shorts/shorts.integration.spec.ts`, в `describe('YouTube против живой базы')`:
  1. «вариант 1»: строка youtube `publishing`, `attempts = 2`, `upload_session = S_B`; `svc.upload(v, 'unlisted', async () => true, 1)` (HTTP-фейк считает запросы) → `YoutubeAttemptSuperseded`, запросов к Google 0, строка без изменений (`upload_session = S_B`, `attempts = 2`);
  2. «захват сессии проигран»: строка `publishing`, `attempts = 1`, адреса нет; HTTP-фейк в ответ на начало сессии ставит в базе `attempts = 2` (имитация захвата B) и отдаёт адрес → `YoutubeAttemptSuperseded`, `upload_session` остался NULL, PUT файла не было;
  3. «старая попытка не трогает чужое»: ролик `publishing`, `attempts = 2` (у B), строка youtube `publishing`, `attempts = 2`; публикатор с устаревшим `v` (`attempts = 1`) и жетоном строки 1: продление живости перед файлом — false, отказ в `platform()` — 0 строк, после `finishAttempt` ролик по-прежнему `publishing` с `attempts = 2`. Через публичное поведение, где можно (`publish()` с фейковым сервисом YouTube), приватное — через `(publisher as any)`;
  4. сторож и новая попытка: ролик `publishing` с `updated_at` старше порога → `rearmStuck()` → ролик `approved`, строка `failed`; новая попытка (`publish()` с фейковым сервисом, чей `upload` запоминает жетон) получает жетон 2; записи с жетоном 1 после этого не проходят.

  Прогон `SHORTS_PG_URL=… npx jest src/shorts/shorts.integration.spec.ts`, коммит «test(shorts): жетон попытки против живой базы».

- [ ] **Step 7: Гейты задачи** — `npx jest src/shorts src/tg-bot` и `npx tsc -p tsconfig.build.json --noEmit` зелёные.

---

### Task 2: Разбор ответа о сессии и угловые скобки (M2, M3)

**Files:**
- Modify: `src/shorts/youtube/youtube-http.ts` — код причины Google
- Modify: `src/shorts/youtube/youtube-upload.ts` — `checkUpload`
- Modify: `src/shorts/short-captions.ts` — чистка `<` `>`
- Modify: `src/shorts/shorts-youtube.service.ts` — заголовок и описание в `meta`
- Modify: `src/shorts/shorts-publisher.service.ts` — заголовок и описание в наборе
- Test: `src/shorts/youtube/youtube-http.spec.ts`, `src/shorts/youtube/youtube-upload.spec.ts`, `src/shorts/short-captions.spec.ts`, `src/shorts/shorts-youtube.service.spec.ts`, `src/shorts/shorts-publisher.service.spec.ts`

**M2 — строже ответ о сессии** (сейчас: 308 с `Range` не в виде `bytes=0-N` считается «не догружено» и ведёт к новой загрузке; любой 403 — итоговый отказ, хотя может значить «сессия не этого аккаунта» после переподключения канала другим менеджером того же бренд-канала, и тогда прошлая загрузка могла дойти).

- [ ] **Step 1: Тесты (красные).** `youtube-http.spec.ts`: `googleReasonCode` — `{ error: { errors: [{ reason: 'quotaExceeded' }] } }` → `'quotaExceeded'`; строковое `error`, пустое тело, не-объект → `null`. `youtube-upload.spec.ts`, `checkUpload`:
  - 308 без Range → `incomplete` (как было);
  - 308 с `Range: bytes=0-99` при размере 1000 → `incomplete` (как было);
  - 308 с `Range: bytes=100-200` → `YoutubeMaybeUploaded`;
  - 308 с `Range: garbage` → `YoutubeMaybeUploaded`;
  - 403 без тела → `YoutubeMaybeUploaded`;
  - 403 с причиной `forbidden` → `YoutubeMaybeUploaded`;
  - 403 с причиной `quotaExceeded` и с `uploadLimitExceeded` → `failed`;
  - 400 с причиной → `failed` (как было).

  Красный коммит, прогон.

- [ ] **Step 2: Код.** В `youtube-http.ts`:

```ts
/** Код причины из тела ошибки Google (`error.errors[0].reason`), если он есть. */
export function googleReasonCode(r: HttpResponse): string | null {
  const err = r.data && typeof r.data === 'object' ? r.data.error : undefined;
  const reason = err && typeof err === 'object' ? err.errors?.[0]?.reason : undefined;
  return typeof reason === 'string' && reason ? reason : null;
}
```

  В `youtube-upload.ts`, `checkUpload` — ветка 308:

```ts
  if (r.status === 308) {
    const range = String(r.headers?.range ?? '').trim();
    // Байтов не получено — не догружено.
    if (!range) return { state: 'incomplete' };
    const m = /^bytes=0-(\d+)$/.exec(range);
    // Ответ не по протоколу — решать по нему нельзя.
    if (!m) throw new YoutubeMaybeUploaded(`YouTube ответил о загрузке непонятным Range: ${clip(range, 60)}`, 308);
    if (Number(m[1]) + 1 >= size) throw new YoutubeMaybeUploaded('YouTube получил файл целиком, ролика в ответе ещё нет', 308);
    return { state: 'incomplete' };
  }
```

  и перед веткой итогового отказа:

```ts
  // 403 бывает и «сессия не этого аккаунта» (канал переподключил другой менеджер бренд-канала):
  // итоговым отказом считаем только явные лимиты, остальное — исход неизвестен.
  if (r.status === 403 && !FINAL_403_REASONS.has(googleReasonCode(r) ?? '')) {
    throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${googleReason(r)}`, 403);
  }
```

  где `const FINAL_403_REASONS = new Set(['quotaExceeded', 'uploadLimitExceeded']);` (`clip` и `googleReasonCode` — из `./youtube-http`). Обновить doc-комментарий `checkUpload` (308 с непонятным Range и 403 без явного лимита — исход неизвестен). Зелёный прогон, коммит «fix(shorts): YouTube — 308 с непонятным Range и 403 без явного лимита на вопрос о сессии — исход неизвестен».

**M3 — угловые скобки.** YouTube отвергает `<` и `>` в заголовке и описании (400): три попытки впустую, потом набор. Теги уже чистятся (`tidyTags`), заголовок и описание — нет.

- [ ] **Step 3: Тесты (красные).** `short-captions.spec.ts`: `youtubeSafe('Права <работника> > всего')` → `'Права ‹работника› › всего'`; строка без скобок не меняется. Спека сервиса: в теле POST начала сессии заголовок и описание без `<` `>` (подписи ролика с `<`). Спека публикатора: в тексте набора заголовок и описание тоже без них. Красный коммит, прогон.

- [ ] **Step 4: Код.** В `short-captions.ts`:

```ts
/**
 * YouTube отвергает `<` и `>` в заголовке и описании (400 — ролик не загрузится, и
 * Studio при ручной выкладке их тоже не примет): заменяем на похожие одиночные ёлочки.
 */
export function youtubeSafe(s: string): string {
  return s.replace(/</g, '‹').replace(/>/g, '›');
}
```

  В `upload()` сервиса: `title: youtubeSafe(yt.title)`, `description: youtubeSafe(yt.description)`. В `youtubeKit` публикатора — заголовок и описание через `youtubeSafe`. Зелёный прогон `npx jest src/shorts`, коммит «fix(shorts): YouTube — угловые скобки в заголовке и описании заменяются (загрузка и набор)».

---

### Task 3: Подключение одной транзакцией, строки лога, предупреждение публикатора, нет колонки 003 (M7, M5, M6, M1)

**Files:**
- Modify: `src/shorts/shorts-youtube.service.ts`
- Modify: `src/shorts/shorts-publisher.service.ts`
- Test: `src/shorts/shorts-youtube.service.spec.ts`, `src/shorts/shorts-publisher.service.spec.ts`

- [ ] **Step 1: Тесты (красные)** — на всё ниже, коммит «(красный)», прогон.

- [ ] **Step 2: M7 — подключение одной транзакцией.** Сейчас аккаунт уже записан, а сбой `UPDATE short_settings` даёт страницу 502 «не получилось». В `completeConnect` оба запроса — в `inTransaction(this.pg, async (tx) => { … })` (`import { inTransaction } from '../blog/blog-slot-claim'`; `PgService` подходит как `TxSource` — у него есть `getClient()`, так его уже передаёт блог). Сообщение владельцу и страница — после транзакции. Тест: `UPDATE short_settings` бросает → `ROLLBACK`, страница 502, сообщение «YouTube не подключён: …», `COMMIT` не было. Фейковая база спеки должна уметь `getClient()` (`query`, `release`) и записывать `BEGIN`/`COMMIT`/`ROLLBACK`.

- [ ] **Step 3: M5 — строки лога.** Сейчас всё это видно только в Telegram владельца и в `last_error`. Logger Nest, значения — через `clip`, без токенов:
  - подключение удалось — `log`: `` `YouTube подключён: канал ${ch.id} «${ch.title}», режим ${mode}` ``;
  - адрес возврата пришёл с `error` от Google — `warn`: `` `YouTube: вход в Google не завершён (error=${clip(q.error, 100)})` ``;
  - смена режима командой — `log`: `` `YouTube: режим ${cmd.mode} — командой владельца` ``;
  - отзыв подключения (`revoke`) — `warn`: `` `YouTube: подключение отозвано — ${reason}` ``; если `rowCount === 0` — `` `YouTube: токен не сработал (${reason}), но канал уже переподключён — не трогаю` ``;
  - загрузка удалась — `log`: `` `ролик ${v.id}: на YouTube ${videoId}${resumed ? ', нашёлся по прошлой сессии' : ''}` ``;
  - набор вместо загрузки — `warn` в `youtubeKit` публикатора, если `note` не пуст: `` `ролик ${v.id}: YouTube набором — ${clip(note, 300)}` `` (режим «вручную» — заметки нет, строки нет).

  Тесты: на каждую строку — `jest.spyOn(Logger.prototype, 'log' | 'warn')` и проверка вызова с подстрокой.

- [ ] **Step 4: M6 — публикатор без сервиса YouTube.** Бот в этом случае предупреждает, публикатор молчит, а набор уходит без проверки живой сессии. `ShortsPublisherService implements OnModuleInit`:

```ts
  onModuleInit(): void {
    if (!this.youtube && shortsEnabled()) {
      this.logger.warn('ролики: ShortsYoutubeService не подставлен — YouTube только набором, без проверки прошлой загрузки');
    }
  }
```

  (`shortsEnabled` — из `./short-env`). Тест: без сервиса и с `SHORTS_ENABLED=true` — warn; с сервисом — нет.

- [ ] **Step 5: M1 — нет колонки `upload_session`.** Если накат 003 сорвался, каждый набор сейчас уходит с ложным «прошлая загрузка могла дойти» и warn на каждый ролик. В `uploadPlan`, `catch` вокруг `session()`:

```ts
    } catch (e: any) {
      if (e?.code === '42703') {
        // Нет колонки — миграция 003 не накатилась: загрузок не было, предупреждать не о чем.
        this.logger.error('YouTube: нет колонки upload_session — миграция 003 не накатилась; набор без предупреждения о прошлой загрузке');
        pending = false;
      } else {
        // Не смогли прочитать адрес — не знаем, была ли загрузка: предупреждаем в безопасную сторону.
        this.logger.warn(`ролик ${shortId}: адрес сессии YouTube не прочитан: ${e?.message ?? e}`);
        pending = true;
      }
    }
```

  Тест: ошибка с `code: '42703'` → набор без `PENDING_UPLOAD_NOTE`, `logger.error` вызван.

  Зелёный прогон `npx jest src/shorts src/tg-bot`, коммиты по смыслу.

---

### Task 4: Контракт настроек, ссылка при сбое итога, тексты про «публично», `.env.example`, шапка 003, спека (M4, M8, M9, M11)

**Files:**
- Modify: `src/shorts/shorts-settings.service.ts` — `validateSettingsPatch`
- Modify: `src/shorts/shorts.controller.ts` — `update_settings`
- Modify: `src/shorts/shorts-publisher.service.ts` — `publish()`
- Modify: `src/shorts/shorts-youtube.service.ts` — тексты
- Modify: `.env.example`, `src/shorts/migrations/003_youtube.sql` (только комментарий)
- Modify: `docs/superpowers/specs/2026-10-27-shorts-youtube-autopublish-design.md`, `docs/superpowers/plans/2026-10-27-shorts-youtube-autopublish.md`
- Test: `src/shorts/shorts-settings.service.spec.ts`, `src/shorts/shorts.controller.spec.ts`, `src/shorts/shorts-publisher.service.spec.ts`, `src/shorts/shorts-youtube.service.spec.ts`

- [ ] **Step 1: M4 — неизменённый режим в настройках.** Клиент, который шлёт настройки целиком (так устроена вкладка блога), получает 400, как только режим не `manual`. `validateSettingsPatch(body, currentYoutubeMode?: YoutubeMode)`: если `b.youtubeMode === currentYoutubeMode` — поле в патч не попадает, без ошибки; иначе как сейчас. Контроллер `update_settings`: `validateSettingsPatch(data.settings, (await this.settings.get()).youtubeMode)`. Тесты: текущий `public`, патч с `public` → 200, режим не тронут; патч с `unlisted` → 400; патч с `manual` → `manual`.

- [ ] **Step 2: M8 — ссылка владельцу при сбое итога.** Если `settle()` упадёт после записи `published`, ссылка не уйдёт никогда. В `publish()`:

```ts
    try {
      await this.settle(v, platforms);
    } finally {
      // Ссылку — и при сбое итога: строка YouTube уже published, повтор её не загрузит и не сообщит.
      if (uploaded) void this.youtube?.notifyUploaded(v.id, uploaded.privacy);
    }
```

  Тест: `UPDATE short_video … published` бросает → `notifyUploaded` всё равно вызван.

- [ ] **Step 3: M9 — прежние ролики «по ссылке».** Сообщения про `/youtube публично` не говорят, что уже загруженные ролики так и останутся по ссылке. Тексты в `shorts-youtube.service.ts`:
  - `modeChanged('public')` при исправном подключении: `Готово: ролики на YouTube — публично. Уже загруженные «по ссылке» так и останутся по ссылке — их доступ меняется в YouTube Studio.`
  - `notifyUploaded`, подсказка при `unlisted`: `\nЕсли ролик открывается и не стал приватным — /youtube публично. Сам этот ролик останется по ссылке — его доступ меняется в YouTube Studio.`
  - сообщение о подключении (`check`): ` Проверьте первый ролик: если открывается по ссылке и не стал приватным — /youtube публично (сам он останется по ссылке — доступ меняется в YouTube Studio).`

  Обновить ожидаемые строки в тестах.

- [ ] **Step 4: M11 — `.env.example`.** В блок YouTube после `PUBLIC_BASE_URL=`:

```
# Токен канала хранится зашифрованным ключом CALENDAR_SECRET_KEY (тот же, что у календаря
# Taler ID; не короче 32 символов). Без ключа загрузка не работает; смена ключа отзывает
# подключение — канал подключается заново командой /youtube.
CALENDAR_SECRET_KEY=
```

- [ ] **Step 5: Шапка 003.** В `src/shorts/migrations/003_youtube.sql`, раздел «ОТКАТ», первой строкой: `--   0. В боте: /youtube вручную — иначе при повторном выкате загрузка включится сразу со старым режимом и аккаунтом.` Только комментарий: файл катается на каждом старте, SQL не меняется.

- [ ] **Step 6: Спека и план.** Спека `docs/superpowers/specs/2026-10-27-shorts-youtube-autopublish-design.md`:
  - в «Публикация» — абзац «Жетон попытки»: что это (attempts захвата строки и ролика), какие записи с условием (сессия: чтение, захват, стирание; отказ площадки; живость перед файлом; итог ролика), исход `superseded` — молча, без записей и без набора; `recordSent` — без жетона намеренно; допущение обнуления счётчиков (`retry`, `mark_published`);
  - в таблицу «Ошибки» — строки: «строку или ролик держит другая попытка (жетон не совпал) → ничего не пишем и не шлём, разбирается новая попытка или сторож»; «308 с Range не по протоколу → исход неизвестен»; «403 на вопрос о сессии без явного лимита (`quotaExceeded`, `uploadLimitExceeded`) → исход неизвестен»;
  - «Вне этой работы»: I1 закрыт (ссылка на этот план); M10 и сверка ссылки из набора с каналом — остаются.

  План `docs/superpowers/plans/2026-10-27-shorts-youtube-autopublish.md`, раздел «Итог после всех кругов ревью» — дописать: «Закрыто планом `2026-10-27-shorts-youtube-fencing.md`: I1, M1–M9, M11; M10 — вне работы.»

  Зелёные `npx jest src/shorts src/tg-bot` и `npx tsc -p tsconfig.build.json --noEmit`, коммиты по смыслу.

---

### Task 5: Гейты, финальное ревью, слияние и выкат (OK владельца)

- [ ] **Step 1: Гейты** на результате слияния с текущим `origin/main`, на ноде, с честным кодом выхода (`set -o pipefail`): `npx jest src/shorts src/tg-bot`, `npx tsc -p tsconfig.build.json --noEmit`, `npm run build`, живой `shorts.integration.spec.ts`.
- [ ] **Step 2: Финальное ревью** всей ветки — отдельный ревьюер, сильнейшая модель.
- [ ] **Step 3 (OK владельца): Слияние и выкат.** Слияние в `main` из свежего клона на ноде, пуш со сверкой merge-base; выкат `scripts/deploy.sh` отвязанно, с журналом.
- [ ] **Step 4: Стенд живьём.** Подключение стенда к @Linkeons оставлено 27.10 ради этой проверки: на стенде `/youtube по ссылке`, повторная загрузка ролика (как 27.10) — с жетоном. Затем стенд в «вручную» и удаление строки `short_youtube_account` стенда, чтобы токен настоящего канала не лежал в тестовой базе. Доступ приложения в аккаунте Google не отзывать: клиент общий, отзыв снял бы и прод.
- [ ] **Step 5 (с владельцем): Прод.** Владелец подключает канал командой `/youtube` в @LinkeonAgentBot; первый ролик — по ссылке или сразу `/youtube публично` — решает владелец. Первую загрузку прода смотреть по логу (`ролик …: на YouTube …`).
