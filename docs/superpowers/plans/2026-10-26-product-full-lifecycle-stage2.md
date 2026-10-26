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
