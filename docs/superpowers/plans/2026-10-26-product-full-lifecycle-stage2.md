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
Run (нода, агент): без списка файлов (`npx jest`). Expected: все наборы PASS, число тестов = базовая линия + 6 (задача 3 добавила свои). Затем tsc агента.

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

- [ ] **Step 1: Тесты**

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
git -C $B add product-runner/src/host/index.spec.ts && git -C $B commit -q -m "test(runner): виды rekey и purge в цикле агента (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Run (нода, агент): `src/host/index.spec.ts`.

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
