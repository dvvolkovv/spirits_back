# Ссылки на разделы, проверенные источники и роли ассистентов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** показывая, где раздел, ассистент даёт ссылку https://my.linkeon.io/…, и кабинет по ней сразу раскрывает нужный блок и прокручивает к карточке, в том числе после входа. Факт из внешнего источника ассистент сообщает со ссылкой на открытую страницу. Узкий специалист сначала предлагает коллегу. Картинки в презентации подбираются под свой слайд.

**Architecture:** три независимых трека. **Фронт** (`spirits_front`): модуль адресов `src/utils/cabinetSections.ts`. По `/profile?open=<карточка>` профиль раскрывает блок и прокручивает к якорю. Старые `/settings` и `/referral` сохраняют параметры. Вход помнит адреса разделов с параметром. Своя ссылка в чате и в поддержке открывается в той же вкладке, ссылки поддержки нажимаются. **Бэк** (`spirits_back`): таблица абсолютных адресов `src/platform-kb/section-links.ts`. Из неё берутся строки «Ссылка…» в разделе «Где» статей (через `url()` контекста сборки) и адреса в перечне разделов `platformSections`; рядом лежит правило ссылок двух видов (markdown — веб и приложения, только адрес — Telegram и поддержка). Блок «Коллеги» собирается функцией от категории (`src/chat/colleagues-rule.ts`). **Релей** (`relay-agent/server.mjs`, отдельная ветка): меняются только текст правил 4 и 9 и новый абзац «ПРОВЕРКА ФАКТОВ», плюс сторож этого текста. Таблицы фронта и бэка — две копии одной, их сверяет общая таблица в двух спеках (задача С1).

**Tech Stack:** React 18 + Vite + vitest + react-router v6 (фронт); NestJS 10 + jest/ts-jest (бэк); node `.mjs` (релей — его текст сторожит jest бэка).

**Спека:** `docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md` (ветка `feat/assistant-links`, коммит `307aea55`): разделы «Решение», «Решения владельца (27.10.2026)», «Тесты», «Выкат». Где план расходится со спекой, главнее раздел «Решения плана» ниже. Задача С2 переносит его в спеку.

---

## Общее

### Где работать

- **План читать только отсюда:** `$B/docs/superpowers/plans/2026-10-27-assistant-links-sources-roles.md`. Копии в других чекаутах устаревают (заметка памяти «План — из воркдерева»).
- **Трек 1, фронт:** `F=/Users/dmitry/Downloads/spirits_front/.worktrees/assistant-links`, ветка `feat/assistant-links` от `origin/main` (на 27.10 — `c4b0d2a`). Заводится в задаче Ф0. Общий чекаут `~/Downloads/spirits_front` не трогать: он на чужой ветке, в нём работают другие сессии.
- **Трек 2, бэк:** `B=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links`, ветка `feat/assistant-links` (уже есть: `main` 407c097e + спека + этот план).
- **Трек 3, релей:** `R=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links-relay`, ветка `feat/assistant-links-relay` от `origin/main`. Заводится в задаче Р0. Отдельная ветка нарочно, см. решение плана 14.
- Перед каждой задачей `git -C <воркдерево> branch --show-current` должен вернуть ветку своего трека. Иначе — СТОП, доложить.
- На ноде у каждого трека своё CI-воркдерево: `~/ci/wt/al-front`, `~/ci/wt/al-back`, `~/ci/wt/al-relay` (Ф0, Б0, Р0).

### Правила (обязательны; нарушение — повод вернуть задачу)

- **Сборки и тесты — ТОЛЬКО на тест-ноде** `dv@85.192.61.231` (CLAUDE.md: «мак не тянет»). Работать в CI-клонах `~/ci/spirits_back` и `~/ci/spirits_front`, каждому треку — своё воркдерево: `git -C ~/ci/<repo> worktree add --detach ~/ci/wt/<имя> <sha>`. Ставить на sha, не на имя ветки. На маке не запускать jest, tsc, `pnpm build` и полный vitest. Допустим разве что точечный `./node_modules/.bin/vitest run <один файл>` для теста без DOM (окружение node), если в воркдереве есть `node_modules`. jsdom-тесты на маке врут: там Node 26 (заметка «Node 26 ломает jsdom»).
- На ноде не трогать `~/spirits_back`, `~/spirits_front` (живой test-стенд), `~/dev/*` (чужие сессии) и чужие каталоги в `~/ci/wt/`. **Каждая ssh-команда начинается с `source ~/.nvm/nvm.sh`**, иначе node не найдётся.
- **Код на ноду — только через git:** коммит → пуш ветки → `git checkout -q --detach <sha>` в своём CI-воркдереве. Не rsync, не scp. Коммиты не переписываются: без `--amend` запушенного и без force-push.
- **Пушить только ветку своего трека и только так:** `git -C $X push -q origin HEAD:refs/heads/<ветка>`. НИКОГДА `git push origin HEAD` из detached HEAD (заметка памяти: создаёт в GitHub ветку `HEAD` и ломает клоны). Никаких `main`, `b2b`. Пуш с мака рвётся (VPN) — повторить до трёх раз с паузой 10 с; не помогло — пуш через ноду (заметка «Пуш через ноду»).
- **Не делать checkout в чужих воркдеревьях** — ни на маке (`.worktrees/*` других сессий, общий чекаут), ни на ноде.
- **Бэк:** зависимости — `npm ci` (не pnpm). После КАЖДОЙ правки бэка — `npx tsc -p tsconfig.build.json --noEmit`: ts-jest типы не проверяет. Тесты — `npx jest --runInBand <пути>`. Jest бэка внутри `.worktrees/` тестов не видит (`testPathIgnorePatterns`), поэтому только на ноде в `~/ci/wt/…`. `strictNullChecks` выключен.
- **Живой Postgres** спекам этого плана не нужен (наши спеки базу не трогают). Если гоняете шире, например `src/products`, — своя одноразовая база: `createdb -h /var/run/postgresql al_test` и `PROVISIONING_PG_URL='postgres:///al_test?host=/var/run/postgresql'`. Без переменной такие спеки ПРОПУСКАЮТСЯ, а не падают.
- **Фронт:** `pnpm install --frozen-lockfile`, `npx vitest run <файлы>`. tsc — `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'`, считать дельтой к базе из Ф0: голый `tsc` не проверяет ничего, а база на main ненулевая (в заметках 42–45). `tsconfig.app.json` включает и тесты, и `noUnusedLocals`/`noUnusedParameters`: неиспользуемый `import React` или параметр в тесте — тоже ошибка. В конце — `pnpm build`.
- **Не писать `\u`-последовательности инструментами Write/Edit**: они молча раскодируются (заметка памяти). В коде плана их нет.
- **Репозитории публичные:** никаких настоящих телефонов, ключей и секретов в тестах и коммитах. Значения в тестах — заведомо фиктивные (`u1`, `t-1`, `example.org`).
- Комментарии — по-русски, в духе соседнего кода: ПОЧЕМУ, а не что. В текстах для людей — «ассистент», не «агент».
- **Коммиты:** последняя строка сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`, в шаблонах ниже — вторым `-m`. Автор — из конфига репозитория (Dmitry Volkov <dvvolkovv@gmail.com>), не переопределять.
- **Никаких выкатов:** ни `deploy.sh`, ни раннбука релея, ни `ota-publish.sh`. Выкат — после плана, с OK владельца (раздел «После плана»).
- Код плана не сходится с файлом (имя, строка, отступ) — не выдумывать: сверить по файлу, сделать по смыслу плана, описать расхождение в отчёте. Смысл неясен — `NEEDS_CONTEXT`.
- **Локали:** новых строк интерфейса план не вводит, `src/i18n/locales/*.json` не меняются. Если исполнитель всё же добавит строку — во все 7 локалей (`ru, en, es, de, fr, pt, zh`; pt — европейский, формальный; de — «du»; es — «tú»; fr — «vous»). Сторож pt без кириллицы — `src/i18n/ptLocale.test.ts`.
- **Вебвизор:** новые ссылки и якоря живут внутри уже скрытых контейнеров — `profile-content` в ProfileView и `support-messages-list` в SupportView (оба `ym-hide-content`). Новых строк в `src/components/webvisorPrivacy.test.ts` не нужно. Появится новый экран с личными данными — класс и строка в сторож.
- **`scripts/sync-kb-labels.mjs` не нужен:** новых ключей подписей нет, `src/platform-kb/label-keys.json` не меняется. Если подпись всё же понадобится — `node scripts/sync-kb-labels.mjs <свежий origin/main фронта>` и проверить дифф `labels.generated.ts` (CLAUDE.md бэка, «Справка о Linkeon для ассистентов»).

### Как гонять тесты (прочитать до первой задачи)

SSH к ноде рвётся на рукопожатии (MaxStartups) — повторить через 20–30 с. Если в сессии есть обёртка `nssh.sh` с мастер-соединением, ставить её вместо `ssh dv@85.192.61.231`.

**Фронт:**

```bash
F=/Users/dmitry/Downloads/spirits_front/.worktrees/assistant-links
git -C $F push -q origin HEAD:refs/heads/feat/assistant-links
SHA=$(git -C $F rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/al-front && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && npx vitest run <файлы> 2>&1 | tail -30"
```

tsc фронта: `ssh dv@85.192.61.231 "cd ~/ci/wt/al-front && source ~/.nvm/nvm.sh >/dev/null && npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'"` — число не выше базы Ф0.

**Бэк:**

```bash
B=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links
git -C $B push -q origin HEAD:refs/heads/feat/assistant-links
SHA=$(git -C $B rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/al-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && npx jest --runInBand <файлы> 2>&1 | grep -E '^(PASS|FAIL)|Tests:|●' | head -80"
```

tsc бэка: `ssh dv@85.192.61.231 "cd ~/ci/wt/al-back && source ~/.nvm/nvm.sh >/dev/null && npx tsc -p tsconfig.build.json --noEmit && echo tsc-ok"`.

**Релей** — как бэк, но воркдерево `$R`, ветка `feat/assistant-links-relay`, на ноде `~/ci/wt/al-relay`.

В шаблонах задач «Run (нода, фронт|бэк|релей): <файлы>» означает: коммит → пуш → соответствующая команда выше с этими файлами. На ноду едет закоммиченный HEAD. Поэтому шаг «убедиться, что тест падает» идёт после коммита теста (`test(...): … (красный)`), а реализация — следующим коммитом.

### Решения плана (отступления от спеки и выборы, где спека молчит)

1. **Адреса — и в постоянном блоке «Что есть в Linkeon», не только в справке.** У каждого раздела в `platformSections` стоит его полный адрес. Иначе каждое «где это?» и каждая подсказка (INITIATIVE_RULE) стоили бы лишнего вызова справки, а ИИ-поддержке и Telegram — тоже. Цена: +~1,7 КБ на промпт (расчёт по ru-подписям: перечень 3008 → ≈4180 байт, весь блок с правилом ссылок ≈4600 → ≈6300). Блок стабилен и кэшируется вместе со стабильной частью промпта. Пределов размера на блок нет; Маше (CLI, запрос одним аргументом) до потолка 128 КБ далеко.
2. **Таблица — 20 адресов** (общая таблица в Б1/Ф1): чат, нетворкинг (`/search`), генератор (`/image-gen`), видео, Студия и её вкладки bots/products, профиль, `?settings=1`, девять карточек `?open=` (calendars, zoom, talerid, logins, reminders, voices, notifications, telegram, partners), помощь, поддержка. Оплаты нет: ссылку на пополнение даёт блок баланса (`TOP_UP_URL`).
3. **Вход запоминает только адреса с параметром:** девять карточек `/profile?open=…`, `/profile?settings=1`, `/studio?tab=bots` и `/studio?tab=products[&action=uuid]`. Голые разделы (`/profile`, `/search`, `/studio`, `/chat` …) — «обычная страница». Экран входа стоит на любом адресе, и такая страница не должна перебивать запомненное намерение (`loginIntent.ts`, тест «обычная страница ничего не трогает»). После входа человек в чате, голый раздел — один клик в меню. `/studio?tab=bots` теперь переживает вход: прежний тест явно это запрещал и меняется в Ф2.
4. **Повтор параметра (`?tab=bots&tab=products`, `?open=a&open=b`) вход не запоминает** — неизвестно, какой из двух имелся в виду.
5. **`/settings?…` → `/profile?…&settings=1`** (раскрыть «Настройки», если в адресе нет своей карточки), **`/referral?…` → `/profile?…&open=partners`**. Остальные параметры сохраняются. Так `/settings?linked=1` после привязки входа теперь доходит до раскрытых настроек — `AuthOAuthCallbackPage` не трогаем.
6. **Своя ссылка в чате и в поддержке** — домен `my.linkeon.io` (боевой, его дают ассистенты и на тестовом стенде) или тот, на котором открыт кабинет (стенд, локальная сборка, Capacitor), и только маршруты кабинета. `/static`, `/smm-media`, `/webhook`, `/tma`, `/room` и корень открываются как раньше, в новой вкладке. Комната — тоже: пусть открывается рядом, не закрывая чат.
7. **Поддержка:** ссылками становятся все `http(s)://` во всех пузырях (и в своих — это безвредно). Свой кабинет открывается в той же вкладке, чужой сайт — `target=_blank rel="noopener noreferrer"`. Схемы `javascript:`, `data:` и прочие остаются текстом.
8. **Якоря** — обёртки `profile-card-<ключ>` (`profileCardAnchor`) в SettingsView и ProfileView, одним образцом для всех карточек. Прежний `id="calendar-sources"` у CalendarSourcesCard снимается: один якорь на карточку. На него ссылался только ProfileView.
9. **Статьи без строки «Ссылка»:** `products` — запас 9 байт до предела 5120 (ru/app, замер 27.10), ссылку на «Продукты» несёт постоянный блок; `tokens` и `payments` — оплата, это дело блока баланса; `how-it-works` — без раздела «Где». Остальные 17 статей ссылку получают.
10. **В статьях — одна ссылка на строку, без знаков после адреса.** GFM-автоссылка (react-markdown + remark-gfm) захватывает `;` вплотную после адреса — `…?open=zoom;` открыл бы незнакомую карточку.
11. **Правило ссылок двух видов** (`linksRule`): `markdown` — веб-чат, Маша, приложения (Flutter рисует `[текст](адрес)`); `plain` — Telegram (бот шлёт простой текст без parse_mode, «/profile» он примет за команду) и ИИ-поддержка (её ответы кабинет показывает простым текстом). В правиле нет фигурных скобок: `platform-guide.spec.ts` их запрещает.
12. **«Коллеги» — функцией от категории** (`colleaguesRule`): `personal` и `business` получают мягкую переадресацию, всё остальное (`assistant`, null, неизвестное) — прежнюю строку слово в слово. Пример в правиле — без имени живого коллеги («<коллеге>»): с «Екатериной» из спеки модель предлагала бы её всем подряд. Маша (personal) получает то же правило.
13. **«ПРОВЕРКА ФАКТОВ» — отдельным абзацем до RULES**, без перенумерации: правило 10 сторожит `relay-help-guard.spec.ts` по номеру. Правило 7 не трогается, правило 9 прямо говорит, что 7 — про создаваемые файлы. Ссылки, которые выдаёт инструмент (`mcp__products__find_files`), и картинки `mcp__linkeon__*` правило 9 по-прежнему разрешает — без этого оно спорило бы с `PRODUCTS_PROMPT`.
14. **Релей — отдельной веткой `feat/assistant-links-relay`, в `main` не сливается до выката фронта и бэка и до конца очереди сессии «секрет релея»** (enforce, затем часть Б). Код той сессии уже в `main`, ей осталось только катить. Окажись наши правила в `main` раньше, их унёс бы её выкат релея — до того, как кабинет научится открывать ссылки (порядок спеки «Выкат»). Правка — только текст `SYSTEM_PROMPT` и новая спека, переносится поверх чего угодно.
15. **Попутно (Б8):** возврат от Zoom ведёт на `/profile?open=zoom&zoom_connect=<исход>`. Сейчас он ведёт на `/?zoom_connect=…`, а `RootRedirect` уводит в чат и теряет пометку: человек не видит ни «подключено», ни «отказались». Независимая задача, её можно выкинуть без вреда остальному.
16. **Telegram-боты и Маша «ПРОВЕРКУ ФАКТОВ» не получают** — спека меняет только релей. У Маши нет веб-инструментов (`--tools ""`). У Telegram-бота WebSearch/WebFetch есть — это открытый вопрос владельцу, в план не входит.
17. **Переходный период** (бэк выкачен, релей ещё нет): ассистенты на релее видят в блоке «дай ссылку», а в правиле 9 релея — «NEVER print URLs». Ссылки у них могут не появляться до выката релея, так и задумано. Маша, Telegram и поддержка дают ссылки сразу.

### Чего план сознательно НЕ делает

- Ничего не катит: ни фронт, ни бэк, ни релей.
- Не трогает Flutter (`~/Downloads/linkeon_mobile`, репозиторий коллеги): там https и так открывается во внешнем браузере, а с белым списком входа ссылка переживает вход и там.
- Не заводит раздел «Интеграции» в кабинете (спека, «Вне рамок»).
- Не меняет в `relay-agent/server.mjs` ничего, кроме правил 4 и 9, абзаца «ПРОВЕРКА ФАКТОВ» и комментария над `SYSTEM_PROMPT`.
- Не трогает статью `products` и `PRODUCTS_PROMPT`.

---

## Структура файлов

**Фронт (`spirits_front`), трек 1:**

| Файл | Что | Задача |
|---|---|---|
| `src/utils/cabinetSections.ts` (новый) | карточки профиля и якоря, что раскрыть, перечень адресов, канонический адрес для входа, старые `/settings` и `/referral`, своя ссылка | Ф1 |
| `src/utils/cabinetSections.test.ts` (новый) | общая таблица адресов (копия бэка), поведение модуля | Ф1 |
| `src/utils/pendingDestination.ts` (+ `.test.ts`) | белый список входа — через `deepSectionLink` | Ф2 |
| `src/utils/loginIntent.test.ts`, `src/pages/OnboardingPage.intent.test.tsx` | ссылка на карточку — тоже намерение | Ф2 |
| `src/components/profile/ProfileView.tsx` | `profileTarget` из роутера, якоря Telegram и «Партнёров» | Ф3 |
| `src/components/settings/SettingsView.tsx` | якоря-обёртки карточек настроек | Ф3 |
| `src/components/settings/CalendarSourcesCard.tsx` | снять прежний `id="calendar-sources"` | Ф3 |
| `src/components/profile/ProfileView.deeplink.test.tsx` (новый) | раскрытие и прокрутка по экрану | Ф3 |
| `src/components/LegacyProfileRedirect.tsx` (+ `.test.tsx`, новые), `src/App.tsx` | `/settings`, `/referral` с параметрами | Ф4 |
| `src/components/chat/ChatInterface.tsx`, `src/components/chat/cabinetLinksWiring.test.ts` (новый) | своя ссылка — в той же вкладке; `action: settings` → `/profile?settings=1` | Ф5 |
| `src/utils/linkify.ts` (+ `.test.ts`, новые) | текст → куски «текст/ссылка», только http(s) | Ф6 |
| `src/components/support/SupportView.tsx`, `src/components/support/SupportView.links.test.tsx` (новый) | ссылки в поддержке | Ф6 |
| `CLAUDE.md` | одна фраза о двух таблицах | С2 |

**Бэк (`spirits_back`), трек 2:**

| Файл | Что | Задача |
|---|---|---|
| `src/platform-kb/section-links.ts` (новый) | таблица абсолютных адресов, `sectionUrl`, `PAID_SECTIONS` | Б1 |
| `src/platform-kb/section-links.spec.ts` (новый) | общая таблица (копия фронта), ссылки в статьях, «интеграции» в описаниях | Б1, Б3, Б4 |
| `src/platform-kb/kb.types.ts`, `render.ts`, `render.spec.ts`, `kb.spec.ts` | `url()` в контексте сборки; сторож исходников знает `${url('…')}` | Б2 |
| `src/platform-kb/articles/*.ts` (17 файлов) | строка «Ссылка…» в разделе «Где» | Б3 |
| `articles/calendars.ts`, `meetings.ts`, `account.ts`; `linkeon-help.ts` (+ `.spec.ts`) | синонимы «интеграции/подключения»; описание инструмента о «Ссылке» | Б4 |
| `src/chat/platform-guide.ts` (+ `.spec.ts`) | адреса в перечне, абзац про интеграции, `linksRule`, INITIATIVE_RULE, Telegram | Б5 |
| `src/support/support.service.ts`, `src/support/support-platform.spec.ts` | поддержке — правило ссылок `plain` | Б6 |
| `src/chat/colleagues-rule.ts` (+ `.spec.ts`, новые), `src/chat/chat.service.ts`, `src/chat/chat.service.masha-prompt.spec.ts` | «Коллеги» по категории | Б7 |
| `src/zoom/zoom.controller.ts`, `src/zoom/zoom.controller.spec.ts` (новый) | возврат от Zoom — на карточку | Б8 |
| `docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md`, `CLAUDE.md` | решения плана; правило сопровождения таблиц | С2 |

**Релей (`spirits_back`, ветка `feat/assistant-links-relay`), трек 3:**

| Файл | Что | Задача |
|---|---|---|
| `relay-agent/server.mjs` | правило 4 (картинки), правило 9 (ссылки и файлы), абзац «ПРОВЕРКА ФАКТОВ» | Р1 |
| `src/chat/relay-rules-guard.spec.ts` (новый) | сторож текста этих правил | Р1 |

## Порядок и параллельность

```
Трек 1 (фронт):  Ф0 → Ф1 → Ф2 → Ф3 → Ф4 → Ф5 → Ф6 → Ф7
Трек 2 (бэк):    Б0 → Б1 → Б2 → Б3 → Б4 → Б5 → Б6 ─┐
                 Б0 → Б7 (независима от Б1–Б6)      ├→ Б9
                 Б0 → Б8 (независима, попутная)    ─┘
Трек 3 (релей):  Р0 → Р1 → Р2
Финал:           С1 (после Ф7 и Б9) → С2
```

- **Треки 1, 2 и 3 идут параллельно:** разные репозитории или ветки, свои воркдеревья на маке и на ноде, общих файлов нет. Связь одна, содержательная: таблица адресов в Ф1 и Б1 — дословно одна и та же, её текст дан в обеих задачах, сверка — С1.
- Внутри трека задачи последовательны: воркдерево одно. Ф2–Ф6 опираются на модуль из Ф1, Б3–Б6 — на таблицу из Б1 и `url()` из Б2. Б7 и Б8 можно делать в любом месте трека после Б0.
- Трек 3 ни от чего не зависит, но в `main` сливается последним, после выката фронта и бэка (решение 14).

---

## Трек 1. Фронт (`spirits_front`)

### Задача Ф0: Подготовка — воркдерево фронта, CI-клон, базовая линия

**Files:** в репозитории ничего не меняется.

- [ ] **Step 1: Воркдерево фронта от `origin/main`**

```bash
git -C /Users/dmitry/Downloads/spirits_front fetch -q origin
git -C /Users/dmitry/Downloads/spirits_front worktree add -q -b feat/assistant-links /Users/dmitry/Downloads/spirits_front/.worktrees/assistant-links origin/main
F=/Users/dmitry/Downloads/spirits_front/.worktrees/assistant-links
git -C $F branch --show-current && git -C $F log --oneline -1
git -C $F push -q -u origin HEAD:refs/heads/feat/assistant-links
```

Expected: `feat/assistant-links` и `c4b0d2a Merge feat/prompt-secrets…` (или новее — тогда записать sha в отчёт).

- [ ] **Step 2: CI-воркдерево на ноде**

```bash
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/al-front origin/feat/assistant-links && cd ~/ci/wt/al-front && source ~/.nvm/nvm.sh >/dev/null && pnpm install --frozen-lockfile >/dev/null && echo front-ok'
```

Expected: `front-ok`.

- [ ] **Step 3: Базовая линия — записать в отчёт, дальше мерить дельтой**

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/al-front && source ~/.nvm/nvm.sh >/dev/null && npx vitest run 2>&1 | tail -6; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'; node scripts/check-no-hardcoded.mjs >/dev/null 2>&1 && echo hardcoded-ok || echo hardcoded-red"
```

Expected: строки `Test Files …` / `Tests …` (записать числа passed/failed), число `error TS` (ориентир 42–45), `hardcoded-ok` или `hardcoded-red` (записать).

---

### Задача Ф1: Адреса кабинета одним модулем

**Files:**
- Create: `src/utils/cabinetSections.ts`
- Test: `src/utils/cabinetSections.test.ts`

- [ ] **Step 1: Тест**

`src/utils/cabinetSections.test.ts` (окружение node: DOM не нужен):

```ts
import { describe, expect, it } from 'vitest';
import {
  PROFILE_CARDS,
  SECTION_LINKS,
  cabinetPath,
  deepSectionLink,
  legacyProfilePath,
  profileCardAnchor,
  profileTarget,
  type ProfileCard,
  type ProfileTarget,
} from './cabinetSections';

/**
 * Адреса разделов, которые дают ассистенты, и что по ним делает кабинет.
 *
 * ОБЩАЯ ТАБЛИЦА — дословно та же стоит в spirits_back
 * src/platform-kb/section-links.spec.ts: оттуда адреса берут справка и блок
 * «Что есть в Linkeon» в промпте ассистентов. Меняется в обоих репозиториях
 * одним изменением. Сверка — пустой вывод diff блоков между строками-метками
 * «<<<» и «>>>» с «АДРЕСА РАЗДЕЛОВ» (команда — задача С1 плана
 * 2026-10-27-assistant-links-sources-roles).
 */
// <<< АДРЕСА РАЗДЕЛОВ — общая таблица бэка и фронта, менять в обоих репозиториях
const SECTION_TABLE = [
  '/chat',
  '/help',
  '/image-gen',
  '/profile',
  '/profile?open=calendars',
  '/profile?open=logins',
  '/profile?open=notifications',
  '/profile?open=partners',
  '/profile?open=reminders',
  '/profile?open=talerid',
  '/profile?open=telegram',
  '/profile?open=voices',
  '/profile?open=zoom',
  '/profile?settings=1',
  '/search',
  '/studio',
  '/studio?tab=bots',
  '/studio?tab=products',
  '/support',
  '/video',
];
// >>> АДРЕСА РАЗДЕЛОВ

describe('таблица адресов разделов', () => {
  it('кабинет открывает ровно общую таблицу', () => {
    expect([...SECTION_LINKS].sort()).toEqual(SECTION_TABLE);
  });

  it('каждый адрес таблицы — путь кабинета: ссылка на него открывается в той же вкладке', () => {
    for (const link of SECTION_TABLE) {
      expect(cabinetPath(`https://my.linkeon.io${link}`, 'my.linkeon.io'), link).toBe(link);
    }
  });

  it('у каждой карточки из таблицы есть якорь', () => {
    for (const link of SECTION_TABLE.filter((l) => l.startsWith('/profile?open='))) {
      expect(profileTarget(link.slice('/profile'.length)).anchor, link).not.toBeNull();
    }
  });

  it('адрес с параметром — в каноническом виде: его запоминает вход', () => {
    for (const link of SECTION_TABLE.filter((l) => l.includes('?'))) {
      const [path, query] = link.split('?');
      expect(deepSectionLink(path, `?${query}`), link).toBe(link);
    }
  });

  it('голый раздел — не намерение: вход его не запоминает', () => {
    for (const link of SECTION_TABLE.filter((l) => !l.includes('?'))) {
      expect(deepSectionLink(link, ''), link).toBeNull();
    }
  });
});

describe('profileTarget — что сделать «Моему профилю»', () => {
  const CARDS: [ProfileCard, ProfileTarget['expand']][] = [
    ['calendars', 'settings'],
    ['zoom', 'settings'],
    ['talerid', 'settings'],
    ['logins', 'settings'],
    ['reminders', 'settings'],
    ['voices', 'settings'],
    ['notifications', 'settings'],
    ['partners', 'referral'],
    ['telegram', null],
  ];

  it.each(CARDS)('?open=%s — блок %s и якорь своей карточки', (card, expand) => {
    expect(profileTarget(`?open=${card}`)).toEqual({ expand, anchor: profileCardAnchor(card) });
  });

  it('перечень карточек — ровно эти девять', () => {
    expect([...PROFILE_CARDS].sort()).toEqual(CARDS.map(([c]) => c).sort());
  });

  it('?settings=1 — раскрыть «Настройки» без прокрутки (так шлёт виджет лаунчера)', () => {
    expect(profileTarget('?settings=1')).toEqual({ expand: 'settings', anchor: null });
  });

  it('незнакомая карточка и пустой адрес — ничего не раскрывать', () => {
    expect(profileTarget('?open=integrations')).toEqual({ expand: null, anchor: null });
    expect(profileTarget('')).toEqual({ expand: null, anchor: null });
  });

  it('карточка важнее ?settings: прокрутка нужна к ней', () => {
    expect(profileTarget('?settings=1&open=zoom')).toEqual({ expand: 'settings', anchor: profileCardAnchor('zoom') });
  });

  it('якоря у карточек разные', () => {
    expect(new Set(PROFILE_CARDS.map(profileCardAnchor)).size).toBe(PROFILE_CARDS.length);
  });
});

describe('deepSectionLink — канонический адрес для входа', () => {
  it('лишние параметры отбрасываются', () => {
    expect(deepSectionLink('/profile', '?open=zoom&zoom_connect=ok&utm_source=kb')).toBe('/profile?open=zoom');
    expect(deepSectionLink('/studio', '?tab=bots&utm=1')).toBe('/studio?tab=bots');
    expect(deepSectionLink('/profile', '?settings=yes')).toBe('/profile?settings=1');
  });

  it('повтор параметра — не угадываем', () => {
    expect(deepSectionLink('/studio', '?tab=bots&tab=products')).toBeNull();
    expect(deepSectionLink('/profile', '?open=zoom&open=talerid')).toBeNull();
  });

  it('чужие разделы и вкладки — null', () => {
    expect(deepSectionLink('/studio', '?tab=agents')).toBeNull();
    expect(deepSectionLink('/admin', '?tab=products')).toBeNull();
    expect(deepSectionLink('/settings', '?open=zoom')).toBeNull();
    expect(deepSectionLink('//evil.example/profile', '?open=zoom')).toBeNull();
  });
});

describe('legacyProfilePath — старые /settings и /referral', () => {
  const CASES: ['settings' | 'referral', string, string][] = [
    ['settings', '', '/profile?settings=1'],
    ['settings', '?open=zoom', '/profile?open=zoom'],
    ['settings', '?linked=1', '/profile?linked=1&settings=1'],
    ['settings', '?settings=1', '/profile?settings=1'],
    ['referral', '', '/profile?open=partners'],
    ['referral', '?ref=abc', '/profile?ref=abc&open=partners'],
  ];

  it.each(CASES)('/%s%s → %s', (from, search, to) => {
    expect(legacyProfilePath(from, search)).toBe(to);
  });
});

describe('cabinetPath — своя ссылка открывается в кабинете', () => {
  const HERE = 'my.linkeon.io';

  it.each([
    ['https://my.linkeon.io/profile?open=zoom', '/profile?open=zoom'],
    ['http://my.linkeon.io/studio?tab=bots', '/studio?tab=bots'],
    ['https://MY.LINKEON.IO/help', '/help'],
    ['https://my.linkeon.io/chat?view=tokens#top', '/chat?view=tokens#top'],
    ['https://my.linkeon.io/settings?open=zoom', '/settings?open=zoom'],
  ])('%s → %s', (href, path) => {
    expect(cabinetPath(href, HERE)).toBe(path);
  });

  it('свой стенд — тоже свой: тестовый сервер, локальная сборка', () => {
    expect(cabinetPath('https://test.linkeon.io/profile?open=zoom', 'test.linkeon.io')).toBe('/profile?open=zoom');
    expect(cabinetPath('http://localhost:5173/support', 'localhost:5173')).toBe('/support');
    expect(cabinetPath('https://test.linkeon.io/profile', HERE)).toBeNull();
  });

  it.each([
    'https://my.linkeon.io/',
    'https://my.linkeon.io/static/generated/a.png',
    'https://my.linkeon.io/smm-media/linkeon-assets/app/linkeon-android.apk',
    'https://my.linkeon.io/webhook/mcp/linkeon',
    'https://my.linkeon.io/tma/',
    'https://my.linkeon.io/room/ABC234',
    'https://my.linkeon.io.evil.example/profile',
    'https://my.linkeon.io@evil.example/profile',
    'https://evil.example/?next=https://my.linkeon.io/profile',
    'javascript:alert(1)',
    '/profile?open=zoom',
    'не адрес',
  ])('%s — не раздел кабинета', (href) => {
    expect(cabinetPath(href, HERE)).toBeNull();
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $F add src/utils/cabinetSections.test.ts && git -C $F commit -q -m "test(cabinet): адреса разделов одним модулем — карточки, вход, свой домен (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/utils/cabinetSections.test.ts`. Expected: FAIL — `Failed to resolve import "./cabinetSections"`.

- [ ] **Step 3: Модуль**

`src/utils/cabinetSections.ts`:

```ts
/**
 * Адреса кабинета, которые дают ассистенты, — что по ним открывается и что из
 * них переживает вход.
 *
 * Находка «Затыков недели» 19–25.10.2026 (e4f01175): ассистент объяснил
 * словами, где раздел («в интеграциях»), и человек его не нашёл. Раздела
 * «Интеграции» в кабинете нет, подключения разбросаны по карточкам
 * «Настроек». Теперь справка и блок о платформе дают ссылку
 * https://my.linkeon.io/…, а кабинет по ней раскрывает нужный блок и
 * прокручивает к карточке.
 *
 * ДВЕ КОПИИ ОДНОЙ ТАБЛИЦЫ: эта и spirits_back src/platform-kb/section-links.ts
 * (оттуда адреса берут справка и блок «Что есть в Linkeon»). Разъедутся —
 * ассистент даст ссылку, по которой кабинет откроет не ту карточку или после
 * входа уведёт в чат. Сторож — общая таблица между метками «АДРЕСА РАЗДЕЛОВ»
 * в cabinetSections.test.ts и в section-links.spec.ts бэка, дословно одна и
 * та же; меняется в обоих репозиториях одним изменением.
 */

/** Карточки «Моего профиля», к которым кабинет прокручивает по /profile?open=<ключ>. */
export const PROFILE_CARDS = [
  'calendars',
  'zoom',
  'talerid',
  'logins',
  'reminders',
  'voices',
  'notifications',
  'telegram',
  'partners',
] as const;
export type ProfileCard = (typeof PROFILE_CARDS)[number];

/** Карточки внутри свёрнутых «Настроек»: чтобы показать такую, блок раскрывается. */
const SETTINGS_CARDS: readonly ProfileCard[] = [
  'calendars',
  'zoom',
  'talerid',
  'logins',
  'reminders',
  'voices',
  'notifications',
];

export function isProfileCard(v: string | null | undefined): v is ProfileCard {
  return typeof v === 'string' && (PROFILE_CARDS as readonly string[]).includes(v);
}

/** id элемента, к которому прокручивает /profile?open=<card>. */
export function profileCardAnchor(card: ProfileCard): string {
  return `profile-card-${card}`;
}

export interface ProfileTarget {
  /** Какой свёрнутый блок профиля раскрыть. */
  expand: 'settings' | 'referral' | null;
  /** id элемента, к которому прокрутить; null — не прокручивать. */
  anchor: string | null;
}

/**
 * Что сделать «Моему профилю» по параметрам адреса. ?open= с незнакомым
 * значением — как без него: старая или битая ссылка открывает профиль, а не
 * ломает его. ?settings= с любым значением раскрывает «Настройки», как и
 * раньше: так шлёт виджет лаунчера.
 */
export function profileTarget(search: string): ProfileTarget {
  const q = new URLSearchParams(search);
  const card = q.get('open');
  if (isProfileCard(card)) {
    const expand = SETTINGS_CARDS.includes(card) ? 'settings' : card === 'partners' ? 'referral' : null;
    return { expand, anchor: profileCardAnchor(card) };
  }
  return { expand: q.has('settings') ? 'settings' : null, anchor: null };
}

/**
 * Все адреса разделов, которые дают ассистенты. Относительные: домен
 * (https://my.linkeon.io) бэк подставляет сам. Сверяются с общей таблицей.
 */
export const SECTION_LINKS: readonly string[] = [
  '/chat',
  '/search',
  '/image-gen',
  '/video',
  '/studio',
  '/studio?tab=bots',
  '/studio?tab=products',
  '/profile',
  '/profile?settings=1',
  ...PROFILE_CARDS.map((card) => `/profile?open=${card}`),
  '/help',
  '/support',
];

/**
 * Канонический вид адреса раздела С ПАРАМЕТРОМ — его запоминает вход
 * (pendingDestination.ts) — или null. Голые разделы (/profile, /studio,
 * /chat …) здесь null намеренно: экран входа стоит на любом адресе, и
 * «обычная страница» не должна перебивать запомненное намерение
 * (loginIntent.ts, тест «обычная страница ничего не трогает»). Повтор
 * параметра (?tab=bots&tab=products) — тоже null: какой из двух имелся в
 * виду, не угадать.
 */
export function deepSectionLink(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  if (q.getAll('tab').length > 1 || q.getAll('open').length > 1) return null;
  let link: string | null = null;
  if (pathname === '/studio') {
    const tab = q.get('tab');
    if (tab === 'bots' || tab === 'products') link = `/studio?tab=${tab}`;
  } else if (pathname === '/profile') {
    const card = q.get('open');
    if (isProfileCard(card)) link = `/profile?open=${card}`;
    else if (q.has('settings')) link = '/profile?settings=1';
  }
  return link !== null && SECTION_LINKS.includes(link) ? link : null;
}

/**
 * Куда ведут старые адреса /settings и /referral: в «Мой профиль» — с
 * параметрами. Прежний <Navigate to="/profile"> терял всё после «?»: и
 * /settings?open=zoom, и возврат после привязки входа (/settings?linked=1)
 * открывали профиль со свёрнутыми настройками. /settings без своей карточки
 * раскрывает «Настройки», /referral — блок «Партнёры».
 */
export function legacyProfilePath(from: 'settings' | 'referral', search: string): string {
  const q = new URLSearchParams(search);
  if (!q.has('open')) {
    if (from === 'referral') q.set('open', 'partners');
    else if (!q.has('settings')) q.set('settings', '1');
  }
  const qs = q.toString();
  return qs ? `/profile?${qs}` : '/profile';
}

/** Боевой домен кабинета: его адреса дают ассистенты — и на тестовом стенде тоже. */
const CABINET_HOST = 'my.linkeon.io';

/**
 * Первые части пути, которые рисует сам кабинет (маршруты App.tsx). Остальное
 * на том же домене — файлы (/static, /smm-media, /files), API (/webhook),
 * мини-приложение (/tma) и голосовая комната (/room: пусть открывается рядом,
 * не закрывая чат) — открывается как раньше, полной загрузкой в новой вкладке.
 */
const CABINET_ROUTES = new Set([
  'chat',
  'chats',
  'profile',
  'studio',
  'products',
  'telegram-bots',
  'search',
  'image-gen',
  'video',
  'help',
  'support',
  'contact-requests',
  'settings',
  'referral',
  'tokens',
]);

function currentHost(): string {
  return typeof window === 'undefined' ? '' : window.location.host;
}

/**
 * Путь внутри кабинета для ссылки на свой домен — или null.
 *
 * Ссылку https://my.linkeon.io/profile?open=zoom из ответа ассистента кабинет
 * открывает в той же вкладке, переходом роутера, как относительную. Новая
 * вкладка загружала бы кабинет заново, а в приложении (Capacitor) открылся бы
 * внешний браузер без входа. Свой домен — боевой и тот, на котором открыт
 * кабинет (тестовый стенд, локальная сборка). Чужой хост, другой протокол или
 * путь не из CABINET_ROUTES — null, и ссылка ведёт себя как прежде.
 */
export function cabinetPath(href: string, here: string = currentHost()): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (host !== CABINET_HOST && host !== here.toLowerCase()) return null;
  if (!CABINET_ROUTES.has(u.pathname.split('/')[1] ?? '')) return null;
  return `${u.pathname}${u.search}${u.hash}`;
}
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $F add src/utils/cabinetSections.ts && git -C $F commit -q -m "cabinet: адреса разделов одним модулем — карточки профиля, вход, старые адреса, свой домен" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/utils/cabinetSections.test.ts`. Expected: PASS. tsc фронта — не выше базы Ф0.

---

### Задача Ф2: Вход помнит адреса разделов с параметром

**Files:**
- Modify: `src/utils/pendingDestination.ts:1-38` (шапка, `ALLOWED`, `allowedDestination`)
- Modify: `src/utils/pendingDestination.test.ts:1-8` (импорт), `:28-42` (тест «адреса не из списка»), конец файла (новые тесты)
- Modify: `src/utils/loginIntent.test.ts` (новый тест), `src/pages/OnboardingPage.intent.test.tsx` (новый тест)

- [ ] **Step 1: Тесты**

`src/utils/pendingDestination.test.ts`:

1) В импорт добавить модуль адресов — после блока `import { … } from './pendingDestination';`:

```ts
import { SECTION_LINKS } from './cabinetSections';
```

2) В тесте «адреса не из списка не запоминаются» заменить массив `others` целиком. `/studio?tab=bots` из него уходит: вкладка ботов теперь в списке (решение плана 3).

```ts
    const others: [string, string][] = [
      ['/studio', ''],
      ['/admin', '?tab=products'],
      ['//evil.example/studio', '?tab=products'],
      ['/chat', ''],
      ['/studio', '?tab=productsx'],
      ['/studio', '?tab=bots&tab=products'],
      ['/studio', '?tab=agents'],
      ['/profile', ''],
      ['/profile', '?open=integrations'],
      ['/profile', '?open=zoom&open=talerid'],
      ['/search', ''],
      ['/settings', '?open=zoom'],
    ];
```

3) В конец `describe('раздел, куда человек шёл до входа', …)`, перед его закрывающей `});`, добавить:

```ts
  it('вкладка Telegram-ботов тоже переживает вход', () => {
    expect(rememberPendingDestination('/studio', '?tab=bots&utm_source=kb', NOW)).toBe(true);
    expect(takePendingDestination(NOW)).toBe('/studio?tab=bots');
  });

  it('ссылка ассистента на карточку профиля переживает вход, лишнее отбрасывается', () => {
    expect(rememberPendingDestination('/profile', '?open=zoom&zoom_connect=ok', NOW)).toBe(true);
    expect(takePendingDestination(NOW)).toBe('/profile?open=zoom');
    expect(allowedDestination('/profile', '?settings=1')).toBe('/profile?settings=1');
  });

  // Тот же перечень, что дают ассистенты (cabinetSections.ts, общая таблица с бэком).
  it('каждый адрес раздела с параметром запоминается как есть, голый — нет', () => {
    for (const link of SECTION_LINKS) {
      const [path, query = ''] = link.split('?');
      expect(allowedDestination(path, query ? `?${query}` : ''), link).toBe(query ? link : null);
    }
  });
```

`src/utils/loginIntent.test.ts` — в конец `describe('намерение до входа: побеждает последнее', …)`:

```ts
  it('ссылка на карточку профиля после страницы ассистента — побеждает карточка', () => {
    rememberLoginIntent('/chat', '?assistant=14', NOW);
    rememberLoginIntent('/profile', '?open=zoom', NOW + 1000);
    expect(takePendingDestination(NOW + 2000)).toBe('/profile?open=zoom');
    expect(peekPendingAssistant(NOW + 2000)).toBeNull();
  });
```

`src/pages/OnboardingPage.intent.test.tsx` — в конец `describe('экран входа запоминает намерение', …)`:

```ts
  it('ссылка ассистента на карточку профиля — раздел', async () => {
    await open('/profile?open=zoom&utm_source=kb');
    expect(JSON.parse(localStorage.getItem('pending_destination') ?? 'null')?.value).toBe('/profile?open=zoom');
  });
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $F add src/utils/pendingDestination.test.ts src/utils/loginIntent.test.ts src/pages/OnboardingPage.intent.test.tsx && git -C $F commit -q -m "test(cabinet): вход помнит карточки профиля и вкладку ботов (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/utils/pendingDestination.test.ts src/utils/loginIntent.test.ts src/pages/OnboardingPage.intent.test.tsx`. Expected: FAIL — «вкладка Telegram-ботов…», «ссылка ассистента на карточку…», «каждый адрес раздела…», новый тест loginIntent и новый тест экрана входа; остальные PASS.

- [ ] **Step 3: Белый список через модуль адресов**

В `src/utils/pendingDestination.ts` заменить всё от начала файла до конца функции `allowedDestination` (строки 1–38: шапка, импорт, `KEY`, `TTL_MS`, `ALLOWED`, `Stored`, `allowedDestination`) на:

```ts
/**
 * Раздел кабинета, в который человек шёл до входа.
 *
 * Кнопка «Сделать сайт или бота» на linkeon.io ведёт на /studio?tab=products,
 * ассистенты дают ссылки на разделы (/profile?open=zoom и другие из
 * cabinetSections.ts). Новый человек сначала видит экран входа, а все пути
 * входа кончаются голым /chat: SMS и OAuth — navigate('/chat'), экран
 * привязки — window.location.replace('/chat'), ссылка из письма — страница
 * бэкенда с location.replace('/chat'). Поэтому адрес запоминается здесь до
 * входа, а после входа его забирает PendingDestinationRedirect, стоящий на /chat.
 *
 * Только канонические адреса разделов С ПАРАМЕТРОМ (deepSectionLink).
 * Произвольный адрес из ссылки сделал бы кабинет открытым редиректом, а голый
 * раздел — «обычная страница», которая не должна перебивать запомненное
 * намерение (loginIntent.ts). Хранилище и срок — как у pendingAssistant:
 * localStorage (ссылку из письма часто открывают в новой вкладке), час.
 */
import { deepSectionLink } from './cabinetSections';
import { isUuid } from './uuid';

const KEY = 'pending_destination';
const TTL_MS = 60 * 60 * 1000;

interface Stored {
  value: string;
  expires: number;
}

/** Канонический адрес из белого списка или null. Лишние параметры отбрасываются. */
export function allowedDestination(pathname: string, search: string): string | null {
  const link = deepSectionLink(pathname, search);
  if (!link) return null;
  // Карточка действия продукта: ссылка из клиента без карточек ведёт сюда, и
  // вход не должен её терять. Только uuid — остальное по-прежнему отбрасывается.
  const action = new URLSearchParams(search).get('action');
  return link === '/studio?tab=products' && isUuid(action) ? `${link}&action=${action}` : link;
}
```

Остальной файл (`forgetPendingDestination`, `read`, `rememberPendingDestination`, `takePendingDestination`) не меняется.

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $F add src/utils/pendingDestination.ts && git -C $F commit -q -m "cabinet: вход помнит адреса разделов с параметром — карточки профиля, настройки, вкладку ботов" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/utils/pendingDestination.test.ts src/utils/loginIntent.test.ts src/pages/OnboardingPage.intent.test.tsx src/components/PendingDestinationRedirect.test.tsx src/components/onboarding/SmsLoginPane.destination.test.tsx src/utils/cabinetSections.test.ts`. Expected: PASS. tsc — не выше базы.

---

### Задача Ф3: «Мой профиль» раскрывает блок и прокручивает к карточке

**Files:**
- Modify: `src/components/profile/ProfileView.tsx:3` (импорт роутера), `:15` (импорт модуля), `:56-74` (раскрытие и прокрутка), `~:512-513` (карточка Telegram), `~:646-647` (блок «Партнёры»)
- Modify: `src/components/settings/SettingsView.tsx:25` (импорт), `:146-147` (уведомления), `:182-194` (карточки), `:235-236` (способы входа)
- Modify: `src/components/settings/CalendarSourcesCard.tsx:145-146` (снять прежний `id`)
- Test: `src/components/profile/ProfileView.deeplink.test.tsx` (новый)

- [ ] **Step 1: Тест**

`src/components/profile/ProfileView.deeplink.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Ссылка ассистента на карточку профиля (/profile?open=<карточка>) обязана
// раскрыть нужный блок и прокрутить к ЭТОЙ карточке. Проверяем по экрану:
// раскрыт ли блок (видна ли заглушка карточки) и к какому элементу ушла
// прокрутка. Карточки настроек заглушены — они тянут свои ручки и к проверке
// отношения не имеют; SettingsView настоящий: якоря живут в нём.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { actAsync, flush, mount, tRu, visibleText, type Mounted } from '../../test/dom';
import { PROFILE_CARDS, profileCardAnchor, type ProfileCard } from '../../utils/cabinetSections';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    // Без телефона: профиль и аватар с сервера не грузятся — здесь они ни к чему.
    user: { firstName: 'Тест' },
    updateUserInfo: () => {},
    updateAvatar: () => {},
    logout: () => {},
    deleteProfile: async () => {},
  }),
}));
vi.mock('../../services/apiClient', () => ({
  apiClient: {
    get: async () => ({ ok: false, json: async () => ({}) }),
    post: async () => ({ ok: false, json: async () => ({}) }),
    request: async () => ({ ok: false }),
  },
}));
vi.mock('../../services/tgBotApi', () => ({ tgBotApi: { identityStatus: async () => ({ bound: false }) } }));
vi.mock('../../services/pushClient', () => ({
  pushSupported: () => false,
  isPushSubscribed: async () => false,
  enablePush: async () => false,
  disablePush: async () => true,
  sendTestPush: async () => false,
}));
vi.mock('./ReferralDashboard', () => ({ default: () => 'ПАНЕЛЬ-ПАРТНЁРОВ' }));
vi.mock('./ProfileTasks', () => ({ default: () => null }));
vi.mock('./BusinessCard', () => ({ default: () => null }));
vi.mock('./InviteFriendBlock', () => ({ default: () => null }));
vi.mock('../settings/LanguageSelect', () => ({ LanguageSelect: () => null }));
vi.mock('../settings/RoutinesManager', () => ({ default: () => 'КАРТОЧКА-НАПОМИНАНИЙ' }));
vi.mock('../settings/TalerIdEcosystemCard', () => ({ default: () => 'КАРТОЧКА-TALERID' }));
vi.mock('../settings/ZoomConnectCard', () => ({ default: () => 'КАРТОЧКА-ZOOM' }));
vi.mock('../settings/CalendarSourcesCard', () => ({ default: () => 'КАРТОЧКА-КАЛЕНДАРЕЙ' }));
vi.mock('../settings/VoiceSettings', () => ({ default: () => 'КАРТОЧКА-ГОЛОСОВ' }));
vi.mock('../settings/LinkedAccountsView', () => ({ default: () => 'КАРТОЧКА-ВХОДА' }));

import ProfileView from './ProfileView';

let view: Mounted | null = null;
const scrolledTo: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  scrolledTo.length = 0;
  // jsdom не прокручивает: записываем, к какому элементу ушла прокрутка.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.id);
  };
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

async function open(url: string): Promise<string> {
  view = mount(
    <MemoryRouter initialEntries={[url]}>
      <ProfileView />
    </MemoryRouter>,
  );
  await flush();
  await flush();
  // Прокрутка — через 350 мс после монтирования: раскрытый блок успевает нарисоваться.
  await actAsync(() => {
    vi.advanceTimersByTime(400);
  });
  return visibleText(view.container);
}

/** Что лежит внутри якоря — по нему видно, что якорь обнимает свою карточку. */
const anchored = (anchor: string): string =>
  view?.container.querySelector(`[id="${anchor}"]`)?.textContent ?? '';

const SETTINGS_CARDS: [ProfileCard, string][] = [
  ['calendars', 'КАРТОЧКА-КАЛЕНДАРЕЙ'],
  ['zoom', 'КАРТОЧКА-ZOOM'],
  ['talerid', 'КАРТОЧКА-TALERID'],
  ['logins', 'КАРТОЧКА-ВХОДА'],
  ['reminders', 'КАРТОЧКА-НАПОМИНАНИЙ'],
  ['voices', 'КАРТОЧКА-ГОЛОСОВ'],
];

describe('ссылка на карточку «Моего профиля»', () => {
  it.each(SETTINGS_CARDS)('?open=%s раскрывает «Настройки» и прокручивает к своей карточке', async (card, stub) => {
    const screen = await open(`/profile?open=${card}`);
    expect(screen).toContain(stub);
    expect(scrolledTo).toEqual([profileCardAnchor(card)]);
    expect(anchored(profileCardAnchor(card))).toBe(stub);
  });

  it('?open=notifications — к уведомлениям на этом устройстве', async () => {
    await open('/profile?open=notifications');
    expect(scrolledTo).toEqual([profileCardAnchor('notifications')]);
    expect(anchored(profileCardAnchor('notifications'))).toContain(tRu('settings.push.title'));
  });

  it('?open=partners раскрывает «Партнёры», «Настройки» остаются свёрнутыми', async () => {
    const screen = await open('/profile?open=partners');
    expect(screen).toContain('ПАНЕЛЬ-ПАРТНЁРОВ');
    expect(screen).not.toContain('КАРТОЧКА-ZOOM');
    expect(scrolledTo).toEqual([profileCardAnchor('partners')]);
  });

  it('?open=telegram — к карточке Telegram, ничего не раскрывая', async () => {
    const screen = await open('/profile?open=telegram');
    expect(screen).not.toContain('КАРТОЧКА-ZOOM');
    expect(screen).not.toContain('ПАНЕЛЬ-ПАРТНЁРОВ');
    expect(scrolledTo).toEqual([profileCardAnchor('telegram')]);
    expect(anchored(profileCardAnchor('telegram'))).toContain(tRu('profile.telegram_not_bound'));
  });

  it('?settings=1 раскрывает «Настройки», но никуда не прокручивает', async () => {
    const screen = await open('/profile?settings=1');
    expect(screen).toContain('КАРТОЧКА-ZOOM');
    expect(scrolledTo).toEqual([]);
  });

  it.each(['/profile', '/profile?open=integrations'])('%s — всё свёрнуто, без прокрутки', async (url) => {
    const screen = await open(url);
    expect(screen).not.toContain('КАРТОЧКА-ZOOM');
    expect(screen).not.toContain('ПАНЕЛЬ-ПАРТНЁРОВ');
    expect(scrolledTo).toEqual([]);
  });

  // Карточка, которую называет ссылка, но якоря у которой на экране нет, —
  // тихий провал: профиль откроется, а прокрутка уйдёт в никуда.
  it.each([...PROFILE_CARDS])('у карточки %s есть якорь на экране', async (card) => {
    await open(`/profile?open=${card}`);
    expect(view?.container.querySelector(`[id="${profileCardAnchor(card)}"]`)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $F add src/components/profile/ProfileView.deeplink.test.tsx && git -C $F commit -q -m "test(profile): ссылка на карточку раскрывает блок и прокручивает к ней (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/components/profile/ProfileView.deeplink.test.tsx`. Expected: FAIL почти во всех случаях: якорей нет, адрес читается из `window.location`, а не из роутера. Проходят только «всё свёрнуто».

- [ ] **Step 3: ProfileView — адрес из роутера, раскрытие и прокрутка**

`src/components/profile/ProfileView.tsx`:

1) Строку 3 `import { useNavigate } from 'react-router-dom';` заменить на:

```tsx
import { useLocation, useNavigate } from 'react-router-dom';
```

2) После строки `import { LanguageSelect } from '../settings/LanguageSelect';` добавить:

```tsx
import { profileCardAnchor, profileTarget } from '../../utils/cabinetSections';
```

3) Заменить блок строк 56–74 — от `// Deep-link из виджета лаунчера: /profile?open=calendars (или ?settings=1) — сразу` до закрывающего `}, []);` эффекта прокрутки к `calendar-sources` включительно — на:

```tsx
  // Адрес раздела — из ссылки ассистента или виджета лаунчера (utils/cabinetSections.ts):
  // /profile?open=<карточка> раскрывает её блок и прокручивает к ней,
  // ?settings=1 раскрывает «Настройки». Те же адреса дают ассистенты — у бэка
  // своя копия таблицы, их сверяет общая таблица в cabinetSections.test.ts.
  // search — из роутера, а не из window.location: так видна и смена адреса
  // переходом внутри кабинета (ссылка из чата), и адрес в тестах (MemoryRouter).
  const { search } = useLocation();
  const [showSettings, setShowSettings] = useState(() => profileTarget(search).expand === 'settings');
  const [showReferral, setShowReferral] = useState(() => profileTarget(search).expand === 'referral');
  useEffect(() => {
    const { expand, anchor } = profileTarget(search);
    if (expand === 'settings') setShowSettings(true);
    if (expand === 'referral') setShowReferral(true);
    if (!anchor) return;
    // Пауза — как была у «Календарей»: раскрытый блок и ленивый чанк профиля
    // успевают нарисоваться, прежде чем к карточке прокрутят.
    const id = window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
    return () => window.clearTimeout(id);
  }, [search]);
```

4) Карточка Telegram. Заменить

```tsx
        {/* Telegram identity — для привязки своего TG к Студии (создание ботов) */}
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
```

на

```tsx
        {/* Telegram identity — для привязки своего TG к Студии (создание ботов).
            id — якорь ссылки /profile?open=telegram (utils/cabinetSections.ts). */}
        <div id={profileCardAnchor('telegram')} className="bg-white rounded-lg shadow-sm p-6 border border-gray-200 scroll-mt-4">
```

5) Блок «Партнёры». Заменить (точно с комментарием: у аккордеона настроек выше такой же `className`)

```tsx
        {/* Referral — collapsible аккордеон по тому же паттерну что и Settings. */}
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
```

на

```tsx
        {/* Referral — collapsible аккордеон по тому же паттерну что и Settings.
            id — якорь ссылки /profile?open=partners (utils/cabinetSections.ts). */}
        <div id={profileCardAnchor('partners')} className="bg-white rounded-lg shadow-sm overflow-hidden scroll-mt-4">
```

- [ ] **Step 4: SettingsView — якоря карточек настроек**

`src/components/settings/SettingsView.tsx`:

1) После строки `import { LanguageSelect } from './LanguageSelect';` добавить:

```tsx
import { profileCardAnchor } from '../../utils/cabinetSections';
```

2) Карточка уведомлений. Заменить

```tsx
        {/* Push на это устройство — реальный опт-ин (PWA / браузер) */}
        <div className="bg-white rounded-lg shadow-sm">
```

на

```tsx
        {/* Push на это устройство — реальный опт-ин (PWA / браузер).
            id у карточек ниже — якоря ссылок /profile?open=<карточка>
            (utils/cabinetSections.ts): к ним прокручивает «Мой профиль». */}
        <div id={profileCardAnchor('notifications')} className="bg-white rounded-lg shadow-sm scroll-mt-4">
```

3) Строки 182–194 (от `{/* Мои напоминания …` до `<VoiceSettings />` включительно) заменить на:

```tsx
        {/* Мои напоминания — проактивные рутинные пуши от ассистентов (Слой 3, обобщённые) */}
        <div id={profileCardAnchor('reminders')} className="scroll-mt-4">
          <RoutinesManager />
        </div>

        {/* Экосистема TalerID — согласие на подключение (референс-коннектор над-экосистемного слоя) */}
        <div id={profileCardAnchor('talerid')} className="scroll-mt-4">
          <TalerIdEcosystemCard />
        </div>

        <div id={profileCardAnchor('zoom')} className="scroll-mt-4">
          <ZoomConnectCard />
        </div>

        {/* Календари — заметное место, чтобы добавить свой календарь (Яндекс по логину+паролю; Outlook/Google готовим) */}
        <div id={profileCardAnchor('calendars')} className="scroll-mt-4">
          <CalendarSourcesCard />
        </div>

        {/* Голоса ассистентов — каким голосом озвучивать ответы каждого ассистента.
            Карточка бывает пустой (нет голосов для языка), якорь при этом остаётся. */}
        <div id={profileCardAnchor('voices')} className="scroll-mt-4">
          <VoiceSettings />
        </div>
```

4) Заменить

```tsx
        {/* Linked Accounts */}
        <LinkedAccountsView />
```

на

```tsx
        {/* Linked Accounts */}
        <div id={profileCardAnchor('logins')} className="scroll-mt-4">
          <LinkedAccountsView />
        </div>
```

- [ ] **Step 5: CalendarSourcesCard — один якорь на карточку**

`src/components/settings/CalendarSourcesCard.tsx`, в `return (` заменить

```tsx
    <div id="calendar-sources" className="bg-white rounded-lg shadow-sm scroll-mt-4">
```

на

```tsx
    // Якорь ссылки /profile?open=calendars — на обёртке в SettingsView
    // (utils/cabinetSections.ts): один на карточку, как у соседних.
    <div className="bg-white rounded-lg shadow-sm">
```

Проверка, что `calendar-sources` больше нигде не нужен: `git -C $F grep -n "calendar-sources" -- src` — пусто.

- [ ] **Step 6: Коммит и прогон — ждём PASS**

```bash
git -C $F add src/components/profile/ProfileView.tsx src/components/settings/SettingsView.tsx src/components/settings/CalendarSourcesCard.tsx && git -C $F commit -q -m "profile: /profile?open=<карточка> раскрывает блок и прокручивает к ней — девять карточек, адрес из роутера" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/components/profile src/components/settings src/components/webvisorPrivacy.test.ts`. Expected: PASS (вместе с `ZoomConnectCard.test.tsx` и сторожем Вебвизора). tsc — не выше базы.

---

### Задача Ф4: Старые `/settings` и `/referral` сохраняют параметры

**Files:**
- Create: `src/components/LegacyProfileRedirect.tsx`
- Modify: `src/App.tsx:12` (импорт), `:245` (`/referral`), `:251` (`/settings`)
- Test: `src/components/LegacyProfileRedirect.test.tsx` (новый)

- [ ] **Step 1: Тест**

`src/components/LegacyProfileRedirect.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Старые адреса /settings и /referral ведут в «Мой профиль» — с параметрами.
// Прежний <Navigate to="/profile"> терял всё после «?», и ссылка
// /settings?open=zoom (или возврат после привязки входа /settings?linked=1)
// открывала профиль со свёрнутыми настройками.
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { flush, mount, visibleText, type Mounted } from '../test/dom';
import LegacyProfileRedirect from './LegacyProfileRedirect';

// Экран-свидетель: показывает, где человек оказался.
const Where = () => {
  const l = useLocation();
  return <div>at:{`${l.pathname}${l.search}`}</div>;
};

let view: Mounted | null = null;

async function open(url: string): Promise<string> {
  view?.unmount();
  view = mount(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/settings" element={<LegacyProfileRedirect from="settings" />} />
        <Route path="/referral" element={<LegacyProfileRedirect from="referral" />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
  return visibleText(view.container);
}

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('старые адреса настроек и партнёров', () => {
  it('/settings — профиль с раскрытыми настройками', async () => {
    expect(await open('/settings')).toBe('at:/profile?settings=1');
  });

  it('/settings?open=zoom — сразу карточка Zoom', async () => {
    expect(await open('/settings?open=zoom')).toBe('at:/profile?open=zoom');
  });

  it('возврат после привязки входа не теряет параметр', async () => {
    expect(await open('/settings?linked=1')).toBe('at:/profile?linked=1&settings=1');
  });

  it('/referral — блок «Партнёры», параметры на месте', async () => {
    expect(await open('/referral')).toBe('at:/profile?open=partners');
    expect(await open('/referral?ref=abc')).toBe('at:/profile?ref=abc&open=partners');
  });

  it('App.tsx ведёт оба старых адреса через этот редирект', () => {
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('<Route path="/settings" element={<LegacyProfileRedirect from="settings" />} />');
    expect(app).toContain('<Route path="/referral" element={<LegacyProfileRedirect from="referral" />} />');
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $F add src/components/LegacyProfileRedirect.test.tsx && git -C $F commit -q -m "test(cabinet): /settings и /referral сохраняют параметры (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/components/LegacyProfileRedirect.test.tsx`. Expected: FAIL — `Failed to resolve import "./LegacyProfileRedirect"`.

- [ ] **Step 3: Компонент и маршруты**

`src/components/LegacyProfileRedirect.tsx`:

```tsx
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { legacyProfilePath } from '../utils/cabinetSections';

/**
 * Старые адреса /settings и /referral — в «Мой профиль» с параметрами
 * (utils/cabinetSections.ts, legacyProfilePath). Прежний
 * <Navigate to="/profile"> терял всё после «?».
 */
const LegacyProfileRedirect: React.FC<{ from: 'settings' | 'referral' }> = ({ from }) => {
  const { search } = useLocation();
  return <Navigate to={legacyProfilePath(from, search)} replace />;
};

export default LegacyProfileRedirect;
```

`src/App.tsx`:

1) После строки `import PendingDestinationRedirect from './components/PendingDestinationRedirect';` добавить:

```tsx
import LegacyProfileRedirect from './components/LegacyProfileRedirect'; // eager: две строки, отдельный чанк ради них незачем
```

2) Заменить

```tsx
            <Route path="/referral" element={<Navigate to="/profile" replace />} />
```

на

```tsx
            <Route path="/referral" element={<LegacyProfileRedirect from="referral" />} />
```

3) Заменить

```tsx
            <Route path="/settings" element={<Navigate to="/profile" replace />} />
```

на

```tsx
            <Route path="/settings" element={<LegacyProfileRedirect from="settings" />} />
```

`Navigate` в App.tsx остаётся в ходу (`/chats`, `/my-agents`, `/telegram-bots`, `/compatibility`) — импорт не трогать.

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $F add src/components/LegacyProfileRedirect.tsx src/App.tsx && git -C $F commit -q -m "cabinet: /settings и /referral ведут в профиль с параметрами — настройки раскрыты, партнёры открыты" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/components/LegacyProfileRedirect.test.tsx`. Expected: PASS. tsc — не выше базы.

---

### Задача Ф5: Чат — своя ссылка в той же вкладке, кнопка «settings» — в настройки

**Files:**
- Modify: `src/components/chat/ChatInterface.tsx:26` (импорт), `:389-391` (`case 'settings'`), `:406-415` (`handleLinkNavigation`)
- Test: `src/components/chat/cabinetLinksWiring.test.ts` (новый)

ChatInterface на 3500 строк в тесте не смонтировать. Логика — в `cabinetPath` (тесты Ф1), а то, что чат её зовёт, сторожит тест исходника, как соседние `*Wiring.test.ts`. Все три вида ссылок в ответе (`{{link}}`, markdown-ссылка, голый https через remark-gfm) идут через `handleLinkNavigation`.

- [ ] **Step 1: Тест**

`src/components/chat/cabinetLinksWiring.test.ts`:

```ts
// src/components/chat/cabinetLinksWiring.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Сторож проводки ChatInterface: чистая логика — в utils/cabinetSections.ts
 * (свои тесты), а что чат её зовёт, видно только здесь. Уберёшь вызов — и
 * ссылки ассистента на разделы снова уйдут в новую вкладку (в приложении —
 * во внешний браузер без входа), а тесты модуля останутся зелёными.
 * Через handleLinkNavigation идут все три вида ссылок в ответе: {{link}},
 * markdown-ссылка и голый https (remark-gfm делает из него <a>).
 */
const SRC = readFileSync(join(__dirname, 'ChatInterface.tsx'), 'utf8');

const between = (from: string, to: string): string => {
  const a = SRC.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = SRC.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return SRC.slice(a, b);
};

describe('ссылки чата на свой кабинет', () => {
  it('своя ссылка проверяется ДО открытия новой вкладки', () => {
    const body = between('const handleLinkNavigation = useCallback', '}, [navigate]);');
    const own = body.indexOf('cabinetPath(url)');
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(body.indexOf('window.open('));
  });

  it('кнопка «Настройки» ведёт в раскрытые настройки профиля', () => {
    const body = between('const handleButtonAction = useCallback', '}, [navigate]);');
    expect(body).toMatch(/case 'settings':\s*navigate\('\/profile\?settings=1'\);/);
    expect(body).not.toContain("navigate('/settings')");
  });

  it('markdown-ссылка и {{link}} — через тот же обработчик', () => {
    expect(SRC).toContain('if (href) handleLinkNavigation(href);');
    expect(SRC).toContain('createLinkComponent(linkConfig, handleLinkNavigation)');
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $F add src/components/chat/cabinetLinksWiring.test.ts && git -C $F commit -q -m "test(chat): своя ссылка — в той же вкладке, кнопка настроек — в профиль (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/components/chat/cabinetLinksWiring.test.ts`. Expected: FAIL — первые два теста; третий PASS.

- [ ] **Step 3: Проводка в ChatInterface**

`src/components/chat/ChatInterface.tsx`:

1) После строки 26 (`import { parseCustomMarkdown, … } from '../../utils/customMarkdown';`) добавить:

```tsx
import { cabinetPath } from '../../utils/cabinetSections';
```

2) В `handleButtonAction` заменить

```tsx
      case 'settings':
        navigate('/settings');
        break;
```

на (комментарий — НАД меткой `case`: между `case` и `navigate` его не пустит регулярка сторожа)

```tsx
      // Прямо в раскрытые «Настройки» профиля, а не через старый адрес.
      case 'settings':
        navigate('/profile?settings=1');
        break;
```

3) Заменить `handleLinkNavigation` целиком:

```tsx
  const handleLinkNavigation = useCallback((url: string) => {
    // Static files and external URLs open in new tab
    if (url.startsWith('/static/') || url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener');
    } else if (url.startsWith('/')) {
      navigate(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }, [navigate]);
```

на

```tsx
  const handleLinkNavigation = useCallback((url: string) => {
    // Ссылка на свой кабинет (https://my.linkeon.io/profile?open=zoom из ответа
    // ассистента) — в той же вкладке, переходом роутера: новая вкладка
    // загружала бы кабинет заново, а в приложении открылся бы внешний браузер
    // без входа (utils/cabinetSections.ts).
    const inside = cabinetPath(url);
    if (inside) {
      navigate(inside);
      return;
    }
    // Static files and external URLs open in new tab
    if (url.startsWith('/static/') || url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener');
    } else if (url.startsWith('/')) {
      navigate(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }, [navigate]);
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $F add src/components/chat/ChatInterface.tsx && git -C $F commit -q -m "chat: ссылка на свой кабинет открывается в той же вкладке; кнопка settings — в настройки профиля" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/components/chat src/utils/customMarkdown.test.ts`. Expected: PASS. tsc — не выше базы.

---

### Задача Ф6: Поддержка — ссылки нажимаются

**Files:**
- Create: `src/utils/linkify.ts`
- Modify: `src/components/support/SupportView.tsx:1-7` (импорты), `:43-63` (`MessageBubble` и новый `MessageText`)
- Test: `src/utils/linkify.test.ts` (новый), `src/components/support/SupportView.links.test.tsx` (новый)

- [ ] **Step 1: Тесты**

`src/utils/linkify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { linkifyText } from './linkify';

describe('linkifyText', () => {
  it('текст без адресов — один кусок текста', () => {
    expect(linkifyText('Просто текст.')).toEqual([{ kind: 'text', text: 'Просто текст.' }]);
  });

  it('адрес посреди текста — ссылка; точка в конце предложения — текст', () => {
    expect(linkifyText('Откройте https://my.linkeon.io/profile?open=zoom. Готово')).toEqual([
      { kind: 'text', text: 'Откройте ' },
      { kind: 'link', text: 'https://my.linkeon.io/profile?open=zoom', href: 'https://my.linkeon.io/profile?open=zoom' },
      { kind: 'text', text: '. Готово' },
    ]);
  });

  it('скобки вокруг адреса — не часть адреса; парная скобка внутри — часть', () => {
    expect(linkifyText('(см. https://example.org/a)')[1]).toEqual({
      kind: 'link',
      text: 'https://example.org/a',
      href: 'https://example.org/a',
    });
    expect(linkifyText('https://en.wikipedia.org/wiki/Foo_(bar)')[0]).toEqual({
      kind: 'link',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('ёлочки вокруг адреса — тоже не часть адреса', () => {
    expect(linkifyText('«https://example.org/x»')).toEqual([
      { kind: 'text', text: '«' },
      { kind: 'link', text: 'https://example.org/x', href: 'https://example.org/x' },
      { kind: 'text', text: '»' },
    ]);
  });

  it('только http и https: javascript:, data: и ftp: остаются текстом', () => {
    for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.org/f']) {
      expect(linkifyText(s).every((p) => p.kind === 'text'), s).toBe(true);
    }
  });

  it('голое «https://» — не адрес', () => {
    expect(linkifyText('https:// и всё')).toEqual([{ kind: 'text', text: 'https:// и всё' }]);
  });

  it('несколько адресов подряд', () => {
    const links = linkifyText('https://a.example/1 и https://b.example/2').filter((p) => p.kind === 'link');
    expect(links.map((p) => p.text)).toEqual(['https://a.example/1', 'https://b.example/2']);
  });
});
```

`src/components/support/SupportView.links.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Ответы поддержки — простой текст, и адрес раздела из ответа не нажимался:
// человек переписывал его руками. Проверяем по экрану: есть ли ссылка, куда
// ведёт и как открывается — свой кабинет в той же вкладке, чужой сайт в
// новой, без доступа к нашей.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { byLink, click, flush, mount, visibleText, type Mounted } from '../../test/dom';
import type { SupportMessage, SupportTicket } from './useSupport';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
// SupportView берёт toIntlLocale из utils/formatters, а тот — настоящий конфиг
// i18next (initReactI18next), которого в заглушке react-i18next нет. Так же
// сделано в SpendingSummary.test.tsx и LoginConsentBlock.test.tsx.
vi.mock('../../i18n', () => ({ default: { language: 'ru' } }));

const state = vi.hoisted(() => ({ messages: [] as SupportMessage[] }));

vi.mock('./useSupport', () => ({
  useSupport: () => {
    const ticket: SupportTicket = {
      id: 't-1',
      status: 'ai_handling',
      urgency: null,
      topic: null,
      createdAt: '2026-10-27T10:00:00.000Z',
      lastMessageAt: null,
      messages: state.messages,
    };
    return {
      tickets: [ticket],
      latestTicket: ticket,
      isLatestActive: true,
      composingNew: false,
      startNewTicket: () => {},
      loading: false,
      sending: false,
      waitingForAi: false,
      sendMessage: async () => {},
    };
  },
}));

import SupportView from './SupportView';

// Экран-свидетель: показывает, куда увела ссылка.
const Where = () => {
  const l = useLocation();
  return <div data-where>{`${l.pathname}${l.search}`}</div>;
};

let view: Mounted | null = null;

beforeAll(() => {
  // jsdom не прокручивает, а лента поддержки докручивает себя вниз после рисования.
  Element.prototype.scrollTo = () => {};
  window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
});

afterEach(() => {
  view?.unmount();
  view = null;
});

async function open(content: string): Promise<HTMLElement> {
  state.messages = [{ id: 'm-1', senderType: 'ai', content, createdAt: '2026-10-27T10:00:00.000Z' }];
  view = mount(
    <MemoryRouter initialEntries={['/support']}>
      <SupportView />
      <Where />
    </MemoryRouter>,
  );
  await flush();
  return view.container;
}

const where = (c: HTMLElement) => c.querySelector('[data-where]')?.textContent;

describe('ссылки в ответах поддержки', () => {
  it('адрес раздела — ссылка, и открывается в кабинете, в той же вкладке', async () => {
    const c = await open('Карточка Zoom тут: https://my.linkeon.io/profile?open=zoom.');
    const a = byLink(c, /my\.linkeon\.io\/profile\?open=zoom$/);
    expect(a).not.toBeNull();
    expect(a!.getAttribute('target')).toBeNull();
    // Точка в конце предложения — не часть адреса, но на экране осталась.
    expect(visibleText(c)).toContain('https://my.linkeon.io/profile?open=zoom.');
    click(a!);
    await flush();
    expect(where(c)).toBe('/profile?open=zoom');
  });

  it('чужой сайт — новая вкладка без доступа к нашей', async () => {
    const c = await open('Источник: https://example.org/docs/page');
    const a = byLink(c, /example\.org/);
    expect(a?.getAttribute('href')).toBe('https://example.org/docs/page');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('не http(s) — остаётся текстом', async () => {
    const c = await open('Не нажимай javascript:alert(1) и data:text/html,x');
    expect(c.querySelectorAll('a')).toHaveLength(0);
    expect(visibleText(c)).toContain('javascript:alert(1)');
  });

  it('текст без адресов — как был', async () => {
    const c = await open('Обычный ответ без ссылок.');
    expect(c.querySelectorAll('a')).toHaveLength(0);
    expect(visibleText(c)).toContain('Обычный ответ без ссылок.');
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $F add src/utils/linkify.test.ts src/components/support/SupportView.links.test.tsx && git -C $F commit -q -m "test(support): ссылки в ответах поддержки нажимаются, только http(s) (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/utils/linkify.test.ts src/components/support/SupportView.links.test.tsx`. Expected: FAIL — `Failed to resolve import "./linkify"`; в SupportView первые два теста (ссылок нет).

- [ ] **Step 3: linkify**

`src/utils/linkify.ts`:

```ts
/**
 * Текст с адресами — куски для показа: обычный текст и ссылки.
 *
 * Поддержка показывает ответы простым текстом (SupportView), и адрес раздела
 * из ответа (https://my.linkeon.io/profile?open=zoom) не нажимался — человек
 * переписывал его руками. Ссылкой становится только http(s):// — javascript:,
 * data: и прочее остаются текстом — и только то, что разбирает URL. Знак
 * препинания вплотную за адресом — конец предложения, а не часть адреса.
 * Закрывающая скобка — часть адреса, только если открывающая тоже в нём
 * (…/wiki/Foo_(bar)).
 */
export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"'`«»]+/gi;
const TRAILING = /[.,;:!?…'"»”’]$/;

function trimTail(raw: string): string {
  let s = raw;
  for (;;) {
    if (TRAILING.test(s)) {
      s = s.slice(0, -1);
      continue;
    }
    const open = s.split('(').length - 1;
    const close = s.split(')').length - 1;
    if (s.endsWith(')') && close > open) {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

export function linkifyText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = trimTail(m[0]);
    let href: string | null = null;
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href;
    } catch {
      /* не адрес — останется текстом */
    }
    if (!href) continue;
    if (start > at) parts.push({ kind: 'text', text: text.slice(at, start) });
    parts.push({ kind: 'link', text: raw, href });
    at = start + raw.length;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}
```

- [ ] **Step 4: SupportView — текст сообщения со ссылками**

`src/components/support/SupportView.tsx`:

1) После строки `import { toIntlLocale } from '../../utils/formatters';` добавить:

```tsx
import { linkifyText } from '../../utils/linkify';
import { cabinetPath } from '../../utils/cabinetSections';
```

2) Перед `function MessageBubble(` добавить компонент:

```tsx
/**
 * Текст сообщения: адреса — ссылками (utils/linkify.ts). Ответы поддержки
 * приходят простым текстом, и адрес раздела из ответа не нажимался — его
 * переписывали руками. Свой кабинет (cabinetPath) открывается в той же
 * вкладке переходом роутера, как в чате с ассистентом; чужой сайт — в новой
 * вкладке без доступа к нашей (noopener noreferrer).
 */
function MessageText({ text }: { text: string }) {
  const navigate = useNavigate();
  return (
    <>
      {linkifyText(text).map((part, i) => {
        if (part.kind === 'text') return <React.Fragment key={i}>{part.text}</React.Fragment>;
        const inside = cabinetPath(part.href);
        if (inside) {
          return (
            <a
              key={i}
              href={part.href}
              onClick={(e) => {
                e.preventDefault();
                navigate(inside);
              }}
              className="underline break-all"
            >
              {part.text}
            </a>
          );
        }
        return (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="underline break-all">
            {part.text}
          </a>
        );
      })}
    </>
  );
}
```

3) В `MessageBubble` заменить строку

```tsx
        <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
```

на

```tsx
        <p className="text-sm whitespace-pre-wrap break-words"><MessageText text={m.content} /></p>
```

Лента `support-messages-list` уже `ym-hide-content` — ссылки внутри неё Вебвизор не пишет. Сторож `webvisorPrivacy.test.ts` смотрит на этот контейнер и на поле ввода, их не трогаем.

- [ ] **Step 5: Коммит и прогон — ждём PASS**

```bash
git -C $F add src/utils/linkify.ts src/components/support/SupportView.tsx && git -C $F commit -q -m "support: адреса в ответах — ссылки; свой кабинет в той же вкладке, чужой сайт — новая вкладка noopener" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, фронт): `src/utils/linkify.test.ts src/components/support src/components/webvisorPrivacy.test.ts`. Expected: PASS. tsc — не выше базы.

---

### Задача Ф7: Итоговый прогон фронта

**Files:** ничего не меняется (кроме случая, когда прогон что-то нашёл — тогда правка и отдельный коммит).

- [ ] **Step 1: Полный vitest, tsc, хардкод, сборка**

```bash
F=/Users/dmitry/Downloads/spirits_front/.worktrees/assistant-links
git -C $F push -q origin HEAD:refs/heads/feat/assistant-links
SHA=$(git -C $F rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/al-front && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && npx vitest run 2>&1 | tail -6; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'; node scripts/check-no-hardcoded.mjs >/dev/null 2>&1 && echo hardcoded-ok || echo hardcoded-red; pnpm build >/tmp/al-front-build.log 2>&1 && echo build-ok || tail -20 /tmp/al-front-build.log"
```

Expected: passed = база Ф0 + новые тесты, failed — не больше, чем в базе; `error TS` — не выше базы; `hardcoded-*` — как в базе; `build-ok`.

- [ ] **Step 2: Отчёт** — записать числа (база → итог) и `SHA` последнего коммита ветки `feat/assistant-links` фронта.

---

## Трек 2. Бэк (`spirits_back`, `feat/assistant-links`)

### Задача Б0: Подготовка — CI-клон бэка, базовая линия

**Files:** в репозитории ничего не меняется.

- [ ] **Step 1: Ветка и пуш на месте**

```bash
B=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links
git -C $B branch --show-current
git -C $B fetch -q origin && git -C $B status -sb | head -1
```

Expected: `feat/assistant-links` и `## feat/assistant-links...origin/feat/assistant-links` без `ahead`/`behind`: план уже запушен.

- [ ] **Step 2: CI-воркдерево на ноде**

```bash
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/al-back origin/feat/assistant-links && cd ~/ci/wt/al-back && source ~/.nvm/nvm.sh >/dev/null && npm ci --no-audit --no-fund >/dev/null && npx tsc -p tsconfig.build.json --noEmit && echo back-ok'
```

Expected: `back-ok`.

- [ ] **Step 3: Базовая линия — записать в отчёт**

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/al-back && source ~/.nvm/nvm.sh >/dev/null && npx jest --runInBand src/platform-kb src/chat src/support src/tg-bot src/zoom src/mcp/relay-products-tools.spec.ts src/products/products-cli-tool.spec.ts 2>&1 | grep -E '^Tests:|^Test Suites:'"
```

Expected: числа наборов и тестов PASS/FAIL/skipped — записать. Для справки: запас статей до 5120 байт на 27.10 (максимум по всем вариантам) — products 9, chat 190, account 204, how-it-works 478, остальные ≥ 859.

---

### Задача Б1: Таблица адресов разделов

**Files:**
- Create: `src/platform-kb/section-links.ts`
- Test: `src/platform-kb/section-links.spec.ts`

- [ ] **Step 1: Тест**

`src/platform-kb/section-links.spec.ts`:

```ts
import { CABINET_ORIGIN, PAID_SECTIONS, SECTION_PATHS, sectionUrl, type SectionKey } from './section-links';

/**
 * Адреса разделов, которые дают ассистенты.
 *
 * ОБЩАЯ ТАБЛИЦА — дословно та же стоит в spirits_front
 * src/utils/cabinetSections.test.ts: что кабинет по этим адресам открывает,
 * к какой карточке прокручивает и что из них переживает вход. Меняется в
 * обоих репозиториях одним изменением. Сверка — пустой вывод diff блоков
 * между строками-метками «<<<» и «>>>» с «АДРЕСА РАЗДЕЛОВ» (команда — задача
 * С1 плана 2026-10-27-assistant-links-sources-roles).
 */
// <<< АДРЕСА РАЗДЕЛОВ — общая таблица бэка и фронта, менять в обоих репозиториях
const SECTION_TABLE = [
  '/chat',
  '/help',
  '/image-gen',
  '/profile',
  '/profile?open=calendars',
  '/profile?open=logins',
  '/profile?open=notifications',
  '/profile?open=partners',
  '/profile?open=reminders',
  '/profile?open=talerid',
  '/profile?open=telegram',
  '/profile?open=voices',
  '/profile?open=zoom',
  '/profile?settings=1',
  '/search',
  '/studio',
  '/studio?tab=bots',
  '/studio?tab=products',
  '/support',
  '/video',
];
// >>> АДРЕСА РАЗДЕЛОВ

const KEYS = Object.keys(SECTION_PATHS) as SectionKey[];

describe('таблица адресов разделов', () => {
  it('ровно общая таблица — та же, что открывает кабинет', () => {
    expect(Object.values(SECTION_PATHS).sort()).toEqual(SECTION_TABLE);
  });

  it('адреса абсолютные, https и только на my.linkeon.io', () => {
    const bad = KEYS.filter((k) => {
      const u = new URL(sectionUrl(k));
      return u.origin !== CABINET_ORIGIN || u.protocol !== 'https:';
    });
    expect(bad).toEqual([]);
    expect(CABINET_ORIGIN).toBe('https://my.linkeon.io');
  });

  it('ни пополнения, ни оплаты: ссылку на пополнение даёт блок баланса', () => {
    expect(Object.values(SECTION_PATHS).filter((p) => /view=tokens|^\/tokens|payment/.test(p))).toEqual([]);
  });

  it('разделы о деньгах — из таблицы', () => {
    expect(PAID_SECTIONS.filter((k) => !SECTION_PATHS[k])).toEqual([]);
  });

  it('sectionUrl — домен и путь', () => {
    expect(sectionUrl('zoom')).toBe('https://my.linkeon.io/profile?open=zoom');
    expect(sectionUrl('studioBots')).toBe('https://my.linkeon.io/studio?tab=bots');
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/platform-kb/section-links.spec.ts && git -C $B commit -q -m "test(platform-kb): таблица адресов разделов — общая с кабинетом (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb/section-links.spec.ts`. Expected: FAIL — `Cannot find module './section-links'`.

- [ ] **Step 3: Таблица**

`src/platform-kb/section-links.ts`:

```ts
/**
 * Адреса разделов кабинета — ОДНО место на бэке. Их дают ассистентам справка
 * (строка «Ссылка…» в разделе «Где» статей, articles/*.ts через url()) и блок
 * «Что есть в Linkeon» (chat/platform-guide.ts), а через него — ИИ-поддержка
 * и боты в Telegram.
 *
 * Находка «Затыков недели» 19–25.10.2026 (e4f01175): словесное указание
 * раздела («в интеграциях») не помогло его найти. Раздела «Интеграции» в
 * кабинете нет, подключения разбросаны по карточкам «Настроек»; ссылка ведёт
 * прямо к карточке.
 *
 * Адреса АБСОЛЮТНЫЕ — тот же довод, что у TOP_UP_URL
 * (tokens/balance-context.service.ts): модель воспроизводит адрес текстом, и
 * относительный путь в Telegram (бот примет «/profile» за команду), в
 * мобильном приложении и в пересланном сообщении никуда не ведёт.
 *
 * ДВЕ КОПИИ ОДНОЙ ТАБЛИЦЫ: эта и кабинет (spirits_front
 * src/utils/cabinetSections.ts — что кабинет по адресу открывает, к какой
 * карточке прокручивает и что из адресов переживает вход). Разъедутся —
 * ассистент даст ссылку, по которой кабинет откроет не ту карточку или после
 * входа уведёт в чат. Сторож — общая таблица между метками «АДРЕСА РАЗДЕЛОВ»
 * в section-links.spec.ts и в cabinetSections.test.ts фронта, дословно одна и
 * та же; меняется в обоих репозиториях одним изменением.
 *
 * Оплаты здесь нет намеренно: ссылку на пополнение даёт блок баланса
 * (TOP_UP_URL), он знает про сборки для сторов.
 */
export const CABINET_ORIGIN = 'https://my.linkeon.io';

/**
 * Ключ — как у подписи раздела в labels.generated.ts (где подпись есть), а
 * значение — адрес кабинета. Имена карточек в адресе (logins, reminders,
 * notifications) — кабинетные, их и сверяет общая таблица.
 */
export const SECTION_PATHS = {
  chat: '/chat',
  networking: '/search',
  imageGen: '/image-gen',
  video: '/video',
  studio: '/studio',
  studioBots: '/studio?tab=bots',
  studioProducts: '/studio?tab=products',
  profile: '/profile',
  settings: '/profile?settings=1',
  calendars: '/profile?open=calendars',
  zoom: '/profile?open=zoom',
  talerid: '/profile?open=talerid',
  loginMethods: '/profile?open=logins',
  routines: '/profile?open=reminders',
  voices: '/profile?open=voices',
  push: '/profile?open=notifications',
  telegram: '/profile?open=telegram',
  partners: '/profile?open=partners',
  help: '/help',
  support: '/support',
} as const;

export type SectionKey = keyof typeof SECTION_PATHS;

/** Разделы о деньгах: сборке из стора о них не говорят (как и о темах paidOnly). */
export const PAID_SECTIONS: readonly SectionKey[] = ['partners'];

/** Полный адрес раздела: sectionUrl('zoom') → https://my.linkeon.io/profile?open=zoom. */
export function sectionUrl(key: SectionKey): string {
  return CABINET_ORIGIN + SECTION_PATHS[key];
}
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/platform-kb/section-links.ts && git -C $B commit -q -m "platform-kb: таблица абсолютных адресов разделов — одно место на бэке, копия кабинета" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb/section-links.spec.ts`. Expected: PASS. Затем tsc бэка — `tsc-ok`.

---

### Задача Б2: `url()` в контексте сборки статьи

**Files:**
- Modify: `src/platform-kb/kb.types.ts:1-2` (импорт), `:22-36` (`KbContext`)
- Modify: `src/platform-kb/render.ts:1-4` (импорт), `:25-34` (`kbContext`)
- Modify: `src/platform-kb/kb.spec.ts:173` (сторож исходников)
- Test: `src/platform-kb/render.spec.ts`

- [ ] **Step 1: Тест**

`src/platform-kb/render.spec.ts`:

1) Первую строку `import { CLIENT_NOTES, dropEmptySections, renderArticle, renderIndex, topicsFor } from './render';` заменить на:

```ts
import { CLIENT_NOTES, dropEmptySections, kbContext, renderArticle, renderIndex, topicsFor } from './render';
```

2) В конец файла добавить:

```ts
describe('url() — адрес раздела для строки «Ссылка…»', () => {
  it('полный адрес из таблицы section-links.ts, в любом языке и клиенте', () => {
    expect(kbContext('ru', 'web').url('zoom')).toBe('https://my.linkeon.io/profile?open=zoom');
    expect(kbContext('en', 'telegram').url('studioBots')).toBe('https://my.linkeon.io/studio?tab=bots');
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/platform-kb/render.spec.ts && git -C $B commit -q -m "test(platform-kb): url() в контексте сборки статьи (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb/render.spec.ts`. Expected: FAIL — `url is not a function`.

- [ ] **Step 3: Контекст и сторож исходников**

`src/platform-kb/kb.types.ts`:

1) После строки `import type { KbLabelKey } from './labels.generated';` добавить:

```ts
import type { SectionKey } from './section-links';
```

2) Строку комментария `/** Что получает render статьи. Имена q, paid и nonStore — договорённость: на них опирается тест исходников. */` заменить на:

```ts
/** Что получает render статьи. Имена q, paid, nonStore и url — договорённость: на них опирается тест исходников. */
```

3) В `interface KbContext` после поля `nonStore: (text: string) => string;` (перед закрывающей `}`) добавить:

```ts
  /**
   * Полный адрес раздела кабинета для строки «Ссылка…» в разделе «Где»:
   * url('zoom') → https://my.linkeon.io/profile?open=zoom (section-links.ts).
   * Адрес не зависит ни от языка, ни от клиента: работает он везде.
   */
  url: (key: SectionKey) => string;
```

`src/platform-kb/render.ts`:

1) После строки `import { labelsFor } from './labels';` добавить:

```ts
import { sectionUrl } from './section-links';
```

2) В `kbContext` после строки `nonStore: (text: string) => (client === 'store' ? '' : text),` добавить:

```ts
    url: sectionUrl,
```

`src/platform-kb/kb.spec.ts` — в тесте «в статичном тексте нет цифр и чужих подстановок» после строки

```ts
        .replace(/\$\{q\('[A-Za-z]+'\)\}/g, '')
```

добавить

```ts
        .replace(/\$\{url\('[A-Za-z]+'\)\}/g, '')
```

Без этой строки сторож назвал бы `${url('chat')}` «чужой подстановкой», а адрес `?settings=1`, написанный текстом, — «цифрой». Поэтому адреса в статьях — только через `url()`.

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/platform-kb/kb.types.ts src/platform-kb/render.ts src/platform-kb/kb.spec.ts && git -C $B commit -q -m "platform-kb: url() в контексте сборки — адрес раздела из таблицы; сторож исходников его знает" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb`. Expected: PASS. tsc бэка — `tsc-ok`.

---

### Задача Б3: Строки «Ссылка…» в разделе «Где» семнадцати статей

**Files:**
- Modify: `src/platform-kb/articles/{start,chat,call,meetings,networking,images,video,speech,studio-assistants,studio-bots,profile,calendars,routines,partners,account,apps,support}.ts`
- Test: `src/platform-kb/section-links.spec.ts`

- [ ] **Step 1: Тест**

`src/platform-kb/section-links.spec.ts`:

1) Под первым импортом добавить:

```ts
import { KB_ARTICLES } from './articles';
import { KB_CLIENTS, type KbClient } from './kb.types';
import { renderArticle } from './render';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';
```

2) В конец файла:

```ts
/**
 * Какие статьи несут ссылку на свой раздел — строку «Ссылка…: <адрес>» в
 * разделе «Где» — и на какой. Без ссылки сознательно: products — предел
 * 5 КБ (запас статьи — единицы байт; ссылку на «Продукты» несёт блок «Что
 * есть в Linkeon»), tokens и payments — оплата, ссылку на пополнение даёт
 * блок баланса, how-it-works — без раздела «Где».
 */
const ARTICLE_LINKS: Record<string, SectionKey[]> = {
  start: ['chat'],
  chat: ['chat'],
  call: ['chat'],
  meetings: ['zoom'],
  networking: ['networking'],
  images: ['imageGen'],
  video: ['video'],
  speech: ['voices'],
  'studio-assistants': ['studio'],
  'studio-bots': ['studioBots', 'telegram'],
  profile: ['profile', 'settings'],
  calendars: ['calendars', 'talerid'],
  routines: ['routines', 'push'],
  partners: ['partners'],
  account: ['loginMethods'],
  apps: ['settings'],
  support: ['help', 'support'],
};

interface Variant { id: string; lang: string; client: KbClient; text: string }

function variants(): Variant[] {
  const out: Variant[] = [];
  for (const a of KB_ARTICLES) {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const client of KB_CLIENTS) {
        if (client === 'store' && a.paidOnly) continue;
        out.push({ id: a.id, lang, client, text: renderArticle(a, lang, client) });
      }
    }
  }
  return out;
}
const where = (v: Variant) => `${v.id}/${v.lang}/${v.client}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Раздел «Где» статьи: от заголовка до следующего «## ». */
function whereSection(text: string): string {
  const at = text.indexOf('\n## Где\n');
  if (at < 0) return '';
  const next = text.indexOf('\n## ', at + 1);
  return next < 0 ? text.slice(at) : text.slice(at, next);
}

describe('ссылки на разделы в справке', () => {
  let all: Variant[];
  beforeAll(() => {
    all = variants();
  });

  it('статьи таблицы несут свои ссылки в разделе «Где», отдельной строкой «Ссылка…»', () => {
    const problems: string[] = [];
    for (const v of all) {
      for (const key of ARTICLE_LINKS[v.id] ?? []) {
        const line = new RegExp(`^Ссылка[^\\n]*: ${escapeRe(sectionUrl(key))}$`, 'm');
        if (!line.test(whereSection(v.text))) problems.push(`${where(v)}: нет ссылки ${key}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('статьи вне таблицы — без строки «Ссылка» (таблица выше — полный перечень)', () => {
    expect(all.filter((v) => !ARTICLE_LINKS[v.id] && /^Ссылка/m.test(v.text)).map(where)).toEqual([]);
  });

  it('любой https-адрес в справке — из таблицы разделов', () => {
    const known = new Set(KEYS.map(sectionUrl));
    const problems: string[] = [];
    for (const v of all) {
      for (const m of v.text.matchAll(/https:\/\/[^\s)»,;]+/g)) {
        if (!known.has(m[0])) problems.push(`${where(v)}: ${m[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('сборка из стора: ни одной ссылки на раздел о деньгах', () => {
    const paid = PAID_SECTIONS.map(sectionUrl);
    expect(all.filter((v) => v.client === 'store' && paid.some((u) => v.text.includes(u))).map(where)).toEqual([]);
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/platform-kb/section-links.spec.ts && git -C $B commit -q -m "test(platform-kb): ссылки на разделы в «Где» статей (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb/section-links.spec.ts`. Expected: FAIL — «статьи таблицы несут свои ссылки…» со списком из всех 17 статей; остальные тесты PASS.

- [ ] **Step 3: Ссылки в статьях**

В каждом из 17 файлов — две правки:

а) в строке `render: (…) =>` заменить деструктуризацию на ту, что в колонке «render — деструктуризация» (`url` — последним; остальное в строке без изменений);

б) СРАЗУ под единственной строкой раздела `## Где` (перед пустой строкой и следующим `## …`) добавить строки из последней колонки — дословно, каждую на своей строке, без знаков препинания после адреса (решение плана 10).

| Файл | render — деструктуризация | Добавить под строкой «Где» |
|---|---|---|
| `start.ts` | `({ q, paid, url })` | `Ссылка: ${url('chat')}` |
| `chat.ts` | `({ q, paid, url })` | `Ссылка: ${url('chat')}` |
| `call.ts` | `({ q, paid, url })` | `Ссылка: ${url('chat')}` |
| `meetings.ts` | `({ q, paid, url })` | `Ссылка на карточку Zoom: ${url('zoom')}` |
| `networking.ts` | `({ q, paid, url })` | `Ссылка: ${url('networking')}` |
| `images.ts` | `({ q, paid, url })` | `Ссылка: ${url('imageGen')}` |
| `video.ts` | `({ q, paid, url })` | `Ссылка: ${url('video')}` |
| `speech.ts` | `({ q, paid, url })` | `Ссылка на голоса: ${url('voices')}` |
| `studio-assistants.ts` | `({ q, url })` | `Ссылка: ${url('studio')}` |
| `studio-bots.ts` | `({ q, paid, url })` | `Ссылка: ${url('studioBots')}`<br>`Ссылка на карточку Telegram в профиле (привязан ли Telegram): ${url('telegram')}` |
| `profile.ts` | `({ q, url })` | `Ссылка: ${url('profile')}`<br>`Ссылка на настройки: ${url('settings')}` |
| `calendars.ts` | `({ q, url })` | `Ссылка: ${url('calendars')}`<br>`Ссылка на Taler ID: ${url('talerid')}` |
| `routines.ts` | `({ q, paid, url })` | `Ссылка: ${url('routines')}`<br>`Ссылка на уведомления: ${url('push')}` |
| `partners.ts` | `({ q, url })` | `Ссылка: ${url('partners')}` |
| `account.ts` | `({ q, paid, url })` | `Ссылка на способы входа: ${url('loginMethods')}` |
| `apps.ts` | `({ q, paid, nonStore, url })` | `Ссылка на настройки: ${url('settings')}` |
| `support.ts` | `({ q, paid, url })` | `Ссылка: ${url('help')}`<br>`Ссылка на чат поддержки: ${url('support')}` |

(`<br>` в таблице — разделитель двух строк, в файл не пишется.)

Пример — `calendars.ts` после правки, раздел «Где» целиком:

```ts
  render: ({ q, url }) => `
## Что это
Ассистенты видят расписание и предлагают события и дела карточкой; в календарь они попадают только после нажатия пользователя.

## Где
${q('profile')} → ${q('settings')} → ${q('calendars')}; рядом — карточка ${q('talerid')}.
Ссылка: ${url('calendars')}
Ссылка на Taler ID: ${url('talerid')}

## Как
```

Пример — `account.ts`, раздел «Где» целиком:

```ts
## Где
Вход — на my.linkeon.io. Остальное — в ${q('profile')}: в ${q('settings')} — ${q('loginMethods')} и ${q('language')}; ${q('logout')} и ${q('deleteAccount')} — в блоке ${q('account')}.
Ссылка на способы входа: ${url('loginMethods')}
```

Запас по пределу 5120 байт (Б0): самая тесная правка — `chat` (+41 байт при запасе 190) и `account` (+87 при 204), `studio-bots` +192 при 1055. Статью `products` не трогать: её запас 9 байт.

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/platform-kb/articles && git -C $B commit -q -m "platform-kb: ссылка на раздел в «Где» 17 статей — из таблицы адресов, по строке на адрес" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb`. Expected: PASS — и `section-links.spec.ts`, и `kb.spec.ts` (предел 5120 байт, стоп-список: хост `my.linkeon.io` в `HOST_ALLOW`; нет `{{`, нет цифр в статичном тексте), и `products-lifecycle.spec.ts`. tsc бэка — `tsc-ok`.

- [ ] **Step 5: Глазами** (на ноде, вывод — в отчёт)

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/al-back && source ~/.nvm/nvm.sh >/dev/null && npx ts-node -T scripts/render-kb.ts ru web | grep -c '^Ссылка'; npx ts-node -T scripts/render-kb.ts ru store | grep -c '^Ссылка'; npx ts-node -T scripts/render-kb.ts en telegram | grep '^Ссылка' | head -3"
```

Expected: `22`, `21` (в сборке из стора нет статьи о партнёрах), три строки с `https://my.linkeon.io/…`.

---

### Задача Б4: «Интеграции» в описаниях тем; инструмент справки говорит о «Ссылке»

**Files:**
- Modify: `src/platform-kb/articles/calendars.ts:12`, `meetings.ts:13`, `account.ts:15` (`summary`)
- Modify: `src/platform-kb/linkeon-help.ts:88` (описание инструмента)
- Test: `src/platform-kb/section-links.spec.ts`, `src/platform-kb/linkeon-help.spec.ts`

- [ ] **Step 1: Тесты**

В конец `src/platform-kb/section-links.spec.ts`:

```ts
describe('где искать «интеграции»', () => {
  // Человек ищет «интеграции» и «подключения», а раздела с таким именем нет:
  // справку по этим словам находят описания тем (перечень в описании
  // инструмента linkeon_help).
  it('описания тем calendars, meetings и account знают слова «интеграции» и «подключение»', () => {
    const missing = ['calendars', 'meetings', 'account']
      .map((id) => KB_ARTICLES.find((a) => a.id === id)!)
      .filter((a) => !/интеграц/i.test(a.summary) || !/подключ/i.test(a.summary))
      .map((a) => a.id);
    expect(missing).toEqual([]);
  });
});
```

В `src/platform-kb/linkeon-help.spec.ts`, в тест, где проверяется `const d = linkeonHelpTool('web', REG).description;` (там `toMatch(/не по памяти/)`), после строки `expect(d).toMatch(/userId/);` добавить:

```ts
    expect(d).toMatch(/Строка «Ссылка…» в разделе «Где» — полный адрес раздела/);
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/platform-kb/section-links.spec.ts src/platform-kb/linkeon-help.spec.ts && git -C $B commit -q -m "test(platform-kb): «интеграции» в описаниях тем, описание справки — о строке «Ссылка» (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb/section-links.spec.ts src/platform-kb/linkeon-help.spec.ts`. Expected: FAIL — `missing` = `['calendars', 'meetings', 'account']`; в описании справки нет фразы.

- [ ] **Step 3: Описания тем и описание инструмента**

`src/platform-kb/articles/calendars.ts` — заменить строку `summary`:

```ts
  summary: 'календари и интеграции: подключить Яндекс, рабочий Outlook, Google и iCloud по ссылке, Taler ID; карточки событий и дел',
```

`src/platform-kb/articles/meetings.ts`:

```ts
  summary: 'ассистент на онлайн-встрече: площадки, интеграция и подключение Zoom, голосовые комнаты Linkeon',
```

`src/platform-kb/articles/account.ts`:

```ts
  summary: 'аккаунт: способы входа (подключения, интеграции Google и Яндекса), код из SMS, объединение, язык, выход, удаление',
```

Длины — 119, 95 и 113 знаков: сторож `kb.spec.ts` пускает до 120.

`src/platform-kb/linkeon-help.ts`, в `description` после строки

```ts
      'Ответ: articles[] — id, title, text. В text подписи кнопок уже на языке пользователя: называй их дословно, как в «кавычках». ' +
```

добавить

```ts
      'Строка «Ссылка…» в разделе «Где» — полный адрес раздела: дай его человеку рядом с названием раздела. ' +
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/platform-kb && git -C $B commit -q -m "platform-kb: «интеграции» и «подключения» в описаниях тем calendars, meetings, account; справка говорит, что делать со «Ссылкой»" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/platform-kb src/mcp/products-mcp.controller.spec.ts src/support/support-platform.spec.ts`. Expected: PASS. tsc — `tsc-ok`.

---

### Задача Б5: Блок «Что есть в Linkeon» — адреса, правило ссылок, подсказки со ссылкой

**Files:**
- Modify: `src/chat/platform-guide.ts` (целиком, текст ниже)
- Test: `src/chat/platform-guide.spec.ts`

- [ ] **Step 1: Тест**

`src/chat/platform-guide.spec.ts`:

1) Импорт из `./platform-guide` дополнить `linksRule`:

```ts
import {
  customAssistantHelpLine,
  INITIATIVE_RULE,
  linksRule,
  platformGuide,
  platformSections,
  telegramPlatformGuide,
  TOOLS_LIST_NOTE,
} from './platform-guide';
```

2) Под строкой `import { SUPPORTED_LANGUAGES } from '../common/services/language.service';` добавить:

```ts
import { PAID_SECTIONS, SECTION_PATHS, sectionUrl, type SectionKey } from '../platform-kb/section-links';
```

3) В конец файла:

```ts
/**
 * Ссылки на разделы (27.10.2026, находка «Затыков недели» e4f01175): путь
 * словами не помог человеку найти раздел. Адрес каждого раздела — в перечне
 * рядом с названием, правило ссылок — по каналу.
 */
describe('ссылки на разделы', () => {
  const KEYS = Object.keys(SECTION_PATHS) as SectionKey[];

  it.each([...SUPPORTED_LANGUAGES])('%s: у каждого раздела таблицы — свой адрес рядом с названием', (lang) => {
    const s = platformSections(lang);
    expect(KEYS.filter((k) => !s.includes(`${sectionUrl(k)})`))).toEqual([]);
  });

  it('стор: без адресов разделов о деньгах, остальные на месте', () => {
    const s = platformSections('ru', { store: true });
    for (const k of KEYS) {
      if (PAID_SECTIONS.includes(k)) expect(s).not.toContain(sectionUrl(k));
      else expect(s).toContain(`${sectionUrl(k)})`);
    }
  });

  it('раздела «Интеграции» нет — перечень говорит, где подключения', () => {
    const s = flat(platformSections('ru'));
    expect(s).toMatch(/Отдельного раздела интеграций нет/);
    expect(s).toContain(sectionUrl('telegram'));
    for (const label of ['«Zoom»', '«Экосистема Taler ID»', '«Календари»', '«Способы входа»']) {
      expect(s).toContain(label);
    }
  });

  it('веб и приложения: ссылка рядом с названием, можно markdown; путь по меню — в дополнение', () => {
    const g = platformGuide('ru', { helpTool: HELP, initiative: true });
    expect(g).toContain(linksRule('markdown'));
    expect(g).not.toContain(linksRule('plain'));
    const r = flat(linksRule('markdown'));
    expect(r).toMatch(/рядом с его названием/);
    expect(r).toMatch(/markdown-ссылкой \[название\]\(адрес\)/);
    expect(r).toMatch(/Путь по меню — только в дополнение к ссылке/);
    expect(r).toMatch(/Других адресов кабинета не придумывай/);
  });

  it('Telegram: только полный адрес, без markdown', () => {
    const g = telegramPlatformGuide('ru', { helpTool: HELP });
    expect(g).toContain(linksRule('plain'));
    expect(g).not.toContain(linksRule('markdown'));
    expect(flat(linksRule('plain'))).toMatch(/только сам полный адрес, начиная с https:\/\//);
    expect(flat(linksRule('plain'))).toMatch(/без markdown/);
  });

  it('подсказка по Linkeon — со ссылкой на раздел, а не с путём по меню', () => {
    expect(flat(INITIATIVE_RULE)).toMatch(/одной фразой со ссылкой на её раздел/);
    expect(INITIATIVE_RULE).not.toMatch(/точным путём по меню/);
  });
});
```

`HELP` и `flat` уже объявлены выше в этом файле.

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/chat/platform-guide.spec.ts && git -C $B commit -q -m "test(chat): адреса разделов в блоке «Что есть в Linkeon», правило ссылок по каналу (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/chat/platform-guide.spec.ts`. Expected: FAIL — новый `describe` целиком (`linksRule is not a function`, адресов в перечне нет); прежние тесты PASS.

- [ ] **Step 3: platform-guide.ts**

`src/chat/platform-guide.ts` — заменить файл целиком:

```ts
import { labelsFor } from '../platform-kb/labels';
import type { KbLabels } from '../platform-kb/labels';
import { sectionUrl } from '../platform-kb/section-links';

/**
 * Блок «Что есть в Linkeon» для системного промпта ассистента.
 *
 * Аудит 12.10.2026: свои инструменты ассистенты знали из промпта релея, а саму
 * платформу — нет. На «где создать сайт», «можно ли поговорить голосом», «как
 * подключить календарь» им оставалось гадать, и Кира, например, обещала
 * собрать сайт прямо в чате — хотя продукт заводится и в Студии, и ассистентом
 * — инструментом manage_product.
 *
 * Разделы названы подписями, которые пользователь видит на своём языке: иначе
 * ассистент переводит «Студию» сам и называет пункт меню, которого нет.
 * Подписи берутся из общей таблицы справки (src/platform-kb/labels.ts),
 * которую собирает из локалей фронта scripts/sync-kb-labels.mjs.
 *
 * У каждого раздела — его адрес (27.10.2026, находка «Затыков недели»
 * e4f01175: путь словами — «в интеграциях» — не помог человеку найти раздел).
 * Адреса — из таблицы src/platform-kb/section-links.ts, той же, что у справки;
 * давать их рядом с названием велит linksRule. Они в постоянном блоке, а не
 * только в справке: иначе каждое «где это?» и каждая подсказка стоили бы
 * лишнего вызова справки, а блок стабилен и кэшируется вместе с остальной
 * стабильной частью промпта.
 *
 * Пополнения и оплаты здесь нет намеренно: это дело блока баланса
 * (balance-context.service.ts), а он знает про сборки для сторов, которым
 * ссылки на оплату показывать нельзя.
 */

export interface PlatformGuideOpts {
  /** Полное имя инструмента справки. Без него — прежнее вступление: там, где инструмента нет. */
  helpTool?: string;
  /** Сборка из стора: без партнёрской программы. */
  store?: boolean;
  /** Правило инициативы — штатным ассистентам и боту в ходе владельца. */
  initiative?: boolean;
}

/**
 * Правило инициативы. Решение владельца 24.10.2026: ассистент сам предлагает
 * функцию, когда она прямо решает текущую задачу, — одной фразой и без повтора
 * отклонённого. Своим ассистентам пользователей и группам Telegram с
 * посторонними его не даём: там подсказка читалась бы чужой рекламой.
 * С 27.10.2026 — со ссылкой на раздел, а не с путём по меню (linksRule).
 */
export const INITIATIVE_RULE =
  'ПОДСКАЗКИ ПО LINKEON. Если функция Linkeon прямо решает задачу, над которой вы сейчас работаете, — ' +
  'предложи её одной фразой со ссылкой на её раздел, после ответа по сути, а не вместо него. ' +
  'Не чаще одного раза за тему. Отказался или уже пользуется — не повторяй. ' +
  'В кризисной ситуации не предлагай ничего.';

/** Как пользоваться справкой: подробности — только из неё, она главнее персоны, нет ответа — поддержка. */
function helpRule(l: KbLabels, tool: string): string {
  return (
    `Подробности — как сделать, лимиты, цены, что делать, если не работает, как устроено, — бери из инструмента ${tool}, ` +
    'а не по памяти: функции и цены меняются. По фактам о платформе справка главнее того, что о платформе сказано ' +
    `в твоей персоне. Справка не дала ответа — скажи, что не знаешь, и предложи «${l.support}» в разделе «${l.help}».`
  );
}

/**
 * Как давать ссылку на раздел. Два вида — по тому, как канал показывает ответ:
 *   markdown — веб-чат и приложения рисуют [текст](адрес) ссылкой;
 *   plain — Telegram (бот шлёт простой текст без parse_mode: нажимается
 *     только полный https-адрес, а «/profile» бот примет за команду) и
 *     ИИ-поддержка (кабинет показывает её ответы простым текстом и делает
 *     ссылкой только сам адрес — markdown остался бы на экране скобками).
 * Фигурных скобок в тексте нет: блок их не терпит (platform-guide.spec.ts).
 */
export function linksRule(format: 'markdown' | 'plain'): string {
  const how =
    format === 'markdown'
      ? 'можно markdown-ссылкой [название](адрес)'
      : 'только сам полный адрес, начиная с https://, без markdown и без знаков препинания вплотную после него: ' +
        'здесь нажимается только такой адрес';
  return (
    'ССЫЛКИ НА РАЗДЕЛЫ. Показываешь, где что находится в кабинете, — дай ссылку на раздел рядом с его названием: ' +
    `адрес из перечня выше или из справки (строка «Ссылка…» в разделе «Где»), ${how}. ` +
    'Путь по меню — только в дополнение к ссылке. Других адресов кабинета не придумывай.'
  );
}

/** Блок для системного промпта ассистента. */
export function platformGuide(lang: string, opts: PlatformGuideOpts = {}): string {
  const l = labelsFor(lang);
  const intro =
    'Если спрашивают, что ещё есть на платформе, где что найти или как сделать то, что делается не в разговоре, — ' +
    'отвечай по этому списку. Разделы и кнопки называй так, как они подписаны у пользователя: в кавычках ниже. ' +
    (opts.helpTool
      ? helpRule(l, opts.helpTool)
      : `Чего в списке нет, не выдумывай: скажи, что не знаешь, и предложи «${l.support}» в разделе «${l.help}».`);
  return [
    '--- ЧТО ЕСТЬ В LINKEON ---',
    intro,
    platformSections(lang, { store: opts.store }),
    // Веб-чат, Маша и приложения рисуют markdown — ссылка может быть текстом.
    linksRule('markdown'),
    ...(opts.initiative ? [INITIATIVE_RULE] : []),
  ].join('\n');
}

/**
 * Перечень разделов без вступления. Его же берёт ИИ-поддержка
 * (support.service.ts): совет «предложи связаться с поддержкой» ей ни к чему.
 * store — без партнёрской программы: она про деньги, а в сборке из стора о
 * деньгах молчим (справка там не отдаёт тему partners).
 *
 * Адрес раздела — в скобках сразу за названием, и за ним всегда «)»: по этой
 * скобке тест отличает /profile от /profile?open=… .
 */
export function platformSections(lang: string, opts: { store?: boolean } = {}): string {
  const l = labelsFor(lang);
  const u = sectionUrl;
  const partners = opts.store ? '' : ` — и «${l.partners}» с «${l.invite}» (${u('partners')})`;
  return [
    `• «${l.chat}» (${u('chat')}) — разговоры с ассистентами. Под ответом ассистента — «${l.listen}»: ответ голосом. ` +
      `«${l.fresh}» — разговор без прошлой истории. «${l.files}» — картинки, видео и файлы этого разговора. ` +
      'Файл к сообщению прикладывается кнопкой «+».',
    `• «${l.call}» (кнопка со значком телефона) — голосовой звонок. В звонке отвечает только Роман.`,
    '• Ссылку на онлайн-встречу можно прислать в чат: если площадка поддерживается, появится карточка ' +
      `с кнопкой «${l.meetingJoin}», и по ней ассистент придёт на встречу. Чтобы ассистент заходил и на чужие ` +
      `встречи в Zoom, в «${l.settings}» подключается «${l.zoom}» (${u('zoom')}).`,
    `• «${l.networking}» (${u('networking')}) — поиск людей по ценностям и навыкам, проверка совместимости, ` +
      'запросы на общение и чаты с другими пользователями.',
    `• «${l.imageGen}» (${u('imageGen')}) и «${l.video}» (${u('video')}) — отдельные разделы для картинок и роликов.`,
    `• «${l.studio}» (${u('studio')}): «${l.studioAgents}» — свои ассистенты со своими инструкциями; ` +
      `«${l.studioBots}» (${u('studioBots')}) — бот с ассистентом для Telegram-группы пользователя; ` +
      `«${l.studioProducts}» (${u('studioProducts')}) — свой сайт или Telegram-бот, который Linkeon размещает ` +
      'и дорабатывает по просьбам обычными словами. Создать, удалить или вернуть продукт можно и попросив ассистента в чате.',
    `• «${l.profile}» (${u('profile')}) — ценности, интересы и навыки (собираются сами из разговоров) и «${l.business}» — ` +
      `что ассистенты знают о деле пользователя. Там же «${l.settings}» (${u('settings')}) — «${l.calendars}» (Яндекс, ` +
      `рабочий Outlook, Google и iCloud по ссылке; ${u('calendars')}), «${l.zoom}» (${u('zoom')}), ` +
      `«${l.talerid}» (${u('talerid')}), «${l.push}» (${u('push')}), «${l.routines}» (${u('routines')}), ` +
      `«${l.voices}» (${u('voices')}), «${l.loginMethods}» (${u('loginMethods')}), ` +
      // Сборки из App Store/Google Play (store) ставятся самим стором — решение
      // владельца 25.10.2026: установку файлом (APK) им не упоминаем вовсе.
      `язык, приватность, «${l.android}»${opts.store ? '' : ' (Android, установка файлом)'}${partners}.`,
    // Человек ищет «интеграции» — так в кабинете ничего не называется.
    `• Отдельного раздела интеграций нет: подключения сервисов — карточки в «${l.settings}» (календари, Zoom, ` +
      `Taler ID, способы входа), а привязка Telegram — карточка в «${l.profile}» (${u('telegram')}).`,
    '• Linkeon открывается и внутри Telegram — как мини-приложение.',
    `• «${l.help}» (${u('help')}) — краткая инструкция, частые вопросы и «${l.support}» (${u('support')}).`,
  ].join('\n');
}

/**
 * Свой ассистент пользователя: ни карты, ни инициативы — персону написал
 * пользователь, и вставки о платформе были бы в ней чужими. Только справка,
 * когда спросили о самой платформе.
 */
export function customAssistantHelpLine(tool: string): string {
  return (
    'Ты работаешь на платформе Linkeon. Если спрашивают о самой платформе — как что сделать, сколько стоит, ' +
    `что делать, если не работает, — отвечай по инструменту ${tool}, не по памяти.`
  );
}

/**
 * Блок для Telegram-бота со штатным ассистентом (tg-bot/tg-router.service.ts).
 * Кабинет назван адресом: в группе бывают люди, которые Linkeon не видели.
 * В Telegram нет файлов на выдачу, кода, календаря, рутин и звонка — в веб-чате
 * они есть. Озвучка есть и там (голосовые ответы бота), её в список не ставим.
 * helpTool — справка есть в ходе; initiative — только в ходе владельца.
 * Ссылки — только полным адресом (linksRule('plain')): бот шлёт простой текст.
 */
export function telegramPlatformGuide(lang: string, opts: { helpTool?: string; initiative?: boolean } = {}): string {
  const l = labelsFor(lang);
  return [
    '--- LINKEON ---',
    'Этот бот — ассистент Linkeon. У Linkeon есть веб-кабинет my.linkeon.io. Если спрашивают, что это за бот, что ещё ' +
      'умеет Linkeon или где сделать то, чего нет в этом чате, — отвечай по списку разделов кабинета ниже и называй их ' +
      'так, как они подписаны (в кавычках). Чего в списке нет, не выдумывай.',
    platformSections(lang),
    linksRule('plain'),
    'В веб-чате Linkeon у ассистентов больше инструментов, чем здесь: документы и таблицы файлами, расчёты кодом, ' +
      'календарь, регулярные сообщения и голосовой звонок. Просят то, чего в этом чате нет, — так и скажи и предложи ' +
      'сделать это в веб-чате.',
    `Такой же бот для своей Telegram-группы заводится в «${l.studio}» → «${l.studioBots}».`,
    ...(opts.helpTool ? [helpRule(l, opts.helpTool)] : []),
    ...(opts.initiative ? [INITIATIVE_RULE] : []),
  ].join('\n');
}

/**
 * Только ассистентам релея: инструменты им перечисляет системный промпт
 * релея, а раздел «ИНСТРУМЕНТЫ» в персоне из БД называет два-три из них —
 * и читается как полный список. У Маши инструментов релея нет, ей не нужна.
 */
export const TOOLS_LIST_NOTE =
  'Твои инструменты перечислены в системных инструкциях выше. Раздел «ИНСТРУМЕНТЫ» в твоей персоне, ' +
  'если он есть, называет самое полезное для твоей работы, а не всё, что у тебя есть.';
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/chat/platform-guide.ts && git -C $B commit -q -m "chat: адреса разделов в блоке «Что есть в Linkeon», правило ссылок по каналу, подсказки — со ссылкой на раздел" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/chat/platform-guide.spec.ts src/tg-bot/tg-router.platform.spec.ts src/tg-bot/tg-bot.products-tool.spec.ts src/chat/chat.service.help-fields.spec.ts src/chat/chat.service.masha-products.spec.ts src/chat/chat.service.masha-prompt.spec.ts src/support/support-platform.spec.ts`. Expected: PASS. Прежние тесты держат подписи, отсутствие `{`/`}`, `view=tokens` и слов об оплате, стор без партнёров и APK. tsc — `tsc-ok`.

---

### Задача Б6: ИИ-поддержка — то же правило ссылок, только адресом

**Files:**
- Modify: `src/support/support.service.ts:23` (импорт), `:497-501` (промпт)
- Test: `src/support/support-platform.spec.ts`

- [ ] **Step 1: Тест**

`src/support/support-platform.spec.ts`:

1) Импорт `import { platformSections } from '../chat/platform-guide';` заменить на:

```ts
import { linksRule, platformSections } from '../chat/platform-guide';
```

2) В конец `describe('ИИ-поддержка знает разделы платформы', …)`, перед его закрывающей `});`:

```ts
  // Ответы поддержки кабинет показывает простым текстом и делает ссылкой
  // только сам адрес (SupportView, linkify): markdown остался бы скобками.
  it('ссылки на разделы — полным адресом, без markdown', () => {
    const p = prompt({ language: 'ru' });
    expect(p).toContain(linksRule('plain'));
    expect(p).not.toContain(linksRule('markdown'));
    expect(p).toContain('https://my.linkeon.io/profile?open=zoom');
  });
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/support/support-platform.spec.ts && git -C $B commit -q -m "test(support): правило ссылок — полным адресом (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/support/support-platform.spec.ts`. Expected: FAIL — нет `linksRule('plain')` в промпте. Адрес Zoom уже есть: он пришёл с перечнем в Б5.

- [ ] **Step 3: Промпт поддержки**

`src/support/support.service.ts`:

1) Строку `import { platformSections } from '../chat/platform-guide';` заменить на:

```ts
import { linksRule, platformSections } from '../chat/platform-guide';
```

2) В `buildSystemPrompt`, перед `// Язык ответа больше не зашит. …` (комментарий над `return`), добавить:

```ts
    // Ссылки на разделы — полным адресом (linksRule('plain')): ответы
    // поддержки кабинет показывает простым текстом и делает ссылкой только
    // сам адрес (SupportView); markdown-ссылка осталась бы на экране скобками.
```

3) В шаблоне промпта заменить строку

```ts
${platformSections(lang, { store: opts.storeBuild })}
```

на две строки:

```ts
${platformSections(lang, { store: opts.storeBuild })}
${linksRule('plain')}
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/support/support.service.ts && git -C $B commit -q -m "support: ИИ-поддержка даёт ссылки на разделы полным адресом" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/support`. Expected: PASS. tsc — `tsc-ok`.

---

### Задача Б7: «Коллеги» — мягкая переадресация узких специалистов

**Files:**
- Create: `src/chat/colleagues-rule.ts`
- Modify: `src/chat/chat.service.ts:21` (импорт), `:716-719` (блок коллег релея), `:1072-1084` (путь Маши)
- Test: `src/chat/colleagues-rule.spec.ts` (новый), `src/chat/chat.service.masha-prompt.spec.ts` (новый `describe` в конце)

- [ ] **Step 1: Тесты**

`src/chat/colleagues-rule.spec.ts`:

```ts
import { ChatService } from './chat.service';
import { COLLEAGUES_RULE_GENERAL, COLLEAGUES_RULE_NARROW, colleaguesRule } from './colleagues-rule';

/**
 * Блок «Коллеги-ассистенты»: что делать с просьбой из чужой области.
 *
 * Находка «Затыков недели» 19–25.10.2026 (2c97fc26): узкие ассистенты брались
 * за вопросы чужой области вместо переадресации. Решение владельца 27.10.2026:
 * мягкая переадресация для категорий personal и business; Роману (assistant)
 * и своим ассистентам пользователей — как было.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('правило о чужой области', () => {
  it.each(['personal', 'business'])('%s — мягкая переадресация', (category) => {
    expect(colleaguesRule(category)).toBe(COLLEAGUES_RULE_NARROW);
  });

  it.each(['assistant', '', 'custom'])('«%s» — прежняя строка', (category) => {
    expect(colleaguesRule(category)).toBe(COLLEAGUES_RULE_GENERAL);
  });

  it('без категории — прежняя строка', () => {
    expect(colleaguesRule(null)).toBe(COLLEAGUES_RULE_GENERAL);
    expect(colleaguesRule(undefined)).toBe(COLLEAGUES_RULE_GENERAL);
  });

  it('прежняя строка — слово в слово та, что была у всех до 27.10', () => {
    expect(COLLEAGUES_RULE_GENERAL).toBe(
      'Если пользователь спрашивает про кого-то из них или просит сделать что-то по их специализации — расскажи про коллегу честно, без выдумок, и предложи переключиться на него.',
    );
  });

  it('узкому: сначала предложить коллегу и переключение; остаётся — помогать самому', () => {
    const t = flat(COLLEAGUES_RULE_NARROW);
    expect(t).toMatch(/Просьба целиком в области коллеги — сначала предложи его/);
    expect(t).toMatch(/Переключиться\?/);
    expect(t).toMatch(/Хочет остаться с тобой — помогай сам/);
  });

  it('узкому: общий вопрос — коротко и назвать, кто разберёт подробнее', () => {
    expect(flat(COLLEAGUES_RULE_NARROW)).toMatch(
      /Общий вопрос, который задевает чужую область, — ответь коротко и назови, кто из коллег разберёт подробнее/,
    );
  });

  it('узкому: о самой платформе — по справке, никого не предлагая', () => {
    expect(flat(COLLEAGUES_RULE_NARROW)).toMatch(/о самой платформе Linkeon — отвечай сам, по справке, никого не предлагая/);
  });

  it('пример — без имени живого коллеги: иначе его предлагали бы всем', () => {
    expect(COLLEAGUES_RULE_NARROW).toContain('<коллеге>');
  });
});

describe('блок «Коллеги» в промпте релея', () => {
  function service() {
    const pg = {
      query: jest.fn(async (sql: string) =>
        /FROM agents a\s+LEFT JOIN agent_translations/.test(sql)
          ? { rows: [{ display_name: 'Оля', description: 'Исследование ценностей' }] }
          : { rows: [] },
      ),
    };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    return new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
  }
  const prefix = (agentId: string, agentCategory: string | null): Promise<string> =>
    (service() as any).buildRelayStablePrefix({
      agentId,
      agentName: 'Дмитрий',
      agentDescription: '',
      agentSystemPrompt: 'Ты ассистент.',
      agentCategory,
      userId: 'u1',
      userLanguage: 'ru',
    });

  it('бизнес-специалисту (Дмитрий, id 19) — мягкая переадресация', async () => {
    const p = await prefix('19', 'business');
    expect(p).toContain(COLLEAGUES_RULE_NARROW);
    expect(p).not.toContain(COLLEAGUES_RULE_GENERAL);
  });

  it('личному (personal) — тоже', async () => {
    expect(await prefix('2', 'personal')).toContain(COLLEAGUES_RULE_NARROW);
  });

  it('Роману (assistant, id 12) — прежняя строка', async () => {
    const p = await prefix('12', 'assistant');
    expect(p).toContain(COLLEAGUES_RULE_GENERAL);
    expect(p).not.toContain(COLLEAGUES_RULE_NARROW);
  });

  it('правило — в блоке коллег, сразу после списка', async () => {
    const p = await prefix('19', 'business');
    const head = p.indexOf('--- Коллеги-ассистенты в Linkeon ---');
    const line = p.indexOf('• Оля — Исследование ценностей', head);
    expect(head).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(head);
    expect(p.indexOf(COLLEAGUES_RULE_NARROW, head)).toBeGreaterThan(line);
  });

  it('своему ассистенту — ни блока, ни правила', async () => {
    const p = await prefix('custom:6f1c2b9e-0000-4000-8000-000000000000', null);
    expect(p).not.toContain('Коллеги-ассистенты');
    expect(p).not.toContain(COLLEAGUES_RULE_NARROW);
    expect(p).not.toContain(COLLEAGUES_RULE_GENERAL);
  });
});
```

`src/chat/chat.service.masha-prompt.spec.ts`:

1) Под строкой `import { LINKEON_HELP_CLI_TOOL_NAME } from '../products/products-cli-tool';` добавить:

```ts
import { COLLEAGUES_RULE_GENERAL, COLLEAGUES_RULE_NARROW } from './colleagues-rule';
```

2) В самый конец файла (новым верхнеуровневым `describe`; функция `mashaSystemPrompt` объявлена в модуле выше):

```ts
describe('системный промпт Маши: чужая область', () => {
  it('Маше (personal) — мягкая переадресация, сразу после списка коллег', async () => {
    const { system } = await mashaSystemPrompt();
    expect(system).toContain(COLLEAGUES_RULE_NARROW);
    expect(system).not.toContain(COLLEAGUES_RULE_GENERAL);
    expect(system.indexOf(COLLEAGUES_RULE_NARROW)).toBeGreaterThan(system.indexOf('Другие ассистенты:'));
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/chat/colleagues-rule.spec.ts src/chat/chat.service.masha-prompt.spec.ts && git -C $B commit -q -m "test(chat): «Коллеги» — мягкая переадресация узких специалистов, Роману как было (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/chat/colleagues-rule.spec.ts src/chat/chat.service.masha-prompt.spec.ts`. Expected: FAIL — `Cannot find module './colleagues-rule'` в обоих наборах.

- [ ] **Step 3: Правило и проводка**

`src/chat/colleagues-rule.ts`:

```ts
/**
 * Что ассистенту делать с просьбой из области коллеги — последняя строка
 * блока «Коллеги-ассистенты» в системном промпте (chat.service.ts:
 * buildRelayStablePrefix и путь Маши).
 *
 * Находка «Затыков недели» 19–25.10.2026 (2c97fc26): узкие ассистенты брались
 * за вопросы чужой области вместо того, чтобы предложить коллегу. Прежняя
 * строка говорила «предложи переключиться», но не говорила, что делать, пока
 * человек не ответил, и была одна на всех — и на узких специалистов, и на
 * Романа.
 *
 * Решение владельца 27.10.2026:
 *   • узким специалистам (категории personal и business) — мягкая
 *     переадресация: сначала предложить коллегу и переключение, делать
 *     самому — если человек хочет остаться; общий вопрос — коротко ответить и
 *     назвать, кто разберёт подробнее; о самой платформе — по справке, никого
 *     не предлагая;
 *   • Роману (категория assistant — универсал, «делаю всё, что не могут
 *     другие») и ассистентам без категории — прежняя строка слово в слово;
 *   • своим ассистентам пользователей блока коллег нет вовсе (так было и
 *     раньше, buildRelayStablePrefix).
 *
 * Пример в правиле — без имени живого коллеги: с конкретным именем модель
 * предлагала бы именно его на любую чужую просьбу. Правило написано
 * по-русски, как и остальные блоки промпта: отвечает модель на языке
 * пользователя — это обеспечивает языковая директива.
 */
const NARROW_CATEGORIES: readonly string[] = ['personal', 'business'];

/** Прежняя строка блока — универсалу и ассистентам без категории. */
export const COLLEAGUES_RULE_GENERAL =
  'Если пользователь спрашивает про кого-то из них или просит сделать что-то по их специализации — ' +
  'расскажи про коллегу честно, без выдумок, и предложи переключиться на него.';

/** Узкому специалисту — мягкая переадресация. */
export const COLLEAGUES_RULE_NARROW =
  'Просьба целиком в области коллеги — сначала предложи его: кто это и чем поможет, и спроси, переключиться ли, ' +
  'например: «Это скорее к <коллеге> — <чем он поможет>. Переключиться? Могу и сам набросать черновик». ' +
  'Хочет остаться с тобой — помогай сам, без повторных уговоров. ' +
  'Общий вопрос, который задевает чужую область, — ответь коротко и назови, кто из коллег разберёт подробнее. ' +
  'Вопросы о самой платформе Linkeon — отвечай сам, по справке, никого не предлагая. ' +
  'Про коллег рассказывай честно, без выдумок.';

/** Строка для блока «Коллеги» по категории ассистента (agents.category). */
export function colleaguesRule(category: string | null | undefined): string {
  return NARROW_CATEGORIES.includes(String(category ?? '')) ? COLLEAGUES_RULE_NARROW : COLLEAGUES_RULE_GENERAL;
}
```

`src/chat/chat.service.ts`:

1) Под строкой `import { loadCoworkers } from './coworkers';` добавить:

```ts
import { colleaguesRule } from './colleagues-rule';
```

2) В `buildRelayStablePrefix` заменить

```ts
          stablePrefix +=
            `--- Коллеги-ассистенты в Linkeon ---\n` +
            `${lines}\n\n` +
            `Если пользователь спрашивает про кого-то из них или просит сделать что-то по их специализации — расскажи про коллегу честно, без выдумок, и предложи переключиться на него.\n\n`;
```

на

```ts
          // Что делать с просьбой из чужой области — по категории ассистента:
          // узким специалистам мягкая переадресация, Роману прежняя строка
          // (colleagues-rule.ts, решение владельца 27.10.2026).
          stablePrefix +=
            `--- Коллеги-ассистенты в Linkeon ---\n` +
            `${lines}\n\n` +
            `${colleaguesRule(opts.agentCategory)}\n\n`;
```

3) В пути Маши: в комментарий над `const otherAgents = …` («Коллеги — тем же запросом, что у релея (coworkers.ts) …») дописать последней строкой:

```ts
    // Что делать с чужой областью — то же правило, что у релея (colleagues-rule.ts).
```

и в шаблоне `platformContext` заменить строку

```
Ты — в чате с ассистентами. Другие ассистенты: ${otherAgents}. Предложи переключиться в левом верхнем углу.
```

на две строки

```
Ты — в чате с ассистентами. Другие ассистенты: ${otherAgents}. Предложи переключиться в левом верхнем углу.
${colleaguesRule(agent.category)}
```

Первая строка остаётся дословно: по ней сторож `chat.service.masha-prompt.spec.ts` вынимает список коллег (`/Другие ассистенты: (.*?)\. Предложи переключиться/`).

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/chat/colleagues-rule.ts src/chat/chat.service.ts && git -C $B commit -q -m "chat: «Коллеги» — мягкая переадресация для personal и business, Роману и своим ассистентам как было" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/chat/colleagues-rule.spec.ts src/chat/chat.service.masha-prompt.spec.ts src/chat/coworkers.spec.ts src/chat/platform-guide.spec.ts src/chat/chat.service.help-fields.spec.ts`. Expected: PASS. tsc — `tsc-ok`.

---

### Задача Б8: Возврат от Zoom — на карточку Zoom (попутно)

**Files:**
- Modify: `src/zoom/zoom.controller.ts:47-48` (адрес возврата)
- Test: `src/zoom/zoom.controller.spec.ts` (новый)

Независимая задача (решение плана 15): без неё всё остальное работает, с ней человек после согласия в Zoom попадает на свою карточку и видит исход. Фронт уже готов: карточка Zoom читает `zoom_connect` и сама убирает его из адреса (ZoomConnectCard.tsx:32-45). Пока фронт не выкачен, старый кабинет откроет профиль со свёрнутыми настройками, и пометка не покажется — как и сегодня.

- [ ] **Step 1: Тест**

`src/zoom/zoom.controller.spec.ts`:

```ts
import { ZoomController } from './zoom.controller';

/**
 * Возврат от Zoom ведёт на карточку Zoom в профиле с пометкой исхода
 * (/profile?open=zoom&zoom_connect=…): кабинет раскрывает «Настройки» и
 * прокручивает к карточке, а та показывает исход. Раньше — на корень, откуда
 * кабинет уводил в чат и пометку терял (RootRedirect переносит только
 * ?assistant=): человек не видел ни «подключено», ни «отказались».
 */
describe('возврат от Zoom', () => {
  const saved = process.env.PUBLIC_BASE_URL;
  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = 'https://my.linkeon.io';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = saved;
  });

  function run(o: { error?: string; userId?: string | null; ok?: boolean } = {}) {
    const oauth = {
      claimState: jest.fn(async () => (o.userId === undefined ? 'u-1' : o.userId)),
      complete: jest.fn(async () => o.ok ?? true),
    };
    const res = { redirect: jest.fn() };
    const done = new ZoomController(oauth as any).callback('code', 'state', o.error as any, res as any);
    return { done, res, oauth };
  }

  it('успех — на карточку Zoom с пометкой ok', async () => {
    const { done, res } = run();
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=ok');
  });

  it('человек отказался — denied, код не обменивается', async () => {
    const { done, res, oauth } = run({ error: 'access_denied' });
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=denied');
    expect(oauth.complete).not.toHaveBeenCalled();
  });

  it('протухший state — expired', async () => {
    const { done, res } = run({ userId: null });
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=expired');
  });

  it('обмен не удался — failed', async () => {
    const { done, res } = run({ ok: false });
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=failed');
  });

  it('слэш в конце базового адреса не удваивается', async () => {
    process.env.PUBLIC_BASE_URL = 'https://test.linkeon.io/';
    const { done, res } = run();
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://test.linkeon.io/profile?open=zoom&zoom_connect=ok');
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/zoom/zoom.controller.spec.ts && git -C $B commit -q -m "test(zoom): возврат от Zoom — на карточку Zoom с исходом (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/zoom/zoom.controller.spec.ts`. Expected: FAIL — redirect на `https://my.linkeon.io/?zoom_connect=ok`.

- [ ] **Step 3: Адрес возврата**

`src/zoom/zoom.controller.ts`, в `callback` заменить

```ts
    const back = (status: string) => res.redirect(`${base}/?zoom_connect=${status}`);
```

на

```ts
    // Назад — на саму карточку Zoom в профиле (/profile?open=zoom: кабинет
    // раскрывает «Настройки» и прокручивает к ней), а не на корень: корень
    // уводил в чат и терял пометку исхода — ни «подключено», ни «отказались»
    // человек не видел (RootRedirect переносит только ?assistant=).
    const back = (status: string) => res.redirect(`${base}/profile?open=zoom&zoom_connect=${status}`);
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/zoom/zoom.controller.ts && git -C $B commit -q -m "zoom: возврат от Zoom ведёт на карточку Zoom в профиле — исход виден" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, бэк): `src/zoom`. Expected: PASS. tsc — `tsc-ok`.

---

### Задача Б9: Итоговый прогон бэка

**Files:** ничего не меняется (если прогон что-то нашёл — правка отдельным коммитом).

- [ ] **Step 1: tsc и тесты против базы Б0**

```bash
B=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links
git -C $B push -q origin HEAD:refs/heads/feat/assistant-links
SHA=$(git -C $B rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/al-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && npx tsc -p tsconfig.build.json --noEmit && echo tsc-ok && npx jest --runInBand src/platform-kb src/chat src/support src/tg-bot src/zoom src/mcp/relay-products-tools.spec.ts src/products/products-cli-tool.spec.ts 2>&1 | grep -E '^Tests:|^Test Suites:|^FAIL'"
```

Expected: `tsc-ok`; PASS = база Б0 + новые наборы и тесты; FAIL — не больше, чем в базе, и не в файлах этого плана.

- [ ] **Step 2: Отчёт** — числа (база → итог) и `SHA`.

---

## Трек 3. Релей (`spirits_back`, ветка `feat/assistant-links-relay`)

### Задача Р0: Ветка, воркдерево, CI-клон, база

**Files:** в репозитории ничего не меняется.

- [ ] **Step 1: Воркдерево от `origin/main`**

```bash
git -C /Users/dmitry/Downloads/spirits_back fetch -q origin
git -C /Users/dmitry/Downloads/spirits_back worktree add -q -b feat/assistant-links-relay /Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links-relay origin/main
R=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links-relay
git -C $R branch --show-current && git -C $R log --oneline -1
git -C $R push -q -u origin HEAD:refs/heads/feat/assistant-links-relay
```

Expected: `feat/assistant-links-relay` и `407c097e Merge feat/prompt-secrets…` (или новее — записать sha).

- [ ] **Step 2: CI-воркдерево**

```bash
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/al-relay origin/feat/assistant-links-relay && cd ~/ci/wt/al-relay && source ~/.nvm/nvm.sh >/dev/null && npm ci --no-audit --no-fund >/dev/null && echo relay-ok'
```

Expected: `relay-ok`.

- [ ] **Step 3: База — прежние сторожа релея зелёные, синтаксис цел**

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/al-relay && source ~/.nvm/nvm.sh >/dev/null && node --check relay-agent/server.mjs && echo syntax-ok && npx jest --runInBand src/chat/relay-help-guard.spec.ts src/chat/relay-linkeon-guard.spec.ts src/chat/relay-order-guard.spec.ts src/chat/relay-products-keys-guard.spec.ts src/mcp/relay-products-tools.spec.ts src/products/products-cli-tool.spec.ts 2>&1 | grep -E '^(PASS|FAIL)|Tests:'"
```

Expected: `syntax-ok`, все наборы PASS.

---

### Задача Р1: Правила 4 и 9 и «ПРОВЕРКА ФАКТОВ» — сторож и текст

**Files:**
- Modify: `relay-agent/server.mjs:51` (комментарий над `SYSTEM_PROMPT`), `:65-67` (абзац «ПРОВЕРКА ФАКТОВ» между «УТОЧНЯЮЩИЕ ВОПРОСЫ» и «ЯЗЫК (ВАЖНО)»), `:103` (правило 4), `:108` (правило 9)
- Test: `src/chat/relay-rules-guard.spec.ts` (новый)

Правка — только текст внутри шаблона `SYSTEM_PROMPT` и комментарий над ним. Ни одной строки кода релея. В тексте нет обратных кавычек и `${` (шаблонная строка). Правила 1–3, 5–8, 10, 11 и все остальные блоки не трогать.

- [ ] **Step 1: Тест**

`src/chat/relay-rules-guard.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Правила SYSTEM_PROMPT релея о ссылках, источниках и файлах — спека
 * docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md,
 * п. 3 (решение владельца 27.10.2026). Копия в relay-agent/ — то, что
 * выкатывается на релей; сторож держит обещания текста:
 *   • правило 9: запрет — только на пути файлов и внутренние адреса; ссылки на
 *     разделы my.linkeon.io и на страницы, открытые в этом ходе, можно;
 *     картинки инструментов — по-прежнему ![](url);
 *   • «файлы прикреплены ниже» — только про файлы, сохранённые в этом ходе;
 *   • правило 7 (адреса созданных файлов не печатать) — на месте;
 *   • «ПРОВЕРКА ФАКТОВ»: факт из внешнего источника — со ссылкой и тем, что
 *     видно; «не нашёл» — не «не существует»;
 *   • правило 4: картинки в pptx — по смыслу своего слайда, вопрос, перечень.
 */
const src = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');
const SYS_START = src.indexOf('const SYSTEM_PROMPT = `');
const system = src.slice(SYS_START, src.indexOf('`;', SYS_START));
const rules = system.slice(system.indexOf('\nRULES:\n'), system.indexOf('\nRECURRING / ROUTINE REQUESTS'));
const rule = (n: number): string => new RegExp(`^${n}\\. [^\\n]+`, 'm').exec(rules)?.[0] ?? '';
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('релей: правила о ссылках, источниках и файлах', () => {
  it('SYSTEM_PROMPT и список RULES нашлись, нумерация 1–11 цела', () => {
    expect(SYS_START).toBeGreaterThan(-1);
    expect(rules.length).toBeGreaterThan(100);
    const missing = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((n) => rule(n) === '');
    expect(missing).toEqual([]);
  });

  it('правило 9 больше не запрещает любые адреса', () => {
    expect(system).not.toContain('NEVER print URLs or filesystem paths in your response');
    expect(rule(9)).toMatch(/^9\. LINKS AND PATHS\./);
  });

  it('правило 9: пути файлов и внутренние адреса — по-прежнему нельзя', () => {
    for (const closed of ['/tmp/', '/files/', 'output directory', 'localhost', 'IP addresses', '/webhook/']) {
      expect(rule(9)).toContain(closed);
    }
    expect(rule(9)).toMatch(/any host of the platform other than my\.linkeon\.io/);
  });

  it('правило 9: можно разделы my.linkeon.io и страницы, открытые в этом ходе', () => {
    const r = rule(9);
    expect(r).toMatch(/https:\/\/my\.linkeon\.io\/\.\.\. exactly as/);
    expect(r).toMatch(/never make up a cabinet address/);
    expect(r).toMatch(/an external page you opened yourself in THIS turn/);
    expect(r).toMatch(/never a link you did not open in this turn/);
  });

  it('правило 9: картинки инструментов и найденные файлы — как раньше', () => {
    expect(rule(9)).toContain('MUST be embedded as ![](url)');
    expect(rule(9)).toContain('mcp__products__find_files');
  });

  it('«файлы прикреплены ниже» — только про файлы этого хода; старый — пересохранить', () => {
    const r = rule(9);
    expect(r).toMatch(/only files you saved to the output directory in THIS turn are attached/);
    expect(r).toContain('«файлы прикреплены ниже»');
    expect(r).toMatch(/save it to the output directory again in this turn instead of claiming it is attached/);
    expect(system).not.toMatch(/If the user asks "where are the files\?", answer "файлы прикреплены ниже"/);
  });

  it('правило 7 на месте: адреса созданных файлов не печатаются', () => {
    expect(rule(7)).toContain('DO NOT print absolute paths or URLs');
    expect(rule(9)).toContain('Rule 7 is about files you create');
  });

  it('ПРОВЕРКА ФАКТОВ: ссылка на открытую страницу и что на ней видно', () => {
    const f = flat(/ПРОВЕРКА ФАКТОВ:[^\n]+/.exec(system)?.[0] ?? '');
    expect(f).toMatch(/реестра, сайта, профиля в мессенджере/);
    expect(f).toMatch(/ссылкой на страницу, которую ты сам открыл в этом ходе/);
    expect(f).toMatch(/что именно на ней видно/);
    expect(f).toMatch(/совпадение неполное/);
    expect(f).toMatch(/не выдавай за проверенный/);
    expect(f).toMatch(/«Не нашёл» не значит «не существует»/);
    expect(f).toMatch(/как человеку проверить самому/);
  });

  it('ПРОВЕРКА ФАКТОВ — отдельным абзацем до RULES, не сбивая нумерацию', () => {
    const at = system.indexOf('\nПРОВЕРКА ФАКТОВ:');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(system.indexOf('\nRULES:\n'));
  });

  it('правило 4: картинка — под свой слайд, вопрос одной фразой, перечень в ответе', () => {
    const r = rule(4);
    expect(r).toContain('python-pptx');
    expect(r).toMatch(/ask ONE short question before building/);
    expect(r).toMatch(/for the content of ITS OWN slide/);
    expect(r).toMatch(/list what each picture shows/);
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
R=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links-relay
git -C $R add src/chat/relay-rules-guard.spec.ts && git -C $R commit -q -m "test(relay): правила о ссылках, источниках и файлах — сторож текста (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, релей): `src/chat/relay-rules-guard.spec.ts`. Expected: FAIL — все тесты, кроме первого («нашлись, нумерация 1–11 цела»). «Правило 7 на месте» тоже красный: его вторая проверка ищет оговорку в новом правиле 9.

- [ ] **Step 3: Текст правил**

`relay-agent/server.mjs`:

1) Над строкой `const SYSTEM_PROMPT = \`You are a universal agent on an Ubuntu 24.04 server. You can do ANYTHING.` добавить:

```js
// Правила 4 и 9 и абзац «ПРОВЕРКА ФАКТОВ» — спека
// docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md (п. 3).
// Их текст сторожит src/chat/relay-rules-guard.spec.ts.
```

2) Между абзацем `УТОЧНЯЮЩИЕ ВОПРОСЫ: …` и абзацем `ЯЗЫК (ВАЖНО): …` вставить абзац (одной строкой, с пустой строкой до и после). Для Edit: старая строка — `\n\nЯЗЫК (ВАЖНО): Всегда отвечай на языке пользователя`, новая — `\n\nПРОВЕРКА ФАКТОВ: …` (текст ниже) `\n\nЯЗЫК (ВАЖНО): Всегда отвечай на языке пользователя`.

```
ПРОВЕРКА ФАКТОВ: факт из внешнего источника — реестра, сайта, профиля в мессенджере или соцсети — сообщай вместе со ссылкой на страницу, которую ты сам открыл в этом ходе, и с тем, что именно на ней видно («в карточке компании на сайте реестра указаны ИНН и адрес …»). Страница не открылась, данных нет или совпадение неполное (другой город, другое отчество, похожее название) — так прямо и скажи; вывод по косвенным признакам не выдавай за проверенный — называй его предположением. «Не нашёл» не значит «не существует»: говори, где именно искал и не нашёл, а не «такого нет». Не можешь проверить — подскажи, как человеку проверить самому: где и что посмотреть.
```

3) Строку правила 4 `4. For pptx: use python-pptx, keep simple, validate with soffice --headless --convert-to pdf.` заменить на (одной строкой):

```
4. For pptx: use python-pptx, keep simple, validate with soffice --headless --convert-to pdf. PICTURES in a pptx or any other document: if the task does not make clear what the pictures should show, ask ONE short question before building (see УТОЧНЯЮЩИЕ ВОПРОСЫ above — ask and end the turn); pick each picture for the content of ITS OWN slide or section, not for the general topic of the file; in your reply list what each picture shows (e.g. "slide 3 — spice jars on a shelf"), so an unfitting picture is visible without opening the file.
```

4) Строку правила 9 (начинается с `9. NEVER print URLs or filesystem paths in your response.`) заменить целиком на (одной строкой):

```
9. LINKS AND PATHS. NEVER print filesystem paths or internal addresses: /tmp/..., /files/..., the output directory, localhost, IP addresses, /webhook/ endpoints, or any host of the platform other than my.linkeon.io. Rule 7 is about files you create; these links ARE allowed: (a) Linkeon cabinet sections — https://my.linkeon.io/... exactly as the assistant instructions below or a linkeon_help article give them, next to the section name; never make up a cabinet address; (b) an external page you opened yourself in THIS turn (WebFetch or WebSearch) — as the source of a fact, next to that fact; never a link you did not open in this turn or remember from earlier; (c) links a tool returns for the user when its instructions say to show them (mcp__products__find_files), and image URLs returned by mcp__linkeon__* image/banner tools, which MUST be embedded as ![](url) — that markdown is how the user sees generated images. FILES: only files you saved to the output directory in THIS turn are attached below your reply. Say «файлы прикреплены ниже» (or the same in the reply language) only about those; a file from an earlier turn is not attached again — save it to the output directory again in this turn instead of claiming it is attached.
```

- [ ] **Step 4: Коммит и прогон — ждём PASS**

```bash
git -C $R add relay-agent/server.mjs && git -C $R commit -q -m "relay: правило 9 — ссылки на разделы и открытые в ходе страницы; «прикреплены» — только файлы хода; ПРОВЕРКА ФАКТОВ; картинки в pptx — по смыслу слайда" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run (нода, релей): `src/chat/relay-rules-guard.spec.ts src/chat/relay-help-guard.spec.ts src/chat/relay-linkeon-guard.spec.ts src/chat/relay-order-guard.spec.ts src/chat/relay-products-keys-guard.spec.ts src/mcp/relay-products-tools.spec.ts src/products/products-cli-tool.spec.ts`. Expected: PASS. Затем на ноде `node --check relay-agent/server.mjs && echo syntax-ok` — `syntax-ok`.

---

### Задача Р2: Итог трека релея — дифф, пуш, условие слияния

**Files:** ничего не меняется.

- [ ] **Step 1: Дифф ветки — только текст правил и спека**

```bash
R=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links-relay
git -C $R fetch -q origin
git -C $R diff --stat origin/main...HEAD
git -C $R diff origin/main...HEAD -- relay-agent/server.mjs | grep -E '^[+-][^+-]' | cut -c1-80
```

Expected: два файла (`relay-agent/server.mjs`, `src/chat/relay-rules-guard.spec.ts`); в server.mjs — три строки комментария, новый абзац «ПРОВЕРКА ФАКТОВ», замены строк правил 4 и 9. Больше ничего.

- [ ] **Step 2: Пуш**

```bash
git -C $R push -q origin HEAD:refs/heads/feat/assistant-links-relay
git -C $R log --oneline -3
```

- [ ] **Step 3: В отчёт — условие слияния (дословно)**

«Ветку `feat/assistant-links-relay` в `main` не сливать, пока не выкачены фронт и бэк этого плана и не закончена очередь сессии „секрет релея“ (enforce, затем часть Б). Перед выкатом релея (его раннбук, с OK владельца): `git -C $R merge origin/main`, разрешить конфликты только в строках `SYSTEM_PROMPT`, сохранив чужие правки, снова прогнать Р1, затем сливать».

---

## Финал

### Задача С1: Сверка трека 1 и трека 2 — одна таблица адресов

**Files:** ничего не меняется (если сверка не сошлась — правка в отстающем репозитории отдельным коммитом и повтор сверки).

Как держатся согласованными две копии (по образцу «трёх копий одной проверки» из `src/products/secret-rules.ts`):

- **Две копии одной таблицы:** `spirits_back/src/platform-kb/section-links.ts` (что дают ассистенты) и `spirits_front/src/utils/cabinetSections.ts` (что кабинет открывает, к какой карточке прокручивает, что переживает вход). Шапка каждой называет вторую.
- **Сторож:** общая таблица — 20 относительных адресов между строками-метками `// <<< АДРЕСА РАЗДЕЛОВ …` и `// >>> АДРЕСА РАЗДЕЛОВ`, дословно одна и та же в `section-links.spec.ts` (бэк) и `cabinetSections.test.ts` (фронт). Каждая спека сверяет свой модуль с таблицей: поменял модуль, не поменяв таблицу, — красный в своём репозитории. Поменял таблицу в одном репозитории — блоки разошлись, это ловит `diff` ниже (тот же шаг стоит в правиле сопровождения, задача С2).
- **Правило изменения:** новый адрес раздела или переименование карточки — одним изменением в обоих репозиториях: модуль + таблица в обеих спеках. Фронт катится не позже бэка, иначе ассистент даст ссылку, которую кабинет ещё не открывает.

- [ ] **Step 1: Блоки таблиц совпадают дословно**

```bash
B=/Users/dmitry/Downloads/spirits_back/.worktrees/assistant-links
F=/Users/dmitry/Downloads/spirits_front/.worktrees/assistant-links
blk() { sed -n '/^\/\/ <<< АДРЕСА РАЗДЕЛОВ/,/^\/\/ >>> АДРЕСА РАЗДЕЛОВ/p' "$1"; }
blk $B/src/platform-kb/section-links.spec.ts | wc -l
blk $F/src/utils/cabinetSections.test.ts | wc -l
diff <(blk $B/src/platform-kb/section-links.spec.ts) <(blk $F/src/utils/cabinetSections.test.ts) && echo tables-equal
```

Expected: `24`, `24` (метка, `const SECTION_TABLE = [`, 20 адресов, `];`, метка) и `tables-equal`.

- [ ] **Step 2: Обе спеки зелёные на последних коммитах обеих веток**

```bash
SHA_B=$(git -C $B rev-parse HEAD); SHA_F=$(git -C $F rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/al-back && git fetch -q origin && git checkout -q --detach $SHA_B && source ~/.nvm/nvm.sh >/dev/null && npx jest src/platform-kb/section-links.spec.ts src/chat/platform-guide.spec.ts 2>&1 | grep -E '^(PASS|FAIL)'"
ssh dv@85.192.61.231 "cd ~/ci/wt/al-front && git fetch -q origin && git checkout -q --detach $SHA_F && source ~/.nvm/nvm.sh >/dev/null && npx vitest run src/utils/cabinetSections.test.ts src/utils/pendingDestination.test.ts src/components/profile/ProfileView.deeplink.test.tsx 2>&1 | tail -4"
```

Expected: PASS везде. Сверка смысла: каждый адрес бэка (а) есть в перечне кабинета, (б) по `cabinetPath` открывается в той же вкладке, (в) у каждой карточки есть якорь на экране, (г) каждый адрес с параметром переживает вход.

- [ ] **Step 3: Адреса кабинета, написанные мимо таблицы (информационно)**

```bash
git -C $B grep -n "my\.linkeon\.io/\(profile\|studio\|settings\|referral\|search\|help\|support\|image-gen\|video\|chat\)" -- src ':!src/platform-kb/section-links.ts' ':!*.spec.ts'
```

Expected: только известные строки — три `https://my.linkeon.io/chat` в рассылках админки (`src/admin/admin.service.ts`) и `TOP_UP_URL` (`src/tokens/balance-context.service.ts`). Их адреса кабинет и так открывает: маршрут чата. Новая строка в выводе — повод проверить, что её адрес есть в таблице или стоит вне её нарочно; описать в отчёте.

---

### Задача С2: Решения плана — в спеку; правило сопровождения — в CLAUDE.md обоих репозиториев

**Files:**
- Modify: `$B/docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md` (новый раздел в конце)
- Modify: `$B/CLAUDE.md` (раздел «Справка о Linkeon для ассистентов (platform-kb)», список «Правило сопровождения»)
- Modify: `$F/CLAUDE.md` (подраздел «Справка ассистентов»)

- [ ] **Step 1: Спека**

В конец спеки добавить раздел:

```markdown
## Решения плана (27.10.2026)

План: `docs/superpowers/plans/2026-10-27-assistant-links-sources-roles.md`, раздел «Решения плана», — там все 17 пунктов с обоснованием. Главное:

- Адреса разделов — в одной таблице `src/platform-kb/section-links.ts` (20 адресов), её копия в кабинете — `spirits_front/src/utils/cabinetSections.ts`; сверка — общая таблица в двух спеках.
- Адреса стоят и в постоянном блоке «Что есть в Linkeon», не только в справке; правило ссылок двух видов — markdown (веб, приложения) и только адрес (Telegram, поддержка).
- Вход запоминает только адреса с параметром (карточки профиля, `?settings=1`, вкладки Студии bots/products); голый раздел — обычная страница.
- Без строки «Ссылка» — статьи products (нет места), tokens и payments (оплата — блок баланса), how-it-works.
- «Коллеги» — функцией категории: personal и business — мягкая переадресация; остальным — прежняя строка.
- Релей — отдельной веткой `feat/assistant-links-relay`, в main — после выката фронта и бэка и очереди «секрет релея».
- Попутно: возврат от Zoom — на `/profile?open=zoom`.
- Открыто: «ПРОВЕРКА ФАКТОВ» для Telegram-ботов (у них есть WebSearch/WebFetch) — решение владельца.
```

- [ ] **Step 2: CLAUDE.md бэка**

В разделе «Справка о Linkeon для ассистентов (platform-kb)», в нумерованный список «Правило сопровождения», после пункта 4 добавить:

```markdown
5. новый раздел или карточка кабинета, на которую ассистент может дать ссылку, — адрес в `src/platform-kb/section-links.ts` И в `spirits_front/src/utils/cabinetSections.ts`, плюс общая таблица «АДРЕСА РАЗДЕЛОВ» в `section-links.spec.ts` и `cabinetSections.test.ts` — дословно одна и та же (сверка: `diff` блоков между метками, план `2026-10-27-assistant-links-sources-roles`, задача С1). Фронт катится не позже бэка.
```

- [ ] **Step 3: CLAUDE.md фронта**

В подразделе «Справка ассистентов» (раздел «Паттерны кода») дописать абзац:

```markdown
Адреса разделов, которые дают ассистенты (`/profile?open=zoom` и др.), — в `src/utils/cabinetSections.ts`; их копия на бэке — `spirits_back/src/platform-kb/section-links.ts`. Новая карточка или раздел — в обоих местах одним изменением, плюс общая таблица «АДРЕСА РАЗДЕЛОВ» в `cabinetSections.test.ts` и в `section-links.spec.ts` бэка.
```

- [ ] **Step 4: Коммиты и пуш**

```bash
git -C $B add docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md CLAUDE.md && git -C $B commit -q -m "docs: решения плана ссылок и ролей — в спеку; правило сопровождения адресов разделов" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C $B push -q origin HEAD:refs/heads/feat/assistant-links
git -C $F add CLAUDE.md && git -C $F commit -q -m "docs: адреса разделов — две копии одной таблицы (кабинет и бэк)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C $F push -q origin HEAD:refs/heads/feat/assistant-links
```

---

## После плана (не задачи; только с OK владельца)

- **Выкат фронта и бэка** — одним `bash ~/Downloads/spirits_back/scripts/deploy.sh` (с ноды — `~/dev/spirits_back/scripts/deploy.sh`), из main, после слияния обеих веток `feat/assistant-links`. Заметки памяти «Выкат: правила», «deploy.sh: ловушки», «Не рестартить при живых стримах».
- **Живая проверка после выката:** вошедшим — `https://my.linkeon.io/profile?open=zoom` раскрывает «Настройки» и прокручивает к Zoom. Без входа — та же ссылка → вход → карточка Zoom. В веб-чате спросить Дмитрия «где интеграции?» — в ответе ссылка, и она открывается в той же вкладке. Бот в Telegram — полный адрес. Поддержка — ссылка нажимается. Бизнес-специалисту дать просьбу из чужой области — он предлагает коллегу. Сверка хеша бандла — заметка «Проверка выката».
- **Выкат релея** — его раннбуком, после очереди «секрет релея» и после фронта и бэка (условие из Р2). Затем: попросить Романа проверить компанию в реестре — в ответе ссылка на открытую страницу и что на ней видно; попросить презентацию с картинками — перечень, что на каждой.

## Покрытие спеки

| Спека | Задачи |
|---|---|
| п. 1: `/profile?open=` для 8 карточек (+ calendars), раскрыть и прокрутить | Ф1, Ф3 |
| п. 1: `/settings?…` сохраняет параметры; кнопка `action: settings` → `/profile?settings=1` | Ф4, Ф5 |
| п. 1: белый список входа | Ф2 |
| п. 1: своя ссылка в веб-чате — в той же вкладке; поддержка — ссылки кликабельны | Ф5, Ф6 |
| п. 2: таблица абсолютных адресов в `src/platform-kb`; «Ссылка: …» в «Где» | Б1, Б2, Б3 |
| п. 2: синонимы «интеграции, подключения» в calendars, meetings, account | Б4 |
| п. 2: правило ссылок в `platform-guide.ts`, INITIATIVE_RULE | Б5 |
| п. 2: то же правило у поддержки | Б6 |
| п. 3: правило 9 сужается; «ПРОВЕРКА ФАКТОВ»; правило 4 — картинки; «прикреплены» — только этот ход | Р1 |
| п. 4: «Коллеги» — мягкая переадресация personal/business, Роману и своим как было | Б7 |
| «Тесты»: фронт, бэк (адреса таблицы = то, что открывает фронт), релей | Ф1–Ф6, Б1–Б8, Р1, С1 |
| «Выкат»: фронт и бэк раньше релея | решение 14, Р2, «После плана» |
