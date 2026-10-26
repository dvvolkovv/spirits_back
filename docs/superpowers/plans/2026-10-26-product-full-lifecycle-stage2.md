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
- На прод (`212.113.106.202`) и машины продуктов в ходе задач 0–21 не ходить. Выкат — только задача 22 и только с OK владельца.

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
- Полный `npx jest --runInBand src` бэка красный «by design» (заметка «npm test бэка красный by design») — записать число FAIL и в задаче 20 сравнивать дельтой.

### Отступления от спеки (вносятся в спеку задачей 21)

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
11. **Резервная копия стирается, только если `repo_url` продукта указывает ровно на `<PRODUCT_REPOS_DIR или ~/product-repos>/<слаг>.git`** этой машины (так её пишет `scripts/product-backup-setup.sh`), после чего `repo_url = NULL`. Иначе — предупреждение в лог (раз на процесс), ничего не трогается.
12. **Стирание после трёх провалов подряд не ставится** (тот же потолок, что у сна удалённого) — строка `error` в лог раз на процесс.
13. **Итог смены ключей для человека — свой текст**, а не сырая причина агента: она остаётся в `product_provision_jobs.error`. Карточка ключей опрашивает «в работе» до трёх минут (60 попыток), остальные — минуту, как было.
14. **В вид действия (`ActionView`) добавлен `productKind`**: карточка ключей не предлагает «Убрать» у `BOT_TOKEN` бота (сервер это всё равно отбивает).
15. **Ручки — `/webhook/product-actions…`** (как в очереди 1); тело ключей — `{set, remove, via}`.

### Чего план сознательно НЕ делает

- Не правит `product-vhost` и `product-image-roll.sh`.
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
| `src/products/product-purge.service.ts` (новый) | почасовой обход стирания, стирание резервных копий | 14 |
| `src/products/product-lifecycle.service.ts` | сон удалённых не снимает `purge`; возврат стёртого — свой отказ | 14 |
| `src/products/product-lifecycle-tool.ts`, `src/products/product-tool.service.ts` | действие `keys`, тексты, «продукт уже стёрт» | 15 |
| `src/products/product-actions.controller.ts`, `src/products/products.module.ts` | отправка карточки ключей, регистрация | 15 |
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
| `src/components/products/ProductActionCard.tsx`, `ProductActionCard.test.tsx` | форма ключей | 18 |
| `src/components/webvisorPrivacy.test.ts` | сторож Вебвизора для новых полей | 18 |
| `src/i18n/locales/*.json` | `products.action.keys.*`, подсказка формы Студии, 7 языков | 19 |
| `src/tma/App.test.tsx` (новый) | мини-приложение открывает карточку ключей | 19 |

---
