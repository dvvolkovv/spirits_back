# Ассистент ведёт продукт целиком — очередь 2. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ассистент меняет ключи продукта защищённой карточкой (новое задание агента `rekey` с откатом при нездоровом продукте), удалённые продукты через 30 дней стираются насовсем (задание `purge`, почасовой обход, резервная копия на проде), бот при заведении знает владельца (`OWNER_TG_ID`).

**Architecture:** действие `keys` инструмента `manage_product` открывает карточку с ИМЕНАМИ текущих ключей; отправка карточки (`POST /webhook/product-actions/:id {set, remove}`) проверяет ключи теми же правилами, что заведение, шифрует новый набор в `product_actions.secrets_box` и одним оператором ставит задание `rekey`, связанное с карточкой колонкой `product_provision_jobs.action_id`. Агент машины пересоздаёт контейнер с тем же образом, портом, каталогом и переменными платформы, меняя только ключи владельца; нездоров — возвращает старый контейнер. Отчёт агента одним оператором закрывает задание, переносит коробку в `products.secrets_encrypted` (или нет — при отказе) и закрывает карточку. Стирание — `purge` из почасового обхода: агент снимает vhost, сертификат, контейнер и каталог (слаг и путь сверяются до любого `rm`), сервер помечает `purged_at`, обнуляет секреты, удаляет строку своего домена, пишет журнал и стирает резервную копию `~/product-repos/<слаг>.git`.

**Tech Stack:** NestJS 10 + PostgreSQL (бэк `spirits_back`), агент машины продуктов (`product-runner/`, свой jest и tsconfig), React 18 + Vite + vitest (фронт `spirits_front`), Telegram (grammy).

**Спека:** `docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md` — разделы «Действия инструмента» (`keys`), «Ручки карточки», «Машина продуктов» (`rekey`, `purge`), «Данные и деньги», «Тексты ассистенту», «Тесты», «Очереди выката» (очередь 2) и итоговые разделы «Отступления очереди 1» и «Открыто на очередь 2» — последние два главнее исходного текста там, где расходятся. План очереди 1 (`docs/superpowers/plans/2026-10-25-product-full-lifecycle-stage1.md`) — образец формы; код ветки — источник правды.

---

## Общее

### Где работать

- Бэк: `/Users/dmitry/Downloads/spirits_back/.worktrees/product-lifecycle-2`, ветка `feat/product-lifecycle-2` (стоит на `main` 565e60f: очередь 1 и «аренда при запуске» уже внутри).
- Фронт: `/Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2`, ветка `feat/product-lifecycle-2` от `origin/main` (a369a67 — слияние очереди 1). Заводится в задаче 0. Общий чекаут `~/Downloads/spirits_front` НЕ трогать: он отстаёт от `origin/main` и в нём работают другие сессии.
- Перед каждой задачей: `git -C <воркдерево> branch --show-current` обязан вернуть `feat/product-lifecycle-2`. Иначе — СТОП, доложить.
- В командах ниже: `B=/Users/dmitry/Downloads/spirits_back/.worktrees/product-lifecycle-2`, `F=/Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2`.

### Правила (обязательны, нарушение — повод вернуть задачу)

- **Сборки и тесты — ТОЛЬКО на тест-ноде** `dv@85.192.61.231`, в CI-клонах `~/ci/wt/pl2-back` и `~/ci/wt/pl2-front` (CLAUDE.md: мак не тянет). На маке не гонять `jest`, `vitest`, `tsc`, `npm run build`, `pnpm build`. Jest бэка внутри `.worktrees/` всё равно не видит ни одного теста (`testPathIgnorePatterns` содержит `/.worktrees/` и `<rootDir>/product-runner/`).
- На ноде не трогать `~/spirits_back`, `~/spirits_front` (живой test-стенд), `~/dev/*` (чужие сессии) и чужие каталоги в `~/ci/wt/`. Каждая ssh-команда начинается с `source ~/.nvm/nvm.sh` — иначе node не найдётся.
- Код на ноду — только через git: коммит → пуш → `git checkout --detach <sha>` в CI-клоне. Коммиты не переписываются: без `--amend` уже запушенного и без force-push.
- **Пушить только ветку фичи и только так:** `git -C $B push -q origin HEAD:refs/heads/feat/product-lifecycle-2` (то же для `$F`). НИКОГДА `git push origin HEAD` из detached HEAD (создаёт в GitHub ветку `HEAD` и ломает клоны), никаких `main`, `b2b`. Пуш с мака рвётся (VPN) — повторить до трёх раз с паузой 10 с; не помогает — пуш через ноду (`wip/<имя>` из `~/ci`, заметка памяти «Пуш через ноду»).
- **`strictNullChecks` в `spirits_back` выключен:** объединения `{ok:true,…} | {ok:false,…}` не сужаются через `!x.ok` и `x.ok ? … : …` — только `x.ok === false` / `x.ok === true`. Агент (`product-runner`) собирается со `strict: true` — там сужение обычное, но форма `=== false` годится и там.
- **Не писать `\uXXXX` инструментами Write/Edit** — последовательности молча раскодируются. Нужен такой символ — node-скриптом, или обойтись без него (регэкспы — через `\p{…}`).
- Репозитории публичные: секреты, токены, номера телефонов в код и коммиты не класть. Тестовые значения — заведомо фиктивные (`123456:TEST…`).
- Комментарии и тексты — по-русски, в духе соседнего кода: ПОЧЕМУ, а не что. В интерфейсе и текстах для людей — «ассистент», не «агент» (агент — только в коде: агент машины продуктов).
- Последняя строка каждого сообщения коммита: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (в шаблонах ниже — через второй `-m`).
- Если код плана не сходится с файлом (имя, строка, отступ) — не выдумывать: сверить по файлу, сделать по смыслу плана, описать расхождение в отчёте. Неясен смысл — `NEEDS_CONTEXT`.
- На прод (`212.113.106.202`) и машины продуктов в ходе задач 0–22 не ходить. Выкат и живая проверка — только задача 23 и только с OK владельца.

### Как гонять тесты (прочитать до первой задачи)

Если в сессии есть обёртка `nssh.sh` (ssh с мастер-соединением и повтором на обрыве рукопожатия) — вместо `ssh dv@85.192.61.231` писать `bash <путь>/nssh.sh`. Без неё: SSH к ноде рвётся на рукопожатии (MaxStartups) — повторить через 20–30 с.

**Бэк (NestJS, корень репозитория):**

```bash
B=/Users/dmitry/Downloads/spirits_back/.worktrees/product-lifecycle-2
git -C $B push -q origin HEAD:refs/heads/feat/product-lifecycle-2
SHA=$(git -C $B rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-back && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && PROVISIONING_PG_URL='postgres:///pl2_test?host=/var/run/postgresql' npx jest --runInBand <файлы через пробел> 2>&1 | grep -E '^(PASS|FAIL)|Tests:|●' | head -80"
```

tsc бэка (после КАЖДОЙ правки бэка, ts-jest типы здесь не проверяет):
`ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-back && source ~/.nvm/nvm.sh >/dev/null && npx tsc -p tsconfig.build.json --noEmit && echo tsc-ok"`.

**Агент машины (`product-runner/` — отдельный пакет со своим jest; ts-jest здесь типы ПРОВЕРЯЕТ):**

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-back && git fetch -q origin && git checkout -q --detach $SHA && cd product-runner && source ~/.nvm/nvm.sh >/dev/null && npx jest <файлы> 2>&1 | grep -E '^(PASS|FAIL)|Tests:|●' | head -80"
```

tsc агента: `... && cd product-runner && npx tsc -p tsconfig.json --noEmit && echo runner-tsc-ok`.

**Фронт:**

```bash
F=/Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2
git -C $F push -q origin HEAD:refs/heads/feat/product-lifecycle-2
SHA=$(git -C $F rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-front && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh >/dev/null && npx vitest run <файлы> 2>&1 | tail -30"
```

tsc фронта: `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'` — число не выше базовой линии из задачи 0 (заметка памяти «tsc фронта — с -p»: голый `tsc` не проверяет ничего).

В шаблонах задач «Run (нода, бэк): …», «Run (нода, агент): …», «Run (нода, фронт): …» значит: коммит → пуш → соответствующая команда выше с указанными файлами. `PROVISIONING_PG_URL` в команде обязателен: без него тесты против живого Postgres ПРОПУСКАЮТСЯ, а не падают.

### Базовая линия — мерить ДО первой правки (задача 0), дальше мерить дельтой

- Бэк: `src/products src/mcp src/chat src/tg-bot src/platform-kb` с `PROVISIONING_PG_URL` — наборы PASS/FAIL/пропущено, тесты PASS/FAIL/пропущено. Для сравнения: до очереди 1 было 129 наборов PASS, 2260 тестов PASS (без `src/platform-kb`); числа после очереди 1 — выше, их и записать.
- Агент: `cd product-runner && npx jest` — все наборы зелёные (агент очередь 1 не трогала).
- Фронт: `src/components/chat src/components/products src/utils src/tma src/pages src/services src/components/webvisorPrivacy.test.ts` — файлы и тесты PASS; `tsc -p tsconfig.app.json` — число `error TS` (в заметках встречались 42 и 45 — мерить заново).
- Полный `npx jest --runInBand src` бэка красный «by design» (заметка «npm test бэка красный by design») — записать число FAIL и в задаче 21 сравнивать дельтой.

### Отступления от спеки (вносятся в спеку задачей 22)

1. **Стирание только помечает.** `purge` ставит `purged_at`, обнуляет `secrets_encrypted` и `first_prompt*`, удаляет строку своего домена — строка `products` остаётся (так требует «Открыто на очередь 2»: задания удаляются каскадом, и счёт бесплатных месяцев `freeMonthCountedJobSql` сбросился бы). `tg_bot_id` и `port` не трогаются: не секрет, нужны журналу; частичный индекс `products_tg_bot_live` архивных и так не видит.
2. **Обход стирания — раз в час, а не раз в сутки.** Таймер на сутки обнуляется каждым рестартом API, а API катится несколько раз в день — суточный обход не сработал бы никогда. Условие (`purge_after <= now()`) то же, так что продукт стирается в первый час после срока. Первый обход — через час после старта, а не на старте: так выкат нового сервера не отдаёт `purge` старому агенту машины в окне между PHASE 2 и PHASE 4 deploy.sh.
3. **Связь «задание — карточка» — колонка `product_provision_jobs.action_id`** (миграция 010, обязательная: её читает каждая выдача задания). Новый набор ключей лежит в `product_actions.secrets_box` тем же `SecretsService` и с тем же AAD (id продукта), поэтому при успехе переносится в `products.secrets_encrypted` как есть, без перешифровки; пустой набор — `NULL`, как у заведения.
4. **Агент получает полный новый набор ключей владельца и список снимаемых имён (`dropNames`).** Из окружения контейнера уходят ровно `dropNames` и имена нового набора, приходят новые значения. Переменные, о которых сервер не знает (заведённые руками у старых продуктов), и переменные платформы не трогаются.
5. **Образ для пересоздания — тот же, но запуск по метке.** Агент запускает новый контейнер по `.Config.Image` (метке), если она по-прежнему указывает на образ контейнера; если метку передвинули (контейнер пропущен прошлым обновлением образа) — по метке `linkeon-product:src-*` того же образа; такой нет — отказ до изменений. Запуск по голому идентификатору выбросил бы контейнер из отбора `scripts/product-image-roll.sh` навсегда (отбор идёт по `.Config.Image` с префиксом `linkeon-product:`).
6. **Здоровье после `rekey`.** Сайт — тот же `waitPort`, что у заведения и пробуждения (200 и непустой `sha` с опубликованного порта). Бот порта не публикует — его `/health` спрашивается изнутри контейнера: `docker exec <слаг> node -e …` и `"ok":true`, как в спеке.
7. **Прерванная смена ключей — ручной разбор.** Если на машине остался контейнер `<слаг>__rekey` (агент умер посреди прошлой смены), `rekey` отказывает до изменений: по одному состоянию хоста нельзя понять, какой контейнер несёт подтверждённые ключи.
8. **Правки и смена ключей не пересекаются с обеих сторон.** Пока у продукта есть правка `queued/running`, отправка карточки возвращает её в `pending` с ошибкой («идёт правка — отправьте, когда закончится»), а выдача `rekey` агенту требует отсутствия активных правок; пока `rekey` в очереди или идёт — `turns.enqueue` отвечает 409.
9. **`OWNER_TG_ID` получает и бот при смене ключей**, если Telegram владельца привязан, — так он доезжает до ботов, заведённых до очереди 2. Ищется отдельным чтением `tg_user_identities` после выдачи задания и лучшим усилием (таблица чужого модуля; отказ чтения не ломает выдачу). Сайтам `OWNER_TG_ID` не передаётся.
10. **Снятие vhost при стирании — как подчистка заведения**, а не через `product-vhost`: у скрипта нет режима удаления. `rm -f /etc/nginx/sites-products/<слаг>.conf` + `systemctl reload nginx` и `certbot delete --cert-name linkeon-<слаг>` («сертификата нет» — не отказ). Правка `product-vhost` потребовала бы отдельного выката скрипта на машины.
11. **Резервная копия стирается, только если путь в `repo_url` продукта — ровно `<PRODUCT_REPOS_DIR или ~/product-repos>/<слаг>.git`** (так её пишет `scripts/product-backup-setup.sh`; имя хоста в `repo_url` не сверяется — стирается каталог по этому пути на машине API), после чего `repo_url = NULL`. Иначе — предупреждение в лог (раз на процесс), ничего не трогается.
12. **Стирание после трёх провалов подряд не ставится** (тот же потолок, что у сна удалённого) — строка `error` в лог раз на процесс.
13. **Итог смены ключей для человека — свой текст**, а не сырая причина агента: она остаётся в `product_provision_jobs.error`. Карточка ключей опрашивает «в работе» до трёх минут (60 попыток), остальные — минуту, как было.
14. **В вид действия (`ActionView`) добавлен `productKind`**: карточка ключей не предлагает «Убрать» у `BOT_TOKEN` бота (сервер это всё равно отбивает).
15. **Ручки — `/webhook/product-actions…`** (как в очереди 1); тело ключей — `{set, remove, via}`.
16. **Ключи стираются на сервере сразу после срока возврата**, не дожидаясь машины: почасовой обход обнуляет `secrets_encrypted` и первую правку у удалённых с `purge_after <= now()` — даже если стирание на машине упрётся в потолок провалов. Потолок считает только задания, которые агент реально забрал (`started_at IS NOT NULL`): снятые до выдачи не в счёт.
17. **Исход смены ключей для человека — по причине (`result.reason`) и переводится на 7 языков** (`products.action.keys.errors.<reason>` в кабинете и мини-приложении; сырой русский `error` — запасной показ). Отдельная причина `rekey_unknown`: откат не удался, агент бросил смену по сроку, задание сняли у агента в руках — продукт может не отвечать; это `logger.error` со слагом и свой текст «напишите в поддержку». Бот Telegram исход смены ключей не показывает вовсе (форма — в мини-приложении), поэтому своих текстов исхода в `tg-i18n` нет.
18. **Поздний отчёт об успехе** (задание уже сняли блокировкой или сборщиком, а агент дошёл до конца) базу не меняет — это прежний замок `status = 'running'`; но он пишет `logger.error` со слагом: в контейнере новые ключи, в базе прежние, нужна сверка руками. Смена, брошенная агентом по сроку, может продолжаться на машине в фоне, и следующее задание продукта может с ней пересечься — тот же класс, что у брошенного заведения (index.ts, `overdue`).
19. **`OWNER_TG_ID` снимается при смене ключей, если владелец отвязал Telegram** (сервер шлёт пустую строку); не прочиталась таблица привязок — переменная остаётся как была.
20. **Обновление образа не пересоздаёт продукт с активным заданием машины** (`product-image-roll.sh`: к счётчику «занят» добавлены задания `queued/running`) — иначе обновление образа и `rekey` переименовывали бы один контейнер наперегонки.
21. **Живая проверка — сразу на проде тестовым аккаунтом**: на test-стенде нет машины продуктов (и релейные инструменты там не работают). Сайт тестового аккаунта может списать аренду 50 000 токенов — это тестовый аккаунт, допустимо.

### Чего план сознательно НЕ делает

- Не правит `product-vhost`. В `product-image-roll.sh` — одна правка запроса «занят» (задача 14b), больше ничего.
- Не катит релей: `relay-agent/server.mjs` меняется только в репозитории; выкат релея — другая сессия по раннбуку релея.
- Не трогает Flutter (там ссылка на кабинет, как в очереди 1).
- Не меняет `CLAUDE.md` уже заведённых продуктов: правки каркаса доезжают только до новых.

---

## Структура файлов

**Бэк (`spirits_back`):**

| Файл | Что | Задача |
|---|---|---|
| `src/products/migrations/010_rekey_purge.sql` (новый) | `product_provision_jobs.action_id`, индекс | 1 |
| `src/products/migrations/004_rent.sql` | словарь видов задания + `rekey`, `purge` | 1 |
| `src/products/products.service.ts` | `MIGRATIONS` + 010, `FATAL_MIGRATIONS` + 010 | 1 |
| `src/products/products.migration.spec.ts`, `src/products/rekey-purge.migration.spec.ts` (новый) | сторожа миграций | 1 |
| `src/products/secret-rules.ts` (новый) | правила ключей одним местом: форма, длины, число, занятые имена (+ `OWNER_TG_ID`) | 2 |
| `src/products/provisioning.service.ts` | `create` на общих правилах; выдача `rekey`/`purge`, `OWNER_TG_ID`; отчёт `rekey`/`purge`; сборщик | 2, 9, 10 |
| `src/products/turns.service.ts` | отказ правке во время смены ключей | 11 |
| `src/products/product-actions.service.ts` | `productKind` в виде; подметальщик карточек с заданием; стирание коробок | 12 |
| `src/products/product-keys.service.ts` (новый) | открыть и отправить карточку ключей, поставить `rekey` | 13 |
| `src/products/product-purge.service.ts` (новый) | почасовой обход стирания, обнуление ключей после срока, стирание резервных копий | 14 |
| `src/products/product-lifecycle.service.ts` | сон удалённых не снимает `purge` | 14 |
| `scripts/product-image-roll.sh` | «занят» = правка ИЛИ задание машины | 14b |
| `src/products/product-lifecycle-tool.ts`, `src/products/product-tool.service.ts` | действие `keys`, описание, «уже стёрт» / «стирается» | 15a |
| `src/products/product-actions.controller.ts`, `src/products/products.module.ts`, `src/products/products.routes.spec.ts` | отправка карточки ключей, регистрация, сторож регистрации | 15b |
| `src/products/products-cli-tool.ts`, `relay-agent/server.mjs`, `src/chat/relay-products-keys-guard.spec.ts` (новый) | тексты CLI и релея | 16 |
| `src/platform-kb/articles/products.ts`, `src/platform-kb/products-lifecycle.spec.ts` | справка «Продукты» | 16 |
| `src/tg-bot/tg-i18n.ts`, `src/tg-bot/tg-product-actions.service.ts` | карточка ключей в Telegram, 7 языков | 17 |

**Агент машины (`spirits_back/product-runner`):**

| Файл | Что | Задача |
|---|---|---|
| `src/host/provision.ts` | `OWNER_TG_ID` занято и уходит в `docker run`; `validateSecrets`/`containerTaken` экспортируются; `waitInside` в зависимостях | 3, 5 |
| `src/host/fake-host.ts`, `src/host/fake-host.spec.ts` | симулятор: `inspect {{json .}}`, `image inspect`, `rename`, `exec`, образы и метки | 4 |
| `src/host/rekey.ts` (новый), `src/host/rekey.spec.ts` (новый) | смена ключей с откатом | 5 |
| `src/host/purge.ts` (новый), `src/host/purge.spec.ts` (новый) | стирание со строгой проверкой пути | 6 |
| `src/host/api.ts`, `src/host/index.ts`, `src/host/index.spec.ts` | виды `rekey`/`purge`, выжимки, сроки | 7 |
| `src/host/skeleton.ts`, `src/host/skeleton.spec.ts` | каркас: `OWNER_TG_ID`, `/start` с chat_id, ключи можно сменить | 8 |
| `src/host/provision.spec.ts` | общая таблица занятых имён + `OWNER_TG_ID` | 3 |

**Фронт (`spirits_front`):**

| Файл | Что | Задача |
|---|---|---|
| `src/components/products/secretNames.ts`, `secretNames.test.ts` | третья копия занятых имён + `OWNER_TG_ID` | 18 |
| `src/services/productActionsApi.ts` | `remove`, `productKind`, `result.keyNames` | 18 |
| `src/components/products/ProductActionCard.tsx`, `ProductActionCard.test.tsx` | форма ключей, перевод причин отказа | 20a |
| `src/components/webvisorPrivacy.test.ts` | сторож Вебвизора для новых полей | 20b |
| `src/i18n/locales/*.json` | `products.action.keys.*` и `keys.errors.*`, подсказка формы Студии, 7 языков; удаление `keys.unsupported` | 19, 20b |
| `src/tma/App.test.tsx` (новый) | мини-приложение открывает карточку ключей | 20b |

---

### Task 0: Подготовка — воркдерево фронта, CI-клоны, база, базовая линия

**Files:** в репозиториях ничего не меняется.

- [ ] **Step 1: Воркдерево фронта от `origin/main`**

```bash
git -C /Users/dmitry/Downloads/spirits_front fetch -q origin
git -C /Users/dmitry/Downloads/spirits_front worktree add -q -b feat/product-lifecycle-2 /Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2 origin/main
F=/Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2
git -C $F branch --show-current && git -C $F log --oneline -1
git -C $F push -q -u origin HEAD:refs/heads/feat/product-lifecycle-2
```
Expected: `feat/product-lifecycle-2` и коммит `a369a67 Merge feat/product-lifecycle…` (или новее — тогда записать sha в отчёт).

- [ ] **Step 2: CI-клоны на ноде** (бэк вместе с пакетом агента)

```bash
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/pl2-back origin/feat/product-lifecycle-2 && cd ~/ci/wt/pl2-back && source ~/.nvm/nvm.sh >/dev/null && npm ci --no-audit --no-fund >/dev/null && npx tsc -p tsconfig.build.json --noEmit && cd product-runner && npm ci --no-audit --no-fund >/dev/null && npx tsc -p tsconfig.json --noEmit && echo back-ok'
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/pl2-front origin/feat/product-lifecycle-2 && cd ~/ci/wt/pl2-front && source ~/.nvm/nvm.sh >/dev/null && pnpm install --frozen-lockfile >/dev/null && echo front-ok'
```
Expected: `back-ok`, `front-ok`. Бэк — `npm ci`, не pnpm (заметка «Бэк — npm ci, не pnpm»).

- [ ] **Step 3: Одноразовая база**

```bash
ssh dv@85.192.61.231 'createdb -h /var/run/postgresql pl2_test 2>/dev/null; psql -h /var/run/postgresql -d pl2_test -tAc "select 1"'
```
Expected: `1`. Если `createdb` не прошёл от `dv` — как в шапке `product-lifecycle.pg.spec.ts`: `sudo -u postgres psql -c "CREATE DATABASE pl2_test OWNER dv;"`.

- [ ] **Step 4: Базовая линия** — записать числа в отчёт, дальше мерить дельтой

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-back && source ~/.nvm/nvm.sh >/dev/null && PROVISIONING_PG_URL='postgres:///pl2_test?host=/var/run/postgresql' npx jest --runInBand src/products src/mcp src/chat src/tg-bot src/platform-kb 2>&1 | grep -E '^Tests:|^Test Suites:'"
ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-back/product-runner && source ~/.nvm/nvm.sh >/dev/null && npx jest 2>&1 | grep -E '^Tests:|^Test Suites:'"
ssh dv@85.192.61.231 "cd ~/ci/wt/pl2-front && source ~/.nvm/nvm.sh >/dev/null && npx vitest run src/components/chat src/components/products src/utils src/tma src/pages src/services src/components/webvisorPrivacy.test.ts 2>&1 | tail -4 && npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'"
```

---

### Task 1: Миграция 010 и виды заданий `rekey`, `purge`

**Files:**
- Create: `src/products/migrations/010_rekey_purge.sql`
- Modify: `src/products/migrations/004_rent.sql:85-90` (словарь `product_provision_jobs_kind_check`)
- Modify: `src/products/products.service.ts:66-85` (`MIGRATIONS`), `:147-151` (`FATAL_MIGRATIONS`) и докблок над `MIGRATIONS`
- Modify: `src/products/products.migration.spec.ts:380-382` (литеральный список), `:649-650` (словарь видов)
- Test: `src/products/rekey-purge.migration.spec.ts` (новый)

- [ ] **Step 1: Тесты**

`src/products/rekey-purge.migration.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS, ProductsService } from './products.service';

/**
 * Очередь 2: задание знает свою карточку (action_id), а словарь видов
 * задания знает rekey и purge. Без них смена ключей не связала бы задание
 * с шифротекстом новых ключей, а стирание не поставилось бы вовсе (CHECK).
 */
describe('010 обязательна: её колонку читает каждая выдача задания', () => {
  it('отказ 010 РОНЯЕТ старт, а не уходит в лог', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (String(sql).includes("products/010_rekey_purge")) throw new Error('не взлетело');
        return { rows: [] };
      }),
      getClient: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() })),
    };
    await expect(new ProductsService(pg as any).onModuleInit()).rejects.toThrow(/010_rekey_purge\.sql/);
  });

  it('010 — последней в списке, после 009 (ссылается на product_actions)', () => {
    expect(MIGRATIONS.indexOf('010_rekey_purge.sql')).toBe(MIGRATIONS.indexOf('009_product_actions.sql') + 1);
    expect(MIGRATIONS[MIGRATIONS.length - 1]).toBe('010_rekey_purge.sql');
  });
});

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('010_rekey_purge против живого Postgres', () => {
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

  it('у задания есть action_id, и удаление карточки его обнуляет, а не удаляет задание', async () => {
    const p = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ('u-mig', 'М', 'mig-010', 'bot', 'running', '/product', 'h-mig-010') RETURNING id`,
    );
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel) VALUES ('u-mig', $1, 'keys', 'working', 'web') RETURNING id`,
      [p.rows[0].id],
    );
    const j = await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id) VALUES ($1, 'rekey', 'queued', $2) RETURNING id`,
      [p.rows[0].id, a.rows[0].id],
    );
    await pool.query(`DELETE FROM product_actions WHERE id = $1`, [a.rows[0].id]);
    const left = await pool.query(`SELECT action_id FROM product_provision_jobs WHERE id = $1`, [j.rows[0].id]);
    expect(left.rows).toEqual([{ action_id: null }]);
  });

  it('словарь видов задания знает rekey и purge и по-прежнему держит чужое', async () => {
    const p = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ('u-mig', 'М2', 'mig-010b', 'site', 'archived', '/product', 'h-mig-010b') RETURNING id`,
    );
    const ins = (kind: string) =>
      pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, $2, 'done')`, [p.rows[0].id, kind]);
    await expect(ins('rekey')).resolves.toBeDefined();
    await expect(ins('purge')).resolves.toBeDefined();
    await expect(ins('nuke')).rejects.toThrow(/check/i);
  });
});
```

- [ ] **Step 2: Коммит и прогон — ждём FAIL**

```bash
git -C $B add src/products/rekey-purge.migration.spec.ts && git -C $B commit -q -m "test(products): миграция 010 — задание знает карточку, виды rekey и purge (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/rekey-purge.migration.spec.ts`. Expected: FAIL — `010_rekey_purge.sql` нет в списке, колонки `action_id` нет, `rekey` отбивается CHECK.

- [ ] **Step 3: Миграция**

`src/products/migrations/010_rekey_purge.sql`:

```sql
-- 010_rekey_purge.sql
-- Ассистент ведёт продукт целиком, очередь 2: смена ключей (задание rekey) и
-- стирание удалённых (задание purge). Спека:
-- docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md.
-- Катится на каждом старте вместе со всем списком MIGRATIONS, идемпотентно.
--
-- ОБЯЗАТЕЛЬНАЯ (FATAL_MIGRATIONS в products.service.ts): выдача заданий
-- агенту (claimJob) читает product_provision_jobs.action_id в КАЖДОМ опросе,
-- для задания любого вида. Молча не применившаяся 010 — это 42703 на каждом
-- опросе агента: ни одного заведения, сна и пробуждения ни у одного клиента.
-- Запланированных отказов в файле нет: ADD COLUMN IF NOT EXISTS и индекс под
-- проверкой существования.
--
-- Словарь видов задания (rekey, purge) — НЕ здесь, а в 004: он объявлен
-- только там, и 004 едет раньше при каждом старте (см. шапки 004 и 008).
SELECT pg_advisory_xact_lock(hashtext('products/010_rekey_purge'));

-- Какая карточка поставила задание. Нужна смене ключей: новые ключи лежат
-- шифротекстом в product_actions.secrets_box, выдача задания расшифровывает
-- их оттуда, а отчёт агента тем же оператором закрывает карточку. SET NULL, а
-- не CASCADE: задание — история машины продукта, оно переживает журнал.
ALTER TABLE product_provision_jobs
  ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES product_actions(id) ON DELETE SET NULL;

-- Индекс — только если его нет: CREATE INDEX IF NOT EXISTS на каждом старте
-- берёт ShareLock на таблицу даже при существующем индексе (заметка памяти
-- «CREATE INDEX в стартовой миграции»).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_provision_jobs_action') THEN
    CREATE INDEX idx_provision_jobs_action ON product_provision_jobs (action_id) WHERE action_id IS NOT NULL;
  END IF;
END $$;
```

- [ ] **Step 4: Словарь видов задания в 004**

В `src/products/migrations/004_rent.sql` заменить строку

```sql
  CHECK (kind IN ('provision','sleep','wake','domain'));
```
на
```sql
  CHECK (kind IN ('provision','sleep','wake','domain','rekey','purge'));
```
и строку комментария над ней `-- 'domain' — вид из 008_domains.sql (свой домен). Словарь объявлен ТОЛЬКО` на две:
```sql
-- 'domain' — вид из 008_domains.sql (свой домен), 'rekey' и 'purge' — смена
-- ключей и стирание удалённых (010_rekey_purge.sql). Словарь объявлен ТОЛЬКО
```
Словарь только расширяется — на живых строках `ADD CONSTRAINT` не падает.

- [ ] **Step 5: Список миграций**

`src/products/products.service.ts`:
- в `MIGRATIONS` после `'009_product_actions.sql',` добавить `'010_rekey_purge.sql',`;
- в `FATAL_MIGRATIONS` после `'008_domains.sql',` добавить `'010_rekey_purge.sql',`;
- в конец докблока над `MIGRATIONS` (после абзаца про 009) дописать абзац:

```ts
 *
 * 010 зависит от 009 (ссылается на product_actions) и от 004 (виды задания
 * rekey/purge объявлены в её словаре). Она ОБЯЗАТЕЛЬНАЯ: колонку action_id
 * читает claimJob при выдаче задания любого вида, и молча не применившаяся
 * 010 означала бы отказ на каждом опросе агента. Цена обязательности та же,
 * что у 008: запланированных отказов в файле нет. Как следствие, 009 тоже
 * становится обязательной де-факто — без её таблицы 010 не применится.
```

`src/products/products.migration.spec.ts`:
- в литеральном списке после `'009_product_actions.sql',` добавить `'010_rekey_purge.sql',`;
- ожидание словаря `.toEqual(['domain', 'provision', 'sleep', 'wake'])` заменить на `.toEqual(['domain', 'provision', 'purge', 'rekey', 'sleep', 'wake'])` и в комментарий теста дописать: «'rekey' и 'purge' — очередь 2 (010), по той же причине объявлены здесь же».

- [ ] **Step 6: Коммит и прогон — ждём PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: миграция 010 — задание знает свою карточку; виды rekey и purge" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/rekey-purge.migration.spec.ts src/products/products.migration.spec.ts src/products/product-actions.migration.spec.ts src/products/domains.migration.spec.ts`. Expected: PASS. Затем tsc бэка — `tsc-ok`.

---

### Task 2: Правила ключей одним местом и `OWNER_TG_ID` в занятых (сервер)

**Files:**
- Create: `src/products/secret-rules.ts`
- Modify: `src/products/provisioning.service.ts:139-180` (константы и `isReservedSecretName` уезжают), `:542-570` (проверка в `create`)
- Modify: `src/products/provisioning.create.spec.ts:743-750` (общая таблица занятых имён)
- Test: `src/products/secret-rules.spec.ts` (новый)

Карточке ключей (задача 13) нужны ТЕ ЖЕ правила, что заведению: имя переменной, длины, число, занятые имена. Сейчас они инлайном в `ProvisioningService.create`. Выносим без изменения текстов — на них держатся спеки заведения (`/секрет/i`, `/занято/`) и они же показываются в карточке как `result.error`.

- [ ] **Step 1: Тест**

`src/products/secret-rules.spec.ts`:

```ts
import { isReservedSecretName, secretsProblem, SECRET_COUNT_MAX, SECRET_VALUE_MAX } from './secret-rules';
import { isReservedSecretName as fromProvisioning } from './provisioning.service';

describe('правила ключей владельца — одно место на сервере', () => {
  it('годный набор — null', () => {
    expect(secretsProblem({ BOT_TOKEN: 't', OZON_API_KEY: 'k' })).toBeNull();
    expect(secretsProblem({})).toBeNull();
  });

  it('тексты — дословно прежние тексты create()', () => {
    expect(secretsProblem({ 'A B': 'x' })).toEqual({ message: 'имя секрета "A B" не переменная окружения', field: 'A B' });
    expect(secretsProblem({ ['K'.repeat(65)]: 'x' })).toEqual({ message: 'имя секрета длиннее 64 символов', field: 'K'.repeat(65) });
    expect(secretsProblem({ PORT: 'x' })).toEqual({ message: 'имя секрета PORT занято платформой — назовите ключ иначе', field: 'PORT' });
    expect(secretsProblem({ A: '' })).toEqual({ message: 'секрет A: значение должно быть непустой строкой', field: 'A' });
    expect(secretsProblem({ A: 'ы'.repeat(SECRET_VALUE_MAX + 1) })).toEqual({ message: 'секрет A: значение длиннее 8192 символов', field: 'A' });
    const many = Object.fromEntries(Array.from({ length: SECRET_COUNT_MAX + 1 }, (_, i) => [`K${i}`, 'v']));
    expect(secretsProblem(many)).toEqual({ message: 'секретов больше 64' });
  });

  it('не-строка вместо значения — отказ, а не String()', () => {
    expect(secretsProblem({ A: 42 as unknown as string })?.message).toMatch(/непустой строкой/);
  });

  it('OWNER_TG_ID — переменная платформы (очередь 2): владельцу её не задать', () => {
    expect(isReservedSecretName('OWNER_TG_ID')).toBe(true);
    expect(isReservedSecretName('owner_tg_id')).toBe(true);
    expect(isReservedSecretName('OWNER_TG')).toBe(false);
  });

  it('provisioning.service отдаёт ту же функцию — старые импорты живы', () => {
    expect(fromProvisioning).toBe(isReservedSecretName);
  });
});
```

В `src/products/provisioning.create.spec.ts` в `RESERVED_TABLE` после `'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',` добавить строку `'OWNER_TG_ID',` (та же правка — в двух других копиях таблицы, задачи 3 и 18; таблицы обязаны остаться дословно одинаковыми).

- [ ] **Step 2: Коммит, прогон — FAIL** (`Cannot find module './secret-rules'`; в create-спеке `OWNER_TG_ID` проходит)

```bash
git -C $B add src/products/secret-rules.spec.ts src/products/provisioning.create.spec.ts && git -C $B commit -q -m "test(products): правила ключей одним местом, OWNER_TG_ID занято (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/secret-rules.spec.ts src/products/provisioning.create.spec.ts`.

- [ ] **Step 3: Реализация**

`src/products/secret-rules.ts`:

```ts
/**
 * Правила ключей владельца продукта — ОДНО место на сервере.
 *
 * Их зовут двое: заведение (ProvisioningService.create — форма Студии и
 * карточка бота) и смена ключей (ProductKeysService, очередь 2). Пока правила
 * жили инлайном в create(), вторая точка входа была бы копией, а копии в этом
 * модуле расходятся молча: карточка пропустила бы имя, на котором заведение
 * отказывает, и отказ всплыл бы уже у агента машины, после пересоздания
 * контейнера.
 *
 * Имена секретов становятся переменными окружения контейнера: 'A B' и 'A=1'
 * там либо теряются, либо подменяют соседнюю переменную.
 *
 * Потолки набора: без них десять мегабайт уезжают в шифротекст, в строку
 * продукта, в тело задания и дальше в env контейнера — а предел размера
 * окружения живёт в ядре хоста (ARG_MAX), и отказ был бы на чужой машине без
 * объяснения. 8 КиБ на значение — с запасом под PEM (RSA-4096 около 3.2 КиБ)
 * и JSON сервис-аккаунта; 64 имени и 64 символа на имя — предел разумного.
 */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_NAME_MAX = 64;
export const SECRET_VALUE_MAX = 8192;
export const SECRET_COUNT_MAX = 64;

/**
 * Занятые имена — ТРИ КОПИИ ОДНОЙ ПРОВЕРКИ: эта, `isReservedEnvName` агента
 * машины (product-runner/src/host/provision.ts — там же объяснение каждого
 * имени, это последний рубеж перед `docker run -e`) и форма кабинета
 * (spirits_front/src/components/products/secretNames.ts). Разъехаться им
 * нельзя: имя, которое сервер принял, а агент отверг, роняет заведение или
 * смену ключей уже после записи. Сторож — общая таблица в трёх спеках.
 *
 * OWNER_TG_ID (очередь 2) — Telegram владельца, его кладёт в окружение бота
 * сама платформа. Ключ владельца с этим именем подменил бы, кому бот
 * отвечает данными владельца.
 */
const RESERVED_SECRET_NAMES = [
  'LINKEON_URL', 'RUNNER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'PRODUCT_START_SCRIPT',
  'CHECKOUT_PATH', 'CLAUDE_BIN', 'PORT', 'HOME', 'PATH', 'NODE_OPTIONS',
  'SHELL', 'USER', 'BASH_ENV', 'ENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',
  'OWNER_TG_ID',
];
const RESERVED_SECRET_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_', 'NODE_', 'NPM_CONFIG_', 'LD_', 'GIT_', 'PM2_', 'SSL_', 'DOTENV_',
];
const RESERVED_SECRET_EXCEPTIONS = ['NODE_ENV'];

/** Без учёта регистра: `https_proxy` читают так же, как `HTTPS_PROXY`. */
export function isReservedSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (RESERVED_SECRET_EXCEPTIONS.includes(upper)) return false;
  return RESERVED_SECRET_NAMES.includes(upper) || RESERVED_SECRET_PREFIXES.some((p) => upper.startsWith(p));
}

export interface SecretProblem {
  /** Текст для человека — дословно тот, что create() отдавал до выноса. */
  message: string;
  /** Имя ключа, к которому относится отказ (карточка подсвечивает поле). */
  field?: string;
}

/**
 * Первая причина, по которой набор ключей не годится, или null.
 *
 * Порядок проверок — прежний порядок create(): сначала число, затем по
 * каждому ключу имя, длина имени, занятость, значение. Тип значения
 * проверяется ДО длины: у не-строки .length либо нет, либо он про другое.
 * Пустая строка — отказ: переменная без значения доезжает до контейнера, и бот
 * читает её как «ключа нет».
 */
export function secretsProblem(secrets: Record<string, unknown>): SecretProblem | null {
  const entries = Object.entries(secrets ?? {});
  if (entries.length > SECRET_COUNT_MAX) return { message: `секретов больше ${SECRET_COUNT_MAX}` };
  for (const [name, value] of entries) {
    if (!SECRET_NAME_RE.test(name)) {
      return { message: `имя секрета ${JSON.stringify(name)} не переменная окружения`, field: name };
    }
    if (name.length > SECRET_NAME_MAX) {
      return { message: `имя секрета длиннее ${SECRET_NAME_MAX} символов`, field: name };
    }
    if (isReservedSecretName(name)) {
      return { message: `имя секрета ${name} занято платформой — назовите ключ иначе`, field: name };
    }
    if (typeof value !== 'string' || value === '') {
      return { message: `секрет ${name}: значение должно быть непустой строкой`, field: name };
    }
    if (value.length > SECRET_VALUE_MAX) {
      return { message: `секрет ${name}: значение длиннее ${SECRET_VALUE_MAX} символов`, field: name };
    }
  }
  return null;
}
```

В `src/products/provisioning.service.ts`:

1. Импорт рядом с остальными: `import { secretsProblem } from './secret-rules';`
2. Блок со строки `// Имена секретов становятся переменными окружения контейнера.` (~139) по конец функции `isReservedSecretName` (~180) заменить на:

```ts
// Правила ключей (форма имени, потолки, занятые имена) живут в
// secret-rules.ts — их зовут и заведение, и смена ключей (очередь 2).
// Реэкспорт — ради прежних импортов и комментариев, ссылающихся сюда.
export { isReservedSecretName } from './secret-rules';
```

3. В `create()` цикл проверки (от `const entries = Object.entries(input.secrets ?? {});` до закрывающей `}` цикла `for (const [name, value] of entries)`, ~548–570) заменить на:

```ts
    const problem = secretsProblem(input.secrets ?? {});
    if (problem) throw new BadRequestException(problem.message);
```
Комментарий над циклом («Форма секретов проверяется здесь, а не в SecretsService…») оставить как есть.

Проверка: `grep -n "SECRET_\|RESERVED_SECRET" src/products/provisioning.service.ts` — пусто.

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: правила ключей в secret-rules.ts; OWNER_TG_ID — имя платформы" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/secret-rules.spec.ts src/products/provisioning.create.spec.ts src/products/provisioning.integration.spec.ts src/products/products.controller.spec.ts`. Expected: PASS, число тестов интеграционного набора — как в базовой линии. Затем tsc бэка.

---

### Task 3: Агент — `OWNER_TG_ID` занят и уезжает в контейнер бота

**Files:**
- Modify: `product-runner/src/host/provision.ts` (`RESERVED_ENV` ~142–174, `ProvisionJob` ~270–282, `dockerRunArgv` ~337–368, `provision` ~459–561)
- Test: `product-runner/src/host/provision.spec.ts` (общая таблица ~1049 и новый `describe`)

- [ ] **Step 1: Тесты**

В `product-runner/src/host/provision.spec.ts` в `RESERVED_TABLE` после строки `'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',` добавить `'OWNER_TG_ID',` (дословно как в задаче 2). В конец файла:

```ts
describe('владелец бота — OWNER_TG_ID (очередь 2)', () => {
  // Платформенная переменная рядом с RUNNER_TOKEN: по ней бот узнаёт, кому
  // отвечать данными владельца. Её кладёт сервер из привязанного Telegram
  // владельца — не владелец полем ключей (имя занято, см. таблицу выше).
  it('бот получает OWNER_TG_ID переменной окружения', async () => {
    await provision(
      job({ slug: 'bot-ulej', kind: 'bot', secrets: { BOT_TOKEN: 'т' }, ownerTgId: '123456789' }),
      deps(host),
    );
    expect(host.containers.get('bot-ulej')!.env.OWNER_TG_ID).toBe('123456789');
  });

  it('без привязки переменной нет вовсе — не пустая строка', async () => {
    await provision(job({ slug: 'bot-ulej', kind: 'bot', secrets: { BOT_TOKEN: 'т' } }), deps(host));
    expect('OWNER_TG_ID' in host.containers.get('bot-ulej')!.env).toBe(false);
  });

  it('сайт OWNER_TG_ID не получает, даже если он пришёл в задании', async () => {
    await provision(job({ ownerTgId: '123456789' }), deps(host));
    expect('OWNER_TG_ID' in host.containers.get('kafe-ulej')!.env).toBe(false);
  });

  it('не число — отказ до первого изменения на хосте', async () => {
    // Значение приезжает по сети. argv без шелла пробел в флаг не превратит,
    // но идентификатор Telegram — всегда число, и всё прочее — признак
    // поломки на сервере, а не повод заводить бота с мусором.
    await expect(
      provision(job({ slug: 'bot-ulej', kind: 'bot', secrets: { BOT_TOKEN: 'т' }, ownerTgId: '12 -e X=1' }), deps(host)),
    ).rejects.toThrow(/OWNER_TG_ID/);
    expect(host.containers.size).toBe(0);
    expect(host.dirs.size).toBe(0);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`ownerTgId` не существует в `ProvisionJob` — ts-jest агента проверяет типы)

```bash
git -C $B add product-runner/src/host/provision.spec.ts && git -C $B commit -q -m "test(runner): OWNER_TG_ID — занятое имя и переменная бота (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/provision.spec.ts`.

- [ ] **Step 3: Реализация** в `product-runner/src/host/provision.ts`

1. В `RESERVED_ENV` после `'REQUEST_TIMEOUT_MS',` (перед `];`):

```ts
  // Владелец бота (очередь 2): Telegram-идентификатор, который кладёт сама
  // платформа из привязки владельца. Ключ клиента с этим именем подменил бы,
  // кому бот отвечает данными владельца. Третья копия — secret-rules.ts на
  // сервере и secretNames.ts в кабинете.
  'OWNER_TG_ID',
```

2. В `interface ProvisionJob` после поля `customNames?`:

```ts
  /**
   * Telegram-идентификатор владельца — только у бота и только при привязанном
   * Telegram (очередь 2). Уходит в окружение `OWNER_TG_ID`, чтобы бот узнавал
   * владельца сам, без chat_id в тексте правки. Необязательное: сервер старше
   * агента поля не шлёт, а у владельца без привязки его нет.
   */
  ownerTgId?: string;
```

3. Перед `function dockerRunArgv`:

```ts
/** Идентификатор Telegram — целое число; 20 знаков с запасом над bigint. */
const OWNER_TG_ID_RE = /^\d{1,20}$/;

/**
 * OWNER_TG_ID для этого задания или undefined. Только боту: сайту владелец
 * в Telegram ни к чему, а лишняя переменная в общем окружении — лишнее, что
 * может прочитать код продукта. Не число — отказ: зовётся до первого
 * изменения на хосте. Экспорт — ради смены ключей (rekey.ts).
 */
export function ownerTgIdFor(job: { kind: ProductKind; ownerTgId?: string | null }): string | undefined {
  if (job.kind !== 'bot' || job.ownerTgId === undefined || job.ownerTgId === null) return undefined;
  if (typeof job.ownerTgId !== 'string' || !OWNER_TG_ID_RE.test(job.ownerTgId)) {
    throw new Error(`OWNER_TG_ID не число: ${JSON.stringify(job.ownerTgId)}`);
  }
  return job.ownerTgId;
}
```

4. Сигнатура `dockerRunArgv` — добавить последний параметр `ownerTgId?: string`; после строки `argv.push('-e', \`PORT=${CONTAINER_PORT}\`);`:

```ts
  if (ownerTgId !== undefined) argv.push('-e', `OWNER_TG_ID=${ownerTgId}`);
```

5. В `provision()` сразу после `const secrets = validateSecrets(job.secrets);`:

```ts
  const ownerTgId = ownerTgIdFor(job);
```
и вызов `deps.run(dockerRunArgv(job, dir, port, oauthToken, secrets, cfg))` заменить на `deps.run(dockerRunArgv(job, dir, port, oauthToken, secrets, cfg, ownerTgId))`.

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add product-runner/src/host/provision.ts && git -C $B commit -q -m "runner: OWNER_TG_ID — переменная платформы у бота, имя занято для ключей" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/provision.spec.ts src/host/index.spec.ts src/config.spec.ts`. Expected: PASS. Затем tsc агента.

---

### Task 4: Агент — симулятор хоста для пересоздания контейнера

**Files:**
- Modify: `product-runner/src/host/fake-host.ts`
- Test: `product-runner/src/host/fake-host.spec.ts`

Смене ключей нужно то, чего симулятор не умеет: прочитать контейнер целиком (`docker inspect --format '{{json .}}'`), спросить образ (`docker image inspect`), переименовать контейнер, спросить `/health` изнутри (`docker exec`). Без этого `rekey` пришлось бы проверять записью команд строками — то есть формой, а не состоянием хоста (см. шапку `sleep.spec.ts`).

- [ ] **Step 1: Тесты** — дописать в конец `product-runner/src/host/fake-host.spec.ts`:

```ts
describe('контейнер целиком и образы — для смены ключей', () => {
  it('inspect {{json .}}: образ, метка, окружение, порт, каталог, лимиты', async () => {
    host.tagImage('linkeon-product:base', 'sha256:aaa', ['PATH=/usr/bin', 'CHECKOUT_PATH=/product']);
    await host.run([
      'docker', 'run', '-d', '--name', 'shop', '--restart', 'unless-stopped', '-v', '/srv/products/shop:/product',
      '-p', '127.0.0.1:8001:3000', '-e', 'RUNNER_TOKEN=ткн', '-e', 'API_KEY=k', '--memory=1g', '--cpus=1', 'linkeon-product:base',
    ]);
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'shop']));
    expect(j.Image).toBe('sha256:aaa');
    expect(j.Config.Image).toBe('linkeon-product:base');
    expect(j.Config.Env).toEqual(['PATH=/usr/bin', 'CHECKOUT_PATH=/product', 'RUNNER_TOKEN=ткн', 'API_KEY=k']);
    expect(j.HostConfig.PortBindings).toEqual({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8001' }] });
    expect(j.HostConfig.Memory).toBe(1073741824);
    expect(j.HostConfig.NanoCpus).toBe(1e9);
    expect(j.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
    expect(j.Mounts).toEqual([{ Type: 'bind', Source: '/srv/products/shop', Destination: '/product', RW: true }]);
    expect(j.State.Running).toBe(true);
  });

  it('-e поверх переменной образа — одна строка с новым значением, как у docker', async () => {
    host.tagImage('linkeon-product:base', 'sha256:aaa', ['TZ=UTC']);
    await host.run(['docker', 'run', '-d', '--name', 'b', '--restart', 'unless-stopped', '-e', 'TZ=Europe/Moscow', 'linkeon-product:base']);
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'b']));
    expect(j.Config.Env).toEqual(['TZ=Europe/Moscow']);
  });

  it('image inspect: метки и окружение образа; передвинутая метка смотрит на новый образ', async () => {
    host.tagImage('linkeon-product:base', 'sha256:old', []);
    host.tagImage('linkeon-product:src-111111111111', 'sha256:old', []);
    host.tagImage('linkeon-product:base', 'sha256:new', ['A=1']);
    const old = JSON.parse(await host.run(['docker', 'image', 'inspect', '--format', '{{json .}}', 'sha256:old']));
    expect(old.RepoTags).toEqual(['linkeon-product:src-111111111111']);
    const base = JSON.parse(await host.run(['docker', 'image', 'inspect', '--format', '{{json .}}', 'linkeon-product:base']));
    expect(base.Id).toBe('sha256:new');
    expect(base.Config.Env).toEqual(['A=1']);
    await expect(host.run(['docker', 'image', 'inspect', '--format', '{{json .}}', 'nope:1'])).rejects.toThrow(/No such image/);
  });

  it('rename переносит контейнер вместе с остановленностью; занятое имя — отказ', async () => {
    await run('shop', 8001);
    await host.run(['docker', 'stop', 'shop']);
    await host.run(['docker', 'rename', 'shop', 'shop__rekey']);
    expect(host.containers.has('shop')).toBe(false);
    expect(host.containers.has('shop__rekey')).toBe(true);
    expect(host.isRunning('shop__rekey')).toBe(false);
    await run('shop', 8001);
    await expect(host.run(['docker', 'rename', 'shop__rekey', 'shop'])).rejects.toThrow(/Conflict/);
  });

  it('exec node: здоров по правилу теста; остановленный — отказ', async () => {
    await run('bot');
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'x'])).resolves.toBe('');
    host.healthy = () => false;
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'x'])).rejects.toThrow(/exit/);
    host.healthy = () => true;
    await host.run(['docker', 'stop', 'bot']);
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'x'])).rejects.toThrow(/not running/);
  });

  it('probePort отвечает за запущенный контейнер на порту и по тому же правилу здоровья', async () => {
    await run('shop', 8001);
    expect(host.probePort(8001)).toBe(true);
    expect(host.probePort(8002)).toBe(false);
    host.healthy = (_name, c) => c.env.API_KEY !== 'плохой';
    host.containers.get('shop')!.env.API_KEY = 'плохой';
    expect(host.probePort(8001)).toBe(false);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`tagImage`, `healthy`, `probePort` не существуют)

```bash
git -C $B add product-runner/src/host/fake-host.spec.ts && git -C $B commit -q -m "test(runner): симулятор хоста — inspect целиком, образы, rename, exec (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/fake-host.spec.ts`.

- [ ] **Step 3: Реализация** в `product-runner/src/host/fake-host.ts`

1. Тип записи контейнера в поле `containers` расширить:

```ts
  containers = new Map<
    string,
    {
      mount: string;
      publish?: string;
      env: Record<string, string>;
      /** Чем контейнер запущен — метка или идентификатор, как было в argv (`.Config.Image`). */
      image: string;
      /** Идентификатор образа, на который метка указывала В МОМЕНТ запуска (`.Image`). */
      imageId: string;
      cmd: string[];
      restart: string;
      memory?: string;
      cpus?: string;
    }
  >();
```

2. После поля `stopped` добавить образы, метки и правило здоровья:

```ts
  /**
   * Образы: идентификатор → окружение образа. Метки — отдельно: метка, как у
   * docker, ПЕРЕДВИГАЕТСЯ на новый образ (`base` после обновления образа), а
   * уже запущенный контейнер остаётся на старом идентификаторе. Ровно на этой
   * разнице стоит выбор образа при смене ключей (rekey.ts).
   */
  images = new Map<string, { env: string[] }>();
  tags = new Map<string, string>();

  /**
   * Здоров ли контейнер для `/health` — общий для `docker exec` (бот) и
   * `probePort` (сайт). По умолчанию здоров любой запущенный; тест подменяет
   * правило, чтобы «нездоровым» был именно контейнер с плохими ключами.
   */
  healthy: (name: string, c: { env: Record<string, string> }) => boolean = () => true;

  /** Завести образ под меткой (или передвинуть метку на другой образ). */
  tagImage(tag: string, id: string, env: string[] = []): void {
    this.images.set(id, { env });
    this.tags.set(tag, id);
  }

  /** Идентификатор по метке или идентификатору; незнакомая метка заводит пустой образ. */
  private resolveImage(ref: string): string {
    if (this.images.has(ref)) return ref;
    const id = this.tags.get(ref);
    if (id) return id;
    const fresh = `sha256:fake-${ref}`;
    this.tagImage(ref, fresh, []);
    return fresh;
  }

  /** Сайт отвечает на порту: запущенный контейнер с этой публикацией и здоровый. */
  probePort(port: number): boolean {
    for (const [name, c] of this.containers) {
      if (this.stopped.has(name) || !c.publish) continue;
      if (Number(c.publish.split(':')[1]) === port) return this.healthy(name, c);
    }
    return false;
  }
```

3. В `docker(rest)` перед строкой `throw new Error(\`docker ${sub}: неизвестная подкоманда\`);`:

```ts
    if (sub === 'rename') {
      const [from, to, ...extra] = args;
      if (!from || !to || extra.length) throw new Error(`docker rename: ${args.join(' ')}`);
      if (!this.containers.has(from)) throw new Error(`No such container: ${from}`);
      if (this.containers.has(to)) throw new Error(`Conflict. The container name "/${to}" is already in use`);
      this.containers.set(to, this.containers.get(from)!);
      this.containers.delete(from);
      if (this.stopped.delete(from)) this.stopped.add(to);
      return '';
    }
    if (sub === 'exec') {
      // Ровно та форма, которой смена ключей спрашивает /health бота:
      // `docker exec <имя> node -e <скрипт>`. Прочее — отказ.
      const [name, bin, flag] = args;
      if (bin !== 'node' || flag !== '-e' || args.length !== 4) throw new Error(`docker exec: симулятор знает только node -e: ${args.join(' ')}`);
      if (!this.containers.has(name)) throw new Error(`No such container: ${name}`);
      if (this.stopped.has(name)) throw new Error(`Error response from daemon: container ${name} is not running`);
      if (!this.healthy(name, this.containers.get(name)!)) throw new Error('Command failed: exit status 1');
      return '';
    }
    if (sub === 'image') {
      const [verb, flag, format, ref, ...extra] = args;
      if (verb !== 'inspect' || flag !== '--format' || format !== '{{json .}}' || !ref || extra.length) {
        throw new Error(`docker image: симулятор знает только inspect --format {{json .}} <образ>: ${args.join(' ')}`);
      }
      const id = this.images.has(ref) ? ref : this.tags.get(ref);
      if (!id) throw new Error(`Error: No such image: ${ref}`);
      const repoTags = [...this.tags.entries()].filter(([, v]) => v === id).map(([t]) => t);
      return `${JSON.stringify({ Id: id, RepoTags: repoTags, Config: { Env: this.images.get(id)!.env } })}\n`;
    }
```

4. В начале `dockerInspect` (сразу после разбора `[flag, format, name, ...extra]` и проверки формы) — ветка целого контейнера:

```ts
    if (format === '{{json .}}') {
      if (!this.containers.has(name)) throw new Error(`Error: No such object: ${name}`);
      return `${JSON.stringify(this.inspectWhole(name))}\n`;
    }
```
и метод рядом с `dockerInspect`:

```ts
  /**
   * Контейнер целиком — в форме `docker inspect --format '{{json .}}'`.
   * Config.Env, как у docker: переменные образа, затем свои; своя с тем же
   * именем заменяет переменную образа (одна строка, новое значение).
   */
  private inspectWhole(name: string): any {
    const c = this.containers.get(name)!;
    const own = new Set(Object.keys(c.env));
    const imageEnv = (this.images.get(c.imageId)?.env ?? []).filter((e) => !own.has(e.slice(0, e.indexOf('='))));
    const [hostIp, hostPort, containerPort] = c.publish ? c.publish.split(':') : [];
    const [source, destination] = c.mount ? c.mount.split(':') : [];
    return {
      Name: `/${name}`,
      Image: c.imageId,
      Config: { Image: c.image, Env: [...imageEnv, ...Object.entries(c.env).map(([k, v]) => `${k}=${v}`)] },
      State: { Running: !this.stopped.has(name), Status: this.stopped.has(name) ? 'exited' : 'running' },
      HostConfig: {
        PortBindings: c.publish ? { [`${containerPort}/tcp`]: [{ HostIp: hostIp, HostPort: hostPort }] } : {},
        Memory: memoryBytes(c.memory),
        NanoCpus: c.cpus ? Math.round(Number(c.cpus) * 1e9) : 0,
        RestartPolicy: { Name: c.restart },
        NetworkMode: 'bridge',
        Privileged: false,
      },
      Mounts: c.mount ? [{ Type: 'bind', Source: source, Destination: destination, RW: true }] : [],
    };
  }
```
и функцию на уровне модуля (над `export const OAUTH`):

```ts
/** `--memory=1g` / `--memory=1073741824` → байты, как в HostConfig.Memory. */
function memoryBytes(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /^(\d+(?:\.\d+)?)([kmg]?)$/i.exec(raw);
  if (!m) throw new Error(`--memory: непонятное значение ${raw}`);
  const mul = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * mul);
}
```

5. В `dockerRun`: объявить `let memory: string | undefined; let cpus: string | undefined;`, строку `if (a.startsWith('--memory=') || a.startsWith('--cpus=')) continue;` заменить на

```ts
      if (a.startsWith('--memory=')) { memory = a.slice('--memory='.length); continue; }
      if (a.startsWith('--cpus=')) { cpus = a.slice('--cpus='.length); continue; }
```
и запись `this.containers.set(name, { mount, publish, env, image, cmd });` — на

```ts
    this.containers.set(name, { mount, publish, env, image, imageId: this.resolveImage(image), cmd, restart, memory, cpus });
```

- [ ] **Step 4: Коммит, прогон — PASS** (весь пакет: симулятор общий для всех батарей)

```bash
git -C $B add product-runner/src/host/fake-host.ts && git -C $B commit -q -m "runner: симулятор хоста — контейнер целиком, образы и метки, rename, exec" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): без списка файлов (`npx jest`). Expected: все наборы PASS (число тестов выросло на добавленные задачами 3–4, падений нет). Затем tsc агента.

---

### Task 5: Агент — смена ключей (`rekey`) с откатом

**Files:**
- Create: `product-runner/src/host/rekey.ts`
- Modify: `product-runner/src/host/provision.ts` (экспорт `validateSecrets` и `containerTaken`; поле `waitInside` в `ProvisionDeps`)
- Test: `product-runner/src/host/rekey.spec.ts` (новый)

Форма пересоздания — та же, что у `scripts/product-image-roll.sh` (`do_recreate`/`do_restore`), где она обкатана на живых клиентах: настройки снимаются с живого контейнера ДО разрушения, старый контейнер не удаляется, а переименовывается и живёт, пока новый не доказал здоровье (в нём единственная копия `RUNNER_TOKEN` — сервер хранит только sha256). Отличия: вместо строк шаблона — `{{json .}}` и разбор в коде (значение с переводом строки не ломает счёт строк), а меняются только ключи владельца.

- [ ] **Step 1: Тесты**

`product-runner/src/host/rekey.spec.ts`:

```ts
/**
 * Смена ключей против симулятора хоста. Спрашивается СОСТОЯНИЕ хоста (какой
 * контейнер жив, с каким окружением, на каком образе и порту), а не форма
 * команд — см. шапку sleep.spec.ts.
 */
import { FakeHost, OAUTH, deps } from './fake-host';
import { ProvisionDeps, provision } from './provision';
import { REKEY_BACKUP_SUFFIX, rekeyProduct, RekeyJob } from './rekey';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

async function seedBot(slug = 'bot1', secrets: Record<string, string> = { BOT_TOKEN: 'old', API_KEY: 'k1' }) {
  await provision({ slug, kind: 'bot', name: 'Бот', runnerToken: 'ткн-раннера', secrets }, deps(host));
}
async function seedSite(slug = 'shop', secrets: Record<string, string> = { API_KEY: 'k1' }) {
  return (await provision({ slug, kind: 'site', name: 'Сайт', runnerToken: 'ткн-раннера', secrets }, deps(host))).port!;
}
const botJob = (over: Partial<RekeyJob> = {}): RekeyJob => ({
  slug: 'bot1', kind: 'bot', secrets: { BOT_TOKEN: 'new', NEW_KEY: 'n' }, dropNames: ['API_KEY'], ...over,
});
/** Сайт «отвечает» ровно тогда, когда симулятор считает его здоровым; срок — ноль, чтобы отказ не ждал минуту. */
const siteDeps = (over: Partial<ProvisionDeps> = {}) =>
  deps(host, { waitPort: async (p) => host.probePort(p), waitPortTimeoutMs: 0, ...over });

describe('смена ключей: успех', () => {
  it('бот: новые ключи в окружении, снятые ушли, переменные платформы на месте', async () => {
    await seedBot();
    await rekeyProduct(botJob(), deps(host, { waitPortTimeoutMs: 0 }));

    const c = host.containers.get('bot1')!;
    expect(c.env.BOT_TOKEN).toBe('new');
    expect(c.env.NEW_KEY).toBe('n');
    expect('API_KEY' in c.env).toBe(false);
    expect(c.env.RUNNER_TOKEN).toBe('ткн-раннера');
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(c.env.LINKEON_URL).toBeTruthy();
    expect(c.mount).toBe('/srv/products/bot1:/product');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('сайт: тот же порт, домен не трогается вовсе', async () => {
    const port = await seedSite();
    const vhostCalls = host.ran('product-vhost').length;
    await rekeyProduct({ slug: 'shop', kind: 'site', secrets: { API_KEY: 'k2' }, dropNames: [] }, siteDeps());

    expect(host.containers.get('shop')!.publish).toBe(`127.0.0.1:${port}:3000`);
    expect(host.containers.get('shop')!.env.API_KEY).toBe('k2');
    expect(host.vhostMode('shop')).toBe('live');
    expect(host.ran('product-vhost').length).toBe(vhostCalls);
  });

  it('переменные, о которых сервер не знает, остаются как были', async () => {
    // У продуктов, заведённых руками (product-provision.sh), в окружении бывает
    // то, чего нет в зашифрованном наборе. Снимать их нельзя: сервер о них не
    // знает и вернуть не сможет.
    await seedBot();
    host.containers.get('bot1')!.env.HAND_MADE = '1';
    await rekeyProduct(botJob(), deps(host, { waitPortTimeoutMs: 0 }));
    expect(host.containers.get('bot1')!.env.HAND_MADE).toBe('1');
  });

  it('OWNER_TG_ID из задания ставится боту рядом с ключами', async () => {
    await seedBot();
    await rekeyProduct(botJob({ ownerTgId: '42' }), deps(host, { waitPortTimeoutMs: 0 }));
    expect(host.containers.get('bot1')!.env.OWNER_TG_ID).toBe('42');
  });

  it('метка образа на месте — запуск по ней же: контейнер остаётся в отборе обновления образа', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    await seedBot();
    await rekeyProduct(botJob(), deps(host, { waitPortTimeoutMs: 0 }));
    expect(host.containers.get('bot1')!.image).toBe('linkeon-product:base');
    expect(host.containers.get('bot1')!.imageId).toBe('sha256:v1');
  });

  it('метку передвинули — тот же образ по его стабильной метке, а не новый образ', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    host.tagImage('linkeon-product:src-aaaaaaaaaaaa', 'sha256:v1', []);
    await seedBot();
    host.tagImage('linkeon-product:base', 'sha256:v2', []);
    await rekeyProduct(botJob(), deps(host, { waitPortTimeoutMs: 0 }));
    expect(host.containers.get('bot1')!.imageId).toBe('sha256:v1');
    expect(host.containers.get('bot1')!.image).toBe('linkeon-product:src-aaaaaaaaaaaa');
  });
});

describe('смена ключей: откат и отказы', () => {
  it('нездоровый бот — откат: старый контейнер со старыми ключами в работе', async () => {
    await seedBot();
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'плохой';
    await expect(rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'плохой' } }), deps(host, { waitPortTimeoutMs: 0 })))
      .rejects.toThrow(/ключи не применены.*старыми ключами/);
    const c = host.containers.get('bot1')!;
    expect(c.env.BOT_TOKEN).toBe('old');
    expect(c.env.API_KEY).toBe('k1');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('нездоровый сайт — откат, порт и домен прежние', async () => {
    const port = await seedSite();
    host.healthy = (_name, c) => c.env.API_KEY !== 'плохой';
    await expect(rekeyProduct({ slug: 'shop', kind: 'site', secrets: { API_KEY: 'плохой' }, dropNames: [] }, siteDeps()))
      .rejects.toThrow(/ключи не применены/);
    expect(host.containers.get('shop')!.env.API_KEY).toBe('k1');
    expect(host.isRunning('shop')).toBe(true);
    expect(host.probePort(port)).toBe(true);
    expect(host.vhostMode('shop')).toBe('live');
  });

  it('docker run отказал — откат, и в причине нет значений ключей', async () => {
    await seedBot();
    host.before = (argv) => {
      if (argv[1] === 'run' && argv.includes('BOT_TOKEN=секрет-новый')) {
        throw new Error(`Command failed: ${argv.join(' ')}\ndocker: Error response from daemon: boom`);
      }
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'секрет-новый' } }), deps(host, { waitPortTimeoutMs: 0 }))
      .catch((e) => e);
    expect(String(err.message)).toMatch(/boom/);
    expect(String(err.message)).not.toContain('секрет-новый');
    expect(String(err.message)).not.toContain('ткн-раннера');
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.isRunning('bot1')).toBe(true);
  });

  it('остаток прерванной смены — отказ до любого изменения', async () => {
    await seedBot();
    await host.run(['docker', 'run', '-d', '--name', `bot1${REKEY_BACKUP_SUFFIX}`, '--restart', 'unless-stopped', 'linkeon-product:base']);
    host.calls.length = 0;
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/прерванной смены ключей/);
    expect(host.calls.some((c) => c[1] === 'stop' || c[1] === 'rename' || c[1] === 'run')).toBe(false);
  });

  it('спящему продукту ключи не меняются', async () => {
    await seedBot();
    await host.run(['docker', 'stop', 'bot1']);
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/не запущен/);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
  });

  it('метки того же образа нет — отказ до изменений', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    await seedBot();
    host.tagImage('linkeon-product:base', 'sha256:v2', []);
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/не помечен/);
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
  });

  it('без RUNNER_TOKEN в окружении — отказ до изменений: пересоздание потеряло бы раннер', async () => {
    await host.run(['docker', 'run', '-d', '--name', 'bot1', '--restart', 'unless-stopped', '-e', 'LINKEON_URL=https://x', 'linkeon-product:base']);
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/RUNNER_TOKEN/);
    expect(host.calls.some((c) => c[1] === 'stop')).toBe(false);
  });

  it('занятое имя в новом наборе или в снимаемых — отказ до изменений', async () => {
    await seedBot();
    await expect(rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'n', RUNNER_TOKEN: 'подмена' } }), deps(host))).rejects.toThrow(/занято/);
    await expect(rekeyProduct(botJob({ dropNames: ['LINKEON_URL'] }), deps(host))).rejects.toThrow(/платформы/);
    expect(host.containers.get('bot1')!.env.RUNNER_TOKEN).toBe('ткн-раннера');
  });

  it('бот без BOT_TOKEN в новом наборе — отказ', async () => {
    await seedBot();
    await expect(rekeyProduct(botJob({ secrets: { NEW_KEY: 'n' } }), deps(host))).rejects.toThrow(/BOT_TOKEN/);
  });

  it('слаг не по форме — отказ до первого вызова docker', async () => {
    await expect(rekeyProduct(botJob({ slug: '../x' }), deps(host))).rejects.toThrow(/слаг/);
    expect(host.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`Cannot find module './rekey'`)

```bash
git -C $B add product-runner/src/host/rekey.spec.ts && git -C $B commit -q -m "test(runner): смена ключей — пересоздание, откат, отказы до изменений (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/rekey.spec.ts`.

- [ ] **Step 3: Экспорт и зависимость в `provision.ts`**

1. `function validateSecrets(` → `export function validateSecrets(`; `async function containerTaken(` → `export async function containerTaken(` (комментарий над каждой: «Экспорт — ради rekey.ts и purge.ts: проверка одна на все хостовые шаги»).
2. В `interface ProvisionDeps` после `waitPort`:

```ts
  /**
   * Ответил ли продукт на /health ИЗНУТРИ контейнера (бот порта не публикует).
   * Необязательное: по умолчанию — `docker exec … node -e` через этот же run
   * (rekey.ts, waitInsideVia), подмена — только для тестов.
   */
  waitInside?: (slug: string, timeoutMs: number) => Promise<boolean>;
```

- [ ] **Step 4: Реализация**

`product-runner/src/host/rekey.ts`:

```ts
/**
 * СМЕНА КЛЮЧЕЙ ВЛАДЕЛЬЦА — задание `rekey` (очередь 2).
 *
 * Переменные окружения контейнера задаются один раз, при `docker run`, —
 * поменять их можно только пересозданием. Пересоздаётся с ТЕМ ЖЕ образом,
 * портом, каталогом, лимитами и переменными платформы; меняются только ключи
 * владельца: `dropNames` и имена нового набора уходят, новый набор приходит.
 *
 * ## Почему настройки — с живого контейнера, а не «как при заведении»
 *
 * В контейнере лежит RUNNER_TOKEN, и взять его второй раз негде: сервер хранит
 * только sha256 (см. шапку sleep.ts). Рядом с ним так же молча потерялись бы
 * порт, привязка каталога и лимиты. Поэтому всё снимается `docker inspect`
 * ДО первого разрушающего шага, а старый контейнер не удаляется, а
 * переименовывается в `<слаг>__rekey` и живёт, пока новый не доказал здоровье.
 * Та же форма, что у scripts/product-image-roll.sh (do_recreate/do_restore).
 *
 * ## Почему JSON, а не шаблоны по строке
 *
 * product-image-roll.sh читает `.Config.Env` построчно и потому сторожит
 * число строк против `{{len .Config.Env}}`: значение с переводом строки
 * (приватный ключ PEM) иначе разваливается на две переменные. Здесь
 * `{{json .}}` и разбор в коде — перевод строки внутри значения ничего не
 * ломает, а приватные ключи владельцы как раз и присылают.
 *
 * ## Образ — тот же, запуск — по метке
 *
 * Запуск по голому идентификатору выбросил бы контейнер из отбора
 * product-image-roll.sh НАВСЕГДА (отбор по `.Config.Image` с префиксом
 * `linkeon-product:`): раннер внутри перестал бы обновляться. Поэтому по
 * `.Config.Image`, если метка по-прежнему указывает на образ контейнера; если
 * её передвинули (контейнер пропущен прошлым обновлением образа) — по
 * стабильной метке `linkeon-product:src-*` того же образа; нет такой — отказ
 * ДО изменений: смена ключей не должна втихую менять раннер.
 *
 * ## Здоровье
 *
 * Сайт — тот же `waitPort`, что у заведения и пробуждения (200 и `sha` с
 * опубликованного порта). Бот наружу ничего не публикует, его `/health`
 * слушает 127.0.0.1:3000 внутри контейнера — спрашиваем изнутри, `docker
 * exec … node -e`, и требуем `"ok":true`. Нездоров — откат: новый контейнер
 * снимается, старый получает имя обратно и поднимается.
 *
 * ## Чего здесь нет
 *
 * vhost не трогается: порт тот же. Причина отказа `docker run` берётся только
 * из stderr: в `message` execFile лежит вся командная строка, а в ней —
 * значения старых ключей, которых нет в задании и которые маска `redact` по
 * известным значениям не знает.
 */
import { isReservedEnvName, containerTaken, CONTAINER_PORT, DEFAULTS, ownerTgIdFor, ProvisionDeps, SLUG_RE, validateSecrets } from './provision';
import { ProductKind } from './skeleton';

export interface RekeyJob {
  slug: string;
  kind: ProductKind;
  /** ПОЛНЫЙ новый набор ключей владельца (после замены, удаления и добавления). */
  secrets: Record<string, string>;
  /** Имена старых ключей, которых в новом наборе нет: уходят из окружения. */
  dropNames: string[];
  /** Telegram владельца бота — ставится рядом с ключами (см. ownerTgIdFor). */
  ownerTgId?: string;
}

/** Имя старого контейнера на время смены. Не `__pre_`: то — страховка обновления образа. */
export const REKEY_BACKUP_SUFFIX = '__rekey';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STABLE_TAG_RE = /^linkeon-product:src-[0-9a-f]{12}$/;

/** /health изнутри контейнера бота: выход 0 только при `"ok":true`. */
const HEALTH_INSIDE =
  `fetch('http://127.0.0.1:${CONTAINER_PORT}/health',{signal:AbortSignal.timeout(2000)})` +
  '.then((r)=>r.json()).then((b)=>process.exit(b&&b.ok===true?0:1),()=>process.exit(1))';

/** Ожидание /health изнутри — по умолчанию для ProvisionDeps.waitInside. */
export function waitInsideVia(deps: ProvisionDeps): (slug: string, timeoutMs: number) => Promise<boolean> {
  return async (slug, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await deps.run(['docker', 'exec', slug, 'node', '-e', HEALTH_INSIDE]);
        return true;
      } catch {
        // Ещё не поднялся или нездоров — спросим снова до срока.
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, DEFAULTS.probeEveryMs));
    }
  };
}

/**
 * Причина отказа программы без командной строки. execFile кладёт в message
 * «Command failed: <весь argv>\n<stderr>» — argv со значениями ключей наружу
 * не идёт; без этой приставки (наш собственный throw) — текст как есть.
 */
function reasonOf(e: any): string {
  const m = String(e?.message ?? e ?? '').trim();
  if (!m.startsWith('Command failed:')) return m.slice(0, 300) || 'без причины';
  const nl = m.indexOf('\n');
  return (nl >= 0 ? m.slice(nl + 1).trim() : '').slice(0, 300) || 'без причины';
}

async function inspectJson(deps: ProvisionDeps, argv: string[]): Promise<any> {
  const out = await deps.run(argv);
  try {
    return JSON.parse(out);
  } catch {
    // Вывод inspect несёт окружение с ключами — в текст отказа он не идёт.
    throw new Error(`${argv.slice(0, 3).join(' ')}: ответ не JSON — ничего не тронуто`);
  }
}

function envName(entry: string): string {
  const i = entry.indexOf('=');
  return i >= 0 ? entry.slice(0, i) : entry;
}

function validateDropNames(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('dropNames — не список');
  for (const n of raw) {
    if (typeof n !== 'string' || !ENV_NAME_RE.test(n)) throw new Error(`имя снимаемого ключа не годится: ${JSON.stringify(n)}`);
    // Сервер шлёт только имена ключей владельца. Переменная платформы здесь —
    // поломка на сервере, а снять её значило бы остаться без раннера.
    if (isReservedEnvName(n)) throw new Error(`снимать переменную платформы нельзя: ${n}`);
  }
  return raw as string[];
}

/** Что снято с живого контейнера ДО любого разрушения. */
interface Captured {
  imageRef: string;
  ownEnv: string[];
  publish: string[];
  mounts: string[];
  restart: string;
  memory: number;
  nanoCpus: number;
  /** Порт хоста для /health сайта. */
  port?: number;
}

async function capture(job: RekeyJob, deps: ProvisionDeps): Promise<Captured> {
  const c = await inspectJson(deps, ['docker', 'inspect', '--format', '{{json .}}', job.slug]);
  if (c?.State?.Running !== true) {
    throw new Error(`контейнер ${job.slug} не запущен — ключи спящему продукту не меняются, ничего не тронуто`);
  }
  const net = c?.HostConfig?.NetworkMode;
  if (net !== 'bridge' && net !== 'default') throw new Error(`сеть контейнера ${JSON.stringify(net)} воспроизвести не умею — ничего не тронуто`);
  if (c?.HostConfig?.Privileged === true) throw new Error('контейнер privileged — воспроизвести не умею, ничего не тронуто');

  const imageId = String(c?.Image ?? '');
  const configImage = String(c?.Config?.Image ?? '');
  if (!imageId) throw new Error(`у контейнера ${job.slug} нет образа — ничего не тронуто`);
  const img = await inspectJson(deps, ['docker', 'image', 'inspect', '--format', '{{json .}}', imageId]);

  let imageRef: string | undefined;
  if (configImage && configImage !== imageId) {
    try {
      const byTag = await inspectJson(deps, ['docker', 'image', 'inspect', '--format', '{{json .}}', configImage]);
      if (byTag?.Id === imageId) imageRef = configImage;
    } catch {
      // Метки больше нет — ищем стабильную ниже.
    }
  }
  if (!imageRef) {
    const tags: string[] = Array.isArray(img?.RepoTags) ? img.RepoTags : [];
    imageRef = tags.find((t) => STABLE_TAG_RE.test(t));
  }
  if (!imageRef) {
    throw new Error(
      `образ контейнера ${job.slug} больше не помечен — смена ключей сменила бы и раннер; ` +
        'ключи сменятся после обновления образа (product-image-roll.sh), ничего не тронуто',
    );
  }

  // Свои переменные = контейнерные МИНУС пришедшие из ТОГО образа, с которого
  // контейнер запущен: вернуть переменные образа флагом -e значило бы
  // законсервировать старое значение по умолчанию (довод product-image-roll.sh).
  const imageEnv = new Set<string>(Array.isArray(img?.Config?.Env) ? img.Config.Env : []);
  const env: unknown[] = Array.isArray(c?.Config?.Env) ? c.Config.Env : [];
  const ownEnv = env.filter((e): e is string => typeof e === 'string' && !imageEnv.has(e));
  const filled = (name: string) => ownEnv.some((e) => envName(e) === name && e.length > name.length + 1);
  if (!filled('RUNNER_TOKEN') || !filled('LINKEON_URL')) {
    throw new Error(`в окружении ${job.slug} нет RUNNER_TOKEN или LINKEON_URL — пересоздание потеряло бы раннер, ничего не тронуто`);
  }

  const publish: string[] = [];
  let port: number | undefined;
  for (const [key, binds] of Object.entries(c?.HostConfig?.PortBindings ?? {})) {
    const m = /^(\d+)\/tcp$/.exec(key);
    if (!m || !Array.isArray(binds)) throw new Error(`публикацию ${key} воспроизвести не умею — ничего не тронуто`);
    for (const b of binds as any[]) {
      const hostPort = String(b?.HostPort ?? '');
      if (!/^\d+$/.test(hostPort)) throw new Error(`публикацию ${key} воспроизвести не умею — ничего не тронуто`);
      publish.push(`${b?.HostIp ? `${b.HostIp}:` : ''}${hostPort}:${m[1]}`);
      if (Number(m[1]) === CONTAINER_PORT) port = Number(hostPort);
    }
  }

  const mounts: string[] = [];
  for (const m of Array.isArray(c?.Mounts) ? c.Mounts : []) {
    if (m?.Type !== 'bind' || !m?.Source || !m?.Destination) {
      throw new Error('монтирование не bind — воспроизвести не умею, ничего не тронуто');
    }
    mounts.push(`${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  }

  return {
    imageRef,
    ownEnv,
    publish,
    mounts,
    restart: String(c?.HostConfig?.RestartPolicy?.Name ?? ''),
    memory: Number(c?.HostConfig?.Memory ?? 0),
    nanoCpus: Number(c?.HostConfig?.NanoCpus ?? 0),
    port,
  };
}

/** Окружение нового контейнера: свои переменные без заменяемых имён + новый набор. */
export function rekeyEnv(ownEnv: string[], secrets: Array<[string, string]>, dropNames: string[], ownerTgId?: string): string[] {
  const replaced = new Set<string>([...dropNames, ...secrets.map(([k]) => k)]);
  if (ownerTgId !== undefined) replaced.add('OWNER_TG_ID');
  const kept = ownEnv.filter((e) => !replaced.has(envName(e)));
  const added = secrets.map(([k, v]) => `${k}=${v}`);
  return ownerTgId !== undefined ? [...kept, ...added, `OWNER_TG_ID=${ownerTgId}`] : [...kept, ...added];
}

function runArgv(slug: string, cap: Captured, env: string[]): string[] {
  const argv = ['docker', 'run', '-d', '--name', slug];
  if (cap.restart && cap.restart !== 'no') argv.push('--restart', cap.restart);
  for (const m of cap.mounts) argv.push('-v', m);
  for (const p of cap.publish) argv.push('-p', p);
  for (const e of env) argv.push('-e', e);
  if (cap.memory > 0) argv.push(`--memory=${cap.memory}`);
  if (cap.nanoCpus > 0) argv.push(`--cpus=${(cap.nanoCpus / 1e9).toFixed(3)}`);
  argv.push(cap.imageRef);
  return argv;
}

/** Вернуть старый контейнер. Пустой список — продукт снова со старыми ключами. */
async function rollback(slug: string, backup: string, deps: ProvisionDeps): Promise<string[]> {
  try {
    if (await containerTaken(deps, slug)) await deps.run(['docker', 'rm', '-f', slug]);
  } catch (e: any) {
    return [`новый контейнер ${slug} не снят (${reasonOf(e)}); старый лежит под именем ${backup}`];
  }
  try {
    await deps.run(['docker', 'rename', backup, slug]);
  } catch (e: any) {
    return [`старый контейнер не вернул имя и лежит под ${backup} (${reasonOf(e)})`];
  }
  try {
    await deps.run(['docker', 'start', slug]);
  } catch (e: any) {
    return [`старый контейнер ${slug} не поднялся (${reasonOf(e)})`];
  }
  return [];
}

/** Сменить ключи владельца. Бросает на любом отказе; до `docker stop` — без изменений на хосте. */
export async function rekeyProduct(job: RekeyJob, deps: ProvisionDeps): Promise<void> {
  const phase = deps.onPhase ?? (() => {});

  // --- Всё, что может отказать, — до первого изменения на хосте. ---
  if (!SLUG_RE.test(job.slug)) throw new Error(`слаг не годится: ${JSON.stringify(job.slug)}`);
  if (job.kind !== 'site' && job.kind !== 'bot') throw new Error(`неизвестная форма продукта: ${JSON.stringify(job.kind)}`);
  const secrets = validateSecrets(job.secrets);
  if (job.kind === 'bot' && !secrets.some(([k]) => k === 'BOT_TOKEN')) {
    throw new Error('в новом наборе нет BOT_TOKEN — бот остался бы без токена, ничего не тронуто');
  }
  const dropNames = validateDropNames(job.dropNames);
  const ownerTgId = ownerTgIdFor(job);
  const backup = `${job.slug}${REKEY_BACKUP_SUFFIX}`;
  if (await containerTaken(deps, backup)) {
    throw new Error(`на хосте остался ${backup} от прерванной смены ключей — сверить руками, ничего не тронуто`);
  }
  const cap = await capture(job, deps);
  if (job.kind === 'site' && cap.port === undefined) {
    throw new Error(`у сайта ${job.slug} нет опубликованного порта — проверить здоровье нечем, ничего не тронуто`);
  }
  const argv = runArgv(job.slug, cap, rekeyEnv(cap.ownEnv, secrets, dropNames, ownerTgId));

  // --- Дальше — разрушающая часть. ---
  await deps.run(['docker', 'stop', job.slug]);
  try {
    await deps.run(['docker', 'rename', job.slug, backup]);
  } catch (e: any) {
    await deps.run(['docker', 'start', job.slug]).catch(() => undefined);
    throw new Error(`docker rename отказал — контейнер возвращён в работу со старыми ключами: ${reasonOf(e)}`);
  }

  let reason: string | undefined;
  try {
    await deps.run(argv);
    const timeoutMs = deps.waitPortTimeoutMs ?? DEFAULTS.waitPortTimeoutMs;
    const healthy = job.kind === 'site'
      ? await deps.waitPort(cap.port as number, timeoutMs)
      : await (deps.waitInside ?? waitInsideVia(deps))(job.slug, timeoutMs);
    if (!healthy) reason = `продукт не ответил на /health за ${Math.round(timeoutMs / 1000)} с с новыми ключами`;
  } catch (e: any) {
    reason = `docker run с новыми ключами отказал: ${reasonOf(e)}`;
  }

  if (reason === undefined) {
    phase(`ключи ${job.slug} сменены`);
    try {
      await deps.run(['docker', 'rm', '-f', backup]);
    } catch (e: any) {
      // Ключи уже новые, отказывать поздно. Но в старом контейнере лежат
      // СТАРЫЕ ключи — и следующая смена откажет на нём (см. начало функции).
      phase(`ВНИМАНИЕ: старый контейнер ${backup} со старыми ключами не убран (${reasonOf(e)}) — убрать руками`);
    }
    return;
  }

  const left = await rollback(job.slug, backup, deps);
  const err = new Error(
    `ключи не применены: ${reason}; ` + (left.length ? 'откат не удался' : 'продукт возвращён со старыми ключами'),
  );
  if (left.length) (err as any).leftovers = left;
  throw err;
}
```

- [ ] **Step 5: Коммит, прогон — PASS**

```bash
git -C $B add product-runner/src/host && git -C $B commit -q -m "runner: смена ключей — пересоздание тем же образом с откатом на нездоровье" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/rekey.spec.ts src/host/provision.spec.ts src/host/sleep.spec.ts src/host/fake-host.spec.ts`. Expected: PASS. Затем tsc агента.

---

### Task 6: Агент — стирание (`purge`) со строгой проверкой пути

**Files:**
- Create: `product-runner/src/host/purge.ts`
- Test: `product-runner/src/host/purge.spec.ts` (новый)

- [ ] **Step 1: Тесты**

`product-runner/src/host/purge.spec.ts`:

```ts
import { FakeHost, deps } from './fake-host';
import { provision } from './provision';
import { productDirFor, purgeProduct } from './purge';
import { REKEY_BACKUP_SUFFIX } from './rekey';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

const seed = (slug: string, kind: 'site' | 'bot' = 'site') =>
  provision({ slug, kind, name: slug, runnerToken: 'ткн', secrets: kind === 'bot' ? { BOT_TOKEN: 'т' } : {} }, deps(host));

describe('стирание', () => {
  it('сайт: vhost, сертификат своего домена, контейнер и каталог — всё снято', async () => {
    await seed('shop');
    host.certs.add('linkeon-shop');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect(host.isClean('shop')).toBe(true);
    expect(host.certs.has('linkeon-shop')).toBe(false);
    expect(host.removedDirs).toEqual(['/srv/products/shop']);
  });

  it('vhost снимается ДО контейнера: иначе порт ушёл бы соседу под живым доменом', async () => {
    await seed('shop');
    host.calls.length = 0;
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    const reload = host.calls.findIndex((c) => c[0] === 'systemctl');
    const rm = host.calls.findIndex((c) => c[0] === 'docker' && c[1] === 'rm');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(reload);
  });

  it('бот: контейнер и каталог; nginx и certbot не зовутся', async () => {
    await seed('bot1', 'bot');
    host.calls.length = 0;
    await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host));
    expect(host.isClean('bot1')).toBe(true);
    expect(host.calls.some((c) => c[0] === 'systemctl' || c[0] === 'certbot' || c[0] === 'rm')).toBe(false);
  });

  it('спящий (остановленный) контейнер и остаток прерванной смены ключей тоже снимаются', async () => {
    await seed('bot1', 'bot');
    await host.run(['docker', 'stop', 'bot1']);
    await host.run(['docker', 'rename', 'bot1', `bot1${REKEY_BACKUP_SUFFIX}`]);
    await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host));
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
    expect(host.isClean('bot1')).toBe(true);
  });

  it('повтор стирания проходит: потерянный отчёт не превращается в вечный отказ', async () => {
    await seed('shop');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).resolves.toBeUndefined();
  });

  it('соседний продукт не тронут', async () => {
    await seed('shop');
    await seed('shop2');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect(host.dirs.has('/srv/products/shop2')).toBe(true);
    expect(host.isRunning('shop2')).toBe(true);
    expect(host.vhostMode('shop2')).toBe('live');
  });

  it('vhost не снялся — контейнер и каталог остаются: порт держит живой домен', async () => {
    await seed('shop');
    host.before = (argv) => {
      if (argv[0] === 'systemctl') throw new Error('Job for nginx.service failed');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/nginx/);
    expect(host.containers.has('shop')).toBe(true);
    expect(host.dirs.has('/srv/products/shop')).toBe(true);
  });

  it('certbot отказал не «нет сертификата» — отказ, контейнер цел', async () => {
    await seed('shop');
    host.certs.add('linkeon-shop');
    host.before = (argv) => {
      if (argv[0] === 'certbot') throw new Error('Another instance of Certbot is already running');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/certbot/i);
    expect(host.containers.has('shop')).toBe(true);
  });
});

describe('путь стирания — только /srv/products/<слаг>', () => {
  it.each(['', '.', '..', 'a/b', '../etc', 'shop/..', '-rf', 'SHOP', 'shop ', 'shop\nx'])(
    'слаг %j — отказ до ЛЮБОГО вызова',
    async (slug) => {
      await expect(purgeProduct({ slug, kind: 'site' }, deps(host))).rejects.toThrow(/слаг/);
      expect(host.calls).toHaveLength(0);
      expect(host.removedDirs).toHaveLength(0);
    },
  );

  it.each(['/', '/srv', 'srv/products', '/srv/../products', ''])(
    'каталог продуктов %j — отказ до ЛЮБОГО вызова',
    async (productsDir) => {
      await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host, { productsDir }))).rejects.toThrow(/каталог продуктов/);
      expect(host.calls).toHaveLength(0);
    },
  );

  it('годный путь собирается ровно из каталога и слага, хвостовой слэш не мешает', () => {
    expect(productDirFor('/srv/products/', 'shop')).toBe('/srv/products/shop');
    expect(productDirFor('/srv/products', 'a-1')).toBe('/srv/products/a-1');
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`Cannot find module './purge'`)

```bash
git -C $B add product-runner/src/host/purge.spec.ts && git -C $B commit -q -m "test(runner): стирание — порядок шагов и строгий путь (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/purge.spec.ts`.

- [ ] **Step 3: Реализация**

`product-runner/src/host/purge.ts`:

```ts
/**
 * СТИРАНИЕ УДАЛЁННОГО ПРОДУКТА — задание `purge` (очередь 2).
 *
 * Через 30 дней после удаления продукт стирается насовсем: vhost и сертификат
 * своего домена, контейнер (и остаток прерванной смены ключей), каталог
 * `/srv/products/<слаг>` с чекаутом и данными. Это единственное место агента,
 * где каталог продукта удаляется целиком, — поэтому путь собирается и
 * сверяется здесь, своей проверкой, ДО любого вызова: слаг приехал по сети, а
 * платит за ошибку эта машина (довод шапки provision.ts про `rm -rf`).
 *
 * ## Порядок — как у подчистки заведения
 *
 * vhost первым: снятый контейнер возвращает порт в оборот (`freePort` смотрит
 * в `docker ps`), и живой vhost стёртого продукта отдал бы его домен чужому
 * продукту. Не снялся vhost — дальше не идём. Каталог — последним: из-под
 * живого контейнера его удалять нельзя.
 *
 * ## Почему не product-vhost
 *
 * У скрипта нет режима удаления; файл конфига и перечитывание — ровно те, что
 * снимает подчистка заведения (cleanup в provision.ts). Сертификат своего
 * домена — `certbot delete`, «сертификата нет» не отказ (повтор, бот).
 *
 * ## Повтор безопасен
 *
 * Каждый шаг спрашивает, есть ли что снимать: повторная выдача (потерянный
 * отчёт) проходит, а не превращается в вечный отказ стирания.
 */
import { dirname, isAbsolute, resolve } from 'path';
import { containerTaken, DEFAULTS, ProvisionDeps, SLUG_RE } from './provision';
import { certName } from './domain';
import { REKEY_BACKUP_SUFFIX } from './rekey';
import { ProductKind } from './skeleton';

export interface PurgeJob {
  slug: string;
  kind: ProductKind;
}

/**
 * Каталог продукта — или отказ. Проверки, все до первого вызова:
 *   - слаг по SLUG_RE (нет `/`, `..`, пустоты, ведущего дефиса, заглавных);
 *   - каталог продуктов абсолютный и не ближе двух уровней к корню (`/` и
 *     `/srv` целиком — не «каталог продуктов»);
 *   - нормализованный путь лежит РОВНО на уровень ниже каталога продуктов и
 *     равен `<каталог>/<слаг>` — `resolve` снимает `..` и лишние слэши, и
 *     сверяется уже результат.
 */
export function productDirFor(productsDir: string, slug: string): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new Error(`слаг не годится: ${JSON.stringify(slug)}`);
  if (typeof productsDir !== 'string' || !productsDir || !isAbsolute(productsDir)) {
    throw new Error(`каталог продуктов ${JSON.stringify(productsDir)} не абсолютный — стирать нечего`);
  }
  const root = resolve(productsDir);
  if (root.split('/').filter(Boolean).length < 2) {
    throw new Error(`каталог продуктов ${JSON.stringify(productsDir)} слишком близко к корню — стирать из него нельзя`);
  }
  const dir = resolve(root, slug);
  if (dirname(dir) !== root || dir !== `${root}/${slug}`) {
    throw new Error(`путь ${dir} вне каталога продуктов ${root} — ничего не тронуто`);
  }
  return dir;
}

const fullText = (e: any): string => `${e?.message ?? e ?? ''}\n${typeof e?.stdout === 'string' ? e.stdout : ''}`;

export async function purgeProduct(job: PurgeJob, deps: ProvisionDeps): Promise<void> {
  const phase = deps.onPhase ?? (() => {});
  // Путь — первым делом: слаг не по форме не доходит ни до одного вызова.
  const dir = productDirFor(deps.productsDir ?? DEFAULTS.productsDir, job.slug);
  if (job.kind !== 'site' && job.kind !== 'bot') throw new Error(`неизвестная форма продукта: ${JSON.stringify(job.kind)}`);

  if (job.kind === 'site') {
    const nginxConfDir = deps.nginxConfDir ?? DEFAULTS.nginxConfDir;
    await deps.run(['rm', '-f', `${nginxConfDir}/${job.slug}.conf`]);
    await deps.run(['systemctl', 'reload', 'nginx']);
    try {
      await deps.run(['certbot', 'delete', '--cert-name', certName(job.slug), '--non-interactive']);
    } catch (e: any) {
      if (!/No certificate found/i.test(fullText(e))) {
        throw new Error(`certbot не удалил сертификат ${certName(job.slug)} — контейнер и каталог не тронуты`);
      }
    }
  }

  for (const name of [job.slug, `${job.slug}${REKEY_BACKUP_SUFFIX}`]) {
    if (await containerTaken(deps, name)) await deps.run(['docker', 'rm', '-f', name]);
  }

  if (await deps.exists(dir)) await deps.removeDir(dir);
  phase(`продукт ${job.slug} стёрт`);
}
```

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add product-runner/src/host/purge.ts && git -C $B commit -q -m "runner: стирание удалённого продукта — vhost, сертификат, контейнер, каталог по строгому пути" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/purge.spec.ts src/host/rekey.spec.ts`. Expected: PASS. Затем tsc агента.

---

### Task 7: Агент — виды `rekey` и `purge` в цикле агента

**Files:**
- Modify: `product-runner/src/host/api.ts:16-58` (`HostJob`: `dropNames`, докблок `jobKind`)
- Modify: `product-runner/src/host/index.ts` (`HostDeps` ~15–48, `KNOWN_KINDS` ~164, `workFor` ~207–251, `overdue` ~261–286, `RealDepsParts`/`realDeps` ~578–617)
- Test: `product-runner/src/host/index.spec.ts` (`makeDeps` ~41–65 и новый `describe`)
- Modify: `product-runner/src/host/review10.defects.spec.ts:109-118`, `product-runner/src/host/domain.spec.ts:236-245` — там тоже собираются объекты `HostDeps`; ts-jest агента проверяет типы, и без новых полей оба набора не скомпилируются

- [ ] **Step 1: Тесты**

В `product-runner/src/host/review10.defects.spec.ts` (объект `const deps: HostDeps = {…}`, после `domain: async () => undefined,`) и в `product-runner/src/host/domain.spec.ts` (`hostDepsWithRealDomain`, после строки `domain: (j) => applyDomain(j, deps(host)),`) добавить по две строки:

```ts
        rekey: async () => undefined,
        purge: async () => undefined,
```

В `product-runner/src/host/index.spec.ts`:

1. Импорты: `import { RekeyJob } from './rekey';` и `import { PurgeJob } from './purge';`.
2. В `makeDeps` после `const domain = …`:

```ts
  const rekey = jest.fn(async (_job: RekeyJob): Promise<void> => undefined);
  const purge = jest.fn(async (_job: PurgeJob): Promise<void> => undefined);
```
в объект `deps` после `domain,` — `rekey,` и `purge,`; в возвращаемый объект — `rekey, purge`.
3. В конец файла:

```ts
const REKEY_JOB: HostJob = {
  ...JOB, kind: 'bot', jobKind: 'rekey', runnerToken: '', port: null,
  secrets: { BOT_TOKEN: 'новый-секрет-бота' }, dropNames: ['OLD_KEY'], ownerTgId: '42',
};
const PURGE_JOB: HostJob = { ...JOB, jobKind: 'purge', runnerToken: '', secrets: {}, port: 8003 };

describe('смена ключей и стирание (очередь 2)', () => {
  it('оба вида агенту знакомы', () => {
    expect(KNOWN_KINDS).toEqual(expect.arrayContaining(['rekey', 'purge']));
  });

  it('rekey: шагу уезжает выжимка — ключи, снимаемые имена, владелец; порта в отчёте нет', async () => {
    const { deps, poll, provision, rekey, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: REKEY_JOB });

    await tick(deps);

    expect(provision).not.toHaveBeenCalled();
    expect(rekey).toHaveBeenCalledWith({
      slug: 'shop', kind: 'bot', secrets: { BOT_TOKEN: 'новый-секрет-бота' }, dropNames: ['OLD_KEY'], ownerTgId: '42',
    });
    expect(complete).toHaveBeenCalledWith('j-1', { ok: true });
  });

  it('purge: шагу — только слаг и форма', async () => {
    const { deps, poll, purge, sleepProduct, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: PURGE_JOB });

    await tick(deps);

    expect(sleepProduct).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledWith({ slug: 'shop', kind: 'site' });
    expect(complete).toHaveBeenCalledWith('j-1', { ok: true });
  });

  it('отказ смены ключей уходит на сервер без значений ключей', async () => {
    const { deps, poll, rekey, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: REKEY_JOB });
    rekey.mockRejectedValue(new Error('ключи не применены: эхо новый-секрет-бота из docker'));

    await tick(deps);

    const report = lastReport(complete);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain('новый-секрет-бота');
    expect(JSON.stringify(report)).toMatch(/ключи не применены/);
  });

  it('срок смены ключей назван своими словами, а не «провижининг»', async () => {
    const { deps, poll, rekey, complete } = makeDeps({ provisionTimeoutMs: 5 });
    poll.mockResolvedValue({ ok: true, job: REKEY_JOB });
    rekey.mockImplementation(() => new Promise<void>(() => {}));

    await tick(deps);

    const report = lastReport(complete) as { ok: false; error: string };
    expect(report.error).toMatch(/смена ключей не уложилась/);
    expect(report.error).toMatch(/__rekey/);
  });

  it('боевая сборка: фазы смены ключей маскируют её новые значения', async () => {
    const logs: string[] = [];
    let captured: ProvisionDeps | undefined;
    const deps = realDeps(CONFIG, {
      log: (m) => logs.push(m),
      buildDeps: (overrides) => overrides as ProvisionDeps,
      rekey: async (_job, d) => {
        captured = d;
      },
    });
    await deps.rekey({ slug: 'shop', kind: 'bot', secrets: { BOT_TOKEN: 'новый-секрет-бота' }, dropNames: [] });
    captured!.onPhase!('docker сказал: новый-секрет-бота');
    expect(logs.join('\n')).not.toContain('новый-секрет-бота');
    expect(logs.join('\n')).toContain('***');
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (у `HostDeps` нет `rekey`/`purge`, у `HostJob` нет `dropNames`)

```bash
git -C $B add product-runner/src/host/index.spec.ts product-runner/src/host/review10.defects.spec.ts product-runner/src/host/domain.spec.ts && git -C $B commit -q -m "test(runner): виды rekey и purge в цикле агента (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/index.spec.ts src/host/review10.defects.spec.ts src/host/domain.spec.ts`.

- [ ] **Step 3: Реализация**

`product-runner/src/host/api.ts`, в `interface HostJob`:
- в докблоке `jobKind` строку «Вид работы: `provision`, `sleep`, `wake` или `domain`» заменить на «Вид работы: `provision`, `sleep`, `wake`, `domain`, `rekey` или `purge`»;
- после `vhostMode?` добавить:

```ts
  /**
   * Смена ключей (rekey): имена старых ключей владельца, которых нет в новом
   * наборе, — уходят из окружения. Новый набор целиком — в `secrets`
   * (расшифровывается сервером при выдаче, как у заведения).
   */
  dropNames?: string[];
```

`product-runner/src/host/index.ts`:

1. Импорты после строки с `./domain`:

```ts
import { RekeyJob, rekeyProduct as rekeyReal } from './rekey';
import { PurgeJob, purgeProduct as purgeReal } from './purge';
```

2. В `HostDeps` после `domain: …;`:

```ts
  /**
   * Смена ключей владельца и стирание удалённого (очередь 2). Обязательные по
   * той же причине, что сон и пробуждение: забытые в сборке, они были бы
   * TypeError в рантайме на каждом задании при зелёном прогоне.
   */
  rekey: (job: RekeyJob) => Promise<void>;
  purge: (job: PurgeJob) => Promise<void>;
```

3. `export const KNOWN_KINDS = ['provision', 'sleep', 'wake', 'domain', 'rekey', 'purge'] as const;`

4. В `workFor` после строки `if (kind === 'provision') return deps.provision(job);`:

```ts
  // Смене ключей — выжимка: новый набор, снимаемые имена, владелец бота.
  // Токена раннера нет и не нужно — пересоздание берёт его из живого
  // контейнера (rekey.ts). Порта в отчёте нет: он не меняется.
  if (kind === 'rekey') {
    return deps
      .rekey({
        slug: job.slug,
        kind: job.kind,
        secrets: job.secrets ?? {},
        dropNames: job.dropNames ?? [],
        ownerTgId: job.ownerTgId,
      })
      .then(() => ({}));
  }
  // Стиранию — только слаг и форма: путь и всё, что снимается, оно выводит
  // само и само же проверяет (purge.ts).
  if (kind === 'purge') return deps.purge({ slug: job.slug, kind: job.kind }).then(() => ({}));
```

5. В `overdue` перед `default:`:

```ts
    case 'rekey':
      return (
        `смена ключей не уложилась в ${sec} с и брошена: состояние хоста НЕИЗВЕСТНО — `
        + 'продукт мог остаться под именем <слаг>__rekey со старыми ключами, сверить руками'
      );
    case 'purge':
      return (
        `стирание не уложилось в ${sec} с и брошено: состояние хоста НЕИЗВЕСТНО — `
        + 'часть продукта могла остаться; повтор стирания безопасен'
      );
```

6. В `RealDepsParts` после `domain?: …;`:

```ts
  rekey?: (job: RekeyJob, deps: ProvisionDeps) => Promise<void>;
  purge?: (job: PurgeJob, deps: ProvisionDeps) => Promise<void>;
```
в `realDeps` после `const doDomain = …`:

```ts
  const doRekey = parts.rekey ?? rekeyReal;
  const doPurge = parts.purge ?? purgeReal;
```
и в возвращаемый объект после `domain: …,`:

```ts
    // Смене ключей маска фаз — С ЗАДАНИЕМ: в её фазах бывает текст отказа
    // docker, а значения новых ключей знает только задание (довод заведения).
    rekey: (job: RekeyJob) => doRekey(job, build(provisionOverrides(config, log, { secrets: job.secrets }))),
    purge: (job: PurgeJob) => doPurge(job, build(provisionOverrides(config, log))),
```

- [ ] **Step 4: Коммит, прогон — PASS** (весь пакет)

```bash
git -C $B add product-runner/src/host && git -C $B commit -q -m "runner: агент исполняет rekey и purge — выжимки, сроки, маска фаз" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `npx jest` без списка и `npx tsc -p tsconfig.json --noEmit` и `npm run build >/dev/null && ls dist/host/rekey.js dist/host/purge.js`. Expected: все наборы PASS; оба файла собраны.

---

### Task 8: Агент — каркас бота знает владельца; ключи можно сменить

**Files:**
- Modify: `product-runner/src/host/skeleton.ts` (`botServerJs` ~221–339, `keysSection` ~373–403, `BOT_AUDIENCE_SECTION` ~463–472)
- Test: `product-runner/src/host/skeleton.spec.ts`

Правило спеки: с привязкой — владелец `OWNER_TG_ID`; без неё — первая сборка отвечает на `/start` chat_id и подсказкой. Решение принимается В РАНТАЙМЕ по `process.env.OWNER_TG_ID`, а не при сборке каркаса: переменная может появиться позже (смена ключей ставит её ботам, заведённым до очереди 2), а `server.js` и `CLAUDE.md` коммитятся один раз.

- [ ] **Step 1: Тесты**

В `describe('каркас, поднятый как на машине клиента', …)` (`product-runner/src/host/skeleton.spec.ts`, ~751) добавить:

```ts
    const sent = (run: Booted): string => {
      const i = run.fetches.findIndex((u) => u.includes('sendMessage'));
      return JSON.parse(run.fetchInits[i].body).text;
    };
    const start = (fromId: number) => ({
      replies: [
        { ok: true, result: [{ update_id: 1, message: { text: '/start', chat: { id: fromId }, from: { id: fromId } } }] },
        { ok: true, result: [] },
      ],
      maxCalls: 6,
    });

    it('без OWNER_TG_ID /start отвечает chat_id и подсказкой, что с ним делать', async () => {
      const run = boot(skeletonFor('bot', 'X', SLUG)['server.js'], { ...start(777001), env: { BOT_TOKEN: 'Т', PORT: '3000' } });
      await drain();
      expect(sent(run)).toContain('777001');
      expect(sent(run)).toMatch(/назовите этот номер ассистенту/);
    });

    it('с OWNER_TG_ID владелец узнан и chat_id не печатается', async () => {
      const run = boot(skeletonFor('bot', 'X', SLUG)['server.js'], { ...start(777001), env: { BOT_TOKEN: 'Т', PORT: '3000', OWNER_TG_ID: '777001' } });
      await drain();
      expect(sent(run)).toMatch(/владелец/);
      expect(sent(run)).not.toContain('777001');
    });

    it('с OWNER_TG_ID постороннему — обычный ответ без chat_id и без «владелец»', async () => {
      const run = boot(skeletonFor('bot', 'X', SLUG)['server.js'], { ...start(555), env: { BOT_TOKEN: 'Т', PORT: '3000', OWNER_TG_ID: '777001' } });
      await drain();
      expect(sent(run)).toBe('Бот заведён и ждёт правок.');
    });

    it('/start@имя_бота в группе — тоже /start', async () => {
      const run = boot(skeletonFor('bot', 'X', SLUG)['server.js'], {
        replies: [
          { ok: true, result: [{ update_id: 1, message: { text: '/start@shop_bot', chat: { id: -100 }, from: { id: 9 } } }] },
          { ok: true, result: [] },
        ],
        maxCalls: 6,
        env: { BOT_TOKEN: 'Т', PORT: '3000' },
      });
      await drain();
      expect(sent(run)).toContain('-100');
    });
```

В `describe('каркас под ключи, данные и расписание', …)` добавить:

```ts
  it('ключи можно сменить через ассистента — каркас не обещает «нельзя»', () => {
    for (const kind of KINDS) {
      const md = skeletonFor(kind, 'X', SLUG, ['A'])['CLAUDE.md'];
      expect(md).not.toMatch(/пока нельзя/);
      expect(md).toMatch(/защищённая карточка/);
      expect(md).toMatch(/Object\.keys\(process\.env\)/);
    }
  });

  it('у бота владелец — OWNER_TG_ID, если он есть; у сайта переменной нет', () => {
    const md = skeletonFor('bot', 'X', SLUG)['CLAUDE.md'];
    expect(md).toMatch(/`OWNER_TG_ID`/);
    expect(md).toMatch(/message\.from\.id/);
    expect(skeletonFor('site', 'X', SLUG)['CLAUDE.md']).not.toMatch(/OWNER_TG_ID/);
  });
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add product-runner/src/host/skeleton.spec.ts && git -C $B commit -q -m "test(runner): каркас бота — владелец по OWNER_TG_ID, /start с chat_id (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/skeleton.spec.ts`.

- [ ] **Step 3: Реализация** в `product-runner/src/host/skeleton.ts`

⚠ `botServerJs` — шаблонная строка TypeScript: внутри неё `\s`, `\w`, `\/` молча превращаются в `s`, `w`, `/`. Поэтому в коде бота — ни одного регэкспа, только операции со строками; `${` внутри — только экранированные `\${`, как у соседних строк.

1. В `botServerJs` после строки `const TOKEN = process.env.BOT_TOKEN;` добавить:

```js
// Telegram-идентификатор владельца. Задаёт платформа, если владелец привязал
// Telegram в Linkeon; без привязки — пусто, и бот на /start подсказывает
// человеку его chat_id. Читается при старте: смена ключей перезапускает
// контейнер, и новое значение придёт вместе с ним.
const OWNER = String(process.env.OWNER_TG_ID || "");
```

2. Блок `if (u.message?.text) { … }` заменить на:

```js
        if (u.message?.text) {
          const chatId = u.message.chat.id;
          const fromId = String((u.message.from && u.message.from.id) || chatId);
          // "/start" и "/start@имя_бота" (так команда приходит в группе) —
          // без регэкспа: строка шаблона съела бы его обратные слэши.
          const first = String(u.message.text).trim().split(" ")[0];
          const isStart = first === "/start" || first.startsWith("/start@");
          let text = "Бот заведён и ждёт правок.";
          if (isStart && !OWNER) {
            text += " Ваш chat_id: " + chatId + ". Если это ваш бот — назовите этот номер ассистенту в Linkeon, чтобы бот узнавал вас.";
          } else if (isStart && fromId === OWNER) {
            text += " Вы — его владелец: правки — в чате Linkeon.";
          }
          // await обязателен: без него пачка обновлений даёт неограниченную
          // пачку одновременных исходящих.
          await fetch(\`https://api.telegram.org/bot\${TOKEN}/sendMessage\`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text }),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
        }
```

3. В `keysSection` комментарий над `const where` и сам `where` заменить на:

```ts
  // С очереди 2 ключи меняются после заведения: ассистент в чате Linkeon
  // открывает владельцу защищённую карточку, контейнер пересоздаётся с новыми
  // ключами. Список имён выше — на момент заведения, отсюда строка про
  // Object.keys: какие ключи есть СЕЙЧАС, ассистент правок узнаёт сам.
  const where =
    'Сменить, добавить или убрать ключ владелец может сам: попросить ассистента в чате Linkeon — '
    + 'откроется защищённая карточка, и продукт перезапустится с новыми ключами. Так и ответить владельцу.';
```
и в возвращаемый массив после строки `` `  в истории и попадает в git. ${where}`, `` добавить две строки:

```ts
    '- Список выше — на момент заведения: ключи могли смениться. Какие имена есть',
    '  сейчас — `Object.keys(process.env)` (только имена, без значений).',
```

4. `BOT_AUDIENCE_SECTION` целиком:

```ts
const BOT_AUDIENCE_SECTION = [
  '## Кому бот отвечает',
  'Если бот присылает данные владельца — отчёты, суммы, всё, что получено по',
  'его ключам, — отвечать ими только владельцу. Если в окружении есть',
  '`OWNER_TG_ID` — это Telegram-идентификатор владельца: владелец тот, у кого',
  '`message.from.id` равен ему (сравнивать строками). Переменную задаёт',
  'платформа, если владелец привязал Telegram в Linkeon.',
  'Если `OWNER_TG_ID` нет — владельца узнавать по chat_id, который он сам',
  'назвал в тексте правки (chat_id не секрет): пусть бот на `/start` отвечает',
  'человеку его chat_id, а владелец передаст его следующей правкой. chat_id',
  'хранить в `data/`. Не назначать владельцем того, кто первым нажал `/start`:',
  'имя бота находится поиском. Остальным — короткий отказ без данных.',
].join('\n');
```
Докблок над ним дополнить абзацем: «С очереди 2 владельца знает платформа: `OWNER_TG_ID` из привязки Telegram (provision.ts, rekey.ts). chat_id из текста правки — запасной путь для владельца без привязки».

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add product-runner/src/host/skeleton.ts && git -C $B commit -q -m "runner: каркас бота — владелец по OWNER_TG_ID, /start с chat_id; ключи меняются через ассистента" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/skeleton.spec.ts src/host/provision.spec.ts`. Expected: PASS, в том числе «server.js остаётся синтаксически валидным JavaScript при любом имени» и сторожа темпа опроса.

---

### Task 9: Сервер — выдача `rekey` и `purge`, `OWNER_TG_ID` боту

**Files:**
- Modify: `src/products/provisioning.service.ts` (`JobKind` ~56, `ClaimedJob` ~62–126, `claimJob` ~950–1126, новый приватный `ownerTgIdOf`)
- Test: `src/products/provisioning.rekey-purge.spec.ts` (новый; живая база + один тест на моке)

- [ ] **Step 1: Тесты**

`src/products/provisioning.rekey-purge.spec.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';

const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const secretsOf = () => new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

describe('OWNER_TG_ID — лучшим усилием', () => {
  it('таблицы привязок нет — задание всё равно выдаётся, без OWNER_TG_ID', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SET status = 'running'")) {
          return { rows: [{ job_id: 'j', job_kind: 'provision', product_id: 'p', user_id: 'u', slug: 's', name: 'Б', kind: 'bot', port: null, box: null, token_issued: true, custom_names: [], vhost_mode: 'proxy' }] };
        }
        if (sql.includes('tg_user_identities')) throw new Error('relation "tg_user_identities" does not exist');
        return { rows: [] };
      }),
    };
    const svc = new ProvisioningService(pg as any, secretsOf(), {} as any, {} as any, {} as any);
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ jobId: 'j', jobKind: 'provision' });
    expect(job).not.toHaveProperty('ownerTgId');
  });
});

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('выдача rekey и purge против живого Postgres', () => {
  let pool: Pool;
  let svc: ProvisioningService;
  const secrets = secretsOf();

  async function product(o: { status: string; kind?: 'site' | 'bot'; userId?: string; archived?: boolean; purgeAfter?: string; purged?: boolean }) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id,
                             archived_at, purge_after, purged_at)
       VALUES ($1, $2, 'П', $3, $4, $5, '/product', $6, 'clients',
               CASE WHEN $7 THEN now() - interval '31 days' END, $8::timestamptz, CASE WHEN $9 THEN now() END)`,
      [id, o.userId ?? 'u1', `s-${id.slice(0, 8)}`, o.kind ?? 'bot', o.status, `h-${id}`, !!o.archived, o.purgeAfter ?? null, !!o.purged],
    );
    return id;
  }

  async function rekeyJob(productId: string, set: Record<string, string> | null, payload: any = {}) {
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
       VALUES ('u1', $1, 'keys', 'working', 'web', $2::jsonb, $3) RETURNING id`,
      [productId, JSON.stringify(payload), set ? secrets.encrypt(set, productId) : null],
    );
    await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id) VALUES ($1, 'rekey', 'queued', $2)`,
      [productId, a.rows[0].id],
    );
    return a.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    // Своя копия таблицы привязок: она из модуля tg-bot (001_tg_bot_schema.sql),
    // а список MIGRATIONS здесь — только продукты. Форма — та же, что там.
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_user_identities (
      linkeon_user_id text PRIMARY KEY, tg_user_id bigint UNIQUE NOT NULL,
      tg_username text, tg_first_name text, bound_at timestamptz NOT NULL DEFAULT now())`);
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE tg_user_identities');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('rekey работающему: новый набор расшифрован, снимаемые имена приехали, токена раннера нет', async () => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new', NEW_KEY: 'n' }, { removedNames: ['OLD_KEY'] });
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ productId: p, jobKind: 'rekey', secrets: { BOT_TOKEN: '123456:TEST-new', NEW_KEY: 'n' }, dropNames: ['OLD_KEY'] });
    expect(job).not.toHaveProperty('runnerToken');
  });

  it('rekey без коробки ключей не выдаётся вовсе — агент не снял бы ключи впустую', async () => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, null);
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('rekey ждёт конца правки', async () => {
    const p = await product({ status: 'running' });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new' });
    await pool.query(`INSERT INTO product_turns (product_id, user_id, channel, prompt, status) VALUES ($1, 'u1', 'web', 'п', 'running')`, [p]);
    expect(await svc.claimJob('clients')).toBeNull();
    await pool.query(`UPDATE product_turns SET status = 'done' WHERE product_id = $1`, [p]);
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey' });
  });

  it.each(['sleeping', 'blocked', 'provisioning', 'failed'])('rekey продукту в %s не выдаётся', async (status) => {
    const p = await product({ status });
    await rekeyJob(p, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('purge — удалённому после срока; до срока, стёртому и живому — нет', async () => {
    const due = await product({ status: 'archived', archived: true, purgeAfter: new Date(Date.now() - 60_000).toISOString() });
    const early = await product({ status: 'archived', archived: true, purgeAfter: new Date(Date.now() + 86_400_000).toISOString() });
    const gone = await product({ status: 'archived', archived: true, purgeAfter: new Date(Date.now() - 60_000).toISOString(), purged: true });
    const live = await product({ status: 'running' });
    for (const id of [early, gone, live, due]) {
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'purge', 'queued')`, [id]);
    }
    const job = await svc.claimJob('clients');
    expect(job).toMatchObject({ productId: due, jobKind: 'purge', secrets: {} });
    expect(await svc.claimJob('clients')).toBeNull();
  });

  it('OWNER_TG_ID: бот владельца с привязкой — при заведении и при смене ключей; сайт и бот без привязки — нет', async () => {
    await pool.query(`INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES ('u1', 777001)`);
    const bot = await product({ status: 'provisioning' });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [bot]);
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'provision', ownerTgId: '777001' });

    const site = await product({ status: 'provisioning', kind: 'site' });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [site]);
    expect(await svc.claimJob('clients')).not.toHaveProperty('ownerTgId');

    const other = await product({ status: 'running', userId: 'u2' });
    await rekeyJob(other, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).not.toHaveProperty('ownerTgId');

    const mine = await product({ status: 'running' });
    await rekeyJob(mine, { BOT_TOKEN: '123456:TEST-new' });
    expect(await svc.claimJob('clients')).toMatchObject({ jobKind: 'rekey', ownerTgId: '777001' });
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add src/products/provisioning.rekey-purge.spec.ts && git -C $B commit -q -m "test(products): выдача rekey и purge, OWNER_TG_ID боту (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/provisioning.rekey-purge.spec.ts`. Expected: FAIL (выдача `null` для rekey/purge; нет `ownerTgId`).

- [ ] **Step 3: Типы**

В `src/products/provisioning.service.ts`:
- `export type JobKind = 'provision' | 'sleep' | 'wake' | 'domain' | 'rekey' | 'purge';` (над ним в докблок: «rekey и purge — очередь 2, словарь в 004 расширен миграцией очереди 2»);
- в `ClaimedJob` после `vhostMode`:

```ts
  /**
   * Смена ключей (rekey): имена старых ключей владельца, которых нет в новом
   * наборе. Новый набор — в `secrets`, расшифрован из коробки карточки
   * (product_actions.secrets_box). У прочих видов ключа нет.
   */
  dropNames?: string[];
  /**
   * Telegram владельца — только боту, только у provision и rekey и только при
   * привязке (tg_user_identities). Уходит в окружение `OWNER_TG_ID`.
   */
  ownerTgId?: string;
```

- [ ] **Step 4: SQL выдачи** — точными заменами, со сверкой числа вхождений

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/product-lifecycle-2 && node - <<'EOF'
const fs = require('fs');
const f = 'src/products/provisioning.service.ts';
let s = fs.readFileSync(f, 'utf8');
const sp = (n) => ' '.repeat(n);
const pairs = [
  ["AND (p.archived_at IS NULL OR (j.kind = 'sleep' AND p.purged_at IS NULL))",
   "AND (p.archived_at IS NULL OR (j.kind IN ('sleep','purge') AND p.purged_at IS NULL))"],
  [sp(34) + "ELSE p.status = 'sleeping'\n" + sp(32) + "END)",
   sp(34) + "-- Смена ключей (очередь 2): только работающему, только с\n" +
   sp(34) + "-- коробкой ключей в карточке и только без идущей правки —\n" +
   sp(34) + "-- пересоздание контейнера убило бы ход молча.\n" +
   sp(34) + "WHEN 'rekey' THEN p.status IN ('running','degraded')\n" +
   sp(34) + "               AND EXISTS (SELECT 1 FROM product_actions ka\n" +
   sp(34) + "                            WHERE ka.id = j.action_id AND ka.status = 'working'\n" +
   sp(34) + "                              AND ka.secrets_box IS NOT NULL)\n" +
   sp(34) + "               AND NOT EXISTS (SELECT 1 FROM product_turns t\n" +
   sp(34) + "                                WHERE t.product_id = p.id AND t.status IN ('queued','running'))\n" +
   sp(34) + "-- Стирание: удалённому и только после срока возврата —\n" +
   sp(34) + "-- возврат мог успеть между постановкой и выдачей.\n" +
   sp(34) + "WHEN 'purge' THEN p.status = 'archived' AND p.purge_after <= now()\n" +
   sp(34) + "ELSE p.status = 'sleeping'\n" + sp(32) + "END)"],
  [sp(10) + "RETURNING id, product_id, kind\n",
   sp(10) + "RETURNING id, product_id, kind, action_id\n"],
  [sp(14) + "(i.id IS NOT NULL) AS token_issued\n",
   sp(14) + "(i.id IS NOT NULL) AS token_issued,\n" +
   sp(14) + "p.user_id AS user_id, a.secrets_box AS rekey_box, a.payload AS rekey_payload\n"],
  [sp(9) + "LEFT JOIN issued i ON i.id = c.product_id`,",
   sp(9) + "LEFT JOIN issued i ON i.id = c.product_id\n" + sp(9) + "LEFT JOIN product_actions a ON a.id = c.action_id`,"],
];
for (const [a, b] of pairs) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error(`вхождений ${n}: ${a.slice(0, 80)}`); process.exit(1); }
  s = s.replace(a, b);
}
fs.writeFileSync(f, s);
console.log('ok');
EOF
```
Expected: `ok`. Не нашлась строка — сверить отступы (`sed -n 1015,1085p src/products/provisioning.service.ts | sed 's/ /·/g'`), поправить строку в скрипте и повторить.

Комментарий над `claimJob` (раздел «СТАТУС ПРОДУКТА СВЕРЯЕТСЯ ПО ВИДУ ЗАДАНИЯ») дополнить абзацем: «Смена ключей (rekey) — работающему, с коробкой ключей в своей карточке (action_id) и без идущей правки; стирание (purge) — удалённому после purge_after. Удалённому, кроме сна, выдаётся только стирание».

- [ ] **Step 5: Разбор строки выдачи**

В `claimJob` после `const jobKind = row.job_kind as JobKind;` и перед `return {` вставить:

```ts
    // Ключи: заведению — из продукта, смене ключей — из коробки её карточки
    // (тот же AAD — id продукта). Прочим видам ключи не нужны и не
    // расшифровываются вовсе.
    let secrets: Record<string, string> = {};
    if (jobKind === 'provision' && row.box) secrets = this.secrets.decrypt(row.box, row.product_id);
    if (jobKind === 'rekey' && row.rekey_box) secrets = this.secrets.decrypt(row.rekey_box, row.product_id);
    const dropNames = jobKind === 'rekey'
      ? (Array.isArray(row.rekey_payload?.removedNames) ? row.rekey_payload.removedNames.filter((n: unknown) => typeof n === 'string') : [])
      : undefined;
    // Отдельным чтением ПОСЛЕ выдачи и лучшим усилием: таблица привязок — из
    // модуля tg-bot, и её отказ не должен ронять опрос агента (задание уже
    // забрано, токен выпущен — 500 здесь оставил бы его до сборщика).
    const ownerTgId = row.kind === 'bot' && (jobKind === 'provision' || jobKind === 'rekey')
      ? await this.ownerTgIdOf(row.user_id)
      : undefined;
```
в возвращаемом объекте строку `secrets: jobKind === 'provision' && row.box ? this.secrets.decrypt(row.box, row.product_id) : {},` заменить на `secrets,`, а после строки `vhostMode: …,` добавить:

```ts
      ...(dropNames !== undefined ? { dropNames } : {}),
      ...(ownerTgId !== undefined ? { ownerTgId } : {}),
```
Комментарий у прежней строки `secrets:` (про сон и пробуждение) перенести к новому блоку выше.

Новый приватный метод — сразу после `claimJob`:

```ts
  /**
   * Telegram владельца для OWNER_TG_ID — лучшим усилием. Таблица чужого
   * модуля (tg-bot/migrations/001_tg_bot_schema.sql): её отказ — строка в лог
   * и бот без OWNER_TG_ID (каркас тогда сам подскажет chat_id на /start), а
   * не сорванная выдача. Без привязки — undefined, ключа в задании нет.
   */
  private async ownerTgIdOf(userId: string): Promise<string | undefined> {
    try {
      const r = await this.pg.query(
        `SELECT tg_user_id::text AS id FROM tg_user_identities WHERE linkeon_user_id = $1 LIMIT 1`,
        [userId],
      );
      const id = r.rows?.[0]?.id;
      return typeof id === 'string' && /^\d{1,20}$/.test(id) ? id : undefined;
    } catch (e: any) {
      this.logger.warn(`OWNER_TG_ID не прочитан (${e?.message}) — бот уедет без него`);
      return undefined;
    }
  }
```

- [ ] **Step 6: Коммит, прогон — PASS + регрессия выдачи**

```bash
git -C $B add src/products/provisioning.service.ts && git -C $B commit -q -m "products: выдача rekey (коробка карточки, без идущей правки) и purge (после срока); OWNER_TG_ID боту" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/provisioning.rekey-purge.spec.ts src/products/provisioning.job.spec.ts src/products/provisioning.archived.spec.ts src/products/provisioning.integration.spec.ts src/products/domains.jobs.spec.ts src/products/host.controller.spec.ts`. Expected: PASS; число тестов регрессионных наборов — как в базовой линии. Затем tsc бэка.

---

### Task 10: Сервер — отчёт агента по `rekey` и `purge`, сборщик

**Files:**
- Modify: `src/products/product-actions.service.ts` (константы текстов для людей)
- Modify: `src/products/provisioning.service.ts` (`completeJob` ~1165–1171, новые `completeRekeyJob` и `completePurgeJob`, `failStaleProvisioning` ~1801–1804)
- Test: `src/products/provisioning.complete-rekey-purge.spec.ts` (новый, живая база)

- [ ] **Step 1: Тесты**

`src/products/provisioning.complete-rekey-purge.spec.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';
import { REKEY_FAILED_SAY } from './product-actions.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

maybe('отчёт агента по rekey и purge против живого Postgres', () => {
  let pool: Pool;
  let svc: ProvisioningService;
  const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

  async function product(o: { status: string; kind?: 'site' | 'bot'; archived?: boolean; tgBotId?: number | null; secrets?: Record<string, string> } ) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id,
                             archived_at, purge_after, tg_bot_id, secrets_encrypted, first_prompt)
       VALUES ($1, 'u1', 'П', $2, $3, $4, '/product', $5, 'clients',
               CASE WHEN $6 THEN now() - interval '31 days' END, CASE WHEN $6 THEN now() - interval '1 day' END, $7, $8, 'первая')`,
      [id, `s-${id.slice(0, 8)}`, o.kind ?? 'bot', o.status, `h-${id}`, !!o.archived, o.tgBotId ?? null,
       o.secrets ? secrets.encrypt(o.secrets, id) : null],
    );
    return id;
  }

  /** Задание уже у агента (running), как после claimJob. */
  async function runningRekey(productId: string, set: Record<string, string>, payload: any) {
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
       VALUES ('u1', $1, 'keys', 'working', 'web', $2::jsonb, $3) RETURNING id`,
      [productId, JSON.stringify(payload), secrets.encrypt(set, productId)],
    );
    const j = await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id, started_at) VALUES ($1, 'rekey', 'running', $2, now()) RETURNING id`,
      [productId, a.rows[0].id],
    );
    return { actionId: a.rows[0].id as string, jobId: j.rows[0].id as string };
  }

  const productRow = async (id: string) => (await pool.query(`SELECT * FROM products WHERE id = $1`, [id])).rows[0];
  const actionRow = async (id: string) => (await pool.query(`SELECT * FROM product_actions WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_domains, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_domains, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('успех rekey: ключи из коробки в продукте, коробка стёрта, карточка done с новыми именами', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old', OLD_KEY: 'o' } });
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-old', NEW_KEY: 'n' }, { newKeyNames: ['BOT_TOKEN', 'NEW_KEY'], removedNames: ['OLD_KEY'] });

    await svc.completeJob(jobId, { ok: true });

    expect(secrets.decrypt((await productRow(p)).secrets_encrypted, p)).toEqual({ BOT_TOKEN: '123456:TEST-old', NEW_KEY: 'n' });
    const a = await actionRow(actionId);
    expect(a.status).toBe('done');
    expect(a.secrets_box).toBeNull();
    expect(a.result).toEqual({ keyNames: ['BOT_TOKEN', 'NEW_KEY'] });
    expect(JSON.stringify(a)).not.toContain('TEST-old');
  });

  it('пустой новый набор — secrets_encrypted NULL, как у заведения без ключей', async () => {
    const p = await product({ status: 'running', kind: 'site', secrets: { A: '1' } });
    const { jobId } = await runningRekey(p, {}, { newKeyNames: [], removedNames: ['A'] });
    await svc.completeJob(jobId, { ok: true });
    expect((await productRow(p)).secrets_encrypted).toBeNull();
  });

  it('отказ rekey: ключи прежние, коробка стёрта, карточка failed с человеческим текстом, продукт не тронут', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const before = await productRow(p);
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-bad' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });

    await svc.completeJob(jobId, { ok: false, error: 'ключи не применены: продукт не ответил на /health' });

    const after = await productRow(p);
    expect(after.secrets_encrypted.equals(before.secrets_encrypted)).toBe(true);
    expect(after.status).toBe('running');
    expect(after.provision_error).toBeNull();
    const a = await actionRow(actionId);
    expect(a.status).toBe('failed');
    expect(a.secrets_box).toBeNull();
    expect(a.result).toEqual({ error: REKEY_FAILED_SAY, reason: 'rekey_failed' });
    const j = (await pool.query(`SELECT status, error FROM product_provision_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(j).toEqual({ status: 'failed', error: 'ключи не применены: продукт не ответил на /health' });
  });

  it('повторный отчёт — ничего не меняет', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    await svc.completeJob(jobId, { ok: true });
    await svc.completeJob(jobId, { ok: false, error: 'поздний отказ' });
    expect((await actionRow(actionId)).status).toBe('done');
    expect(secrets.decrypt((await productRow(p)).secrets_encrypted, p)).toEqual({ BOT_TOKEN: '123456:TEST-new' });
  });

  it('смена BOT_TOKEN: tg_bot_id новый; занят другим живым — отчёт проходит, метка прежняя', async () => {
    const p = await product({ status: 'running', tgBotId: 111, secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const a1 = await runningRekey(p, { BOT_TOKEN: '222222:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [], tgBotId: 222 });
    await svc.completeJob(a1.jobId, { ok: true });
    expect(Number((await productRow(p)).tg_bot_id)).toBe(222);

    await product({ status: 'running', tgBotId: 333 });
    const a2 = await runningRekey(p, { BOT_TOKEN: '333333:TEST-x' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [], tgBotId: 333 });
    await expect(svc.completeJob(a2.jobId, { ok: true })).resolves.toBeUndefined();
    expect(Number((await productRow(p)).tg_bot_id)).toBe(222);
    expect((await actionRow(a2.actionId)).status).toBe('done');
  });

  it('успех purge: purged_at, секреты и первая правка стёрты, домен снят, журнал system; строка и задания на месте', async () => {
    const p = await product({ status: 'archived', archived: true, kind: 'site', secrets: { A: '1' } });
    await pool.query(
      `INSERT INTO product_domains (product_id, domain, names, token, status) VALUES ($1, 'shop.example.ru', '{shop.example.ru}', 't', 'active')`,
      [p],
    );
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'provision', 'done')`, [p]);
    const j = await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status, started_at) VALUES ($1, 'purge', 'running', now()) RETURNING id`, [p]);

    await svc.completeJob(j.rows[0].id, { ok: true });

    const row = await productRow(p);
    expect(row.purged_at).not.toBeNull();
    expect(row.secrets_encrypted).toBeNull();
    expect(row.first_prompt).toBeNull();
    expect((await pool.query(`SELECT 1 FROM product_domains WHERE product_id = $1`, [p])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id = $1`, [p])).rows[0].n).toBe(2);
    const log = await pool.query(`SELECT kind, status, channel, payload FROM product_actions WHERE product_id = $1`, [p]);
    expect(log.rows).toEqual([{ kind: 'purge', status: 'done', channel: 'system', payload: { name: 'П', slug: row.slug } }]);
  });

  it('отказ purge: продукт не помечен стёртым, журнал failed без сырой причины агента', async () => {
    const p = await product({ status: 'archived', archived: true, kind: 'site' });
    const j = await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status, started_at) VALUES ($1, 'purge', 'running', now()) RETURNING id`, [p]);
    await svc.completeJob(j.rows[0].id, { ok: false, error: 'certbot не удалил сертификат linkeon-x' });
    expect((await productRow(p)).purged_at).toBeNull();
    const log = await pool.query(`SELECT status, result FROM product_actions WHERE product_id = $1`, [p]);
    expect(log.rows[0].status).toBe('failed');
    expect(JSON.stringify(log.rows[0].result)).not.toContain('certbot');
  });

  it('сборщик называет свой срок у смены ключей и стирания', async () => {
    const p = await product({ status: 'running' });
    const { jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-x' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    await pool.query(`UPDATE product_provision_jobs SET started_at = now() - interval '11 minutes' WHERE id = $1`, [jobId]);
    await svc.failStaleProvisioning();
    const j = (await pool.query(`SELECT status, error FROM product_provision_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(j).toEqual({ status: 'failed', error: 'срок смены ключей истёк (10 мин)' });
    expect((await productRow(p)).status).toBe('running');
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add src/products/provisioning.complete-rekey-purge.spec.ts && git -C $B commit -q -m "test(products): отчёт агента по rekey и purge (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/provisioning.complete-rekey-purge.spec.ts`. Expected: FAIL (`REKEY_FAILED_SAY` не экспортируется; отчёт уходит в общий путь).

- [ ] **Step 3: Тексты для людей** — в `src/products/product-actions.service.ts` после `DELETE_GRACE_DAYS`:

```ts
/**
 * Итог несостоявшейся смены ключей — для карточки и ассистента. Сырая причина
 * агента (stderr docker, срок, откат) остаётся в product_provision_jobs.error:
 * человеку она ничего не скажет, а значение ключа там в теории может
 * оказаться (агент маскирует, но журнал карточки читается шире).
 */
export const REKEY_FAILED_SAY =
  'Ключи не применены — продукт работает со старыми ключами. Попробуйте ещё раз через несколько минут; не выйдет — напишите в поддержку.';

/** Итог несостоявшегося стирания в журнале: обход повторит его сам. */
export const PURGE_FAILED_SAY = 'Стирание не удалось — повторится автоматически';
```

- [ ] **Step 4: Разводка и два отчёта** в `src/products/provisioning.service.ts`

1. Импорт: `import { PURGE_FAILED_SAY, REKEY_FAILED_SAY } from './product-actions.service';`
2. В `completeJob` строку `if (kindRow.rows[0]?.kind === 'domain') return this.completeDomainJob(jobId, result);` заменить на:

```ts
    const jobKind = kindRow.rows[0]?.kind;
    if (jobKind === 'domain') return this.completeDomainJob(jobId, result);
    // Смена ключей и стирание продукт по общему пути НЕ трогают: отказ
    // смены ключей — не поломка заведения (продукт работает со старыми
    // ключами), отказ стирания — не повод выводить удалённый из архива.
    if (jobKind === 'rekey') return this.completeRekeyJob(jobId, result);
    if (jobKind === 'purge') return this.completePurgeJob(jobId, result);
```

3. Два метода — сразу после `completeDomainJob`:

```ts
  /**
   * Отчёт по смене ключей. ОДИН оператор, замок тот же (`status = 'running'`):
   * закрыть задание, при успехе перенести коробку карточки в продукт, закрыть
   * карточку и стереть коробку в любом исходе. Двумя операторами смерть
   * процесса между ними оставила бы ключи в базе одними, а в контейнере —
   * другими.
   *
   * Коробка переносится КАК ЕСТЬ: она зашифрована тем же SecretsService с тем
   * же AAD (id продукта), что и products.secrets_encrypted. Пустой новый набор
   * (newKeyNames пуст) — NULL, как у заведения без ключей: decrypt на коробке
   * от {} никто не зовёт, признак «ключей нет» — NULL (см. create()).
   *
   * CTE act читает карточку из снимка ДО этого же оператора, поэтому коробка в
   * swapped — ещё не стёртая finished. Порядок CTE тут не защита — защита в
   * снимке, одном на весь оператор.
   */
  private async completeRekeyJob(jobId: string, result: { ok: boolean; error?: string }) {
    const r = await this.pg.query(
      `WITH closed AS (
          UPDATE product_provision_jobs
             SET status = CASE WHEN $2::boolean THEN 'done' ELSE 'failed' END,
                 error = CASE WHEN $2::boolean THEN NULL ELSE $3::text END,
                 finished_at = now()
           WHERE id = $1 AND status = 'running' AND kind = 'rekey'
          RETURNING product_id, action_id
       ), act AS (
          SELECT a.id, a.secrets_box, a.payload FROM product_actions a JOIN closed c ON a.id = c.action_id
       ), swapped AS (
          UPDATE products p
             SET secrets_encrypted = CASE
                   WHEN jsonb_array_length(COALESCE(act.payload->'newKeyNames', '[]'::jsonb)) = 0 THEN NULL
                   ELSE act.secrets_box END
            FROM closed, act
           WHERE $2::boolean AND p.id = closed.product_id AND act.secrets_box IS NOT NULL
          RETURNING p.id
       ), finished AS (
          UPDATE product_actions a
             SET status = CASE WHEN $2::boolean THEN 'done' ELSE 'failed' END,
                 secrets_box = NULL,
                 result = CASE WHEN $2::boolean
                               THEN jsonb_build_object('keyNames', COALESCE(a.payload->'newKeyNames', '[]'::jsonb))
                               ELSE jsonb_build_object('error', $4::text, 'reason', 'rekey_failed') END,
                 resolved_at = now()
            FROM closed WHERE a.id = closed.action_id AND a.status = 'working'
          RETURNING a.payload->>'tgBotId' AS tg_bot_id
       )
       SELECT (SELECT count(*) FROM closed)::int AS closed,
              (SELECT product_id FROM closed) AS product_id,
              (SELECT tg_bot_id FROM finished) AS tg_bot_id`,
      [jobId, result.ok, result.error ?? 'без причины', REKEY_FAILED_SAY],
    );
    const row = r.rows[0];
    if (!row?.closed) {
      this.logger.warn(`отчёт по незапущенному заданию rekey ${jobId} — ключи не тронуты`);
      return;
    }
    // Метка бота — отдельным оператором и лучшим усилием: частичный UNIQUE
    // products_tg_bot_live мог занять другой живой продукт между проверкой в
    // карточке и этим отчётом. Отказ уронил бы оператор выше целиком — и с
    // ним перенос уже применённых в контейнере ключей.
    if (result.ok && row.tg_bot_id) {
      try {
        await this.pg.query(
          `UPDATE products SET tg_bot_id = $2, tg_bot_checked_at = now() WHERE id = $1 AND archived_at IS NULL`,
          [row.product_id, row.tg_bot_id],
        );
      } catch (e: any) {
        if (e?.code === '23505' && e?.constraint === 'products_tg_bot_live') {
          this.logger.warn(`смена ключей продукта ${row.product_id}: новый бот уже числится за другим живым продуктом — tg_bot_id не обновлён`);
        } else {
          this.logger.error(`смена ключей продукта ${row.product_id}: tg_bot_id не записан (${e?.message})`);
        }
      }
    }
  }

  /**
   * Отчёт по стиранию. Строка продукта НЕ удаляется (спека, «Открыто на
   * очередь 2»): задания продукта удалились бы каскадом, и счёт бесплатных
   * месяцев (freeMonthCountedJobSql) сбросился бы — «удалить, дождаться
   * стирания, завести снова» снова давало бы бесплатный месяц. Стираются
   * ключи и первая правка, снимается строка своего домена (освобождает
   * домен для других: индекс занятости product_domains_occupied), пишется
   * строка журнала. Резервную копию стирает обход (product-purge.service).
   *
   * Один оператор и тот же замок `status = 'running'`. Журнал в исходе отказа —
   * без сырой причины агента (она в задании).
   */
  private async completePurgeJob(jobId: string, result: { ok: boolean; error?: string }) {
    const r = await this.pg.query(
      `WITH closed AS (
          UPDATE product_provision_jobs
             SET status = CASE WHEN $2::boolean THEN 'done' ELSE 'failed' END,
                 error = CASE WHEN $2::boolean THEN NULL ELSE $3::text END,
                 finished_at = now()
           WHERE id = $1 AND status = 'running' AND kind = 'purge'
          RETURNING product_id
       ), purged AS (
          UPDATE products p
             SET purged_at = now(), secrets_encrypted = NULL, first_prompt = NULL, first_prompt_channel = NULL
            FROM closed
           WHERE $2::boolean AND p.id = closed.product_id AND p.purged_at IS NULL
          RETURNING p.id
       ), domains AS (
          DELETE FROM product_domains d USING purged WHERE d.product_id = purged.id
          RETURNING d.product_id
       ), logged AS (
          INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, result, attached_at, resolved_at)
          SELECT p.user_id, p.id, 'purge',
                 CASE WHEN $2::boolean THEN 'done' ELSE 'failed' END, 'system',
                 jsonb_build_object('name', p.name, 'slug', p.slug),
                 CASE WHEN $2::boolean THEN '{}'::jsonb ELSE jsonb_build_object('error', $4::text) END,
                 now(), now()
            FROM products p JOIN closed c ON c.product_id = p.id
          RETURNING id
       )
       SELECT (SELECT count(*) FROM closed)::int AS closed`,
      [jobId, result.ok, result.error ?? 'без причины', PURGE_FAILED_SAY],
    );
    if (!r.rows[0]?.closed) this.logger.warn(`отчёт по незапущенному заданию purge ${jobId} — продукт не тронут`);
  }
```

4. В `failStaleProvisioning` в `CASE kind` после строки `WHEN 'domain' THEN …` добавить:

```ts
                          WHEN 'rekey' THEN 'срок смены ключей истёк (${PROVISION_DEADLINE_MIN} мин)'
                          WHEN 'purge' THEN 'срок стирания истёк (${PROVISION_DEADLINE_MIN} мин)'
```
Карточку зависшей смены ключей закрывает подметальщик журнала (задача 12): у неё задание `failed`, а исход не записан.

- [ ] **Step 5: Коммит, прогон — PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: отчёт агента по смене ключей и стиранию — одним оператором; сроки сборщика" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/provisioning.complete-rekey-purge.spec.ts src/products/provisioning.rekey-purge.spec.ts src/products/provisioning.job.spec.ts src/products/provisioning.integration.spec.ts src/products/domains.jobs.spec.ts`. Expected: PASS. Затем tsc бэка.

---

### Task 11: Сервер — правки не ставятся, пока меняются ключи

**Files:**
- Modify: `src/products/turns.service.ts` (новая константа рядом с `BLOCKED_REFUSAL` ~122; `enqueue` ~305–316)
- Modify: `src/products/product-tool.service.ts` (`refusal` ~499–522, импорт)
- Test: `src/products/turns.enqueue.spec.ts` (опция мока и тест), `src/products/product-tool.rekey.spec.ts` (новый)

Пересоздание контейнера посреди хода убивает ход молча (раннер живёт внутри контейнера). С одной стороны выдачу `rekey` держит отсутствие правок (задача 9), с другой — эта задача: пока `rekey` в очереди или идёт, новая правка не ставится.

- [ ] **Step 1: Тесты**

В `src/products/turns.enqueue.spec.ts`:
1. В тип опций `makeService` добавить `rekeying?: boolean;`, а в мок `pg.query` первой строкой тела (до ветки `SELECT status FROM products`):

```ts
      if (sql.includes("kind = 'rekey'")) return { rows: opts.rekeying ? [{ x: 1 }] : [] };
```
2. Импорт: `REKEY_REFUSAL` рядом с `BLOCKED_REFUSAL`. В конец файла:

```ts
describe('правка во время смены ключей', () => {
  it('пока rekey в очереди или идёт — 409 со своим текстом, ход не ставится', async () => {
    const { svc, calls } = makeService({ rekeying: true });
    await expect(svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'п' })).rejects.toThrow(ConflictException);
    await expect(svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'п' })).rejects.toThrow(REKEY_REFUSAL);
    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
    const q = calls.find((c) => c.sql.includes("kind = 'rekey'"))!;
    expect(q.sql).toMatch(/status IN \('queued','running'\)/);
  });

  it('спящему по-прежнему свой отказ — проверка ключей стоит после статусов', async () => {
    const { svc } = makeService({ rekeying: true, productStatus: 'sleeping' });
    await expect(svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'п' })).rejects.toThrow(SLEEPING_REFUSAL);
  });
});
```

`src/products/product-tool.rekey.spec.ts`:

```ts
import { ConflictException } from '@nestjs/common';
import { ProductToolService } from './product-tool.service';
import { REKEY_REFUSAL } from './turns.service';

const PRODUCT = { id: 'p1', name: 'Магазин', slug: 'magazin', domain: null, kind: 'bot', status: 'running' };

describe('отказ правке во время смены ключей — ассистенту свой reason', () => {
  it('reason rekeying, без предложения пополнить', async () => {
    const pg = { query: jest.fn(async (sql: string) => (sql.includes('FROM products') ? { rows: [PRODUCT] } : { rows: [] })) };
    const turns = { enqueue: jest.fn(async () => { throw new ConflictException(REKEY_REFUSAL); }) };
    const svc = new ProductToolService(pg as any, turns as any, {} as any);
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: 'поменяй приветствие' });
    expect(r).toMatchObject({ ok: false, reason: 'rekeying', canTopUp: false });
    expect(r.say).toMatch(/через пару минут/);
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`REKEY_REFUSAL` не экспортируется)

```bash
git -C $B add src/products/turns.enqueue.spec.ts src/products/product-tool.rekey.spec.ts && git -C $B commit -q -m "test(products): правка во время смены ключей — 409 и свой reason (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/turns.enqueue.spec.ts src/products/product-tool.rekey.spec.ts`.

- [ ] **Step 3: Реализация**

`src/products/turns.service.ts` — после `BLOCKED_REFUSAL`:

```ts
/**
 * Отказ правке, пока меняются ключи продукта (задание rekey в очереди или
 * идёт). Смена ключей ПЕРЕСОЗДАЁТ контейнер, а раннер живёт внутри него:
 * поставленная сейчас правка была бы убита посреди хода молча, а
 * выдача rekey ждала бы её конца (claimJob) — то есть правка и ключи
 * загораживали бы друг друга до сборщика. 409, а не 402: деньги тут ни при
 * чём, кабинет показывает текст сервера (см. BLOCKED_REFUSAL).
 */
export const REKEY_REFUSAL = 'Сейчас меняются ключи продукта — правку можно поставить через пару минут.';
```

В `enqueue` сразу после блока

```ts
    if (productStatus !== 'running') {
      throw new ConflictException('Продукт сейчас недоступен для правок');
    }
```
вставить:

```ts
    // После статусов (у спящего и погашенного — свои тексты) и ДО баланса:
    // пополнение смену ключей не ускорит. Отдельным запросом, а не полем
    // SELECT статуса: тот же запрос читают мок-спеки модуля по подстроке.
    const rekey = await this.pg.query(
      `SELECT 1 FROM product_provision_jobs
        WHERE product_id = $1 AND kind = 'rekey' AND status IN ('queued','running') LIMIT 1`,
      [input.productId],
    );
    if (rekey.rows.length) throw new ConflictException(REKEY_REFUSAL);
```

`src/products/product-tool.service.ts`: в импорт из `./turns.service` добавить `REKEY_REFUSAL`; в `refusal` перед веткой `'Недостаточно токенов'`:

```ts
    if (msg === REKEY_REFUSAL) {
      return { ok: false, reason: 'rekeying', canTopUp: false, product,
        say: `${REKEY_REFUSAL} Повтори правку через пару минут — продукт перезапускается с новыми ключами.` };
    }
```

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: правка не ставится, пока меняются ключи; свой reason ассистенту" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/turns.enqueue.spec.ts src/products/product-tool.rekey.spec.ts src/products/turns.revert.spec.ts src/products/product-tool.spec.ts src/products/product-lifecycle.pg.spec.ts`. Expected: PASS. Затем tsc бэка.

---

### Task 12: Сервер — журнал: вид продукта в карточке, коробки не переживают действие

**Files:**
- Modify: `src/products/product-actions.service.ts` (`ActionView`/`toView` ~38–77; `release` ~206–213; `finish` ~219–227; `sweepStuck` ~243–253)
- Test: `src/products/product-actions.sweep.pg.spec.ts` (новый, живая база), `src/products/product-actions.service.spec.ts` (вид)

Три правки журнала под смену ключей:
1. `productKind` в виде — карточка не предлагает «Убрать» у `BOT_TOKEN` бота.
2. Подметальщик `working` не трогает карточку, у которой задание `rekey` ещё в очереди или идёт (иначе карточка, отправленная на 29-й минуте, умерла бы через 11 минут при живом задании), и закрывает ту, чьё задание сняли снаружи (сборщик, удаление, возврат), — с текстом смены ключей.
3. Коробка (`secrets_box`) стирается ЛЮБЫМ закрытием карточки (`finish`, `release`, подметальщик) — шифротекст живёт не дольше задания (спека, «Журнал»).

- [ ] **Step 1: Тесты**

В `src/products/product-actions.service.spec.ts`, в `describe('вид действия', …)`:

```ts
  it('вид продукта — из payload; у карточки бота — всегда bot', () => {
    expect(toView(row({ payload: { productKind: 'site' } }), now).productKind).toBe('site');
    expect(toView(row({ kind: 'create_bot', payload: {} }), now).productKind).toBe('bot');
    expect(toView(row({ payload: {} }), now).productKind).toBeNull();
  });
```

`src/products/product-actions.sweep.pg.spec.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProductActionsService, REKEY_FAILED_SAY } from './product-actions.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('подметальщик журнала и коробки ключей против живого Postgres', () => {
  let pool: Pool;
  let svc: ProductActionsService;

  async function product() {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ($1, 'u1', 'П', $2, 'bot', 'running', '/product', $3)`,
      [id, `s-${id.slice(0, 8)}`, `h-${id}`],
    );
    return id;
  }
  async function keysCard(productId: string, o: { expired: boolean; job?: 'queued' | 'running' | 'failed' }) {
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, secrets_box, expires_at)
       VALUES ('u1', $1, 'keys', 'working', 'web', '\\x01020304'::bytea,
               CASE WHEN $2 THEN now() - interval '20 minutes' ELSE now() + interval '20 minutes' END)
       RETURNING id`,
      [productId, o.expired],
    );
    if (o.job) {
      await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status, action_id) VALUES ($1, 'rekey', $2, $3)`,
        [productId, o.job, a.rows[0].id],
      );
    }
    return a.rows[0].id as string;
  }
  const card = async (id: string) => (await pool.query(`SELECT status, secrets_box, result FROM product_actions WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    svc = new ProductActionsService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(() => pool.query('TRUNCATE products, product_provision_jobs, product_actions RESTART IDENTITY CASCADE'));
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_actions RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('карточка с живым заданием rekey не подметается даже после срока', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: true, job: 'running' });
    await svc.sweepStuck();
    expect((await card(id)).status).toBe('working');
  });

  it('задание сняли снаружи — карточка failed с текстом смены ключей, коробка стёрта', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false, job: 'failed' });
    await svc.sweepStuck();
    const c = await card(id);
    expect(c.status).toBe('failed');
    expect(c.secrets_box).toBeNull();
    expect(c.result).toEqual({ error: REKEY_FAILED_SAY, reason: 'rekey_failed' });
  });

  it('прежнее поведение: working без задания после срока + 10 минут — failed с общим текстом', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: true });
    await svc.sweepStuck();
    expect((await card(id)).result).toEqual({ error: 'Действие прервалось — попросите ассистента повторить' });
  });

  it('закрытая карточка с коробкой — коробка стирается подметальщиком', async () => {
    const p = await product();
    const id = await keysCard(p, { expired: false });
    await pool.query(`UPDATE product_actions SET status = 'done' WHERE id = $1`, [id]);
    await svc.sweepStuck();
    expect((await card(id)).secrets_box).toBeNull();
  });

  it('finish и release стирают коробку сами', async () => {
    const p = await product();
    const a = await keysCard(p, { expired: false });
    await svc.release(a, { error: 'поправьте' });
    expect((await card(a)).secrets_box).toBeNull();
    const b = await keysCard(p, { expired: false });
    await svc.finish(b, 'failed', { error: 'x' });
    expect((await card(b)).secrets_box).toBeNull();
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add src/products/product-actions.service.spec.ts src/products/product-actions.sweep.pg.spec.ts && git -C $B commit -q -m "test(products): журнал — вид продукта, подметальщик смены ключей, коробки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-actions.service.spec.ts src/products/product-actions.sweep.pg.spec.ts`.

- [ ] **Step 3: Реализация** в `src/products/product-actions.service.ts`

1. `ActionView` — после `productName`:

```ts
  /** Форма продукта: карточка ключей не предлагает убрать BOT_TOKEN у бота. */
  productKind: 'site' | 'bot' | null;
```
и в `toView` после `productName: …,`:

```ts
    productKind: row.kind === 'create_bot'
      ? 'bot'
      : (row.payload?.productKind === 'site' || row.payload?.productKind === 'bot' ? row.payload.productKind : null),
```

2. `release`: строку `` `UPDATE product_actions SET status = 'pending', confirmed_via = NULL, result = $2::jsonb `` заменить на `` `UPDATE product_actions SET status = 'pending', confirmed_via = NULL, result = $2::jsonb, secrets_box = NULL ``; в докблок: «Коробка ключей стирается и здесь: pending-карточка шифротекста не держит никогда — новый набор пишется только вместе с заданием (ProductKeysService)».

3. `finish`: в `SET` после `resolved_at = now(),` добавить `secrets_box = NULL,`; в докблок: «Любое закрытие стирает коробку ключей: шифротекст живёт не дольше задания».

4. `sweepStuck` целиком:

```ts
  /**
   * working-карточки без исхода. Два случая:
   *   - процесс умер между claim и finish/release (обрыв с базой, падение) —
   *     у карточки нет задания, и срок в прошлом больше чем на 10 минут
   *     отличает мертвеца от живой операции (сама работа — секунды);
   *   - смена ключей: задание rekey сняли снаружи (сборщик зависших,
   *     удаление продукта, возврат) — исход в карточку не записан. Такая
   *     карточка закрывается с текстом смены ключей, без ожидания срока.
   * Карточку с ЖИВЫМ заданием (queued/running) не трогаем ни при каком сроке:
   * отправленная на 29-й минуте, она иначе умерла бы при работающем агенте.
   *
   * Вторым оператором — стирание коробок у закрытых карточек: страховка на
   * случай закрытия мимо finish/release (ручная правка, будущий код).
   */
  async sweepStuck(): Promise<number> {
    const r = await this.pg.query(
      `UPDATE product_actions a
          SET status = 'failed',
              secrets_box = NULL,
              result = CASE
                WHEN EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id)
                  THEN jsonb_build_object('error', $1::text, 'reason', 'rekey_failed')
                ELSE jsonb_build_object('error', 'Действие прервалось — попросите ассистента повторить')
              END,
              resolved_at = now()
        WHERE a.status = 'working'
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.action_id = a.id AND j.status IN ('queued','running','done'))
          AND (EXISTS (SELECT 1 FROM product_provision_jobs j WHERE j.action_id = a.id AND j.status = 'failed')
               OR a.expires_at < now() - interval '10 minutes')
       RETURNING a.id`,
      [REKEY_FAILED_SAY],
    );
    await this.pg.query(
      `UPDATE product_actions SET secrets_box = NULL
        WHERE secrets_box IS NOT NULL AND status IN ('done','failed','expired','cancelled')`,
    );
    return r.rows.length;
  }
```
`REKEY_FAILED_SAY` объявлен в этом же файле (задача 10) — объявление стоит выше класса.

Юнит-сторож `sweepStuck` в `product-actions.service.spec.ts` (~101–110) проверяет `calls[0]`: `status = 'working'`, `expires_at < now() - interval '10 minutes'`, `status = 'failed'`, `Действие прервалось`, отсутствие `BOT_TOKEN|pending` — новая форма всё это сохраняет.

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add src/products/product-actions.service.ts && git -C $B commit -q -m "products: журнал — вид продукта в карточке; подметальщик не трогает живую смену ключей; коробки стираются закрытием" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-actions.service.spec.ts src/products/product-actions.sweep.pg.spec.ts src/products/product-actions.pg.spec.ts src/products/product-actions.controller.spec.ts src/products/product-lifecycle.service.spec.ts src/products/product-lifecycle.pg.spec.ts`. Expected: PASS. Затем tsc бэка.

---

### Task 13: Сервер — карточка ключей: открыть и отправить

**Files:**
- Create: `src/products/product-keys.service.ts`
- Test: `src/products/product-keys.service.spec.ts` (новый, моки), `src/products/product-keys.pg.spec.ts` (новый, живая база: карточка → выдача → отчёт)

Правила:
- открыть — только живому продукту в `running`/`degraded`; спящему, погашенному, заводящемуся, не заведённому — отказ своим текстом; в карточку — ИМЕНА текущих ключей (расшифровка на сервере, значения дальше этого метода не идут);
- отправить — `{set, remove}`; поправимое (форма, занятое имя, неверный токен, бот занят, идёт правка, машина занята, «ничего не изменено») возвращает карточку в `pending` с `result.error` и `field`; непоправимое (продукт удалён, уснул, погашен) — `failed`;
- `BOT_TOKEN` бота сменился — `getMe`; Telegram не принял/не ответил — поправимо; бот уже в другом живом продукте — поправимо; `tgBotId` уходит в payload карточки (пишется в продукт отчётом об успехе, задача 10);
- новый набор = старый − `remove` + `set`, проверяется ЦЕЛИКОМ `secretsProblem` (задача 2); шифруется `SecretsService` с AAD id продукта; задание `rekey` и коробка пишутся ОДНИМ оператором, коробка — только если задание встало;
- значения ключей не попадают ни в payload, ни в result, ни в лог, ни в ответ — только имена.

- [ ] **Step 1: Тесты на моках**

`src/products/product-keys.service.spec.ts`:

```ts
import { ProductKeysService } from './product-keys.service';
import { SecretsService } from './secrets.service';

const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const AID = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000a1';
const CANARY = 'КАНАРЕЙКА-значение-ключа-7f3e';

function harness(o: { status?: string; kind?: 'site' | 'bot'; block?: string | null; old?: Record<string, string>; turns?: number; jobs?: number; taken?: boolean; queued?: number; tgBotId?: number | null } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const product = {
    id: PID, name: 'Бот', slug: 'bot-x', kind: o.kind ?? 'bot', status: o.status ?? 'running',
    block_reason: o.block ?? null, tg_bot_id: o.tgBotId ?? 111,
    secrets_encrypted: secrets.encrypt(o.old ?? { BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'o' }, PID),
  };
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM products') && sql.includes('user_id = $2')) return { rows: [product] };
      if (sql.includes('FROM product_turns')) return { rows: [{ turns: o.turns ?? 0, jobs: o.jobs ?? 0 }] };
      if (sql.includes('tg_bot_id = $1')) return { rows: o.taken ? [{ x: 1 }] : [] };
      if (sql.includes('INSERT INTO product_provision_jobs')) return { rows: [{ queued: o.queued ?? 1 }] };
      return { rows: [] };
    }),
  };
  const actions = {
    open: jest.fn(async () => ({ id: AID, expiresAt: '2026-10-26T10:30:00.000Z' })),
    claim: jest.fn(async () => ({ id: AID, user_id: 'u1', product_id: PID, kind: 'keys', status: 'working', channel: 'web', payload: {}, result: null })),
    release: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const svc = new ProductKeysService(pg as any, actions as any, secrets);
  (svc as any).checkBot = jest.fn(async () => ({ ok: true, id: 222, username: 'new_bot' }));
  return { svc, pg, calls, actions, product };
}

describe('карточка ключей: открыть', () => {
  it('в карточку — имена текущих ключей по алфавиту, без значений', async () => {
    const h = harness({ old: { OLD_KEY: CANARY, BOT_TOKEN: '111111:TEST-old' } });
    const r = await h.svc.open({ userId: 'u1', productId: PID, channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: true, actionId: AID, keyNames: ['BOT_TOKEN', 'OLD_KEY'] });
    expect(h.actions.open).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'keys', productId: PID,
      payload: { name: 'Бот', slug: 'bot-x', productKind: 'bot', keyNames: ['BOT_TOKEN', 'OLD_KEY'] },
    }));
    expect(JSON.stringify(h.actions.open.mock.calls)).not.toContain(CANARY);
  });

  it.each([
    ['sleeping', null, 'sleeping'],
    ['blocked', 'нарушение', 'blocked'],
    ['running', 'нарушение', 'blocked'],
    ['provisioning', null, 'provisioning'],
    ['failed', null, 'failed_product'],
  ])('статус %s (блок %s) — отказ %s, карточка не открывается', async (status, block, reason) => {
    const h = harness({ status, block });
    const r = await h.svc.open({ userId: 'u1', productId: PID, channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: false, reason });
    expect(h.actions.open).not.toHaveBeenCalled();
  });
});

describe('карточка ключей: отправить', () => {
  const send = (h: ReturnType<typeof harness>, set: unknown, remove: unknown = []) =>
    h.svc.complete({ userId: 'u1', actionId: AID, set, remove, via: 'chat' });

  it('замена, удаление и добавление — один оператор с заданием и коробкой; в payload только имена', async () => {
    const h = harness();
    const r = await send(h, { NEW_KEY: CANARY }, ['OLD_KEY']);
    expect(r).toEqual({ ok: true, queued: true });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(ins.sql).toMatch(/'rekey'/);
    expect(ins.sql).toMatch(/secrets_box = \$2/);
    const [actionId, box, patch] = ins.params;
    expect(actionId).toBe(AID);
    expect(secrets.decrypt(box, PID)).toEqual({ BOT_TOKEN: '111111:TEST-old', NEW_KEY: CANARY });
    expect(JSON.parse(patch)).toEqual({ newKeyNames: ['BOT_TOKEN', 'NEW_KEY'], removedNames: ['OLD_KEY'], changedNames: ['NEW_KEY'] });
    expect(h.actions.release).not.toHaveBeenCalled();
    expect(h.actions.finish).not.toHaveBeenCalled();
  });

  it('значение ключа не уходит никуда, кроме коробки: ни в SQL-параметры текстом, ни в ответ, ни в лог', async () => {
    const h = harness();
    const logs: string[] = [];
    (h.svc as any).logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), log: (m: string) => logs.push(m) };
    const r = await send(h, { NEW_KEY: CANARY, BAD_ONE: '' });
    const textParams = h.calls.flatMap((c) => c.params).filter((p) => !Buffer.isBuffer(p));
    expect(JSON.stringify(textParams)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(h.actions.release.mock.calls)).not.toContain(CANARY);
    expect(logs.join('\n')).not.toContain(CANARY);
  });

  it.each([
    [{}, [], 'nothing'],
    [{ A: 'x' }, ['A'], 'bad_input'],
    [{ PORT: '1' }, [], 'bad_input'],
    [{ OWNER_TG_ID: '1' }, [], 'bad_input'],
    [{ 'A B': '1' }, [], 'bad_input'],
    [{ A: '' }, [], 'bad_input'],
    [{}, ['BOT_TOKEN'], 'bad_input'],
    [{}, ['NO_SUCH'], 'bad_input'],
    ['не объект', [], 'bad_input'],
    [{}, 'не список', 'bad_input'],
  ])('set %j, remove %j — поправимо (%s): карточка снова ждёт, задания нет', async (set, remove, reason) => {
    const h = harness();
    const r = await send(h, set, remove);
    expect(r).toMatchObject({ ok: false, reason });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ error: expect.any(String) }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('идёт правка или машина занята — поправимо, своим текстом', async () => {
    const a = harness({ turns: 1 });
    expect(await send(a, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'busy_turn' });
    const b = harness({ jobs: 1 });
    expect(await send(b, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('новый BOT_TOKEN: getMe; Telegram не принял — поправимо, поле BOT_TOKEN', async () => {
    const h = harness();
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: false, reason: 'rejected' }));
    const r = await send(h, { BOT_TOKEN: '222222:TEST-new' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_token' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'BOT_TOKEN' }));
  });

  it('новый BOT_TOKEN другого бота, который уже в живом продукте, — поправимо', async () => {
    const h = harness({ taken: true });
    expect(await send(h, { BOT_TOKEN: '222222:TEST-new' })).toMatchObject({ ok: false, reason: 'bot_in_use' });
  });

  it('новый BOT_TOKEN свободного бота — tgBotId в payload, токен без пробелов по краям', async () => {
    const h = harness();
    await send(h, { BOT_TOKEN: '  222222:TEST-new  ' });
    expect((h.svc as any).checkBot).toHaveBeenCalledWith('222222:TEST-new');
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(JSON.parse(ins.params[2]).tgBotId).toBe(222);
  });

  it('тот же BOT_TOKEN — Telegram не спрашивается', async () => {
    const h = harness();
    await send(h, { BOT_TOKEN: '111111:TEST-old', NEW_KEY: 'n' });
    expect((h.svc as any).checkBot).not.toHaveBeenCalled();
  });

  it.each([['sleeping', null], ['running', 'блок']])('продукт в %s (блок %s) к моменту отправки — карточка failed', async (status, block) => {
    const h = harness({ status, block });
    const r = await send(h, { NEW_KEY: 'n' });
    expect(r.ok).toBe(false);
    expect(h.actions.finish).toHaveBeenCalledWith(AID, 'failed', expect.objectContaining({ error: expect.any(String) }));
  });

  it('продукт сменил состояние между проверкой и записью — failed, коробки нет', async () => {
    const h = harness({ queued: 0 });
    const r = await send(h, { NEW_KEY: 'n' });
    expect(r).toMatchObject({ ok: false, reason: 'state_changed' });
    expect(h.actions.finish).toHaveBeenCalledWith(AID, 'failed', expect.any(Object));
  });

  it('чужая, закрытая или просроченная карточка — not_pending, база не трогается', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValueOnce(null as any);
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(h.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Тест против живой базы** — вся цепочка: карточка → выдача агенту → отчёт

`src/products/product-keys.pg.spec.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';
import { ProductActionsService } from './product-actions.service';
import { ProductKeysService } from './product-keys.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

maybe('смена ключей целиком против живого Postgres', () => {
  let pool: Pool;
  let provisioning: ProvisioningService;
  let keys: ProductKeysService;
  let actions: ProductActionsService;
  const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    provisioning = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
    actions = new ProductActionsService(pg as any);
    keys = new ProductKeysService(pg as any, actions, secrets);
    (keys as any).checkBot = async () => ({ ok: true, id: 222, username: 'new_bot' });
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  async function bot() {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, tg_bot_id, secrets_encrypted)
       VALUES ($1, 'u1', 'Бот', $2, 'bot', 'running', '/product', $3, 'clients', 111, $4)`,
      [id, `b-${id.slice(0, 8)}`, `h-${id}`, secrets.encrypt({ BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'o' }, id)],
    );
    return id;
  }

  it('карточка → задание с коробкой → агент получает новый набор → отчёт переносит ключи и метку бота', async () => {
    const p = await bot();
    const opened = await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null });
    expect(opened).toMatchObject({ ok: true, keyNames: ['BOT_TOKEN', 'OLD_KEY'] });
    const actionId = (opened as any).actionId;

    expect(await keys.complete({ userId: 'u1', actionId, set: { BOT_TOKEN: '222222:TEST-new', NEW_KEY: 'n' }, remove: ['OLD_KEY'], via: 'cabinet' }))
      .toEqual({ ok: true, queued: true });

    const job = await provisioning.claimJob('clients');
    expect(job).toMatchObject({ jobKind: 'rekey', secrets: { BOT_TOKEN: '222222:TEST-new', NEW_KEY: 'n' }, dropNames: ['OLD_KEY'] });

    await provisioning.completeJob(job!.jobId, { ok: true });

    const row = (await pool.query(`SELECT secrets_encrypted, tg_bot_id FROM products WHERE id = $1`, [p])).rows[0];
    expect(secrets.decrypt(row.secrets_encrypted, p)).toEqual({ BOT_TOKEN: '222222:TEST-new', NEW_KEY: 'n' });
    expect(Number(row.tg_bot_id)).toBe(222);
    const a = (await pool.query(`SELECT status, secrets_box, payload, result FROM product_actions WHERE id = $1`, [actionId])).rows[0];
    expect(a.status).toBe('done');
    expect(a.secrets_box).toBeNull();
    expect(JSON.stringify(a)).not.toMatch(/TEST-new|TEST-old/);
  });

  it('пока задание стоит, правка не ставится, а второе нажатие той же карточки — not_pending', async () => {
    const p = await bot();
    const { actionId } = (await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null })) as any;
    await keys.complete({ userId: 'u1', actionId, set: { NEW_KEY: 'n' }, remove: [], via: 'chat' });
    expect(await keys.complete({ userId: 'u1', actionId, set: { NEW_KEY: 'm' }, remove: [], via: 'chat' })).toMatchObject({ reason: 'not_pending' });
    const jobs = await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id = $1 AND kind = 'rekey'`, [p]);
    expect(jobs.rows[0].n).toBe(1);
  });

  it('у продукта уже стоит задание — поправимо, коробка не записана', async () => {
    const p = await bot();
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'domain', 'queued')`, [p]);
    const { actionId } = (await keys.open({ userId: 'u1', productId: p, channel: 'web', turn: null })) as any;
    expect(await keys.complete({ userId: 'u1', actionId, set: { NEW_KEY: 'n' }, remove: [], via: 'chat' })).toMatchObject({ reason: 'busy' });
    const a = (await pool.query(`SELECT status, secrets_box FROM product_actions WHERE id = $1`, [actionId])).rows[0];
    expect(a).toEqual({ status: 'pending', secrets_box: null });
  });
});
```

- [ ] **Step 3: Коммит, прогон — FAIL** (`Cannot find module './product-keys.service'`)

```bash
git -C $B add src/products/product-keys.service.spec.ts src/products/product-keys.pg.spec.ts && git -C $B commit -q -m "test(products): карточка ключей — правила, канарейка, вся цепочка до отчёта (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-keys.service.spec.ts src/products/product-keys.pg.spec.ts`.

- [ ] **Step 4: Реализация**

`src/products/product-keys.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { BotTokenCheck, checkBotToken } from './bot-token-check';
import { ActionChannel, ActionRow, ConfirmedVia, ProductActionsService } from './product-actions.service';
import { secretsProblem } from './secret-rules';
import { SecretsService } from './secrets.service';

export type KeysFail = { ok: false; reason: string; message: string };

/**
 * Отказ по состоянию продукта — один на открытие и на отправку: продукт мог
 * уснуть или попасть под блокировку, пока карточка ждала нажатия.
 */
function statusRefusal(p: { status: string; block_reason: string | null }): KeysFail | null {
  if (p.block_reason !== null || p.status === 'blocked') {
    return { ok: false, reason: 'blocked', message: 'Продукт остановлен администратором — ключи меняются через поддержку' };
  }
  if (p.status === 'sleeping') {
    return { ok: false, reason: 'sleeping', message: 'Продукт спит: не хватило токенов на аренду. Ключи меняются у работающего продукта — пополните баланс, он проснётся сам' };
  }
  if (p.status === 'provisioning') {
    return { ok: false, reason: 'provisioning', message: 'Продукт ещё заводится — ключи можно сменить через минуту' };
  }
  if (p.status === 'failed') {
    return { ok: false, reason: 'failed_product', message: 'Продукт не завёлся — сначала его нужно завести заново' };
  }
  if (p.status !== 'running' && p.status !== 'degraded') {
    return { ok: false, reason: 'unavailable', message: 'Продукт сейчас недоступен' };
  }
  return null;
}

/**
 * Смена ключей владельца карточкой (очередь 2). Открывает карточку с ИМЕНАМИ
 * текущих ключей и принимает её отправку: проверяет новый набор теми же
 * правилами, что заведение, шифрует его в коробку карточки и одним
 * оператором ставит задание rekey агенту машины. Ключи в базе продукта
 * меняются только отчётом агента об успехе (ProvisioningService).
 *
 * Значения ключей живут здесь только в локальных переменных: в payload и
 * result — имена, в логе — ничего от значений, в ответе — ничего.
 */
@Injectable()
export class ProductKeysService {
  private readonly logger = new Logger(ProductKeysService.name);
  /** Поле, а не прямой вызов: тесты подменяют Telegram (тот же приём, что у lifecycle). */
  private checkBot: (token: string) => Promise<BotTokenCheck> = (t) => checkBotToken(t);

  constructor(
    private readonly pg: PgService,
    private readonly actions: ProductActionsService,
    private readonly secrets: SecretsService,
  ) {}

  async open(i: { userId: string; productId: string; channel: ActionChannel; turn: string | null }):
    Promise<{ ok: true; actionId: string; expiresAt: string; keyNames: string[] } | KeysFail> {
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, status, block_reason, secrets_encrypted FROM products
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [i.productId, i.userId],
    );
    const p = r.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'Такого продукта нет' };
    const refusal = statusRefusal(p);
    if (refusal) return refusal;
    let keyNames: string[];
    try {
      keyNames = p.secrets_encrypted ? Object.keys(this.secrets.decrypt(p.secrets_encrypted, p.id)).sort() : [];
    } catch (e: any) {
      this.logger.error(`ключи продукта ${p.id} не расшифровались: ${e?.message}`);
      return { ok: false, reason: 'failed', message: 'Ключи продукта сейчас не читаются — напишите в поддержку' };
    }
    const { id, expiresAt } = await this.actions.open({
      userId: i.userId, productId: p.id, kind: 'keys', channel: i.channel, turn: i.turn,
      payload: { name: p.name, slug: p.slug, productKind: p.kind, keyNames },
    });
    return { ok: true, actionId: id, expiresAt, keyNames };
  }

  async complete(i: { userId: string; actionId: string; set: unknown; remove: unknown; via: ConfirmedVia }):
    Promise<{ ok: true; queued: true } | KeysFail> {
    const row = await this.actions.claim(i.userId, i.actionId, i.via);
    if (!row || row.kind !== 'keys' || !row.product_id) {
      if (row) await this.actions.release(row.id, row.result ?? {});
      return { ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' };
    }
    try {
      return await this.submit(row, i);
    } catch (e: any) {
      // Непонятная ошибка между claim и исходом — без release карточка умерла
      // бы в working (claim и cancel требуют pending). В лог — только текст
      // ошибки: параметры запросов pg в message не кладёт.
      this.logger.warn(`keys ${row.id} упал между claim и исходом: ${e?.message ?? e}`);
      const message = 'Не получилось — попробуйте ещё раз позже';
      await this.actions.release(row.id, { error: message });
      return { ok: false, reason: 'failed', message };
    }
  }

  private async submit(row: ActionRow, i: { userId: string; set: unknown; remove: unknown }): Promise<{ ok: true; queued: true } | KeysFail> {
    const fix = async (message: string, reason: string, field?: string): Promise<KeysFail> => {
      await this.actions.release(row.id, field ? { error: message, field } : { error: message });
      return { ok: false, reason, message };
    };
    const fail = async (message: string, reason: string): Promise<KeysFail> => {
      await this.actions.finish(row.id, 'failed', { error: message, reason });
      return { ok: false, reason, message };
    };

    const r = await this.pg.query(
      `SELECT id, kind, status, block_reason, secrets_encrypted, tg_bot_id FROM products
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [row.product_id, i.userId],
    );
    const p = r.rows[0];
    if (!p) return fail('Продукт удалён — ключи менять не у чего', 'not_found');
    const refusal = statusRefusal(p);
    if (refusal) return fail(refusal.message, refusal.reason);

    // --- Форма тела. Значения — только в set, и только строками. ---
    const set: Record<string, string> = {};
    if (i.set !== undefined && i.set !== null) {
      if (typeof i.set !== 'object' || Array.isArray(i.set)) return fix('Ключи пришли не в той форме — обновите карточку', 'bad_input');
      for (const [k, v] of Object.entries(i.set as Record<string, unknown>)) {
        if (typeof v !== 'string') return fix(`секрет ${k}: значение должно быть непустой строкой`, 'bad_input', k);
        set[k] = k === 'BOT_TOKEN' ? v.trim() : v;
      }
    }
    if (i.remove !== undefined && i.remove !== null && (!Array.isArray(i.remove) || i.remove.some((n) => typeof n !== 'string'))) {
      return fix('Список удаляемых ключей не в той форме — обновите карточку', 'bad_input');
    }
    const remove = [...new Set((i.remove as string[] | undefined) ?? [])];
    if (!Object.keys(set).length && !remove.length) return fix('Ничего не изменено: замените, уберите или добавьте ключ', 'nothing');
    const both = remove.find((n) => Object.prototype.hasOwnProperty.call(set, n));
    if (both) return fix(`Ключ ${both} и заменён, и убран — оставьте что-то одно`, 'bad_input', both);
    if (p.kind === 'bot' && remove.includes('BOT_TOKEN')) return fix('Токен бота убрать нельзя — его можно только заменить', 'bad_input', 'BOT_TOKEN');

    // --- Занятость: правка и задание машины. ---
    const busy = await this.pg.query(
      `SELECT (SELECT count(*) FROM product_turns WHERE product_id = $1 AND status IN ('queued','running'))::int AS turns,
              (SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND status IN ('queued','running'))::int AS jobs`,
      [p.id],
    );
    if (busy.rows[0]?.turns > 0) return fix('Сейчас идёт правка продукта — отправьте карточку, когда она закончится', 'busy_turn');
    if (busy.rows[0]?.jobs > 0) return fix('Машина продукта сейчас занята — отправьте карточку через минуту', 'busy');

    // --- Новый набор целиком и проверка теми же правилами, что заведение. ---
    const old: Record<string, string> = p.secrets_encrypted ? this.secrets.decrypt(p.secrets_encrypted, p.id) : {};
    const missing = remove.find((n) => !Object.prototype.hasOwnProperty.call(old, n));
    if (missing) return fix(`Ключа ${missing} у продукта нет`, 'bad_input', missing);
    // Object.fromEntries, а не присваивание: имя `__proto__` форму переменной
    // проходит, а `obj['__proto__'] = …` своего ключа не создаёт.
    const merged: Record<string, string> = Object.fromEntries([
      ...Object.entries(old).filter(([k]) => !remove.includes(k) && !Object.prototype.hasOwnProperty.call(set, k)),
      ...Object.entries(set),
    ]);
    const problem = secretsProblem(merged);
    if (problem) return fix(problem.message, 'bad_input', problem.field);
    if (p.kind === 'bot' && !merged.BOT_TOKEN) return fix('У бота должен быть BOT_TOKEN', 'bad_input', 'BOT_TOKEN');

    // --- Новый токен бота — в Telegram, до записи чего-либо. ---
    let tgBotId: number | undefined;
    if (p.kind === 'bot' && set.BOT_TOKEN !== undefined && set.BOT_TOKEN !== old.BOT_TOKEN) {
      const check = await this.checkBot(set.BOT_TOKEN);
      // `=== false`, а не `!check.ok`: strictNullChecks выключен (см. «Общее»).
      if (check.ok === false) {
        return fix(
          check.reason === 'unreachable'
            ? 'Не удалось проверить токен в Telegram — попробуйте ещё раз через минуту'
            : 'Telegram не принял токен бота — скопируйте его целиком из @BotFather',
          'bad_token', 'BOT_TOKEN',
        );
      }
      if (Number(p.tg_bot_id) !== check.id) {
        const taken = await this.pg.query(
          `SELECT 1 FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL AND id <> $2 LIMIT 1`,
          [check.id, p.id],
        );
        if (taken.rows.length) return fix('Этот бот уже работает в другом продукте — создайте в @BotFather нового бота', 'bot_in_use', 'BOT_TOKEN');
        tgBotId = check.id;
      }
    }

    // --- Задание и коробка — одним оператором; коробка — только при задании. ---
    const patch = {
      newKeyNames: Object.keys(merged).sort(),
      removedNames: Object.keys(old).filter((n) => !Object.prototype.hasOwnProperty.call(merged, n)).sort(),
      changedNames: Object.keys(set).filter((k) => old[k] !== set[k]).sort(),
      ...(tgBotId !== undefined ? { tgBotId } : {}),
    };
    const box = this.secrets.encrypt(merged, p.id);
    let q: any;
    try {
      q = await this.pg.query(
        `WITH ins AS (
            INSERT INTO product_provision_jobs (product_id, kind, status, action_id)
            SELECT pr.id, 'rekey', 'queued', a.id
              FROM product_actions a JOIN products pr ON pr.id = a.product_id
             WHERE a.id = $1 AND a.status = 'working'
               AND pr.archived_at IS NULL AND pr.status IN ('running','degraded') AND pr.block_reason IS NULL
            RETURNING action_id
         ), upd AS (
            UPDATE product_actions a SET secrets_box = $2, payload = a.payload || $3::jsonb
              FROM ins WHERE a.id = ins.action_id
            RETURNING a.id
         )
         SELECT (SELECT count(*) FROM ins)::int AS queued`,
        [row.id, box, JSON.stringify(patch)],
      );
    } catch (e: any) {
      if (e?.code === '23505' && e?.constraint === 'product_provision_jobs_one_active') {
        return fix('Машина продукта сейчас занята — отправьте карточку через минуту', 'busy');
      }
      throw e;
    }
    if (!q.rows[0]?.queued) return fail('Продукт сменил состояние — ключи не меняются, попросите ассистента ещё раз', 'state_changed');
    return { ok: true, queued: true };
  }
}
```

Сторож «значения не уходят»: тест канарейки выше проверяет параметры запросов (кроме `Buffer` коробки), ответ, `release` и лог.

- [ ] **Step 5: Коммит, прогон — PASS**

```bash
git -C $B add src/products/product-keys.service.ts && git -C $B commit -q -m "products: карточка ключей — имена при открытии; отправка ставит rekey с коробкой одним оператором" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-keys.service.spec.ts src/products/product-keys.pg.spec.ts src/products/provisioning.rekey-purge.spec.ts`. Expected: PASS. Затем tsc бэка.

---

### Task 14: Сервер — обход стирания и резервные копии

**Files:**
- Create: `src/products/product-purge.service.ts`
- Modify: `src/products/product-lifecycle.service.ts` (`sleepDeletedTick` ~215–228: не снимать `purge`)
- Test: `src/products/product-purge.service.spec.ts` (новый: чистые функции пути), `src/products/product-purge.pg.spec.ts` (новый: обход и копии против живой базы и временного каталога)

- [ ] **Step 1: Тесты**

`src/products/product-purge.service.spec.ts`:

```ts
import { backupPathFor, reposRoot } from './product-purge.service';

const ROOT = '/home/owner/product-repos';

describe('путь резервной копии — только ровно <корень>/<слаг>.git', () => {
  it('repo_url скрипта product-backup-setup.sh — годится', () => {
    expect(backupPathFor(`backup@10.0.0.1:${ROOT}/shop.git`, 'shop', ROOT)).toBe(`${ROOT}/shop.git`);
    expect(backupPathFor(`${ROOT}/shop.git`, 'shop', ROOT)).toBe(`${ROOT}/shop.git`);
  });

  it.each([
    [`backup@10.0.0.1:${ROOT}/other.git`, 'shop'],
    [`backup@10.0.0.1:${ROOT}/../product-repos/shop.git/..`, 'shop'],
    [`backup@10.0.0.1:/home/owner/elsewhere/shop.git`, 'shop'],
    [`backup@10.0.0.1:${ROOT}/shop.git`, '..'],
    [`backup@10.0.0.1:${ROOT}/shop.git`, ''],
    [`backup@10.0.0.1:${ROOT}`, 'shop'],
    ['https://github.com/x/shop.git', 'shop'],
    ['', 'shop'],
  ])('%j при слаге %j — не наша копия, null', (url, slug) => {
    expect(backupPathFor(url, slug, ROOT)).toBeNull();
  });

  it('корень — абсолютный и не у самого корня ФС', () => {
    expect(reposRoot({ PRODUCT_REPOS_DIR: '/srv/backups/product-repos' } as any)).toBe('/srv/backups/product-repos');
    expect(() => reposRoot({ PRODUCT_REPOS_DIR: 'relative/dir' } as any)).toThrow(/абсолютн/);
    expect(() => reposRoot({ PRODUCT_REPOS_DIR: '/' } as any)).toThrow(/корн/);
    expect(reposRoot({} as any)).toMatch(/\/product-repos$/);
  });
});
```

`src/products/product-purge.pg.spec.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProductPurgeService } from './product-purge.service';
import { ProductLifecycleService } from './product-lifecycle.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('обход стирания и резервные копии против живого Postgres', () => {
  let pool: Pool;
  let svc: ProductPurgeService;
  let tmp: string;

  async function deleted(o: { purgeAfterMs: number; purged?: boolean; repoUrl?: string | null; slug?: string }) {
    const id = crypto.randomUUID();
    const slug = o.slug ?? `d-${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash,
                             archived_at, purge_after, purged_at, repo_url)
       VALUES ($1, 'u1', 'П', $2, 'site', 'archived', '/product', $3, now() - interval '31 days',
               now() + make_interval(secs => $4::double precision / 1000), CASE WHEN $5 THEN now() END, $6)`,
      [id, slug, `h-${id}`, o.purgeAfterMs, !!o.purged, o.repoUrl ?? null],
    );
    return { id, slug };
  }
  const jobsOf = async (id: string) =>
    (await pool.query(`SELECT kind, status FROM product_provision_jobs WHERE product_id = $1 ORDER BY created_at`, [id])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    svc = new ProductPurgeService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_actions RESTART IDENTITY CASCADE');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl2-purge-'));
    process.env.PRODUCT_REPOS_DIR = path.join(tmp, 'product-repos');
    fs.mkdirSync(process.env.PRODUCT_REPOS_DIR);
  });
  afterEach(() => {
    delete process.env.PRODUCT_REPOS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_actions RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('стирание ставится только удалённому после срока, не стёртому и без активного задания', async () => {
    const due = await deleted({ purgeAfterMs: -60_000 });
    const early = await deleted({ purgeAfterMs: 86_400_000 });
    const gone = await deleted({ purgeAfterMs: -60_000, purged: true });
    const busy = await deleted({ purgeAfterMs: -60_000 });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'sleep', 'queued')`, [busy.id]);

    expect(await svc.queuePurges()).toBe(1);
    expect(await jobsOf(due.id)).toEqual([{ kind: 'purge', status: 'queued' }]);
    expect(await jobsOf(early.id)).toEqual([]);
    expect(await jobsOf(gone.id)).toEqual([]);
    expect(await svc.queuePurges()).toBe(0);
  });

  it('после трёх провалов подряд стирание не ставится', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    for (let i = 0; i < 3; i++) {
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'purge', 'failed')`, [p.id]);
    }
    expect(await svc.queuePurges()).toBe(0);
  });

  it('сон удалённых не снимает стоящее в очереди стирание', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    await svc.queuePurges();
    const pg = { query: (s: string, q?: any[]) => pool.query(s, q) };
    const lifecycle = new ProductLifecycleService(pg as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await lifecycle.sleepDeletedTick();
    expect(await jobsOf(p.id)).toEqual([{ kind: 'purge', status: 'queued' }]);
  });

  it('копия стёртого продукта удаляется, repo_url обнуляется; чужие и неподходящие — не трогаются', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const mine = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'gone-shop', repoUrl: `backup@10.0.0.1:${root}/gone-shop.git` });
    fs.mkdirSync(path.join(root, 'gone-shop.git'));
    fs.writeFileSync(path.join(root, 'gone-shop.git', 'HEAD'), 'ref: refs/heads/master\n');
    const neighbour = path.join(root, 'live-shop.git');
    fs.mkdirSync(neighbour);
    const foreign = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'far-shop', repoUrl: 'backup@10.0.0.1:/somewhere/else/far-shop.git' });
    const alive = await deleted({ purgeAfterMs: 86_400_000, slug: 'kept-shop', repoUrl: `backup@10.0.0.1:${root}/kept-shop.git` });
    fs.mkdirSync(path.join(root, 'kept-shop.git'));

    expect(await svc.removeBackups()).toBe(1);

    expect(fs.existsSync(path.join(root, 'gone-shop.git'))).toBe(false);
    expect(fs.existsSync(neighbour)).toBe(true);
    expect(fs.existsSync(path.join(root, 'kept-shop.git'))).toBe(true);
    const urls = await pool.query(`SELECT id, repo_url FROM products WHERE id = ANY($1::uuid[])`, [[mine.id, foreign.id, alive.id]]);
    const byId = Object.fromEntries(urls.rows.map((r: any) => [r.id, r.repo_url]));
    expect(byId[mine.id]).toBeNull();
    expect(byId[foreign.id]).toBe('backup@10.0.0.1:/somewhere/else/far-shop.git');
    expect(byId[alive.id]).not.toBeNull();
  });

  it('символическая ссылка на месте копии не разыменовывается и не удаляется', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const target = path.join(tmp, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), '1');
    fs.symlinkSync(target, path.join(root, 'link-shop.git'));
    await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'link-shop', repoUrl: `backup@10.0.0.1:${root}/link-shop.git` });

    expect(await svc.removeBackups()).toBe(0);
    expect(fs.existsSync(path.join(target, 'keep'))).toBe(true);
  });

  it('копии уже нет — repo_url всё равно обнуляется', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'no-copy', repoUrl: `backup@10.0.0.1:${root}/no-copy.git` });
    expect(await svc.removeBackups()).toBe(1);
    expect((await pool.query(`SELECT repo_url FROM products WHERE id = $1`, [p.id])).rows[0].repo_url).toBeNull();
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`Cannot find module './product-purge.service'`)

```bash
git -C $B add src/products/product-purge.service.spec.ts src/products/product-purge.pg.spec.ts && git -C $B commit -q -m "test(products): обход стирания и резервные копии (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-purge.service.spec.ts src/products/product-purge.pg.spec.ts`.

- [ ] **Step 3: Реализация**

`src/products/product-purge.service.ts`:

```ts
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { SLUG_RE } from './provisioning.service';

/**
 * Раз в час, а не раз в сутки: API перезапускается выкатами несколько раз в
 * день, и суточный таймер не доживал бы до первого срабатывания никогда.
 * Условие стирания — purge_after <= now(), так что продукт стирается в первый
 * час после срока. Первый обход — через час после старта, а не на старте:
 * выкат сервера идёт раньше выката агента машины (deploy.sh, PHASE 2 и 4), и
 * обход на старте отдал бы purge агенту, который его ещё не знает.
 */
export const PURGE_TICK_MS = 60 * 60 * 1000;
/** Тот же потолок, что у сна удалённого (queueSleepForDeleted). */
const PURGE_FAIL_CAP = 3;

/**
 * Корень резервных копий: PRODUCT_REPOS_DIR или ~/product-repos пользователя
 * процесса API — туда их кладёт scripts/product-backup-setup.sh
 * (REPO_ROOT=/home/dvolkov/product-repos, API на проде работает от dvolkov).
 * Абсолютный и не ближе двух уровней к корню ФС — иначе стирать из него нельзя.
 */
export function reposRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PRODUCT_REPOS_DIR;
  const root = raw ? raw : path.join(os.homedir(), 'product-repos');
  if (!path.isAbsolute(root)) throw new Error(`PRODUCT_REPOS_DIR не абсолютный: ${JSON.stringify(raw)}`);
  const resolved = path.resolve(root);
  if (resolved.split('/').filter(Boolean).length < 2) throw new Error(`каталог копий ${resolved} слишком близко к корню ФС`);
  return resolved;
}

/**
 * Путь копии ЭТОГО продукта на ЭТОЙ машине — или null.
 *
 * Стираем только то, на что указывает repo_url продукта, и только если это
 * ровно `<корень>/<слаг>.git`: слаг сверяется SLUG_RE, путь нормализуется, и
 * результат обязан лежать прямо в корне. Копия другой машины (repo_url с
 * чужим путём), чужой формы (https) или с `..` — не наша.
 */
export function backupPathFor(repoUrl: string, slug: string, root: string): string | null {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  const m = /^(?:(?:[^@/:\s]+@)?[^/:\s]+:)?(\/\S+)$/.exec(String(repoUrl ?? ''));
  if (!m) return null;
  const want = path.join(root, `${slug}.git`);
  if (path.dirname(want) !== root) return null;
  return path.resolve(m[1]) === want ? want : null;
}

/**
 * Стирание удалённых продуктов (очередь 2): ставит задание purge агенту машины
 * тем, у кого вышел срок возврата, и стирает резервные копии уже стёртых.
 * Пометку «стёрт» ставит отчёт агента (ProvisioningService.completePurgeJob).
 */
@Injectable()
export class ProductPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductPurgeService.name);
  private timer?: NodeJS.Timeout;
  /** Разовые предупреждения на процесс — тот же приём, что warnedSleepCap. */
  private warned = new Set<string>();

  constructor(private readonly pg: PgService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), PURGE_TICK_MS);
    // unref, иначе таймер держит процесс и jest не завершается.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      await this.queuePurges();
    } catch (e: any) {
      this.logger.error(`обход стирания: ${e?.message}`);
    }
    try {
      await this.removeBackups();
    } catch (e: any) {
      this.logger.error(`стирание резервных копий: ${e?.message}`);
    }
  }

  async queuePurges(): Promise<number> {
    const capped = await this.pg.query(
      `SELECT p.id, p.slug FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.purge_after <= now()
          AND (SELECT count(*) FROM product_provision_jobs j
                WHERE j.product_id = p.id AND j.kind = 'purge' AND j.status = 'failed') >= $1`,
      [PURGE_FAIL_CAP],
    );
    for (const row of capped.rows) {
      if (this.warned.has(`cap:${row.id}`)) continue;
      this.warned.add(`cap:${row.id}`);
      this.logger.error(`стирание продукта ${row.id} (${row.slug}) не ставится: ${PURGE_FAIL_CAP} провала подряд — нужен ручной разбор`);
    }
    // FOR UPDATE OF p — тот же замок, что у сна удалённых: возврат (restore)
    // держит строку продукта до COMMIT, и стирание, прочитавшее снимок до
    // возврата, иначе встало бы вернувшемуся продукту.
    const r = await this.pg.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status)
       SELECT p.id, 'purge', 'queued' FROM products p
        WHERE p.archived_at IS NOT NULL AND p.purged_at IS NULL AND p.status = 'archived'
          AND p.purge_after IS NOT NULL AND p.purge_after <= now()
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND (SELECT count(*) FROM product_provision_jobs j
                WHERE j.product_id = p.id AND j.kind = 'purge' AND j.status = 'failed') < $1
          FOR UPDATE OF p
       ON CONFLICT DO NOTHING
       RETURNING product_id`,
      [PURGE_FAIL_CAP],
    );
    return r.rows.length;
  }

  async removeBackups(): Promise<number> {
    const root = reposRoot();
    const r = await this.pg.query(
      `SELECT id, slug, repo_url FROM products
        WHERE purged_at IS NOT NULL AND repo_url IS NOT NULL
        ORDER BY purged_at LIMIT 20`,
    );
    let removed = 0;
    for (const p of r.rows) {
      const where = backupPathFor(p.repo_url, p.slug, root);
      if (!where) {
        this.warnOnce(`foreign:${p.id}`, `резервная копия стёртого продукта ${p.slug} не на этой машине или не по форме (${p.repo_url}) — стереть руками`);
        continue;
      }
      try {
        let st: fs.Stats | null = null;
        try {
          st = await fs.promises.lstat(where);
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }
        // lstat, а не stat: символическую ссылку не разыменовываем — она
        // могла бы увести удаление куда угодно.
        if (st && (st.isSymbolicLink() || !st.isDirectory())) {
          this.warnOnce(`odd:${p.id}`, `на месте копии ${where} не каталог — не трогаю, стереть руками`);
          continue;
        }
        if (st) await fs.promises.rm(where, { recursive: true, force: true });
        await this.pg.query(`UPDATE products SET repo_url = NULL WHERE id = $1 AND purged_at IS NOT NULL`, [p.id]);
        removed += 1;
      } catch (e: any) {
        this.logger.error(`резервная копия ${p.slug} не стёрта: ${e?.message}`);
      }
    }
    return removed;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
```

В `src/products/product-lifecycle.service.ts`, в `sleepDeletedTick`, строку

```sql
          AND j.status = 'queued' AND j.kind <> 'sleep'`,
```
заменить на

```sql
          AND j.status = 'queued' AND j.kind NOT IN ('sleep','purge')`,
```
и дописать в комментарий над запросом: «Стирание (purge, очередь 2) — тоже задание архивного продукта, его не снимаем».

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: почасовой обход стирания удалённых; стирание резервных копий по строгому пути" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-purge.service.spec.ts src/products/product-purge.pg.spec.ts src/products/product-lifecycle.pg.spec.ts src/products/product-lifecycle.service.spec.ts`. Expected: PASS. Затем tsc бэка.

---

### Task 15: Сервер — действие `keys` инструмента, отправка карточки, «уже стёрт», регистрация

**Files:**
- Modify: `src/products/product-lifecycle-tool.ts` (конструктор, новые `keys` и `resolveGone`, `restore`, `actionStatus`)
- Modify: `src/products/product-tool.service.ts` (`execute` ~315–352, `PRODUCT_TOOLS` ~702–790)
- Modify: `src/products/product-actions.controller.ts` (DTO, конструктор, ветка `keys`)
- Modify: `src/products/products.module.ts` (`ProductKeysService`, `ProductPurgeService`)
- Modify: `src/products/product-tool.defs.spec.ts` (~10–18, ~73–79, ~104–108)
- Test: `src/products/product-lifecycle-tool.keys.spec.ts` (новый), `src/products/product-actions.controller.keys.spec.ts` (новый)

- [ ] **Step 1: Тесты**

`src/products/product-lifecycle-tool.keys.spec.ts`:

```ts
import { ProductToolService } from './product-tool.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';

const PRODUCT = { id: 'p1', name: 'Бот отчётов', slug: 'bot-otchet', domain: null, kind: 'bot', status: 'running' };

function harness(o: { gone?: boolean } = {}) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('purged_at IS NOT NULL OR purge_after <= now()')) {
        return { rows: o.gone ? [{ id: 'p0', name: 'Старый сайт', slug: 'old', kind: 'site', purge_after: '2026-09-01T00:00:00.000Z' }] : [] };
      }
      if (sql.includes('archived_at IS NOT NULL')) return { rows: [] };
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      return { rows: [] };
    }),
  };
  const keysSvc = {
    open: jest.fn(async () => ({ ok: true, actionId: 'a-keys', expiresAt: '2026-10-26T10:30:00.000Z', keyNames: ['BOT_TOKEN', 'OZON_API_KEY'] })),
  };
  const actions = { get: jest.fn(async () => null) };
  const tool = new ProductLifecycleTool(pg as any, {} as any, actions as any, keysSvc as any);
  const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
  return { svc, keysSvc, actions };
}

describe('действие keys', () => {
  it('открывает карточку: в ответе имена ключей, значений нет, ключи в переписке не просить', async () => {
    const h = harness();
    const r: any = await h.svc.execute('u1', { action: 'keys', product: 'бот отчётов' }, 'web', '11111111-2222-4333-8444-555555555555');
    expect(h.keysSvc.open).toHaveBeenCalledWith({ userId: 'u1', productId: 'p1', channel: 'web', turn: '11111111-2222-4333-8444-555555555555' });
    expect(r).toMatchObject({ ok: true, pending: { actionId: 'a-keys', kind: 'keys' }, keyNames: ['BOT_TOKEN', 'OZON_API_KEY'] });
    expect(r.say).toMatch(/Под твоим ответом появится защищённая карточка/);
    expect(r.say).toMatch(/в переписке ключи не проси/);
    expect(r.say).toMatch(/не говори «ключи обновлены»/);
  });

  it('в Telegram — «ниже сообщение с кнопкой»; без метки хода — кабинет', async () => {
    const h = harness();
    const tg: any = await h.svc.execute('u1', { action: 'keys', product: 'бот' }, 'telegram', '11111111-2222-4333-8444-555555555555');
    expect(tg.say).toMatch(/Ниже придёт сообщение с кнопкой/);
    const cab: any = await h.svc.execute('u1', { action: 'keys', product: 'бот' }, 'web', null);
    expect(cab.say).toMatch(/в кабинете/);
  });

  it('отказ сервиса (спит) — пересказ без карточки', async () => {
    const h = harness();
    h.keysSvc.open.mockResolvedValueOnce({ ok: false, reason: 'sleeping', message: 'Продукт спит: …' } as any);
    const r: any = await h.svc.execute('u1', { action: 'keys', product: 'бот' }, 'web', null);
    expect(r).toMatchObject({ ok: false, reason: 'sleeping' });
  });

  it('статус карточки ключей: done — «ключи обновлены», working — «перезапускается»', async () => {
    const h = harness();
    const base = { id: 'a-keys', user_id: 'u1', product_id: 'p1', kind: 'keys', channel: 'web', confirmed_via: 'chat', payload: { keyNames: [] },
      created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'Бот' };
    h.actions.get.mockResolvedValueOnce({ ...base, status: 'done', result: { keyNames: ['BOT_TOKEN'] } } as any);
    expect(((await h.svc.execute('u1', { action: 'status', actionId: 'a-keys' })) as any).say).toMatch(/ключи обновлены/i);
    h.actions.get.mockResolvedValueOnce({ ...base, status: 'working', result: null } as any);
    expect(((await h.svc.execute('u1', { action: 'status', actionId: 'a-keys' })) as any).say).toMatch(/перезапускается/);
  });
});

describe('restore стёртого', () => {
  it('«уже стёрт» вместо «такого нет»', async () => {
    const h = harness({ gone: true });
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый сайт' });
    expect(r).toMatchObject({ ok: false, reason: 'purged' });
    expect(r.say).toMatch(/уже стёрт/);
  });
});
```

`src/products/product-actions.controller.keys.spec.ts`:

```ts
import { ProductActionsController } from './product-actions.controller';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('отправка карточки ключей', () => {
  it('set и remove уходят в сервис ключей; ответ — вид без значений', async () => {
    const row = { id: ID, user_id: 'u1', product_id: 'p1', kind: 'keys', status: 'pending', channel: 'web', confirmed_via: null,
      payload: { keyNames: ['A'] }, result: null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
      resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'Бот' };
    const actions = { get: jest.fn(async () => row) };
    const keys = { complete: jest.fn(async () => ({ ok: true, queued: true })) };
    const limiter = { check: jest.fn(async () => undefined) };
    const ctrl = new ProductActionsController(actions as any, {} as any, limiter as any, keys as any);
    const out = await ctrl.submit({ userId: 'u1' }, ID, { set: { B: 'секрет-значение' }, remove: ['A'], via: 'chat' } as any);
    expect(keys.complete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { B: 'секрет-значение' }, remove: ['A'], via: 'chat' });
    expect(JSON.stringify(out)).not.toContain('секрет-значение');
  });
});
```

В `src/products/product-tool.defs.spec.ts`:
- тест «инструмент ровно один, с восемью действиями» → «…с девятью действиями», ожидаемый список: `['create', 'delete', 'domain', 'edit', 'keys', 'list', 'restore', 'revert', 'status']`;
- в тесте «ключи в текст правки не уезжают…» строку `expect(d).toMatch(/Сменить ключи после создания пока нельзя/);` заменить на:

```ts
    expect(d).not.toMatch(/пока нельзя/);
    expect(d).toMatch(/action="keys"/);
    expect(d).toMatch(/предложи карточку keys/);
```
- в «каждое действие названо в описании» в список добавить `'keys'`.

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add src/products/product-lifecycle-tool.keys.spec.ts src/products/product-actions.controller.keys.spec.ts src/products/product-tool.defs.spec.ts && git -C $B commit -q -m "test(products): действие keys, отправка карточки ключей, возврат стёртого (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-lifecycle-tool.keys.spec.ts src/products/product-actions.controller.keys.spec.ts src/products/product-tool.defs.spec.ts`.

- [ ] **Step 3: Инструмент** — `src/products/product-lifecycle-tool.ts`

1. Импорты: `Optional` из `@nestjs/common` (рядом с `Injectable`), `import { ProductKeysService } from './product-keys.service';`.
2. Конструктор — четвёртый параметр (последним и необязательным: спеки собирают инструмент позиционно с тремя):

```ts
    // Смена ключей (очередь 2). @Optional и последним — по той же причине,
    // что lifecycleTool в ProductToolService.
    @Optional() private readonly keysSvc?: ProductKeysService,
```
3. Метод после `delete`:

```ts
  async keys(userId: string, product: ProductMatch, channel: ProductToolChannel, turn: string | null) {
    if (!this.keysSvc) return { ok: false, reason: 'unavailable', product, say: 'Смена ключей сейчас недоступна.' };
    const r = await this.keysSvc.open({ userId, productId: product.id, channel, turn });
    if (r.ok === false) return { ok: false, reason: r.reason, product, say: r.message };
    return {
      ok: true,
      pending: { actionId: r.actionId, kind: 'keys', expiresAt: r.expiresAt },
      product,
      keyNames: r.keyNames,
      say: (!turn
        ? 'Защищённая карточка ключей ждёт пользователя в кабинете (Студия → Продукты).'
        : channel === 'telegram'
          ? 'Ниже придёт сообщение с кнопкой: пользователь откроет защищённую форму ключей.'
          : 'Под твоим ответом появится защищённая карточка ключей.') +
        ` В ней имена текущих ключей (${r.keyNames.length ? r.keyNames.join(', ') : 'ключей пока нет'}): их можно заменить, убрать или добавить новые. ` +
        'Значения вводит только пользователь — в переписке ключи не проси. Продукт перезапустится с новыми ключами; ' +
        'не говори «ключи обновлены», пока status с этим actionId не вернёт done.',
    };
  }
```
4. После `resolveDeleted`:

```ts
  /** Удалённые, которые уже не вернуть: стёрты или срок возврата вышел. */
  private async resolveGone(userId: string, query: string): Promise<DeletedProduct[]> {
    const raw = String(query ?? '').trim().toLowerCase();
    if (!raw) return [];
    const like = `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
    const r = await this.pg.query(
      `SELECT id, name, slug, kind, purge_after FROM products
        WHERE user_id = $1 AND archived_at IS NOT NULL AND (purged_at IS NOT NULL OR purge_after <= now())
          AND (id::text = $2 OR lower(slug) = $2 OR lower(name) LIKE $3)
        ORDER BY archived_at DESC LIMIT 1`,
      [userId, raw, like],
    );
    return r.rows.map((x: any) => ({ ...x, purge_after: x.purge_after ? new Date(x.purge_after).toISOString() : null }));
  }
```
5. В `restore` первой строкой ветки `if (!matches.length) {`:

```ts
      const gone = await this.resolveGone(userId, String(input?.product ?? ''));
      if (gone.length) {
        return {
          ok: false, reason: 'purged', product: gone[0],
          say: `«${gone[0].name}» уже стёрт: срок возврата (${DELETE_GRACE_DAYS} дней) вышел, вернуть его нельзя. Можно завести новый продукт.`,
        };
      }
```
6. В `actionStatus` после `const botDone = …;`:

```ts
    const keysDone = action.kind === 'keys' && action.status === 'done';
    const keysWorking = action.kind === 'keys' && action.status === 'working';
```
и в цепочку `say` перед финальным `: ACTION_SAY[action.status]`:

```ts
            : keysDone
              ? 'Готово: ключи обновлены, продукт перезапущен с ними.'
              : keysWorking
                ? 'Ключи применяются: продукт перезапускается — посмотри через минуту.'
```
(скобки и отступы — по месту, тернарная цепочка продолжается).

- [ ] **Step 4: Разводка и описание** — `src/products/product-tool.service.ts`

1. В `execute` условие `if (action === 'delete' || action === 'revert') {` → `if (action === 'delete' || action === 'revert' || action === 'keys') {`, и после строки `if (action === 'delete') return this.lifecycleTool.delete(userId, product, channel, turn);`:

```ts
        if (action === 'keys') return this.lifecycleTool.keys(userId, product, channel, turn);
```
Текст `bad_action`: `'Неизвестное действие. Доступны: list, create, edit, status, revert, delete, restore, keys, domain.'`.

2. В `PRODUCT_TOOLS[0].description` после строки про `action="restore"` (`'• action="restore" — вернуть удалённый: product. Нужно свободное место в пределе аккаунта.\n' +`) вставить:

```ts
      '• action="keys" — сменить, убрать или добавить ключи продукта (токен бота, ключи сервисов): product. Сервер прикрепит к ответу защищённую карточку с ИМЕНАМИ текущих ключей; значения вводит только пользователь, продукт перезапустится с новыми ключами. ' +
      'Спящему и остановленному продукту ключи не меняются. Не говори «ключи обновлены», пока status с actionId не вернёт done.\n' +
```
и в `restore` дописать: `После стирания (через 30 дней) вернуть нельзя — ответ reason="purged".`

3. Абзац «КЛЮЧИ, ТОКЕНЫ И ПАРОЛИ…» целиком:

```ts
      'КЛЮЧИ, ТОКЕНЫ И ПАРОЛИ в prompt не вписывай никогда: текст правки хранится в истории и попадает в git продукта. ' +
      'Ключи в разговоре не проси никогда — их вводят только в защищённую карточку (при создании бота и действием keys). ' +
      'Прислал пользователь ключ в чат — никуда его не передавай, не вписывай в prompt и предложи карточку keys.\n' +
```
4. В схеме: `action.enum` — добавить `'keys'`; описание `product` — `'… Для edit, delete, restore, revert, keys обязательно.'`.

- [ ] **Step 5: Ручка отправки** — `src/products/product-actions.controller.ts`

1. Импорты: `IsArray, IsString` из `class-validator`; `Optional` из `@nestjs/common`; `import { ProductKeysService } from './product-keys.service';`.
2. В `SubmitActionDto`:

```ts
  @IsOptional() @IsArray() @IsString({ each: true }) remove?: string[];
```
3. Конструктор — четвёртым параметром `@Optional() private readonly keys?: ProductKeysService,` (спеки собирают контроллер с тремя).
4. Ветку `else if (row.kind === 'keys') { throw new NotImplementedException(…); }` заменить на:

```ts
    } else if (row.kind === 'keys') {
      if (!this.keys) throw new NotImplementedException('Смена ключей сейчас недоступна');
      await this.keys.complete({ userId: user.userId, actionId: id, set: body?.set ?? {}, remove: body?.remove ?? [], via });
```
В докблок класса: «Ключи (`keys`) — `{set, remove}`: значения уходят в ProductKeysService и дальше только в коробку карточки; ответ — `toView`, в котором значений нет по построению».

- [ ] **Step 6: Регистрация** — `src/products/products.module.ts`

Импорты `ProductKeysService`, `ProductPurgeService`; в `providers` после `ProductLifecycleTool,`:

```ts
    // Очередь 2: карточка ключей (её зовут инструмент и ручка отправки) и
    // почасовой обход стирания. Без регистрации здесь @Optional-зависимости
    // инструмента и контроллера молча остались бы пустыми — ассистент
    // отвечал бы «смена ключей недоступна» при полностью выкаченном коде.
    ProductKeysService,
    ProductPurgeService,
```
Сторож регистрации — в `src/products/products.routes.spec.ts` (там уже импортированы `MODULE_METADATA` и `ProductsModule`, см. тест «все три контроллера объявлены в ProductsModule» ~194): импорты `import { ProductKeysService } from './product-keys.service';` и `import { ProductPurgeService } from './product-purge.service';`, и тест рядом:

```ts
  it('смена ключей и обход стирания зарегистрированы в ProductsModule', () => {
    // @Optional-зависимость инструмента и контроллера без регистрации молча
    // пуста: тесты зелёные, а ассистент отвечает «смена ключей недоступна».
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProductsModule) ?? [];
    expect(providers).toEqual(expect.arrayContaining([ProductKeysService, ProductPurgeService]));
  });
```
Этот тест краснеет до правки модуля — прогнать его вместе с остальными на шаге 7.

- [ ] **Step 7: Коммит, прогон — PASS**

```bash
git -C $B add src/products && git -C $B commit -q -m "products: действие keys инструмента и отправка карточки ключей; «продукт уже стёрт»; регистрация" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/product-lifecycle-tool.keys.spec.ts src/products/product-actions.controller.keys.spec.ts src/products/product-tool.defs.spec.ts src/products/product-lifecycle-tool.spec.ts src/products/product-tool.spec.ts src/products/product-actions.controller.spec.ts src/products/products.routes.spec.ts src/mcp`. Expected: PASS. Затем tsc бэка.

---

### Task 16: Тексты ассистентам и справка — ключи меняются, удалённое стирается

**Files:**
- Modify: `src/products/products-cli-tool.ts:67-82` (`PRODUCTS_CLI_PROMPT`)
- Modify: `relay-agent/server.mjs` (`PRODUCTS_PROMPT`, ~356–372) — только репозиторий; выкат релея — другая сессия
- Modify: `src/platform-kb/articles/products.ts` (строки «Как» и «Чего нельзя», комментарий-источник)
- Test: `src/products/products-cli-tool.spec.ts` (~192), `src/chat/relay-products-keys-guard.spec.ts` (новый), `src/platform-kb/products-lifecycle.spec.ts`

- [ ] **Step 1: Тесты**

В `src/products/products-cli-tool.spec.ts` после теста «create, delete, restore, revert и status по actionId» (~192):

```ts
  it('keys — карточкой; ключи в переписке не просить; удалённое стирается', () => {
    expect(PRODUCTS_CLI_PROMPT).toContain('action: "keys"');
    expect(PRODUCTS_CLI_PROMPT).toMatch(/Ключи в переписке не проси никогда/);
    expect(PRODUCTS_CLI_PROMPT).toMatch(/предложи карточку keys/);
    expect(PRODUCTS_CLI_PROMPT).toMatch(/Не говори «ключи обновлены», пока status не вернёт done/);
    expect(PRODUCTS_CLI_PROMPT).toMatch(/стирается насовсем/);
  });
```

`src/chat/relay-products-keys-guard.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Копия текста продуктов в промпте релея (relay-agent/server.mjs) катится
 * отдельно от бэкенда и отстаёт молча: ассистенты релея продолжали бы
 * отвечать «сменить ключи нельзя», когда сервер уже умеет.
 */
const src = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');
const block = src.slice(src.indexOf('const PRODUCTS_PROMPT'), src.indexOf('ФАЙЛЫ ИЗ ПРОШЛЫХ РАЗГОВОРОВ'));

describe('релей: продукты — ключи карточкой', () => {
  it('блок найден', () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it('знает action keys и не просит ключи в переписке', () => {
    expect(block).toContain('action: "keys"');
    expect(block).toMatch(/Ключи в переписке не проси никогда/);
    expect(block).toMatch(/предложи карточку keys/);
    expect(block).toMatch(/стирается насовсем/);
  });
});
```

В `src/platform-kb/products-lifecycle.spec.ts` в конец `describe`:

```ts
  // Очередь 2: ключи меняются карточкой, удалённое через срок стирается.
  // Прежняя строка «Чего нельзя: сменить токен или ключ после создания»
  // врала бы человеку так же, как прежнее «удалить — только через поддержку».
  it('ключи можно сменить, попросив ассистента; «нельзя сменить» больше не говорится', () => {
    expect(web).not.toMatch(/после создания не меняются/);
    expect(web).not.toMatch(/сменить[^.\n]*после создания/);
    expect(web).toMatch(/Сменить, убрать или добавить ключ/);
  });

  it('после срока возврата продукт стирается насовсем', () => {
    expect(web).toMatch(/стирается насовсем/);
  });
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add src/products/products-cli-tool.spec.ts src/chat/relay-products-keys-guard.spec.ts src/platform-kb/products-lifecycle.spec.ts && git -C $B commit -q -m "test: тексты продуктов — keys карточкой, стирание удалённых (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/products-cli-tool.spec.ts src/chat/relay-products-keys-guard.spec.ts src/platform-kb/products-lifecycle.spec.ts`.

- [ ] **Step 3: Реализация**

`src/products/products-cli-tool.ts`, в `PRODUCTS_CLI_PROMPT`:
- строку `- { action: "delete", product } — удалить: … вернуть можно ${DELETE_GRACE_DAYS} дней. { action: "restore", product } — вернуть удалённый. { action: "revert", product, turnId? } — откатить правку.` заменить на ту же строку, где после `вернуть можно ${DELETE_GRACE_DAYS} дней` стоит `, потом он стирается насовсем`;
- после неё добавить строку:

```
- { action: "keys", product } — сменить, убрать или добавить ключи продукта (токен бота, ключи сервисов): сервер пришлёт защищённую карточку с именами текущих ключей, значения вводит только пользователь. Ключи в переписке не проси никогда; прислал ключ в чат — никуда его не передавай и предложи карточку keys. Не говори «ключи обновлены», пока status не вернёт done.
```

`relay-agent/server.mjs`, в `PRODUCTS_PROMPT` — те же две правки, числа буквами, как в соседних строках: в строке `- { action: "delete", product } — удалить: … вернуть можно 30 дней.` после `вернуть можно 30 дней` — `, потом он стирается насовсем`, и после неё — та же строка `- { action: "keys", product } — …` дословно. Релей не выкатывать (см. «Чего план сознательно НЕ делает»).

`src/platform-kb/articles/products.ts`:
- строку «Удалить: …» (`- Удалить: попросить ассистента — …${paid(' Оплаченный период не возвращается.')}`) дополнить перед `${paid(`: ` Потом он стирается насовсем.`;
- строку `- ${q('prodSecrets')} — пары «имя — значение» для сторонних сервисов; хранятся зашифрованными, после создания не меняются. Значения в чат не присылать.` заменить на:

```ts
- ${q('prodSecrets')} — пары «имя — значение» для сторонних сервисов; хранятся зашифрованными. Сменить, убрать или добавить ключ (и ${q('prodToken')}) — попросить ассистента: он пришлёт защищённую карточку, продукт перезапустится с новыми ключами. Значения в чат не присылать.
```
- в «Чего нельзя» строку `- Свой домен у бота; сменить ${q('prodToken')} или ключ после создания.` заменить на `- Свой домен у бота.`;
- комментарий-источник `// источник: ключи — …` дополнить: `; смена — src/products/product-keys.service.ts, product-runner/src/host/rekey.ts; стирание — src/products/product-purge.service.ts`.

Справка ограничена 5 КиБ (`kb.spec.ts`, `MAX_BYTES`): прогон ниже это проверяет. Не влезло — сократить фразу «продукт перезапустится с новыми ключами» до «продукт перезапустится».

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $B add src/products/products-cli-tool.ts relay-agent/server.mjs src/platform-kb/articles/products.ts && git -C $B commit -q -m "тексты: ключи меняются карточкой, удалённое стирается — CLI, релей (репозиторий), справка" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/products/products-cli-tool.spec.ts src/chat/relay-products-keys-guard.spec.ts src/chat/relay-help-guard.spec.ts src/chat/relay-order-guard.spec.ts src/platform-kb`. Expected: PASS.

---

### Task 17: Telegram — карточка ключей кнопкой мини-приложения, 7 языков

**Files:**
- Modify: `src/tg-bot/tg-i18n.ts` (каталоги `ru` ~145–163, `en` ~273–284, `de` ~391–402, `fr` ~526–537, `es` ~644–655, `pt` ~762–773, `zh` ~880–891)
- Modify: `src/tg-bot/tg-product-actions.service.ts:57-77` (ветка `keys`)
- Test: `src/tg-bot/tg-product-actions.service.spec.ts` (~57–63)

- [ ] **Step 1: Тесты**

В `src/tg-bot/tg-product-actions.service.spec.ts` тест «карточка неизвестного вида (keys — очередь 2) — пропускается…» заменить двумя:

```ts
  it('ключи: в личке — кнопка мини-приложения, в группе — ссылка на кабинет; ключи в переписку не просим', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'keys', payload: { name: 'Магазин' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    const [, text, opts] = h.grammy.sendMessage.mock.calls[0] as any[];
    expect(text).toMatch(/Ключи «Магазин»/);
    expect(text).toMatch(/В переписку ключи не присылайте/);
    expect(opts.reply_markup.inline_keyboard[0][0].web_app.url).toMatch(new RegExp(`/tma/\\?pa=${ID}$`));
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: -100, isPrivate: false, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[1] as any[])[2].reply_markup.inline_keyboard[0][0].url)
      .toMatch(new RegExp(`/studio\\?tab=products&action=${ID}$`));
  });

  it('карточка неизвестного вида — пропускается, сообщение не шлётся', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'zzz', payload: { name: 'Магазин' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    expect(h.grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('текст ключей есть на всех семи языках и называет продукт', async () => {
    for (const lang of ['ru', 'en', 'de', 'fr', 'es', 'pt', 'zh']) {
      const h = harness();
      h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'keys', payload: { name: 'Shop' } }] as any);
      await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang });
      const [, text, opts] = h.grammy.sendMessage.mock.calls[0] as any[];
      expect(text).toContain('Shop');
      expect(text).not.toMatch(/\{name\}/);
      expect(opts.reply_markup.inline_keyboard[0][0].text.length).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $B add src/tg-bot/tg-product-actions.service.spec.ts && git -C $B commit -q -m "test(tg-bot): карточка ключей в Telegram (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/tg-bot/tg-product-actions.service.spec.ts`.

- [ ] **Step 3: Тексты** — в `src/tg-bot/tg-i18n.ts` после `pa_open_cabinet_btn` в КАЖДОМ из семи каталогов (тип `Catalog` = ключи `ru`: пропуск в любом языке — ошибка компиляции):

| каталог | `pa_keys_prompt` | `pa_keys_btn` |
|---|---|---|
| `ru` | `'Ключи «{name}»: замените, уберите или добавьте их в защищённой форме — продукт перезапустится с новыми ключами. В переписку ключи не присылайте.'` | `'Открыть ключи'` |
| `en` | `"Keys for “{name}”: replace, remove or add them in the secure form — the product will restart with the new keys. Please don't send keys in the chat."` | `"Open keys"` |
| `de` | `'Schlüssel für „{name}“: Ersetze, entferne oder ergänze sie im geschützten Formular – das Produkt startet dann mit den neuen Schlüsseln neu. Schick Schlüssel bitte nicht in den Chat.'` | `'Schlüssel öffnen'` |
| `fr` | `'Clés de « {name} » : remplacez, supprimez ou ajoutez-les dans le formulaire sécurisé — le produit redémarrera avec les nouvelles clés. Ne les envoyez pas dans la discussion.'` | `'Ouvrir les clés'` |
| `es` | `'Claves de «{name}»: sustitúyelas, quítalas o añade otras en el formulario seguro; el producto se reiniciará con las claves nuevas. No las envíes por el chat.'` | `'Abrir claves'` |
| `pt` | `'Chaves de «{name}»: substitui, remove ou acrescenta chaves no formulário seguro — o produto reinicia com as chaves novas. Não as envies pela conversa.'` | `'Abrir chaves'` |
| `zh` | `'「{name}」的密钥：请在安全表单中替换、删除或添加——产品将使用新密钥重新启动。请不要在聊天中发送密钥。'` | `'打开密钥'` |

Французский каталог обёрнут в `frenchTypography({...})` — неразрывные пробелы у «», `:` и `?` она ставит сама; писать обычные пробелы, как в соседних строках. Немецкий — на «du», португальский — европейский (`tu`), как весь каталог.

- [ ] **Step 4: Ветка `keys`** — в `src/tg-bot/tg-product-actions.service.ts` условие `} else if (a.kind === 'create_bot') {` заменить на `} else if (a.kind === 'create_bot' || a.kind === 'keys') {`, а внутри — текст и подпись кнопки по виду:

```ts
          text = a.kind === 'keys'
            ? tgText(i.lang, 'pa_keys_prompt', { name })
            : tgText(i.lang, 'pa_create_bot_prompt', { name });
```
и в кнопке мини-приложения `text: tgText(i.lang, 'pa_create_bot_btn')` → `text: tgText(i.lang, a.kind === 'keys' ? 'pa_keys_btn' : 'pa_create_bot_btn')`. Комментарий в `else` («keys (очередь 2) и прочие…») заменить на «прочие виды карточек (на будущее) — карточка уже attached_at, молча теряться ей нельзя, но слать по ней нечего». В докблок класса: «Ключи бота и смена ключей — только формой мини-приложения».

- [ ] **Step 5: Коммит, прогон — PASS**

```bash
git -C $B add src/tg-bot && git -C $B commit -q -m "tg-bot: карточка ключей — кнопка мини-приложения в личке, кабинет в группе; 7 языков" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, бэк): `src/tg-bot`. Expected: PASS (включая сторожа каталогов `tg-i18n`). Затем tsc бэка.

---

### Task 18: Фронт — третья копия занятых имён и ручка карточки

**Files (фронт, `$F`):**
- Modify: `src/components/products/secretNames.ts` (`RESERVED`), `src/components/products/secretNames.test.ts` (`RESERVED_TABLE`)
- Modify: `src/services/productActionsApi.ts` (`ProductActionView`, `submit`)
- Test: `src/services/productActionsApi.test.ts`

- [ ] **Step 1: Тесты**

`src/components/products/secretNames.test.ts`: в `RESERVED_TABLE` после `'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',` добавить `'OWNER_TG_ID',` — таблица обязана остаться дословно такой же, как в двух копиях бэка (задачи 2 и 3).

`src/services/productActionsApi.test.ts`, в `describe('ручки карточки', …)`:

```ts
  it('submit ключей — set, remove и источник, ничего сверх', async () => {
    api.post.mockResolvedValue(json(200, { ...VIEW, kind: 'keys', status: 'working', productKind: 'bot' }));
    const r = await productActionsApi.submit('a1', { set: { API_KEY: 'k' }, remove: ['OLD'], via: 'tma' });
    expect(api.post).toHaveBeenCalledWith('/webhook/product-actions/a1', { set: { API_KEY: 'k' }, remove: ['OLD'], via: 'tma' });
    expect(!isProblem(r) && r.productKind).toBe('bot');
  });
```

- [ ] **Step 2: Коммит, прогон — FAIL** (`OWNER_TG_ID` не занят; `remove` нет в типе тела — vitest типы не проверяет, поэтому краснеет только таблица; тип проверит tsc на шаге 4)

```bash
git -C $F add src/components/products/secretNames.test.ts src/services/productActionsApi.test.ts && git -C $F commit -q -m "test(products): OWNER_TG_ID занят; отправка ключей set/remove (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, фронт): `src/components/products/secretNames.test.ts src/services/productActionsApi.test.ts`.

- [ ] **Step 3: Реализация**

`src/components/products/secretNames.ts`, в `RESERVED` после `'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',`:

```ts
  // Telegram владельца бота — кладёт платформа (очередь 2). Ключ с этим именем
  // подменил бы, кому бот отвечает данными владельца.
  'OWNER_TG_ID',
```
и в шапке файла ссылку «Вторая — `isReservedSecretName` на сервере (`spirits_back/src/products/provisioning.service.ts`)» поправить на `spirits_back/src/products/secret-rules.ts`.

`src/services/productActionsApi.ts`:
- в `ProductActionView` после `productName`:

```ts
  /** Форма продукта (с очереди 2). Необязательное: сервер старше фронта поля не шлёт. */
  productKind?: 'site' | 'bot' | null;
```
- в типе `result` добавить `keyNames?: string[];`;
- сигнатура `submit`: `body: { confirm?: true; set?: Record<string, string>; remove?: string[]; via: ActionSource }`.

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $F add src && git -C $F commit -q -m "products: OWNER_TG_ID — третья копия занятых имён; ручка карточки знает remove и вид продукта" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, фронт): `src/components/products src/services/productActionsApi.test.ts`. Expected: PASS. Затем tsc фронта — не выше базовой линии.

---

### Task 19: Фронт — тексты карточки ключей и формы Студии, 7 языков

**Files (фронт):**
- Modify: `src/i18n/locales/{ru,en,de,fr,es,pt,zh}.json` (`products.action.keys.*`, `products.new.extraSecrets.hint`)

Правка — node-скриптом, а не руками и не `translate-locales` (без ключа переписывает локаль, заметка памяти). Файлы локалей канонические (`JSON.stringify(…, null, 2) + '\n'`, проверено на `a369a67`), поэтому перезапись скриптом даёт дифф только по правленым ключам. Французские неразрывные пробелы (у «», `:`, `?`) ставятся символом `String.fromCharCode(0xa0)` — НЕ последовательностью `\u…` (заметка «Write портит \uXXXX»). `keys.unsupported` здесь ещё НЕ удаляется: его читает карточка до задачи 20a, удаляет задача 20b.

- [ ] **Step 1: Скрипт**

```bash
cd /Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2 && node - <<'EOF'
const fs = require('fs');
const NB = String.fromCharCode(0xa0);
const T = {
  ru: {
    keys: {
      title: 'Ключи «{{name}}»',
      hint: 'Значения уходят прямо на сервер — ассистент и история чата их не видят. Пустое поле — ключ остаётся прежним.',
      current: 'Текущие ключи', none: 'Ключей пока нет.', newValue: 'Новое значение {{name}}', keepPlaceholder: 'оставить как есть',
      remove: 'Убрать', undoRemove: 'Вернуть', willRemove: 'будет убран', addTitle: 'Добавить ключи',
      duplicate: 'Такой ключ уже есть — замените его выше',
      nothing: 'Ничего не изменено: впишите новое значение, уберите или добавьте ключ.',
      submit: 'Сохранить ключи', submitting: 'Сохраняю…',
      working: 'Меняю ключи и перезапускаю продукт — это займёт до пары минут.',
      done: 'Ключи «{{name}}» обновлены, продукт перезапущен.',
    },
    hintOld: 'Сменить ключи после создания бота пока нельзя.',
    hintNew: 'Сменить, убрать или добавить ключи потом можно, попросив ассистента.',
  },
  en: {
    keys: {
      title: 'Keys for “{{name}}”',
      hint: 'The values go straight to the server — neither the assistant nor the chat history sees them. Leave a field empty to keep that key.',
      current: 'Current keys', none: 'No keys yet.', newValue: 'New value for {{name}}', keepPlaceholder: 'keep as is',
      remove: 'Remove', undoRemove: 'Keep', willRemove: 'will be removed', addTitle: 'Add keys',
      duplicate: 'This key already exists — replace it above',
      nothing: 'Nothing changed: enter a new value, remove a key or add one.',
      submit: 'Save keys', submitting: 'Saving…',
      working: 'Changing the keys and restarting the product — this takes up to a couple of minutes.',
      done: 'Keys for “{{name}}” updated, the product has restarted.',
    },
    hintOld: 'For now, keys can’t be changed after the bot is created.',
    hintNew: 'You can change, remove or add keys later by asking the assistant.',
  },
  de: {
    keys: {
      title: 'Schlüssel für „{{name}}“',
      hint: 'Die Werte gehen direkt an den Server — weder der Assistent noch der Chatverlauf sieht sie. Leeres Feld — der Schlüssel bleibt, wie er ist.',
      current: 'Aktuelle Schlüssel', none: 'Noch keine Schlüssel.', newValue: 'Neuer Wert für {{name}}', keepPlaceholder: 'unverändert lassen',
      remove: 'Entfernen', undoRemove: 'Behalten', willRemove: 'wird entfernt', addTitle: 'Schlüssel hinzufügen',
      duplicate: 'Diesen Schlüssel gibt es schon — ersetze ihn oben',
      nothing: 'Nichts geändert: Gib einen neuen Wert ein, entferne einen Schlüssel oder füge einen hinzu.',
      submit: 'Schlüssel speichern', submitting: 'Speichere…',
      working: 'Die Schlüssel werden geändert und das Produkt neu gestartet — das dauert bis zu ein paar Minuten.',
      done: 'Die Schlüssel für „{{name}}“ sind aktualisiert, das Produkt wurde neu gestartet.',
    },
    hintOld: 'Nach dem Anlegen des Bots lassen sich die Schlüssel vorerst nicht ändern.',
    hintNew: 'Ändern, entfernen oder ergänzen kannst du die Schlüssel später, indem du den Assistenten fragst.',
  },
  fr: {
    keys: {
      title: `Clés de «${NB}{{name}}${NB}»`,
      hint: 'Les valeurs vont directement au serveur — ni l’assistant ni l’historique de la discussion ne les voient. Champ vide — la clé reste inchangée.',
      current: 'Clés actuelles', none: 'Aucune clé pour l’instant.', newValue: 'Nouvelle valeur de {{name}}', keepPlaceholder: 'laisser tel quel',
      remove: 'Supprimer', undoRemove: 'Garder', willRemove: 'sera supprimée', addTitle: 'Ajouter des clés',
      duplicate: 'Cette clé existe déjà — remplacez-la plus haut',
      nothing: `Rien n’a changé${NB}: saisissez une nouvelle valeur, supprimez ou ajoutez une clé.`,
      submit: 'Enregistrer les clés', submitting: 'Enregistrement…',
      working: 'Changement des clés et redémarrage du produit — cela prend jusqu’à quelques minutes.',
      done: `Les clés de «${NB}{{name}}${NB}» sont à jour, le produit a redémarré.`,
    },
    hintOld: 'Pour l’instant, les clés ne peuvent pas être modifiées après la création du bot.',
    hintNew: 'Vous pourrez ensuite modifier, supprimer ou ajouter des clés en le demandant à l’assistant.',
  },
  es: {
    keys: {
      title: 'Claves de «{{name}}»',
      hint: 'Los valores van directamente al servidor: ni el asistente ni el historial del chat los ven. Si dejas un campo vacío, la clave se queda como está.',
      current: 'Claves actuales', none: 'Todavía no hay claves.', newValue: 'Nuevo valor de {{name}}', keepPlaceholder: 'dejar como está',
      remove: 'Quitar', undoRemove: 'Mantener', willRemove: 'se quitará', addTitle: 'Añadir claves',
      duplicate: 'Esta clave ya existe: sustitúyela arriba',
      nothing: 'No has cambiado nada: escribe un valor nuevo, quita una clave o añade otra.',
      submit: 'Guardar claves', submitting: 'Guardando…',
      working: 'Cambiando las claves y reiniciando el producto: tardará hasta un par de minutos.',
      done: 'Claves de «{{name}}» actualizadas; el producto se ha reiniciado.',
    },
    hintOld: 'Por ahora, las claves no se pueden cambiar después de crear el bot.',
    hintNew: 'Más adelante puedes cambiar, quitar o añadir claves pidiéndoselo al asistente.',
  },
  pt: {
    keys: {
      title: 'Chaves de «{{name}}»',
      hint: 'Os valores vão diretamente para o servidor — nem o assistente nem o histórico da conversa os veem. Campo vazio — a chave fica como está.',
      current: 'Chaves atuais', none: 'Ainda não há chaves.', newValue: 'Novo valor de {{name}}', keepPlaceholder: 'manter como está',
      remove: 'Remover', undoRemove: 'Manter', willRemove: 'vai ser removida', addTitle: 'Acrescentar chaves',
      duplicate: 'Esta chave já existe — substitui-a acima',
      nothing: 'Nada foi alterado: escreve um valor novo, remove ou acrescenta uma chave.',
      submit: 'Guardar chaves', submitting: 'A guardar…',
      working: 'A alterar as chaves e a reiniciar o produto — demora até alguns minutos.',
      done: 'As chaves de «{{name}}» foram atualizadas e o produto reiniciou.',
    },
    hintOld: 'Por agora, as chaves não podem ser alteradas depois de criar o bot.',
    hintNew: 'Mais tarde podes alterar, remover ou acrescentar chaves pedindo ao assistente.',
  },
  zh: {
    keys: {
      title: '「{{name}}」的密钥',
      hint: '这些值直接发送到服务器——助手和聊天记录都看不到。留空则保持该密钥不变。',
      current: '当前密钥', none: '暂无密钥。', newValue: '{{name}} 的新值', keepPlaceholder: '保持不变',
      remove: '删除', undoRemove: '保留', willRemove: '将被删除', addTitle: '添加密钥',
      duplicate: '该密钥已存在——请在上方替换',
      nothing: '没有任何更改：请输入新值、删除或添加密钥。',
      submit: '保存密钥', submitting: '正在保存…',
      working: '正在更换密钥并重启产品——最多需要几分钟。',
      done: '「{{name}}」的密钥已更新，产品已重启。',
    },
    hintOld: '目前，机器人创建后无法更改密钥。',
    hintNew: '之后可以请助手更改、删除或添加密钥。',
  },
};
for (const [lang, t] of Object.entries(T)) {
  const f = `src/i18n/locales/${lang}.json`;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.products.action.keys = { ...d.products.action.keys, ...t.keys };
  const h = d.products.new.extraSecrets.hint;
  if (!h.includes(t.hintOld)) { console.error(`${lang}: в подсказке формы нет ожидаемой фразы — сверить вручную`); process.exit(1); }
  d.products.new.extraSecrets.hint = h.replace(t.hintOld, t.hintNew);
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
}
console.log('ok');
EOF
git -C /Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2 diff --stat
```
Expected: `ok`; в `diff --stat` — ровно 7 файлов локалей, по 15–20 строк в каждом. Иное (сотни строк) — файл был не каноническим: `git checkout -- src/i18n/locales` и написать в отчёт.

- [ ] **Step 2: Проверки локалей**

Run (нода, фронт): `pnpm check-locales && pnpm check-keys && pnpm check-hardcoded` (после `git checkout --detach $SHA`). Expected: зелёные (`check-locale-format` красный на `main` и без нас — заметка «i18n-скрипты фронта»; сравнить его вывод с выводом на `origin/main`, новых строк быть не должно).

- [ ] **Step 3: Коммит**

```bash
git -C $F add src/i18n/locales && git -C $F commit -q -m "i18n(products): тексты карточки ключей; форма Студии — ключи можно сменить через ассистента (7 языков)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C $F push -q origin HEAD:refs/heads/feat/product-lifecycle-2
```

---

### Task 20: Фронт — форма ключей в карточке, Вебвизор, мини-приложение

**Files (фронт):**
- Modify: `src/components/products/ProductActionCard.tsx`
- Modify: `src/components/products/ProductActionCard.test.tsx` (тест «виды действия без формы» ~300–314 и новый `describe`)
- Modify: `src/components/webvisorPrivacy.test.ts` (~262–265)
- Modify: `src/i18n/locales/*.json` (удалить `products.action.keys.unsupported`)
- Create: `src/tma/App.test.tsx`

- [ ] **Step 1: Тесты**

`src/components/products/ProductActionCard.test.tsx`:
1. В тесте «виды действия без формы — свой текст на «готово» и на «ожидание»» удалить третью часть (карточку `c` с `keys.unsupported`, четыре строки).
2. В конец файла:

```tsx
describe('карточка ключей', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  const keysView = (over: Partial<ProductActionView> = {}) =>
    view({ kind: 'keys', productKind: 'site', productName: 'Сайт', keyNames: ['API_KEY', 'OLD_KEY'], ...over });
  const buttonsByText = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].filter((b) => b.textContent === text);

  it('имена ключей видны, значений нет; замена, удаление и новый ключ уходят в set и remove', async () => {
    api.get.mockResolvedValue(keysView());
    api.submit.mockResolvedValue(keysView({ status: 'working' }));
    const { container } = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    expect(visibleText(container)).toContain(tRu('products.action.keys.title', { name: 'Сайт' }));
    expect(visibleText(container)).toContain('API_KEY');
    const replaces = container.querySelectorAll('[data-testid="product-action-key-replace"]');
    expect(replaces).toHaveLength(2);
    expect((replaces[0] as HTMLInputElement).value).toBe('');
    type(replaces[0], 'новое-значение');
    click(buttonsByText(container, tRu('products.action.keys.remove'))[1]);
    expect(visibleText(container)).toContain(tRu('products.action.keys.willRemove'));
    await clickAsync(byButton(container, new RegExp(tRu('products.action.createBot.addKey')))!);
    type(container.querySelector('input[placeholder="API_KEY"]')!, 'NEW_KEY');
    type(container.querySelector('[data-testid="product-action-secret-value"]')!, 'n');
    await clickAsync(byButton(container, new RegExp(tRu('products.action.keys.submit')))!);
    expect(api.submit).toHaveBeenCalledWith('a1', { set: { API_KEY: 'новое-значение', NEW_KEY: 'n' }, remove: ['OLD_KEY'], via: 'chat' });
  });

  it('ничего не изменено — отказ на месте, на сервер не уходит', async () => {
    api.get.mockResolvedValue(keysView());
    const { container } = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    await clickAsync(byButton(container, new RegExp(tRu('products.action.keys.submit')))!);
    expect(api.submit).not.toHaveBeenCalled();
    expect(visibleText(container)).toContain(tRu('products.action.keys.nothing'));
  });

  it('у бота токен убрать нельзя — кнопки «Убрать» у BOT_TOKEN нет', async () => {
    api.get.mockResolvedValue(keysView({ productKind: 'bot', keyNames: ['BOT_TOKEN', 'API_KEY'] }));
    const { container } = mount(<ProductActionCard actionId="a1" via="tma" />);
    await flush();
    expect(buttonsByText(container, tRu('products.action.keys.remove'))).toHaveLength(1);
  });

  it('новый ключ с именем существующего — ошибка строки, на сервер не уходит', async () => {
    api.get.mockResolvedValue(keysView());
    const { container } = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    await clickAsync(byButton(container, new RegExp(tRu('products.action.createBot.addKey')))!);
    type(container.querySelector('input[placeholder="API_KEY"]')!, 'API_KEY');
    type(container.querySelector('[data-testid="product-action-secret-value"]')!, 'x');
    await clickAsync(byButton(container, new RegExp(tRu('products.action.keys.submit')))!);
    expect(api.submit).not.toHaveBeenCalled();
    expect(visibleText(container)).toContain(tRu('products.action.keys.duplicate'));
  });

  it('готово и «в работе» — свои тексты ключей', async () => {
    api.get.mockResolvedValueOnce(keysView({ status: 'done' }));
    const a = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    expect(visibleText(a.container)).toContain(tRu('products.action.keys.done', { name: 'Сайт' }));
    api.get.mockResolvedValueOnce(keysView({ status: 'working' }));
    const b = mount(<ProductActionCard actionId="a2" via="chat" />);
    await flush();
    expect(visibleText(b.container)).toContain(tRu('products.action.keys.working'));
  });

  it('«в работе» у ключей опрашивается дольше минуты: пересоздание контейнера бывает небыстрым', async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue(keysView({ status: 'working' }));
    const { container } = mount(<ProductActionCard actionId="a1" via="chat" />);
    await flush();
    await actAsync(async () => { await vi.advanceTimersByTimeAsync(3000 * 25); });
    expect(api.get.mock.calls.length).toBeGreaterThan(21);
    expect(byButton(container, new RegExp(tRu('products.action.checkAgain')))).toBeNull();
  });
});
```
(Импорт `click` из `../../test/dom` в шапке файла уже есть.)

`src/components/webvisorPrivacy.test.ts`, в тесте «токен бота и значения ключей — ym-disable-keys»:

```ts
    expect(classesOf(ProductActionCardSrc, 'product-action-key-replace', 'input')).toContain('ym-disable-keys');
```

`src/tma/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, flush, visibleText, tRu } from '../test/dom';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
vi.mock('../services/productActionsApi', () => ({
  productActionsApi: {
    get: vi.fn(async () => ({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'keys', status: 'pending', productId: 'p1', productName: 'Бот',
      productKind: 'bot', keyNames: ['BOT_TOKEN'], expiresAt: null, restoreUntil: null, result: null,
    })),
    submit: vi.fn(),
    cancel: vi.fn(),
  },
  isProblem: (x: any) => x?.ok === false,
}));
// Вкладки мини-приложения при ?pa= не рисуются — подменяем, чтобы их модули
// не тянули в тест свои запросы и хранилища.
vi.mock('./screens/DayScreen', () => ({ DayScreen: () => null }));
vi.mock('./screens/AssistantsScreen', () => ({ AssistantsScreen: () => null }));
vi.mock('./screens/SearchScreen', () => ({ SearchScreen: () => null }));
vi.mock('./screens/WalletScreen', () => ({ WalletScreen: () => null }));
vi.mock('./screens/ProfileScreen', () => ({ ProfileScreen: () => null }));
vi.mock('./telegram', () => ({ closeApp: vi.fn() }));

import { App } from './App';

describe('мини-приложение: карточка ключей по кнопке из Telegram', () => {
  it('?pa=<id> открывает карточку ключей вместо вкладок', async () => {
    window.history.replaceState({}, '', '/tma/?pa=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const { container } = mount(<App />);
    await flush();
    expect(visibleText(container)).toContain(tRu('products.action.keys.title', { name: 'Бот' }));
    expect(container.querySelector('[data-testid="product-action-key-replace"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Коммит, прогон — FAIL**

```bash
git -C $F add src/components/products/ProductActionCard.test.tsx src/components/webvisorPrivacy.test.ts src/tma/App.test.tsx && git -C $F commit -q -m "test(products): форма ключей в карточке, Вебвизор, мини-приложение (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, фронт): `src/components/products/ProductActionCard.test.tsx src/components/webvisorPrivacy.test.ts src/tma/App.test.tsx`.

- [ ] **Step 3: Реализация** — `src/components/products/ProductActionCard.tsx`

1. Под `WORKING_POLL_MAX_ATTEMPTS`:

```tsx
/**
 * Смена ключей пересоздаёт контейнер и ждёт его /health — до пары минут, а
 * не секунды, как удаление: минута опроса обрывалась бы на живой смене.
 */
const WORKING_POLL_MAX_ATTEMPTS_KEYS = 60;
```
2. Состояние рядом с `rows`/`rowErrors`:

```tsx
  // Ключи: новые значения существующих (пустое — «оставить как есть») и
  // помеченные к удалению. Значения живут только здесь и в теле отправки.
  const [replace, setReplace] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
```
3. В эффекте смены `actionId` после `setRowErrors([]);` — `setReplace({}); setRemoved([]);`. В `apply` в ветке `if (r.status !== 'pending') {` после `setRows([]);` — `setReplace({}); setRemoved([]);`.
4. В эффекте опроса: перед `const timer = setInterval(` — `const maxAttempts = view?.kind === 'keys' ? WORKING_POLL_MAX_ATTEMPTS_KEYS : WORKING_POLL_MAX_ATTEMPTS;`, сравнение `attempts >= WORKING_POLL_MAX_ATTEMPTS` → `attempts >= maxAttempts`, в зависимости эффекта добавить `view?.kind`.
5. После `submitBot`:

```tsx
  const toggleRemove = (n: string) =>
    setRemoved((rs) => (rs.includes(n) ? rs.filter((x) => x !== n) : [...rs, n]));

  const submitKeys = () => {
    if (!view) return;
    const existing = new Set(view.keyNames);
    // Проверка новых строк — та же, что у формы бота; плюс повтор имени,
    // которое уже есть выше: его меняют полем замены, а не новой строкой.
    const errs = validateExtraSecrets(rows).map((e, i) =>
      !e.name && existing.has(rows[i].name.trim()) ? { ...e, name: 'products.action.keys.duplicate' } : e,
    );
    setRowErrors(errs);
    if (errs.some((e) => e.name || e.value)) return;
    // Object.fromEntries, а не присваивание: см. extraSecretsPayload.
    const set = Object.fromEntries([
      ...view.keyNames
        .filter((n) => !removed.includes(n))
        .map((n) => [n, (replace[n] ?? '').trim()] as const)
        .filter(([, v]) => v !== ''),
      ...Object.entries(extraSecretsPayload(rows)),
    ]);
    const remove = view.keyNames.filter((n) => removed.includes(n));
    if (!Object.keys(set).length && !remove.length) {
      setError(t('products.action.keys.nothing'));
      return;
    }
    void run(() => productActionsApi.submit(actionId, { set, remove, via }));
  };
```
6. Блок новых строк вынести во вспомогательную функцию над `let body` (форма бота и форма ключей рисуют одно и то же):

```tsx
  // Новые строки «имя — значение»: одни и те же у формы бота и у формы ключей.
  const extraRows = (titleId: string, title: string) => (
    <div role="group" aria-labelledby={titleId} className="space-y-2">
      <p id={titleId} className="text-xs font-medium">{title}</p>
      {rows.map((row, i) => (
        <div key={row.id} className="flex gap-2">
          <input type="text" maxLength={SECRET_NAME_MAX} aria-label={t('products.action.createBot.keyName')}
            placeholder="API_KEY" value={row.name} disabled={busy}
            aria-invalid={Boolean(rowErrors[i]?.name)}
            onChange={(e) => updateRow(row.id, { name: e.target.value })}
            className="w-2/5 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
          <input data-testid="product-action-secret-value" type="password" autoComplete="off" spellCheck={false}
            aria-label={t('products.action.createBot.keyValue')} value={row.value} disabled={busy}
            aria-invalid={Boolean(rowErrors[i]?.value)}
            onChange={(e) => updateRow(row.id, { value: e.target.value })}
            className="ym-disable-keys flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
          <button type="button" disabled={busy} onClick={() => removeRow(row.id)} className="text-xs text-gray-500">
            {t('products.action.createBot.removeKey')}
          </button>
          {(rowErrors[i]?.name || rowErrors[i]?.value) && (
            <span role="alert" className="text-xs text-red-700">{t((rowErrors[i].name ?? rowErrors[i].value)!)}</span>
          )}
        </div>
      ))}
      {rows.length < EXTRA_SECRETS_MAX && (
        <button type="button" disabled={busy} onClick={() => setRows([...rows, { id: nextId.current++, name: '', value: '' }])}
          className="text-xs text-forest-700">
          {t('products.action.createBot.addKey')}
        </button>
      )}
    </div>
  );
```
Это дословно прежний блок формы бота (`<div role="group" aria-labelledby="product-action-extra-title" …>…</div>`, ~364–392 на `a369a67`), только с параметрами заголовка; в форме бота сам блок заменить на `{extraRows('product-action-extra-title', t('products.action.createBot.extraTitle'))}`. Сторож Вебвизора по `data-testid="product-action-secret-value"` продолжает находить тот же тег.
7. В ветке `view.status === 'working'` первую строку `<p>{t('products.action.working')}</p>` заменить на `<p>{view.kind === 'keys' ? t('products.action.keys.working') : t('products.action.working')}</p>`.
8. В ветке `view.status === 'done'` перед последней альтернативой (`doneGeneric`) добавить `view.kind === 'keys' ? (<p>{t('products.action.keys.done', { name })}</p>) :`.
9. Ветку `} else if (view.kind === 'keys') { body = <p>{t('products.action.keys.unsupported')}</p>; }` заменить на:

```tsx
  } else if (view.kind === 'keys') {
    // BOT_TOKEN бота убрать нельзя — только заменить (сервер отбьёт тоже).
    const canRemove = (n: string) => !(view.productKind === 'bot' && n === 'BOT_TOKEN');
    body = (
      <>
        <p className="font-medium">{t('products.action.keys.title', { name })}</p>
        <p className="text-xs text-gray-600">{t('products.action.keys.hint')}</p>
        <div role="group" aria-labelledby="product-action-keys-current" className="space-y-2">
          <p id="product-action-keys-current" className="text-xs font-medium">{t('products.action.keys.current')}</p>
          {view.keyNames.length === 0 && <p className="text-xs text-gray-500">{t('products.action.keys.none')}</p>}
          {view.keyNames.map((n) => (
            <div key={n} className="flex gap-2 items-center">
              <span className="w-2/5 font-mono text-xs break-all">{n}</span>
              {removed.includes(n) ? (
                <span className="flex-1 text-xs text-gray-500">{t('products.action.keys.willRemove')}</span>
              ) : (
                <input data-testid="product-action-key-replace" type="password" autoComplete="off" spellCheck={false}
                  aria-label={t('products.action.keys.newValue', { name: n })} placeholder={t('products.action.keys.keepPlaceholder')}
                  value={replace[n] ?? ''} disabled={busy}
                  onChange={(e) => setReplace((r) => ({ ...r, [n]: e.target.value }))}
                  className="ym-disable-keys flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
              )}
              {canRemove(n) && (
                <button type="button" disabled={busy} onClick={() => toggleRemove(n)} className="text-xs text-gray-500">
                  {removed.includes(n) ? t('products.action.keys.undoRemove') : t('products.action.keys.remove')}
                </button>
              )}
            </div>
          ))}
        </div>
        {extraRows('product-action-keys-add', t('products.action.keys.addTitle'))}
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={submitKeys}
            className="px-4 py-1.5 rounded-lg bg-forest-600 text-white text-xs font-medium disabled:opacity-50">
            {busy ? t('products.action.keys.submitting') : t('products.action.keys.submit')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => productActionsApi.cancel(actionId))}
            className="px-4 py-1.5 rounded-lg border border-gray-300 text-xs">
            {t('products.action.cancel')}
          </button>
        </div>
      </>
    );
```
10. Шапку компонента дополнить: «Смена ключей: имена текущих ключей — с сервера, значения не приходят никогда; поле замены пустое, пустое при отправке — ключ остаётся прежним. Поля значений — `ym-disable-keys` (сторож — webvisorPrivacy.test.ts)».

`products.action.keys.unsupported` больше не читается — удалить из всех семи локалей:

```bash
cd /Users/dmitry/Downloads/spirits_front/.worktrees/product-lifecycle-2 && node -e "
const fs=require('fs');
for (const l of ['ru','en','de','fr','es','pt','zh']) {
  const f='src/i18n/locales/'+l+'.json'; const d=JSON.parse(fs.readFileSync(f,'utf8'));
  delete d.products.action.keys.unsupported; fs.writeFileSync(f, JSON.stringify(d,null,2)+'\n');
}
console.log('ok')"
```

- [ ] **Step 4: Коммит, прогон — PASS**

```bash
git -C $F add src && git -C $F commit -q -m "products: форма ключей в карточке — имена, замена, удаление, добавление; мини-приложение" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, фронт): `src/components/products src/components/chat src/tma src/components/webvisorPrivacy.test.ts src/services`, затем `pnpm check-locales && pnpm check-keys && pnpm check-hardcoded` и tsc фронта (не выше базовой линии). Expected: PASS.

---

### Task 21: Полная проверка — оба репозитория, поломки нарочно, ревью

**Files:** без изменений (кроме правок по итогам ревью — отдельными коммитами с тестом).

- [ ] **Step 1: Бэк** (нода, `~/ci/wt/pl2-back` на последнем sha ветки):

```bash
source ~/.nvm/nvm.sh && npx tsc -p tsconfig.build.json --noEmit && echo tsc-ok
PROVISIONING_PG_URL='postgres:///pl2_test?host=/var/run/postgresql' npx jest --runInBand src/products src/mcp src/chat src/tg-bot src/platform-kb 2>&1 | grep -E '^Tests:|^Test Suites:|^FAIL'
PROVISIONING_PG_URL='postgres:///pl2_test?host=/var/run/postgresql' npx jest --runInBand src 2>&1 | grep -E '^Tests:|^Test Suites:|^FAIL'
npm run build >/dev/null && ls dist/main.js && echo build-ok
```
Expected: `tsc-ok`; узкий прогон — без FAIL; полный — FAIL не больше базовой линии задачи 0 (заметка «npm test бэка красный by design»); `build-ok` (заметка «deploy.sh глотает падение сборки» — `ls dist/main.js` обязателен).

- [ ] **Step 2: Агент** (там же, `cd product-runner`):

```bash
source ~/.nvm/nvm.sh && npx tsc -p tsconfig.json --noEmit && npx jest 2>&1 | grep -E '^Tests:|^Test Suites:|^FAIL'; npm run build >/dev/null && ls dist/host/rekey.js dist/host/purge.js dist/host/index.js && test ! -e dist/host/fake-host.js && echo runner-ok
```
Expected: без FAIL; `runner-ok` (симулятор в боевую сборку не попал — tsconfig его исключает).

- [ ] **Step 3: Фронт** (нода, `~/ci/wt/pl2-front`):

```bash
source ~/.nvm/nvm.sh && npx vitest run 2>&1 | tail -5 && pnpm check-locales && pnpm check-keys && pnpm check-hardcoded && npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'; pnpm build >/dev/null && echo build-ok
```
Expected: падений не больше базовой линии; число `error TS` не выше базовой; `build-ok`.

- [ ] **Step 4: Поломки нарочно** — каждая обязана покраснеть хотя бы одним названным тестом. Ломать в CI-клоне ноды, после проверки — `git checkout -- <файл>`:

| # | Поломка | Должен покраснеть |
|---|---|---|
| 1 | `product-runner/src/host/purge.ts`: в `purgeProduct` строку `const dir = productDirFor(…)` заменить на ``const dir = `${deps.productsDir ?? DEFAULTS.productsDir}/${job.slug}`;`` | `purge.spec.ts` — «слаг %j — отказ до ЛЮБОГО вызова», «каталог продуктов %j …» |
| 2 | `purge.ts`: в `productDirFor` удалить проверку `root.split('/')…length < 2` | `purge.spec.ts` — «каталог продуктов "/srv" …» |
| 3 | `product-runner/src/host/rekey.ts`: `const left = await rollback(job.slug, backup, deps);` → `const left: string[] = [];` | `rekey.spec.ts` — «нездоровый бот — откат…», «нездоровый сайт — откат…», «docker run отказал — откат…» |
| 4 | `rekey.ts`: в `capture` убрать ветку `if (!imageRef) { … STABLE_TAG_RE … }` (запуск по идентификатору) | `rekey.spec.ts` — «метку передвинули — тот же образ по его стабильной метке…» |
| 5 | `src/products/secret-rules.ts`: убрать `'OWNER_TG_ID'` | `secret-rules.spec.ts`, `provisioning.create.spec.ts` (общая таблица) |
| 6 | `product-runner/src/host/provision.ts`: убрать `'OWNER_TG_ID'` из `RESERVED_ENV` | `provision.spec.ts` (общая таблица) |
| 7 | фронт `secretNames.ts`: убрать `'OWNER_TG_ID'` | `secretNames.test.ts` |
| 8 | `src/products/product-keys.service.ts`: в `patch` добавить `values: set` | `product-keys.service.spec.ts` (payload только имена), `product-keys.pg.spec.ts` (нет TEST-значений в строке карточки) |
| 9 | `src/products/provisioning.service.ts`: в ветке `WHEN 'rekey'` убрать `AND NOT EXISTS (… product_turns …)` | `provisioning.rekey-purge.spec.ts` — «rekey ждёт конца правки» |
| 10 | `provisioning.service.ts`: в `completePurgeJob` убрать `$2::boolean AND` из `purged` | `provisioning.complete-rekey-purge.spec.ts` — «отказ purge: продукт не помечен…» |
| 11 | `src/products/product-actions.service.ts`: в `sweepStuck` убрать `AND NOT EXISTS (… 'queued','running','done' …)` | `product-actions.sweep.pg.spec.ts` — «карточка с живым заданием rekey не подметается…» |
| 12 | `src/products/turns.service.ts`: убрать проверку `REKEY_REFUSAL` | `turns.enqueue.spec.ts` — «пока rekey в очереди или идёт…» |
| 13 | `src/products/product-purge.service.ts`: в `backupPathFor` убрать сравнение `path.resolve(m[1]) === want` (вернуть `want`) | `product-purge.service.spec.ts`, `product-purge.pg.spec.ts` — чужая копия не тронута |
| 14 | фронт `ProductActionCard.tsx`: у `product-action-key-replace` убрать `ym-disable-keys` | `webvisorPrivacy.test.ts` |

Итог — таблицей в отчёт: поломка → какой тест покраснел. Не покраснело ничего — дописать тест, который ловит, и прогнать заново.

- [ ] **Step 5: Ревью** — субагент `superpowers:code-reviewer` по диффам `origin/main..origin/feat/product-lifecycle-2` обоих репозиториев против спеки и этого плана, с вопросами: значения ключей нигде, кроме коробки и `secrets_encrypted`; откат `rekey` возвращает ровно старый контейнер; `purge` не может тронуть путь вне `/srv/products/<слаг>`; строка `products` при стирании не удаляется; одно действие — один оператор там, где это обещано. Найденное — правками с тестом и прогоном шагов 1–3.

---

### Task 22: Спека — отступления очереди 2

**Files:** Modify: `docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md`

- [ ] **Step 1:** В конец спеки — раздел `## Отступления очереди 2 (по ходу исполнения, <дата>)`: пункты 1–15 из «Общее → Отступления от спеки» этого плана (кратко, по одному абзацу), плюс фактические расхождения, найденные исполнителями и ревью. В разделе «Открыто на очередь 2» отметить закрытое: «стирание только помечает `purged_at`» — сделано (задача 10); «удалённый продукт, у которого сон трижды не прошёл, может работать до стирания» — стирание снимает и работающий контейнер (задача 6), то есть «работает» теперь ограничено сроком возврата. Остальные пункты того раздела — перенести в новый подраздел «Открыто после очереди 2» как есть (тексты о деньгах в сборке из магазина, Flutter и блок карточки в истории, `end.content` на фронте, тексты `result.error` по-русски, Telegram-группа → кабинет, вторая карточка от самолечения).

- [ ] **Step 2: Коммит**

```bash
git -C $B add docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md && git -C $B commit -q -m "docs(spec): отступления очереди 2" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C $B push -q origin HEAD:refs/heads/feat/product-lifecycle-2
```

---

### Task 23: Слияние и выкат — ТОЛЬКО С OK ВЛАДЕЛЬЦА

Каждый шаг ниже начинается с явного OK владельца в этой сессии. Без него — остановиться и доложить готовность.

- [ ] **Step 1: Слияние** (OK владельца) — `feat/product-lifecycle-2` в `main` обоих репозиториев, как в очереди 1: `checkout --detach origin/main`, `merge --no-ff`, пуш `${SHA}:refs/heads/main` (в zsh — с фигурными скобками, заметка «zsh: «$VAR:r» в refspec»), сверка merge-base (заметка «push origin main ≠ HEAD»). В `origin/main` за это время приехали чужие коммиты — прогнать на мерже шаги 1–3 задачи 21.

- [ ] **Step 2: Выкат** (отдельный OK владельца) — ОДИН раз, в тихое время, `deploy.sh` с ноды со свежих клонов, отвязанно, наблюдатель по логу (заметка «Выкат: правила»; флаги — как в очереди 1, `SKIP_BOTS=1`, пока у PHASE 5 нет ключа). Что знать заранее:
  - **Образ продуктов пересобирается и пересоздаёт ВСЕ работающие контейнеры продуктов.** Метка образа — хеш содержимого `product-runner/` (`product-image-roll.sh`), а очередь 2 его меняет (rekey, purge, каркас). Пересоздание — секунды на продукт, живые правки скрипт пропускает сам (стоп-сигнал «активный ход»). Поэтому тихое время и ОДИН выкат, а не по частям.
  - **Спящие (остановленные) контейнеры пропускаются — это ожидаемо**: скрипт называет их в итоге и возвращает код 3. PHASE 4 считается зелёной, если в «не сделано» — только остановленные контейнеры (известные спящие и удалённые продукты); любая другая строка — разбор до следующего шага.
  - **Окно «сервер новее агента».** Бэк катится в PHASE 2, агент — в PHASE 4. Карточку ключей, отправленную в этом окне, старый агент честно отвергнет («неизвестный вид задания») — карточка станет `failed` с текстом «Ключи не применены…», ключи не тронуты. Первый обход стирания — через час после старта API (отступление 2), и удалённых со сроком в прошлом сейчас нет (первые удаления — 25–26.10, срок — с 25.11), так что `purge` в это окно не уходит.
  - **Релей не трогать.** Его копия `PRODUCTS_PROMPT` обновлена только в репозитории; описание действия `keys` ассистенты релея всё равно получают из схемы инструмента (`/webhook/mcp/products`). Выкат релея — другая сессия, по раннбуку релея.
  - После выката — заметка «Проверка выката»: хеш своего бандла фронта, PHASE 4 по всем машинам реестра, `journalctl -u linkeon-host-agent` на машине продуктов чист.

- [ ] **Step 3: Живая проверка на проде тестовым аккаунтом** (OK владельца; `70000000000`, вход через debug-OTP с секретом прода на localhost прода; на test нет машины продуктов, а релейные инструменты там не работают — заметка «test без BACKEND_URL»). Значения ключей — заведомо фиктивные (`LIVE_CHECK=1`), в отчёт — только имена:
  1. тестовым аккаунтом завести сайт «Проверка ключей» (Маше или кнопкой Студии), дождаться `running`;
  2. «смени ключи у Проверки ключей» → карточка; отправить из кабинета `POST /webhook/product-actions/<id> {set:{LIVE_CHECK:"1"}, remove:[], via:"cabinet"}` → через 1–2 минуты действие `done`, в `product_provision_jobs` задание `rekey` `done`; на машине продуктов (только чтение) `docker inspect --format '{{json .Config.Env}}' <слаг> | grep -c LIVE_CHECK` = 1, сайт отвечает;
  3. правка во время смены ключей: сразу после отправки второй карточки поставить правку — 409 «Сейчас меняются ключи продукта…»;
  4. убрать `LIVE_CHECK` карточкой → `done`, переменной в контейнере нет;
  5. если владелец даст токен тестового бота — то же для бота: смена `BOT_TOKEN` на токен другого тестового бота (getMe, `tg_bot_id` обновился), бот отвечает на `/start`; без привязки Telegram — с chat_id в ответе (только у ботов, заведённых после выката);
  6. удалить «Проверку ключей» карточкой; с OK владельца — `UPDATE products SET purge_after = now() WHERE slug = '<слаг>'` и `INSERT INTO product_provision_jobs (product_id, kind, status) SELECT id, 'purge', 'queued' FROM products WHERE slug = '<слаг>'`; через минуту: `purged_at` проставлен, `secrets_encrypted` NULL, строка продукта и его задания на месте, в `product_actions` строка `purge`/`done`/`system`; на машине нет ни контейнера, ни `/srv/products/<слаг>`, ни конфига nginx;
  7. «верни Проверку ключей» → «уже стёрт».

- [ ] **Step 4: Заметки памяти** — обновить `project_product_lifecycle_stage1.md` (или завести `…_stage2.md`): что выкачено (sha обоих репозиториев), что смена ключей и стирание живы, что релей ещё на старом тексте продуктов, что первые сроки стирания — с 25.11.
