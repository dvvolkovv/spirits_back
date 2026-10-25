# Короткие ролики, план 2: конвейер на стенде — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ролик проходит весь путь без ручной сборки: тема → сцена (режиссёр) → съёмка студией → сценарий с проверкой правил → озвучка и сборка → видео владельцу в Telegram с кнопками → одобрение в слот → Telegram-канал и набор для YouTube. Итог проверяется сквозным прогоном на стенде test.linkeon.io.

**Architecture:** Модуль `src/shorts/` в API ведёт ролик по машине состояний в таблице `short_video`. Режиссёр и сценарист ходят в релей, кнопки и замечания идут через того же бота, что у блога, публикация ведётся по площадкам в `short_publication`. Студия получает `src/worker/`: процесс забирает задания `capture` и `render` из той же таблицы (`FOR UPDATE SKIP LOCKED` и аренда), файлы кладёт в MinIO. API и студию связывают только строки Postgres и ключи MinIO.

**Tech Stack:** NestJS 10 (commonjs, `strictNullChecks: false`), PostgreSQL 16, `@nestjs/schedule`, grammy 1.43, MinIO через `@aws-sdk/client-s3`, релей `r.linkeon.io` (`BlogRelayClient`). Студия — Node 22 ESM, `tsx --test`, `pg`, Playwright 1.59.1, Remotion 4.0.530.

**Спека:** `docs/superpowers/specs/2026-10-24-promo-shorts-design.md`: разделы «Ролик», «Архитектура», «Данные», «Расписание и одобрение», «Публикация» (Telegram и YouTube), «Метки и измерение» (ссылки роликов), «Обработка отказов», «Среды и выкат» (стенд). Образец и ядро студии — план 1 (`2026-10-24-promo-shorts-1-sample.md`).

**Вне этого плана:**
- **План 3 «Админка, метки блога и выкат на прод».** Вкладка «Ролики» (`AdminShortsView.tsx`). Метки в постах блога. Сцены `page` (калькулятор Human Design, тест ценностей) и темы-возможности в каталоге. Новости недели и заголовки блога для режиссёра (экспорт из `BlogModule`). Список `ALLOWED` в `pendingDestination`. Блок студии в `deploy.sh` и PM2 `linkeon-studio` (`nice 19`, `kill_timeout`). Вход демо-аккаунта на проде, `SHORTS_DEMO_PHONE` и баланс демо-аккаунта в админке. Проверка, что мониторинги молчат на демо-аккаунте. Включение на проде.
- **План 4.** VK: подключение, `short_vk_account`, публикатор, Клипы. Воскресная сводка: просмотры VK и YouTube, регистрации по меткам.

**Что план уточняет в спеке** (дописывается в спеку в задаче 38):
- В `short_video` сверх спеки: `title`, `angle_locked`, `approved_at`, `writer_feedback`, `writer_rounds`, `note_prompt_ids`, `yt_prompt_ids`, `failed_from`, `failure_notified`. В `short_publication` — `created_at`, `updated_at`. Таблица `short_vk_account` появится в плане 4.
- `SHORTS_AUTO_TOPICS` выключает и воскресное наполнение, и автозапуск роликов к слотам. На стенде ролик стартует только вызовом `start_now`.
- Новые переменные: `SHORTS_STAND=true` (пометка «СТЕНД» в сообщениях владельцу) и `SHORTS_LINK_BASE` (адрес кабинета в ссылках роликов, по умолчанию `https://my.linkeon.io`).
- Команда `/short` заводит ролик рубрики `case`. Без `SHORTS_ENABLED=true` бот её не знает.
- Строка «Ответ ИИ, не заменяет …» ставится по ассистенту: юрист, бухгалтер, финансы, здоровье (`short-assistants.ts`).
- Если озвучка вышла за 30–60 с или реплика ответа короче 1,5 с, студия возвращает сценарий сценаристу с пояснением. Не больше двух раз подряд (`writer_feedback`, `writer_rounds`).
- Кнопки под роликом принимаются только от апрувера (`BLOG_APPROVER_TG_ID`).
- Повтор упавшего ролика продолжает с этапа, на котором он упал (`failed_from`). Повтор публикации возможен только у ролика, который владелец одобрял (`approved_at`).

---

## Как работать

- **Воркдерево на маке:** `/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts`, ветка `feat/promo-shorts` (план 1 закончился на `9d7c7a3`). Ниже `WT` — этот путь. Git — через `git -C "$WT"`, без `cd` в цепочках.
- **Всё тяжёлое — на тестовой ноде** через `studio/scripts/node-run.sh "<команда>"`. Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит. **Незакоммиченное на ноду не уезжает:** красный тест сначала коммитится (`test(...): … (красный)`), потом гоняется.
  - Студия (команда выполняется в `studio/`): `studio/scripts/node-run.sh "npx tsx --test src/frame.test.ts"`.
  - Бэкенд (команда выполняется в корне): `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-numbers.spec.ts"`. Путь на ноде не содержит `.worktrees`, поэтому jest находит тесты без флагов.
  - Гейт типов бэкенда: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`. jest типы не проверяет (`isolatedModules`), поэтому каждая задача бэкенда кончается этим гейтом.
- **`strictNullChecks: false` в бэкенде.** Дискриминированный союз сужается только сравнением `r.ok === false`, не `!r.ok`.
- **Живой чекаут `~/spirits_back` на ноде не трогать:** из него работает test.linkeon.io. Из его `.env` можно только читать.
- **Ничего не выкатывать и не вливать в main** до задачи 36. Там и слияние, и выкат — только с явного OK владельца.
- **Ревьюерам-субагентам:** никаких `git checkout` и `git switch` в общем воркдереве. «Красное» состояние смотреть через `git show <sha>:<путь>`.
- **SSH к ноде — через одно мастер-соединение.** sshd ноды рвёт новые подключения по `MaxStartups 10:30:100` (`Connection closed by 85.192.61.231 port 22`): её постоянно перебирают боты. Поэтому все `ssh` и `scp` в плане идут с `-o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m`: первое подключение становится мастером, остальные идут через него. Если сбрасывает и первое, повторить через 1–2 минуты, а не петлёй каждые несколько секунд — петля только добавляет подключений к потолку. После задачи 0 `node-run.sh` сам ждёт соседний прогон на flock (до 5 минут, потом выходит с кодом 75 и показывает, чей прогон держит лок — тогда повторить позже). Команда на ноде ограничена 30 минутами. Bash-вызов агента по умолчанию живёт 2 минуты (10 минут — потолок и только с явным `timeout`), а одно ожидание лока — до 5 минут. Поэтому любой вызов `node-run.sh` — с `timeout: 600000`, долгие прогоны (`npm ci` с jest, сквозной рендер, рабочий процесс студии) — с `run_in_background`. Код 3 — воркдерево ноды не встало на коммит и команда не запускалась: это не «ожидаемый красный» шага TDD. В файле владельца лока записан `pid` — зависший прогон снимается `kill <pid>` на ноде.
- **Коммиты** — по-русски, с префиксом (`feat(shorts):`, `test(shorts):`, `feat(studio):`, `fix(...)`). Последняя строка каждого сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Кириллица и эмодзи пишутся в файлы как есть.** Escape-последовательностей вида `\uXXXX` в коде нет и не вводить: инструмент записи их портит.

## Контракт API и студии

Строка `short_video` — единственная связь. Кто что пишет:

| Переход | Кто | Что пишет |
|---|---|---|
| `idea` → `directing` | API: `ShortsTopicService.start` (крон или `start_now`) | `slot_at` — планируемый слот, `angle` |
| `directing` → `capture_queued` | API: режиссёр | `scene` (форма `Scene` студии), `assistant_id`, `slug`, `title` |
| `capture_queued` → `capturing` → `writing` | студия: задание `capture` | `capture`: `CaptureResult` без путей файлов, плюс `questionShotKey`, `answerShotKey` |
| `writing` → `render_queued` | API: сценарист | `script` (форма `Script` студии), `captions` |
| `render_queued` → `rendering` → `pending_review` | студия: задание `render` | `video_key`, `cover_key`, `duration_ms`, `review_message_id = NULL` |
| `rendering` → `writing` | студия: озвучка вне 30–60 с или реплика короче 1,5 с | `writer_feedback` |
| `pending_review` → … | API: кнопки и замечание | см. машину состояний (задача 1) |

Ключи MinIO (бакет `MINIO_BUCKET_VIDEOS`, по умолчанию `linkeon-smm-videos`):
- `shorts/<id>/capture-<попытка>/question.png` и `answer.png`;
- `shorts/<id>/video.mp4` и `shorts/<id>/cover.jpg`.

Аренда: этап забирается запросом `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` с `lease_until`. Процесс, упавший посреди работы, отдаёт задание, когда аренда истечёт. Попытки считает захват (`attempts + 1`), сбрасывает их переход на следующий этап.

## Файлы

| Файл | За что отвечает |
|---|---|
| `tsconfig.json`, `tsconfig.build.json`, `package.json` (jest) | Студия вне сборки и тестов API |
| `studio/scripts/node-run.sh` | Прогон на ноде: `NODE_RUN_DIR`, flock |
| `src/shorts/shorts.types.ts` | Типы, машина состояний, контракт со студией, `rowToShort` |
| `src/shorts/migrations/001_shorts.sql` | Таблицы `short_video`, `short_publication`, `short_settings` |
| `src/shorts/shorts-schema.service.ts` | Накат миграции при старте |
| `src/shorts/short-numbers.ts` | Числа словами для озвучки, финальная реплика |
| `src/shorts/short-slug.ts` | Слаг для меток |
| `src/shorts/short-links.ts` | Ссылки роликов с UTM |
| `src/shorts/short-assistants.ts` | Голос ассистента, строка «не заменяет специалиста», темы здоровья |
| `src/shorts/short-rhythm.ts` | Ритм подач, выбор следующей идеи, выбор ассистентов недели |
| `src/shorts/short-rules.ts` | Проверка сценария: структура и правила текста 1–15 |
| `src/shorts/short-parse.ts` | Разбор ответов режиссёра и сценариста |
| `src/shorts/short-callback.ts` | Кнопки, `/short`, ссылка YouTube |
| `src/shorts/short-captions.ts` | Подписи площадок с пределами длины, подпись для владельца |
| `src/shorts/short-script.ts` | Ответ сценариста → сценарий студии |
| `src/shorts/short-slot-claim.ts` | Одобрение в слот |
| `src/shorts/short-jobs.ts` | Захват этапа API и повтор с паузой |
| `src/shorts/short-prompts.ts` | Промпты режиссёра и сценариста |
| `src/shorts/shorts-settings.service.ts` | Настройки и их проверка |
| `src/shorts/shorts-topic.service.ts` | Заказ, наполнение недели, запуск ролика к слоту |
| `src/shorts/shorts-director.service.ts` | Тема → сцена |
| `src/shorts/shorts-writer.service.ts` | Съёмка → сценарий и подписи |
| `src/shorts/shorts-approval.service.ts` | Видео владельцу, кнопки, замечание, `/short`, ссылка YouTube, сообщения о сбоях |
| `src/shorts/shorts-publisher.service.ts` | Telegram-канал и набор для YouTube |
| `src/shorts/shorts.cron.ts` | Тики конвейера |
| `src/shorts/shorts.controller.ts` | `POST admin/shorts` |
| `src/shorts/shorts.module.ts` | Сборка модуля |
| `src/shorts/shorts.integration.spec.ts` | Проверки на живом Postgres |
| `src/tg-bot/tg-bot.service.ts`, `tg-bot.module.ts`, `src/app.module.ts` | Подключение |
| `studio/src/errors.ts` | Ошибки студии с кодом и признаком повтора |
| `studio/src/frame.ts` | Размер кадра — один на съёмку и композицию |
| `studio/src/answer-motion.ts` | Движение сцены «Ответ» чистой функцией |
| `studio/src/worker/db.ts` | Очередь заданий в Postgres |
| `studio/src/worker/storage.ts` | MinIO |
| `studio/src/worker/jobs.ts` | Задания `capture` и `render` |
| `studio/src/worker/worker.ts` | Рабочий процесс |
| `studio/scripts/stand-admin.ts` | Админский API стенда с ноды |

---

### Task 0: Студия вне сборки API, прогоны бэкенда на ноде

Сейчас `tsconfig.build.json` не исключает `studio/`. `nest build` втянул бы в сборку ESM-код студии, а общий корень файлов сдвинул бы `dist/main.js` в `dist/src/main.js`. До слияния в main это надо закрыть.

**Files:**
- Modify: `tsconfig.json`, `tsconfig.build.json`, `package.json` (блок `jest`)
- Modify: `studio/scripts/node-run.sh`

- [ ] **Step 1: Убедиться, что сборка API сейчас видит студию**

Это нарочно ломаемая проверка: без неё шаг 5 нечем отличить от пустого прогона. `node-run.sh` пока умеет только `studio/`, поэтому — через `cd ..`:

Run: `studio/scripts/node-run.sh "cd .. && npm ci --no-audit --no-fund >/dev/null 2>&1; npx tsc --listFilesOnly -p tsconfig.build.json | grep -c '/studio/' || true"`
Expected: число больше нуля (файлы `studio/src/**` в списке сборки).

- [ ] **Step 2: `node-run.sh` — каталог прогона и flock**

Заменить `studio/scripts/node-run.sh` целиком:

```bash
#!/usr/bin/env bash
# Прогон команды на тестовой ноде (CLAUDE.md: сборки и тесты — не на маке).
# Пушит текущую ветку и ставит воркдерево ноды ~/ci/wt/promo-shorts на ТОЧНЫЙ коммит:
# по имени ветки нельзя — в общие чекауты коммитят параллельные сессии.
#   studio/scripts/node-run.sh "npm test"                           — в studio/
#   NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts" — в корне бэкенда
# Два прогона сразу (параллельные сессии, субагенты) воркдерево не делят: второй ждёт
# первого на flock до 5 минут, а не переключает коммит у него из-под ног. Команда
# ограничена 30 минутами: зависший прогон не держит лок вечно.
# Коды выхода: 75 — воркдерево занято (повторить позже), 2 — неверный вызов,
# 3 — воркдерево ноды не встало на коммит (команда не запускалась), 124 или 137 —
# команда не уложилась в 30 минут, 255 — ssh (сброс по MaxStartups: повторить через
# 1–2 минуты), иначе — код самой команды.
set -euo pipefail
[ $# -eq 1 ] || { echo 'usage: studio/scripts/node-run.sh "<команда>" — команда одной строкой в кавычках' >&2; exit 2; }
cmd="$1"
dir="${NODE_RUN_DIR:-studio}"
case "$dir" in
  studio|.) ;;
  *) echo "node-run.sh: NODE_RUN_DIR — studio или . (корень бэкенда), получено «${dir}»" >&2; exit 2 ;;
esac
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse HEAD)"
branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
# Из отсоединённого HEAD branch == "HEAD": пуш создал бы ветку refs/heads/HEAD,
# а она при fetch затирает refs/remotes/origin/main у всех клонов (было 24.10.2026).
# Из main не гоняем: скрипт только для ветки задачи.
case "$branch" in
  HEAD) echo "node-run.sh: HEAD отсоединён — встань на ветку задачи (git switch feat/promo-shorts)" >&2; exit 2 ;;
  main|master) echo "node-run.sh: из ${branch} не запускать — только из ветки задачи" >&2; exit 2 ;;
esac
# Незакоммиченное на ноду не уезжает: прогон проверит прежний код. Новые файлы тоже
# считаются — забытый git add молча оставил бы новую сюиту вне прогона.
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "node-run.sh: есть незакоммиченные правки или новые файлы — на ноду уедет только ${sha:0:7}" >&2
fi
echo "node-run.sh: ${sha:0:7} → ${dir}" >&2
git -C "$repo" push -q origin "HEAD:refs/heads/${branch}"
# Команда уезжает одним словом: на ноде её разбирает bash -ec, а не цепочка подготовки.
q="$(printf '%q' "$cmd")"
# Одно мастер-соединение на все прогоны (ControlPersist): sshd ноды рвёт новые
# подключения по MaxStartups 10:30:100 — её постоянно перебирают боты. Keepalive —
# чтобы прогон не висел на мёртвом соединении мастера (сон мака, смена сети).
# На одно соединение sshd пускает до 10 сессий (MaxSessions) — с запасом.
# Подготовка воркдерева — одной группой: любой её сбой фатален. Под set -e упавшее
# звено списка && шелл не останавливает, и команда выполнилась бы на чужом коммите.
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
    -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "set -e
exec 9>~/ci/wt/.promo-shorts.lock
if ! flock -w 300 9; then echo 'node-run.sh: воркдерево занято другим прогоном дольше 5 минут, его владелец:' >&2; cat ~/ci/wt/.promo-shorts.owner >&2 2>/dev/null || true; exit 75; fi
echo \"\$(date -Is) ${sha:0:7} ${dir} pid \$\$\" > ~/ci/wt/.promo-shorts.owner
{ cd ~/ci/wt/promo-shorts && timeout 120 git fetch -q origin 'refs/heads/${branch}' && test -z \"\$(git status --porcelain --untracked-files=no)\" && git checkout -q --detach ${sha} && cd ${dir} && source ~/.nvm/nvm.sh >/dev/null; } || { echo 'node-run.sh: воркдерево ноды не встало на ${sha:0:7} (fetch, незакоммиченное в дереве ноды или checkout)' >&2; git -C ~/ci/wt/promo-shorts status --short >&2 || true; exit 3; }
exec timeout -k 30 1800 bash -ec ${q}"
```

- [ ] **Step 3: Исключить студию из сборки и тестов API**

В `tsconfig.json` после `compilerOptions` добавить исключения. Без явного `exclude` tsc берёт все `.ts` дерева, включая `studio/`. Значения по умолчанию (`node_modules`, `outDir`) надо перечислить явно, раз список задаётся:

```json
  "exclude": ["node_modules", "dist", "studio"]
```

В `tsconfig.build.json` в массив `exclude` после `"product-runner"` добавить:

```json
    "studio",
```

В `package.json`, в `jest.testPathIgnorePatterns` после `"<rootDir>/voice-host/"` добавить:

```json
      "<rootDir>/studio/",
```

- [ ] **Step 4: Коммит**

```bash
git -C "$WT" add tsconfig.json tsconfig.build.json package.json studio/scripts/node-run.sh
git -C "$WT" commit -m "build: студия вне сборки и тестов API; node-run — корень бэкенда и flock

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Сборка больше не видит студию, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx tsc --listFilesOnly -p tsconfig.build.json | grep -c '/studio/' || true; npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: `0`, затем `TSC_OK`.

- [ ] **Step 6: jest в корне работает, студия зелёная**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/blog/blog-slots.spec.ts"`
Expected: `PASS src/blog/blog-slots.spec.ts`.

Run: `studio/scripts/node-run.sh "npm test"`
Expected: `# pass 49`, `# fail 0`.

- [ ] **Step 7: База уже красных сюит бота и блога**

На `c787327` сюиты `src/tg-bot` и `src/blog` зелёные (25.10.2026: 57 passed, 3 skipped — интеграционные без своих баз). ESM-пакет агента `@anthropic-ai/claude-agent-sdk`, который тянет `misc.service.ts`, гасит ручной мок `__mocks__/@anthropic-ai/claude-agent-sdk.js` в корне репозитория. Копия репозитория для проверок без каталога `__mocks__` даёт ложные красные (`SyntaxError: Cannot use import statement outside a module`). База всё равно записывается: если `main` принесёт свою красную сюиту, дальше будет видно только новое:

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "rm -f /tmp/promo-jest-base.log; npx jest src/tg-bot src/blog > /tmp/promo-jest-base.log 2>&1 || true; grep -q '^Tests: ' /tmp/promo-jest-base.log || { tail -30 /tmp/promo-jest-base.log; echo JEST_DID_NOT_RUN; exit 1; }; grep -oE '^FAIL [^ ]+' /tmp/promo-jest-base.log | sort -u > ~/ci/promo-shorts-jest-fail-base.txt; grep -E '^(Tests|Test Suites):' /tmp/promo-jest-base.log; cat ~/ci/promo-shorts-jest-fail-base.txt"`
Expected: строки `Test Suites:` и `Tests:` без `failed`, список красных — пустой (на `c787327` красных сюит нет). Файл базы лежит на ноде вне воркдеревьев. `grep -q '^Tests: '` страхует от пустого прогона: jest, который не стартовал (ошибка конфига, сломанный `npm ci`), строк `FAIL` тоже не печатает.

Новые красные сюиты относительно этой базы показывает команда, которой пользуются задачи 22, 35 и 36:
- `|| true` после jest обязателен: команда выполняется под `bash -e`, и упавший jest оборвал бы её до сравнения;
- `grep -q '^Tests: '` — jest действительно отработал;
- `grep -oE '^FAIL [^ ]+'` берёт только путь: к медленной сюите jest дописывает время, и старая красная сюита с другим временем иначе показалась бы новой.

```bash
rm -f /tmp/promo-jest.log; npx jest src/shorts src/tg-bot src/blog > /tmp/promo-jest.log 2>&1 || true; grep -q '^Tests: ' /tmp/promo-jest.log || { tail -30 /tmp/promo-jest.log; echo JEST_DID_NOT_RUN; exit 1; }; grep -oE '^FAIL [^ ]+' /tmp/promo-jest.log | sort -u > /tmp/promo-fail-now.txt; comm -13 ~/ci/promo-shorts-jest-fail-base.txt /tmp/promo-fail-now.txt > /tmp/promo-fail-new.txt; cat /tmp/promo-fail-new.txt; test ! -s /tmp/promo-fail-new.txt && echo NO_NEW_FAILS
```

---

### Task 1: Типы роликов и машина состояний

**Files:**
- Create: `src/shorts/shorts.types.ts`
- Test: `src/shorts/shorts.types.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts.types.spec.ts`:

```ts
import {
  ALLOWED_TRANSITIONS,
  MAX_OWNER_NOTE_CHARS,
  ShortStatus,
  appendOwnerNote,
  canTransition,
  retryTarget,
  rowToShort,
  shortsBucket,
} from './shorts.types';

const STATUSES = Object.keys(ALLOWED_TRANSITIONS) as ShortStatus[];

describe('машина состояний роликов', () => {
  it('в approved ведут только «Одобрить», повтор отправки и повтор публикации', () => {
    // pending_review — кнопка владельца; publishing → approved — Telegram отвалился,
    // ролик ждёт следующего тика; failed → approved — «Повторить» (только с approved_at).
    expect(STATUSES.filter((s) => canTransition(s, 'approved')).sort()).toEqual(['failed', 'pending_review', 'publishing']);
  });

  it('в publishing — только из approved: в канал без одобрения не попасть', () => {
    expect(STATUSES.filter((s) => canTransition(s, 'publishing'))).toEqual(['approved']);
  });

  it('published и rejected терминальны', () => {
    expect(ALLOWED_TRANSITIONS.published).toEqual([]);
    expect(ALLOWED_TRANSITIONS.rejected).toEqual([]);
  });

  it('студия может вернуть сценарий сценаристу, а сценарист — в режиссёра', () => {
    expect(canTransition('rendering', 'writing')).toBe(true);
    expect(canTransition('writing', 'directing')).toBe(true);
  });
});

describe('retryTarget', () => {
  const failed = (failedFrom: ShortStatus | null, approvedAt: Date | null = null) =>
    ({ status: 'failed' as ShortStatus, failedFrom, approvedAt });

  it('продолжает с этапа, на котором ролик упал', () => {
    expect(retryTarget(failed('directing'))).toBe('directing');
    expect(retryTarget(failed('capturing'))).toBe('capture_queued');
    expect(retryTarget(failed('writing'))).toBe('writing');
    expect(retryTarget(failed('rendering'))).toBe('render_queued');
  });

  it('публикацию повторяет только у ролика, который владелец одобрял', () => {
    expect(retryTarget(failed('publishing', new Date()))).toBe('approved');
    expect(retryTarget(failed('publishing', null))).toBeNull();
  });

  it('не упавший ролик и ролик без этапа не повторяются', () => {
    expect(retryTarget({ status: 'pending_review', failedFrom: null, approvedAt: null })).toBeNull();
    expect(retryTarget(failed(null))).toBeNull();
  });
});

describe('rowToShort', () => {
  it('bigint и даты — числами и Date, пустое — null', () => {
    const v = rowToShort({
      id: 'v1', rubric: 'assistant', angle: 'roast', angle_locked: true, source: 'manual',
      topic_key: 't', status: 'pending_review', review_chat_id: '77', review_message_id: '12',
      note_prompt_ids: ['13', '14'], yt_prompt_ids: null, slot_at: '2026-10-27T15:00:00.000Z',
      approved_at: null, attempts: '2', writer_rounds: null, failure_notified: false,
      created_at: '2026-10-25T00:00:00.000Z', updated_at: '2026-10-25T00:00:00.000Z',
    });
    expect(v.reviewChatId).toBe(77);
    expect(v.reviewMessageId).toBe(12);
    expect(v.notePromptIds).toEqual([13, 14]);
    expect(v.ytPromptIds).toEqual([]);
    expect(v.slotAt).toEqual(new Date('2026-10-27T15:00:00.000Z'));
    expect(v.approvedAt).toBeNull();
    expect(v.attempts).toBe(2);
    expect(v.writerRounds).toBe(0);
    expect(v.angleLocked).toBe(true);
    expect(v.scene).toBeNull();
  });
});

describe('appendOwnerNote', () => {
  it('копит замечания строками, пустое не добавляет', () => {
    expect(appendOwnerNote(null, ' короче ')).toBe('короче');
    expect(appendOwnerNote('короче', 'другой вопрос')).toBe('короче\nдругой вопрос');
    expect(appendOwnerNote('короче', '  ')).toBe('короче');
  });

  it('сверх предела отрезает самое старое', () => {
    const out = appendOwnerNote('я'.repeat(MAX_OWNER_NOTE_CHARS), 'свежее');
    expect(Array.from(out).length).toBe(MAX_OWNER_NOTE_CHARS);
    expect(out.endsWith('\nсвежее')).toBe(true);
  });
});

describe('shortsBucket', () => {
  it('общий бакет видео, по умолчанию linkeon-smm-videos', () => {
    expect(shortsBucket({})).toBe('linkeon-smm-videos');
    expect(shortsBucket({ MINIO_BUCKET_VIDEOS: 'videos-test' })).toBe('videos-test');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts.types.spec.ts
git -C "$WT" commit -m "test(shorts): машина состояний и строка ролика (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts"`
Expected: FAIL — `Cannot find module './shorts.types'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts.types.ts`:

```ts
/**
 * Короткие ролики: типы, машина состояний и контракт со студией.
 *
 * Спека: docs/superpowers/specs/2026-10-24-promo-shorts-design.md.
 *
 * Поля jsonb (`scene`, `capture`, `script`) пишут две стороны: API — сцену и
 * сценарий, студия (`studio/`) — съёмку. Их форма — зеркало
 * `studio/src/types.ts` и `studio/src/worker/db.ts`. Импортировать оттуда
 * нельзя: студия — отдельный ESM-пакет вне сборки API. Совпадение имён полей
 * сторожит shorts.contract.spec.ts.
 */

export type ShortRubric = 'assistant' | 'feature' | 'news' | 'case';
export type ShortAngle = 'uncomfortable' | 'roast' | 'myth' | 'calm';
export type ShortSource = 'catalog' | 'git' | 'manual';
export type ShortStatus =
  | 'idea' | 'directing' | 'capture_queued' | 'capturing' | 'writing'
  | 'render_queued' | 'rendering' | 'pending_review' | 'approved'
  | 'publishing' | 'published' | 'rejected' | 'failed';
export type ShortPlatform = 'telegram' | 'vk' | 'youtube';
export type PublicationStatus =
  | 'pending' | 'publishing' | 'published' | 'failed' | 'manual_pending' | 'manual_done';

export const RUBRICS: readonly ShortRubric[] = ['assistant', 'feature', 'news', 'case'];
export const ANGLES: readonly ShortAngle[] = ['uncomfortable', 'roast', 'myth', 'calm'];
/** Провокационные подачи: два ролика из трёх в неделю (спека, «Подача»). */
export const PROVOCATIVE_ANGLES: readonly ShortAngle[] = ['uncomfortable', 'roast', 'myth'];

export const RUBRIC_TITLES: Record<ShortRubric, string> = {
  assistant: 'Ассистент за работой',
  feature: 'Возможность Linkeon',
  news: 'Новинка',
  case: 'Реальный кейс',
};

export const ANGLE_TITLES: Record<ShortAngle, string> = {
  uncomfortable: 'Неудобный вопрос',
  roast: 'Разнос',
  myth: 'ИИ против мифа',
  calm: 'Как это работает',
};

/** Ролик в работе: предназначен своему слоту и считается в предел MAX_IN_WORK. */
export const IN_WORK_STATUSES: readonly ShortStatus[] = [
  'directing', 'capture_queued', 'capturing', 'writing', 'render_queued', 'rendering', 'pending_review',
];

/** Слот держат ровно эти статусы — предикат uq_short_video_slot (сверяет shorts-schema.spec.ts). */
export const SLOT_HOLDING_STATUSES: readonly ShortStatus[] = ['approved', 'publishing'];

/** Больше стольких роликов в работе крон одновременно не запускает (спека, «Расписание»). */
export const MAX_IN_WORK = 2;

/**
 * Допустимые переходы. Главное, что здесь закрыто: в `publishing` ведёт только
 * `approved`, а в `approved` — кнопка «Одобрить» (`pending_review`), возврат
 * сорвавшейся отправки (`publishing`, ролик уже одобрен) и повтор публикации
 * из `failed`. Последний дополнительно требует `approved_at` (`retryTarget`):
 * ролик, упавший на съёмке, одобрения не получал, и путь «failed → approved»
 * открыл бы ему канал мимо человека.
 *
 * Возвраты на ту же стадию (`capturing → capture_queued`,
 * `rendering → render_queued`) — повтор задания студии после сбоя.
 * `rendering → writing` — озвучка вышла за 30–60 с, сценарий уходит на
 * переписку с пояснением. `writing → directing` — сценарист просит другую сцену.
 */
export const ALLOWED_TRANSITIONS: Record<ShortStatus, ShortStatus[]> = {
  idea:           ['directing', 'rejected'],
  directing:      ['capture_queued', 'failed'],
  capture_queued: ['capturing'],
  capturing:      ['writing', 'capture_queued', 'failed'],
  writing:        ['render_queued', 'directing', 'failed'],
  render_queued:  ['rendering'],
  rendering:      ['pending_review', 'render_queued', 'writing', 'failed'],
  pending_review: ['approved', 'writing', 'directing', 'rejected'],
  approved:       ['publishing', 'directing', 'rejected'],
  publishing:     ['published', 'approved', 'failed'],
  published:      [],
  rejected:       [],
  failed:         ['directing', 'capture_queued', 'writing', 'render_queued', 'approved', 'rejected'],
};

export function canTransition(from: ShortStatus, to: ShortStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/** С какого статуса продолжить упавший ролик — по этапу, на котором он упал. */
const RESUME_FROM: Partial<Record<ShortStatus, ShortStatus>> = {
  directing: 'directing',
  capturing: 'capture_queued',
  writing: 'writing',
  rendering: 'render_queued',
};

/**
 * Куда вернуть упавший ролик кнопкой «Повторить». null — повторять нечего.
 * Публикация повторяется только у ролика, который владелец одобрял.
 */
export function retryTarget(v: Pick<ShortVideo, 'status' | 'failedFrom' | 'approvedAt'>): ShortStatus | null {
  if (v.status !== 'failed' || !v.failedFrom) return null;
  if (v.failedFrom === 'publishing') return v.approvedAt ? 'approved' : null;
  return RESUME_FROM[v.failedFrom] ?? null;
}

/** Сколько приглашений к замечанию и к ссылке YouTube помним на ролике (как MAX_NOTE_PROMPTS блога). */
export const MAX_NOTE_PROMPTS = 20;

/** Предел накопленных замечаний: они уходят сценаристу и режиссёру целиком. */
export const MAX_OWNER_NOTE_CHARS = 2000;

/**
 * Замечание в конец накопленных. Второе замечание не отменяет первое — как у
 * блога (`appendEditorNote`). Сверх предела уходит самое старое.
 */
export function appendOwnerNote(prev: string | null, note: string): string {
  const joined = [String(prev ?? '').trim(), String(note ?? '').trim()].filter(Boolean).join('\n');
  const chars = Array.from(joined);
  return chars.length > MAX_OWNER_NOTE_CHARS ? chars.slice(-MAX_OWNER_NOTE_CHARS).join('') : joined;
}

/** Общий бакет видео (спека, «Что переиспользуем»); ролики — с префиксом shorts/. */
export function shortsBucket(env: Record<string, string | undefined> = process.env): string {
  return env.MINIO_BUCKET_VIDEOS || 'linkeon-smm-videos';
}

// ── Контракт со студией (зеркало studio/src/types.ts) ──────────────────────

/** Сцена чата: что и у какого ассистента спросить. */
export interface ShortScene {
  kind: 'chat';
  assistantId: number;
  /** Имя как в кабинете (agents.name): по нему студия проверяет, что открыт нужный ассистент. */
  assistantName: string;
  question: string;
  /** Ответы на встречный вопрос ассистента, по порядку; используется не больше двух. */
  followups: string[];
}

export interface ShortBox {
  n: number;
  top: number;
  height: number;
  text: string;
}

/** Абзац ответа целиком — его пересказывает реплика сценария. */
export interface ShortParagraph {
  n: number;
  text: string;
}

/** Съёмка, как её пишет студия (studio/src/worker/db.ts, StoredCapture). */
export interface ShortCapture {
  scene: ShortScene;
  cabinetUrl: string;
  capturedAt: string;
  questionShotKey: string;
  answerShotKey: string;
  answerShotWidth: number;
  answerShotHeight: number;
  answerText: string;
  turns: number;
  boxes: ShortBox[];
  paragraphs: ShortParagraph[];
}

export type ShortLineScene = 'hook' | 'question' | 'answer' | 'final';

export interface ShortScriptLine {
  id: string;
  scene: ShortLineScene;
  text: string;
  box?: number;
  voice?: string;
}

export interface ShortScript {
  hook: string;
  /** Абзац, на котором держится смелая фраза зацепки (правило 10). */
  hookBox?: number;
  /** Подпись в кадре вопроса — у реального кейса. */
  badge?: string;
  voice: string;
  speed: number;
  lines: ShortScriptLine[];
  final: { assistantsCount: number; disclaimer?: string };
}

/** Подписи площадок — уже со ссылками и пометкой о синтезированном голосе. */
export interface ShortCaptions {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

// ── Строки таблиц ──────────────────────────────────────────────────────────

export interface ShortVideo {
  id: string;
  rubric: ShortRubric;
  angle: ShortAngle;
  angleLocked: boolean;
  source: ShortSource;
  sourceRef: string | null;
  topicKey: string;
  topicHint: string | null;
  title: string | null;
  assistantId: number | null;
  slug: string | null;
  lang: string;
  scene: ShortScene | null;
  capture: ShortCapture | null;
  script: ShortScript | null;
  captions: ShortCaptions | null;
  videoKey: string | null;
  coverKey: string | null;
  durationMs: number | null;
  status: ShortStatus;
  /** До одобрения — планируемый слот, после — занятый. */
  slotAt: Date | null;
  approvedAt: Date | null;
  ownerNote: string | null;
  writerFeedback: string | null;
  writerRounds: number;
  reviewChatId: number | null;
  reviewMessageId: number | null;
  notePromptIds: number[];
  ytPromptIds: number[];
  leaseUntil: Date | null;
  attempts: number;
  lastError: string | null;
  failedFrom: ShortStatus | null;
  failureNotified: boolean;
  publishedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ShortPublication {
  shortId: string;
  platform: ShortPlatform;
  status: PublicationStatus;
  externalId: string | null;
  url: string | null;
  attempts: number;
  lastError: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
}

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: any): Date | null => (v ? new Date(v) : null);
// bigint[] node-pg отдаёт строками поэлементно; сравнение '13' === 13 молча ложно.
const ids = (v: any): number[] => (Array.isArray(v) ? v.map(Number) : []);

export function rowToShort(row: any): ShortVideo {
  return {
    id: row.id,
    rubric: row.rubric,
    angle: row.angle,
    angleLocked: row.angle_locked === true,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    topicKey: row.topic_key,
    topicHint: row.topic_hint ?? null,
    title: row.title ?? null,
    assistantId: num(row.assistant_id),
    slug: row.slug ?? null,
    lang: row.lang ?? 'ru',
    scene: row.scene ?? null,
    capture: row.capture ?? null,
    script: row.script ?? null,
    captions: row.captions ?? null,
    videoKey: row.video_key ?? null,
    coverKey: row.cover_key ?? null,
    durationMs: num(row.duration_ms),
    status: row.status,
    slotAt: date(row.slot_at),
    approvedAt: date(row.approved_at),
    ownerNote: row.owner_note ?? null,
    writerFeedback: row.writer_feedback ?? null,
    writerRounds: Number(row.writer_rounds || 0),
    reviewChatId: num(row.review_chat_id),
    reviewMessageId: num(row.review_message_id),
    notePromptIds: ids(row.note_prompt_ids),
    ytPromptIds: ids(row.yt_prompt_ids),
    leaseUntil: date(row.lease_until),
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ?? null,
    failedFrom: row.failed_from ?? null,
    failureNotified: row.failure_notified === true,
    publishedAt: date(row.published_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function rowToPublication(row: any): ShortPublication {
  return {
    shortId: row.short_id,
    platform: row.platform,
    status: row.status,
    externalId: row.external_id ?? null,
    url: row.url ?? null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ?? null,
    publishedAt: date(row.published_at),
    updatedAt: date(row.updated_at),
  };
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS (все тесты файла), `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts.types.ts
git -C "$WT" commit -m "feat(shorts): типы роликов, машина состояний, контракт со студией

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Таблицы роликов и их накат при старте

**Files:**
- Create: `src/shorts/migrations/001_shorts.sql`
- Create: `src/shorts/shorts-schema.service.ts`
- Test: `src/shorts/shorts-schema.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-schema.spec.ts`:

```ts
/**
 * Накат миграции роликов — без базы. Живой повторный старт с открытой
 * пишущей транзакцией проверяет shorts.integration.spec.ts; здесь — то, что
 * живой прогон не видит: файл находится сервисом, катится при старте, его
 * форма не берёт лишних замков и не расходится с типами.
 */
import { ShortsSchemaService } from './shorts-schema.service';
import { ALLOWED_TRANSITIONS, SLOT_HOLDING_STATUSES } from './shorts.types';

async function appliedSql(): Promise<string> {
  const queries: string[] = [];
  const pg = { query: jest.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }) };
  await new ShortsSchemaService(pg as any).onModuleInit();
  const text = queries.find((q) => q.includes('CREATE TABLE short_video'));
  if (!text) throw new Error('миграция 001 не применена');
  return text.replace(/--[^\n]*/g, '');
}

describe('ShortsSchemaService', () => {
  it('катит 001 при старте модуля', async () => {
    expect(await appliedSql()).toContain('CREATE TABLE short_publication');
  });

  it('не роняет старт, если база ответила ошибкой', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('boom'); }) };
    await expect(new ShortsSchemaService(pg as any).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('текст 001_shorts.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/001'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('каждый индекс — под IF to_regclass, а не голым CREATE INDEX IF NOT EXISTS', async () => {
    const sql = await appliedSql();
    const created = sql.match(/CREATE (UNIQUE )?INDEX/g) ?? [];
    const guarded = sql.match(/IF to_regclass\('public\.(uq|idx)_short_[a-z_]+'\) IS NULL THEN\s+CREATE (UNIQUE )?INDEX/g) ?? [];
    expect(created.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(created.length);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
  });

  it('слот держат ровно SLOT_HOLDING_STATUSES', async () => {
    const m = (await appliedSql()).match(/uq_short_video_slot ON short_video \(slot_at\)\s+WHERE status IN \(([^)]*)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...SLOT_HOLDING_STATUSES].sort());
  });

  it('статусы в CHECK совпадают с машиной состояний', async () => {
    const m = (await appliedSql()).match(/status\s+text NOT NULL DEFAULT 'idea' CHECK \(status IN \(([\s\S]*?)\)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
  });

  it('строка настроек — под IF NOT EXISTS: обычный SELECT не ждёт чужую правку', async () => {
    expect(await appliedSql()).toMatch(/IF NOT EXISTS \(SELECT 1 FROM short_settings WHERE id = 1\) THEN\s+INSERT INTO short_settings/);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-schema.spec.ts
git -C "$WT" commit -m "test(shorts): накат таблиц роликов (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-schema.service'`.

- [ ] **Step 3: Миграция**

`src/shorts/migrations/001_shorts.sql`:

```sql
-- 001_shorts.sql — таблицы коротких роликов.
--
-- Спека: docs/superpowers/specs/2026-10-24-promo-shorts-design.md, «Данные».
-- План: docs/superpowers/plans/2026-10-25-promo-shorts-2-pipeline.md, задача 2.
--
-- КАК КАТИТСЯ. ShortsSchemaService выполняет файл при КАЖДОМ старте API: общий
-- migrate-раннер на проде сломан (см. tokens-schema.service.ts). Поэтому файл
-- идемпотентен, и весь он — один оператор DO, то есть одна транзакция.
--
-- ЗАМКИ. Первым — advisory-лок: два одновременных старта (cluster_mode) идут
-- по очереди. Дальше чужих замков ждём не дольше 5 с (lock_timeout только в
-- этой транзакции): ошибка откатит файл, следующий старт повторит. Таблицы и
-- индексы создаются только под IF to_regclass(...) IS NULL. Голый CREATE INDEX
-- IF NOT EXISTS берёт ShareLock даже на готовый индекс и на каждом старте ждал
-- бы открытые записи (так было в tokens/002, проверено на PG 16).
--
-- Строка настроек вставляется под IF NOT EXISTS (SELECT …): обычный SELECT не
-- ждёт чужую незакрытую правку настроек, а INSERT … ON CONFLICT мог бы.
--
-- ОТКАТ (ролики пропадут): убрать ShortsSchemaService из shorts.module.ts —
-- иначе следующий старт создаст таблицы заново, — затем
--   DROP TABLE short_publication; DROP TABLE short_video; DROP TABLE short_settings;

DO $shorts$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('shorts/001'));
    PERFORM set_config('lock_timeout', '5s', true);

    IF to_regclass('public.short_video') IS NULL THEN
        CREATE TABLE short_video (
            id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            rubric            text NOT NULL CHECK (rubric IN ('assistant', 'feature', 'news', 'case')),
            -- Подача. angle_locked — задана при заказе; иначе её ставит ритм недели при запуске.
            angle             text NOT NULL DEFAULT 'calm'
                                CHECK (angle IN ('uncomfortable', 'roast', 'myth', 'calm')),
            angle_locked      boolean NOT NULL DEFAULT false,
            source            text NOT NULL CHECK (source IN ('catalog', 'git', 'manual')),
            source_ref        text,
            topic_key         text NOT NULL,
            topic_hint        text,
            title             text,
            assistant_id      int,
            -- Для меток: только [a-z0-9_], до 40 символов (vk-ads разбирает [A-Za-z0-9_]+).
            slug              text CHECK (slug IS NULL OR slug ~ '^[a-z0-9_]{1,40}$'),
            lang              text NOT NULL DEFAULT 'ru',
            scene             jsonb,
            capture           jsonb,
            script            jsonb,
            captions          jsonb,
            video_key         text,
            cover_key         text,
            duration_ms       int,
            status            text NOT NULL DEFAULT 'idea' CHECK (status IN (
                                'idea', 'directing', 'capture_queued', 'capturing', 'writing',
                                'render_queued', 'rendering', 'pending_review', 'approved',
                                'publishing', 'published', 'rejected', 'failed')),
            -- До одобрения — планируемый слот, после — занятый.
            slot_at           timestamptz,
            -- Ролик одобрял человек: только такой можно вернуть в approved повтором публикации.
            approved_at       timestamptz,
            owner_note        text,
            -- Пояснение сценаристу от студии: озвучка вышла за 30–60 с.
            writer_feedback   text,
            writer_rounds     int NOT NULL DEFAULT 0,
            review_chat_id    bigint,
            review_message_id bigint,
            note_prompt_ids   bigint[] NOT NULL DEFAULT '{}'::bigint[],
            yt_prompt_ids     bigint[] NOT NULL DEFAULT '{}'::bigint[],
            -- Аренда этапа: API (режиссёр, сценарист, отправка владельцу) и студия (съёмка, сборка).
            lease_until       timestamptz,
            attempts          int NOT NULL DEFAULT 0,
            last_error        text,
            failed_from       text,
            failure_notified  boolean NOT NULL DEFAULT false,
            published_at      timestamptz,
            created_at        timestamptz NOT NULL DEFAULT now(),
            updated_at        timestamptz NOT NULL DEFAULT now()
        );
    END IF;

    -- Один ролик на слот, как blog/004: слот держат approved и publishing.
    IF to_regclass('public.uq_short_video_slot') IS NULL THEN
        CREATE UNIQUE INDEX uq_short_video_slot ON short_video (slot_at)
            WHERE status IN ('approved', 'publishing');
    END IF;
    -- Повторная доставка /short и повторное наполнение недели второй ролик не заводят.
    IF to_regclass('public.uq_short_video_source_ref') IS NULL THEN
        CREATE UNIQUE INDEX uq_short_video_source_ref ON short_video (source_ref)
            WHERE source_ref IS NOT NULL;
    END IF;
    IF to_regclass('public.idx_short_video_status') IS NULL THEN
        CREATE INDEX idx_short_video_status ON short_video (status, lease_until);
    END IF;

    -- Статус по площадке отдельно: Telegram вышел, YouTube ждёт — повторяем только упавшую.
    IF to_regclass('public.short_publication') IS NULL THEN
        CREATE TABLE short_publication (
            short_id      uuid NOT NULL REFERENCES short_video(id),
            platform      text NOT NULL CHECK (platform IN ('telegram', 'vk', 'youtube')),
            status        text NOT NULL CHECK (status IN (
                            'pending', 'publishing', 'published', 'failed',
                            'manual_pending', 'manual_done')),
            external_id   text,
            url           text,
            views         int,
            views_at      timestamptz,
            attempts      int NOT NULL DEFAULT 0,
            last_error    text,
            published_at  timestamptz,
            created_at    timestamptz NOT NULL DEFAULT now(),
            updated_at    timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (short_id, platform)
        );
    END IF;

    IF to_regclass('public.short_settings') IS NULL THEN
        CREATE TABLE short_settings (
            id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            slot_days           int[] NOT NULL DEFAULT '{2,4,6}',
            slot_hour_msk       int   NOT NULL DEFAULT 18,
            prepare_lead_hours  int   NOT NULL DEFAULT 24,
            min_answer_chars    int   NOT NULL DEFAULT 400,
            tg_channel_chat_id  text,
            vk_group_id         bigint,
            youtube_channel_id  text,
            platforms           text[] NOT NULL DEFAULT '{telegram,youtube}',
            narrator_voice      text  NOT NULL DEFAULT 'alena',
            updated_at          timestamptz NOT NULL DEFAULT now()
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM short_settings WHERE id = 1) THEN
        INSERT INTO short_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    END IF;
END
$shorts$;
```

- [ ] **Step 4: Сервис наката**

`src/shorts/shorts-schema.service.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

/**
 * Таблицы роликов — при старте модуля, идемпотентным SQL. Общий
 * `npm run migrate` на проде застрял на base/001 и не докатывает ничего после
 * (tokens-schema.service.ts), поэтому модули катят свои миграции сами.
 */
@Injectable()
export class ShortsSchemaService implements OnModuleInit {
  private readonly logger = new Logger(ShortsSchemaService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    await this.applyMigration('001_shorts.sql');
  }

  /**
   * Два пути, как в tokens-schema.service.ts: рядом с собранным js (dist) и в
   * исходниках. `nest build` .sql в dist не кладёт, так что на проде файл
   * находится по второму. «Не нашёл» — warn, «нашёл и не применил» — error:
   * сломанная миграция не должна прятаться за будничным «skipping».
   */
  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'shorts', 'migrations', filename),
    ];
    let found = false;
    for (const p of [...new Set(candidates)]) {
      if (!fs.existsSync(p)) continue;
      found = true;
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
        this.logger.log(`shorts migration ${filename} applied from ${p}`);
        return;
      } catch (e: any) {
        this.logger.error(`shorts migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    if (found) {
      this.logger.error(`shorts migration ${filename} was found but did not apply on any candidate path`);
    } else {
      this.logger.warn(`shorts migration ${filename} not found, skipping`);
    }
  }
}
```

- [ ] **Step 5: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add src/shorts/migrations/001_shorts.sql src/shorts/shorts-schema.service.ts
git -C "$WT" commit -m "feat(shorts): таблицы роликов, накат при старте API

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Числа словами и финальная реплика

Финальная реплика звучит голосом alena: «Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.» Число берётся из базы. Словами пишет код, чтобы цифра на экране и в голосе была одна, а SpeechKit не читал её по-своему.

**Files:**
- Create: `src/shorts/short-numbers.ts`
- Test: `src/shorts/short-numbers.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-numbers.spec.ts`:

```ts
import { assistantsInWords, finalLine, numberWordsRu } from './short-numbers';

describe('numberWordsRu', () => {
  it.each([
    [0, 'ноль'], [1, 'один'], [9, 'девять'], [10, 'десять'], [11, 'одиннадцать'],
    [18, 'восемнадцать'], [20, 'двадцать'], [21, 'двадцать один'], [40, 'сорок'],
    [99, 'девяносто девять'], [100, 'сто'], [111, 'сто одиннадцать'], [205, 'двести пять'],
    [999, 'девятьсот девяносто девять'],
  ])('%i → %s', (n, words) => {
    expect(numberWordsRu(n)).toBe(words);
  });

  it('вне 0–999 и дробное — ошибка, а не тихая ерунда в озвучке', () => {
    expect(() => numberWordsRu(1000)).toThrow(/0–999/);
    expect(() => numberWordsRu(-1)).toThrow(/0–999/);
    expect(() => numberWordsRu(1.5)).toThrow(/0–999/);
  });
});

describe('assistantsInWords', () => {
  it('падеж — из Intl.PluralRules', () => {
    expect(assistantsInWords(18)).toBe('восемнадцать ассистентов');
    expect(assistantsInWords(21)).toBe('двадцать один ассистент');
    expect(assistantsInWords(22)).toBe('двадцать два ассистента');
    expect(assistantsInWords(11)).toBe('одиннадцать ассистентов');
  });
});

describe('finalLine', () => {
  it('совпадает с финалом принятого образца', () => {
    expect(finalLine(18)).toBe('Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-numbers.spec.ts
git -C "$WT" commit -m "test(shorts): числа словами для финала (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-numbers.spec.ts"`
Expected: FAIL — `Cannot find module './short-numbers'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-numbers.ts`:

```ts
/**
 * Числа для озвучки. Финальную реплику пишет код, а не сценарист: число
 * ассистентов берётся из базы (правило текста 1), и словами — чтобы на
 * экране и в голосе было одно и то же, а SpeechKit не читал цифру по-своему.
 */

const UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Целое 0–999 словами, мужской род («один ассистент», «два ассистента»). */
export function numberWordsRu(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) {
    throw new Error(`numberWordsRu: ждём целое 0–999, получено ${n}`);
  }
  if (n === 0) return UNITS[0];
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    const units = rest % 10;
    if (tens) parts.push(TENS[tens]);
    if (units) parts.push(UNITS[units]);
  }
  return parts.join(' ');
}

const FORMS: Record<string, string> = { one: 'ассистент', few: 'ассистента', many: 'ассистентов', other: 'ассистента' };
const rules = new Intl.PluralRules('ru-RU');

/** «восемнадцать ассистентов» — падеж из Intl.PluralRules, как plural.ts студии. */
export function assistantsInWords(n: number): string {
  return `${numberWordsRu(n)} ${FORMS[rules.select(n)]}`;
}

/**
 * Финальная реплика — дословно как в принятом образце (владелец, 25.10.2026).
 * «Линкеон» кириллицей: латиницу SpeechKit читает непредсказуемо.
 */
export function finalLine(assistantsCount: number): string {
  return `Линкеон — ${assistantsInWords(assistantsCount)}. Ссылка — в описании и в профиле.`;
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-numbers.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-numbers.ts
git -C "$WT" commit -m "feat(shorts): числа словами и финальная реплика

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Слаг и ссылки с метками

Ссылки всегда ведут в кабинет, где живёт атрибуция. Ролик про ассистента ведёт в его чат: человек после входа попадает к тому, кого видел. `slug` — латиница, цифры и подчёркивание, до 40 знаков. Хвост из первых четырёх знаков id не даёт кампаниям двух роликов на одну тему склеиться.

**Files:**
- Create: `src/shorts/short-slug.ts`, `src/shorts/short-links.ts`
- Test: `src/shorts/short-links.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-links.spec.ts`:

```ts
import { SLUG_PATTERN, shortSlug, slugBase } from './short-slug';
import { DEFAULT_LINK_BASE, linkBase, shortLink, shortLinks, shortTarget } from './short-links';

describe('slugBase', () => {
  it('кириллица — латиницей, всё прочее — подчёркиванием', () => {
    expect(slugBase('Залог при аренде!')).toBe('zalog_pri_arende');
    expect(slugBase('Щука, ёлка и Юля')).toBe('schuka_elka_i_yulya');
    expect(slugBase('  --  ')).toBe('');
  });
});

describe('shortSlug', () => {
  it('основа и 4 знака id, не длиннее 40 и под шаблон меток', () => {
    expect(shortSlug('Залог при аренде', 'ab12cd34-0000-4000-8000-000000000000')).toBe('zalog_pri_arende_ab12');
    const long = shortSlug('очень '.repeat(20), 'ffff0000-0000-4000-8000-000000000000');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(SLUG_PATTERN.test(long)).toBe(true);
    expect(long.endsWith('_ffff')).toBe(true);
  });

  it('тема без букв — short и хвост id', () => {
    expect(shortSlug('!!!', '0a0b0c0d-0000-4000-8000-000000000000')).toBe('short_0a0b');
  });
});

describe('ссылки роликов', () => {
  it('ведут в чат ассистента с метками площадки и кампании', () => {
    const url = shortLink({ base: 'https://my.linkeon.io', target: shortTarget(10), platform: 'telegram', slug: 'zalog_ab12' });
    expect(url).toBe('https://my.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_zalog_ab12');
  });

  it('без ассистента — в чат', () => {
    expect(shortTarget(null)).toBe('chat');
  });

  it('по ссылке на каждую площадку', () => {
    const links = shortLinks('https://my.linkeon.io', 'chat', 'x_0000');
    expect(Object.keys(links).sort()).toEqual(['telegram', 'vk', 'youtube']);
    expect(links.youtube).toContain('utm_source=youtube');
  });

  it('кривой слаг метку не получает', () => {
    expect(() => shortLink({ base: 'https://my.linkeon.io', target: 'chat', platform: 'vk', slug: 'Залог' })).toThrow(/слаг/);
  });

  it('адрес кабинета — из SHORTS_LINK_BASE, хвостовой слэш снимается', () => {
    expect(linkBase({})).toBe(DEFAULT_LINK_BASE);
    expect(linkBase({ SHORTS_LINK_BASE: 'https://test.linkeon.io/' })).toBe('https://test.linkeon.io');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-links.spec.ts
git -C "$WT" commit -m "test(shorts): слаг и ссылки с метками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-links.spec.ts"`
Expected: FAIL — `Cannot find module './short-slug'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-slug.ts`:

```ts
/** Транслитерация для меток: в utm_campaign — только латиница, цифры и подчёркивание. */
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG_MAX = 40;
/** Тот же формат разбирает vk-ads.service ([A-Za-z0-9_]+); CHECK в 001_shorts.sql — такой же. */
export const SLUG_PATTERN = /^[a-z0-9_]{1,40}$/;

export function slugBase(text: string): string {
  const latin = Array.from(String(text ?? '').toLowerCase())
    .map((ch) => (ch in MAP ? MAP[ch] : ch))
    .join('');
  return latin.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Слаг ролика: основа до 35 знаков и первые 4 знака id. */
export function shortSlug(text: string, id: string): string {
  const tail = String(id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || '0000';
  const base = slugBase(text).slice(0, SLUG_MAX - tail.length - 1).replace(/_+$/, '') || 'short';
  return `${base}_${tail}`;
}
```

`src/shorts/short-links.ts`:

```ts
import { SLUG_PATTERN } from './short-slug';

export type LinkPlatform = 'telegram' | 'vk' | 'youtube';

export const DEFAULT_LINK_BASE = 'https://my.linkeon.io';

/** Адрес кабинета в ссылках роликов. На стенде — test.linkeon.io, чтобы клики проверки не шли в прод. */
export function linkBase(env: Record<string, string | undefined> = process.env): string {
  return (env.SHORTS_LINK_BASE?.trim() || DEFAULT_LINK_BASE).replace(/\/+$/, '');
}

/** Куда ведёт ссылка: в чат ассистента, которого зритель видел (кабинет помнит его до входа). */
export function shortTarget(assistantId: number | null): string {
  return assistantId ? `chat?assistant=${assistantId}` : 'chat';
}

/** Ссылка с метками площадки: utm_medium=short, utm_campaign=sh_<slug> (спека, «Метки и измерение»). */
export function shortLink(o: { base: string; target: string; platform: LinkPlatform; slug: string }): string {
  if (!SLUG_PATTERN.test(o.slug)) {
    throw new Error(`shorts: слаг «${o.slug}» не годится для метки — только [a-z0-9_], до 40 знаков`);
  }
  const url = new URL(`${o.base}/${o.target}`);
  url.searchParams.set('utm_source', o.platform);
  url.searchParams.set('utm_medium', 'short');
  url.searchParams.set('utm_campaign', `sh_${o.slug}`);
  return url.toString();
}

export function shortLinks(base: string, target: string, slug: string): Record<LinkPlatform, string> {
  return {
    telegram: shortLink({ base, target, platform: 'telegram', slug }),
    vk: shortLink({ base, target, platform: 'vk', slug }),
    youtube: shortLink({ base, target, platform: 'youtube', slug }),
  };
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-links.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-slug.ts src/shorts/short-links.ts
git -C "$WT" commit -m "feat(shorts): слаг и ссылки роликов с метками

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ассистенты в роликах и ритм подач

Голос ассистента берётся тот же, что у него по умолчанию в кабинете (`voices.ts`). Строка «Ответ ИИ, не заменяет …» нужна юристу, бухгалтеру, финансам и здоровью. Ритм недели: в любых трёх роликах подряд один `calm`, провокационные подачи не повторяются подряд. Здоровье в провокационный слот не идёт (правило 12).

**Files:**
- Create: `src/shorts/short-assistants.ts`, `src/shorts/short-rhythm.ts`
- Test: `src/shorts/short-assistants.spec.ts`, `src/shorts/short-rhythm.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

`src/shorts/short-assistants.spec.ts`:

```ts
import { assistantVoice, disclaimerFor, isHealthAssistant } from './short-assistants';

describe('ассистенты в роликах', () => {
  it('голос — тот же, что у ассистента по умолчанию', () => {
    expect(assistantVoice('Алексей')).toBe('madirus');
    expect(assistantVoice('Кира')).toBe('marina');
  });

  it('незнакомый ассистент — голос по умолчанию, а не ошибка', () => {
    expect(assistantVoice('Новенький')).toBe('alena');
  });

  it('строка о специалисте — юристу, бухгалтеру, финансам и здоровью', () => {
    expect(disclaimerFor('Алексей')).toBe('Ответ ИИ, не заменяет юриста');
    expect(disclaimerFor('Анна')).toBe('Ответ ИИ, не заменяет бухгалтера');
    expect(disclaimerFor('Виталий')).toBe('Ответ ИИ, не заменяет финансового консультанта');
    expect(disclaimerFor('Полина')).toBe('Ответ ИИ, не заменяет врача');
    expect(disclaimerFor('Кира')).toBeUndefined();
  });

  it('темы здоровья — у Полины и Шанкары', () => {
    expect(isHealthAssistant('Полина')).toBe(true);
    expect(isHealthAssistant('Шанкара')).toBe(true);
    expect(isHealthAssistant('Алексей')).toBe(false);
  });
});
```

`src/shorts/short-rhythm.spec.ts`:

```ts
import { IdeaLite, nextAngle, pickAssistants, planNext } from './short-rhythm';
import { ShortAngle } from './shorts.types';

describe('nextAngle', () => {
  it('из пустой истории — неудобный вопрос, затем разнос, затем спокойный', () => {
    expect(nextAngle([])).toBe('uncomfortable');
    expect(nextAngle(['uncomfortable'])).toBe('roast');
    expect(nextAngle(['roast', 'uncomfortable'])).toBe('calm');
  });

  it('в любых трёх подряд — ровно один calm, провокации подряд не повторяются', () => {
    const recent: ShortAngle[] = [];
    for (let i = 0; i < 12; i++) recent.unshift(nextAngle(recent));
    const chrono = [...recent].reverse();
    for (let i = 0; i + 3 <= chrono.length; i++) {
      expect(chrono.slice(i, i + 3).filter((a) => a === 'calm')).toHaveLength(1);
    }
    const provocative = chrono.filter((a) => a !== 'calm');
    for (let i = 1; i < provocative.length; i++) expect(provocative[i]).not.toBe(provocative[i - 1]);
  });
});

const idea = (over: Partial<IdeaLite>): IdeaLite => ({
  id: 'x', rubric: 'assistant', assistantName: 'Алексей', angle: 'calm', angleLocked: false,
  source: 'catalog', createdAt: new Date('2026-10-20T00:00:00Z'), ...over,
});

describe('planNext', () => {
  it('пустая очередь — запускать нечего', () => {
    expect(planNext([], [])).toBeNull();
  });

  it('заказ владельца — раньше каталога', () => {
    const p = planNext([idea({ id: 'cat' }), idea({ id: 'own', source: 'manual', createdAt: new Date('2026-10-24T00:00:00Z') })], []);
    expect(p).toEqual({ ideaId: 'own', angle: 'uncomfortable' });
  });

  it('две одинаковые рубрики подряд не ставятся, если в очереди есть другая', () => {
    const p = planNext([idea({ id: 'a', rubric: 'case', source: 'manual' }), idea({ id: 'b' })], [{ rubric: 'case', angle: 'calm' }]);
    expect(p?.ideaId).toBe('b');
  });

  it('другой рубрики нет — берётся та же', () => {
    expect(planNext([idea({ id: 'a' })], [{ rubric: 'assistant', angle: 'calm' }])?.ideaId).toBe('a');
  });

  it('подача, заданная при заказе, не меняется', () => {
    expect(planNext([idea({ id: 'a', angle: 'myth', angleLocked: true })], [])).toEqual({ ideaId: 'a', angle: 'myth' });
  });

  it('здоровье в провокационный слот не идёт, если есть другая тема', () => {
    const p = planNext(
      [idea({ id: 'h', assistantName: 'Полина' }), idea({ id: 'k', assistantName: 'Кира', createdAt: new Date('2026-10-21T00:00:00Z') })],
      [],
    );
    expect(p).toEqual({ ideaId: 'k', angle: 'uncomfortable' });
  });

  it('другой темы нет — здоровье выходит спокойным', () => {
    expect(planNext([idea({ id: 'h', assistantName: 'Шанкара' })], [])).toEqual({ ideaId: 'h', angle: 'calm' });
  });
});

describe('pickAssistants', () => {
  const all = [
    { id: 1, name: 'Миша', description: '' },
    { id: 10, name: 'Алексей', description: '' },
    { id: 22, name: 'Кира', description: '' },
    { id: 4, name: 'Ирина', description: '' },
  ];

  it('сначала те, о ком роликов не было, затем давно показанные; с открытой идеей — пропуск', () => {
    const last = new Map([[10, new Date('2026-10-01')], [22, new Date('2026-09-01')]]);
    expect(pickAssistants(all, last, new Set([4]), 3).map((a) => a.id)).toEqual([1, 22, 10]);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тесты падают**

```bash
git -C "$WT" add src/shorts/short-assistants.spec.ts src/shorts/short-rhythm.spec.ts
git -C "$WT" commit -m "test(shorts): голоса ассистентов и ритм подач (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-assistants.spec.ts src/shorts/short-rhythm.spec.ts"`
Expected: FAIL — `Cannot find module './short-assistants'` и `'./short-rhythm'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-assistants.ts`:

```ts
import { ASSISTANT_DEFAULTS, GENDER_DEFAULT } from '../speech/voices';

/**
 * Кому в финале нужна строка «Ответ ИИ, не заменяет …» (спека: юристы,
 * психологи, медицина и деньги). Ключ — agents.name. Психолога среди
 * активных ассистентов на 25.10.2026 нет; появится — дописать сюда.
 */
const SPECIALIST: Record<string, string> = {
  'Алексей': 'юриста',
  'Анна': 'бухгалтера',
  'Виталий': 'финансового консультанта',
  'Полина': 'врача',
  'Шанкара': 'врача',
};

/** Ассистенты, чьи темы касаются здоровья: им — только спокойная подача (правило 12). */
const HEALTH = new Set(['Полина', 'Шанкара']);

export function disclaimerFor(assistantName: string): string | undefined {
  const who = SPECIALIST[assistantName];
  return who ? `Ответ ИИ, не заменяет ${who}` : undefined;
}

export function isHealthAssistant(assistantName: string): boolean {
  return HEALTH.has(assistantName);
}

/**
 * Голос ассистента в SpeechKit — тот, что у него по умолчанию в кабинете.
 * Незнакомому — женский по умолчанию, как resolveVoice; владелец услышит это
 * на проверке и, если что, ассистента допишут в ASSISTANT_DEFAULTS.
 */
export function assistantVoice(assistantName: string): string {
  return ASSISTANT_DEFAULTS[assistantName]?.yandex ?? GENDER_DEFAULT.f.yandex;
}
```

`src/shorts/short-rhythm.ts`:

```ts
import { isHealthAssistant } from './short-assistants';
import { PROVOCATIVE_ANGLES, ShortAngle, ShortRubric, ShortSource } from './shorts.types';

/**
 * Подача следующего ролика по ритму недели: в любых трёх подряд — один calm и
 * две провокационные, разные. recent — подачи последних запущенных роликов,
 * от свежего к старому.
 */
export function nextAngle(recent: ShortAngle[]): ShortAngle {
  if (recent.length >= 2 && !recent.slice(0, 2).includes('calm')) return 'calm';
  const lastProvocative = recent.find((a) => a !== 'calm');
  const i = lastProvocative ? PROVOCATIVE_ANGLES.indexOf(lastProvocative) : -1;
  return PROVOCATIVE_ANGLES[(i + 1) % PROVOCATIVE_ANGLES.length];
}

export interface IdeaLite {
  id: string;
  rubric: ShortRubric;
  assistantName: string | null;
  angle: ShortAngle;
  angleLocked: boolean;
  source: ShortSource;
  createdAt: Date;
}

export interface RecentLite {
  rubric: ShortRubric;
  angle: ShortAngle;
}

export interface NextPlan {
  ideaId: string;
  angle: ShortAngle;
}

const health = (i: IdeaLite): boolean => Boolean(i.assistantName && isHealthAssistant(i.assistantName));

/**
 * Какую идею запускать и с какой подачей.
 *
 * 1. Рубрика не повторяет рубрику последнего ролика, если в очереди есть другая.
 * 2. Заказ владельца — раньше каталога, дальше — по времени заказа.
 * 3. Провокационный слот не отдаётся теме здоровья, пока есть другая; если
 *    другой нет, тема здоровья выходит спокойной (правило 12).
 * 4. Подача, заданная при заказе, не меняется.
 */
export function planNext(ideas: IdeaLite[], recent: RecentLite[]): NextPlan | null {
  if (!ideas.length) return null;
  const wanted = nextAngle(recent.map((r) => r.angle));
  const provocative = wanted !== 'calm';
  const lastRubric = recent[0]?.rubric;
  const ordered = [...ideas].sort(
    (a, b) => Number(a.source !== 'manual') - Number(b.source !== 'manual') || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const other = ordered.filter((i) => i.rubric !== lastRubric);
  const pool = other.length ? other : ordered;
  let pick = pool[0];
  if (provocative && !pick.angleLocked && health(pick)) {
    pick = pool.find((i) => i.angleLocked || !health(i)) ?? pick;
  }
  const angle = pick.angleLocked ? pick.angle : provocative && health(pick) ? 'calm' : wanted;
  return { ideaId: pick.id, angle };
}

export interface CatalogAssistant {
  id: number;
  name: string;
  description: string;
}

/**
 * Ассистенты недели: сначала те, о ком роликов не было, затем давно
 * показанные. У кого уже есть идея в очереди — пропускается.
 */
export function pickAssistants(
  all: CatalogAssistant[],
  lastShown: Map<number, Date>,
  open: Set<number>,
  count: number,
): CatalogAssistant[] {
  return all
    .filter((a) => !open.has(a.id))
    .sort((a, b) => (lastShown.get(a.id)?.getTime() ?? 0) - (lastShown.get(b.id)?.getTime() ?? 0) || a.id - b.id)
    .slice(0, count);
}
```

- [ ] **Step 4: Тесты проходят, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-assistants.spec.ts src/shorts/short-rhythm.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS (оба файла), `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-assistants.ts src/shorts/short-rhythm.ts
git -C "$WT" commit -m "feat(shorts): голоса ассистентов, строка о специалисте, ритм подач

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Правила текста

Те же правила вписаны в промпт сценариста (задача 14) и проверяются кодом до отправки владельцу. Проверка — страховка, а не фильтр смысла: стоп-слова ловят явное, остальное держат промпт и глаза владельца. Не прошедший сценарий возвращается сценаристу с перечнем нарушений.

**Files:**
- Create: `src/shorts/short-rules.ts`
- Test: `src/shorts/short-rules.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-rules.spec.ts`:

```ts
import { RulesInput, checkScriptRules, estimateSpeechSec, numbersIn } from './short-rules';
import { ShortScript } from './shorts.types';

const paragraphs = [
  { n: 1, text: 'Залог возвращается в течение 7 дней после выезда.' },
  { n: 2, text: 'Опасная фраза: «залог не возвращается при досрочном выезде».' },
  { n: 3, text: 'Нормальный износ не является повреждением — впишите это в договор.' },
];

function script(over: Partial<ShortScript> = {}): ShortScript {
  return {
    hook: 'Хозяин может оставить залог себе?',
    hookBox: 2,
    voice: 'madirus',
    speed: 1.1,
    lines: [
      { id: 'h', scene: 'hook', text: 'Хозяин может оставить залог себе?' },
      { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Меня спросили, как снять квартиру и не потерять залог при выезде.' },
      { id: 'a1', scene: 'answer', box: 2, text: 'Ищите в договоре опасную фразу: «залог не возвращается при досрочном выезде». Увидели — просите переписать этот пункт.' },
      { id: 'a2', scene: 'answer', box: 3, text: 'Впишите прямо: нормальный износ не является повреждением. Тогда за потёртый пол и выцветшие обои удержать деньги не получится.' },
      { id: 'a3', scene: 'answer', box: 1, text: 'И договоритесь о сроке: залог возвращается в течение 7 дней после выезда — так и запишите в договоре аренды.' },
      { id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' },
    ],
    final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' },
    ...over,
  };
}

const captions = {
  telegram: 'Юрист разобрал, как не потерять залог при аренде.',
  vk: 'Юрист разобрал, как не потерять залог при аренде.',
  youtube: { title: 'Как не потерять залог при аренде', description: 'Три пункта договора, которые сберегут залог.', tags: ['аренда', 'залог', 'юрист'] },
};

const input = (over: Partial<RulesInput> = {}): RulesInput => ({
  angle: 'uncomfortable',
  assistantName: 'Алексей',
  script: script(),
  captions,
  paragraphs,
  answerText: paragraphs.map((p) => p.text).join('\n'),
  assistantsCount: 18,
  ...over,
});

const withLine = (id: string, text: string): ShortScript => {
  const s = script();
  s.lines = s.lines.map((l) => (l.id === id ? { ...l, text } : l));
  if (id === 'h') s.hook = text;
  return s;
};

describe('checkScriptRules', () => {
  it('честный сценарий проходит без замечаний', () => {
    expect(checkScriptRules(input())).toEqual([]);
  });

  it('правило 1: числа, которого нет в ответе', () => {
    const s = withLine('a1', `${script().lines[2].text} Так делают 90 процентов хозяев.`);
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/правило 1: числа 90 нет в ответе/);
  });

  it('правило 1: число ассистентов и подарок новичку называть можно', () => {
    const c = { ...captions, telegram: 'Тут 18 ассистентов, новичку — 25 000 токенов.' };
    expect(checkScriptRules(input({ captions: c }))).toEqual([]);
  });

  it.each([
    ['правила 2 и 7', 'Лучше, чем ChatGPT.'],
    ['правило 3', 'Всё анонимно.'],
    ['правило 4', 'Найдите вторую половинку.'],
    ['правило 5', 'Наши агенты помогут.'],
    ['правило 6', 'Попробуйте бесплатно.'],
    ['правило 7', 'Юля тоже так советовала.'],
    ['правило 11', 'Как санкции влияют на аренду.'],
    ['правило 12', 'Иначе вы умрёте от стресса.'],
    ['правило 13', 'Квартиры на Авито.'],
    ['правило 14', 'Только идиот подпишет такое.'],
    ['правило 14', 'Смешно смотреть на тех, кто до сих пор не пользуется ассистентами.'],
    ['правило 15', 'Как не платить налоги с аренды.'],
  ])('%s: «%s»', (rule, phrase) => {
    const c = { ...captions, telegram: `${captions.telegram} ${phrase}` };
    expect(checkScriptRules(input({ captions: c })).join('\n')).toContain(rule);
  });

  it('стоп-слова не цепляют похожие слова: агентство, сбережения, трамплин, богатый', () => {
    const c = { ...captions, telegram: `${captions.telegram} Без агентства, сбережения целы, трамплин для богатых.` };
    expect(checkScriptRules(input({ captions: c }))).toEqual([]);
  });

  it('правило 8: реплика ответа без опоры на снятый абзац', () => {
    const s = script();
    s.lines = s.lines.map((l) => (l.id === 'a1' ? { ...l, box: 9 } : l));
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/правило 8: реплика a1/);
  });

  it('правило 9: зацепка утверждает чувство зрителя', () => {
    expect(checkScriptRules(input({ script: withLine('h', 'Вы боитесь потерять залог') })).join('\n')).toMatch(/правило 9/);
  });

  it('правило 9: тот же страх вопросом — можно', () => {
    expect(checkScriptRules(input({ script: withLine('h', 'Боитесь потерять залог?') }))).toEqual([]);
  });

  it('правило 10: у провокационной зацепки обязательна опора', () => {
    expect(checkScriptRules(input({ script: script({ hookBox: undefined }) })).join('\n')).toMatch(/правило 10: .*hookBox/);
    expect(checkScriptRules(input({ angle: 'calm', script: script({ hookBox: undefined }) }))).toEqual([]);
    expect(checkScriptRules(input({ script: script({ hookBox: 7 }) })).join('\n')).toMatch(/hookBox 7/);
  });

  it('правило 12: здоровье — только спокойной подачей', () => {
    expect(checkScriptRules(input({ assistantName: 'Полина' })).join('\n')).toMatch(/правило 12: темы здоровья/);
    expect(checkScriptRules(input({ assistantName: 'Полина', angle: 'calm' }))).toEqual([]);
  });

  it('зацепка длиннее восьми слов', () => {
    const s = withLine('h', 'раз два три четыре пять шесть семь восемь девять');
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/длиннее 8 слов/);
  });

  it('название сервиса в репликах — только в финале', () => {
    const s = withLine('q', `${script().lines[1].text} Это Линкеон.`);
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/только в финале/);
  });

  it('длина: короче 32 с и длиннее 55 с', () => {
    const short = script();
    short.lines = short.lines
      .filter((l) => l.id !== 'a3')
      .map((l) => (l.scene === 'answer' ? { ...l, text: 'Коротко.' } : l));
    expect(checkScriptRules(input({ script: short })).join('\n')).toMatch(/добавь реплику/);
    const long = script();
    long.lines = long.lines.map((l) => (l.scene === 'answer' ? { ...l, text: l.text.repeat(3) } : l));
    expect(checkScriptRules(input({ script: long })).join('\n')).toMatch(/сократи реплики/);
  });

  it('реплик ответа — от двух до четырёх', () => {
    const s = script();
    s.lines = s.lines.filter((l) => l.id !== 'a2' && l.id !== 'a3');
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/реплик ответа 1/);
  });
});

describe('numbersIn и estimateSpeechSec', () => {
  it('числа с пробелами тысяч и десятичные — одной записью', () => {
    expect(numbersIn('залог 25 000 ₽ за 1,5 месяца и 7 дней')).toEqual(['25000', '1.5', '7']);
  });

  it('образец укладывается в коридор оценки', () => {
    const sec = estimateSpeechSec(script());
    expect(sec).toBeGreaterThan(32);
    expect(sec).toBeLessThan(55);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-rules.spec.ts
git -C "$WT" commit -m "test(shorts): правила текста роликов (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-rules.spec.ts"`
Expected: FAIL — `Cannot find module './short-rules'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-rules.ts`:

```ts
import { isHealthAssistant } from './short-assistants';
import { PROVOCATIVE_ANGLES, ShortAngle, ShortParagraph, ShortScript } from './shorts.types';

/**
 * Проверка сценария до отправки владельцу (спека, «Правила текста»).
 *
 * Стоп-слова — страховка от явного: главное держат промпт сценариста и
 * одобрение владельца. Каждое правило — отдельная строка с номером, чтобы
 * сценарист при переписке знал, что именно исправлять.
 */

/** Подписи от сценариста — до того, как код допишет ссылки. */
export interface WriterCaptions {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

export interface RulesInput {
  angle: ShortAngle;
  assistantName: string;
  script: ShortScript;
  captions: WriterCaptions;
  paragraphs: ShortParagraph[];
  answerText: string;
  assistantsCount: number;
}

/**
 * Скорость речи при темпе 1.1, замер на ролике-образце: 619 знаков реплик
 * прозвучали за 42,5 с. Оценка нужна, чтобы сценарист поправил длину до
 * озвучки; окончательно длину проверяет таймлайн студии.
 */
export const CHARS_PER_SECOND = 14.5;
/** Коридор оценки уже, чем 30–60 с у студии: запас на погрешность оценки. */
export const MIN_ESTIMATED_SEC = 32;
export const MAX_ESTIMATED_SEC = 55;
export const MAX_HOOK_WORDS = 8;
export const MIN_ANSWER_LINES = 2;
export const MAX_ANSWER_LINES = 4;
/** Подарок новичку можно называть, хотя в ответе ассистента этого числа нет (правило 6). */
export const WELCOME_GIFT_TOKENS = 25000;
const GAP_SEC = 0.25;
const MIN_HOOK_SEC = 2;

const chars = (s: string): number => Array.from(String(s ?? '')).length;

export function estimateSpeechSec(script: ShortScript): number {
  return script.lines.reduce((sum, l) => {
    const sec = chars(l.text) / CHARS_PER_SECOND + GAP_SEC;
    return sum + (l.scene === 'hook' ? Math.max(MIN_HOOK_SEC, sec) : sec);
  }, 0);
}

/** Числа текста одной записью: «25 000» → «25000», «1,5» → «1.5». */
export function numbersIn(text: string): string[] {
  return (String(text ?? '').match(/\d+(?:\s\d{3})*(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/\s/g, '').replace(',', '.'));
}

interface TextRule {
  pattern: RegExp;
  message: (hit: string) => string;
}

// Где нужно, слово ограничено: (^|[^\p{L}]) перед ним и (?![\p{L}]) после —
// иначе «сбер» ловил бы «сбережения», а «трамп» — «трамплин».
const TEXT_RULES: TextRule[] = [
  {
    pattern: /\b(chat\s*gpt|gpt-?\d+|openai|anthropic|claude|gemini|gigachat|yandex\s*gpt|deepseek|perplexity|copilot|midjourney|kling|veo|sora|llama|mistral|qwen|grok)\b/i,
    message: (hit) => `правила 2 и 7: названы модель, провайдер или конкурент («${hit}»)`,
  },
  {
    pattern: /(^|[^\p{L}])(гигачат\S*|чат\s*гпт|алис[аеуы])(?![\p{L}])/iu,
    message: (hit) => `правила 2 и 7: названы модель, провайдер или конкурент («${hit}»)`,
  },
  {
    pattern: /(анонимн|никуда не (уход|переда)|не переда[её]м|не передаются третьим)/iu,
    message: () => 'правило 3: «анонимно» и «данные никуда не уходят» не пишем',
  },
  {
    pattern: /(знакомств|дейтинг|(^|[^\p{L}])свидани(е|ю|ем|ях)(?![\p{L}])|втор(ая|ую|ой) половинк|найти пару)/iu,
    message: () => 'правило 4: поиск единомышленников — не знакомства и не дейтинг',
  },
  {
    pattern: /(^|[^\p{L}])агент(а|у|ом|е|ы|ов|ам|ами|ах)?(?![\p{L}])/iu,
    message: () => 'правило 5: «ассистент», а не «агент»',
  },
  {
    pattern: /бесплатн/iu,
    message: () => 'правило 6: стартовый подарок — «25 000 токенов», а не «бесплатно»',
  },
  {
    pattern: /(^|[^\p{L}])(юл[яиюе]|юлей)(?![\p{L}])/iu,
    message: () => 'правило 7: Юлю не упоминаем',
  },
  {
    pattern: /((тысяч|миллион|сотн)\S*\s+(пользовател|клиент|людей уже|человек уже)|наш\S* пользовател|отзыв\S*\s+(наших\s+|довольных\s+)?(пользовател|клиент))/iu,
    message: () => 'правило 1: число пользователей и отзывы не называем',
  },
  {
    pattern: /(^|[^\p{L}])(путин\S*|зеленск\S*|байден\S*|трамп(а|у|ом|е)?|госдум\S*|депутат\S*|санкци\S*|мобилизац\S*|митинг\S*|оппозиц\S*|религи\S*|церк(овь|ви|овн\S*)|ислам\S*|мусульм\S*|христиан\S*|православ\S*|иуде\S*|будди\S*|бог(а|у|ом|е)?|войн(а|е|у|ы|ой|ам|ами|ах)?|выбор(ы|ов|ах|ам))(?![\p{L}])/iu,
    message: (hit) => `правило 11: без политики и религии («${hit}»)`,
  },
  {
    pattern: /(умр[её]те|умр[её]шь|смерт|погибн|инфаркт|инсульт|опасно для жизни)/iu,
    message: () => 'правило 12: без запугивания здоровьем',
  },
  {
    pattern: /(^|[^\p{L}])(сбер(банк\S*|а|е|у|ом)?|тинькофф?\S*|т-банк\S*|втб|альфа-банк\S*|газпром\S*|авито|циан(а|е|у|ом)?|озон(а|е|у|ом)?|ozon|wildberries|вайлдберриз|яндекс\S*|google|гугл\S*|apple|samsung|макдоналдс|starbucks|старбакс)(?![\p{L}])/iu,
    message: (hit) => `правило 13: названа компания или бренд («${hit}»)`,
  },
  {
    pattern: /(^|[^\p{L}])(бля|хуй|хуё|хуе|пизд|ебан|ёбан|ебат|сук[аи](?![\p{L}])|мудак|дебил|идиот|придур|лох(и|ов|ам)?(?![\p{L}])|тупиц)/iu,
    message: () => 'правило 14: без брани и оскорблений',
  },
  {
    pattern: /(кто|которые)\s+(ещё\s+|еще\s+|до сих пор\s+)?не\s+(пользу|знает о|слышал)/iu,
    message: () => 'правило 14: без насмешек над теми, кто не пользуется сервисом',
  },
  {
    pattern: /(не платить налог|уйти от налог|уклон\S* от (уплаты\s+)?налог|обойти закон|скрыть доход|зарплат\S* в конверте|сер(ую|ая) зарплат|выселить[^.!?]{0,30}без суда|обмануть (налогов|банк|суд|пристав))/iu,
    message: () => 'правило 15: не подталкиваем к нарушению закона',
  },
];

/** Утверждение о чувствах зрителя (правило 9). Вопросом — можно. */
const FEELING = /(^|[^\p{L}])(боитесь|устали|переживаете|злитесь|мечтаете|чувствуете|сомневаетесь|волнуетесь|стесняетесь|ненавидите|вам\s+(страшно|стыдно|тревожно|обидно|надоело|одиноко))(?![\p{L}])/iu;
const BRAND_SPOKEN = /linkeon|линкеон/iu;
const isQuestion = (s: string): boolean => /\?["'»”)\s]*$/.test(s.trim());

export function checkScriptRules(i: RulesInput): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    if (!out.includes(m)) out.push(m);
  };
  const s = i.script;
  const known = new Set(i.paragraphs.map((p) => p.n));
  const scene = (name: string) => s.lines.filter((l) => l.scene === name);

  // Раскадровка: зацепка → вопрос → ответ → финал.
  const hook = String(s.hook ?? '').trim();
  if (!hook) add('нет зацепки');
  else if (hook.split(/\s+/).length > MAX_HOOK_WORDS) add(`зацепка длиннее ${MAX_HOOK_WORDS} слов`);
  const ORDER = ['hook', 'question', 'answer', 'final'];
  let at = 0;
  for (const l of s.lines) {
    const k = ORDER.indexOf(l.scene);
    if (k < at) {
      add(`реплика ${l.id}: сцены идут не по порядку зацепка → вопрос → ответ → финал`);
      break;
    }
    at = k;
  }
  const hooks = scene('hook');
  if (hooks.length !== 1) add('зацепка — ровно одна реплика');
  else if (hooks[0].text.trim() !== hook) add('текст реплики зацепки должен совпадать с зацепкой');
  if (!scene('question').length) add('нет реплики вопроса');
  const answers = scene('answer');
  if (answers.length < MIN_ANSWER_LINES || answers.length > MAX_ANSWER_LINES) {
    add(`реплик ответа ${answers.length} — нужно ${MIN_ANSWER_LINES}–${MAX_ANSWER_LINES}`);
  }
  for (const l of answers) {
    if (l.box === undefined || l.box === null || !known.has(l.box)) {
      add(`правило 8: реплика ${l.id} не опирается на снятый абзац (box ${l.box ?? 'не указан'})`);
    }
  }
  for (const l of s.lines) {
    if (l.scene !== 'answer' && l.box !== undefined && l.box !== null) add(`реплика ${l.id} сцены ${l.scene} не должна ссылаться на абзац`);
  }
  if (scene('final').length !== 1) add('финал — ровно одна реплика');

  // Подача.
  const provocative = PROVOCATIVE_ANGLES.includes(i.angle);
  if (s.hookBox === undefined || s.hookBox === null) {
    if (provocative) add('правило 10: у провокационной зацепки нет опоры — укажи hookBox');
  } else if (!known.has(s.hookBox)) {
    add(`правило 10: hookBox ${s.hookBox} — такого абзаца в ответе нет`);
  }
  if (hook && !isQuestion(hook) && FEELING.test(hook)) {
    add('правило 9: зацепка утверждает за зрителя, что он чувствует, — спроси или скажи факт из ответа');
  }
  if (provocative && isHealthAssistant(i.assistantName)) add('правило 12: темы здоровья — только в спокойной подаче');

  // Длина по оценке.
  const est = estimateSpeechSec(s);
  if (est < MIN_ESTIMATED_SEC) {
    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${MIN_ESTIMATED_SEC}–${MAX_ESTIMATED_SEC} с: добавь реплику или перескажи абзац подробнее`);
  }
  if (est > MAX_ESTIMATED_SEC) {
    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${MIN_ESTIMATED_SEC}–${MAX_ESTIMATED_SEC} с: сократи реплики`);
  }

  // Тексты сценариста. Финал пишет код, его здесь нет.
  const spoken = s.lines.filter((l) => l.scene !== 'final').map((l) => l.text);
  if (spoken.some((t) => BRAND_SPOKEN.test(t))) add('название сервиса звучит только в финале — убери его из реплик');
  const c = i.captions;
  const texts = [...spoken, c.telegram, c.vk, c.youtube.title, c.youtube.description, (c.youtube.tags ?? []).join(' ')];
  for (const t of texts) {
    for (const r of TEXT_RULES) {
      const m = String(t ?? '').match(r.pattern);
      if (m) add(r.message(m[0].replace(/^[^\p{L}\p{N}]+/u, '').trim()));
    }
  }
  const allowed = new Set([...numbersIn(i.answerText), String(i.assistantsCount), String(WELCOME_GIFT_TOKENS)]);
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      if (!allowed.has(n)) add(`правило 1: числа ${n} нет в ответе ассистента`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-rules.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

Если «честный сценарий» вдруг ловит замечание — это ошибка стоп-слова (ложное срабатывание), а не повод менять текст теста: сузить шаблон словесными границами, как у остальных.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-rules.ts
git -C "$WT" commit -m "feat(shorts): проверка сценария — раскадровка, подача и правила 1–15

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Разбор ответов режиссёра и сценариста

Релей иногда оборачивает JSON в забор или добавляет вежливую обвязку, как у редактора блога. Разбираем терпимо, а пустые и кривые поля считаем ошибкой. Ошибка уходит в `last_error` вместе с началом ответа: по ней видно, что модель прислала вместо JSON.

**Files:**
- Create: `src/shorts/short-parse.ts`
- Test: `src/shorts/short-parse.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-parse.spec.ts`:

````ts
import { extractJsonObject, parseDirectorReply, parseWriterReply } from './short-parse';

describe('extractJsonObject', () => {
  it('берёт объект из забора и из обвязки', () => {
    expect(extractJsonObject('Вот:\n```json\n{"a":1}\n```', 'x')).toEqual({ a: 1 });
    expect(extractJsonObject('Конечно! {"a":2} Удачи', 'x')).toEqual({ a: 2 });
  });

  it('без объекта — ошибка с началом ответа', () => {
    expect(() => extractJsonObject('Извините, не могу', 'режиссёр')).toThrow(/режиссёр: не нашёл JSON.*Извините, не могу/);
    expect(() => extractJsonObject('[1,2]', 'x')).toThrow(/не нашёл JSON/);
    expect(() => extractJsonObject('', 'x')).toThrow(/пустой ответ/);
  });
});

describe('parseDirectorReply', () => {
  const ids = new Set([10, 22]);
  const free = { assistantIds: ids, fixedAssistantId: null };
  const ok = {
    assistantId: 10,
    question: 'Хозяин квартиры не возвращает залог — что делать?',
    followups: ['Москва, договор на 11 месяцев'],
    title: 'Залог при аренде',
  };

  it('нормальный ответ', () => {
    expect(parseDirectorReply(JSON.stringify(ok), free)).toEqual(ok);
  });

  it('ассистент не из списка и не тот, что задан темой', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, assistantId: 5 }), free)).toThrow(/ассистента 5 нет/);
    expect(() => parseDirectorReply(JSON.stringify(ok), { assistantIds: ids, fixedAssistantId: 22 })).toThrow(/задана для 22/);
  });

  it('длина вопроса и персональные данные', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: 'Коротко?' }), free)).toThrow(/длина вопроса 8/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: 'я'.repeat(451) }), free)).toThrow(/длина вопроса 451/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: `${ok.question} Телефон +7 000 000-00-00` }), free)).toThrow(/персональные данные/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: `${ok.question} Пишите на ivan@example.com` }), free)).toThrow(/персональные данные/);
  });

  it('без уточнения на встречный вопрос и без названия — ошибка', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, followups: [] }), free)).toThrow(/уточнения/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, title: '' }), free)).toThrow(/названия/);
  });
});

describe('parseWriterReply', () => {
  const w = {
    hook: 'Хозяин может оставить залог себе?',
    hookBox: 2,
    question: 'Я Алексей, юрист.',
    lines: [{ box: 2, text: 'Первая.' }, { box: 3, text: 'Вторая.' }],
    captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'YT', description: 'D', tags: ['аренда'] } },
  };

  it('нормальный ответ', () => {
    const r = parseWriterReply(JSON.stringify(w));
    expect(r.needsRecapture).toBe(false);
    expect(r.hookBox).toBe(2);
    expect(r.lines).toEqual(w.lines);
    expect(r.captions.youtube.tags).toEqual(['аренда']);
  });

  it('hookBox пустой — null; vk без текста — как telegram', () => {
    const r = parseWriterReply(JSON.stringify({ ...w, hookBox: null, captions: { ...w.captions, vk: '' } }));
    expect(r.hookBox).toBeNull();
    expect(r.captions.vk).toBe('TG');
  });

  it('просьба переснять — только с причиной', () => {
    expect(parseWriterReply('{"needsRecapture": true, "reason": "нужен вопрос про субаренду"}'))
      .toMatchObject({ needsRecapture: true, reason: 'нужен вопрос про субаренду' });
    expect(() => parseWriterReply('{"needsRecapture": true}')).toThrow(/не объяснил/);
  });

  it('реплика без номера абзаца — ошибка', () => {
    expect(() => parseWriterReply(JSON.stringify({ ...w, lines: [{ text: 'без номера' }] }))).toThrow(/box/);
  });

  it('нет зацепки или заголовка YouTube — ошибка', () => {
    expect(() => parseWriterReply(JSON.stringify({ ...w, hook: '' }))).toThrow(/зацепк/);
    expect(() => parseWriterReply(JSON.stringify({ ...w, captions: { ...w.captions, youtube: { ...w.captions.youtube, title: '' } } }))).toThrow(/YouTube/);
  });
});
````

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-parse.spec.ts
git -C "$WT" commit -m "test(shorts): разбор ответов режиссёра и сценариста (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-parse.spec.ts"`
Expected: FAIL — `Cannot find module './short-parse'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-parse.ts`:

```ts
/**
 * Разбор ответов режиссёра и сценариста. Ошибки уходят в `last_error` ролика
 * и в личку владельцу, поэтому несут начало ответа: без него неясно, что
 * модель прислала вместо JSON — переспросила, извинилась или оборвалась.
 */

/** Сколько символов сырого ответа кладём в ошибку — как RAW_SNIPPET_CHARS блога. */
export const RAW_SNIPPET_CHARS = 300;
export const MIN_QUESTION_CHARS = 20;
/**
 * Пузырь вопроса должен целиком влезть над полем ввода в кадре 360×640
 * (studio/src/capture/chat-scene.ts падает на question-hidden). 450 знаков —
 * около 13 строк пузыря.
 */
export const MAX_QUESTION_CHARS = 450;
const MAX_FOLLOWUP_CHARS = 300;
const MAX_TITLE_CHARS = 80;

/** Телефон и почта в кадр не идут: вопрос задаётся на демо-аккаунте и попадает в ролик. */
const PII = [/\+?\d[\d\s()-]{9,}\d/, /[\w.+-]+@[\w-]+\.[\w.]+/];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const len = (s: string): number => Array.from(s).length;

export function rawSnippet(text: string): string {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length <= RAW_SNIPPET_CHARS ? chars.join('') : `${chars.slice(0, RAW_SNIPPET_CHARS).join('')}…`;
}

function sliceOuterObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start < 0 || end <= start ? null : text.slice(start, end + 1);
}

/** Объект JSON из ответа релея: в заборе с json или между первой { и последней }. */
export function extractJsonObject(raw: string, who: string): Record<string, any> {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error(`${who}: пустой ответ`);
  const fenced = text.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/i);
  const candidate = fenced ? fenced[1].trim() : sliceOuterObject(text);
  let parsed: any = null;
  if (candidate) {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${who}: не нашёл JSON в ответе; начало ответа: «${rawSnippet(text)}»`);
  }
  return parsed;
}

export interface DirectorReply {
  assistantId: number;
  question: string;
  followups: string[];
  title: string;
}

export function parseDirectorReply(
  raw: string,
  ctx: { assistantIds: ReadonlySet<number>; fixedAssistantId: number | null },
): DirectorReply {
  const o = extractJsonObject(raw, 'режиссёр');
  const assistantId = Number(o.assistantId);
  if (!Number.isInteger(assistantId) || !ctx.assistantIds.has(assistantId)) {
    throw new Error(`режиссёр: ассистента ${o.assistantId} нет среди активных`);
  }
  if (ctx.fixedAssistantId && assistantId !== ctx.fixedAssistantId) {
    throw new Error(`режиссёр: выбрал ассистента ${assistantId}, а тема задана для ${ctx.fixedAssistantId}`);
  }
  const question = str(o.question);
  const n = len(question);
  if (n < MIN_QUESTION_CHARS || n > MAX_QUESTION_CHARS) {
    throw new Error(`режиссёр: длина вопроса ${n} — нужно ${MIN_QUESTION_CHARS}–${MAX_QUESTION_CHARS} знаков`);
  }
  if (PII.some((re) => re.test(question))) {
    throw new Error('режиссёр: в вопросе телефон или почта — персональные данные в кадр не идут');
  }
  const followups = Array.isArray(o.followups) ? o.followups.map(str).filter(Boolean).slice(0, 2) : [];
  if (!followups.length) throw new Error('режиссёр: нет заготовленного уточнения на встречный вопрос');
  if (followups.some((f) => len(f) > MAX_FOLLOWUP_CHARS || PII.some((re) => re.test(f)))) {
    throw new Error(`режиссёр: уточнение длиннее ${MAX_FOLLOWUP_CHARS} знаков или с персональными данными`);
  }
  const title = str(o.title);
  if (len(title) < 3) throw new Error('режиссёр: нет рабочего названия ролика');
  return { assistantId, question, followups, title: Array.from(title).slice(0, MAX_TITLE_CHARS).join('') };
}

export interface WriterReply {
  needsRecapture: boolean;
  reason: string;
  hook: string;
  hookBox: number | null;
  question: string;
  lines: Array<{ box: number; text: string }>;
  captions: { telegram: string; vk: string; youtube: { title: string; description: string; tags: string[] } };
}

const EMPTY_CAPTIONS: WriterReply['captions'] = { telegram: '', vk: '', youtube: { title: '', description: '', tags: [] } };

export function parseWriterReply(raw: string): WriterReply {
  const o = extractJsonObject(raw, 'сценарист');
  if (o.needsRecapture === true) {
    const reason = str(o.reason);
    if (!reason) throw new Error('сценарист: просит переснять, но не объяснил почему');
    return { needsRecapture: true, reason, hook: '', hookBox: null, question: '', lines: [], captions: EMPTY_CAPTIONS };
  }
  const hook = str(o.hook);
  if (!hook) throw new Error('сценарист: нет зацепки');
  const question = str(o.question);
  if (!question) throw new Error('сценарист: нет реплики вопроса');
  const lines = Array.isArray(o.lines) ? o.lines.map((l: any) => ({ box: Number(l?.box), text: str(l?.text) })) : [];
  if (!lines.length || lines.some((l) => !Number.isInteger(l.box) || !l.text)) {
    throw new Error('сценарист: реплики ответа — массив {box, text} с номером абзаца и текстом');
  }
  const rawHookBox = o.hookBox;
  const hookBox = rawHookBox === null || rawHookBox === undefined || rawHookBox === '' ? null : Number(rawHookBox);
  if (hookBox !== null && !Number.isInteger(hookBox)) throw new Error('сценарист: hookBox — номер абзаца или null');
  const c = o.captions ?? {};
  const yt = c.youtube ?? {};
  const captions = {
    telegram: str(c.telegram),
    vk: str(c.vk) || str(c.telegram),
    youtube: {
      title: str(yt.title),
      description: str(yt.description),
      tags: Array.isArray(yt.tags) ? yt.tags.map(str).filter(Boolean) : [],
    },
  };
  if (!captions.telegram) throw new Error('сценарист: нет подписи для Telegram');
  if (!captions.youtube.title) throw new Error('сценарист: нет заголовка для YouTube');
  return { needsRecapture: false, reason: '', hook, hookBox, question, lines, captions };
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-parse.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-parse.ts
git -C "$WT" commit -m "feat(shorts): разбор ответов режиссёра и сценариста

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Кнопки, команда `/short` и ссылка YouTube

**Files:**
- Create: `src/shorts/short-callback.ts`
- Test: `src/shorts/short-callback.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-callback.spec.ts`:

```ts
import { buildReviewKeyboard, buildYoutubeKeyboard, parseShortCallback, parseYoutubeUrl, shortCommandText } from './short-callback';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';

describe('кнопки ролика', () => {
  it('разбор: действие и id', () => {
    expect(parseShortCallback(`short:ok:${ID}`)).toEqual({ action: 'ok', shortId: ID });
    expect(parseShortCallback(`short:yt:${ID}`)).toEqual({ action: 'yt', shortId: ID });
  });

  it('чужие и кривые — null', () => {
    expect(parseShortCallback(`blog:ok:${ID}`)).toBeNull();
    expect(parseShortCallback(`short:boom:${ID}`)).toBeNull();
    expect(parseShortCallback('short:ok:')).toBeNull();
    expect(parseShortCallback('short:ok:not-a-uuid')).toBeNull();
  });

  it('два ряда по две кнопки, callback_data не длиннее 64 байт', () => {
    const kb = buildReviewKeyboard(ID).inline_keyboard;
    expect(kb.map((row) => row.length)).toEqual([2, 2]);
    expect(kb.flat().map((b) => b.callback_data)).toEqual([`short:ok:${ID}`, `short:note:${ID}`, `short:redo:${ID}`, `short:no:${ID}`]);
    for (const b of kb.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(buildYoutubeKeyboard(ID).inline_keyboard[0][0].callback_data).toBe(`short:yt:${ID}`);
  });
});

describe('/short', () => {
  it('текст после команды — целиком, с переносами', () => {
    expect(shortCommandText('/short Как не потерять залог\nи договор')).toBe('Как не потерять залог\nи договор');
    expect(shortCommandText('/short@LinkeonTestBot тема')).toBe('тема');
    expect(shortCommandText('/short')).toBe('');
  });

  it('другие команды — не наши', () => {
    expect(shortCommandText('/shortcut x')).toBeNull();
    expect(shortCommandText('/case x')).toBeNull();
    expect(shortCommandText(undefined)).toBeNull();
  });
});

describe('ссылка YouTube', () => {
  it.each([
    ['https://youtube.com/shorts/AbCdEfGhIjK', 'AbCdEfGhIjK'],
    ['https://www.youtube.com/shorts/AbCdEfGhIjK?feature=share', 'AbCdEfGhIjK'],
    ['https://youtu.be/AbCdEfGhIjK', 'AbCdEfGhIjK'],
    ['https://m.youtube.com/watch?v=AbCdEfGhIjK&t=3', 'AbCdEfGhIjK'],
    ['Вот: https://youtube.com/shorts/AbCdEfGhIjK', 'AbCdEfGhIjK'],
  ])('%s', (text, id) => {
    expect(parseYoutubeUrl(text)).toEqual({ videoId: id, url: `https://youtube.com/shorts/${id}` });
  });

  it('не YouTube — null', () => {
    expect(parseYoutubeUrl('https://vk.com/clip-1_2')).toBeNull();
    expect(parseYoutubeUrl('ссылки нет')).toBeNull();
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-callback.spec.ts
git -C "$WT" commit -m "test(shorts): кнопки ролика, /short и ссылка YouTube (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-callback.spec.ts"`
Expected: FAIL — `Cannot find module './short-callback'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-callback.ts`:

```ts
export type ShortCallbackAction = 'ok' | 'note' | 'redo' | 'no' | 'yt';

const ACTIONS: ShortCallbackAction[] = ['ok', 'note', 'redo', 'no', 'yt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `short:<действие>:<id>` — ещё один префикс того же роутера кнопок, что у блога. */
export function parseShortCallback(data: string): { action: ShortCallbackAction; shortId: string } | null {
  const parts = String(data || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'short') return null;
  const action = parts[1] as ShortCallbackAction;
  if (!ACTIONS.includes(action) || !UUID.test(parts[2])) return null;
  return { action, shortId: parts[2] };
}

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

/** Два ряда по две, как у блога: четыре кнопки в ряд на телефоне сжимаются до обрезков подписей. */
export function buildReviewKeyboard(id: string): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `short:ok:${id}` },
        { text: '✍️ Замечание', callback_data: `short:note:${id}` },
      ],
      [
        { text: '🔄 Переснять', callback_data: `short:redo:${id}` },
        { text: '🗑 Отклонить', callback_data: `short:no:${id}` },
      ],
    ],
  };
}

export function buildYoutubeKeyboard(id: string): Keyboard {
  return { inline_keyboard: [[{ text: '▶️ Выложил на YouTube', callback_data: `short:yt:${id}` }]] };
}

/**
 * Текст после `/short` (и `/short@Бот`) — целиком, с переносами строк, как
 * `/case` у блога. null — это не `/short`; пустая строка — команда без темы.
 */
export function shortCommandText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\/short(?:@[A-Za-z0-9_]+)?(?=\s|$)([\s\S]*)$/);
  return m ? m[1].trim() : null;
}

const YOUTUBE: RegExp[] = [
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[?#/].*)?$/,
  /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#/].*)?$/,
  /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})(?:[&#].*)?$/,
];

/** Ссылка на ролик в YouTube из ответа владельца — в каноническом виде shorts/<id>. */
export function parseYoutubeUrl(text: unknown): { videoId: string; url: string } | null {
  const url = String(text ?? '').match(/https?:\/\/\S+/)?.[0];
  if (!url) return null;
  for (const re of YOUTUBE) {
    const m = url.match(re);
    if (m) return { videoId: m[1], url: `https://youtube.com/shorts/${m[1]}` };
  }
  return null;
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-callback.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-callback.ts
git -C "$WT" commit -m "feat(shorts): кнопки ролика, команда /short, ссылка YouTube

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Подписи площадок и подпись для владельца

Telegram молча обрезает подпись длиннее 1000 знаков: на этом уже обжигались с блогом. Поэтому режется текст сценариста, а не ссылка и не пометка «Озвучено синтезированным голосом».

**Files:**
- Create: `src/shorts/short-captions.ts`
- Test: `src/shorts/short-captions.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-captions.spec.ts`:

```ts
import { SYNTH_NOTE, TG_CAPTION_MAX, YT_TITLE_MAX, buildCaptions, buildReviewCaption, clip, tidyTags } from './short-captions';

const links = {
  telegram: 'https://my.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_x_0000',
  vk: 'https://my.linkeon.io/chat?assistant=10&utm_source=vk&utm_medium=short&utm_campaign=sh_x_0000',
  youtube: 'https://my.linkeon.io/chat?assistant=10&utm_source=youtube&utm_medium=short&utm_campaign=sh_x_0000',
};
const w = {
  telegram: 'Юрист разобрал договор.',
  vk: '',
  youtube: { title: 'Залог при аренде', description: 'Три пункта.', tags: ['#аренда', 'залог', 'залог', 'юрист'] },
};

describe('clip', () => {
  it('режет по символам и ставит многоточие', () => {
    expect(clip('короткий', 20)).toBe('короткий');
    expect(clip('абвгдеёжзи', 5)).toBe('абвг…');
    expect(Array.from(clip('😀'.repeat(10), 5))).toHaveLength(5);
  });
});

describe('buildCaptions', () => {
  it('ссылка и пометка о синтезированном голосе — у каждой площадки', () => {
    const c = buildCaptions(w, links);
    expect(c.telegram).toBe(`Юрист разобрал договор.\n\n${links.telegram}\n\n${SYNTH_NOTE}`);
    expect(c.vk.startsWith('Юрист разобрал договор.')).toBe(true);
    expect(c.vk).toContain(links.vk);
    expect(c.youtube.description).toBe(`Три пункта.\n\n${links.youtube}\n\n${SYNTH_NOTE}`);
    expect(c.youtube.tags).toEqual(['аренда', 'залог', 'юрист']);
  });

  it('подпись Telegram не длиннее 1000 — режется текст, а не ссылка', () => {
    const c = buildCaptions({ ...w, telegram: 'я'.repeat(2000) }, links);
    expect(Array.from(c.telegram).length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(c.telegram.endsWith(`${links.telegram}\n\n${SYNTH_NOTE}`)).toBe(true);
  });

  it('заголовок YouTube не длиннее 100', () => {
    const c = buildCaptions({ ...w, youtube: { ...w.youtube, title: 'я'.repeat(300) } }, links);
    expect(Array.from(c.youtube.title).length).toBeLessThanOrEqual(YT_TITLE_MAX);
  });
});

describe('tidyTags', () => {
  it('без решёток, повторов и сверх общего предела', () => {
    expect(tidyTags(['#a', 'a', ' b  c '])).toEqual(['a', 'b c']);
    expect(tidyTags(Array.from({ length: 100 }, (_, i) => `тег${i}`)).join(',').length).toBeLessThanOrEqual(450);
  });
});

describe('buildReviewCaption', () => {
  const base = {
    stand: false,
    rubric: 'assistant' as const,
    angle: 'roast' as const,
    assistantName: 'Алексей',
    question: 'Проверьте договор',
    when: 'завтра в 18:00 МСК',
    captions: buildCaptions(w, links),
  };

  it('влезает в 1000 — одним сообщением со всеми подписями', () => {
    const r = buildReviewCaption(base);
    expect(r.extra).toBeNull();
    expect(r.caption).toContain('Рубрика: Ассистент за работой · подача: разнос');
    expect(r.caption).toContain('Выйдет: завтра в 18:00 МСК');
    expect(r.caption).toContain('YouTube — заголовок:');
  });

  it('не влезает — подписи вторым сообщением', () => {
    const r = buildReviewCaption({ ...base, captions: buildCaptions({ ...w, telegram: 'я'.repeat(900) }, links) });
    expect(Array.from(r.caption).length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(r.extra).toContain('Telegram:');
  });

  it('стенд помечен', () => {
    expect(buildReviewCaption({ ...base, stand: true }).caption.startsWith('[СТЕНД]')).toBe(true);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-captions.spec.ts
git -C "$WT" commit -m "test(shorts): подписи площадок и подпись для владельца (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-captions.spec.ts"`
Expected: FAIL — `Cannot find module './short-captions'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-captions.ts`:

```ts
import { LinkPlatform } from './short-links';
import { ANGLE_TITLES, RUBRIC_TITLES, ShortAngle, ShortCaptions, ShortRubric } from './shorts.types';

/** Telegram молча обрезает подпись длиннее — на этом обжигались с блогом. */
export const TG_CAPTION_MAX = 1000;
export const VK_TEXT_MAX = 2000;
export const YT_TITLE_MAX = 100;
export const YT_DESCRIPTION_MAX = 5000;
/** У YouTube предел тегов — 500 знаков вместе с разделителями; берём с запасом. */
export const YT_TAGS_TOTAL_MAX = 450;
export const YT_TAG_MAX = 30;
/** Пишем на всех площадках (спека, «Голос и музыка»). */
export const SYNTH_NOTE = 'Озвучено синтезированным голосом.';
export const STAND_MARK = '[СТЕНД] ';

/** По символам, а не по UTF-16: эмодзи на границе не распадается пополам. */
export function clip(text: string, max: number): string {
  const chars = Array.from(String(text ?? '').trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** Текст сценариста + хвост (ссылка, пометка) не длиннее max: режется текст, хвост цел. */
function withTail(body: string, tail: string, max: number): string {
  return `${clip(body, max - Array.from(tail).length)}${tail}`;
}

export function tidyTags(tags: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const raw of tags ?? []) {
    const tag = clip(String(raw ?? '').replace(/^#+/, '').replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim(), YT_TAG_MAX);
    if (!tag || out.includes(tag)) continue;
    const cost = Array.from(tag).length + 1;
    if (total + cost > YT_TAGS_TOTAL_MAX) break;
    out.push(tag);
    total += cost;
  }
  return out;
}

export interface WriterCaptionTexts {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

/** Подписи площадок: текст сценариста, ссылка с метками этой площадки, пометка о голосе. */
export function buildCaptions(w: WriterCaptionTexts, links: Record<LinkPlatform, string>): ShortCaptions {
  return {
    telegram: withTail(w.telegram, `\n\n${links.telegram}\n\n${SYNTH_NOTE}`, TG_CAPTION_MAX),
    vk: withTail(w.vk || w.telegram, `\n\n${links.vk}\n\n${SYNTH_NOTE}`, VK_TEXT_MAX),
    youtube: {
      title: clip(w.youtube.title, YT_TITLE_MAX),
      description: withTail(w.youtube.description, `\n\n${links.youtube}\n\n${SYNTH_NOTE}`, YT_DESCRIPTION_MAX),
      tags: tidyTags(w.youtube.tags),
    },
  };
}

export interface ReviewCaptionInput {
  stand: boolean;
  rubric: ShortRubric;
  angle: ShortAngle;
  assistantName: string;
  question: string;
  when: string;
  captions: ShortCaptions;
}

/**
 * Подпись видео владельцу: рубрика, подача, ассистент, вопрос, время выхода и
 * подписи площадок. Не влезают в 1000 знаков — подписи идут вторым сообщением.
 */
export function buildReviewCaption(i: ReviewCaptionInput): { caption: string; extra: string | null } {
  const head = [
    `${i.stand ? STAND_MARK : ''}🎬 Ролик на проверку`,
    `Рубрика: ${RUBRIC_TITLES[i.rubric]} · подача: ${ANGLE_TITLES[i.angle].toLowerCase()}`,
    `Ассистент: ${i.assistantName}`,
    `Вопрос: «${clip(i.question, 300)}»`,
    `Выйдет: ${i.when}`,
  ].join('\n');
  const texts = [
    `Telegram:\n${i.captions.telegram}`,
    `YouTube — заголовок:\n${i.captions.youtube.title}`,
    `YouTube — описание:\n${i.captions.youtube.description}`,
  ].join('\n\n');
  const full = `${head}\n\n${texts}`;
  if (Array.from(full).length <= TG_CAPTION_MAX) return { caption: full, extra: null };
  return { caption: head, extra: `Подписи к ролику\n\n${texts}` };
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-captions.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-captions.ts
git -C "$WT" commit -m "feat(shorts): подписи площадок с пределами длины и подпись для владельца

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Ответ сценариста → сценарий студии

Форма — та, что студия уже собирает (`studio/src/types.ts`, `Script`). Финальную реплику и число ассистентов ставит код. Темп 1.1 и голос финала alena — из принятого образца.

**Files:**
- Create: `src/shorts/short-script.ts`
- Test: `src/shorts/short-script.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-script.spec.ts`:

```ts
import { CASE_BADGE, SPEECH_SPEED, buildScript } from './short-script';

const reply = {
  hook: 'Снимаете квартиру? Как не потерять залог',
  hookBox: 11,
  question: 'Я Алексей, юрист. Меня спросили, что проверить в договоре аренды.',
  lines: [{ box: 11, text: 'Опасные фразы в договоре.' }, { box: 14, text: 'Нормальный износ.' }],
};

describe('buildScript', () => {
  it('реплики по сценам, финал и число ассистентов — от кода', () => {
    const s = buildScript(reply, { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' });
    expect(s.lines.map((l) => [l.id, l.scene, l.box ?? null])).toEqual([
      ['h', 'hook', null], ['q', 'question', null], ['a1', 'answer', 11], ['a2', 'answer', 14], ['f', 'final', null],
    ]);
    expect(s.lines[4]).toEqual({ id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' });
    expect(s).toMatchObject({ hook: reply.hook, hookBox: 11, voice: 'madirus', speed: SPEECH_SPEED, final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' } });
    expect(s.badge).toBeUndefined();
  });

  it('без опоры зацепки и без строки о специалисте — полей нет вовсе', () => {
    const s = buildScript({ ...reply, hookBox: null }, { voice: 'marina', narratorVoice: 'alena', assistantsCount: 18 });
    expect('hookBox' in s).toBe(false);
    expect(s.final).toEqual({ assistantsCount: 18 });
  });

  it('реальный кейс — с подписью в кадре вопроса', () => {
    const s = buildScript(reply, { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18, badge: CASE_BADGE });
    expect(s.badge).toBe('Реальная история, разговор повторён на демо-аккаунте');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-script.spec.ts
git -C "$WT" commit -m "test(shorts): сценарий студии из ответа сценариста (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-script.spec.ts"`
Expected: FAIL — `Cannot find module './short-script'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-script.ts`:

```ts
import { finalLine } from './short-numbers';
import { WriterReply } from './short-parse';
import { ShortScript, ShortScriptLine } from './shorts.types';

/** Темп принятого образца (владелец, 25.10.2026). */
export const SPEECH_SPEED = 1.1;

/** Подпись реального кейса в кадре вопроса (спека, «Рубрики»). */
export const CASE_BADGE = 'Реальная история, разговор повторён на демо-аккаунте';

export interface ScriptOptions {
  /** Голос ассистента — им звучат зацепка, вопрос и ответ. */
  voice: string;
  /** Голос Linkeon для финала (short_settings.narrator_voice). */
  narratorVoice: string;
  assistantsCount: number;
  disclaimer?: string;
  badge?: string;
}

/** Ответ сценариста → `Script` студии: id реплик h, q, a1…, f — как у образца. */
export function buildScript(reply: Pick<WriterReply, 'hook' | 'hookBox' | 'question' | 'lines'>, o: ScriptOptions): ShortScript {
  const lines: ShortScriptLine[] = [
    { id: 'h', scene: 'hook', text: reply.hook },
    { id: 'q', scene: 'question', text: reply.question },
    ...reply.lines.map((l, i): ShortScriptLine => ({ id: `a${i + 1}`, scene: 'answer', box: l.box, text: l.text })),
    { id: 'f', scene: 'final', voice: o.narratorVoice, text: finalLine(o.assistantsCount) },
  ];
  return {
    hook: reply.hook,
    ...(reply.hookBox !== null && reply.hookBox !== undefined ? { hookBox: reply.hookBox } : {}),
    ...(o.badge ? { badge: o.badge } : {}),
    voice: o.voice,
    speed: SPEECH_SPEED,
    lines,
    final: { assistantsCount: o.assistantsCount, ...(o.disclaimer ? { disclaimer: o.disclaimer } : {}) },
  };
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-script.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-script.ts
git -C "$WT" commit -m "feat(shorts): сценарий студии из ответа сценариста

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Одобрение в слот

Отличие от блога: у ролика в работе уже есть планируемый слот. Если он впереди и свободен, одобрение занимает его. Если слот прошёл или занят, ролик встаёт в ближайший свободный. Гонку двух одобрений держит уникальный индекс `uq_short_video_slot`, повтор при конфликте — как в `approveIntoFreeSlot` блога. Транзакция, блокировка держателей слотов и сама функция поиска свободного слота берутся из блога, а не копируются.

**Files:**
- Create: `src/shorts/short-slot-claim.ts`
- Test: `src/shorts/short-slot-claim.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-slot-claim.spec.ts`:

```ts
import { NoFreeSlotError } from '../blog/blog-slots';
import { SHORT_SLOT_INDEX, approveShortIntoSlot, chooseApprovalSlot } from './short-slot-claim';

const schedule = { slotDays: [2, 4, 6], slotHourMsk: 18 };
const NOW = new Date('2026-10-26T12:00:00.000Z'); // понедельник
const TUE = new Date('2026-10-27T15:00:00.000Z'); // вторник, 18:00 МСК
const THU = new Date('2026-10-29T15:00:00.000Z');
const conflict = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: SHORT_SLOT_INDEX });

describe('chooseApprovalSlot', () => {
  it('планируемый слот впереди и свободен — он', () => {
    expect(chooseApprovalSlot(NOW, THU, schedule, [])).toEqual(THU);
  });
  it('планируемый занят — ближайший свободный', () => {
    expect(chooseApprovalSlot(NOW, THU, schedule, [THU])).toEqual(TUE);
  });
  it('планируемый прошёл — ближайший свободный', () => {
    expect(chooseApprovalSlot(NOW, new Date('2026-10-25T15:00:00.000Z'), schedule, [])).toEqual(TUE);
  });
  it('без планируемого — ближайший свободный', () => {
    expect(chooseApprovalSlot(NOW, null, schedule, [TUE])).toEqual(THU);
  });
});

/** Соединение-заглушка: SELECT отдаёт строки по очереди, UPDATE — по сценарию. */
function fakePg(selects: Array<{ rows: any[] }>, updates: Array<() => any>) {
  const log: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      const verb = sql.trim().split(/\s+/)[0];
      log.push(verb);
      if (verb === 'SELECT') return selects.shift() ?? { rows: [] };
      if (verb === 'UPDATE') return (updates.shift() as () => any)();
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { pg: { getClient: async () => client }, log };
}

describe('approveShortIntoSlot', () => {
  it('проигрыш гонки — новый круг видит слот занятым и берёт следующий', async () => {
    const { pg, log } = fakePg(
      [{ rows: [] }, { rows: [{ slot_at: THU }] }],
      [() => { throw conflict(); }, () => ({ rowCount: 1 })],
    );
    expect(await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).toEqual({ slot: TUE, now: NOW });
    expect(log.filter((v) => v === 'ROLLBACK')).toHaveLength(1);
    expect(log.filter((v) => v === 'COMMIT')).toHaveLength(1);
  });

  it('ролик ушёл из pending_review — null', async () => {
    const { pg } = fakePg([{ rows: [] }], [() => ({ rowCount: 0 })]);
    expect(await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).toBeNull();
  });

  it('чужой конфликт новым слотом не лечится', async () => {
    const other = Object.assign(new Error('pk'), { code: '23505', constraint: 'short_video_pkey' });
    const { pg } = fakePg([{ rows: [] }], [() => { throw other; }]);
    await expect(approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).rejects.toThrow('pk');
  });

  it('пять проигрышей подряд — NoFreeSlotError', async () => {
    const { pg } = fakePg([], Array.from({ length: 5 }, () => () => { throw conflict(); }));
    await expect(approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).rejects.toBeInstanceOf(NoFreeSlotError);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-slot-claim.spec.ts
git -C "$WT" commit -m "test(shorts): одобрение ролика в слот (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-slot-claim.spec.ts"`
Expected: FAIL — `Cannot find module './short-slot-claim'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-slot-claim.ts`:

```ts
import { NoFreeSlotError, nextFreeSlotAfter } from '../blog/blog-slots';
import { ApprovedSlot, MAX_SLOT_ATTEMPTS, Schedule, SlotQueryable, TxSource, inTransaction } from '../blog/blog-slot-claim';
import { SLOT_HOLDING_STATUSES } from './shorts.types';

/** Имя частичного уникального индекса из 001_shorts.sql: гонку узнаём по нему, а не по одному коду 23505. */
export const SHORT_SLOT_INDEX = 'uq_short_video_slot';

export function isShortSlotConflict(e: any): boolean {
  return e?.code === '23505' && e?.constraint === SHORT_SLOT_INDEX;
}

/** Слоты, занятые одобренными роликами, строго после `after`. `lock` — только внутри транзакции. */
export async function takenSlots(pg: SlotQueryable, after: Date, { lock = false } = {}): Promise<Date[]> {
  const r = await pg.query(
    `SELECT slot_at FROM short_video
      WHERE status = ANY($1::text[]) AND slot_at > $2
      ORDER BY slot_at${lock ? ' FOR UPDATE' : ''}`,
    [SLOT_HOLDING_STATUSES, after.toISOString()],
  );
  return r.rows.filter((row) => row.slot_at).map((row) => new Date(row.slot_at));
}

/**
 * Слот одобрения: планируемый, если он ещё впереди и свободен, иначе
 * ближайший свободный по расписанию (спека, «Одобрение занимает слот»).
 */
export function chooseApprovalSlot(now: Date, planned: Date | null, schedule: Schedule, taken: Date[]): Date {
  const busy = new Set(taken.map((t) => t.getTime()));
  if (planned && planned.getTime() > now.getTime() && !busy.has(planned.getTime())) return planned;
  return nextFreeSlotAfter(now, schedule.slotDays, schedule.slotHourMsk, taken);
}

/**
 * Одобрить ролик в слот. Запись — только из `pending_review`: двойное
 * касание «Одобрить» — два обработчика, и второй не должен переставить ролик
 * на другой слот. `approved_at` отмечает, что ролик одобрял человек: только
 * такой можно вернуть в `approved` повтором публикации (`retryTarget`).
 *
 * @returns слот — или null, если ролик успел уйти из `pending_review`
 * @throws NoFreeSlotError — слот уводили MAX_SLOT_ATTEMPTS раз подряд
 */
export async function approveShortIntoSlot(
  pg: TxSource,
  id: string,
  planned: Date | null,
  schedule: Schedule,
  clock: () => Date = () => new Date(),
): Promise<ApprovedSlot | null> {
  for (let attempt = 1; attempt <= MAX_SLOT_ATTEMPTS; attempt++) {
    try {
      return await inTransaction(pg, async (tx) => {
        const now = clock();
        const slot = chooseApprovalSlot(now, planned, schedule, await takenSlots(tx, now, { lock: true }));
        const r = await tx.query(
          `UPDATE short_video SET status = 'approved', slot_at = $2, approved_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'pending_review'`,
          [id, slot.toISOString()],
        );
        return r.rowCount === 0 ? null : { slot, now };
      });
    } catch (e: any) {
      if (!isShortSlotConflict(e)) throw e;
      // Слот заняли между чтением и записью — новый круг прочтёт его занятым.
    }
  }
  throw new NoFreeSlotError(`слот ${MAX_SLOT_ATTEMPTS} раз подряд занимали одновременно с нами — попробуйте ещё раз`);
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-slot-claim.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-slot-claim.ts
git -C "$WT" commit -m "feat(shorts): одобрение в планируемый или ближайший свободный слот

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Захват этапа API и повтор с паузой

Режиссёр и сценарист ходят в релей, и это минуты. Этап забирается с арендой. Сбой не роняет ролик сразу: повтор через 1 и через 10 минут, затем `failed` и сообщение владельцу (спека, «Обработка отказов»). `StageFatalError` — сбой, который повтором не лечится. Например, правила текста не прошли после двух переписок.

**Files:**
- Create: `src/shorts/short-jobs.ts`
- Test: `src/shorts/short-jobs.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-jobs.spec.ts`:

```ts
import { STAGE_LEASE_MINUTES, StageFatalError, claimStage, stageFailed } from './short-jobs';

function pg(rows: any[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: 1 };
    }),
  };
}

const video = (attempts: number) => ({ id: 'v1', status: 'directing', attempts }) as any;

describe('claimStage', () => {
  it('берёт свободный по аренде ролик и считает попытку', async () => {
    const p = pg([{ id: 'v1', status: 'directing', attempts: 1, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't' }]);
    const got = await claimStage(p, 'directing');
    expect(got?.id).toBe('v1');
    expect(p.calls[0].sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(p.calls[0].sql).toMatch(/attempts = attempts \+ 1/);
    expect(p.calls[0].params).toEqual(['directing', STAGE_LEASE_MINUTES]);
  });

  it('нечего брать — null', async () => {
    expect(await claimStage(pg([]), 'writing')).toBeNull();
  });
});

describe('stageFailed', () => {
  it('первая неудача — повтор через минуту, вторая — через десять', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'режиссёр', new Error('релей молчит'))).toBe('retry');
    expect(p.calls[0].params).toEqual(['v1', 'directing', 60, 'режиссёр: релей молчит']);
    await stageFailed(p, video(2), 'режиссёр', new Error('релей молчит'));
    expect(p.calls[1].params[2]).toBe(600);
  });

  it('третья неудача — failed с этапом, сообщение владельцу ещё не ушло', async () => {
    const p = pg();
    expect(await stageFailed(p, video(3), 'режиссёр', new Error('релей молчит'))).toBe('failed');
    expect(p.calls[0].sql).toMatch(/status = 'failed', failed_from = \$2/);
    expect(p.calls[0].sql).toMatch(/failure_notified = false/);
    expect(p.calls[0].params).toEqual(['v1', 'directing', 'режиссёр: релей молчит']);
  });

  it('StageFatalError — сразу failed, без повторов', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'сценарист', new StageFatalError('правила не прошли'))).toBe('failed');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-jobs.spec.ts
git -C "$WT" commit -m "test(shorts): захват этапа и повтор с паузой (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-jobs.spec.ts"`
Expected: FAIL — `Cannot find module './short-jobs'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-jobs.ts`:

```ts
import { ShortVideo, rowToShort } from './shorts.types';

export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Этапы, которые ведёт сам API. Съёмку и сборку забирает студия (studio/src/worker/db.ts). */
export type ApiStage = 'directing' | 'writing';

/**
 * Аренда этапа. Сценарист — до трёх обращений к релею подряд (переписка по
 * правилам), каждое до 5 минут (таймаут BlogRelayClient). 20 минут хватает с
 * запасом, а упавший посреди работы процесс отдаст ролик через 20 минут.
 */
export const STAGE_LEASE_MINUTES = 20;
export const MAX_STAGE_ATTEMPTS = 3;
/** Паузы перед повторами: 1 и 10 минут (спека, «Обработка отказов»). */
export const STAGE_RETRY_DELAYS_SEC = [60, 600];

/** Сбой, который повтором не лечится: ролик сразу уходит в failed. */
export class StageFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageFatalError';
  }
}

/**
 * Взять один ролик этапа, свободный по аренде. Попытку считает захват, поэтому
 * счётчик переживает рестарт; переход на следующий этап его сбрасывает.
 */
export async function claimStage(pg: Queryable, status: ApiStage): Promise<ShortVideo | null> {
  const r = await pg.query(
    `UPDATE short_video
        SET lease_until = now() + make_interval(mins => $2), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM short_video
         WHERE status = $1 AND (lease_until IS NULL OR lease_until < now())
         ORDER BY slot_at NULLS LAST, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [status, STAGE_LEASE_MINUTES],
  );
  return r.rows[0] ? rowToShort(r.rows[0]) : null;
}

export type StageOutcome = 'retry' | 'failed';

/**
 * Сбой этапа. Пока попытки есть — ролик остаётся на этапе, а аренда
 * становится паузой до повтора. Попытки кончились или сбой фатальный —
 * `failed`, `failed_from` (с чего продолжит «Повторить»), и
 * `failure_notified = false`: владельцу напишет следующий тик.
 * Обе записи — с условием на статус: ролик могли отклонить, пока шёл этап.
 */
export async function stageFailed(pg: Queryable, v: ShortVideo, label: string, e: any): Promise<StageOutcome> {
  const message = `${label}: ${String(e?.message ?? e)}`.slice(0, 1000);
  if (!(e instanceof StageFatalError) && v.attempts < MAX_STAGE_ATTEMPTS) {
    const delay = STAGE_RETRY_DELAYS_SEC[Math.min(Math.max(v.attempts, 1), STAGE_RETRY_DELAYS_SEC.length) - 1];
    await pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(secs => $3), last_error = $4, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [v.id, v.status, delay, message],
    );
    return 'retry';
  }
  await pg.query(
    `UPDATE short_video SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3,
            failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2`,
    [v.id, v.status, message],
  );
  return 'failed';
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-jobs.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-jobs.ts
git -C "$WT" commit -m "feat(shorts): захват этапа API с арендой, повтор через 1 и 10 минут

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Настройки роликов

**Files:**
- Create: `src/shorts/shorts-settings.service.ts`
- Test: `src/shorts/shorts-settings.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-settings.service.spec.ts`:

```ts
import { SETTINGS_DEFAULTS, ShortsSettingsService, validateSettingsPatch } from './shorts-settings.service';

describe('ShortsSettingsService', () => {
  it('нет строки — значения по умолчанию', async () => {
    const svc = new ShortsSettingsService({ query: jest.fn(async () => ({ rows: [] })) } as any);
    expect(await svc.get()).toEqual(SETTINGS_DEFAULTS);
  });

  it('строка базы — числами и списками', async () => {
    const row = {
      slot_days: ['2', '4'], slot_hour_msk: '19', prepare_lead_hours: 12, min_answer_chars: 500,
      tg_channel_chat_id: '-1003290853538', platforms: ['telegram'], narrator_voice: 'jane',
    };
    const svc = new ShortsSettingsService({ query: jest.fn(async () => ({ rows: [row] })) } as any);
    expect(await svc.get()).toEqual({
      slotDays: [2, 4], slotHourMsk: 19, prepareLeadHours: 12, minAnswerChars: 500,
      tgChannelChatId: '-1003290853538', platforms: ['telegram'], narratorVoice: 'jane',
    });
  });

  it('правка пишет только переданные поля', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await new ShortsSettingsService({ query } as any).update({ slotHourMsk: 20, platforms: ['telegram'] });
    const [sql, args] = query.mock.calls[0] as any[];
    expect(sql).toBe('UPDATE short_settings SET slot_hour_msk = $1, platforms = $2, updated_at = now() WHERE id = 1');
    expect(args).toEqual([20, ['telegram']]);
  });
});

describe('validateSettingsPatch', () => {
  it('дни сортируются, корректное проходит', () => {
    expect(validateSettingsPatch({ slotDays: [6, 2, 4], slotHourMsk: 18, tgChannelChatId: '-1003290853538' }))
      .toEqual({ slotDays: [2, 4, 6], slotHourMsk: 18, tgChannelChatId: '-1003290853538' });
    expect(validateSettingsPatch({ tgChannelChatId: null })).toEqual({ tgChannelChatId: null });
  });

  it.each([
    [{ slotDays: [] }, /slotDays/],
    [{ slotDays: [8] }, /slotDays/],
    [{ slotDays: [2, 2] }, /slotDays/],
    [{ slotHourMsk: 24 }, /slotHourMsk/],
    [{ prepareLeadHours: 0 }, /prepareLeadHours/],
    [{ minAnswerChars: 50 }, /minAnswerChars/],
    [{ tgChannelChatId: '@linkeontest' }, /tgChannelChatId/],
    [{ platforms: ['vk'] }, /VK/],
    [{ platforms: [] }, /platforms/],
    [{ narratorVoice: 'nova' }, /narratorVoice/],
    [{ colour: 'red' }, /неизвестная настройка: colour/],
  ])('%j — ошибка', (body, message) => {
    expect(() => validateSettingsPatch(body)).toThrow(message);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-settings.service.spec.ts
git -C "$WT" commit -m "test(shorts): настройки роликов (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-settings.service.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-settings.service'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-settings.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { isValidVoice } from '../speech/voices';
import { ShortPlatform } from './shorts.types';

export interface ShortSettings {
  /** ISO-дни: 1 — понедельник … 7 — воскресенье. */
  slotDays: number[];
  slotHourMsk: number;
  /** За сколько часов до свободного слота крон запускает под него ролик. */
  prepareLeadHours: number;
  /** Ответ короче — съёмка повторяется (спека, «Съёмка», шаг 5). */
  minAnswerChars: number;
  tgChannelChatId: string | null;
  platforms: ShortPlatform[];
  /** Голос Linkeon в финале. */
  narratorVoice: string;
}

export const SETTINGS_DEFAULTS: ShortSettings = {
  slotDays: [2, 4, 6],
  slotHourMsk: 18,
  prepareLeadHours: 24,
  minAnswerChars: 400,
  tgChannelChatId: null,
  platforms: ['telegram', 'youtube'],
  narratorVoice: 'alena',
};

export type ShortSettingsPatch = Partial<ShortSettings>;

/** Площадки публикатора этого плана. VK подключается в плане 4. */
export const SUPPORTED_PLATFORMS: readonly ShortPlatform[] = ['telegram', 'youtube'];

const COLUMNS: Record<keyof ShortSettings, string> = {
  slotDays: 'slot_days',
  slotHourMsk: 'slot_hour_msk',
  prepareLeadHours: 'prepare_lead_hours',
  minAnswerChars: 'min_answer_chars',
  tgChannelChatId: 'tg_channel_chat_id',
  platforms: 'platforms',
  narratorVoice: 'narrator_voice',
};

const intIn = (v: any, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;

/**
 * Правка из админки. Незнакомое и кривое поле — ошибка с понятной причиной, а
 * не тихий пропуск: опечатка в имени поля иначе выглядела бы как «сохранено».
 */
export function validateSettingsPatch(body: any): ShortSettingsPatch {
  const b = body ?? {};
  for (const k of Object.keys(b)) {
    if (!(k in COLUMNS)) throw new Error(`неизвестная настройка: ${k}`);
  }
  const p: ShortSettingsPatch = {};
  if (b.slotDays !== undefined) {
    const d = b.slotDays;
    if (!Array.isArray(d) || !d.length || d.some((x: any) => !intIn(x, 1, 7)) || new Set(d).size !== d.length) {
      throw new Error('slotDays — непустой список дней недели 1–7 без повторов (1 — понедельник)');
    }
    p.slotDays = [...d].sort((x: number, y: number) => x - y);
  }
  if (b.slotHourMsk !== undefined) {
    if (!intIn(b.slotHourMsk, 0, 23)) throw new Error('slotHourMsk — час 0–23 по Москве');
    p.slotHourMsk = b.slotHourMsk;
  }
  if (b.prepareLeadHours !== undefined) {
    if (!intIn(b.prepareLeadHours, 1, 96)) throw new Error('prepareLeadHours — 1–96 часов');
    p.prepareLeadHours = b.prepareLeadHours;
  }
  if (b.minAnswerChars !== undefined) {
    if (!intIn(b.minAnswerChars, 100, 5000)) throw new Error('minAnswerChars — 100–5000 знаков');
    p.minAnswerChars = b.minAnswerChars;
  }
  if (b.tgChannelChatId !== undefined) {
    const v = b.tgChannelChatId;
    if (v !== null && !(typeof v === 'string' && /^-100\d{6,}$/.test(v))) {
      throw new Error('tgChannelChatId — числовой id канала вида -100… или null');
    }
    p.tgChannelChatId = v;
  }
  if (b.platforms !== undefined) {
    const list = b.platforms;
    if (list?.includes?.('vk')) throw new Error('VK подключается отдельно и пока не готов — оставьте telegram и youtube');
    if (!Array.isArray(list) || !list.length || list.some((x: any) => !SUPPORTED_PLATFORMS.includes(x)) || new Set(list).size !== list.length) {
      throw new Error(`platforms — непустой список из ${SUPPORTED_PLATFORMS.join(', ')} без повторов`);
    }
    p.platforms = list;
  }
  if (b.narratorVoice !== undefined) {
    if (!isValidVoice(b.narratorVoice, 'yandex')) throw new Error('narratorVoice — голос SpeechKit из каталога voices.ts');
    p.narratorVoice = b.narratorVoice;
  }
  return p;
}

@Injectable()
export class ShortsSettingsService {
  constructor(private readonly pg: PgService) {}

  async get(): Promise<ShortSettings> {
    const r = await this.pg.query(
      `SELECT slot_days, slot_hour_msk, prepare_lead_hours, min_answer_chars,
              tg_channel_chat_id, platforms, narrator_voice
         FROM short_settings WHERE id = 1`,
    );
    const row = r.rows[0];
    if (!row) return { ...SETTINGS_DEFAULTS };
    return {
      slotDays: Array.isArray(row.slot_days) && row.slot_days.length ? row.slot_days.map(Number) : SETTINGS_DEFAULTS.slotDays,
      slotHourMsk: Number(row.slot_hour_msk ?? SETTINGS_DEFAULTS.slotHourMsk),
      prepareLeadHours: Number(row.prepare_lead_hours ?? SETTINGS_DEFAULTS.prepareLeadHours),
      minAnswerChars: Number(row.min_answer_chars ?? SETTINGS_DEFAULTS.minAnswerChars),
      tgChannelChatId: row.tg_channel_chat_id ?? null,
      platforms: Array.isArray(row.platforms) && row.platforms.length ? row.platforms : SETTINGS_DEFAULTS.platforms,
      narratorVoice: row.narrator_voice || SETTINGS_DEFAULTS.narratorVoice,
    };
  }

  async update(patch: ShortSettingsPatch): Promise<ShortSettings> {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      const value = (patch as any)[key];
      if (value === undefined) continue;
      args.push(value);
      sets.push(`${column} = $${args.length}`);
    }
    if (sets.length) {
      await this.pg.query(`UPDATE short_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, args);
    }
    return this.get();
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-settings.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts-settings.service.ts
git -C "$WT" commit -m "feat(shorts): настройки роликов и их проверка

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Промпты режиссёра и сценариста

Правила подачи и текста — те же, что проверяет код (задача 6). Промпт их называет, проверка их ловит.

**Files:**
- Create: `src/shorts/short-prompts.ts`
- Test: `src/shorts/short-prompts.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-prompts.spec.ts`:

```ts
import { DIRECTOR_SYSTEM, WRITER_SYSTEM, buildDirectorMessage, buildWriterMessage, toAgents } from './short-prompts';

describe('системные промпты', () => {
  it('режиссёр знает подачи, предел вопроса и запреты', () => {
    for (const s of ['uncomfortable', 'roast', 'myth', 'calm', '450 знаков', 'персональных данных', 'политики и религии', 'Уже было', '"followups"']) {
      expect(DIRECTOR_SYSTEM).toContain(s);
    }
  });

  it('сценарист знает опору зацепки, финал от кода и все 15 правил', () => {
    for (const s of ['hookBox', 'Финальную реплику с названием сервиса добавит код', 'needsRecapture', '25 000 токенов']) {
      expect(WRITER_SYSTEM).toContain(s);
    }
    for (let n = 1; n <= 15; n++) expect(WRITER_SYSTEM).toContain(`\n${n}. `);
  });
});

describe('toAgents', () => {
  it('строки getAgents — id числом и профиль без пробелов по краям', () => {
    expect(toAgents([{ id: '10', name: 'Алексей', description: ' Юрист ' }])).toEqual([{ id: 10, name: 'Алексей', description: 'Юрист' }]);
  });
});

describe('buildDirectorMessage', () => {
  const assistants = [{ id: 10, name: 'Алексей', description: 'Юрист' }, { id: 22, name: 'Кира', description: 'Дизайнер' }];
  const base = {
    rubric: 'assistant' as const, angle: 'roast' as const, topicHint: null, fixedAssistant: null, assistants,
    recentQuestions: [], ownerNote: null, previousQuestion: null,
  };

  it('без заданного ассистента — список с профилями', () => {
    const m = buildDirectorMessage(base);
    expect(m).toContain('Подача: roast — Разнос');
    expect(m).toContain('10 — Алексей: Юрист');
    expect(m).toContain('22 — Кира: Дизайнер');
  });

  it('заданный ассистент, прошлая сцена, замечания и «уже было»', () => {
    const m = buildDirectorMessage({
      ...base, fixedAssistant: assistants[0], topicHint: 'Договор аренды',
      previousQuestion: 'Старый вопрос', ownerNote: 'Сценарист: нужен вопрос про субаренду', recentQuestions: ['Вопрос А'],
    });
    expect(m).toContain('Ассистент задан: 10 — Алексей: Юрист');
    expect(m).not.toContain('22 — Кира');
    expect(m).toContain('Тема: Договор аренды');
    expect(m).toContain('придумай другую:\nСтарый вопрос');
    expect(m).toContain('нужен вопрос про субаренду');
    expect(m).toContain('Уже было (не повторяй):\n- Вопрос А');
  });

  it('реальный кейс — пересказ истории без имён и сумм', () => {
    expect(buildDirectorMessage({ ...base, rubric: 'case', topicHint: 'История владельца' })).toMatch(/Реальная история владельца.*без имён/);
  });
});

describe('buildWriterMessage', () => {
  const base = {
    rubric: 'assistant' as const, angle: 'myth' as const, assistantName: 'Алексей', assistantDescription: 'Юрист',
    question: 'Можно ли не вернуть залог?', paragraphs: [{ n: 1, text: 'Первый.' }, { n: 2, text: 'Второй.' }],
    ownerNote: null, writerFeedback: null, previousScript: null, violations: [],
  };

  it('абзацы с номерами и вопрос', () => {
    const m = buildWriterMessage(base);
    expect(m).toContain('[1] Первый.\n[2] Второй.');
    expect(m).toContain('Спросили: Можно ли не вернуть залог?');
    expect(m).toContain('Подача: myth — ИИ против мифа');
  });

  it('замечания, пояснение студии, прошлый вариант и нарушения', () => {
    const m = buildWriterMessage({
      ...base,
      ownerNote: 'короче',
      writerFeedback: 'Озвучка заняла 63 с',
      previousScript: { hook: 'Старая зацепка', voice: 'madirus', speed: 1.1, lines: [{ id: 'a1', scene: 'answer', box: 1, text: 'Старая реплика' }], final: { assistantsCount: 18 } },
      violations: ['правило 6: стартовый подарок — «25 000 токенов», а не «бесплатно»'],
    });
    expect(m).toContain('Замечания владельца:\nкороче');
    expect(m).toContain('Студия: Озвучка заняла 63 с');
    expect(m).toContain('Старая зацепка');
    expect(m).toContain('[1] Старая реплика');
    expect(m).toContain('нарушил правила — исправь:\n- правило 6');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/short-prompts.spec.ts
git -C "$WT" commit -m "test(shorts): промпты режиссёра и сценариста (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-prompts.spec.ts"`
Expected: FAIL — `Cannot find module './short-prompts'`.

- [ ] **Step 3: Реализация**

`src/shorts/short-prompts.ts`:

```ts
import { ANGLE_TITLES, RUBRIC_TITLES, ShortAngle, ShortParagraph, ShortRubric, ShortScript } from './shorts.types';

/** Ассистент так, как его видят режиссёр и сценарист. */
export interface AgentLite {
  id: number;
  name: string;
  description: string;
}

/** Строки AgentsService.getAgents('ru') → id числом, профиль без пробелов по краям. */
export function toAgents(rows: any[]): AgentLite[] {
  return (rows ?? []).map((r) => ({ id: Number(r.id), name: String(r.name), description: String(r.description ?? '').trim() }));
}

export const DIRECTOR_SYSTEM = [
  'Ты — режиссёр коротких вертикальных роликов Linkeon (30–60 секунд) для VK, YouTube Shorts и Telegram.',
  'Linkeon — сервис с ИИ-ассистентами: юрист, бухгалтер, коуч, дизайнер и другие. Ролик показывает настоящий ответ ассистента, снятый на демо-аккаунте.',
  'Твоя задача — сцена: какому ассистенту и какой жизненный вопрос задать, чтобы ответ был полезным и цеплял.',
  '',
  'Подача ролика задана в сообщении:',
  '- uncomfortable — неудобный вопрос: деньги, конфликты, ошибки, «а так можно?» — то, о чём спорят или стыдно спросить;',
  '- roast — разнос: ассистент жёстко разбирает плохой материал. Материал сочиняешь ты сам — короткий демонстрационный кусок (пара пунктов договора, продающий текст, план) — и вставляешь его в вопрос текстом;',
  '- myth — ИИ против мифа: «Правда ли, что…» с неожиданным ответом;',
  '- calm — спокойная демонстрация: ассистент решает обычную задачу.',
  '',
  'Правила вопроса:',
  '1. От лица обычного человека, живыми словами, как пишут в чат. Не длиннее 450 знаков вместе с материалом для разноса.',
  '2. Без персональных данных: ни имён, ни телефонов, ни почты, ни адресов, ни названий организаций.',
  '3. Без политики и религии.',
  '4. Здоровье — только в подаче calm и без запугивания.',
  '5. Без названных людей, компаний, брендов и конкурентов — и в материале для разноса тоже.',
  '6. Не подталкивать к нарушению закона: «как не платить налоги» нельзя, «что будет, если…» можно.',
  '7. Задача — из профиля ассистента: не приписывай ему того, чего он не умеет.',
  '8. Не повторяй вопросы из списка «Уже было».',
  '',
  'Ассистент может переспросить (город, сроки, суммы). Заготовь 1–2 коротких уточнения — студия ответит ими на встречный вопрос.',
  '',
  'Ответь ТОЛЬКО JSON, без пояснений:',
  '{"assistantId": <id из списка>, "question": "<вопрос>", "followups": ["<уточнение>"], "title": "<рабочее название ролика, до 60 знаков>"}',
].join('\n');

export interface DirectorInput {
  rubric: ShortRubric;
  angle: ShortAngle;
  topicHint: string | null;
  fixedAssistant: AgentLite | null;
  assistants: AgentLite[];
  recentQuestions: string[];
  ownerNote: string | null;
  previousQuestion: string | null;
}

export function buildDirectorMessage(i: DirectorInput): string {
  const parts = [`Рубрика: ${RUBRIC_TITLES[i.rubric]}. Подача: ${i.angle} — ${ANGLE_TITLES[i.angle]}.`];
  if (i.rubric === 'case') {
    parts.push(
      'Реальная история владельца: задай её ассистенту заново вопросом от первого лица, без имён, названий организаций и сумм.',
    );
  }
  parts.push(i.topicHint ? `Тема: ${i.topicHint}` : 'Тему выбери сам — из профиля ассистента.');
  parts.push(
    i.fixedAssistant
      ? `Ассистент задан: ${i.fixedAssistant.id} — ${i.fixedAssistant.name}: ${i.fixedAssistant.description}`
      : `Ассистенты (id — имя: профиль):\n${i.assistants.map((a) => `${a.id} — ${a.name}: ${a.description}`).join('\n')}`,
  );
  if (i.previousQuestion) parts.push(`Прошлая сцена этого ролика — придумай другую:\n${i.previousQuestion}`);
  if (i.ownerNote) parts.push(`Замечания — учти:\n${i.ownerNote}`);
  if (i.recentQuestions.length) parts.push(`Уже было (не повторяй):\n${i.recentQuestions.map((q) => `- ${q}`).join('\n')}`);
  return parts.join('\n\n');
}

export const WRITER_SYSTEM = [
  'Ты — сценарист коротких роликов Linkeon. Тебе дают настоящий ответ ИИ-ассистента, разбитый на абзацы с номерами, и подачу ролика. Напиши текст для озвучки и подписи площадок.',
  '',
  'Ролик идёт так: зацепка → вопрос в чате → ответ, где камера приближает абзацы, о которых говорит голос → финал.',
  'Финальную реплику с названием сервиса добавит код. Сам её не пиши и название сервиса в своих репликах не называй.',
  '',
  'Что написать:',
  '- hook — зацепка до 8 слов под подачу. Может спрашивать («Боитесь подписать договор не глядя?»), но не утверждает за зрителя, что он чувствует.',
  '- hookBox — номер абзаца, на котором держится смелая фраза зацепки. Для подач uncomfortable, roast и myth обязателен: зацепка без опоры на ответ — нарушение. Для calm можно null.',
  '- question — реплика ассистента от первого лица о том, что у него спросили: «Я <имя>, <кто он>. Меня спросили…».',
  '- lines — 2–3 реплики, не больше 4. Каждая пересказывает ОДИН абзац ответа близко к тексту и указывает его номер в box. Ничего сверх абзаца не добавляй.',
  '- captions — подписи: telegram и vk (до 600 знаков, без ссылок — ссылку добавит код), youtube: title (до 90 знаков), description (до 600 знаков, без ссылок), tags (5–10 слов).',
  '',
  'Длина: всё, что звучит, вместе с финалом — 32–55 секунд. Это примерно 450–780 знаков на все реплики (финал — около 70).',
  '',
  'Правила текста:',
  '1. Никаких выдуманных цифр, отзывов и числа пользователей: цифры — только из ответа.',
  '2. Никаких сравнений с конкурентами и их названий.',
  '3. Не писать «анонимно» и «ваши данные никуда не уходят».',
  '4. Поиск единомышленников — не знакомства и не дейтинг.',
  '5. «Ассистент», а не «агент».',
  '6. Стартовый подарок — «25 000 токенов», а не «бесплатно».',
  '7. Не упоминать Юлю, Kling, названия моделей и провайдеров ИИ.',
  '8. Каждая реплика ответа опирается на свой абзац (box).',
  '9. Зацепка спрашивает или говорит факт из ответа, но не приписывает зрителю чувства.',
  '10. Смелая фраза зацепки опирается на абзац hookBox.',
  '11. Без политики и религии.',
  '12. Без запугивания здоровьем.',
  '13. Без названных людей, компаний и брендов.',
  '14. Без брани, оскорблений и насмешек над теми, кто не пользуется сервисом.',
  '15. Не подталкивать к нарушению закона.',
  '',
  'Если замечание владельца нельзя выполнить без другого вопроса или другого ответа, верни:',
  '{"needsRecapture": true, "reason": "<почему нужна новая сцена>"}',
  '',
  'Иначе ответь ТОЛЬКО JSON, без пояснений:',
  '{"hook": "...", "hookBox": <номер или null>, "question": "...", "lines": [{"box": <номер>, "text": "..."}], "captions": {"telegram": "...", "vk": "...", "youtube": {"title": "...", "description": "...", "tags": ["..."]}}}',
].join('\n');

export interface WriterInput {
  rubric: ShortRubric;
  angle: ShortAngle;
  assistantName: string;
  assistantDescription: string;
  question: string;
  paragraphs: ShortParagraph[];
  ownerNote: string | null;
  writerFeedback: string | null;
  previousScript: ShortScript | null;
  violations: string[];
}

export function buildWriterMessage(i: WriterInput): string {
  const parts = [
    `Рубрика: ${RUBRIC_TITLES[i.rubric]}. Подача: ${i.angle} — ${ANGLE_TITLES[i.angle]}.`,
    `Ассистент: ${i.assistantName} — ${i.assistantDescription}`,
    `Спросили: ${i.question}`,
    `Ответ по абзацам:\n${i.paragraphs.map((p) => `[${p.n}] ${p.text}`).join('\n')}`,
  ];
  if (i.previousScript) {
    const lines = i.previousScript.lines
      .filter((l) => l.scene === 'answer')
      .map((l) => `[${l.box}] ${l.text}`)
      .join('\n');
    parts.push(`Прошлый вариант:\nЗацепка: ${i.previousScript.hook}\n${lines}`);
  }
  if (i.ownerNote) parts.push(`Замечания владельца:\n${i.ownerNote}`);
  if (i.writerFeedback) parts.push(`Студия: ${i.writerFeedback}`);
  if (i.violations.length) parts.push(`Прошлый вариант нарушил правила — исправь:\n${i.violations.map((v) => `- ${v}`).join('\n')}`);
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/short-prompts.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/short-prompts.ts
git -C "$WT" commit -m "feat(shorts): промпты режиссёра и сценариста

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Режиссёр — тема и подача в сцену

Сессия релея — новая на каждый вызов, со случайной частью: `short-direct-<id>-<uuid>`. 18.10.2026 стенд и прод обратились к релею с совпавшим sessionId, и новости ушли не в тот канал.

**Files:**
- Create: `src/shorts/shorts-director.service.ts`
- Test: `src/shorts/shorts-director.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-director.service.spec.ts`:

```ts
import { ShortsDirectorService } from './shorts-director.service';
import { StageFatalError } from './short-jobs';
import { DIRECTOR_SYSTEM } from './short-prompts';
import { rowToShort } from './shorts.types';

const AGENTS = [
  { id: 10, name: 'Алексей', description: 'Юрист — помогает разобраться в правовых вопросах' },
  { id: 22, name: 'Кира', description: 'Дизайнер' },
];
const REPLY = {
  assistantId: 10,
  question: 'Хозяин квартиры не возвращает залог — что делать?',
  followups: ['Москва, договор на 11 месяцев'],
  title: 'Залог при аренде',
};

function video(over: Record<string, any> = {}) {
  return rowToShort({
    id: 'ab12cd34-0000-4000-8000-000000000000', rubric: 'assistant', angle: 'uncomfortable', source: 'catalog',
    topic_key: 'assistant-10', topic_hint: 'Ассистент «Алексей»', assistant_id: 10, status: 'directing', attempts: 1,
    ...over,
  });
}

function setup(reply: any = REPLY, updated = 1) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("scene->>'question'")) return { rows: [{ q: 'Вопрос из прошлого ролика' }] };
      return { rows: [], rowCount: updated };
    }),
  };
  const relay = { ask: jest.fn(async () => (typeof reply === 'string' ? reply : JSON.stringify(reply))) };
  const agents = { getAgents: jest.fn(async () => AGENTS) };
  return { svc: new ShortsDirectorService(pg as any, relay as any, agents as any), pg, relay, agents };
}

describe('ShortsDirectorService.direct', () => {
  it('сцена из ответа режиссёра, ролик — в очередь съёмки', async () => {
    const { svc, pg, relay } = setup();
    await svc.direct(video());

    const [system, message, sessionId] = relay.ask.mock.calls[0] as any[];
    expect(system).toBe(DIRECTOR_SYSTEM);
    expect(message).toContain('Ассистент задан: 10 — Алексей');
    expect(message).toContain('- Вопрос из прошлого ролика');
    expect(sessionId).toMatch(/^short-direct-ab12cd34-0000-4000-8000-000000000000-[0-9a-f-]{36}$/);

    const [sql, params] = pg.query.mock.calls[1] as any[];
    expect(sql).toMatch(/SET status = 'capture_queued'/);
    expect(sql).toMatch(/WHERE id = \$1 AND status = 'directing' AND attempts = \$6/);
    expect(params[5]).toBe(1);
    expect(JSON.parse(params[1])).toEqual({
      kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: REPLY.question, followups: REPLY.followups,
    });
    expect(params[2]).toBe(10);
    expect(params[3]).toBe('zalog_pri_arende_ab12');
    expect(params[4]).toBe('Залог при аренде');
  });

  it('слаг уже есть — не меняется (метки ролика постоянны)', async () => {
    const { svc, pg } = setup();
    await svc.direct(video({ slug: 'old_slug_ab12' }));
    expect((pg.query.mock.calls[1] as any[])[1][3]).toBe('old_slug_ab12');
  });

  it('пересъёмка: прошлый вопрос и замечания уходят режиссёру', async () => {
    const { svc, relay } = setup();
    await svc.direct(video({
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Старый вопрос', followups: [] },
      owner_note: 'Сценарист: нужен вопрос про субаренду',
    }));
    const message = (relay.ask.mock.calls[0] as any[])[1];
    expect(message).toContain('придумай другую:\nСтарый вопрос');
    expect(message).toContain('нужен вопрос про субаренду');
  });

  it('ассистент темы больше не активен — фатально, повтор не поможет', async () => {
    const { svc } = setup();
    await expect(svc.direct(video({ assistant_id: 99 }))).rejects.toBeInstanceOf(StageFatalError);
  });

  it('кривой ответ режиссёра — обычная ошибка: этап повторится', async () => {
    const { svc } = setup('Извините, не могу');
    await expect(svc.direct(video())).rejects.toThrow(/режиссёр: не нашёл JSON/);
  });

  it('ролик ушёл из directing, пока думал режиссёр — без ошибки', async () => {
    const { svc } = setup(REPLY, 0);
    await expect(svc.direct(video())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-director.service.spec.ts
git -C "$WT" commit -m "test(shorts): режиссёр — тема в сцену (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-director.service.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-director.service'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-director.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentsService } from '../agents/agents.service';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { PgService } from '../common/services/pg.service';
import { StageFatalError } from './short-jobs';
import { parseDirectorReply } from './short-parse';
import { DIRECTOR_SYSTEM, buildDirectorMessage, toAgents } from './short-prompts';
import { shortSlug } from './short-slug';
import { ShortScene, ShortVideo } from './shorts.types';

/** Сколько прошлых вопросов показываем режиссёру, чтобы он не повторялся (спека, «Правила очереди»). */
const RECENT_QUESTIONS = 20;

@Injectable()
export class ShortsDirectorService {
  private readonly logger = new Logger(ShortsDirectorService.name);

  constructor(
    private readonly pg: PgService,
    private readonly relay: BlogRelayClient,
    private readonly agents: AgentsService,
  ) {}

  /**
   * Тема и подача → сцена чата. Пишет scene, assistant_id, slug и title и
   * переводит ролик в capture_queued. Ошибки релея и разбора бросаются как
   * есть — этап повторится по паузам (short-jobs.ts). Фатально только то,
   * что повтор не исправит.
   */
  async direct(v: ShortVideo): Promise<void> {
    const assistants = toAgents(await this.agents.getAgents('ru'));
    const fixed = v.assistantId ? assistants.find((a) => a.id === v.assistantId) ?? null : null;
    if (v.assistantId && !fixed) throw new StageFatalError(`режиссёр: ассистента ${v.assistantId} нет среди активных`);

    const recent = await this.pg.query(
      `SELECT scene->>'question' AS q FROM short_video
        WHERE id <> $1 AND scene IS NOT NULL
        ORDER BY created_at DESC LIMIT ${RECENT_QUESTIONS}`,
      [v.id],
    );
    const message = buildDirectorMessage({
      rubric: v.rubric,
      angle: v.angle,
      topicHint: v.topicHint,
      fixedAssistant: fixed,
      assistants,
      recentQuestions: recent.rows.map((r: any) => r.q).filter(Boolean),
      ownerNote: v.ownerNote,
      previousQuestion: v.scene?.question ?? null,
    });

    // Новая сессия на каждый вызов: совпавший sessionId стенда и прода 18.10.2026
    // увёл новости блога не в тот канал.
    const sessionId = `short-direct-${v.id}-${randomUUID()}`;
    this.logger.log(`ролик ${v.id}: режиссёр, sessionId ${sessionId}`);
    const raw = await this.relay.ask(DIRECTOR_SYSTEM, message, sessionId);
    const reply = parseDirectorReply(raw, {
      assistantIds: new Set(assistants.map((a) => a.id)),
      fixedAssistantId: fixed?.id ?? null,
    });

    const assistant = assistants.find((a) => a.id === reply.assistantId);
    const scene: ShortScene = {
      kind: 'chat',
      assistantId: reply.assistantId,
      assistantName: assistant.name,
      question: reply.question,
      followups: reply.followups,
    };
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = 'capture_queued', scene = $2::jsonb, assistant_id = $3, slug = $4, title = $5,
              attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'directing' AND attempts = $6`,
      [v.id, JSON.stringify(scene), reply.assistantId, v.slug ?? shortSlug(reply.title, v.id), reply.title, v.attempts],
    );
    // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
    if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из directing или его забрал другой процесс — сцену не записал`);
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-director.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts-director.service.ts
git -C "$WT" commit -m "feat(shorts): режиссёр — тема и подача в сцену чата

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Сценарист — съёмка в сценарий и подписи

Сценарий проверяется правилами (задача 6). Не прошёл — сценарист переписывает с перечнем нарушений, до двух раз. Если замечание владельца требует другой сцены, сценарист возвращает `needsRecapture`, и ролик уходит к режиссёру.

**Files:**
- Create: `src/shorts/shorts-writer.service.ts`
- Test: `src/shorts/shorts-writer.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-writer.service.spec.ts`:

```ts
import { ShortsWriterService } from './shorts-writer.service';
import { StageFatalError } from './short-jobs';
import { WRITER_SYSTEM } from './short-prompts';
import { rowToShort } from './shorts.types';

const PARAGRAPHS = [
  { n: 1, text: 'Залог возвращается в течение 7 дней после выезда.' },
  { n: 2, text: 'Опасная фраза: «залог не возвращается при досрочном выезде».' },
  { n: 3, text: 'Нормальный износ не является повреждением — впишите это в договор.' },
];
const GOOD = {
  hook: 'Хозяин может оставить залог себе?',
  hookBox: 2,
  question: 'Я Алексей, юрист. Меня спросили, как снять квартиру и не потерять залог при выезде.',
  lines: [
    { box: 2, text: 'Ищите в договоре опасную фразу: «залог не возвращается при досрочном выезде». Увидели — просите переписать этот пункт.' },
    { box: 3, text: 'Впишите прямо: нормальный износ не является повреждением. Тогда за потёртый пол и выцветшие обои удержать деньги не получится.' },
    { box: 1, text: 'И договоритесь о сроке: залог возвращается в течение 7 дней после выезда — так и запишите в договоре аренды.' },
  ],
  captions: {
    telegram: 'Юрист разобрал, как не потерять залог при аренде.',
    vk: '',
    youtube: { title: 'Как не потерять залог при аренде', description: 'Три пункта договора, которые сберегут залог.', tags: ['аренда', 'залог'] },
  },
};
// 18 активных ассистентов: число в финале — из этого списка.
const AGENTS = [{ id: 10, name: 'Алексей', description: 'Юрист' }, ...Array.from({ length: 17 }, (_, i) => ({ id: 100 + i, name: `А${i}`, description: '' }))];

function video(over: Record<string, any> = {}) {
  return rowToShort({
    id: 'ab12cd34-0000-4000-8000-000000000000', rubric: 'assistant', angle: 'uncomfortable', source: 'catalog',
    topic_key: 'assistant-10', title: 'Залог при аренде', slug: 'zalog_ab12', assistant_id: 10, status: 'writing', attempts: 1,
    scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Как не потерять залог?', followups: [] },
    capture: { paragraphs: PARAGRAPHS, answerText: PARAGRAPHS.map((p) => p.text).join('\n'), boxes: [] },
    ...over,
  });
}

function setup(replies: any[]) {
  const queue = [...replies];
  const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 1 })) };
  const relay = { ask: jest.fn(async () => JSON.stringify(queue.shift())) };
  const agents = { getAgents: jest.fn(async () => AGENTS) };
  const settings = { get: jest.fn(async () => ({ narratorVoice: 'alena' })) };
  return { svc: new ShortsWriterService(pg as any, relay as any, agents as any, settings as any), pg, relay };
}

describe('ShortsWriterService.write', () => {
  const OLD = process.env.SHORTS_LINK_BASE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SHORTS_LINK_BASE;
    else process.env.SHORTS_LINK_BASE = OLD;
  });

  it('честный ответ — сценарий и подписи, ролик в очередь сборки', async () => {
    process.env.SHORTS_LINK_BASE = 'https://test.linkeon.io';
    const { svc, pg, relay } = setup([GOOD]);
    await svc.write(video());

    const [system, message, sessionId] = relay.ask.mock.calls[0] as any[];
    expect(system).toBe(WRITER_SYSTEM);
    expect(message).toContain('[2] Опасная фраза');
    expect(sessionId).toMatch(/^short-write-ab12cd34-0000-4000-8000-000000000000-[0-9a-f-]{36}$/);

    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/SET status = 'render_queued'/);
    expect(sql).toMatch(/writer_rounds = writer_rounds \+ 1/);
    const script = JSON.parse(params[1]);
    expect(script.voice).toBe('madirus');
    expect(script.lines[script.lines.length - 1]).toEqual({ id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' });
    expect(script.final).toEqual({ assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' });
    const captions = JSON.parse(params[2]);
    expect(captions.telegram).toContain('https://test.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_zalog_ab12');
    expect(captions.youtube.description).toContain('utm_source=youtube');
  });

  it('нарушение правил — переписка с перечнем, второй вариант проходит', async () => {
    const bad = { ...GOOD, captions: { ...GOOD.captions, telegram: 'Попробуйте бесплатно!' } };
    const { svc, pg, relay } = setup([bad, GOOD]);
    await svc.write(video());
    expect(relay.ask).toHaveBeenCalledTimes(2);
    expect((relay.ask.mock.calls[1] as any[])[1]).toMatch(/нарушил правила — исправь:\n- правило 6/);
    // Отвергнутый вариант — перед сценаристом: в первом запросе прошлого нет, во втором он есть.
    expect((relay.ask.mock.calls[0] as any[])[1]).not.toContain('Прошлый вариант:');
    expect((relay.ask.mock.calls[1] as any[])[1]).toContain('Прошлый вариант:');
    expect((pg.query.mock.calls[0] as any[])[0]).toMatch(/render_queued/);
  });

  it('три варианта подряд с нарушениями — фатально, без записи', async () => {
    const bad = { ...GOOD, captions: { ...GOOD.captions, telegram: 'Попробуйте бесплатно!' } };
    const { svc, pg } = setup([bad, bad, bad]);
    await expect(svc.write(video())).rejects.toBeInstanceOf(StageFatalError);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('просит переснять — ролик к режиссёру с причиной в замечаниях', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    await svc.write(video({ owner_note: 'про субаренду' }));
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/SET status = 'directing'/);
    expect(params[1]).toBe('про субаренду\nСценарист: нужен вопрос про субаренду');
  });

  it('реальный кейс — с подписью в кадре вопроса', async () => {
    const { svc, pg } = setup([GOOD]);
    await svc.write(video({ rubric: 'case' }));
    expect(JSON.parse((pg.query.mock.calls[0] as any[])[1][1]).badge).toBe('Реальная история, разговор повторён на демо-аккаунте');
  });

  it('нет съёмки — фатально', async () => {
    const { svc } = setup([GOOD]);
    await expect(svc.write(video({ capture: null }))).rejects.toBeInstanceOf(StageFatalError);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-writer.service.spec.ts
git -C "$WT" commit -m "test(shorts): сценарист — сценарий и подписи (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-writer.service'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-writer.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentsService } from '../agents/agents.service';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { PgService } from '../common/services/pg.service';
import { assistantVoice, disclaimerFor } from './short-assistants';
import { buildCaptions } from './short-captions';
import { StageFatalError } from './short-jobs';
import { linkBase, shortLinks, shortTarget } from './short-links';
import { parseWriterReply } from './short-parse';
import { WRITER_SYSTEM, buildWriterMessage, toAgents } from './short-prompts';
import { checkScriptRules } from './short-rules';
import { CASE_BADGE, buildScript } from './short-script';
import { shortSlug } from './short-slug';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortScript, ShortVideo, appendOwnerNote } from './shorts.types';

/** Сколько раз сценарий переписывается по нарушениям правил (спека, «Обработка отказов»). */
export const MAX_REWRITES = 2;

@Injectable()
export class ShortsWriterService {
  private readonly logger = new Logger(ShortsWriterService.name);

  constructor(
    private readonly pg: PgService,
    private readonly relay: BlogRelayClient,
    private readonly agents: AgentsService,
    private readonly settings: ShortsSettingsService,
  ) {}

  /**
   * Снятый ответ → сценарий студии и подписи площадок, затем проверка правил.
   * Не прошёл — переписка с перечнем нарушений, до MAX_REWRITES раз; не
   * помогло — StageFatalError (повтор тем же ответом бессмыслен).
   */
  async write(v: ShortVideo): Promise<void> {
    if (!v.scene || !v.capture) throw new StageFatalError('сценарист: у ролика нет сцены или съёмки');
    const [rows, settings] = await Promise.all([this.agents.getAgents('ru'), this.settings.get()]);
    const assistants = toAgents(rows);
    const name = v.scene.assistantName;
    const description = assistants.find((a) => a.id === v.scene.assistantId)?.description ?? '';
    const assistantsCount = assistants.length;
    const slug = v.slug ?? shortSlug(v.title ?? v.topicKey, v.id);
    const links = shortLinks(linkBase(), shortTarget(v.scene.assistantId), slug);
    const options = {
      voice: assistantVoice(name),
      narratorVoice: settings.narratorVoice,
      assistantsCount,
      disclaimer: disclaimerFor(name),
      badge: v.rubric === 'case' ? CASE_BADGE : undefined,
    };

    let violations: string[] = [];
    // Со второго круга сценарист видит отвергнутый вариант, а не прежний
    // сценарий из базы: иначе нарушение названо, а текста, где оно, перед ним нет.
    let previous: ShortScript | null = v.script;
    for (let round = 0; round <= MAX_REWRITES; round++) {
      const message = buildWriterMessage({
        rubric: v.rubric,
        angle: v.angle,
        assistantName: name,
        assistantDescription: description,
        question: v.scene.question,
        paragraphs: v.capture.paragraphs ?? [],
        ownerNote: v.ownerNote,
        writerFeedback: v.writerFeedback,
        previousScript: previous,
        violations,
      });
      const raw = await this.relay.ask(WRITER_SYSTEM, message, `short-write-${v.id}-${randomUUID()}`);
      const reply = parseWriterReply(raw);
      if (reply.needsRecapture) {
        await this.backToDirector(v, reply.reason);
        return;
      }
      const script = buildScript(reply, options);
      violations = checkScriptRules({
        angle: v.angle,
        assistantName: name,
        script,
        captions: reply.captions,
        paragraphs: v.capture.paragraphs ?? [],
        answerText: v.capture.answerText ?? '',
        sceneQuestion: v.scene.question,
        assistantsCount,
      });
      if (violations.length) {
        this.logger.warn(`ролик ${v.id}: сценарий не прошёл правила (круг ${round + 1}): ${violations.join('; ')}`);
        previous = script;
        continue;
      }
      const r = await this.pg.query(
        `UPDATE short_video
            SET status = 'render_queued', script = $2::jsonb, captions = $3::jsonb, slug = $4,
                writer_feedback = NULL, writer_rounds = writer_rounds + 1,
                attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'writing' AND attempts = $5`,
        [v.id, JSON.stringify(script), JSON.stringify(buildCaptions(reply.captions, links)), slug, v.attempts],
      );
      // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
      if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — сценарий не записал`);
      return;
    }
    throw new StageFatalError(`сценарист: правила текста не прошли и после ${MAX_REWRITES} переписок — ${violations.join('; ')}`);
  }

  /** Нужна другая сцена: причина ложится к замечаниям — их прочтёт режиссёр. */
  private async backToDirector(v: ShortVideo, reason: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = 'directing', owner_note = $2, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'writing' AND attempts = $3`,
      [v.id, appendOwnerNote(v.ownerNote, `Сценарист: ${reason}`), v.attempts],
    );
    if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — к режиссёру не вернул`);
    else this.logger.log(`ролик ${v.id}: сценарист просит новую сцену — ${reason}`);
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts-writer.service.ts
git -C "$WT" commit -m "feat(shorts): сценарист — сценарий, подписи и переписка по правилам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Очередь тем и запуск ролика к слоту

Заказ владельца — одна строка в админке или `/short`. Каталог недели — три ассистента, о которых роликов не было дольше всех. Запуск ставит идее планируемый слот и подачу по ритму. Крон делает это не раньше чем за `prepare_lead_hours` до свободного слота и держит в работе не больше двух роликов. `start_now` из админки обходит оба ограничения. Решение о запуске принимается под advisory-локом транзакции: два процесса API не запустят два ролика под один слот.

**Files:**
- Create: `src/shorts/shorts-topic.service.ts`
- Test: `src/shorts/shorts-topic.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-topic.service.spec.ts`:

```ts
import { ShortsTopicService } from './shorts-topic.service';

const AGENTS = [
  { id: 1, name: 'Миша', description: 'Коуч' },
  { id: 10, name: 'Алексей', description: 'Юрист' },
  { id: 22, name: 'Кира', description: 'Дизайнер' },
  { id: 4, name: 'Ирина', description: 'Карьера' },
];
const SETTINGS = { slotDays: [2, 4, 6], slotHourMsk: 18, prepareLeadHours: 24 };
const MON_NOON = new Date('2026-10-26T12:00:00.000Z'); // до вт 18:00 МСК — 27 ч
const MON_EVENING = new Date('2026-10-26T17:00:00.000Z'); // до вт 18:00 МСК — 22 ч
const TUE = '2026-10-27T15:00:00.000Z';

const ideaRow = (over: Record<string, any> = {}) => ({
  id: 'i1', rubric: 'assistant', angle: 'calm', angle_locked: false, source: 'catalog', topic_key: 't',
  assistant_id: 10, status: 'idea', created_at: '2026-10-20T00:00:00.000Z', ...over,
});

/** Транзакция-заглушка: ответ — по первому совпавшему кусочку SQL. */
function fakeTx(routes: Array<[string, any]>) {
  const seen: Array<{ sql: string; params: any[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      const hit = routes.find(([needle]) => sql.includes(needle));
      return hit ? hit[1] : { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  return { getClient: async () => client, seen };
}

function setup(tx: ReturnType<typeof fakeTx>, poolQuery = jest.fn(async () => ({ rows: [] }))) {
  const pg = { query: poolQuery, getClient: tx.getClient };
  const agents = { getAgents: jest.fn(async () => AGENTS) };
  const settings = { get: jest.fn(async () => SETTINGS) };
  return new ShortsTopicService(pg as any, agents as any, settings as any);
}

describe('ShortsTopicService.addManual', () => {
  const insertOnly = () => {
    const query = jest.fn(async (_sql: string, params: any[]) => ({ rows: [{ ...ideaRow(), id: 'new', source: 'manual', source_ref: params[4] }] }));
    return { svc: setup(fakeTx([]), query), query };
  };

  it('история из /short — рубрика case, подача по ритму, ключ сообщения', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'Как я спорил с арендодателем о залоге', sourceRef: 'tg:1:2' });
    const params = (query.mock.calls[0] as any[])[1];
    expect(params.slice(0, 5)).toEqual(['case', 'calm', false, 'manual', 'tg:1:2']);
    expect(params[7]).toBe('Как я спорил с арендодателем о залоге');
  });

  it('подача из заказа фиксируется', async () => {
    const { svc, query } = insertOnly();
    await svc.addManual({ topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 });
    const params = (query.mock.calls[0] as any[])[1];
    expect(params.slice(0, 3)).toEqual(['assistant', 'roast', true]);
    expect(params[8]).toBe(10);
  });

  it.each([
    [{ topic: 'коротко' }, /от 10 до 4000/],
    [{ topic: 'нормальная тема ролика', rubric: 'boom' }, /рубрика/],
    [{ topic: 'нормальная тема ролика', angle: 'boom' }, /подача/],
    [{ topic: 'нормальная тема ролика', assistantId: 99 }, /ассистента 99 нет/],
  ])('%j — ошибка', async (order, message) => {
    const { svc } = insertOnly();
    await expect(svc.addManual(order as any)).rejects.toThrow(message);
  });
});

describe('ShortsTopicService.refillWeek', () => {
  it('три давно не показанных ассистента, кроме тех, у кого уже есть идея', async () => {
    const inserted: any[] = [];
    const query = jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('max(created_at)')) return { rows: [{ assistant_id: 10, last: '2026-10-01T00:00:00Z' }] };
      if (sql.includes('DISTINCT assistant_id')) return { rows: [{ assistant_id: 4 }] };
      if (sql.startsWith('INSERT')) {
        inserted.push(params);
        return { rows: [ideaRow({ id: `n${inserted.length}` })] };
      }
      return { rows: [] };
    });
    const added = await setup(fakeTx([]), query).refillWeek(new Date('2026-10-25T07:00:00Z'));
    expect(added).toBe(3);
    expect(inserted.map((p) => p[8])).toEqual([1, 22, 10]);
    expect(inserted[0][4]).toBe('catalog:assistant:1:2026-10-25');
    expect(inserted[0].slice(0, 4)).toEqual(['assistant', 'calm', false, 'catalog']);
  });
});

describe('ShortsTopicService.start', () => {
  // UPDATE — раньше выборки идей: в нём тоже есть «status = 'idea'».
  const routes = (over: Array<[string, any]> = []) => fakeTx([
    ...over,
    ['pg_try_advisory_xact_lock', { rows: [{ ok: true }] }],
    ['UPDATE short_video', { rows: [ideaRow({ status: 'directing', slot_at: TUE, angle: 'uncomfortable' })], rowCount: 1 }],
    ['SELECT slot_at FROM short_video', { rows: [] }],
    ['count(*)', { rows: [{ n: 0 }] }],
    ["status = 'idea'", { rows: [ideaRow()] }],
    ['SELECT rubric, angle', { rows: [] }],
  ]);

  it('до свободного слота меньше суток — запуск в этот слот с подачей по ритму', async () => {
    const tx = routes();
    const v = await setup(tx).start({ force: false }, () => MON_EVENING);
    expect(v?.status).toBe('directing');
    const update = tx.seen.find((q) => q.sql.includes('UPDATE short_video'));
    expect(update.params).toEqual(['i1', TUE, 'uncomfortable']);
  });

  it('до слота больше суток — крон ждёт, start_now — запускает', async () => {
    expect(await setup(routes()).start({ force: false }, () => MON_NOON)).toBeNull();
    expect((await setup(routes()).start({ force: true }, () => MON_NOON))?.status).toBe('directing');
  });

  it('в работе уже два ролика — крон не запускает третий', async () => {
    expect(await setup(routes([['count(*)', { rows: [{ n: 2 }] }]])).start({ force: false }, () => MON_EVENING)).toBeNull();
  });

  it('соседний процесс уже решает запуск — null без записи', async () => {
    const tx = routes([['pg_try_advisory_xact_lock', { rows: [{ ok: false }] }]]);
    expect(await setup(tx).start({ force: true }, () => MON_EVENING)).toBeNull();
    expect(tx.seen.some((q) => q.sql.includes('UPDATE short_video'))).toBe(false);
  });

  it('слот, предназначенный другому ролику, пропускается', async () => {
    const tx = routes([['SELECT slot_at FROM short_video', { rows: [{ slot_at: new Date(TUE) }] }]]);
    await setup(tx).start({ force: true }, () => MON_EVENING);
    const update = tx.seen.find((q) => q.sql.includes('UPDATE short_video'));
    expect(update.params[1]).toBe('2026-10-29T15:00:00.000Z');
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-topic.service.spec.ts
git -C "$WT" commit -m "test(shorts): заказ, наполнение недели и запуск к слоту (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-topic.service.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-topic.service'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-topic.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { inTransaction } from '../blog/blog-slot-claim';
import { nextFreeSlotAfter } from '../blog/blog-slots';
import { normalizeTopicKey } from '../blog/blog-topic.service';
import { PgService } from '../common/services/pg.service';
import { toAgents } from './short-prompts';
import { pickAssistants, planNext } from './short-rhythm';
import { ShortsSettingsService } from './shorts-settings.service';
import {
  ANGLES, IN_WORK_STATUSES, MAX_IN_WORK, RUBRICS, SLOT_HOLDING_STATUSES,
  ShortAngle, ShortRubric, ShortSource, ShortVideo, rowToShort,
} from './shorts.types';

export const WEEKLY_TOPICS = 3;
export const MIN_ORDER_CHARS = 10;
export const MAX_ORDER_CHARS = 4000;

export interface OrderInput {
  topic: string;
  rubric?: ShortRubric;
  /** Задана — фиксируется (`angle_locked`); нет — подачу поставит ритм недели при запуске. */
  angle?: ShortAngle | null;
  assistantId?: number | null;
  /** Ключ повторной доставки: `tg:<чат>:<сообщение>` у /short. */
  sourceRef?: string | null;
}

interface IdeaInsert {
  rubric: ShortRubric;
  angle: ShortAngle;
  angleLocked: boolean;
  source: ShortSource;
  sourceRef: string | null;
  topicKey: string;
  topicHint: string;
  title: string;
  assistantId: number | null;
}

@Injectable()
export class ShortsTopicService {
  private readonly logger = new Logger(ShortsTopicService.name);

  constructor(
    private readonly pg: PgService,
    private readonly agents: AgentsService,
    private readonly settings: ShortsSettingsService,
  ) {}

  /**
   * Заказ владельца. Без рубрики — `case`: так приходит история через /short.
   * @returns null — по этому sourceRef ролик уже заказан
   */
  async addManual(o: OrderInput): Promise<ShortVideo | null> {
    const topic = String(o.topic ?? '').trim();
    const n = Array.from(topic).length;
    if (n < MIN_ORDER_CHARS || n > MAX_ORDER_CHARS) {
      throw new Error(`тема — от ${MIN_ORDER_CHARS} до ${MAX_ORDER_CHARS} знаков, сейчас ${n}`);
    }
    const rubric = o.rubric ?? 'case';
    if (!RUBRICS.includes(rubric)) throw new Error(`неизвестная рубрика: ${rubric}`);
    if (o.angle != null && !ANGLES.includes(o.angle)) throw new Error(`неизвестная подача: ${o.angle}`);
    let assistantId: number | null = null;
    if (o.assistantId != null) {
      const active = toAgents(await this.agents.getAgents('ru'));
      if (!active.some((a) => a.id === Number(o.assistantId))) throw new Error(`ассистента ${o.assistantId} нет среди активных`);
      assistantId = Number(o.assistantId);
    }
    return this.insertIdea({
      rubric,
      angle: o.angle ?? 'calm',
      angleLocked: o.angle != null,
      source: 'manual',
      sourceRef: o.sourceRef ?? null,
      topicKey: normalizeTopicKey(topic.slice(0, 80)) || 'short',
      topicHint: topic,
      title: Array.from(topic.replace(/\s+/g, ' ')).slice(0, 60).join(''),
      assistantId,
    });
  }

  /**
   * Каталог недели (вс, крон): три активных ассистента, о которых роликов не
   * было дольше всех. Ключ — ассистент и дата: второй процесс API в тот же
   * день дубля не заведёт (uq_short_video_source_ref).
   */
  async refillWeek(now: Date = new Date()): Promise<number> {
    const assistants = toAgents(await this.agents.getAgents('ru'));
    const shown = await this.pg.query(
      `SELECT assistant_id, max(created_at) AS last FROM short_video
        WHERE assistant_id IS NOT NULL AND status <> 'rejected'
        GROUP BY assistant_id`,
    );
    const open = await this.pg.query(
      `SELECT DISTINCT assistant_id FROM short_video WHERE status = 'idea' AND assistant_id IS NOT NULL`,
    );
    const lastShown = new Map<number, Date>(shown.rows.map((r: any) => [Number(r.assistant_id), new Date(r.last)]));
    const openIds = new Set<number>(open.rows.map((r: any) => Number(r.assistant_id)));
    const day = now.toISOString().slice(0, 10);
    let added = 0;
    for (const a of pickAssistants(assistants, lastShown, openIds, WEEKLY_TOPICS)) {
      const v = await this.insertIdea({
        rubric: 'assistant',
        angle: 'calm',
        angleLocked: false,
        source: 'catalog',
        sourceRef: `catalog:assistant:${a.id}:${day}`,
        topicKey: `assistant-${a.id}`,
        topicHint: `Ассистент «${a.name}»: ${a.description}. Жизненная задача из его профиля.`,
        title: a.name,
        assistantId: a.id,
      });
      if (v) added += 1;
    }
    this.logger.log(`каталог недели: заведено ${added} тем`);
    return added;
  }

  /**
   * Запустить ролик под ближайший слот, которому ещё не предназначен ни один
   * ролик. Крон (`force: false`) — только когда до слота не больше
   * prepare_lead_hours и в работе меньше MAX_IN_WORK роликов. `start_now`
   * из админки (`force: true`) — сразу; `id` — конкретная идея.
   *
   * Всё решение — в одной транзакции под pg_try_advisory_xact_lock: два
   * процесса API не запустят два ролика под один слот. Занят — null, следующий
   * тик попробует снова.
   */
  async start(o: { id?: string; force: boolean }, clock: () => Date = () => new Date()): Promise<ShortVideo | null> {
    const [settings, agentRows] = await Promise.all([this.settings.get(), this.agents.getAgents('ru')]);
    const names = new Map(toAgents(agentRows).map((a) => [a.id, a.name]));
    return inTransaction(this.pg, async (tx) => {
      const lock = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext('shorts/start')) AS ok`);
      if (!lock.rows[0]?.ok) return null;
      const now = clock();

      const assigned = await tx.query(
        `SELECT slot_at FROM short_video WHERE status = ANY($1::text[]) AND slot_at > $2`,
        [[...IN_WORK_STATUSES, ...SLOT_HOLDING_STATUSES], now.toISOString()],
      );
      const slot = nextFreeSlotAfter(now, settings.slotDays, settings.slotHourMsk, assigned.rows.map((r: any) => r.slot_at));
      if (!o.force) {
        const inWork = await tx.query(
          `SELECT count(*)::int AS n FROM short_video WHERE status = ANY($1::text[])`,
          [IN_WORK_STATUSES],
        );
        if (Number(inWork.rows[0]?.n ?? 0) >= MAX_IN_WORK) return null;
        if (slot.getTime() - now.getTime() > settings.prepareLeadHours * 3600_000) return null;
      }

      const ideas = o.id
        ? await tx.query(`SELECT * FROM short_video WHERE status = 'idea' AND id = $1`, [o.id])
        : await tx.query(`SELECT * FROM short_video WHERE status = 'idea' ORDER BY created_at LIMIT 50`);
      if (!ideas.rows.length) return null;
      const recent = await tx.query(
        `SELECT rubric, angle FROM short_video
          WHERE status <> ALL($1::text[]) AND slot_at IS NOT NULL
          ORDER BY slot_at DESC LIMIT 6`,
        [['idea', 'rejected', 'failed']],
      );
      const plan = planNext(
        ideas.rows.map((row: any) => {
          const v = rowToShort(row);
          return {
            id: v.id,
            rubric: v.rubric,
            assistantName: v.assistantId ? names.get(v.assistantId) ?? null : null,
            angle: v.angle,
            angleLocked: v.angleLocked,
            source: v.source,
            createdAt: v.createdAt ?? now,
          };
        }),
        recent.rows.map((r: any) => ({ rubric: r.rubric, angle: r.angle })),
      );
      if (!plan) return null;

      const r = await tx.query(
        `UPDATE short_video
            SET status = 'directing', slot_at = $2, angle = $3, attempts = 0, lease_until = NULL,
                last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'idea'
          RETURNING *`,
        [plan.ideaId, slot.toISOString(), plan.angle],
      );
      return r.rows[0] ? rowToShort(r.rows[0]) : null;
    });
  }

  private async insertIdea(i: IdeaInsert): Promise<ShortVideo | null> {
    const r = await this.pg.query(
      `INSERT INTO short_video
         (rubric, angle, angle_locked, source, source_ref, topic_key, topic_hint, title, assistant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [i.rubric, i.angle, i.angleLocked, i.source, i.sourceRef, i.topicKey, i.topicHint, i.title, i.assistantId],
    );
    return r.rows[0] ? rowToShort(r.rows[0]) : null;
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-topic.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts-topic.service.ts
git -C "$WT" commit -m "feat(shorts): заказ ролика, каталог недели и запуск к свободному слоту

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Одобрение в Telegram — видео, кнопки, замечание, `/short`, сбои

Видео идёт в личку апрувера (`BLOG_APPROVER_TG_ID`) **байтами**: по ссылке Telegram наши файлы не забирает (`blog-image.fetch.ts`). Ответ на сообщение ролика или на приглашение узнаётся по паре «чат проверки + id сообщения» в любом статусе ролика, как у блога. Статус решает, что ответить владельцу, а не кому достанется текст. Флаги окружения собраны в `short-env.ts`.

**Files:**
- Create: `src/shorts/short-env.ts`, `src/shorts/shorts-approval.service.ts`
- Test: `src/shorts/shorts-approval.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-approval.service.spec.ts`:

```ts
jest.mock('./short-slot-claim', () => ({
  ...jest.requireActual('./short-slot-claim'),
  approveShortIntoSlot: jest.fn(),
}));

import { InputFile } from 'grammy';
import { NoFreeSlotError } from '../blog/blog-slots';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsApprovalService } from './shorts-approval.service';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;

const row = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'roast', source: 'manual', topic_key: 't', title: 'Залог при аренде',
  status: 'pending_review', review_chat_id: OWNER, review_message_id: 12, note_prompt_ids: [], yt_prompt_ids: [],
  slot_at: '2030-01-01T15:00:00.000Z', video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', duration_ms: 44000,
  scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
  captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'YT', description: 'D', tags: [] } },
  ...over,
});

function setup(dbRow: any = row()) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM short_video')) return { rows: dbRow ? [dbRow] : [] };
      if (sql.includes('SELECT status FROM short_publication')) return { rows: [{ status: 'manual_pending' }] };
      return { rows: dbRow ? [dbRow] : [], rowCount: 1 };
    }),
  };
  let nextId = 900;
  const tg = {
    sendVideo: jest.fn(async () => ({ message_id: 500 })),
    sendMessage: jest.fn(async () => ({ message_id: nextId++ })),
    answerCallbackQuery: jest.fn(async () => true),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ slotDays: [2, 4, 6], slotHourMsk: 18 })) };
  const topics = { addManual: jest.fn(async (): Promise<any> => ({ id: 'new' })) };
  const svc = new ShortsApprovalService(pg as any, tg as any, storage as any, settings as any, topics as any);
  return { svc, pg, tg, storage, topics };
}

describe('ShortsApprovalService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.BLOG_APPROVER_TG_ID = String(OWNER);
    process.env.SHORTS_ENABLED = 'true';
    delete process.env.SHORTS_STAND;
    delete process.env.SHORTS_AUTO_TOPICS;
    delete process.env.MINIO_BUCKET_VIDEOS;
    (approveShortIntoSlot as jest.Mock).mockReset();
  });
  afterAll(() => {
    process.env = env;
  });

  describe('отправка владельцу', () => {
    it('видео байтами, обложка, кнопки; координаты сообщения — в ролик', async () => {
      const { svc, tg, pg, storage } = setup();
      await svc.sendPendingReviews();
      expect(storage.download).toHaveBeenCalledWith({ bucket: 'linkeon-smm-videos', key: 'shorts/v/video.mp4' });
      const [chat, bytes, opts] = tg.sendVideo.mock.calls[0] as any[];
      expect(chat).toBe(OWNER);
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(opts.thumbnail).toBeInstanceOf(InputFile);
      expect(opts.supports_streaming).toBe(true);
      expect(opts.duration).toBe(44);
      expect(opts.caption).toContain('🎬 Ролик на проверку');
      expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(`short:ok:${ID}`);
      const last = pg.query.mock.calls[pg.query.mock.calls.length - 1] as any[];
      expect(last[0]).toMatch(/SET review_chat_id = \$2, review_message_id = \$3/);
      expect(last[1]).toEqual([ID, OWNER, 500]);
    });

    it('на стенде — пометка «СТЕНД»', async () => {
      process.env.SHORTS_STAND = 'true';
      const { svc, tg } = setup();
      await svc.sendPendingReviews();
      expect((tg.sendVideo.mock.calls[0] as any[])[2].caption.startsWith('[СТЕНД]')).toBe(true);
    });

    it('нечего отправлять — Telegram не трогаем', async () => {
      const { svc, tg } = setup(null);
      await svc.sendPendingReviews();
      expect(tg.sendVideo).not.toHaveBeenCalled();
    });
  });

  describe('кнопки', () => {
    const cb = (action: string, from = OWNER) => ({
      id: 'cb', data: `short:${action}:${ID}`, from: { id: from }, message: { chat: { id: OWNER }, message_id: 12 },
    });

    it('чужая кнопка — не наша', async () => {
      const { svc } = setup();
      expect(await svc.handleCallback({ id: 'cb', data: 'blog:ok:1', from: { id: OWNER } })).toBe(false);
    });

    it('кнопки — только у владельца', async () => {
      const { svc, tg, pg } = setup();
      expect(await svc.handleCallback(cb('ok', 42))).toBe(true);
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Эти кнопки — для владельца канала' });
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('«Одобрить» — слот и дата владельцу', async () => {
      (approveShortIntoSlot as jest.Mock).mockResolvedValue({
        slot: new Date('2030-01-01T15:00:00.000Z'), now: new Date('2029-12-31T12:00:00.000Z'),
      });
      const { svc, tg } = setup();
      await svc.handleCallback(cb('ok'));
      expect(approveShortIntoSlot).toHaveBeenCalledWith(expect.anything(), ID, new Date('2030-01-01T15:00:00.000Z'), { slotDays: [2, 4, 6], slotHourMsk: 18 });
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Одобрено. Опубликую завтра в 18:00 МСК.' });
      expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Одобрено. Опубликую завтра в 18:00 МСК.');
    });

    it('«Одобрить» без свободного слота — причина владельцу, ролик остаётся на проверке', async () => {
      (approveShortIntoSlot as jest.Mock).mockRejectedValue(new NoFreeSlotError('все 60 ближайших слотов расписания заняты'));
      const { svc, tg } = setup();
      await svc.handleCallback(cb('ok'));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/не одобрен — все 60 ближайших слотов/);
    });

    it('кнопка под устаревшим сообщением — отказ, ролик не трогается', async () => {
      // Новая версия ещё не отправлена (review_message_id обнулён студией) или уже ушла другим сообщением.
      for (const fresh of [null, 13]) {
        (approveShortIntoSlot as jest.Mock).mockClear();
        const { svc, tg, pg } = setup(row({ review_message_id: fresh }));
        expect(await svc.handleCallback(cb('ok'))).toBe(true);
        expect(approveShortIntoSlot).not.toHaveBeenCalled();
        expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Это сообщение устарело: ролик переделан, решение — под свежим сообщением' });
        expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
      }
    });

    it('«Одобрить» у уже обработанного — без записи', async () => {
      const { svc, tg } = setup(row({ status: 'published' }));
      await svc.handleCallback(cb('ok'));
      expect(approveShortIntoSlot).not.toHaveBeenCalled();
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Ролик уже обработан: published' });
    });

    it('«Замечание» — приглашение с полем ответа, его id — в ролик', async () => {
      const { svc, tg, pg } = setup();
      await svc.handleCallback(cb('note'));
      const [chat, text, opts] = tg.sendMessage.mock.calls[0] as any[];
      expect(chat).toBe(OWNER);
      expect(text).toContain('Что поправить в ролике «Залог при аренде»?');
      expect(opts.reply_markup.force_reply).toBe(true);
      expect(opts.reply_parameters).toEqual({ message_id: 12, allow_sending_without_reply: true });
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('note_prompt_ids =')) as any[];
      expect(upd[1]).toEqual([ID, 900, 20]);
    });

    it('«Переснять» — к режиссёру, «Отклонить» — в отказ, с условием на статус', async () => {
      const { svc, pg } = setup();
      await svc.handleCallback(cb('redo'));
      await svc.handleCallback(cb('no'));
      const writes = pg.query.mock.calls.filter((c: any[]) => String(c[0]).includes('SET status = $2')) as any[];
      expect(writes.map((c) => c[1][1])).toEqual(['directing', 'rejected']);
      expect(writes[0][1][2]).toEqual(['pending_review', 'approved']);
    });

    it('«Выложил на YouTube» — приглашение прислать ссылку', async () => {
      const { svc, tg, pg } = setup(row({ status: 'published' }));
      await svc.handleCallback(cb('yt'));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toContain('Пришлите ссылку на ролик «Залог при аренде» в YouTube');
      expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).includes('yt_prompt_ids ='))).toBe(true);
    });
  });

  describe('ответы реплаем', () => {
    const reply = (over: Record<string, any> = {}) => ({
      chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, message_id: 50,
      reply_to_message: { message_id: 12 }, text: 'короче и без цифр', ...over,
    });

    it('чужое сообщение — не наше', async () => {
      const { svc } = setup(null);
      expect(await svc.handleReplyEdit(reply())).toBe(false);
    });

    it('реплай не из чата апрувера — не наш, база не трогается', async () => {
      const { svc, pg } = setup();
      expect(await svc.handleReplyEdit(reply({ chat: { id: 555, type: 'private' }, from: { id: 555 } }))).toBe(false);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('замечание — ролик на переписку', async () => {
      const { svc, pg, tg } = setup();
      expect(await svc.handleReplyEdit(reply())).toBe(true);
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("status = 'writing'")) as any[];
      expect(upd[1]).toEqual([ID, 'короче и без цифр']);
      expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Принял замечание — поправлю ролик и пришлю заново.');
    });

    it('ролик уже не на проверке — объяснение, а не тишина', async () => {
      const { svc, tg } = setup(row({ status: 'approved' }));
      await svc.handleReplyEdit(reply());
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/уже одобрен/);
    });

    it('голосовое вместо текста — просьба написать текстом', async () => {
      const { svc, tg } = setup();
      await svc.handleReplyEdit(reply({ text: undefined, voice: {} }));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/только текстом/);
    });

    it('ссылка YouTube — отметка manual_done', async () => {
      const { svc, pg, tg } = setup(row({ status: 'published', yt_prompt_ids: ['70'] }));
      await svc.handleReplyEdit(reply({ reply_to_message: { message_id: 70 }, text: 'https://youtu.be/AbCdEfGhIjK' }));
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'manual_done'")) as any[];
      expect(upd[1]).toEqual([ID, 'https://youtube.com/shorts/AbCdEfGhIjK', 'AbCdEfGhIjK']);
      expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Записал ссылку YouTube: https://youtube.com/shorts/AbCdEfGhIjK');
    });

    it('не ссылка YouTube — переспрашивает', async () => {
      const { svc, tg } = setup(row({ status: 'published', yt_prompt_ids: ['70'] }));
      await svc.handleReplyEdit(reply({ reply_to_message: { message_id: 70 }, text: 'выложил' }));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Не узнал ссылку/);
    });
  });

  describe('/short', () => {
    const msg = (over: Record<string, any> = {}) => ({
      chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, message_id: 33,
      text: '/short Как я спорил с арендодателем о залоге', ...over,
    });

    it('владелец в личке — заказ рубрики case с ключом сообщения', async () => {
      const { svc, topics, tg } = setup();
      expect(await svc.handleShortCommand(msg())).toBe(true);
      expect(topics.addManual).toHaveBeenCalledWith({ topic: 'Как я спорил с арендодателем о залоге', rubric: 'case', sourceRef: `tg:${OWNER}:33` });
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Принял заказ ролика.*Автозапуск выключен/);
    });

    it('не владелец, группа, выключенные ролики — не наша команда', async () => {
      const { svc } = setup();
      expect(await svc.handleShortCommand(msg({ from: { id: 42 } }))).toBe(false);
      expect(await svc.handleShortCommand(msg({ chat: { id: -5, type: 'group' } }))).toBe(false);
      process.env.SHORTS_ENABLED = '';
      expect(await svc.handleShortCommand(msg())).toBe(false);
    });

    it('без темы — подсказка, как заказать', async () => {
      const { svc, topics, tg } = setup();
      await svc.handleShortCommand(msg({ text: '/short' }));
      expect(topics.addManual).not.toHaveBeenCalled();
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Как заказать ролик/);
    });

    it('повтор того же сообщения — второй раз не заводит', async () => {
      const { svc, topics, tg } = setup();
      topics.addManual.mockResolvedValue(null);
      await svc.handleShortCommand(msg());
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/уже заказан/);
    });
  });

  describe('сообщения о сбоях', () => {
    it('упавший ролик — владельцу с причиной, один раз', async () => {
      let given = false;
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', last_error: 'съёмка: ответ не годится', failed_from: 'capturing' })] };
        }
        return { rows: [] };
      });
      await svc.notifyFailures();
      expect(tg.sendMessage).toHaveBeenCalledTimes(1);
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Ролик «Залог при аренде» не собрался: съёмка: ответ не годится/);
    });
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-approval.service.spec.ts
git -C "$WT" commit -m "test(shorts): одобрение ролика в Telegram (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-approval.service.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-approval.service'`.

- [ ] **Step 3: Флаги окружения**

`src/shorts/short-env.ts`:

```ts
const flag = (name: string): boolean => String(process.env[name] || '').toLowerCase() === 'true';

/** Рубильник конвейера. Включать последним — после канала в short_settings (спека, «Среды и выкат»). */
export const shortsEnabled = (): boolean => flag('SHORTS_ENABLED');
/** Воскресное наполнение очереди и запуск роликов к слотам. На стенде выключен: ролик стартует из админки. */
export const autoTopicsEnabled = (): boolean => flag('SHORTS_AUTO_TOPICS');
/** Стенд: пометка «СТЕНД» в сообщениях владельцу. */
export const isStand = (): boolean => flag('SHORTS_STAND');
```

- [ ] **Step 4: Сервис одобрения**

`src/shorts/shorts-approval.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InputFile } from 'grammy';
import { approverChatId } from '../blog/blog-approval.service';
import { formatSlotWhen } from '../blog/blog-slot-format';
import { NoFreeSlotError } from '../blog/blog-slots';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildReviewKeyboard, parseShortCallback, parseYoutubeUrl, shortCommandText } from './short-callback';
import { STAND_MARK, buildReviewCaption, clip } from './short-captions';
import { autoTopicsEnabled, isStand, shortsEnabled } from './short-env';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsSettingsService } from './shorts-settings.service';
import { MIN_ORDER_CHARS, ShortsTopicService } from './shorts-topic.service';
import {
  MAX_NOTE_PROMPTS, ShortStatus, ShortVideo, appendOwnerNote, canTransition, rowToShort, shortsBucket,
} from './shorts.types';

/** Подсказки в поле ответа. Telegram принимает 1–64 символа. */
const NOTE_PLACEHOLDER = 'Что поправить?';
const LINK_PLACEHOLDER = 'https://youtube.com/shorts/…';

/** Ролик не ушёл владельцу (Telegram, MinIO) — следующая попытка через столько минут. */
export const REVIEW_LEASE_MINUTES = 5;

const RESHOOT = 'Ролик сейчас переснимается — замечание напишите к новому варианту.';
const REBUILD = 'Ролик сейчас пересобирается — замечание напишите к новому варианту.';

/** Почему замечание не принять — по статусу. Отказ лучше молчания: ответ наш, и владелец должен знать, куда он делся. */
const NOTE_REFUSALS: Partial<Record<ShortStatus, string>> = {
  directing: RESHOOT,
  capture_queued: RESHOOT,
  capturing: RESHOOT,
  writing: 'Ролик сейчас переписывается — замечание напишите к новому варианту.',
  render_queued: REBUILD,
  rendering: REBUILD,
  approved: 'Ролик уже одобрен и ждёт слота — замечание не принял. Переснять его можно кнопкой «🔄 Переснять».',
  publishing: 'Ролик прямо сейчас уходит на площадки — замечание не принял.',
  published: 'Ролик уже опубликован — замечание не принял.',
  rejected: 'Ролик отклонён — замечание не принял.',
  failed: 'Ролик не собрался — замечание не принял. Повторить его можно из админки.',
};

const noteRefusal = (s: ShortStatus): string => NOTE_REFUSALS[s] ?? `Замечание не принял: ролик в статусе ${s}.`;
const quoted = (v: ShortVideo): string => (v.title?.trim() ? ` «${v.title.trim()}»` : '');

/** Последние слова заказа — чтобы владелец видел, дошёл ли текст до конца (как caseAccepted блога). */
function ending(text: string): string {
  const chars = Array.from(text);
  const tail = chars.slice(-60).join('').replace(/\s+/g, ' ').trim();
  return chars.length > 60 ? `…${tail}` : tail;
}

@Injectable()
export class ShortsApprovalService {
  private readonly logger = new Logger(ShortsApprovalService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
    private readonly topics: ShortsTopicService,
  ) {}

  /** Служебное сообщение владельцу. Сбой отправки глотаем: он не повод ронять тик. */
  async notify(chatId: number | null, text: string): Promise<void> {
    if (!chatId) {
      this.logger.warn(`BLOG_APPROVER_TG_ID не задан — сообщить некому: ${text}`);
      return;
    }
    try {
      await this.tg.sendMessage(chatId, text);
    } catch (e: any) {
      this.logger.warn(`не смог написать ${chatId}: ${e.message}`);
    }
  }

  /**
   * Собранный ролик без сообщения — владельцу, по одному на вызов. Захват с
   * арендой: два процесса API не пришлют один ролик дважды, а сорвавшаяся
   * отправка повторится через REVIEW_LEASE_MINUTES.
   */
  async sendPendingReviews(): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(mins => $1), updated_at = now()
        WHERE id = (
          SELECT id FROM short_video
           WHERE status = 'pending_review' AND review_message_id IS NULL
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [REVIEW_LEASE_MINUTES],
    );
    if (!r.rows.length) return;
    const v = rowToShort(r.rows[0]);
    try {
      await this.sendForReview(v);
    } catch (e: any) {
      this.logger.error(`ролик ${v.id} владельцу не ушёл: ${e.message} — повторю через ${REVIEW_LEASE_MINUTES} мин`);
    }
  }

  /** Видео байтами с обложкой и кнопками; подписи, не влезшие в 1000 знаков, — вторым сообщением. */
  async sendForReview(v: ShortVideo): Promise<void> {
    const chatId = approverChatId();
    if (!chatId) {
      this.logger.warn(`ролик ${v.id} готов, но BLOG_APPROVER_TG_ID не задан — показать некому`);
      return;
    }
    if (!v.videoKey || !v.coverKey || !v.captions || !v.scene) {
      throw new Error('у ролика нет файла, обложки, подписей или сцены');
    }
    const bucket = shortsBucket();
    const [video, cover] = await Promise.all([
      this.storage.download({ bucket, key: v.videoKey }),
      this.storage.download({ bucket, key: v.coverKey }),
    ]);
    const now = new Date();
    const when = v.slotAt && v.slotAt.getTime() > now.getTime()
      ? formatSlotWhen(v.slotAt, now)
      : 'в ближайший свободный слот после одобрения';
    const { caption, extra } = buildReviewCaption({
      stand: isStand(),
      rubric: v.rubric,
      angle: v.angle,
      assistantName: v.scene.assistantName,
      question: v.scene.question,
      when,
      captions: v.captions,
    });
    const msg: any = await this.tg.sendVideo(chatId, video, {
      caption,
      reply_markup: buildReviewKeyboard(v.id),
      thumbnail: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    });
    if (extra) await this.tg.sendMessage(chatId, extra);
    await this.pg.query(
      `UPDATE short_video SET review_chat_id = $2, review_message_id = $3, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review'`,
      [v.id, chatId, Number(msg.message_id)],
    );
  }

  /** @returns true, если кнопка наша и обработана */
  async handleCallback(cb: any): Promise<boolean> {
    const parsed = parseShortCallback(String(cb?.data || ''));
    if (!parsed) return false;
    // Кнопки решают, что уйдёт в канал, — только владельцу. Пересланное сообщение кнопки сохраняет.
    const owner = approverChatId();
    if (!owner || Number(cb?.from?.id) !== owner) {
      await this.answer(cb, 'Эти кнопки — для владельца канала');
      return true;
    }
    const v = await this.load(parsed.shortId);
    if (!v) {
      await this.answer(cb, 'Ролик не найден');
      return true;
    }
    const chatId = Number(cb?.message?.chat?.id) || owner;
    // Кнопки проверки действуют только под тем сообщением, что сейчас на проверке.
    // После «Переснять» и замечания кнопки старого сообщения остаются, а студия,
    // собрав новую версию, обнуляет review_message_id: «Одобрить» под старым
    // отправил бы в канал версию, которую владелец не видел.
    if (parsed.action !== 'yt' && Number(cb?.message?.message_id) !== v.reviewMessageId) {
      await this.answer(cb, 'Это сообщение устарело: ролик переделан, решение — под свежим сообщением');
      return true;
    }
    switch (parsed.action) {
      case 'ok':
        await this.approve(v, cb, chatId);
        break;
      case 'note':
        await this.promptForNote(v, cb, chatId);
        break;
      case 'redo':
        await this.leave(v, cb, chatId, 'directing');
        break;
      case 'no':
        await this.leave(v, cb, chatId, 'rejected');
        break;
      case 'yt':
        await this.promptForYoutube(v, cb, chatId);
        break;
    }
    return true;
  }

  private async approve(v: ShortVideo, cb: any, chatId: number): Promise<void> {
    if (v.status !== 'pending_review') {
      await this.answer(cb, `Ролик уже обработан: ${v.status}`);
      return;
    }
    let approved: { slot: Date; now: Date } | null;
    try {
      approved = await approveShortIntoSlot(this.pg, v.id, v.slotAt, await this.settings.get());
    } catch (e: any) {
      if (!(e instanceof NoFreeSlotError)) throw e;
      this.logger.warn(`ролик ${v.id} не одобрен: ${e.message}`);
      await this.answer(cb, `Не одобрил: ${e.message}`);
      await this.notify(chatId, `Ролики: ролик${quoted(v)} не одобрен — ${e.message}.`);
      return;
    }
    if (!approved) {
      await this.answer(cb, 'Ролик уже обработан');
      return;
    }
    // Всплывашка живёт секунды — та же дата остаётся и сообщением в чате.
    const text = `Одобрено. Опубликую ${formatSlotWhen(approved.slot, approved.now)}.`;
    await this.answer(cb, text);
    await this.notify(chatId, text);
  }

  /**
   * «Переснять» (новая сцена на ту же тему) и «Отклонить». Из pending_review и
   * из approved: одобренный ролик освобождает слот и теряет одобрение
   * (`approved_at = NULL`) — новую версию человек ещё не видел. Запись — с
   * условием на статус: пока сообщение висело, ролик мог уйти в публикацию.
   */
  private async leave(v: ShortVideo, cb: any, chatId: number, target: 'directing' | 'rejected'): Promise<void> {
    const from: ShortStatus[] = ['pending_review', 'approved'];
    if (!from.includes(v.status) || !canTransition(v.status, target)) {
      await this.answer(cb, `Ролик уже обработан: ${v.status}`);
      return;
    }
    const r = await this.pg.query(
      `UPDATE short_video SET status = $2, approved_at = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = ANY($3::text[])`,
      [v.id, target, from],
    );
    if (r.rowCount === 0) {
      await this.answer(cb, 'Ролик уже обработан');
      return;
    }
    if (target === 'directing') {
      const text = 'Пересниму: новая сцена на ту же тему. Пришлю, когда будет готово.';
      await this.answer(cb, text);
      await this.notify(chatId, `Ролик${quoted(v)}: ${text}`);
    } else {
      await this.answer(cb, 'Отклонено');
    }
  }

  private async promptForNote(v: ShortVideo, cb: any, chatId: number): Promise<void> {
    if (v.status !== 'pending_review') {
      await this.answer(cb, `Ролик уже обработан: ${v.status}`);
      return;
    }
    // Ответ узнаётся по паре «чат проверки + id приглашения»; приглашение в чужом чате узнать не по чему.
    if (chatId !== v.reviewChatId) {
      await this.answer(cb, 'Этот ролик на проверке в другом чате');
      return;
    }
    await this.sendPrompt(v, 'note_prompt_ids', chatId, `Что поправить в ролике${quoted(v)}? Напишите ответом на это сообщение.`, v.reviewMessageId, NOTE_PLACEHOLDER);
    await this.answer(cb);
  }

  private async promptForYoutube(v: ShortVideo, cb: any, chatId: number): Promise<void> {
    const r = await this.pg.query(`SELECT status FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [v.id]);
    const status = r.rows[0]?.status;
    if (status !== 'manual_pending' && status !== 'manual_done') {
      await this.answer(cb, 'Набор для YouTube по этому ролику ещё не отправлялся');
      return;
    }
    await this.sendPrompt(v, 'yt_prompt_ids', chatId, `Пришлите ссылку на ролик${quoted(v)} в YouTube ответом на это сообщение.`, Number(cb?.message?.message_id) || null, LINK_PLACEHOLDER);
    await this.answer(cb);
  }

  /**
   * Приглашение с открытым полем ответа (ForceReply); id — в список ролика
   * прямо в UPDATE, а не чтением-изменением-записью: двойное касание не
   * теряет одно из приглашений (как sendNotePrompt блога).
   */
  private async sendPrompt(
    v: ShortVideo,
    column: 'note_prompt_ids' | 'yt_prompt_ids',
    chatId: number,
    text: string,
    replyTo: number | null,
    placeholder: string,
  ): Promise<void> {
    const prompt: any = await this.tg.sendMessage(chatId, text, {
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      reply_markup: { force_reply: true, input_field_placeholder: placeholder },
    });
    await this.pg.query(
      `UPDATE short_video
          SET ${column} = (${column} || $2::bigint)[greatest(cardinality(${column}) + 2 - $3, 1):]
        WHERE id = $1`,
      [v.id, Number(prompt.message_id), MAX_NOTE_PROMPTS],
    );
  }

  /**
   * Ответ на сообщение ролика или на приглашение. Своим он считается в любом
   * статусе ролика: статус решает, что ответить, а не кому уйдёт текст.
   * @returns false — сообщение не наше, его надо пустить к ассистенту
   */
  async handleReplyEdit(msg: any): Promise<boolean> {
    const chatId = Number(msg?.chat?.id);
    const replyTo = Number(msg?.reply_to_message?.message_id);
    if (!chatId || !replyTo) return false;
    // Ролик на проверку уходит только апруверу. Реплай из другого чата — не наш, и
    // базу он не трогает: иначе каждый реплай пользователя ассистенту шёл бы через
    // short_video, а без таблицы (сорвался первый накат) падал бы и не доходил.
    if (chatId !== approverChatId()) return false;
    const r = await this.pg.query(
      `SELECT * FROM short_video
        WHERE review_chat_id = $1
          AND (review_message_id = $2 OR $2 = ANY(note_prompt_ids) OR $2 = ANY(yt_prompt_ids))
        LIMIT 1`,
      [chatId, replyTo],
    );
    if (!r.rows.length) return false;
    const v = rowToShort(r.rows[0]);

    if (v.ytPromptIds.includes(replyTo)) {
      await this.acceptYoutubeLink(v, msg, chatId);
      return true;
    }
    if (v.status !== 'pending_review') {
      await this.tg.sendMessage(chatId, noteRefusal(v.status));
      return true;
    }
    const text = String(msg?.text || '').trim();
    if (!text) {
      await this.sendPrompt(v, 'note_prompt_ids', chatId, `Замечание к ролику${quoted(v)} принимаю только текстом — напишите его ответом на это сообщение.`, Number(msg?.message_id) || null, NOTE_PLACEHOLDER);
      return true;
    }
    // writer_rounds = 0: новый круг владельца, счётчик автоматических переписок студии — заново.
    const w = await this.pg.query(
      `UPDATE short_video
          SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0,
              lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review'`,
      [v.id, appendOwnerNote(v.ownerNote, text)],
    );
    if (w.rowCount === 0) {
      const now = await this.load(v.id);
      await this.tg.sendMessage(chatId, noteRefusal(now?.status ?? v.status));
      return true;
    }
    await this.tg.sendMessage(chatId, 'Принял замечание — поправлю ролик и пришлю заново.');
    return true;
  }

  private async acceptYoutubeLink(v: ShortVideo, msg: any, chatId: number): Promise<void> {
    const link = parseYoutubeUrl(msg?.text);
    if (!link) {
      await this.sendPrompt(v, 'yt_prompt_ids', chatId, 'Не узнал ссылку на YouTube. Пришлите ссылку вида https://youtube.com/shorts/… ответом на это сообщение.', Number(msg?.message_id) || null, LINK_PLACEHOLDER);
      return;
    }
    const r = await this.pg.query(
      `UPDATE short_publication
          SET status = 'manual_done', url = $2, external_id = $3, published_at = coalesce(published_at, now()),
              last_error = NULL, updated_at = now()
        WHERE short_id = $1 AND platform = 'youtube' AND status IN ('manual_pending', 'manual_done')`,
      [v.id, link.url, link.videoId],
    );
    await this.tg.sendMessage(
      chatId,
      r.rowCount ? `Записал ссылку YouTube: ${link.url}` : 'Набор для YouTube по этому ролику не отправлялся — ссылку не записал.',
    );
  }

  /**
   * `/short <тема или история>` — только владелец, только в личке и только при
   * включённых роликах; иначе команда не наша, и бот ответит как на
   * неизвестную. Одно сообщение — не больше одного заказа (ключ сообщения).
   */
  async handleShortCommand(msg: any): Promise<boolean> {
    const text = shortCommandText(msg?.text);
    if (text === null || !shortsEnabled()) return false;
    if (msg?.chat?.type !== 'private') return false;
    const owner = approverChatId();
    if (!owner || Number(msg?.from?.id) !== owner) return false;

    const chatId = Number(msg?.chat?.id) || owner;
    if (Array.from(text).length < MIN_ORDER_CHARS) {
      await this.notify(chatId, 'Как заказать ролик: /short и следом тема или история — можно в несколько строк.');
      return true;
    }
    const messageId = Number(msg?.message_id);
    try {
      const v = await this.topics.addManual({
        topic: text,
        rubric: 'case',
        sourceRef: messageId > 0 ? `tg:${chatId}:${messageId}` : null,
      });
      if (!v) {
        await this.notify(chatId, 'По этому сообщению ролик уже заказан — второй раз не завожу.');
        return true;
      }
      const next = autoTopicsEnabled()
        ? 'Пришлю ролик на проверку, когда до него дойдёт очередь.'
        : 'Автозапуск выключен — запустите ролик из админки.';
      await this.notify(chatId, `Принял заказ ролика: ${Array.from(text).length} знаков, кончается на «${ending(text)}». ${next}`);
    } catch (e: any) {
      await this.notify(chatId, `Не завёл ролик: ${e.message}`);
    }
    return true;
  }

  /** Упавшие ролики — владельцу, каждый один раз (захват по failure_notified). */
  async notifyFailures(limit = 5): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const r = await this.pg.query(
        `UPDATE short_video SET failure_notified = true
          WHERE id = (
            SELECT id FROM short_video
             WHERE status = 'failed' AND NOT failure_notified
             ORDER BY updated_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED)
          RETURNING *`,
      );
      if (!r.rows.length) return;
      const v = rowToShort(r.rows[0]);
      const what = v.failedFrom === 'publishing' ? 'не вышел на площадки' : 'не собрался';
      await this.notify(
        approverChatId(),
        `${isStand() ? STAND_MARK : ''}Ролик${quoted(v)} ${what}: ${clip(v.lastError || 'причина не записана', 600)}\nПовторить можно из админки: retry.`,
      );
    }
  }

  private async answer(cb: any, text?: string): Promise<void> {
    try {
      await this.tg.answerCallbackQuery(cb.id, text ? { text } : {});
    } catch (e: any) {
      this.logger.warn(`answerCallbackQuery: ${e.message}`);
    }
  }

  private async load(id: string): Promise<ShortVideo | null> {
    const r = await this.pg.query(`SELECT * FROM short_video WHERE id = $1`, [id]);
    return r.rows[0] ? rowToShort(r.rows[0]) : null;
  }
}
```

- [ ] **Step 5: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-approval.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add src/shorts/short-env.ts src/shorts/shorts-approval.service.ts
git -C "$WT" commit -m "feat(shorts): одобрение в Telegram — видео, кнопки, замечание, /short, сбои

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Публикация — Telegram-канал и набор для YouTube

Каждая площадка ведётся своей строкой `short_publication`. Номер поста записывается в той же записи, что отметка о публикации. Повтор трогает только упавшую площадку. Набор для YouTube уходит владельцу, когда вышел Telegram.

**Files:**
- Create: `src/shorts/shorts-publisher.service.ts`
- Test: `src/shorts/shorts-publisher.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts-publisher.service.spec.ts`:

```ts
import { InputFile } from 'grammy';
import { buildYoutubeKeyboard } from './short-callback';
import { ShortsPublisherService } from './shorts-publisher.service';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;

/** База в миниатюре: ровно те запросы, что делает публикатор. */
function fakeDb(over: Record<string, any> = {}) {
  const v: any = {
    id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', title: 'Залог', slug: 'zalog_ab12',
    status: 'approved', attempts: 0, video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', duration_ms: 44000,
    captions: { telegram: 'TG-подпись', vk: 'VK', youtube: { title: 'YT-заголовок', description: 'YT-описание', tags: ['аренда'] } },
    ...over,
  };
  const pubs = new Map<string, any>();
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith("UPDATE short_video SET status = 'publishing'")) {
      if (v.status !== 'approved') return { rows: [] };
      v.status = 'publishing';
      v.attempts += 1;
      return { rows: [{ ...v }] };
    }
    if (s.startsWith('INSERT INTO short_publication')) {
      if (!pubs.has(p[1])) pubs.set(p[1], { short_id: p[0], platform: p[1], status: 'pending', attempts: 0 });
      return { rows: [] };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'publishing'")) {
      const row = pubs.get(p[1]);
      if (!row || !['pending', 'failed'].includes(row.status)) return { rows: [] };
      row.status = 'publishing';
      row.attempts += 1;
      return { rows: [{ ...row }] };
    }
    if (s.startsWith('UPDATE short_publication SET status = $3')) {
      Object.assign(pubs.get(p[1]), { status: p[2], external_id: p[3], url: p[4], last_error: null });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'failed'")) {
      Object.assign(pubs.get(p[1]), { status: 'failed', last_error: p[2] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM short_publication')) return { rows: [...pubs.values()].map((r) => ({ ...r })) };
    const m = s.match(/^UPDATE short_video SET status = '(published|approved|failed)'/);
    if (m) {
      v.status = m[1];
      if (m[1] !== 'published') v.last_error = p[1];
      if (m[1] === 'failed') v.failed_from = 'publishing';
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, v, pubs };
}

function setup(db = fakeDb(), channel: string | null = '-1003290853538') {
  const tg = {
    sendVideo: jest.fn(async () => ({ message_id: 501, chat: { id: -1003290853538, username: 'linkeontest' } })),
    sendDocument: jest.fn(async () => ({ message_id: 601 })),
    sendMessage: jest.fn(async () => ({ message_id: 602 })),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ platforms: ['telegram', 'youtube'], tgChannelChatId: channel })) };
  const svc = new ShortsPublisherService({ query: db.query } as any, tg as any, storage as any, settings as any);
  return { svc, tg, db };
}

describe('ShortsPublisherService.publish', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.BLOG_APPROVER_TG_ID = String(OWNER);
    delete process.env.SHORTS_STAND;
  });
  afterAll(() => {
    process.env = env;
  });

  it('Telegram байтами с обложкой, затем набор YouTube; ролик опубликован', async () => {
    const { svc, tg, db } = setup();
    await svc.publish(ID);

    const [chat, bytes, opts] = tg.sendVideo.mock.calls[0] as any[];
    expect(chat).toBe(-1003290853538);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(opts).toMatchObject({ caption: 'TG-подпись', supports_streaming: true, width: 1080, height: 1920, duration: 44 });
    expect(opts.thumbnail).toBeInstanceOf(InputFile);
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'published', external_id: '501', url: 'https://t.me/linkeontest/501' });

    const [docChat, , filename] = tg.sendDocument.mock.calls[0] as any[];
    expect([docChat, filename]).toEqual([OWNER, 'linkeon-zalog_ab12.mp4']);
    const [msgChat, text, msgOpts] = tg.sendMessage.mock.calls[0] as any[];
    expect(msgChat).toBe(OWNER);
    expect(text).toContain('YouTube — заголовок:\nYT-заголовок');
    expect(text).toContain('YT-описание');
    expect(msgOpts.reply_markup).toEqual(buildYoutubeKeyboard(ID));
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending', external_id: '602' });
    expect(db.v.status).toBe('published');
  });

  it('канал не настроен — Telegram упал, набора YouTube нет, ролик ждёт повтора', async () => {
    const { svc, tg, db } = setup(fakeDb(), null);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram').status).toBe('failed');
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).toMatch(/telegram: канал Telegram не настроен/);
  });

  it('третья неудачная попытка — failed с этапом publishing', async () => {
    const { svc, db } = setup(fakeDb({ attempts: 2 }), null);
    await svc.publish(ID);
    expect([db.v.status, db.v.failed_from]).toEqual(['failed', 'publishing']);
  });

  it('повтор шлёт только упавшее: Telegram второй раз не уходит', async () => {
    const { svc, tg, db } = setup();
    tg.sendDocument.mockRejectedValueOnce(new Error('файл не принят'));
    await svc.publish(ID);
    expect(db.v.status).toBe('approved');
    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect(tg.sendDocument).toHaveBeenCalledTimes(2);
    expect(db.v.status).toBe('published');
  });

  it('ролик не в approved — ничего не отправляется', async () => {
    const { svc, tg } = setup(fakeDb({ status: 'pending_review' }));
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts-publisher.service.spec.ts
git -C "$WT" commit -m "test(shorts): публикация в Telegram и набор YouTube (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-publisher.service.spec.ts"`
Expected: FAIL — `Cannot find module './shorts-publisher.service'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts-publisher.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InputFile } from 'grammy';
import { approverChatId } from '../blog/blog-approval.service';
import { buildPostUrl } from '../blog/blog-publisher.service';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildYoutubeKeyboard } from './short-callback';
import { STAND_MARK, clip } from './short-captions';
import { isStand } from './short-env';
import { SUPPORTED_PLATFORMS, ShortSettings, ShortsSettingsService } from './shorts-settings.service';
import { ShortPlatform, ShortPublication, ShortVideo, rowToPublication, rowToShort, shortsBucket } from './shorts.types';

/** Сколько раз ролик пробует выйти. Попытку считает захват, счётчик переживает рестарт. */
export const MAX_PUBLISH_ATTEMPTS = 3;
/** Отправка ролика — секунды; ролик в publishing дольше — осиротевший: процесс умер посреди публикации. */
export const STUCK_PUBLISHING_MINUTES = 10;

/** Площадка своё отработала: вышла сама или ушла владельцу набором. */
const SETTLED = ['published', 'manual_pending', 'manual_done'];

interface PlatformResult {
  status: 'published' | 'manual_pending';
  externalId: string;
  url: string | null;
}

@Injectable()
export class ShortsPublisherService {
  private readonly logger = new Logger(ShortsPublisherService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
  ) {}

  /** Одобренные ролики, чей слот наступил. */
  async publishDue(): Promise<void> {
    const due = await this.pg.query(
      `SELECT id FROM short_video WHERE status = 'approved' AND slot_at <= now() ORDER BY slot_at LIMIT 3`,
    );
    for (const row of due.rows) {
      try {
        await this.publish(row.id);
      } catch (e: any) {
        this.logger.error(`публикация ${row.id} сорвалась: ${e.message}`);
      }
    }
  }

  /**
   * Захват `approved → publishing` атомарный: два тика или два процесса дают
   * один пост. Дальше — по площадкам: Telegram, затем набор YouTube (только
   * когда Telegram вышел). Итог — `published`, возврат в `approved` под
   * повтор или, когда попытки кончились, `failed` с сообщением владельцу.
   */
  async publish(id: string): Promise<void> {
    const claim = await this.pg.query(
      `UPDATE short_video SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'approved' AND slot_at <= now()
        RETURNING *`,
      [id],
    );
    if (!claim.rows.length) return;
    const v = rowToShort(claim.rows[0]);
    const settings = await this.settings.get();
    const platforms = settings.platforms.filter((p) => SUPPORTED_PLATFORMS.includes(p));
    for (const p of platforms) {
      await this.pg.query(
        `INSERT INTO short_publication (short_id, platform, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (short_id, platform) DO NOTHING`,
        [v.id, p],
      );
    }
    if (platforms.includes('telegram')) await this.platform(v, 'telegram', () => this.toTelegram(v, settings));
    const telegramDone = !platforms.includes('telegram') || (await this.rows(v.id)).some((r) => r.platform === 'telegram' && r.status === 'published');
    if (platforms.includes('youtube') && telegramDone) await this.platform(v, 'youtube', () => this.youtubeKit(v));
    await this.settle(v, platforms);
  }

  /**
   * Сторож: публикация, оборванная рестартом, иначе висела бы вечно. Площадка
   * в `publishing` становится `failed` и уйдёт повтором — пост в Telegram при
   * этом может выйти второй раз, если оборвался ответ, а не отправка. Блог
   * живёт с тем же риском (STUCK_PUBLISHING_MINUTES в blog.cron.ts).
   */
  async rearmStuck(): Promise<void> {
    await this.pg.query(
      `UPDATE short_publication
          SET status = 'failed', last_error = 'отправка оборвалась — процесс перезапущен посреди публикации', updated_at = now()
        WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $1)`,
      [STUCK_PUBLISHING_MINUTES],
    );
    await this.pg.query(
      `UPDATE short_video SET status = 'approved', updated_at = now()
        WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $1)`,
      [STUCK_PUBLISHING_MINUTES],
    );
  }

  /** Площадка: захват строки (только pending/failed), отправка, отметка вместе с номером поста. */
  private async platform(v: ShortVideo, platform: ShortPlatform, send: () => Promise<PlatformResult>): Promise<void> {
    const claim = await this.pg.query(
      `UPDATE short_publication SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE short_id = $1 AND platform = $2 AND status IN ('pending', 'failed')
        RETURNING *`,
      [v.id, platform],
    );
    if (!claim.rows.length) return;
    try {
      const out = await send();
      await this.pg.query(
        `UPDATE short_publication
            SET status = $3, external_id = $4, url = $5, last_error = NULL,
                published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status = 'publishing'`,
        [v.id, platform, out.status, out.externalId, out.url],
      );
    } catch (e: any) {
      this.logger.error(`ролик ${v.id}, ${platform}: ${e.message}`);
      await this.pg.query(
        `UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status = 'publishing'`,
        [v.id, platform, String(e?.message ?? e).slice(0, 500)],
      );
    }
  }

  /** Telegram-канал: тот же бот, что у блога, видео байтами с обложкой и подписью до 1000 знаков. */
  private async toTelegram(v: ShortVideo, s: ShortSettings): Promise<PlatformResult> {
    if (!s.tgChannelChatId) throw new Error('канал Telegram не настроен (short_settings.tg_channel_chat_id)');
    if (!v.videoKey || !v.coverKey || !v.captions) throw new Error('у ролика нет файла, обложки или подписей');
    const bucket = shortsBucket();
    const [video, cover] = await Promise.all([
      this.storage.download({ bucket, key: v.videoKey }),
      this.storage.download({ bucket, key: v.coverKey }),
    ]);
    const msg: any = await this.tg.sendVideo(Number(s.tgChannelChatId), video, {
      caption: v.captions.telegram,
      thumbnail: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    });
    const messageId = Number(msg.message_id);
    return {
      status: 'published',
      externalId: String(messageId),
      url: buildPostUrl({ id: Number(msg.chat?.id ?? s.tgChannelChatId), username: msg.chat?.username }, messageId),
    };
  }

  /**
   * YouTube, пока Google не проверил приложение: владельцу — файл документом
   * (без пережатия), заголовок, описание, теги и кнопка «Выложил на YouTube».
   */
  private async youtubeKit(v: ShortVideo): Promise<PlatformResult> {
    const chatId = approverChatId();
    if (!chatId) throw new Error('BLOG_APPROVER_TG_ID не задан — набор для YouTube отправить некому');
    if (!v.videoKey || !v.captions) throw new Error('у ролика нет файла или подписей');
    const video = await this.storage.download({ bucket: shortsBucket(), key: v.videoKey });
    const mark = isStand() ? STAND_MARK : '';
    const yt = v.captions.youtube;
    await this.tg.sendDocument(chatId, video, `linkeon-${v.slug ?? v.id}.mp4`, {
      caption: clip(`${mark}Набор для YouTube Shorts — файл ролика${v.title ? ` «${v.title}»` : ''}.`, 1000),
    });
    const msg: any = await this.tg.sendMessage(
      chatId,
      `${mark}YouTube — заголовок:\n${yt.title}\n\nОписание:\n${yt.description}\n\nТеги: ${yt.tags.join(', ')}\n\n` +
        'Когда выложите, нажмите кнопку и пришлите ссылку ответом.',
      { reply_markup: buildYoutubeKeyboard(v.id) },
    );
    return { status: 'manual_pending', externalId: String(msg.message_id), url: null };
  }

  private async settle(v: ShortVideo, platforms: ShortPlatform[]): Promise<void> {
    const rows = (await this.rows(v.id)).filter((r) => platforms.includes(r.platform));
    if (rows.every((r) => SETTLED.includes(r.status))) {
      await this.pg.query(
        `UPDATE short_video SET status = 'published', published_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id],
      );
      this.logger.log(`ролик ${v.id} опубликован`);
      return;
    }
    const problems = rows
      .filter((r) => !SETTLED.includes(r.status))
      .map((r) => `${r.platform}: ${r.lastError ?? r.status}`)
      .join('; ');
    const message = `публикация: ${problems}`.slice(0, 1000);
    if (v.attempts >= MAX_PUBLISH_ATTEMPTS) {
      await this.pg.query(
        `UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = $2,
                failure_notified = false, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id, message],
      );
    } else {
      // Тот же slot_at: строка та же, индекс одного ролика на слот её пропустит.
      await this.pg.query(
        `UPDATE short_video SET status = 'approved', last_error = $2, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id, message],
      );
    }
  }

  private async rows(id: string): Promise<ShortPublication[]> {
    const r = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    return r.rows.map(rowToPublication);
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts-publisher.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts-publisher.service.ts
git -C "$WT" commit -m "feat(shorts): публикация в Telegram-канал и набор для YouTube по площадкам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Крон конвейера

Четыре тика:
- **наполнение недели** — вс 10:00 МСК;
- **запуск к слоту** — каждые 10 минут;
- **работа** — каждую минуту: режиссёр, сценарист, отправка владельцу, сообщения о сбоях;
- **публикация** — каждые 5 минут.

Без `SHORTS_ENABLED=true` не делает ничего. Наполнение и запуск требуют ещё `SHORTS_AUTO_TOPICS=true`. Сбой одного шага не останавливает остальные.

**Files:**
- Create: `src/shorts/shorts.cron.ts`
- Test: `src/shorts/shorts.cron.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts.cron.spec.ts`:

```ts
import { ShortsCron } from './shorts.cron';

function setup() {
  // claimStage('directing') отдаёт ролик, claimStage('writing') — ничего; остальное — запись.
  const pg = {
    query: jest.fn(async (_sql: string, params: any[] = []) =>
      params[0] === 'directing'
        ? { rows: [{ id: 'v1', status: 'directing', attempts: 1, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't' }] }
        : { rows: [], rowCount: 1 }),
  };
  const topics = { refillWeek: jest.fn(async () => 3), start: jest.fn(async (): Promise<any> => null) };
  const director = { direct: jest.fn(async () => { throw new Error('релей молчит'); }) };
  const writer = { write: jest.fn(async () => {}) };
  const approval = { sendPendingReviews: jest.fn(async () => {}), notifyFailures: jest.fn(async () => {}) };
  const publisher = { rearmStuck: jest.fn(async () => {}), publishDue: jest.fn(async () => {}) };
  const cron = new ShortsCron(pg as any, topics as any, director as any, writer as any, approval as any, publisher as any);
  return { cron, pg, topics, director, writer, approval, publisher };
}

describe('ShortsCron', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.SHORTS_ENABLED;
    delete process.env.SHORTS_AUTO_TOPICS;
  });
  afterAll(() => {
    process.env = env;
  });

  it('без SHORTS_ENABLED — ни одного действия', async () => {
    const d = setup();
    await d.cron.refillTopics();
    await d.cron.prepare();
    await d.cron.work();
    await d.cron.publishDue();
    expect(d.pg.query).not.toHaveBeenCalled();
    expect(d.topics.start).not.toHaveBeenCalled();
    expect(d.publisher.publishDue).not.toHaveBeenCalled();
  });

  it('включено без автозапуска: конвейер идёт, очередь сама не наполняется', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const d = setup();
    await d.cron.refillTopics();
    await d.cron.prepare();
    expect(d.topics.refillWeek).not.toHaveBeenCalled();
    expect(d.topics.start).not.toHaveBeenCalled();

    await d.cron.work();
    expect(d.director.direct).toHaveBeenCalledTimes(1);
    const retry = d.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('make_interval(secs => $3)')) as any[];
    expect(retry[1]).toEqual(['v1', 'directing', 60, 'режиссёр: релей молчит', 1]);
    expect(d.writer.write).not.toHaveBeenCalled();
    expect(d.approval.sendPendingReviews).toHaveBeenCalled();
    expect(d.approval.notifyFailures).toHaveBeenCalled();

    await d.cron.publishDue();
    expect(d.publisher.rearmStuck).toHaveBeenCalled();
    expect(d.publisher.publishDue).toHaveBeenCalled();
  });

  it('с автозапуском — наполнение недели и запуск к слоту без обхода ограничений', async () => {
    process.env.SHORTS_ENABLED = 'true';
    process.env.SHORTS_AUTO_TOPICS = 'true';
    const d = setup();
    await d.cron.refillTopics();
    await d.cron.prepare();
    expect(d.topics.refillWeek).toHaveBeenCalled();
    expect(d.topics.start).toHaveBeenCalledWith({ force: false });
  });

  it('сбой одного шага не останавливает следующие', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const d = setup();
    d.approval.sendPendingReviews.mockRejectedValue(new Error('Telegram лежит'));
    await d.cron.work();
    expect(d.approval.notifyFailures).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts.cron.spec.ts
git -C "$WT" commit -m "test(shorts): тики конвейера (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.cron.spec.ts"`
Expected: FAIL — `Cannot find module './shorts.cron'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts.cron.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { autoTopicsEnabled, shortsEnabled } from './short-env';
import { ApiStage, claimStage, stageFailed, withStageDeadline } from './short-jobs';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsDirectorService } from './shorts-director.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsWriterService } from './shorts-writer.service';
import { ShortVideo } from './shorts.types';

/**
 * Тики конвейера роликов. ScheduleModule подключён глобально (app.module.ts),
 * @Cron заводится сам, как у BlogCron. Тики одного процесса могут
 * перекрываться, процессов API может быть несколько — от дублей защищают
 * захваты с арендой в самих шагах, а не очерёдность тиков.
 */
@Injectable()
export class ShortsCron {
  private readonly logger = new Logger(ShortsCron.name);

  constructor(
    private readonly pg: PgService,
    private readonly topics: ShortsTopicService,
    private readonly director: ShortsDirectorService,
    private readonly writer: ShortsWriterService,
    private readonly approval: ShortsApprovalService,
    private readonly publisher: ShortsPublisherService,
  ) {}

  /** Воскресенье 10:00 МСК — через час после наполнения блога. */
  @Cron('0 7 * * 0')
  async refillTopics(): Promise<void> {
    if (!shortsEnabled() || !autoTopicsEnabled()) return;
    await this.step('наполнение недели', () => this.topics.refillWeek());
  }

  @Cron('*/10 * * * *')
  async prepare(): Promise<void> {
    if (!shortsEnabled() || !autoTopicsEnabled()) return;
    await this.step('запуск к слоту', async () => {
      const v = await this.topics.start({ force: false });
      if (v) this.logger.log(`ролик ${v.id} запущен под слот ${v.slotAt?.toISOString()} (подача ${v.angle})`);
    });
  }

  @Cron('* * * * *')
  async work(): Promise<void> {
    if (!shortsEnabled()) return;
    await this.step('режиссёр', () => this.runStage('directing', 'режиссёр', (v) => this.director.direct(v)));
    await this.step('сценарист', () => this.runStage('writing', 'сценарист', (v) => this.writer.write(v)));
    await this.step('отправка владельцу', () => this.approval.sendPendingReviews());
    await this.step('сообщения о сбоях', () => this.approval.notifyFailures());
  }

  @Cron('*/5 * * * *')
  async publishDue(): Promise<void> {
    if (!shortsEnabled()) return;
    await this.step('сторож публикаций', () => this.publisher.rearmStuck());
    await this.step('публикация', () => this.publisher.publishDue());
  }

  /** Один ролик этапа: захват с арендой, работа, при сбое — повтор с паузой или failed. */
  async runStage(status: ApiStage, label: string, run: (v: ShortVideo) => Promise<void>): Promise<void> {
    const v = await claimStage(this.pg, status);
    if (!v) return;
    try {
      // Срок этапа короче аренды: таймаут axios не действует после заголовков
      // ответа, и зависший релей иначе держал бы этап, пока его не заберёт второй процесс.
      await withStageDeadline(() => run(v));
    } catch (e: any) {
      const outcome = await stageFailed(this.pg, v, label, e);
      const what = outcome === 'retry' ? `повтор, попытка ${v.attempts}` : outcome === 'gone' ? 'ролик уже не на этапе' : 'failed';
      this.logger.warn(`ролик ${v.id}: ${label} — ${e?.message ?? e} (${what})`);
    }
  }

  private async step(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e: any) {
      this.logger.error(`тик роликов, ${name}: ${e?.message ?? e}`);
    }
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.cron.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts.cron.ts
git -C "$WT" commit -m "feat(shorts): тики конвейера под рубильниками SHORTS_ENABLED и SHORTS_AUTO_TOPICS

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Админский API роликов

`POST admin/shorts` с действием в теле, как у `admin/blog`. Вкладки в кабинете в этом плане нет (план 3). На стенде это единственный способ запустить ролик (`start_now`) и выпустить одобренный, не дожидаясь слота (`publish_now`).

**Files:**
- Create: `src/shorts/shorts.controller.ts`
- Test: `src/shorts/shorts.controller.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/shorts.controller.spec.ts`:

```ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { SHORT_SLOT_INDEX } from './short-slot-claim';
import { ShortOrderError } from './shorts-topic.service';
import { ShortsController } from './shorts.controller';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const video = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', status: 'failed',
  failed_from: 'capturing', video_key: 'shorts/v/video.mp4', cover_key: null, ...over,
});

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn((body: any) => {
    r.body = body;
    return r;
  });
  return r;
}

function setup(answer: (sql: string, params: any[]) => any = () => ({ rows: [], rowCount: 0 })) {
  const pg = { query: jest.fn(async (sql: string, params: any[] = []) => answer(sql, params)) };
  const settings = { get: jest.fn(async () => ({ slotDays: [2, 4, 6] })), update: jest.fn(async (p: any) => p) };
  const topics = { addManual: jest.fn(async () => ({ id: 'new' })), start: jest.fn(async (): Promise<any> => ({ id: ID, status: 'directing' })) };
  const storage = { publicUrl: jest.fn((b: string, k: string) => `https://minio.test/${b}/${k}`) };
  const ctl = new ShortsController(pg as any, settings as any, topics as any, storage as any);
  return { ctl, pg, settings, topics, storage };
}

describe('POST admin/shorts', () => {
  it('закрыт JWT и правами админа', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ShortsController.prototype.action);
    expect(guards).toEqual([JwtGuard, AdminGuard]);
  });

  it('list — ролики со статусами площадок', async () => {
    const { ctl } = setup((sql) =>
      sql.includes('FROM short_publication')
        ? { rows: [{ short_id: ID, platform: 'telegram', status: 'published' }] }
        : { rows: [video({ status: 'published' })] });
    const r = res();
    await ctl.action({ action: 'list' }, r);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].publications[0]).toMatchObject({ platform: 'telegram', status: 'published' });
  });

  it('get — ссылки на видео; кривой id — 400, нет ролика — 404', async () => {
    const { ctl } = setup((sql) => (sql.includes('FROM short_video') ? { rows: [video()] } : { rows: [] }));
    const r = res();
    await ctl.action({ action: 'get', id: ID }, r);
    expect(r.body.videoUrl).toBe('https://minio.test/linkeon-smm-videos/shorts/v/video.mp4');
    expect(r.body.coverUrl).toBeNull();
    await expect(ctl.action({ action: 'get', id: 'x' }, res())).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup().ctl.action({ action: 'get', id: ID }, res())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('order — поля заказа; ошибка проверки — 400', async () => {
    const { ctl, topics } = setup();
    await ctl.action({ action: 'order', topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 }, res());
    expect(topics.addManual).toHaveBeenCalledWith({ topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 });
    topics.addManual.mockRejectedValueOnce(new ShortOrderError('тема — от 10 до 4000 знаков, сейчас 3'));
    await expect(ctl.action({ action: 'order', topic: 'abc' }, res())).rejects.toBeInstanceOf(BadRequestException);
    topics.addManual.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(ctl.action({ action: 'order', topic: 'Разнос плохого договора' }, res())).rejects.not.toBeInstanceOf(BadRequestException);
  });

  it('start_now — запуск в обход ограничений; нечего запускать — 409', async () => {
    const { ctl, topics } = setup();
    await ctl.action({ action: 'start_now', id: ID }, res());
    expect(topics.start).toHaveBeenCalledWith({ id: ID, force: true });
    topics.start.mockResolvedValueOnce(null);
    await expect(ctl.action({ action: 'start_now' }, res())).rejects.toBeInstanceOf(ConflictException);
  });

  it('publish_now — только одобренный; занятый момент — 409 slot_taken', async () => {
    const ok = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ status: 'approved' })] }));
    const r = res();
    await ok.ctl.action({ action: 'publish_now', id: ID }, r);
    expect(ok.pg.query.mock.calls.some((c: any[]) => String(c[0]).includes('SET slot_at = now()'))).toBe(true);

    const notApproved = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [] } : { rows: [video({ status: 'pending_review' })] }));
    await expect(notApproved.ctl.action({ action: 'publish_now', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);

    const conflict = setup((sql) => {
      if (sql.startsWith('UPDATE')) throw Object.assign(new Error('dup'), { code: '23505', constraint: SHORT_SLOT_INDEX });
      return { rows: [video({ status: 'approved' })] };
    });
    await expect(conflict.ctl.action({ action: 'publish_now', id: ID }, res())).rejects.toThrow('slot_taken');
  });

  it('retry — с этапа, на котором упал; публикация — только одобренного', async () => {
    const capture = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'capture_queued' })] } : { rows: [video()] }));
    await capture.ctl.action({ action: 'retry', id: ID }, res());
    const upd = capture.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("WHERE id = $1 AND status = 'failed'")) as any[];
    expect(upd[1]).toEqual([ID, 'capture_queued', 'capturing']);

    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await pub.ctl.action({ action: 'retry', id: ID }, res());
    expect(pub.pg.query.mock.calls.some((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'pending'"))).toBe(true);

    const never = setup(() => ({ rows: [video({ failed_from: 'publishing', approved_at: null })] }));
    await expect(never.ctl.action({ action: 'retry', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
  });

  it('настройки: чтение, правка с проверкой', async () => {
    const { ctl, settings } = setup();
    const r = res();
    await ctl.action({ action: 'get_settings' }, r);
    expect(r.body).toEqual({ slotDays: [2, 4, 6] });
    await ctl.action({ action: 'update_settings', settings: { slotHourMsk: 19 } }, res());
    expect(settings.update).toHaveBeenCalledWith({ slotHourMsk: 19 });
    await expect(ctl.action({ action: 'update_settings', settings: { slotHourMsk: 99 } }, res())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('неизвестное действие — 400', async () => {
    await expect(setup().ctl.action({ action: 'boom' }, res())).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add src/shorts/shorts.controller.spec.ts
git -C "$WT" commit -m "test(shorts): админский API роликов (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts"`
Expected: FAIL — `Cannot find module './shorts.controller'`.

- [ ] **Step 3: Реализация**

`src/shorts/shorts.controller.ts`:

```ts
import { BadRequestException, Body, ConflictException, Controller, NotFoundException, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { isShortSlotConflict } from './short-slot-claim';
import { ShortSettingsPatch, ShortsSettingsService, validateSettingsPatch } from './shorts-settings.service';
import { ShortOrderError, ShortsTopicService } from './shorts-topic.service';
import { ShortPublication, ShortVideo, retryTarget, rowToPublication, rowToShort, shortsBucket } from './shorts.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Админка роликов: действия в одном POST, как admin/blog. Вкладка кабинета
 * появится в плане 3. На стенде это единственный способ запустить ролик
 * (`start_now`) и выпустить одобренный, не дожидаясь слота (`publish_now`).
 *
 * Записи статуса — с условием на статус, как везде в модуле: две вкладки
 * админки и кнопки в личке не перетирают решения друг друга.
 */
@Controller('')
export class ShortsController {
  constructor(
    private readonly pg: PgService,
    private readonly settings: ShortsSettingsService,
    private readonly topics: ShortsTopicService,
    private readonly storage: StorageService,
  ) {}

  @Post('admin/shorts')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};
    switch (action) {
      case 'list':
        return res.status(200).json(await this.list());
      case 'get':
        return res.status(200).json(await this.getOne(String(data.id ?? '')));
      case 'order': {
        let v: ShortVideo | null;
        try {
          v = await this.topics.addManual({
            topic: data.topic,
            rubric: data.rubric,
            angle: data.angle ?? null,
            assistantId: data.assistantId ?? null,
          });
        } catch (e: any) {
          // 400 — только на ошибку проверки заказа; сбой базы остаётся 500, а не «плохим запросом».
          if (e instanceof ShortOrderError) throw new BadRequestException(e.message);
          throw e;
        }
        return res.status(200).json(v);
      }
      case 'start_now': {
        if (data.id && !UUID.test(String(data.id))) throw new BadRequestException('id ролика — uuid');
        const v = await this.topics.start({ id: data.id || undefined, force: true });
        if (!v) {
          throw new ConflictException(
            data.id
              ? 'не запустил: ролик не в статусе idea или запуск идёт параллельно — попробуйте ещё раз'
              : 'не запустил: в очереди нет идей или запуск идёт параллельно — попробуйте ещё раз',
          );
        }
        return res.status(200).json(v);
      }
      case 'publish_now':
        return res.status(200).json(await this.publishNow(String(data.id ?? '')));
      case 'retry':
        return res.status(200).json(await this.retry(String(data.id ?? '')));
      case 'get_settings':
        return res.status(200).json(await this.settings.get());
      case 'update_settings': {
        let patch: ShortSettingsPatch;
        try {
          patch = validateSettingsPatch(data.settings);
        } catch (e: any) {
          throw new BadRequestException(e.message);
        }
        return res.status(200).json(await this.settings.update(patch));
      }
      default:
        throw new BadRequestException(`неизвестное действие: ${action}`);
    }
  }

  private async list(): Promise<Array<ShortVideo & { publications: ShortPublication[] }>> {
    const r = await this.pg.query(`SELECT * FROM short_video ORDER BY created_at DESC LIMIT 100`);
    const videos = r.rows.map(rowToShort);
    const pubs = videos.length
      ? await this.pg.query(`SELECT * FROM short_publication WHERE short_id = ANY($1::uuid[])`, [videos.map((v) => v.id)])
      : { rows: [] };
    const byVideo = new Map<string, ShortPublication[]>();
    for (const p of pubs.rows.map(rowToPublication)) byVideo.set(p.shortId, [...(byVideo.get(p.shortId) ?? []), p]);
    return videos.map((v) => ({ ...v, publications: byVideo.get(v.id) ?? [] }));
  }

  private async getOne(id: string) {
    const v = await this.load(id);
    const pubs = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    const bucket = shortsBucket();
    return {
      ...v,
      publications: pubs.rows.map(rowToPublication),
      videoUrl: v.videoKey ? this.storage.publicUrl(bucket, v.videoKey) : null,
      coverUrl: v.coverKey ? this.storage.publicUrl(bucket, v.coverKey) : null,
    };
  }

  /** Одобренный ролик — в публикацию на ближайшем тике (раз в 5 минут), не дожидаясь слота. */
  private async publishNow(id: string): Promise<ShortVideo> {
    await this.load(id);
    let r: any;
    try {
      r = await this.pg.query(
        `UPDATE short_video SET slot_at = now(), updated_at = now() WHERE id = $1 AND status = 'approved' RETURNING *`,
        [id],
      );
    } catch (e: any) {
      if (isShortSlotConflict(e)) throw new ConflictException('slot_taken');
      throw e;
    }
    if (!r.rows.length) throw new ConflictException('опубликовать сейчас можно только одобренный ролик');
    return rowToShort(r.rows[0]);
  }

  /**
   * «Повторить» упавший ролик — с этапа, на котором он упал (`retryTarget`).
   * Повтор публикации — только у ролика, который владелец одобрял, сразу (слот —
   * «сейчас») и только по упавшим площадкам: вышедшие не трогаются. Запись — с
   * условием на `failed_from`: цель выбрана по прочитанной неудаче, и путь
   * «failed → approved» не должен открыться ролику, упавшему на другом этапе.
   */
  private async retry(id: string): Promise<ShortVideo> {
    const v = await this.load(id);
    const target = retryTarget(v);
    if (!target) {
      throw new ConflictException(`повторять нечего: ролик в статусе ${v.status}${v.failedFrom ? `, упал на этапе ${v.failedFrom}` : ''}`);
    }
    if (target === 'approved') {
      await this.pg.query(
        `UPDATE short_publication SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
          WHERE short_id = $1 AND status = 'failed'`,
        [id],
      );
    }
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = $2, attempts = 0, lease_until = NULL, last_error = NULL, failed_from = NULL,
              failure_notified = false, writer_rounds = 0,
              slot_at = CASE WHEN $2 = 'approved' THEN now() ELSE slot_at END, updated_at = now()
        WHERE id = $1 AND status = 'failed' AND failed_from = $3
        RETURNING *`,
      [id, target, v.failedFrom],
    );
    if (!r.rows.length) throw new ConflictException('ролик успел уйти из failed — обновите список');
    return rowToShort(r.rows[0]);
  }

  private async load(id: string): Promise<ShortVideo> {
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const r = await this.pg.query(`SELECT * FROM short_video WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException('ролик не найден');
    return rowToShort(r.rows[0]);
  }
}
```

- [ ] **Step 4: Тест проходит, гейт типов чистый**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add src/shorts/shorts.controller.ts
git -C "$WT" commit -m "feat(shorts): админский API — заказ, запуск, публикация сейчас, повтор, настройки

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Модуль роликов, подключение к боту и приложению

Кольцо `ShortsModule` ↔ `TgBotModule` разрывается `forwardRef` с обеих сторон, как у блога. Роликам нужен `TgGrammyClient`, боту — `ShortsApprovalService`. В `TgBotService` сервис роликов встаёт последним и `@Optional`: два десятка спек собирают бот позиционно. Поэтому отдельная проверка графа подтверждает, что Nest его действительно подставляет.

**Files:**
- Create: `src/shorts/shorts.module.ts`
- Modify: `src/app.module.ts:31,87`, `src/tg-bot/tg-bot.module.ts`, `src/tg-bot/tg-bot.service.ts` (импорт ~21, после `shouldRouteToBlog` ~111, конструктор ~151, `handleMessage` ~275, `handleCallbackQuery` ~366, `handleDmCommand` ~411), `.env.example`
- Test: `src/tg-bot/tg-bot.shorts-routing.spec.ts`, `src/shorts/shorts.module.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

`src/tg-bot/tg-bot.shorts-routing.spec.ts`:

```ts
import { TgBotService, shouldRouteToShorts } from './tg-bot.service';

describe('shouldRouteToShorts', () => {
  it('short: — в ролики, остальное — нет', () => {
    expect(shouldRouteToShorts('short:ok:x')).toBe(true);
    expect(shouldRouteToShorts('blog:ok:x')).toBe(false);
    expect(shouldRouteToShorts('shortcut')).toBe(false);
    expect(shouldRouteToShorts(undefined)).toBe(false);
  });
});

/**
 * Порядок врезок — тот же, что у блога (tg-bot.blog-routing.spec.ts): кнопка
 * роликов — до проверки привязки; реплай, который не узнали ни блог, ни
 * ролики, — ассистенту; `/short` — до разбора команд.
 */
describe('роутинг роликов в живом обработчике', () => {
  const identity = { getLinkeonIdByTgUserId: jest.fn() };
  const configs = { ensurePrivateConfig: jest.fn(), getActiveByTgChatId: jest.fn() };
  const commands = { handleAgentCallback: jest.fn(), handleLanguageCallback: jest.fn(), handleAssistants: jest.fn() };
  const grammy = { sendMessage: jest.fn(), answerCallbackQuery: jest.fn() };
  const blog = { handleCallback: jest.fn(), handleReplyEdit: jest.fn(), handleCaseCommand: jest.fn() };
  const shorts = { handleCallback: jest.fn(), handleReplyEdit: jest.fn(), handleShortCommand: jest.fn() };
  const pg = { query: jest.fn() };
  const build = (withShorts: boolean) =>
    new TgBotService(
      pg as any, identity as any, {} as any, configs as any, {} as any, {} as any, {} as any,
      commands as any, {} as any, grammy as any, {} as any, {} as any, blog as any,
      undefined, withShorts ? (shorts as any) : undefined,
    );
  const svc = build(true);

  beforeEach(() => {
    jest.resetAllMocks();
    pg.query.mockResolvedValue({ rows: [] });
    grammy.answerCallbackQuery.mockResolvedValue(true);
    (svc as any).handleChatMessage = jest.fn();
  });

  it('кнопка ролика уходит в ролики даже у непривязанного', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);
    const cb = { id: 'cb', data: 'short:ok:6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10', from: { id: 42 }, message: { chat: { id: 777 } } };
    await (svc as any).handleCallbackQuery(cb);
    expect(shorts.handleCallback).toHaveBeenCalledWith(cb);
    expect(blog.handleCallback).not.toHaveBeenCalled();
  });

  it('кнопка блога в ролики не уходит', async () => {
    await (svc as any).handleCallbackQuery({ id: 'cb', data: 'blog:ok:p1', from: { id: 42 }, message: { chat: { id: 777 } } });
    expect(blog.handleCallback).toHaveBeenCalled();
    expect(shorts.handleCallback).not.toHaveBeenCalled();
  });

  const replyMsg = () => ({
    chat: { id: 777, type: 'private' }, from: { id: 42 }, message_id: 10, reply_to_message: { message_id: 5 }, text: 'короче',
  });

  it('реплай, который узнали ролики, ассистенту не уходит', async () => {
    blog.handleReplyEdit.mockResolvedValue(false);
    shorts.handleReplyEdit.mockResolvedValue(true);
    await (svc as any).handleMessage(replyMsg());
    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
  });

  it('блог узнал реплай первым — ролики его не видят', async () => {
    blog.handleReplyEdit.mockResolvedValue(true);
    await (svc as any).handleMessage(replyMsg());
    expect(shorts.handleReplyEdit).not.toHaveBeenCalled();
  });

  it('ни блог, ни ролики не узнали — текст ассистенту', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    configs.ensurePrivateConfig.mockResolvedValue({ id: 'cfg-1' });
    blog.handleReplyEdit.mockResolvedValue(false);
    shorts.handleReplyEdit.mockResolvedValue(false);
    await (svc as any).handleMessage(replyMsg());
    expect((svc as any).handleChatMessage).toHaveBeenCalled();
  });

  it('/short владельца забирают ролики — ответа про неизвестную команду нет', async () => {
    blog.handleCaseCommand.mockResolvedValue(false);
    shorts.handleShortCommand.mockResolvedValue(true);
    await (svc as any).handleDmCommand({ chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/short тема ролика' });
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('без сервиса роликов кнопка гасит часики и не падает', async () => {
    const bare = build(false);
    await (bare as any).handleCallbackQuery({ id: 'cb', data: 'short:ok:x', from: { id: 42 }, message: { chat: { id: 777 } } });
    expect(grammy.answerCallbackQuery).toHaveBeenCalledWith('cb', {});
  });
});
```

`src/shorts/shorts.module.spec.ts`:

```ts
/**
 * Сходится ли граф Nest с модулем роликов — тем же способом, что
 * blog.module.spec.ts: scan + instance loader, без onModuleInit (ни базы, ни
 * Telegram, ни .env). Отдельно — что бот получает сервис роликов: он стоит в
 * TgBotService как @Optional, и разрыв графа там прошёл бы молча.
 */
import { NestContainer } from '@nestjs/core/injector/container';
import { InstanceLoader } from '@nestjs/core/injector/instance-loader';
import { Injector } from '@nestjs/core/injector/injector';
import { DependenciesScanner } from '@nestjs/core/scanner';
import { GraphInspector } from '@nestjs/core/inspector/graph-inspector';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { TgBotService } from '../tg-bot/tg-bot.service';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsDirectorService } from './shorts-director.service';
import { ShortsModule } from './shorts.module';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsSchemaService } from './shorts-schema.service';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsWriterService } from './shorts-writer.service';
import { ShortsController } from './shorts.controller';
import { ShortsCron } from './shorts.cron';

jest.setTimeout(120000);

async function buildGraph(root: any): Promise<NestContainer> {
  const container = new NestContainer();
  const graphInspector = new GraphInspector(container);
  const scanner = new DependenciesScanner(container, new MetadataScanner(), graphInspector);
  await scanner.scan(root);
  const loader = new InstanceLoader(container, new Injector(), graphInspector);
  await loader.createInstancesOfDependencies();
  return container;
}

function find(container: NestContainer, cls: any): any {
  for (const [, mod] of container.getModules()) {
    const p = mod.providers.get(cls) || mod.controllers.get(cls);
    if (p && p.instance) return p.instance;
  }
  return undefined;
}

describe('DI-граф роликов', () => {
  it('AppModule: все провайдеры роликов в графе', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    for (const cls of [
      ShortsSchemaService, ShortsSettingsService, ShortsTopicService, ShortsDirectorService, ShortsWriterService,
      ShortsApprovalService, ShortsPublisherService, ShortsCron, ShortsController,
    ]) {
      expect(find(container, cls)).toBeInstanceOf(cls as any);
    }
  });

  it('бот получает сервис роликов — @Optional не прячет разрыв графа', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    expect(find(container, TgBotService).shortsApproval).toBeInstanceOf(ShortsApprovalService);
  });

  it('без AgentsModule граф роликов ломается — проверка не резиновая', async () => {
    const { AppModule } = require('../app.module');
    const imports = Reflect.getMetadata('imports', ShortsModule);
    const saved = [...imports];
    imports.splice(imports.findIndex((m: any) => m?.name === 'AgentsModule'), 1);
    try {
      await expect(buildGraph(AppModule)).rejects.toThrow(/AgentsService|ShortsDirectorService/);
    } finally {
      imports.splice(0, imports.length, ...saved);
    }
  });

  it('ShortsCron виден ScheduleModule: четыре @Cron-метода', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    const cron = find(container, ShortsCron);
    const { SCHEDULE_CRON_OPTIONS } = require('@nestjs/schedule/dist/schedule.constants');
    const proto = Object.getPrototypeOf(cron);
    const crons = Object.getOwnPropertyNames(proto).filter((k) => Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, proto[k]) !== undefined);
    expect(crons.sort()).toEqual(['prepare', 'publishDue', 'refillTopics', 'work']);
  });
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тесты падают**

```bash
git -C "$WT" add src/tg-bot/tg-bot.shorts-routing.spec.ts src/shorts/shorts.module.spec.ts
git -C "$WT" commit -m "test(shorts): кнопки роликов в боте и граф модуля (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/tg-bot/tg-bot.shorts-routing.spec.ts src/shorts/shorts.module.spec.ts"`
Expected: FAIL — `shouldRouteToShorts is not a function` (или `undefined`), `Cannot find module './shorts.module'`.

- [ ] **Step 3: Модуль**

`src/shorts/shorts.module.ts`:

```ts
import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { CommonModule } from '../common/common.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsDirectorService } from './shorts-director.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsSchemaService } from './shorts-schema.service';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsWriterService } from './shorts-writer.service';
import { ShortsController } from './shorts.controller';
import { ShortsCron } from './shorts.cron';

/**
 * Короткие ролики (спека 2026-10-24-promo-shorts-design.md).
 *
 * Кольцо с TgBotModule (роликам — TgGrammyClient, боту — ShortsApprovalService
 * для кнопок) разорвано forwardRef с обеих сторон, как у BlogModule.
 * BlogRelayClient — свой экземпляр: класс без состояния, BlogModule его не
 * экспортирует. ScheduleModule не импортируется — он глобальный (app.module.ts).
 */
@Module({
  imports: [CommonModule, AgentsModule, forwardRef(() => TgBotModule)],
  controllers: [ShortsController],
  providers: [
    ShortsSchemaService,
    ShortsSettingsService,
    ShortsTopicService,
    BlogRelayClient,
    ShortsDirectorService,
    ShortsWriterService,
    ShortsApprovalService,
    ShortsPublisherService,
    ShortsCron,
  ],
  exports: [ShortsApprovalService],
})
export class ShortsModule {}
```

- [ ] **Step 4: Подключение к приложению и к модулю бота**

В `src/app.module.ts` после строки `import { BlogModule } from './blog/blog.module';` добавить:

```ts
import { ShortsModule } from './shorts/shorts.module';
```

и в массиве `imports` после строки `    BlogModule,` добавить:

```ts
    ShortsModule,
```

В `src/tg-bot/tg-bot.module.ts` после `import { BlogModule } from '../blog/blog.module';` добавить импорт и заменить строку `imports` вместе с комментарием над ней:

```ts
import { ShortsModule } from '../shorts/shorts.module';
```

```ts
  // forwardRef на BlogModule и ShortsModule — вторая половина разрыва колец:
  // блог и ролики берут отсюда TgGrammyClient, бот оттуда — сервисы кнопок.
  imports: [
    AgentsModule, CommonModule, MiscModule, VideoModule, MeetingModule, RoomModule,
    forwardRef(() => BlogModule), forwardRef(() => ShortsModule),
  ],
```

- [ ] **Step 5: Врезки в `TgBotService`**

В `src/tg-bot/tg-bot.service.ts`:

После `import { BlogApprovalService } from '../blog/blog-approval.service';`:

```ts
import { ShortsApprovalService } from '../shorts/shorts-approval.service';
```

После функции `shouldRouteToBlog`:

```ts
/**
 * Кнопки роликов (`short:…`) — тем же вебхуком и с тем же порядком, что у
 * блога: до проверки привязки, иначе нажатие «Одобрить» у владельца, не
 * привязанного как пользователь ассистентов, ушло бы в пустоту.
 */
export function shouldRouteToShorts(data?: string): boolean {
  return String(data || '').startsWith('short:');
}
```

В конструкторе — последним параметром, после `@Optional() private readonly costGrowth?: CostGrowthService,`:

```ts
    // Ролики (src/shorts) — то же кольцо модулей, что у блога. Последним и
    // @Optional: спеки собирают сервис позиционно. Что Nest его подставляет,
    // сторожит shorts.module.spec.ts.
    @Optional() @Inject(forwardRef(() => ShortsApprovalService))
    private readonly shortsApproval?: ShortsApprovalService,
```

В `handleMessage`, сразу после строки `      if (await this.blogApproval.handleReplyEdit(msg)) return;`:

```ts
      if (await this.shortsApproval?.handleReplyEdit(msg)) return;
```

В `handleCallbackQuery`, сразу после ветки блога (`if (shouldRouteToBlog(data)) { … return; }`):

```ts
    if (shouldRouteToShorts(data)) {
      if (this.shortsApproval) await this.shortsApproval.handleCallback(cb);
      else await this.grammy.answerCallbackQuery(cb.id, {}).catch(() => {});
      return;
    }
```

В `handleDmCommand`, сразу после строки `    if (await this.blogApproval.handleCaseCommand(msg)) return;`:

```ts
    // `/short <тема>` — заказ ролика владельцем; как и /case, до разбора команд.
    if (await this.shortsApproval?.handleShortCommand(msg)) return;
```

- [ ] **Step 6: Переменные в `.env.example`**

В конец `.env.example` дописать:

```bash

# ── Короткие ролики (src/shorts, спека 2026-10-24-promo-shorts-design.md) ──
# Рубильник конвейера: съёмка, одобрение, публикация. Включать последним —
# после того как в short_settings прописан канал (admin/shorts update_settings).
# SHORTS_ENABLED=true
# Воскресное наполнение очереди и запуск роликов к слотам. На стенде — false:
# ролик запускается из админки (admin/shorts start_now).
# SHORTS_AUTO_TOPICS=true
# Стенд: пометка «СТЕНД» в сообщениях владельцу.
# SHORTS_STAND=true
# Адрес кабинета в ссылках роликов; по умолчанию https://my.linkeon.io.
# SHORTS_LINK_BASE=https://test.linkeon.io
```

- [ ] **Step 7: Тесты проходят — новые и прежние спеки бота и блога**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "rm -f /tmp/promo-jest.log; npx jest src/shorts src/tg-bot src/blog > /tmp/promo-jest.log 2>&1 || true; grep -q '^Tests: ' /tmp/promo-jest.log || { tail -30 /tmp/promo-jest.log; echo JEST_DID_NOT_RUN; exit 1; }; grep -oE '^FAIL [^ ]+' /tmp/promo-jest.log | sort -u > /tmp/promo-fail-now.txt; comm -13 ~/ci/promo-shorts-jest-fail-base.txt /tmp/promo-fail-now.txt > /tmp/promo-fail-new.txt; cat /tmp/promo-fail-new.txt; test ! -s /tmp/promo-fail-new.txt && echo NO_NEW_FAILS && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: `NO_NEW_FAILS` и `TSC_OK`. Сюиты задачи (`src/shorts/*`, `tg-bot.shorts-routing.spec.ts`) — PASS. Интеграционные `shorts.integration.spec.ts` и `blog-approval.integration.spec.ts` без своих переменных — skipped. Если база задачи 0 не пустая, её сюиты красными и остаются — это не от этой работы.

Прежние спеки `src/tg-bot` собирают `TgBotService` из 13–14 аргументов. Новый параметр стоит последним и `@Optional`, поэтому они не меняются. Если среди новых красных — прежняя спека бота, сначала проверить её позиционные аргументы и не трогать порядок параметров.

- [ ] **Step 8: Коммит**

```bash
git -C "$WT" add src/shorts/shorts.module.ts src/app.module.ts src/tg-bot/tg-bot.module.ts src/tg-bot/tg-bot.service.ts .env.example
git -C "$WT" commit -m "feat(shorts): модуль роликов в приложении, кнопки и /short в боте

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: Проверки на живом Postgres

Заглушки не видят того, что решает SQL:
- повторный накат при открытой пишущей транзакции;
- гонку двух одобрений за один слот (уникальный индекс и повтор);
- захват этапа двумя процессами и паузу аренды;
- `$2 = ANY(bigint[])` для больших id сообщений;
- две публикации одновременно.

База одноразовая, гард отказывается работать с базой приложения.

**Files:**
- Test: `src/shorts/shorts.integration.spec.ts`

- [ ] **Step 1: Одноразовая база на ноде (один раз)**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "sudo -u postgres psql -qc \"CREATE ROLE shortsit LOGIN PASSWORD 'shortsit'\" 2>/dev/null; sudo -u postgres psql -qc 'DROP DATABASE IF EXISTS shorts_it' && sudo -u postgres psql -qc 'CREATE DATABASE shorts_it OWNER shortsit' && echo DB_OK"
```

Expected: `DB_OK`. Роль с паролем — как у `blog_notes`: node-pg ходит по TCP, peer-аутентификации у него нет.

- [ ] **Step 2: Написать тест**

`src/shorts/shorts.integration.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { claimStage, stageFailed } from './short-jobs';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { rowToShort } from './shorts.types';

/**
 * Ролики против живого Postgres — то, что решает SQL, а не код вокруг него.
 *
 * КАК ГОНЯТЬ. База ОДНОРАЗОВАЯ: beforeEach делает TRUNCATE. Гард отказывается
 * работать с базой приложения и с непустой short_video — до наката миграции.
 *
 *   sudo -u postgres psql -qc "CREATE ROLE shortsit LOGIN PASSWORD 'shortsit'"
 *   sudo -u postgres psql -qc "CREATE DATABASE shorts_it OWNER shortsit"
 *   SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts
 *
 * Без SHORTS_PG_URL файл пропускается (skipped), а не зеленеет.
 */
const PG = process.env.SHORTS_PG_URL;
const maybe = PG ? describe : describe.skip;
const MIGRATION = path.join(__dirname, 'migrations', '001_shorts.sql');

maybe('ролики против живого Postgres', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let ours = false;
  const pgLike = () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), getClient: () => pool.connect() });

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    const probe = await pool.query(
      `SELECT to_regclass('public.ai_profiles_consolidated') AS app, to_regclass('public.short_video') AS shorts`,
    );
    if (probe.rows[0].app) throw new Error('SHORTS_PG_URL указывает на базу приложения — нужна одноразовая (рецепт в шапке файла)');
    if (probe.rows[0].shorts) {
      const n = await pool.query('SELECT count(*)::int AS n FROM short_video');
      if (n.rows[0].n > 0) throw new Error('в short_video уже есть строки — нужна одноразовая база, TRUNCATE их сотрёт');
    }
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    ours = true;
  });

  beforeEach(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
  });

  afterAll(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
    await pool?.end();
  });

  /** Строка ролика; объекты — в jsonb строкой, массивы и даты — как есть. */
  async function insert(over: Record<string, any>) {
    const cols: Record<string, any> = { rubric: 'assistant', source: 'manual', topic_key: 't', ...over };
    const keys = Object.keys(cols);
    const values = keys.map((k) => {
      const v = cols[k];
      return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    const r = await pool.query(
      `INSERT INTO short_video (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      values,
    );
    return rowToShort(r.rows[0]);
  }

  it('повторный накат не ждёт открытую пишущую транзакцию', async () => {
    await insert({});
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE short_video SET topic_hint = 'держу строку'`);
      await holder.query(`UPDATE short_settings SET slot_hour_msk = 19 WHERE id = 1`);
      const t0 = Date.now();
      await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('два одобрения в один планируемый слот — разные слоты, планируемый достаётся одному', async () => {
    const schedule = { slotDays: [2, 4, 6], slotHourMsk: 18 };
    const planned = new Date('2026-10-27T15:00:00.000Z');
    const clock = () => new Date('2026-10-26T12:00:00.000Z');
    const a = await insert({ status: 'pending_review', slot_at: planned });
    const b = await insert({ status: 'pending_review', slot_at: planned });
    const [ra, rb] = await Promise.all([
      approveShortIntoSlot(pgLike() as any, a.id, planned, schedule, clock),
      approveShortIntoSlot(pgLike() as any, b.id, planned, schedule, clock),
    ]);
    expect([ra.slot.toISOString(), rb.slot.toISOString()].sort()).toEqual(['2026-10-27T15:00:00.000Z', '2026-10-29T15:00:00.000Z']);
    const rows = await pool.query(`SELECT status, approved_at FROM short_video`);
    expect(rows.rows.every((r) => r.status === 'approved' && r.approved_at)).toBe(true);
  });

  it('этап забирает один процесс; повтор ждёт паузу; три неудачи — failed', async () => {
    const v = await insert({ status: 'directing' });
    const [x, y] = await Promise.all([claimStage(pool, 'directing'), claimStage(pool, 'directing')]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const first = x ?? y;
    expect(first.attempts).toBe(1);

    expect(await stageFailed(pool, first, 'режиссёр', new Error('релей молчит'))).toBe('retry');
    expect(await claimStage(pool, 'directing')).toBeNull();

    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    const second = await claimStage(pool, 'directing');
    expect(second.attempts).toBe(2);
    await stageFailed(pool, second, 'режиссёр', new Error('релей молчит'));

    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    const third = await claimStage(pool, 'directing');
    expect(await stageFailed(pool, third, 'режиссёр', new Error('релей молчит'))).toBe('failed');
    const row = (await pool.query(`SELECT * FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect([row.status, row.failed_from, row.failure_notified, row.last_error]).toEqual(['failed', 'directing', false, 'режиссёр: релей молчит']);
  });

  it('аренда истекла посреди работы: опоздавший процесс не трогает чужой захват; зависшая последняя попытка — failed', async () => {
    const v = await insert({ status: 'directing' });
    const a = await claimStage(pool, 'directing');
    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    const b = await claimStage(pool, 'directing');
    expect(b.attempts).toBe(2);
    expect(await stageFailed(pool, a, 'режиссёр', new Error('поздно'))).toBe('gone');
    const kept = (await pool.query(`SELECT attempts, last_error, lease_until > now() + interval '15 minutes' AS long FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect(kept).toEqual({ attempts: 2, last_error: null, long: true });

    await pool.query(`UPDATE short_video SET attempts = 3, lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    expect(await claimStage(pool, 'directing')).toBeNull();
    const row = (await pool.query(`SELECT status, failed_from, failure_notified FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect(row).toEqual({ status: 'failed', failed_from: 'directing', failure_notified: false });
  });

  it('ответ на приглашение узнаётся по большому id сообщения, замечание уводит ролик на переписку', async () => {
    const v = await insert({ status: 'pending_review', review_chat_id: 77, review_message_id: 12, note_prompt_ids: [9007199254740] });
    const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
    process.env.BLOG_APPROVER_TG_ID = '77';
    const svc = new ShortsApprovalService(pgLike() as any, tg as any, {} as any, {} as any, {} as any);
    expect(await svc.handleReplyEdit({ chat: { id: 77 }, reply_to_message: { message_id: 9007199254740 }, message_id: 50, text: 'короче' })).toBe(true);
    const row = (await pool.query(`SELECT status, owner_note FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect(row).toEqual({ status: 'writing', owner_note: 'короче' });
  });

  it('две публикации одновременно — одна отправка в канал', async () => {
    const v = await insert({
      status: 'approved', slot_at: new Date(Date.now() - 60_000), approved_at: new Date(),
      video_key: 'shorts/x/video.mp4', cover_key: 'shorts/x/cover.jpg', duration_ms: 44000, slug: 'x_0000',
      captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'T', description: 'D', tags: [] } },
    });
    const tg = { sendVideo: jest.fn(async () => ({ message_id: 501, chat: { id: -1001000000001, username: 'linkeontest' } })) };
    const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
    const settings = { get: jest.fn(async () => ({ platforms: ['telegram'], tgChannelChatId: '-1001000000001' })) };
    const publisher = new ShortsPublisherService(pgLike() as any, tg as any, storage as any, settings as any);
    await Promise.all([publisher.publish(v.id), publisher.publish(v.id)]);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('published');
    const pub = (await pool.query(`SELECT status, external_id, url FROM short_publication WHERE short_id = $1`, [v.id])).rows[0];
    expect(pub).toEqual({ status: 'published', external_id: '501', url: 'https://t.me/linkeontest/501' });
  });
});
```

- [ ] **Step 3: Убедиться, что без базы файл пропускается, а с базой — зелёный**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.integration.spec.ts"`
Expected: `Tests: 6 skipped`.

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts"`
Expected: `Tests: 6 passed`.

Красный тест здесь — дефект SQL, а не теста. Гонка одобрений: два одинаковых слота — индекса `uq_short_video_slot` нет или он создан не тем предикатом (блокировка свободный слот не держит, его держит индекс); отказ с сырым 23505 — имя индекса в миграции разошлось с `SHORT_SLOT_INDEX`.

- [ ] **Step 4: Коммит**

```bash
git -C "$WT" add src/shorts/shorts.integration.spec.ts
git -C "$WT" commit -m "test(shorts): накат, гонка слотов, аренда этапов, реплаи и публикация на живом Postgres

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Студия: от команд к заданиям конвейера

Задачи 24–34 правят `studio/`. Команды студии выполняются в `studio/` на ноде: `studio/scripts/node-run.sh "<команда>"`. Строку `test` в `studio/package.json` каждая задача, добавившая файл теста, переписывает целиком — она приведена в задаче.

### Task 24: Ошибки студии с кодом и признаком повтора

Рабочему процессу нужно знать, что делать с упавшим заданием: повторить, вернуть сценарий сценаристу или сдаться. Сейчас студия бросает голые `Error` с текстом.

**Files:**
- Create: `studio/src/errors.ts`, `studio/src/errors.test.ts`
- Modify: `studio/src/capture/chat-scene.ts`, `studio/src/capture/login.ts`, `studio/src/timeline.ts`, `studio/src/tts.ts`, `studio/src/render/run-render.ts`, `studio/package.json` (`test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/errors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError, WRITER_FEEDBACK_CODES, toStudioError } from './errors';
import { buildTimeline } from './timeline';
import type { VoicedLine } from './types';

test('StudioError несёт код и признак повтора', () => {
  const e = new StudioError('answer_rejected', 'capture: ответ не годится', true);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'StudioError');
  assert.equal(e.code, 'answer_rejected');
  assert.equal(e.retryable, true);
});

test('незнакомая ошибка — unknown с повтором; StudioError проходит как есть', () => {
  const known = new StudioError('tts', 'x', false);
  assert.equal(toStudioError(known), known);
  const wrapped = toStudioError(new Error('ECONNRESET'));
  assert.deepEqual([wrapped.code, wrapped.retryable, wrapped.message], ['unknown', true, 'ECONNRESET']);
  assert.equal(toStudioError('строка').message, 'строка');
});

test('длина озвучки — к сценаристу, а не в повтор сборки', () => {
  for (const code of ['too_long', 'too_short', 'line_too_short'] as const) assert.ok(WRITER_FEEDBACK_CODES.has(code));
  assert.ok(!WRITER_FEEDBACK_CODES.has('answer_rejected'));
});

const line = (id: string, scene: VoicedLine['scene'], durationMs: number, box?: number): VoicedLine => ({
  id, scene, text: id, durationMs, audio: `voice/${id}.mp3`, ...(box ? { box } : {}),
});

test('таймлайн короче 30 с — too_short без повтора', () => {
  assert.throws(
    () => buildTimeline([line('h', 'hook', 1500), line('q', 'question', 2000), line('a1', 'answer', 3000, 1), line('f', 'final', 2000)]),
    (e: unknown) => e instanceof StudioError && e.code === 'too_short' && !e.retryable,
  );
});

test('таймлайн длиннее 60 с — too_long', () => {
  assert.throws(
    () => buildTimeline([line('h', 'hook', 1500), line('q', 'question', 20000), line('a1', 'answer', 30000, 1), line('f', 'final', 15000)]),
    (e: unknown) => e instanceof StudioError && e.code === 'too_long',
  );
});

test('сцены не по порядку — script_invalid', () => {
  assert.throws(
    () => buildTimeline([line('q', 'question', 2000), line('h', 'hook', 1500)]),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});
```

В `studio/package.json` строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts src/errors.test.ts",
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/errors.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): ошибки с кодом и признаком повтора (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/errors.test.ts"`
Expected: FAIL — `Cannot find module '…/src/errors'`.

- [ ] **Step 3: Реализация**

`studio/src/errors.ts`:

```ts
/**
 * Ошибки студии с кодом и признаком повтора. По ним рабочий процесс решает,
 * что делать с заданием: повторить, вернуть сценарий сценаристу или сдаться
 * (studio/src/worker/db.ts, failJob). Сообщение — для владельца: оно уходит
 * в last_error ролика и в личку.
 */
export type StudioErrorCode =
  | 'login'
  | 'blocked'
  | 'wrong_assistant'
  | 'idle_timeout'
  | 'question_hidden'
  | 'answer_timeout'
  | 'answer_rejected'
  | 'no_paragraphs'
  | 'empty_frame'
  | 'script_invalid'
  | 'too_short'
  | 'too_long'
  | 'line_too_short'
  | 'frame_size'
  | 'tts'
  | 'video_invalid'
  | 'no_input'
  | 'unknown';

/** Озвучка вышла за 30–60 с или реплика слишком короткая — править сценаристу, а не повторять сборку. */
export const WRITER_FEEDBACK_CODES: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(['too_short', 'too_long', 'line_too_short']);

export class StudioError extends Error {
  readonly code: StudioErrorCode;
  readonly retryable: boolean;

  constructor(code: StudioErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Любая ошибка → StudioError. Незнакомая повторяется: чаще всего это сеть или моргнувший стенд. */
export function toStudioError(e: unknown): StudioError {
  if (e instanceof StudioError) return e;
  return new StudioError('unknown', e instanceof Error ? e.message : String(e), true);
}
```

- [ ] **Step 4: Коды в местах, где студия бросает**

Во всех файлах ниже добавить импорт `import { StudioError } from '../errors';` (в `src/timeline.ts` и `src/tts.ts` — `from './errors'`). Тексты сообщений не меняются: тесты и владелец их уже знают.

`studio/src/capture/chat-scene.ts`:

```ts
throw new StudioError('answer_timeout', 'capture: ответ не закончился за 5 минут', true);
throw new StudioError('idle_timeout', 'capture: лента не успокоилась за 5 минут — приветствие ассистента не закончилось', true);
throw new StudioError('blocked', `capture: кабинет не дошёл до чата — см. ${shot('blocked.png')}`, true);
throw new StudioError('wrong_assistant', `capture: открыт не тот ассистент: «${picked}» вместо «${scene.assistantName}»`, false);
throw new StudioError('question_hidden', `capture: пузырь вопроса не виден целиком — см. ${shot('question-hidden.png')}`, true);
throw new StudioError('answer_rejected', `capture: ответ не годится — ${problems.join('; ')}`, true);
if (boxes.length === 0) throw new StudioError('no_paragraphs', 'capture: в ответе не нашлось ни одного абзаца', true);
throw new StudioError('empty_frame', `capture: ${f} меньше 20 КБ — похоже на пустой кадр`, true);
```

`studio/src/capture/login.ts`. Неверный секрет повтором не лечится, остальное — сеть и стенд:

```ts
throw new StudioError('login', 'login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены', false);
throw new StudioError('login', 'login: код не появился за 10 секунд', true);
throw new StudioError('login', `login: запрос SMS — ${sms.status}`, true);
throw new StudioError('login', `login: check-code — ${check.status}`, true);
throw new StudioError('login', 'login: в ответе check-code нет токенов', true);
throw new StudioError('login', `login: профиль — ${prof.status}`, true);
```

`studio/src/timeline.ts`:

```ts
throw new StudioError('script_invalid', 'timeline: зацепка (hook) — первая и единственная реплика своей сцены', false);
throw new StudioError('script_invalid', `timeline: сцена ${l.scene} после ${ORDER[at]}; порядок hook → question → answer → final`, false);
throw new StudioError('script_invalid', `timeline: в сцене ${s} нет реплик`, false);
if (sec * 1000 < MIN_TOTAL_MS) throw new StudioError('too_short', `timeline: ролик ${sec.toFixed(1)} с — короче 30 с`, false);
if (sec * 1000 > MAX_TOTAL_MS) throw new StudioError('too_long', `timeline: ролик ${sec.toFixed(1)} с — длиннее 60 с`, false);
```

`studio/src/tts.ts`:

```ts
throw new StudioError('tts', `tts ${r.id}: реплики нет в кеше озвучки, а ключи SpeechKit не заданы`, false);
if (!resp.ok) throw new StudioError('tts', `tts ${r.id}: SpeechKit ${resp.status} ${(await resp.text()).slice(0, 200)}`, true);
```

`studio/src/render/run-render.ts`:

```ts
if (scriptProblems.length) throw new StudioError('script_invalid', `render: сценарий не прошёл проверку:\n- ${scriptProblems.join('\n- ')}`, false);
```

- [ ] **Step 5: Тесты и типы зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test"`
Expected: `tsc` без вывода; `# fail 0`.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add studio/src/errors.ts studio/src/capture/chat-scene.ts studio/src/capture/login.ts studio/src/timeline.ts studio/src/tts.ts studio/src/render/run-render.ts
git -C "$WT" commit -m "feat(studio): ошибки с кодом и признаком повтора во всех местах сбоя

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: Размер кадра — один источник

Хвост финального ревью плана 1: 1080×1920 жили независимо в съёмке (`chat-scene.ts`, 360×640 × 3) и в теме композиции (`theme.ts`). Теперь оба берут их из `frame.ts`, а сборка отказывает снимку не той ширины. Иначе он растянулся бы, и рамка встала бы мимо абзаца.

**Files:**
- Create: `studio/src/frame.ts`, `studio/src/frame.test.ts`
- Modify: `studio/src/remotion/theme.ts`, `studio/src/capture/chat-scene.ts`, `studio/src/ffprobe.ts`, `studio/src/render/props.ts`, `studio/src/render/props.test.ts`, `studio/package.json` (`test`)

- [ ] **Step 1: Написать падающие тесты**

`studio/src/frame.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORT_LIMITS } from './ffprobe';
import { CAPTURE_SCALE, CAPTURE_VIEWPORT, FRAME } from './frame';

test('окно съёмки при плотности даёт ровно кадр ролика', () => {
  assert.ok(Number.isInteger(CAPTURE_VIEWPORT.width) && Number.isInteger(CAPTURE_VIEWPORT.height));
  assert.equal(CAPTURE_VIEWPORT.width * CAPTURE_SCALE, FRAME.width);
  assert.equal(CAPTURE_VIEWPORT.height * CAPTURE_SCALE, FRAME.height);
});

test('проверка готового файла ждёт тот же кадр', () => {
  assert.deepEqual([SHORT_LIMITS.width, SHORT_LIMITS.height], [FRAME.width, FRAME.height]);
});
```

В конец `studio/src/render/props.test.ts`:

```ts
test('снимок ответа не той ширины — frame_size без повтора', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.throws(
    () => buildProps({ ...capture, answerShotWidth: 720 }, script, voiced, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'frame_size' && !e.retryable,
  );
});
```

и импорт в его шапку: `import { StudioError } from '../errors';`.

В `studio/package.json` строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts src/errors.test.ts src/frame.test.ts",
```

- [ ] **Step 2: Закоммитить и убедиться, что тесты падают**

```bash
git -C "$WT" add studio/src/frame.test.ts studio/src/render/props.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): один источник размера кадра (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/frame.test.ts src/render/props.test.ts"`
Expected: FAIL — `Cannot find module '…/src/frame'`; тест `frame_size` падает — `Missing expected exception`.

- [ ] **Step 3: Реализация**

`studio/src/frame.ts`:

```ts
/**
 * Кадр ролика — один источник для съёмки и композиции. Съёмка: окно
 * CAPTURE_VIEWPORT при плотности CAPTURE_SCALE даёт снимок шириной ровно
 * FRAME.width. Композиция Remotion — FRAME целиком (remotion/theme.ts).
 * Проверка готового файла — тот же FRAME (ffprobe.ts, SHORT_LIMITS).
 */
export const FRAME = { width: 1080, height: 1920 } as const;
export const CAPTURE_SCALE = 3;
export const CAPTURE_VIEWPORT = { width: FRAME.width / CAPTURE_SCALE, height: FRAME.height / CAPTURE_SCALE } as const;
```

`studio/src/remotion/theme.ts` — строки `export const W = 1080;` и `export const H = 1920;` заменить на:

```ts
import { FRAME } from '../frame';

export const W = FRAME.width;
export const H = FRAME.height;
```

(импорт — к остальным импортам в начале файла).

`studio/src/capture/chat-scene.ts` — строки `export const VIEWPORT = { width: 360, height: 640 };` и `export const SCALE = 3;` вместе с комментарием над ними заменить на:

```ts
/** Окно съёмки и плотность — из frame.ts: 360×640 при плотности 3 — ровно кадр 1080×1920. */
export const VIEWPORT = CAPTURE_VIEWPORT;
export const SCALE = CAPTURE_SCALE;
```

и добавить импорт `import { CAPTURE_SCALE, CAPTURE_VIEWPORT } from '../frame';`.

`studio/src/ffprobe.ts` — `SHORT_LIMITS`:

```ts
export const SHORT_LIMITS: VerifyLimits = { minSec: 30, maxSec: 60, width: FRAME.width, height: FRAME.height, maxSilenceSec: 2 };
```

и импорт `import { FRAME } from './frame';`.

`studio/src/render/props.ts` — первой строкой тела `buildProps`:

```ts
  if (capture.answerShotWidth !== FRAME.width) {
    throw new StudioError(
      'frame_size',
      `props: снимок ответа шириной ${capture.answerShotWidth} px, нужен ${FRAME.width} — съёмка шла не в кадре ${FRAME.width}×${FRAME.height}`,
      false,
    );
  }
```

и импорты `import { StudioError } from '../errors';`, `import { FRAME } from '../frame';`.

- [ ] **Step 4: Тесты и типы зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test"`
Expected: `tsc` без вывода; `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add studio/src/frame.ts studio/src/remotion/theme.ts studio/src/capture/chat-scene.ts studio/src/ffprobe.ts studio/src/render/props.ts
git -C "$WT" commit -m "feat(studio): размер кадра — один источник для съёмки, композиции и проверки

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 26: Абзацы целиком в съёмке, число ассистентов — из сценария

Сценаристу нужен полный текст каждого абзаца, а не 120 знаков подсказки. Номера — те же, что у рамок. Число ассистентов теперь пишет бэкенд в `script.final.assistantsCount`: та же цифра звучит в финальной реплике, словами (хвост «числа в озвучке — с бэкенда»). Подсчёт в студии (`countAssistants`) уходит.

**Files:**
- Modify: `studio/src/types.ts`, `studio/src/boxes.ts`, `studio/src/boxes.test.ts`, `studio/src/capture/chat-scene.ts`, `studio/src/capture/login.ts`, `studio/src/capture/run-capture.ts`, `studio/src/render/props.ts`, `studio/src/render/props.test.ts`, `studio/src/render/render.fixture.ts`, `studio/scenes/sample-lawyer-lease.script.json`

- [ ] **Step 1: Написать падающий тест**

В конец `studio/src/boxes.test.ts` и в его импорт — `toAnswerLayout`:

```ts
import { toAnswerLayout, toImageBoxes } from './boxes';
```

```ts
test('полный текст абзацев — с теми же номерами, без обрезки до 120', () => {
  const long = `начало ${'x'.repeat(300)}`;
  const { boxes, paragraphs } = toAnswerLayout(
    [
      { top: 300, height: 40, text: 'второй' },
      { top: 100, height: 40, text: long },
    ],
    1,
  );
  assert.deepEqual(boxes.map((b) => b.n), [1, 2]);
  assert.deepEqual(paragraphs.map((p) => p.n), [1, 2]);
  assert.equal(paragraphs[0].text, long);
  assert.equal(boxes[0].text.length, 120);
  assert.equal(paragraphs[1].text, 'второй');
});
```

В `studio/src/render/props.test.ts`:
- в `capture` убрать строку `assistantsCount: 18,` и добавить `paragraphs: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }],`;
- в `script` заменить `final: { disclaimer: 'Ответ ИИ, не заменяет специалиста' },` на `final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет специалиста' },`;
- первый тест переименовать в `'пропсы: пути озвучки относительно папки съёмки, финал — из сценария'`, его проверки не меняются.

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/boxes.test.ts studio/src/render/props.test.ts
git -C "$WT" commit -m "test(studio): абзацы целиком, число ассистентов из сценария (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/boxes.test.ts src/render/props.test.ts"`
Expected: FAIL — `toAnswerLayout is not a function`; в `props.test.ts` финал получает `assistantsCount: undefined`.

- [ ] **Step 3: Типы**

В `studio/src/types.ts`:

После `ImageBox` добавить:

```ts
/** Абзац ответа целиком — его пересказывает реплика сценария (сценарист бэкенда читает этот текст). */
export interface Paragraph {
  n: number;
  text: string;
}
```

В `CaptureResult` строки `boxes: ImageBox[];` и `assistantsCount: number;` заменить на:

```ts
  boxes: ImageBox[];
  /** Полный текст абзацев; номера — как у boxes. */
  paragraphs: Paragraph[];
```

В `Script` строку `final: { disclaimer?: string };` заменить на:

```ts
  /** Число ассистентов — из базы; его же словами произносит финальная реплика (сценарий пишет бэкенд). */
  final: { assistantsCount: number; disclaimer?: string };
```

- [ ] **Step 4: Абзацы из DOM**

`studio/src/boxes.ts` заменить целиком:

```ts
import type { ImageBox, Paragraph } from './types';

/** Блок ответа в CSS-пикселях документа (getBoundingClientRect + scrollY). */
export interface CssRect {
  top: number;
  height: number;
  text: string;
}

export const MIN_BLOCK_CSS_PX = 8;
/** Подсказка в ImageBox.text — начало абзаца. */
export const BOX_HINT_CHARS = 120;
/** Абзац целиком, но не бесконечный: блок кода в ответе не должен раздуть промпт сценариста. */
export const PARAGRAPH_MAX_CHARS = 2000;

export interface AnswerLayout {
  boxes: ImageBox[];
  paragraphs: Paragraph[];
}

/**
 * Блоки ответа → абзацы на скриншоте (пиксели картинки при deviceScaleFactor = scale)
 * и их полный текст. Пустые и крошечные блоки отбрасываются, вылезающие за низ
 * картинки — тоже: показать их нечем. Остальные нумеруются с 1 сверху вниз —
 * одинаково в обоих списках.
 */
export function toAnswerLayout(rects: CssRect[], scale: number, imageHeight = Infinity): AnswerLayout {
  const kept = rects
    .filter((r) => r.height >= MIN_BLOCK_CSS_PX && r.text.trim().length > 0)
    .map((r) => ({
      top: Math.round(r.top * scale),
      height: Math.round(r.height * scale),
      text: r.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter((b) => b.top + b.height <= imageHeight)
    .sort((a, b) => a.top - b.top);
  return {
    boxes: kept.map((b, i) => ({ n: i + 1, top: b.top, height: b.height, text: b.text.slice(0, BOX_HINT_CHARS) })),
    paragraphs: kept.map((b, i) => ({ n: i + 1, text: b.text.slice(0, PARAGRAPH_MAX_CHARS) })),
  };
}

export function toImageBoxes(rects: CssRect[], scale: number, imageHeight = Infinity): ImageBox[] {
  return toAnswerLayout(rects, scale, imageHeight).boxes;
}
```

`studio/src/capture/chat-scene.ts`:
- импорт `import { toImageBoxes, type CssRect } from '../boxes';` → `import { toAnswerLayout, type CssRect } from '../boxes';`;
- в `CaptureOptions` убрать строку `assistantsCount: number;`;
- `const boxes = toImageBoxes(rects, SCALE, img.height);` → `const { boxes, paragraphs } = toAnswerLayout(rects, SCALE, img.height);`;
- в возвращаемом объекте строки `boxes,` и `assistantsCount: opts.assistantsCount,` → `boxes,` и `paragraphs,`.

`studio/src/capture/login.ts` — функцию `countAssistants` (последнюю в файле, вместе с её комментарием) удалить.

`studio/src/capture/run-capture.ts`:
- `import { countAssistants, loginDemoCached } from './login';` → `import { loginDemoCached } from './login';`;
- удалить строку `const assistantsCount = await countAssistants(cfg);`;
- в опциях `captureChat` удалить строку `assistantsCount,`.

`studio/src/render/props.ts` — строку финала:

```ts
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
```

`studio/scenes/sample-lawyer-lease.script.json` — финал:

```json
  "final": { "assistantsCount": 18, "disclaimer": "Ответ ИИ, не заменяет юриста" }
```

`studio/src/render/render.fixture.ts`:
- в `capture.json` убрать `assistantsCount: 18,` и добавить `paragraphs: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }],`;
- в `script.json` заменить `final: { disclaimer: 'Ответ ИИ, не заменяет специалиста' },` на `final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет специалиста' },`.

- [ ] **Step 5: Тесты, типы и сквозной рендер зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test && npm run test:render"`
Expected: `tsc` без вывода; `# fail 0` в обоих прогонах.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add studio/src/types.ts studio/src/boxes.ts studio/src/capture/chat-scene.ts studio/src/capture/login.ts studio/src/capture/run-capture.ts studio/src/render/props.ts studio/src/render/render.fixture.ts studio/scenes/sample-lawyer-lease.script.json
git -C "$WT" commit -m "feat(studio): полный текст абзацев в съёмке, число ассистентов — из сценария

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: Опора зацепки, подпись кейса, минимальная длина реплики

Студия проверяет то, что может проверить сама:
- абзац `hookBox` снят;
- число ассистентов в финале есть;
- реплика ответа звучит не меньше 1,5 с — иначе приближение к абзацу не успевает (хвост ревью плана 1: `MOVE` + рамка + удержание ≈ 35 кадров).

Подпись реального кейса («Реальная история, разговор повторён на демо-аккаунте») показывается в кадре вопроса.

**Files:**
- Modify: `studio/src/types.ts`, `studio/src/script.ts`, `studio/src/script.test.ts`, `studio/src/timeline.ts`, `studio/src/timeline.test.ts`, `studio/src/render/props.ts`, `studio/src/render/props.test.ts`, `studio/src/remotion/Short.tsx`, `studio/src/remotion/scenes/Question.tsx`

- [ ] **Step 1: Написать падающие тесты**

В `studio/src/script.test.ts` в `good()` заменить `final: {},` на `final: { assistantsCount: 18 },` и дописать:

```ts
test('зацепка опирается на снятый абзац', () => {
  assert.deepEqual(validateScript({ ...good(), hookBox: 2 }, capture), []);
  assert.match(validateScript({ ...good(), hookBox: 7 }, capture).join(';'), /зацепка опирается на абзац 7/);
});

test('в финале нужно число ассистентов', () => {
  assert.match(validateScript({ ...good(), final: { assistantsCount: 0 } }, capture).join(';'), /числа ассистентов/);
});
```

В `studio/src/timeline.test.ts` — импорт `MIN_ANSWER_LINE_MS` из `./timeline`, `StudioError` из `./errors` и тест:

```ts
test('реплика ответа короче 1,5 с — line_too_short: приближение не успеет', () => {
  const s = sample();
  s[2] = line('a1', 'answer', MIN_ANSWER_LINE_MS - 100, 1);
  assert.throws(
    () => buildTimeline(s),
    (e: unknown) => e instanceof StudioError && e.code === 'line_too_short' && /реплика a1/.test(e.message),
  );
});
```

В `studio/src/render/props.test.ts`:

```ts
test('подпись реального кейса доходит до композиции', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.equal(buildProps(capture, { ...script, badge: 'Реальная история' }, voiced, '/run').badge, 'Реальная история');
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тесты падают**

```bash
git -C "$WT" add studio/src/script.test.ts studio/src/timeline.test.ts studio/src/render/props.test.ts
git -C "$WT" commit -m "test(studio): опора зацепки, подпись кейса, минимальная длина реплики (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/script.test.ts src/timeline.test.ts src/render/props.test.ts"`
Expected: FAIL — нет проверок `hookBox` и числа ассистентов, нет `MIN_ANSWER_LINE_MS`, `badge` — `undefined`.

- [ ] **Step 3: Типы**

В `studio/src/types.ts`, в `Script` после `hook: string;`:

```ts
  /** Абзац, на котором держится смелая фраза зацепки (правило текста 10). */
  hookBox?: number;
  /** Подпись в кадре вопроса — у реального кейса. */
  badge?: string;
```

В `ShortProps` после `hook: string;`:

```ts
  badge?: string;
```

- [ ] **Step 4: Проверки**

`studio/src/script.ts` — после цикла по репликам, перед поиском `hookLine`:

```ts
  if (script.hookBox != null && !known.has(script.hookBox)) {
    problems.push(`зацепка опирается на абзац ${script.hookBox}, а снято абзацев: ${capture.boxes.length}`);
  }
  const count = script.final?.assistantsCount;
  if (!Number.isInteger(count) || count <= 0) problems.push('в финале нет числа ассистентов (final.assistantsCount)');
```

`studio/src/timeline.ts` — константа рядом с остальными:

```ts
/**
 * Реплика ответа короче — сцена не успевает: переезд к абзацу (MOVE, 15 кадров),
 * появление рамки (10) и удержание приближения перед отпуском (10).
 */
export const MIN_ANSWER_LINE_MS = 1500;
```

и проверка в `buildTimeline` — после проверки «в каждой сцене хотя бы одна реплика»:

```ts
  for (const l of lines) {
    if (l.scene === 'answer' && l.durationMs < MIN_ANSWER_LINE_MS) {
      throw new StudioError(
        'line_too_short',
        `timeline: реплика ${l.id} звучит ${(l.durationMs / 1000).toFixed(1)} с — короче ${MIN_ANSWER_LINE_MS / 1000} с: приближение к абзацу не успеет`,
        false,
      );
    }
  }
```

`studio/src/render/props.ts` — в возвращаемый объект после `hook: script.hook,`:

```ts
    badge: script.badge,
```

- [ ] **Step 5: Подпись в кадре вопроса**

`studio/src/remotion/scenes/Question.tsx` заменить целиком:

```tsx
import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C, fontFamily } from '../theme';

/** Задача: снимок чата с вопросом и лёгкое приближение; у реального кейса — подпись сверху. */
export const Question: React.FC<{ questionShot: string; durationInFrames: number; badge?: string }> = ({
  questionShot,
  durationInFrames,
  badge,
}) => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, 1.06], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: C.white }}>
      <Img
        src={staticFile(questionShot)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`, transformOrigin: '50% 70%' }}
      />
      {badge ? (
        <div
          style={{
            position: 'absolute',
            top: 140,
            left: 60,
            right: 60,
            padding: '20px 32px',
            borderRadius: 28,
            background: C.shade,
            color: C.white,
            fontFamily,
            fontWeight: 800,
            fontSize: 40,
            lineHeight: 1.2,
            textAlign: 'center',
          }}
        >
          {badge}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
```

`studio/src/remotion/Short.tsx` — в вызов `<Question … />` добавить `badge={p.badge}`:

```tsx
        <Question questionShot={p.questionShot} durationInFrames={scenes.question.duration} badge={p.badge} />
```

- [ ] **Step 6: Тесты, типы и сквозной рендер зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test && npm run test:render"`
Expected: `tsc` без вывода; `# fail 0` в обоих прогонах.

- [ ] **Step 7: Коммит**

```bash
git -C "$WT" add studio/src/types.ts studio/src/script.ts studio/src/timeline.ts studio/src/render/props.ts studio/src/remotion/Short.tsx studio/src/remotion/scenes/Question.tsx
git -C "$WT" commit -m "feat(studio): проверка опоры зацепки, подпись кейса, реплика ответа не короче 1,5 с

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 28: Движение сцены «Ответ» — чистой функцией с тестами

Хвост ревью плана 1: расчёт переезда, приближения и рамки жил внутри компонента, тестов у него не было. Он выносится в `answer-motion.ts` без изменения поведения: образец принят владельцем, кадры должны остаться теми же. Сглаживание и ключевые точки повторяют `interpolate` Remotion с `clamp`. Числа в тестах посчитаны по формулам прежнего компонента.

**Files:**
- Create: `studio/src/answer-motion.ts`, `studio/src/answer-motion.test.ts`
- Modify: `studio/src/remotion/scenes/Answer.tsx`, `studio/package.json` (`test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/answer-motion.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOVE, RING_FADE, RING_INSET, ZOOM, answerMotion, easeInOutCubic, lerpKeys } from './answer-motion';
import { FRAME } from './frame';
import type { ImageBox, Segment } from './types';

const boxes: ImageBox[] = [
  { n: 1, top: 900, height: 300, text: 'a' },
  { n: 2, top: 2400, height: 300, text: 'b' },
];
const seg = (lineId: string, box: number, from: number, duration: number): Segment => ({
  lineId, scene: 'answer', text: lineId, box, audio: `voice/${lineId}.mp3`, from, duration,
});
// Сцена ответа начинается с кадра 200; реплики — 200…439 и 448…687 ролика.
const segments = [seg('a1', 1, 200, 240), seg('a2', 2, 448, 240)];
const at = (frame: number) =>
  answerMotion({ frame, segments, sceneFrom: 200, boxes, imageHeight: 5400, frameHeight: 1920, anchorY: 760 })!;

test('сглаживание и ключевые точки — как interpolate Remotion с clamp', () => {
  assert.deepEqual([easeInOutCubic(0), easeInOutCubic(0.5), easeInOutCubic(1)], [0, 0.5, 1]);
  assert.equal(lerpKeys(-5, [0, 10], [1, 2]), 1);
  assert.equal(lerpKeys(5, [0, 10], [1, 2]), 1.5);
  assert.equal(lerpKeys(50, [0, 10], [1, 2]), 2);
});

test('первая реплика: от верха снимка к абзацу, приближение, затем рамка', () => {
  // Середина абзаца 1 — 1050 px; на линию 760 → сдвиг −290.
  assert.deepEqual([at(0).y, at(0).zoom, at(0).ring], [0, 1, 0]);
  assert.equal(at(MOVE / 2).y, -145);
  assert.deepEqual([at(MOVE).y, at(MOVE).zoom, at(MOVE).ring], [-290, ZOOM, 0]);
  assert.equal(at(MOVE + RING_FADE).ring, 1);
  assert.equal(at(239).box.n, 1);
});

test('к концу реплики приближение отпускается', () => {
  assert.equal(at(240).zoom, 1);
  assert.ok(at(235).zoom > 1 && at(235).zoom < ZOOM);
});

test('вторая реплика едет от первого абзаца ко второму', () => {
  // Середина абзаца 2 — 2550 px → сдвиг 760 − 2550 = −1790.
  assert.equal(at(248).y, -290);
  assert.equal(at(248 + MOVE).y, -1790);
  assert.equal(at(248 + MOVE).box.n, 2);
});

test('без реплик или абзацев — движения нет', () => {
  assert.equal(answerMotion({ frame: 0, segments: [], sceneFrom: 0, boxes, imageHeight: 5400, frameHeight: 1920, anchorY: 760 }), null);
});

test('рамка не уходит за кадр на пике приближения', () => {
  assert.ok(RING_INSET >= (FRAME.width / 2) * (1 - 1 / ZOOM));
});
```

В `studio/package.json` строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts src/errors.test.ts src/frame.test.ts src/answer-motion.test.ts",
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/answer-motion.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): движение сцены «Ответ» (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/answer-motion.test.ts"`
Expected: FAIL — `Cannot find module '…/src/answer-motion'`.

- [ ] **Step 3: Реализация**

`studio/src/answer-motion.ts`:

```ts
import { panOffset } from './pan';
import type { ImageBox, Segment } from './types';

/** Кадров на переезд к следующему абзацу. */
export const MOVE = 15;
/** Пик приближения абзаца. */
export const ZOOM = 1.08;
/** Кадров на появление рамки после переезда. */
export const RING_FADE = 10;
/** Кадров до конца реплики, за которые приближение отпускается. */
export const RELEASE = 10;
/**
 * Отступ рамки от краёв снимка. На пике приближения край рамки уходит наружу;
 * чтобы он остался в кадре, нужно ≥ (W/2)·(1 − 1/ZOOM) = 40 px. Берём 60 — с запасом.
 */
export const RING_INSET = 60;

export interface AnswerMotion {
  /** Сдвиг высокого снимка по вертикали, пиксели кадра. */
  y: number;
  zoom: number;
  /** Непрозрачность рамки абзаца, 0–1. */
  ring: number;
  box: ImageBox;
}

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** Easing.inOut(Easing.cubic) из Remotion. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Кусочно-линейно по ключевым точкам с зажимом краёв — interpolate Remotion с clamp. */
export function lerpKeys(t: number, input: number[], output: number[]): number {
  if (t <= input[0]) return output[0];
  for (let i = 1; i < input.length; i++) {
    if (t <= input[i]) {
      const k = (t - input[i - 1]) / (input[i] - input[i - 1]);
      return output[i - 1] + (output[i] - output[i - 1]) * k;
    }
  }
  return output[output.length - 1];
}

/**
 * Где снимок, насколько он приближен и видна ли рамка на кадре сцены «Ответ».
 * segments — реплики сцены с кадрами от начала ролика; sceneFrom переводит их
 * в кадры сцены. null — показывать нечего.
 */
export function answerMotion(o: {
  frame: number;
  segments: Segment[];
  sceneFrom: number;
  boxes: ImageBox[];
  imageHeight: number;
  frameHeight: number;
  anchorY: number;
}): AnswerMotion | null {
  if (o.segments.length === 0 || o.boxes.length === 0) return null;
  let idx = 0;
  o.segments.forEach((s, i) => {
    if (s.from - o.sceneFrom <= o.frame) idx = i;
  });
  const boxOf = (s: Segment): ImageBox => o.boxes.find((b) => b.n === s.box) ?? o.boxes[0];
  const offsetOf = (s: Segment): number => {
    const b = boxOf(s);
    return panOffset({ boxTop: b.top, boxHeight: b.height, imageHeight: o.imageHeight, frameHeight: o.frameHeight, anchorY: o.anchorY });
  };

  const seg = o.segments[idx];
  const t = o.frame - (seg.from - o.sceneFrom);
  const prev = idx > 0 ? offsetOf(o.segments[idx - 1]) : 0;
  const target = offsetOf(seg);
  const y = prev + (target - prev) * easeInOutCubic(clamp01(t / MOVE));
  const hold = Math.max(MOVE + 1, seg.duration - RELEASE);
  const stop = Math.max(hold + 1, seg.duration);
  return {
    y,
    zoom: lerpKeys(t, [0, MOVE, hold, stop], [1, ZOOM, ZOOM, 1]),
    ring: lerpKeys(t, [MOVE, MOVE + RING_FADE], [0, 1]),
    box: boxOf(seg),
  };
}
```

`studio/src/remotion/scenes/Answer.tsx` заменить целиком:

```tsx
import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { RING_INSET, answerMotion } from '../../answer-motion';
import type { ImageBox, Segment } from '../../types';
import { ANCHOR_Y, C, H, W } from '../theme';

/**
 * Ответ: высокий снимок едет к абзацу, о котором говорит голос, приближается к
 * нему и обводит рамкой. Расчёт движения — answer-motion.ts (с тестами).
 */
export const Answer: React.FC<{
  answerShot: string;
  imageHeight: number;
  boxes: ImageBox[];
  segments: Segment[];
  sceneFrom: number;
}> = ({ answerShot, imageHeight, boxes, segments, sceneFrom }) => {
  const frame = useCurrentFrame();
  const m = answerMotion({ frame, segments, sceneFrom, boxes, imageHeight, frameHeight: H, anchorY: ANCHOR_Y });
  if (!m) return <AbsoluteFill style={{ backgroundColor: C.white }} />;

  return (
    <AbsoluteFill style={{ backgroundColor: C.white, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, transform: `translateY(${m.y}px)` }}>
        <div
          style={{
            position: 'relative',
            width: W,
            height: imageHeight,
            transform: `scale(${m.zoom})`,
            transformOrigin: `50% ${m.box.top + m.box.height / 2}px`,
          }}
        >
          <Img src={staticFile(answerShot)} style={{ width: W, height: imageHeight, display: 'block' }} />
          <div
            style={{
              position: 'absolute',
              left: RING_INSET,
              right: RING_INSET,
              top: m.box.top - 14,
              height: m.box.height + 28,
              borderRadius: 24,
              border: `6px solid ${C.forest600}`,
              opacity: m.ring,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Тесты, типы и сквозной рендер зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test && npm run test:render"`
Expected: `tsc` без вывода; `# fail 0` в обоих прогонах.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add studio/src/answer-motion.ts studio/src/remotion/scenes/Answer.tsx
git -C "$WT" commit -m "refactor(studio): движение сцены «Ответ» — чистая функция с тестами, кадры прежние

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 29: Съёмка как функция

Хвост финального ревью плана 1: `run-capture.ts` выполнял команду прямо при импорте. Рабочему процессу нужна та же съёмка функцией: вход демо-аккаунта с кешем плюс съёмка сцены. Команда остаётся, но запускается только как точка входа — так же сделан `run-render.ts`.

**Files:**
- Modify: `studio/src/capture/run-capture.ts`, `studio/package.json` (`test`)
- Create: `studio/src/capture/run-capture.test.ts`

- [ ] **Step 1: Написать падающий тест**

`studio/src/capture/run-capture.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('команду capture можно импортировать: без аргументов она не запускается', async () => {
  const m = await import('./run-capture');
  assert.equal(typeof m.captureScene, 'function');
  assert.equal(m.DEFAULT_MIN_ANSWER_CHARS, 400);
});
```

В `studio/package.json` строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts src/errors.test.ts src/frame.test.ts src/answer-motion.test.ts src/capture/run-capture.test.ts",
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/capture/run-capture.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): съёмка импортируется функцией (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/capture/run-capture.test.ts"`
Expected: FAIL — импорт запускает команду, а она без аргументов выходит с `usage: npm run capture` и кодом 2.

- [ ] **Step 3: Реализация**

`studio/src/capture/run-capture.ts` заменить целиком:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type StudioConfig } from '../config';
import type { CaptureResult, Scene } from '../types';
import { captureChat } from './chat-scene';
import { loginDemoCached } from './login';

/** Порог длины ответа для ручного прогона; конвейер берёт его из short_settings.min_answer_chars. */
export const DEFAULT_MIN_ANSWER_CHARS = 400;
/** Кеш входа демо-аккаунта: SMS на номер ограничены по частоте. Файл вне git, права 600. */
const SESSION_CACHE = path.resolve('out', '.session.json');

/**
 * Вход демо-аккаунта (с кешем) и съёмка сцены в runDir. Одна и та же для
 * команды capture и рабочего процесса (studio/src/worker/jobs.ts).
 */
export async function captureScene(scene: Scene, cfg: StudioConfig, runDir: string, minAnswerChars: number): Promise<CaptureResult> {
  const session = await loginDemoCached(cfg, SESSION_CACHE);
  const result = await captureChat(scene, cfg, session, runDir, { minAnswerChars });
  if (!result) throw new Error('capture: съёмка вернула пробу вместо результата');
  fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sceneFile, ...flags] = process.argv.slice(2);
  if (!sceneFile) {
    console.error('usage: npm run capture -- <scene.json> [--probe]');
    process.exit(2);
  }
  const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')) as Scene;
  const cfg = parseConfig(process.env, { capture: true, tts: false });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve('out', `${path.basename(sceneFile, '.json')}-${stamp}`);
  if (flags.includes('--probe')) {
    const session = await loginDemoCached(cfg, SESSION_CACHE);
    await captureChat(scene, cfg, session, runDir, { minAnswerChars: DEFAULT_MIN_ANSWER_CHARS, probeOnly: true });
    console.log(`capture: проба → ${path.join(runDir, 'probe.png')}`);
  } else {
    const result = await captureScene(scene, cfg, runDir, DEFAULT_MIN_ANSWER_CHARS);
    console.log(`capture: готово → ${runDir} (ходов: ${result.turns}, абзацев: ${result.boxes.length})`);
    for (const b of result.boxes) console.log(`  [${b.n}] ${b.text}`);
  }
}
```

- [ ] **Step 4: Тесты и типы зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test"`
Expected: `tsc` без вывода; `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add studio/src/capture/run-capture.ts
git -C "$WT" commit -m "feat(studio): съёмка сцены функцией captureScene, команда — только как точка входа

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 30: Зависимости и окружение рабочего процесса

Рабочему процессу нужны база (`pg`) и MinIO (`@aws-sdk/client-s3`), версии — те же, что у бэкенда. `tsx` переезжает из devDependencies в dependencies: процесс запускается через него, а выкат с `npm ci --omit=dev` (план 3) иначе его не поставит.

**Files:**
- Modify: `studio/package.json`, `studio/package-lock.json`, `studio/src/config.ts`, `studio/src/config.test.ts`, `studio/.env.example`

- [ ] **Step 1: Написать падающий тест**

В конец `studio/src/config.test.ts`:

```ts
test('рабочему процессу нужны база и MinIO; бакет по умолчанию — общий бакет видео', () => {
  const worker = { capture: false, tts: false, worker: true };
  assert.throws(() => parseConfig({}, worker), /DATABASE_URL/);
  assert.throws(() => parseConfig({ DATABASE_URL: 'postgres://x' }, worker), /MINIO_ENDPOINT/);
  const c = parseConfig(
    { DATABASE_URL: 'postgres://x', MINIO_ENDPOINT: 'http://127.0.0.1:9000', MINIO_ACCESS_KEY: 'a', MINIO_SECRET_KEY: 's' },
    worker,
  );
  assert.equal(c.databaseUrl, 'postgres://x');
  assert.deepEqual(c.minio, { endpoint: 'http://127.0.0.1:9000', accessKey: 'a', secretKey: 's', bucket: 'linkeon-smm-videos' });
  assert.equal(parseConfig({}, none).minio, null);
});
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/config.test.ts
git -C "$WT" commit -m "test(studio): окружение рабочего процесса (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/config.test.ts"`
Expected: FAIL — `Missing expected exception` (DATABASE_URL не требуется).

- [ ] **Step 3: Конфиг**

`studio/src/config.ts`. Добавить тип и расширить `StudioConfig` и `parseConfig`:

```ts
export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}
```

В `StudioConfig` после `speechkitFolder: string;`:

```ts
  /** База и хранилище рабочего процесса (studio/src/worker); вне него — пусто. */
  databaseUrl: string;
  minio: MinioConfig | null;
```

Сигнатура и возврат `parseConfig`:

```ts
export function parseConfig(env: Env, needs: { capture: boolean; tts: boolean; worker?: boolean }): StudioConfig {
```

```ts
  const worker = needs.worker === true;
  return {
    cabinetUrl,
    apiUrl,
    basicAuth,
    demoPhone: needs.capture ? assertDemoPhone(required(env, 'DEMO_PHONE')) : (env.DEMO_PHONE?.trim() ?? ''),
    debugSecret: needs.capture ? required(env, 'DEBUG_SECRET') : '',
    speechkitKey: needs.tts ? required(env, 'YANDEX_SPEECHKIT_API_KEY') : '',
    speechkitFolder: needs.tts ? required(env, 'YANDEX_TTS_FOLDER_ID') : '',
    databaseUrl: worker ? required(env, 'DATABASE_URL') : '',
    minio: worker
      ? {
          endpoint: required(env, 'MINIO_ENDPOINT'),
          accessKey: required(env, 'MINIO_ACCESS_KEY'),
          secretKey: required(env, 'MINIO_SECRET_KEY'),
          // Общий бакет видео, как у бэкенда (shortsBucket в src/shorts/shorts.types.ts).
          bucket: env.MINIO_BUCKET_VIDEOS?.trim() || 'linkeon-smm-videos',
        }
      : null,
  };
```

В конец `studio/.env.example`:

```bash
# ── Рабочий процесс (npm run worker) ──
# База и MinIO той же среды, что API: на стенде — значения из ~/spirits_back/.env.
DATABASE_URL=
MINIO_ENDPOINT=
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
MINIO_BUCKET_VIDEOS=linkeon-smm-videos
```

- [ ] **Step 4: Зависимости**

В `studio/package.json`: в `dependencies` добавить `"@aws-sdk/client-s3": "^3.1025.0"`, `"pg": "^8.11.0"` и перенести туда `"tsx": "^4.23.12"` из `devDependencies`; в `devDependencies` добавить `"@types/pg": "^8.10.0"`. Порядок ключей — по алфавиту, как сейчас.

```bash
git -C "$WT" add studio/package.json studio/src/config.ts studio/.env.example
git -C "$WT" commit -m "feat(studio): окружение и зависимости рабочего процесса — база и MinIO

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Поставить зависимости на ноде и забрать lock-файл**

`npm install` перепишет `package-lock.json` в воркдереве ноды. Новый lock-файл забираем тем же прогоном и там же откатываем, под тем же локом: иначе следующий прогон упрётся в изменённый файл в дереве ноды. Весь вывод `npm install` — в stderr, в stdout — только lock-файл:

```bash
"$WT/studio/scripts/node-run.sh" "npm install --no-audit --no-fund >&2 && cat package-lock.json && git checkout -- package-lock.json" > "$WT/studio/package-lock.json.new"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); ok=('pg' in d['packages']['']['dependencies'], '@aws-sdk/client-s3' in d['packages']['']['dependencies']); print(*ok); sys.exit(0 if all(ok) else 1)" "$WT/studio/package-lock.json.new" && mv "$WT/studio/package-lock.json.new" "$WT/studio/package-lock.json"
git -C "$WT" add studio/package-lock.json
git -C "$WT" commit -m "build(studio): lock-файл с pg и @aws-sdk/client-s3

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `True True` — lock-файл валиден и знает новые зависимости. Lock-файл сначала ложится во временный `package-lock.json.new`: сорвавшийся прогон не испортит настоящий. Если упал сам `npm install`, lock-файл в дереве ноды мог остаться изменённым, и следующий прогон откажет с «незакоммиченное в дереве ноды». Тогда вернуть его: `ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'git -C ~/ci/wt/promo-shorts checkout -- studio/package-lock.json'`.

Run: `studio/scripts/node-run.sh "npm ci --no-audit --no-fund && npx tsc --noEmit && npm test"`
Expected: `npm ci` проходит по lock-файлу; `tsc` без вывода; `# fail 0`.

---

### Task 31: Очередь заданий студии в Postgres

Студия забирает задания из `short_video` тем же способом, что API — свои этапы: `FOR UPDATE SKIP LOCKED` и аренда. Задание, брошенное упавшим процессом, забирается снова после истечения аренды, с новой попыткой. Все записи — с условием на статус. Проверка — на одноразовой базе той же миграцией, что катит API: так контракт колонок проверяется против настоящей схемы.

**Files:**
- Create: `studio/src/worker/db.ts`, `studio/src/worker/db.integration.ts`
- Modify: `studio/package.json` (`test:db`)

- [ ] **Step 1: Одноразовая база на ноде (один раз)**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "sudo -u postgres psql -qc \"CREATE ROLE studioit LOGIN PASSWORD 'studioit'\" 2>/dev/null; sudo -u postgres psql -qc 'DROP DATABASE IF EXISTS studio_it' && sudo -u postgres psql -qc 'CREATE DATABASE studio_it OWNER studioit' && echo DB_OK"
```

Expected: `DB_OK`. База своя, не `shorts_it`: прогоны бэкенда и студии не стирают строки друг друга.

- [ ] **Step 2: Написать тест**

`studio/src/worker/db.integration.ts`:

```ts
/**
 * Очередь студии против живого Postgres — той же миграцией, что катит API
 * (src/shorts/migrations/001_shorts.sql): так контракт колонок проверяется на
 * настоящей схеме.
 *
 * База ОДНОРАЗОВАЯ: перед каждым тестом TRUNCATE. Гард отказывается работать с
 * базой приложения и с непустой short_video — до наката миграции.
 *
 *   sudo -u postgres psql -qc "CREATE ROLE studioit LOGIN PASSWORD 'studioit'"
 *   sudo -u postgres psql -qc "CREATE DATABASE studio_it OWNER studioit"
 *   STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { StudioError } from '../errors';
import { claimJob, completeCapture, completeRender, failJob, minAnswerChars, type StoredCapture } from './db';

const DB_URL = process.env.STUDIO_PG_URL;
const MIGRATION = fileURLToPath(new URL('../../../src/shorts/migrations/001_shorts.sql', import.meta.url));
const skip = DB_URL ? false : 'нет STUDIO_PG_URL — нужна одноразовая база (рецепт в шапке файла)';

describe('очередь студии против живого Postgres', { skip }, () => {
  let pool: pg.Pool;
  let ours = false;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
    const probe = await pool.query(
      `SELECT to_regclass('public.ai_profiles_consolidated') AS app, to_regclass('public.short_video') AS shorts`,
    );
    if (probe.rows[0].app) throw new Error('STUDIO_PG_URL указывает на базу приложения — нужна одноразовая');
    if (probe.rows[0].shorts) {
      const n = await pool.query('SELECT count(*)::int AS n FROM short_video');
      if (n.rows[0].n > 0) throw new Error('в short_video уже есть строки — нужна одноразовая база');
    }
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    ours = true;
  });

  beforeEach(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
  });

  after(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
    await pool?.end();
  });

  const scene = { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Вопрос', followups: [] };

  async function insert(status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const cols: Record<string, unknown> = { rubric: 'assistant', source: 'manual', topic_key: 't', status, scene: JSON.stringify(scene), ...extra };
    const keys = Object.keys(cols);
    const r = await pool.query(
      `INSERT INTO short_video (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => cols[k]),
    );
    return r.rows[0].id;
  }

  const row = async (id: string) => (await pool.query('SELECT * FROM short_video WHERE id = $1', [id])).rows[0];

  it('задание забирается один раз; брошенное упавшим процессом — снова, с новой попыткой', async () => {
    const id = await insert('capture_queued');
    const job = await claimJob(pool, 'capture');
    assert.equal(job?.id, id);
    assert.equal(job?.attempts, 1);
    assert.deepEqual(job?.scene, scene);
    assert.equal((await row(id)).status, 'capturing');
    assert.equal(await claimJob(pool, 'capture'), null);

    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const again = await claimJob(pool, 'capture');
    assert.deepEqual([again?.id, again?.attempts], [id, 2]);
  });

  it('съёмка готова — writing и съёмка в базе', async () => {
    const id = await insert('capture_queued');
    await claimJob(pool, 'capture');
    const capture = { scene, questionShotKey: 'shorts/x/capture-1/question.png', answerShotKey: 'shorts/x/capture-1/answer.png', paragraphs: [{ n: 1, text: 'a' }] } as unknown as StoredCapture;
    assert.equal(await completeCapture(pool, id, capture), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.lease_until, r.capture.answerShotKey], ['writing', 0, null, 'shorts/x/capture-1/answer.png']);
  });

  it('сборка готова — pending_review без сообщения владельцу, с файлами', async () => {
    const id = await insert('render_queued', { review_message_id: 55 });
    await claimJob(pool, 'render');
    assert.equal(await completeRender(pool, id, { videoKey: 'shorts/x/video.mp4', coverKey: 'shorts/x/cover.jpg', durationMs: 44000 }), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.video_key, r.duration_ms, r.review_message_id], ['pending_review', 'shorts/x/video.mp4', 44000, null]);
  });

  it('сбой с повтором — пауза в очереди; без повтора — failed с этапом', async () => {
    const id = await insert('capture_queued');
    const job = await claimJob(pool, 'capture');
    assert.equal(await failJob(pool, job!, new StudioError('answer_rejected', 'ответ не годится', true)), 'retry');
    const r = await row(id);
    assert.deepEqual([r.status, r.last_error], ['capture_queued', 'съёмка: ответ не годится']);
    assert.ok(new Date(r.lease_until).getTime() > Date.now());
    assert.equal(await claimJob(pool, 'capture'), null);

    await pool.query(`UPDATE short_video SET lease_until = NULL WHERE id = $1`, [id]);
    const second = await claimJob(pool, 'capture');
    assert.equal(await failJob(pool, second!, new StudioError('wrong_assistant', 'не тот ассистент', false)), 'failed');
    const f = await row(id);
    assert.deepEqual([f.status, f.failed_from, f.failure_notified], ['failed', 'capturing', false]);
  });

  it('озвучка длиннее 60 с — сценарий назад сценаристу; после трёх кругов — failed', async () => {
    const id = await insert('render_queued', { writer_rounds: 1 });
    const job = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, job!, new StudioError('too_long', 'timeline: ролик 63.2 с — длиннее 60 с', false)), 'writer');
    const r = await row(id);
    assert.deepEqual([r.status, r.writer_feedback], ['writing', 'озвучка: timeline: ролик 63.2 с — длиннее 60 с']);

    await pool.query(`UPDATE short_video SET status = 'render_queued', writer_rounds = 3 WHERE id = $1`, [id]);
    const last = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, last!, new StudioError('too_long', 'снова длинно', false)), 'failed');
  });

  it('порог длины ответа — из настроек', async () => {
    assert.equal(await minAnswerChars(pool), 400);
    await pool.query('UPDATE short_settings SET min_answer_chars = 500 WHERE id = 1');
    assert.equal(await minAnswerChars(pool), 500);
    await pool.query('UPDATE short_settings SET min_answer_chars = 400 WHERE id = 1');
  });
});
```

В `studio/package.json`, в `scripts` после `test:render`:

```json
    "test:db": "tsx --test src/worker/db.integration.ts",
```

- [ ] **Step 3: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/worker/db.integration.ts studio/package.json
git -C "$WT" commit -m "test(studio): очередь заданий против живого Postgres (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db"`
Expected: FAIL — `Cannot find module '…/src/worker/db'`.

- [ ] **Step 4: Реализация**

`studio/src/worker/db.ts`:

```ts
import { WRITER_FEEDBACK_CODES, type StudioError } from '../errors';
import type { CaptureResult, Scene, Script } from '../types';

/** То, что нужно от pg.Pool, — чтобы в тестах рабочего процесса его можно было заменить. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export type JobKind = 'capture' | 'render';

interface QueueSpec {
  queued: string;
  running: string;
  /** Этап в last_error и в сообщении владельцу. */
  label: string;
}

/** Очереди студии в short_video. Статусы и колонки — контракт с src/shorts/shorts.types.ts бэкенда. */
export const QUEUES: Record<JobKind, QueueSpec> = {
  capture: { queued: 'capture_queued', running: 'capturing', label: 'съёмка' },
  render: { queued: 'render_queued', running: 'rendering', label: 'сборка' },
};

/**
 * Аренда задания. Съёмка с двумя уточнениями ждёт ответа до 5 минут на каждый
 * ход, сборка с озвучкой — минуты. Упавший процесс отдаёт задание через столько.
 */
export const LEASE_MINUTES = 30;
/** Пересъёмка «до двух раз», SpeechKit и рендер — «до трёх попыток» (спека): три попытки задания. */
export const MAX_JOB_ATTEMPTS = 3;
/** Пауза перед повтором: стенд или кабинет могли моргнуть. */
export const RETRY_DELAY_SEC = 120;
/** Сколько раз подряд сценарий может вернуться сценаристу из-за длины озвучки. */
export const MAX_WRITER_ROUNDS = 3;

/** Съёмка, как она лежит в базе: файлы — ключами MinIO. Зеркало ShortCapture бэкенда. */
export type StoredCapture = Omit<CaptureResult, 'questionShot' | 'answerShot'> & {
  questionShotKey: string;
  answerShotKey: string;
};

export interface Job {
  id: string;
  kind: JobKind;
  attempts: number;
  writerRounds: number;
  scene: Scene | null;
  capture: StoredCapture | null;
  script: Script | null;
}

export interface RenderOutput {
  videoKey: string;
  coverKey: string;
  durationMs: number;
}

export type FailOutcome = 'retry' | 'writer' | 'failed';

/** Очередь, как её видят задания (jobs.ts). */
export interface Queue {
  claim(kind: JobKind): Promise<Job | null>;
  completeCapture(id: string, capture: StoredCapture): Promise<boolean>;
  completeRender(id: string, out: RenderOutput): Promise<boolean>;
  fail(job: Job, err: StudioError): Promise<FailOutcome>;
  minAnswerChars(): Promise<number>;
}

/**
 * Взять одно задание: из очереди (аренда пуста или истекла — пауза повтора
 * кончилась) или брошенное упавшим процессом (в работе, аренда истекла).
 * Попытку считает захват.
 */
export async function claimJob(db: Queryable, kind: JobKind): Promise<Job | null> {
  const q = QUEUES[kind];
  const r = await db.query(
    `UPDATE short_video
        SET status = $2, lease_until = now() + make_interval(mins => $3), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM short_video
         WHERE (status = $1 AND (lease_until IS NULL OR lease_until < now()))
            OR (status = $2 AND lease_until < now())
         ORDER BY slot_at NULLS LAST, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, attempts, writer_rounds, scene, capture, script`,
    [q.queued, q.running, LEASE_MINUTES],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind,
    attempts: Number(row.attempts),
    writerRounds: Number(row.writer_rounds ?? 0),
    scene: row.scene ?? null,
    capture: row.capture ?? null,
    script: row.script ?? null,
  };
}

/** @returns false — ролик ушёл из capturing, пока шла съёмка (его отклонили), результат не записан */
export async function completeCapture(db: Queryable, id: string, capture: StoredCapture): Promise<boolean> {
  const r = await db.query(
    `UPDATE short_video
        SET status = 'writing', capture = $2::jsonb, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'capturing'`,
    [id, JSON.stringify(capture)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** review_message_id = NULL — сигнал API прислать новый вариант владельцу. */
export async function completeRender(db: Queryable, id: string, out: RenderOutput): Promise<boolean> {
  const r = await db.query(
    `UPDATE short_video
        SET status = 'pending_review', video_key = $2, cover_key = $3, duration_ms = $4,
            review_message_id = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'rendering'`,
    [id, out.videoKey, out.coverKey, out.durationMs],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Сбой задания:
 * - озвучка вышла за 30–60 с или реплика короче 1,5 с — сценарий назад
 *   сценаристу с пояснением, не больше MAX_WRITER_ROUNDS кругов;
 * - повторяемый сбой, попытки есть — обратно в очередь с паузой;
 * - иначе failed: failed_from — с чего продолжит «Повторить», владельцу напишет API.
 */
export async function failJob(db: Queryable, job: Job, err: StudioError): Promise<FailOutcome> {
  const q = QUEUES[job.kind];
  const message = `${q.label}: ${err.message}`.slice(0, 1000);
  if (job.kind === 'render' && WRITER_FEEDBACK_CODES.has(err.code) && job.writerRounds < MAX_WRITER_ROUNDS) {
    await db.query(
      `UPDATE short_video
          SET status = 'writing', writer_feedback = $3, last_error = $4, attempts = 0, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [job.id, q.running, `озвучка: ${err.message}`, message],
    );
    return 'writer';
  }
  if (err.retryable && job.attempts < MAX_JOB_ATTEMPTS) {
    await db.query(
      `UPDATE short_video
          SET status = $3, lease_until = now() + make_interval(secs => $4), last_error = $5, updated_at = now()
        WHERE id = $1 AND status = $2`,
      [job.id, q.running, q.queued, RETRY_DELAY_SEC, message],
    );
    return 'retry';
  }
  await db.query(
    `UPDATE short_video
        SET status = 'failed', failed_from = $2, lease_until = NULL, last_error = $3, failure_notified = false, updated_at = now()
      WHERE id = $1 AND status = $2`,
    [job.id, q.running, message],
  );
  return 'failed';
}

export async function minAnswerChars(db: Queryable): Promise<number> {
  const r = await db.query('SELECT min_answer_chars FROM short_settings WHERE id = 1');
  return Number(r.rows[0]?.min_answer_chars ?? 400);
}

export function pgQueue(db: Queryable): Queue {
  return {
    claim: (kind) => claimJob(db, kind),
    completeCapture: (id, capture) => completeCapture(db, id, capture),
    completeRender: (id, out) => completeRender(db, id, out),
    fail: (job, err) => failJob(db, job, err),
    minAnswerChars: () => minAnswerChars(db),
  };
}
```

- [ ] **Step 5: Тест проходит, типы чистые**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db"`
Expected: `tsc` без вывода; `# pass 6`, `# fail 0`.

Run: `studio/scripts/node-run.sh "npm run test:db"`
Expected: тесты пропущены (`# skipped 6` или описание помечено skip), не упали.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add studio/src/worker/db.ts
git -C "$WT" commit -m "feat(studio): очередь заданий в Postgres — захват с арендой, итог и сбой с условием на статус

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 32: Файлы заданий в MinIO

**Files:**
- Create: `studio/src/worker/storage.ts`, `studio/src/worker/storage.test.ts`
- Modify: `studio/package.json` (`test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/worker/storage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Storage } from './storage';

const cfg = { endpoint: 'http://127.0.0.1:9000', accessKey: 'a', secretKey: 's', bucket: 'linkeon-smm-videos' };

test('файл уходит в бакет под ключом, с типом; скачивается в файл', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-storage-'));
  const sent: any[] = [];
  const client = {
    send: async (cmd: any) => {
      sent.push(cmd);
      return cmd instanceof GetObjectCommand ? { Body: Readable.from([Buffer.from('видео')]) } : {};
    },
  };
  const storage = s3Storage(cfg, client);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'байты');

  await storage.put('shorts/x/video.mp4', path.join(dir, 'video.mp4'), 'video/mp4');
  assert.ok(sent[0] instanceof PutObjectCommand);
  // После assert.ok TypeScript сужает sent[0] до PutObjectCommand, а Body там — union
  // потоковых типов; в тесте это Buffer.
  const input = sent[0].input as { Bucket?: string; Key?: string; ContentType?: string; Body?: Buffer };
  assert.deepEqual(
    [input.Bucket, input.Key, input.ContentType, input.Body?.toString()],
    ['linkeon-smm-videos', 'shorts/x/video.mp4', 'video/mp4', 'байты'],
  );

  await storage.get('shorts/x/video.mp4', path.join(dir, 'got.mp4'));
  assert.ok(sent[1] instanceof GetObjectCommand);
  assert.equal(fs.readFileSync(path.join(dir, 'got.mp4'), 'utf8'), 'видео');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

В `studio/package.json` строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts src/errors.test.ts src/frame.test.ts src/answer-motion.test.ts src/capture/run-capture.test.ts src/worker/storage.test.ts",
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/worker/storage.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): файлы заданий в MinIO (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/worker/storage.test.ts"`
Expected: FAIL — `Cannot find module '…/src/worker/storage'`.

- [ ] **Step 3: Реализация**

`studio/src/worker/storage.ts`:

```ts
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MinioConfig } from '../config';

/** Файлы заданий: снимки съёмки, видео и обложка (ключи — в jobs.ts). */
export interface Storage {
  put(key: string, file: string, contentType: string): Promise<void>;
  get(key: string, dest: string): Promise<void>;
}

/**
 * MinIO по протоколу S3 — как StorageService бэкенда: path-style, регион
 * любой. Файл целиком в памяти: ролик — около 13 МБ, снимки — единицы МБ.
 * client — для тестов.
 */
export function s3Storage(cfg: MinioConfig, client?: { send(cmd: any): Promise<any> }): Storage {
  const s3 =
    client ??
    new S3Client({
      endpoint: cfg.endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: true,
    });
  return {
    async put(key, file, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: fs.readFileSync(file), ContentType: contentType }));
    },
    async get(key, dest) {
      const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      await pipeline(res.Body as Readable, fs.createWriteStream(dest));
    },
  };
}
```

- [ ] **Step 4: Тесты и типы зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test"`
Expected: `tsc` без вывода; `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
git -C "$WT" add studio/src/worker/storage.ts
git -C "$WT" commit -m "feat(studio): файлы заданий в MinIO

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 33: Задания `capture` и `render`

Съёмка: вход и съёмка сцены, снимки — в MinIO под ключами попытки, результат — в базу без локальных путей. Сборка: снимки из MinIO в свежую папку, туда же `capture.json` и `script.json`, затем `renderRun` (озвучка, Remotion, проверка файла), видео и обложка — в MinIO. Первой берётся сборка: ролик ближе к концу пути. Старые рабочие папки старше недели удаляются при старте процесса — сотни рендеров иначе съедят диск.

**Files:**
- Create: `studio/src/worker/jobs.ts`, `studio/src/worker/jobs.test.ts`
- Modify: `studio/src/render/run-render.ts` (длительность в результате), `studio/package.json` (`test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/worker/jobs.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import type { RenderResult } from '../render/run-render';
import type { CaptureResult, Scene, Script } from '../types';
import type { FailOutcome, Job, Queue, RenderOutput, StoredCapture } from './db';
import { coverKey, pruneOld, runOne, shotKey, videoKey, type JobDeps } from './jobs';
import type { Storage } from './storage';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const scene: Scene = { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Вопрос', followups: [] };
const script = { hook: 'h', voice: 'madirus', lines: [], final: { assistantsCount: 18 } } as unknown as Script;

function fakeQueue(jobs: Partial<Record<'capture' | 'render', Job>>) {
  const calls: Record<string, unknown[]> = { capture: [], render: [], fail: [], claim: [] };
  const queue: Queue = {
    async claim(kind) {
      calls.claim.push(kind);
      const job = jobs[kind] ?? null;
      delete jobs[kind];
      return job;
    },
    async completeCapture(id, capture) {
      calls.capture.push([id, capture]);
      return true;
    },
    async completeRender(id, out) {
      calls.render.push([id, out]);
      return true;
    },
    async fail(job, err): Promise<FailOutcome> {
      calls.fail.push([job.id, err]);
      return 'retry';
    },
    async minAnswerChars() {
      return 500;
    },
  };
  return { queue, calls };
}

function fakeStorage() {
  const files = new Map<string, string>();
  const storage: Storage = {
    async put(key, file) {
      files.set(key, fs.readFileSync(file, 'utf8'));
    },
    async get(key, dest) {
      fs.writeFileSync(dest, files.get(key) ?? '');
    },
  };
  return { storage, files };
}

function deps(over: Partial<JobDeps> & Pick<JobDeps, 'queue' | 'storage'>): JobDeps {
  return {
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-jobs-')),
    capture: async () => {
      throw new Error('съёмка не ожидалась');
    },
    render: async () => {
      throw new Error('сборка не ожидалась');
    },
    log: () => {},
    ...over,
  };
}

const job = (kind: 'capture' | 'render', over: Partial<Job> = {}): Job => ({
  id: ID, kind, attempts: 1, writerRounds: 0, scene, capture: null, script: null, ...over,
});

test('съёмка: снимки — в MinIO под ключами попытки, съёмка — в базу без путей', async () => {
  const { queue, calls } = fakeQueue({ capture: job('capture', { attempts: 2 }) });
  const { storage, files } = fakeStorage();
  let minChars = 0;
  const d = deps({
    queue,
    storage,
    capture: async (s, runDir, min) => {
      minChars = min;
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'question.png'), 'вопрос');
      fs.writeFileSync(path.join(runDir, 'answer.png'), 'ответ');
      return { scene: s, questionShot: 'question.png', answerShot: 'answer.png', boxes: [], paragraphs: [] } as unknown as CaptureResult;
    },
  });
  assert.equal(await runOne(d), true);
  assert.equal(minChars, 500);
  assert.equal(files.get(shotKey(ID, 2, 'answer.png')), 'ответ');
  const [id, stored] = calls.capture[0] as [string, StoredCapture & Record<string, unknown>];
  assert.equal(id, ID);
  assert.equal(stored.questionShotKey, `shorts/${ID}/capture-2/question.png`);
  assert.equal('questionShot' in stored, false);
});

test('сборка: снимки из MinIO, сценарий и съёмка файлами, видео и обложка — в MinIO', async () => {
  const capture = { scene, questionShotKey: 'q-key', answerShotKey: 'a-key', boxes: [], paragraphs: [] } as unknown as StoredCapture;
  const { queue, calls } = fakeQueue({ render: job('render', { capture, script }) });
  const { storage, files } = fakeStorage();
  files.set('q-key', 'вопрос');
  files.set('a-key', 'ответ');
  const d = deps({
    queue,
    storage,
    render: async (runDir): Promise<RenderResult> => {
      assert.equal(fs.readFileSync(path.join(runDir, 'answer.png'), 'utf8'), 'ответ');
      const c = JSON.parse(fs.readFileSync(path.join(runDir, 'capture.json'), 'utf8'));
      assert.deepEqual([c.questionShot, c.answerShot, 'answerShotKey' in c], ['question.png', 'answer.png', false]);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')), script);
      fs.writeFileSync(path.join(runDir, 'video.mp4'), 'видео');
      fs.writeFileSync(path.join(runDir, 'cover.jpg'), 'обложка');
      return { video: path.join(runDir, 'video.mp4'), cover: path.join(runDir, 'cover.jpg'), problems: [], durationSec: 44.2 };
    },
  });
  assert.equal(await runOne(d), true);
  assert.equal(files.get(videoKey(ID)), 'видео');
  assert.equal(files.get(coverKey(ID)), 'обложка');
  assert.deepEqual(calls.render[0], [ID, { videoKey: `shorts/${ID}/video.mp4`, coverKey: `shorts/${ID}/cover.jpg`, durationMs: 44200 } satisfies RenderOutput]);
});

test('сборка — первой: ролик ближе к концу пути', async () => {
  const { queue, calls } = fakeQueue({ capture: job('capture'), render: job('render') });
  await runOne(deps({ queue, storage: fakeStorage().storage }));
  assert.equal(calls.claim[0], 'render');
});

test('проверка файла не прошла — video_invalid с повтором', async () => {
  const capture = { scene, questionShotKey: 'q', answerShotKey: 'a' } as unknown as StoredCapture;
  const { queue, calls } = fakeQueue({ render: job('render', { capture, script }) });
  const d = deps({
    queue,
    storage: fakeStorage().storage,
    render: async (runDir) => ({ video: path.join(runDir, 'v'), cover: path.join(runDir, 'c'), problems: ['тишина 3.1 с с 23.0 с'], durationSec: 44 }),
  });
  await runOne(d);
  const [, err] = calls.fail[0] as [string, StudioError];
  assert.deepEqual([err.code, err.retryable], ['video_invalid', true]);
  assert.match(err.message, /тишина 3.1 с/);
});

test('незнакомая ошибка — unknown с повтором; задание без сцены — no_input без повтора', async () => {
  const a = fakeQueue({ capture: job('capture') });
  await runOne(deps({ queue: a.queue, storage: fakeStorage().storage, capture: async () => { throw new Error('ECONNRESET'); } }));
  assert.deepEqual([(a.calls.fail[0] as [string, StudioError])[1].code, (a.calls.fail[0] as [string, StudioError])[1].retryable], ['unknown', true]);

  const b = fakeQueue({ capture: job('capture', { scene: null }) });
  await runOne(deps({ queue: b.queue, storage: fakeStorage().storage }));
  assert.deepEqual([(b.calls.fail[0] as [string, StudioError])[1].code, (b.calls.fail[0] as [string, StudioError])[1].retryable], ['no_input', false]);
});

test('нет заданий — false', async () => {
  assert.equal(await runOne(deps({ queue: fakeQueue({}).queue, storage: fakeStorage().storage })), false);
});

test('старые рабочие папки удаляются, свежие — нет', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-prune-'));
  fs.mkdirSync(path.join(root, 'old'));
  fs.mkdirSync(path.join(root, 'fresh'));
  const weekAgo = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(path.join(root, 'old'), weekAgo, weekAgo);
  assert.equal(pruneOld(root, 7), 1);
  assert.deepEqual(fs.readdirSync(root), ['fresh']);
  assert.equal(pruneOld(path.join(root, 'нет такой'), 7), 0);
});
```

В `studio/package.json` строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts src/errors.test.ts src/frame.test.ts src/answer-motion.test.ts src/capture/run-capture.test.ts src/worker/storage.test.ts src/worker/jobs.test.ts",
```

- [ ] **Step 2: Закоммитить и убедиться, что тест падает**

```bash
git -C "$WT" add studio/src/worker/jobs.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): задания съёмки и сборки (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `studio/scripts/node-run.sh "npx tsx --test src/worker/jobs.test.ts"`
Expected: FAIL — `Cannot find module '…/src/worker/jobs'`.

- [ ] **Step 3: Длительность в результате сборки**

`studio/src/render/run-render.ts`:
- в `RenderResult` после `problems: string[];` добавить `durationSec: number;`;
- `return { video, cover, problems: verifyVideo(probe, silences) };` → `return { video, cover, problems: verifyVideo(probe, silences), durationSec: probe.durationSec };`.

- [ ] **Step 4: Реализация заданий**

`studio/src/worker/jobs.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { StudioError, toStudioError } from '../errors';
import type { RenderResult } from '../render/run-render';
import type { CaptureResult, Scene } from '../types';
import type { Job, JobKind, Queue } from './db';
import type { Storage } from './storage';

export interface JobDeps {
  queue: Queue;
  storage: Storage;
  /** Рабочие папки заданий: <workRoot>/<id>/capture-<попытка>, render-<попытка>. */
  workRoot: string;
  capture: (scene: Scene, runDir: string, minAnswerChars: number) => Promise<CaptureResult>;
  render: (runDir: string) => Promise<RenderResult>;
  log: (line: string) => void;
}

/** Ключи MinIO — контракт с API: видео и обложку он шлёт в Telegram отсюда. */
export const shotKey = (id: string, attempt: number, name: string): string => `shorts/${id}/capture-${attempt}/${name}`;
export const videoKey = (id: string): string => `shorts/${id}/video.mp4`;
export const coverKey = (id: string): string => `shorts/${id}/cover.jpg`;

export async function runCapture(job: Job, d: JobDeps): Promise<void> {
  if (!job.scene) throw new StudioError('no_input', 'у ролика нет сцены', false);
  const runDir = path.join(d.workRoot, job.id, `capture-${job.attempts}`);
  const result = await d.capture(job.scene, runDir, await d.queue.minAnswerChars());
  const questionShotKey = shotKey(job.id, job.attempts, 'question.png');
  const answerShotKey = shotKey(job.id, job.attempts, 'answer.png');
  await d.storage.put(questionShotKey, path.join(runDir, result.questionShot), 'image/png');
  await d.storage.put(answerShotKey, path.join(runDir, result.answerShot), 'image/png');
  const { questionShot: _q, answerShot: _a, ...rest } = result;
  if (!(await d.queue.completeCapture(job.id, { ...rest, questionShotKey, answerShotKey }))) {
    d.log(`capture ${job.id}: ролик ушёл из capturing, пока шла съёмка — результат не записан`);
  }
}

export async function runRender(job: Job, d: JobDeps): Promise<void> {
  if (!job.capture || !job.script) throw new StudioError('no_input', 'у ролика нет съёмки или сценария', false);
  const runDir = path.join(d.workRoot, job.id, `render-${job.attempts}`);
  fs.mkdirSync(runDir, { recursive: true });
  await d.storage.get(job.capture.questionShotKey, path.join(runDir, 'question.png'));
  await d.storage.get(job.capture.answerShotKey, path.join(runDir, 'answer.png'));
  const { questionShotKey: _q, answerShotKey: _a, ...rest } = job.capture;
  fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify({ ...rest, questionShot: 'question.png', answerShot: 'answer.png' }, null, 2));
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(job.script, null, 2));

  const r = await d.render(runDir);
  if (r.problems.length) throw new StudioError('video_invalid', `проверка файла не прошла: ${r.problems.join('; ')}`, true);
  await d.storage.put(videoKey(job.id), r.video, 'video/mp4');
  await d.storage.put(coverKey(job.id), r.cover, 'image/jpeg');
  const out = { videoKey: videoKey(job.id), coverKey: coverKey(job.id), durationMs: Math.round(r.durationSec * 1000) };
  if (!(await d.queue.completeRender(job.id, out))) {
    d.log(`render ${job.id}: ролик ушёл из rendering, пока шла сборка — результат не записан`);
  }
}

/** Сборка — первой: ролик ближе к концу пути и к владельцу. */
const ORDER: JobKind[] = ['render', 'capture'];

/** Одно задание: взять, выполнить, при сбое — отдать очереди с кодом. @returns false — заданий нет */
export async function runOne(d: JobDeps): Promise<boolean> {
  for (const kind of ORDER) {
    const job = await d.queue.claim(kind);
    if (!job) continue;
    d.log(`${kind} ${job.id}: попытка ${job.attempts}`);
    try {
      if (kind === 'capture') await runCapture(job, d);
      else await runRender(job, d);
      d.log(`${kind} ${job.id}: готово`);
    } catch (e) {
      const err = toStudioError(e);
      const outcome = await d.queue.fail(job, err);
      d.log(`${kind} ${job.id}: ${err.code} — ${err.message} → ${outcome}`);
    }
    return true;
  }
  return false;
}

/** Рабочие папки заданий старше days — удалить. @returns сколько удалено */
export function pruneOld(workRoot: string, days: number, now = Date.now()): number {
  if (!fs.existsSync(workRoot)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(workRoot)) {
    const dir = path.join(workRoot, name);
    const st = fs.statSync(dir);
    if (st.isDirectory() && now - st.mtimeMs > days * 86_400_000) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
```

- [ ] **Step 5: Тесты и типы зелёные**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test"`
Expected: `tsc` без вывода; `# fail 0`.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add studio/src/worker/jobs.ts studio/src/render/run-render.ts
git -C "$WT" commit -m "feat(studio): задания съёмки и сборки — файлы через MinIO, сбои с кодами

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 34: Рабочий процесс, админка стенда с ноды, README и сторож контракта

`npm run worker` — цикл: задание, иначе пауза 15 с. `npm run worker -- --once` — одно задание, и выход: так рабочий процесс гоняется на стенде в этом плане (PM2 `linkeon-studio` — план 3). Строки лога — с датой: в pm2-логах её нет. `scripts/stand-admin.ts` — вызовы `admin/shorts` стенда прямо с ноды, в API на `127.0.0.1:3001`, мимо Nginx и Basic Auth. Сторож контракта в jest бэкенда сверяет имена полей и ключей студии с тем, что читает API.

**Files:**
- Create: `studio/src/worker/worker.ts`, `studio/scripts/stand-admin.ts`, `src/shorts/shorts.contract.spec.ts`
- Modify: `studio/src/capture/login.ts` (экспорт вебхуков входа), `studio/package.json` (`worker`), `studio/.env.example`, `studio/README.md`

- [ ] **Step 1: Сторож контракта (бэкенд) — падающий тест**

`src/shorts/shorts.contract.spec.ts`:

```ts
/**
 * Контракт API и студии — строки short_video и ключи MinIO. Импортировать
 * типы студии нельзя (отдельный ESM-пакет вне сборки API), поэтому сторож
 * читает её исходники текстом: переименование поля в одной половине должно
 * ронять тест, а не съёмку на стенде.
 */
import * as fs from 'fs';
import * as path from 'path';

const studio = (p: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'studio', 'src', p), 'utf8');

describe('контракт API и студии', () => {
  it('сцена, съёмка и сценарий студии — с полями, которые пишет и читает API', () => {
    const types = studio('types.ts');
    for (const field of [
      'assistantId', 'assistantName', 'followups', 'answerShotWidth', 'answerShotHeight', 'answerText', 'turns',
      'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer',
    ]) {
      expect(types).toMatch(new RegExp(`\\b${field}\\??:`));
    }
  });

  it('очередь студии — те же статусы и колонки', () => {
    const db = studio('worker/db.ts');
    for (const s of [
      "'capture_queued'", "'capturing'", "'render_queued'", "'rendering'", "status = 'writing'", "status = 'pending_review'",
      'writer_feedback', 'failed_from', 'failure_notified = false', 'questionShotKey', 'answerShotKey', 'review_message_id = NULL',
    ]) {
      expect(db).toContain(s);
    }
  });

  it('ключи видео и обложки — те, что API шлёт в Telegram', () => {
    const jobs = studio('worker/jobs.ts');
    expect(jobs).toContain('shorts/${id}/video.mp4');
    expect(jobs).toContain('shorts/${id}/cover.jpg');
  });
});
```

```bash
git -C "$WT" add src/shorts/shorts.contract.spec.ts
git -C "$WT" commit -m "test(shorts): сторож контракта API и студии

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts"`
Expected: PASS: обе половины уже написаны (задачи 1, 26–27, 31, 33). Если тест красный — разошлись имена полей. Чинить расхождение в коде, не в тесте.

- [ ] **Step 2: Рабочий процесс**

`studio/src/worker/worker.ts`:

```ts
import 'dotenv/config';
import path from 'node:path';
import pg from 'pg';
import { captureScene } from '../capture/run-capture';
import { parseConfig } from '../config';
import { renderRun } from '../render/run-render';
import { pgQueue } from './db';
import { pruneOld, runOne, type JobDeps } from './jobs';
import { s3Storage } from './storage';

/**
 * Рабочий процесс студии: забирает задания capture и render из short_video,
 * по одному за раз (спека: «по одному заданию за раз»).
 *   npm run worker            — цикл; без заданий — пауза IDLE_MS
 *   npm run worker -- --once  — одно задание и выход (стенд в плане 2)
 * SIGTERM/SIGINT — дождаться текущего задания и выйти; брошенное задание
 * вернётся в очередь по истечении аренды.
 */
const IDLE_MS = 15_000;
const KEEP_DAYS = 7;

const cfg = parseConfig(process.env, { capture: true, tts: true, worker: true });
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const deps: JobDeps = {
  queue: pgQueue(pool),
  storage: s3Storage(cfg.minio!),
  workRoot: path.resolve('out', 'jobs'),
  capture: (scene, runDir, minAnswerChars) => captureScene(scene, cfg, runDir, minAnswerChars),
  render: (runDir) => renderRun(runDir),
  log,
};

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopping = true;
    log(`worker: ${sig} — закончу текущее задание и выйду`);
  });
}

const once = process.argv.includes('--once');
const pruned = pruneOld(deps.workRoot, KEEP_DAYS);
if (pruned) log(`worker: удалено старых рабочих папок — ${pruned}`);
log(`worker: старт${once ? ' (одно задание)' : ''}`);
try {
  while (!stopping) {
    const did = await runOne(deps);
    if (once) {
      if (!did) log('worker: заданий нет');
      break;
    }
    if (!did) await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  }
} finally {
  await pool.end();
}
// Браузер съёмки и рендер могли оставить хэндлы — выходим явно.
process.exit(0);
```

В `studio/package.json`, в `scripts` после `render`:

```json
    "worker": "tsx src/worker/worker.ts",
```

- [ ] **Step 3: Админка стенда с ноды**

В `studio/src/capture/login.ts` объявления вебхуков сделать экспортом:

```ts
export const SMS_WEBHOOK = '898c938d-f094-455c-86af-969617e62f7a';
export const CHECK_WEBHOOK = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
```

`studio/scripts/stand-admin.ts`:

```ts
/**
 * Админский API роликов стенда — с ноды, прямо в API на 127.0.0.1:3001 (мимо
 * Nginx и Basic Auth стенда). Вход — админ стенда (ADMIN_PHONE из studio/.env)
 * по debug-OTP с DEBUG_SECRET; токен кешируется в out/.admin-session.json (600).
 *
 *   npx tsx scripts/stand-admin.ts <действие> [ключ=строка | ключ:=json]...
 *   npx tsx scripts/stand-admin.ts list
 *   npx tsx scripts/stand-admin.ts order topic='Как не потерять залог' rubric=assistant angle=uncomfortable assistantId:=10
 *   npx tsx scripts/stand-admin.ts update_settings settings:='{"tgChannelChatId":"-1003290853538"}'
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_WEBHOOK, SMS_WEBHOOK } from '../src/capture/login';

const API = (process.env.ADMIN_API_URL?.trim() || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const CACHE = path.resolve('out', '.admin-session.json');

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`stand-admin: не задана переменная ${name} в studio/.env`);
  return v;
}

async function login(phone: string, secret: string): Promise<string> {
  const sms = await fetch(`${API}/webhook/${SMS_WEBHOOK}/sms/${phone}`);
  if (!sms.ok) throw new Error(`stand-admin: запрос SMS — ${sms.status}`);
  let code = '';
  for (let i = 0; i < 10 && !code; i++) {
    const r = await fetch(`${API}/webhook/debug/sms-code/${phone}`, { headers: { 'X-Debug-Secret': secret } });
    if (r.status === 404) throw new Error('stand-admin: debug-ручка ответила 404 — неверный DEBUG_SECRET');
    if (r.ok) code = String(((await r.json()) as { code?: string }).code ?? '');
    if (!code) await new Promise((res) => setTimeout(res, 1000));
  }
  if (!code) throw new Error('stand-admin: код не появился за 10 секунд');
  const check = await fetch(`${API}/webhook/${CHECK_WEBHOOK}/check-code/${phone}/${code}`);
  if (!check.ok) throw new Error(`stand-admin: check-code — ${check.status}`);
  const token = ((await check.json()) as Record<string, string>)['access-token'];
  if (!token) throw new Error('stand-admin: в ответе check-code нет токена');
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ phone, token }), { mode: 0o600 });
  return token;
}

function parseArgs(args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const a of args) {
    const json = a.indexOf(':=');
    const eq = a.indexOf('=');
    if (json > 0 && json + 1 === eq) body[a.slice(0, json)] = JSON.parse(a.slice(json + 2));
    else if (eq > 0) body[a.slice(0, eq)] = a.slice(eq + 1);
    else throw new Error(`stand-admin: аргумент «${a}» — ключ=строка или ключ:=json`);
  }
  return body;
}

const [action, ...rest] = process.argv.slice(2);
if (!action) {
  console.error('usage: npx tsx scripts/stand-admin.ts <действие> [ключ=строка | ключ:=json]...');
  process.exit(2);
}
const phone = need('ADMIN_PHONE');
const secret = need('DEBUG_SECRET');
const body = JSON.stringify({ action, ...parseArgs(rest) });
const cached = fs.existsSync(CACHE) ? (JSON.parse(fs.readFileSync(CACHE, 'utf8')) as { phone?: string; token?: string }) : {};
let token = cached.phone === phone && cached.token ? cached.token : await login(phone, secret);
const call = (t: string) =>
  fetch(`${API}/webhook/admin/shorts`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body });
let res = await call(token);
if (res.status === 401) {
  token = await login(phone, secret);
  res = await call(token);
}
const text = await res.text();
let out = text;
try {
  out = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  // не JSON — печатаем как есть
}
console.log(`HTTP ${res.status}\n${out}`);
if (!res.ok) process.exit(1);
```

`parseArgs` читает значение как JSON, только если первое `=` в аргументе — часть `:=`. Строка с двоеточием (`topic=Совет: договор`) или с `:=` дальше по тексту остаётся строкой.

В конец `studio/.env.example`:

```bash
# ── Админка стенда с ноды (scripts/stand-admin.ts) ──
# Номер админа стенда (тестовый аккаунт из CLAUDE.md); в репозиторий не класть.
ADMIN_PHONE=
# По умолчанию — API стенда на этой же ноде, мимо Nginx.
ADMIN_API_URL=http://127.0.0.1:3001
```

- [ ] **Step 4: README**

В `studio/README.md` после раздела «Как устроен ролик» добавить:

````markdown
## Конвейер (план 2)

Ролики заказывает и ведёт API (`src/shorts/`): режиссёр пишет сцену, сценарист —
сценарий, бот присылает готовый ролик владельцу. Студия — рабочий процесс,
который забирает из `short_video` задания `capture` и `render`:

```bash
studio/scripts/node-run.sh "npm run worker -- --once"   # одно задание и выход
# Цикл (npm run worker) — не через node-run: он держал бы лок воркдерева 30 минут.
# Цикл живёт под PM2 (план 3).
```

- Захват — `FOR UPDATE SKIP LOCKED` с арендой 30 минут: задание упавшего
  процесса вернётся в очередь само.
- Сбой — с кодом (`src/errors.ts`): повтор до трёх попыток с паузой 2 минуты;
  озвучка вне 30–60 с — сценарий назад сценаристу; остальное — `failed`, и API
  пишет владельцу.
- Файлы — в MinIO, бакет `MINIO_BUCKET_VIDEOS`:
  `shorts/<id>/capture-<попытка>/{question,answer}.png`, `shorts/<id>/{video.mp4,cover.jpg}`.
- Рабочие папки — `out/jobs/<id>/`, старше недели удаляются при старте.

Окружение рабочего процесса — `DATABASE_URL` и `MINIO_*` той же среды, что API
(см. `.env.example`). На стенде ролик запускается из админского API:

```bash
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts order topic='…' rubric=assistant assistantId:=10"
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts start_now id=<uuid>"
```
````

- [ ] **Step 5: Типы и тесты зелёные, процесс запускается**

Run: `studio/scripts/node-run.sh "npx tsc --noEmit && npm test && npx tsc --noEmit --module ES2022 --moduleResolution bundler --target ES2022 --strict --skipLibCheck --types node scripts/stand-admin.ts"`
Expected: без вывода ошибок; `# fail 0`. `tsconfig.json` студии включает только `src/`, поэтому скрипт проверяется отдельной командой.

Run: `studio/scripts/node-run.sh "DOTENV_CONFIG_PATH=/dev/null DEMO_PHONE=79030000001 DEBUG_SECRET=x YANDEX_SPEECHKIT_API_KEY=x YANDEX_TTS_FOLDER_ID=x npm run worker -- --once || echo EXIT=\$?"`
Expected: падение с `studio: не задана переменная DATABASE_URL` и `EXIT=1` — без базы процесс не стартует молча. `DOTENV_CONFIG_PATH=/dev/null` не даёт `dotenv` подставить базу из `studio/.env`: иначе проверка забрала бы настоящее задание стенда.

- [ ] **Step 6: Коммит**

```bash
git -C "$WT" add studio/src/worker/worker.ts studio/scripts/stand-admin.ts studio/src/capture/login.ts studio/package.json studio/.env.example studio/README.md
git -C "$WT" commit -m "feat(studio): рабочий процесс заданий, админка стенда с ноды, README конвейера

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Контрольная точка: стенд

Задачи 35–38 — не код, а проверка конвейера целиком. Задача 36 меняет общее (`main`, стенд) и выполняется **только после явного «да» владельца**. В задаче 37 участвует сам владелец: кнопки в Telegram нажимает он.

### Task 35: Полный прогон перед слиянием

**Files:** нет изменений.

- [ ] **Step 1: Бэкенд — затронутые каталоги, живой Postgres, гейт типов**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "rm -f /tmp/promo-jest.log; npx jest src/shorts src/tg-bot src/blog > /tmp/promo-jest.log 2>&1 || true; grep -q '^Tests: ' /tmp/promo-jest.log || { tail -30 /tmp/promo-jest.log; echo JEST_DID_NOT_RUN; exit 1; }; grep -oE '^FAIL [^ ]+' /tmp/promo-jest.log | sort -u > /tmp/promo-fail-now.txt; comm -13 ~/ci/promo-shorts-jest-fail-base.txt /tmp/promo-fail-now.txt > /tmp/promo-fail-new.txt; cat /tmp/promo-fail-new.txt; test ! -s /tmp/promo-fail-new.txt && echo NO_NEW_FAILS && SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`
Expected: `NO_NEW_FAILS`; интеграционный — `6 passed`; `TSC_OK`.

- [ ] **Step 2: Сборка API не изменила раскладку `dist/`**

Run: `NODE_RUN_DIR=. studio/scripts/node-run.sh "rm -rf dist && npm run build >/dev/null && test -f dist/main.js && test ! -e dist/studio && test ! -e dist/src && echo BUILD_OK"`
Expected: `BUILD_OK`. `dist/main.js` на месте, студии в сборке нет. Если появился `dist/src/` — `studio/` снова попала в `tsconfig.build.json`, и прод не стартует.

- [ ] **Step 3: Студия — с нуля по lock-файлу, все прогоны**

Run: `studio/scripts/node-run.sh "npm ci --no-audit --no-fund && npx tsc --noEmit && npm test && STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db && npm run test:render"`
Expected: `tsc` без вывода; `# fail 0` во всех трёх прогонах; сквозной рендер фикстуры проходит.

- [ ] **Step 4: Финальное ревью ветки**

По правилам subagent-driven-development: ревьюер смотрит весь дифф `feat/promo-shorts` от `9d7c7a3` против спеки и этого плана. Замечания чинятся до задачи 36. Ревьюеру — без `git checkout` в общем воркдереве.

---

### Task 36: Слияние в main и выкат API на стенд — только с OK владельца

После слияния модуль роликов окажется в `main`. Этот выкат прод не трогает (`TEST_ONLY=1`). Но следующий обычный выкат — чей угодно — привезёт модуль на прод. Там он инертен: таблицы создадутся при старте, без `SHORTS_ENABLED` крон ничего не делает, команды `/short` бот не знает, кнопок `short:` без роликов не бывает. Студия на прод не выкатывается вовсе (план 3).

**Files:** нет изменений в репозитории; на стенде — `~/spirits_back/.env`.

- [ ] **Step 1: Спросить владельца**

Одним сообщением:
- влить `feat/promo-shorts` в `main`;
- выкатить API на стенд: `TEST_ONLY=1 BACK_ONLY=1`, прод не трогается;
- дописать в `.env` стенда `SHORTS_ENABLED=true`, `SHORTS_AUTO_TOPICS=false`, `SHORTS_STAND=true`, `SHORTS_LINK_BASE=https://test.linkeon.io`;
- рассказать про инертность на проде (абзац выше).

Без явного «да» дальше не идти.

- [ ] **Step 2: Слияние в чистом клоне**

Ниже `SCRATCH` — каталог временных файлов сессии.

```bash
git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git "$SCRATCH/shorts-merge"
git -C "$SCRATCH/shorts-merge" fetch -q origin feat/promo-shorts
git -C "$SCRATCH/shorts-merge" switch -q -c merge/promo-shorts-2
git -C "$SCRATCH/shorts-merge" merge --no-ff origin/feat/promo-shorts \
  -m "Merge feat/promo-shorts: студия и конвейер коротких роликов (планы 1–2)" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Конфликт — остановиться и разобрать вручную. Вероятные места: `package.json` (блок `jest`), `tsconfig.build.json`, `src/app.module.ts`, `src/tg-bot/*`. Правки параллельных сессий в них не терять.

- [ ] **Step 3: Прогон итога слияния на ноде**

`node-run.sh` клона пушит ветку `merge/promo-shorts-2` (не `main`) и гоняет её точный коммит:

Run: `NODE_RUN_DIR=. "$SCRATCH/shorts-merge/studio/scripts/node-run.sh" "npm ci --no-audit --no-fund >/dev/null; rm -f /tmp/promo-jest.log; npx jest src/shorts src/tg-bot src/blog > /tmp/promo-jest.log 2>&1 || true; grep -q '^Tests: ' /tmp/promo-jest.log || { tail -30 /tmp/promo-jest.log; echo JEST_DID_NOT_RUN; exit 1; }; grep -oE '^FAIL [^ ]+' /tmp/promo-jest.log | sort -u > /tmp/promo-fail-now.txt; comm -13 ~/ci/promo-shorts-jest-fail-base.txt /tmp/promo-fail-now.txt > /tmp/promo-fail-new.txt; cat /tmp/promo-fail-new.txt; test ! -s /tmp/promo-fail-new.txt && npx tsc --noEmit -p tsconfig.build.json && rm -rf dist && npm run build >/dev/null && test -f dist/main.js && echo MERGE_OK"`
Expected: `MERGE_OK`. Если `main` за это время принёс свои красные сюиты, их видно в выводе списком — разобрать, чьи они, прежде чем вливать.

- [ ] **Step 4: В main — только перемоткой, затем убрать временную ветку**

```bash
git -C "$SCRATCH/shorts-merge" fetch -q origin main
git -C "$SCRATCH/shorts-merge" merge-base --is-ancestor origin/main HEAD && echo FF_OK
SHA="$(git -C "$SCRATCH/shorts-merge" rev-parse HEAD)"
git -C "$SCRATCH/shorts-merge" push origin "${SHA}:refs/heads/main"
git -C "$SCRATCH/shorts-merge" push -q origin --delete merge/promo-shorts-2
```

Если `FF_OK` не напечатался, `main` ушёл вперёд. Тогда `git -C "$SCRATCH/shorts-merge" merge origin/main`, затем снова шаги 3–4.

- [ ] **Step 5: Переменные роликов на стенде**

Копия `.env` кладётся вне каталога приложения. Строки дописываются, только если их ещё нет. Значения секретов не печатаются.

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'set -e; cp ~/spirits_back/.env ~/env-spirits_back.bak-$(date +%Y%m%d%H%M); if ! grep -q "^SHORTS_ENABLED=" ~/spirits_back/.env; then printf "\nSHORTS_ENABLED=true\nSHORTS_AUTO_TOPICS=false\nSHORTS_STAND=true\nSHORTS_LINK_BASE=https://test.linkeon.io\n" >> ~/spirits_back/.env; fi; grep -E "^SHORTS_" ~/spirits_back/.env'
```

Expected: четыре строки `SHORTS_…`. API прочтёт их при рестарте, который сделает `deploy.sh`.

- [ ] **Step 6: Выкат на стенд — отвязанно, из чистого клона, без `tail`**

Рецепт «выкат со свежих клонов»: файл с кредами стенда и `node_modules` тестов — из общего чекаута.

```bash
git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git "$SCRATCH/deploy/spirits_back"
install -m 600 ~/Downloads/spirits_back/scripts/test-server.env.local "$SCRATCH/deploy/spirits_back/scripts/"
ln -s ~/Downloads/spirits_back/tests/node_modules "$SCRATCH/deploy/spirits_back/tests/node_modules"
( cd "$SCRATCH/deploy/spirits_back" && TEST_ONLY=1 BACK_ONLY=1 nohup bash scripts/deploy.sh > "$SCRATCH/deploy-shorts.log" 2>&1 < /dev/null & )
```

Следить за логом `$SCRATCH/deploy-shorts.log` Monitor-ом, не убивать процесс. Ждать итоговой строки PHASE 1. Если smoke красный, разобрать причину по логу и показать владельцу. Сеть, DNS и браузерный слой стенда уже краснели не из-за кода. Сам откат при красной фазе test скрипт не делает.

- [ ] **Step 7: Убедиться, что приехал наш код и таблицы созданы**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'git -C ~/spirits_back log -1 --format=%H; grep -c "shorts migration 001_shorts.sql applied" ~/.pm2/logs/linkeon-api-out*.log | tail -1; set -a; . ~/spirits_back/.env >/dev/null 2>&1; set +a; psql "$DATABASE_URL" -Atc "SELECT to_regclass('"'"'public.short_video'"'"'), (SELECT count(*) FROM short_settings)"'
```

Expected:
- первая строка — `SHA` из шага 4;
- счётчик применённой миграции больше нуля;
- `short_video|1`.

Хеш сверять с отправленным, а не «последним в main»: туда могли успеть чужие коммиты.

---

### Task 37: Сквозной прогон на стенде — вместе с владельцем

Ролик проходит весь путь:
- заказ → режиссёр → съёмка → сценарист → сборка;
- видео владельцу → замечание → новый вариант → одобрение;
- канал @linkeontest → набор для YouTube → ссылка.

Затем учения: сбой съёмки должен прийти владельцу сообщением, а не тишиной.

Команды админки — через `scripts/stand-admin.ts` с ноды, ответы печатаются JSON. Состояние ролика смотреть так: `studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts get id=<id>"` (поле `status`, при сбое — `lastError`).

**Files:** на ноде — `~/ci/wt/promo-shorts/studio/.env`.

- [ ] **Step 1: Окружение рабочего процесса и админки на ноде**

База и MinIO — того же стенда, что API. Номер админа стенда — из таблицы «Тестовые аккаунты» в `CLAUDE.md` (роль Admin). Ниже он подставлен как `<номер-админа>`. В репозиторий номер не попадает.

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'set -e; f=~/ci/wt/promo-shorts/studio/.env; grep -q "^DATABASE_URL=" $f || grep -E "^(DATABASE_URL|MINIO_ENDPOINT|MINIO_ACCESS_KEY|MINIO_SECRET_KEY|MINIO_BUCKET_VIDEOS)=" ~/spirits_back/.env >> $f; grep -q "^ADMIN_PHONE=" $f || echo "ADMIN_PHONE=<номер-админа>" >> $f; chmod 600 $f; grep -oE "^[A-Z_]+=" $f | sort | tr "\n" " "'
```

Expected — только имена переменных: `ADMIN_PHONE= API_URL= CABINET_BASIC_AUTH= CABINET_URL= DATABASE_URL= DEBUG_SECRET= DEMO_PHONE= MINIO_ACCESS_KEY= MINIO_BUCKET_VIDEOS= MINIO_ENDPOINT= MINIO_SECRET_KEY= YANDEX_SPEECHKIT_API_KEY= YANDEX_TTS_FOLDER_ID=`.

- [ ] **Step 2: Канал стенда и баланс демо-аккаунта**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'set -a; . ~/spirits_back/.env >/dev/null 2>&1; set +a; psql "$DATABASE_URL" -Atc "SELECT channel_chat_id FROM blog_settings WHERE id = 1"; psql "$DATABASE_URL" -Atc "SELECT tokens FROM ai_profiles_consolidated WHERE user_id = '"'"'79030000001'"'"'"'
```

Expected:
- `-1003290853538` — блог стенда публикует в @linkeontest, значит тестовый бот там админ;
- баланс демо-аккаунта — не меньше 10 000 токенов.

Если баланса меньше, попросить владельца пополнить его из админки стенда и подождать. Каждая съёмка — настоящий ход ассистента, около 2 000 токенов.

Run: `studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts update_settings settings:='{\"tgChannelChatId\":\"-1003290853538\"}'"`
Expected: `HTTP 200`, в ответе `"tgChannelChatId": "-1003290853538"`, `"platforms": ["telegram", "youtube"]`.

- [ ] **Step 3: Заказ и запуск**

Run: `studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts order topic='Можно ли не вернуть залог за съёмную квартиру' rubric=assistant angle=uncomfortable assistantId:=10"`
Expected: `HTTP 200`, `"status": "idea"`, `"angleLocked": true`. Запомнить `id`.

Run: `studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts start_now id=<id>"`
Expected: `HTTP 200`, `"status": "directing"`, `slotAt` — ближайший свободный вт/чт/сб 18:00 МСК.

- [ ] **Step 4: Режиссёр (API, тик раз в минуту)**

Раз в минуту, не дольше 10 минут, смотреть `get id=<id>`.

Expected: `"status": "capture_queued"`, в `scene` — вопрос к Алексею (id 10) не длиннее 450 знаков и 1–2 уточнения, `slug` вида `…_xxxx`.

Сорвалось — в `lastError` причина с префиксом «режиссёр:». Повторы идут сами через 1 и 10 минут.

- [ ] **Step 5: Съёмка**

Run: `studio/scripts/node-run.sh "npm run worker -- --once"`
Expected: в логе `capture <id>: попытка 1`, через 1–5 минут — `capture <id>: готово`. `get` показывает `"status": "writing"` и `capture.paragraphs` с полным текстом абзацев.

Если `answer_rejected` или `question_hidden`, ролик вернётся в очередь с паузой 2 минуты. Через 2 минуты повторить команду.

- [ ] **Step 6: Сценарист (API)**

Раз в минуту, не дольше 10 минут, — `get id=<id>`.

Expected:
- `"status": "render_queued"`;
- в `script` — зацепка до 8 слов, `hookBox`, 2–4 реплики с `box`, финал «Линкеон — … ассистентов…», `final.disclaimer` «Ответ ИИ, не заменяет юриста»;
- в `captions.telegram` — ссылка `https://test.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_<slug>`.

- [ ] **Step 7: Сборка**

Run: `studio/scripts/node-run.sh "npm run worker -- --once"`
Expected: `render <id>: готово` за 2–5 минут. `get` показывает `"status": "pending_review"`, `durationMs` в пределах 30 000–60 000 и `videoUrl`.

Если `too_long` или `line_too_short`, сценарий ушёл обратно сценаристу (`writing`, `writerFeedback`). Тогда снова шаги 6–7.

- [ ] **Step 8: Видео владельцу, замечание, новый вариант**

Не позже чем через минуту тестовый бот присылает владельцу ролик с пометкой «[СТЕНД]» и четырьмя кнопками. Попросить владельца:
1. посмотреть ролик;
2. нажать «✍️ Замечание» и ответить на приглашение текстом, например: «Зацепку сделай утверждением из ответа, без вопроса».

Expected: бот отвечает «Принял замечание — поправлю ролик и пришлю заново.», `get` — `"status": "writing"`, в `ownerNote` текст замечания.

Дальше — шаг 6, затем шаг 7. Владельцу приходит новый вариант.

- [ ] **Step 9: Одобрение и публикация сейчас**

Попросить владельца нажать «✅ Одобрить».
Expected: всплывашка и сообщение «Одобрено. Опубликую …», `get` — `"status": "approved"`, `approvedAt` заполнен.

Run: `studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts publish_now id=<id>"`
Expected: `HTTP 200`. Не позже чем через 5 минут:
- в @linkeontest — видео с обложкой, подписью, ссылкой с метками и строкой «Озвучено синтезированным голосом.»;
- владельцу — файл «Набор для YouTube Shorts» и сообщение с заголовком, описанием, тегами и кнопкой «▶️ Выложил на YouTube»;
- `get`: `"status": "published"`, у `telegram` — `published` и `url` вида `https://t.me/…`, у `youtube` — `manual_pending`.

- [ ] **Step 10: Ссылка YouTube**

Попросить владельца нажать «▶️ Выложил на YouTube» и ответить на приглашение ссылкой на любой ролик Shorts. Для проверки годится чужой публичный, выкладывать наш на стенде не нужно.
Expected: бот отвечает «Записал ссылку YouTube: https://youtube.com/shorts/…», `get` — у `youtube` статус `manual_done` и `url`.

- [ ] **Step 11: Учения — сбой должен дойти до владельца**

Спека просит учения с нарочно сломанным релеем. Для этого пришлось бы править `.env` стенда и перезапускать API, поэтому релей здесь заменён сбоем съёмки. Путь «релей молчит → повтор через 1 и 10 минут → failed → сообщение» покрыт тестами задач 12, 20 и 23.

Заставить съёмку браковать любой ответ, провести ролик до `failed` и вернуть порог:

```bash
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts update_settings settings:='{\"minAnswerChars\":5000}'"
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts order topic='Как вернуть деньги за бракованный товар' rubric=assistant assistantId:=10"
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts start_now id=<id2>"
```

Дождаться `capture_queued` (шаг 4). Затем три раза — `studio/scripts/node-run.sh "npm run worker -- --once"` с паузой не меньше 2 минут между запусками: так выдерживается пауза повтора.
Expected:
- в логе дважды `answer_rejected … → retry`, затем `→ failed`;
- `get id=<id2>` — `"status": "failed"`, `"failedFrom": "capturing"`;
- не позже чем через минуту владельцу приходит «[СТЕНД] Ролик «…» не собрался: съёмка: capture: ответ не годится — ответ N символов — меньше порога 5000».

Вернуть порог и повторить ролик — так проверяется «Повторить»:

```bash
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts update_settings settings:='{\"minAnswerChars\":400}'"
studio/scripts/node-run.sh "npx tsx scripts/stand-admin.ts retry id=<id2>"
studio/scripts/node-run.sh "npm run worker -- --once"
```

Expected: `retry` отвечает `"status": "capture_queued"`; съёмка проходит; ролик доходит до `writing`. Дальше он идёт обычным путём. Когда он придёт владельцу, попросить нажать «🗑 Отклонить».

- [ ] **Step 12: Итог прогона — владельцу**

Коротко:
- что прошло на каждом шаге;
- ссылка на пост в @linkeontest;
- сколько длился путь от заказа до видео в личке;
- что сорвалось и как починено.

Найденные дефекты — отдельными коммитами в `feat/promo-shorts`, с тестом на каждый. Если исправление касается уже влитого кода — повторить задачу 36 с новым OK.

---

### Task 38: Итоги плана

**Files:**
- Modify: `docs/superpowers/specs/2026-10-24-promo-shorts-design.md`, этот план (галочки)

- [ ] **Step 1: Спека — что уточнил план 2**

В спеку после раздела «Порядок работ» добавить раздел «Что уточнил план 2 (25.10.2026)». В нём — список из шапки этого плана («Что план уточняет в спеке») и строка «Проверено на стенде <дата>: заказ → … → ссылка YouTube; учения со сбоем съёмки — сообщение пришло».

- [ ] **Step 2: Галочки и коммит**

Отметить выполненные шаги плана. Затем:

```bash
git -C "$WT" add docs/superpowers/specs/2026-10-24-promo-shorts-design.md docs/superpowers/plans/2026-10-25-promo-shorts-2-pipeline.md
git -C "$WT" commit -m "docs: план 2 выполнен — конвейер роликов проверен на стенде

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -q origin feat/promo-shorts
```

- [ ] **Step 3: Память и следующий шаг**

Обновить заметку `project_promo_shorts_studio.md` в памяти:
- план 2 выполнен, конвейер в `main`;
- переменные стенда;
- как гонять рабочий процесс и `stand-admin.ts`;
- грабли, найденные в задаче 37.

Предложить владельцу план 3: админка, метки блога, сцены `page`, выкат студии на прод.
