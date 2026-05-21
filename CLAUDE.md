# My.Linkeon (b.linkeon.io)

## Обзор
Платформа для поиска единомышленников. NestJS бэкенд + React фронтенд.

## Окружение (единая среда)

- **URL:** https://my.linkeon.io
- **Сервер:** `ssh dvolkov@212.113.106.202` (порт 22)
- **БД:** PostgreSQL local (`linkeon`, порт 5433)
- **Neo4j:** Docker local (`bolt://localhost:7687`)
- **PM2:** `linkeon-api` (port 3001)
- **Статика фронта:** `/home/dvolkov/spirits_front/`
- Staging (`b.linkeon.io`) упразднён — всё гоняется на prod. Для безопасного тестирования использовать test-аккаунты ниже и `DEBUG_SMS_CODES=true`.

## Репозитории

| Компонент | GitHub | Локальный путь |
|-----------|--------|----------------|
| Бэкенд (NestJS) | git@github.com:dvvolkovv/spirits_back.git | `~/Downloads/spirits_back/` |
| Фронтенд (React) | git@github.com:dvvolkovv/spirits.git | `~/Downloads/spirits_front/` |

## Стек
- **Backend:** NestJS 10, TypeScript, PostgreSQL 16, Redis, Neo4j (Docker), PM2
- **Frontend:** React 18, TypeScript, Vite 5, Tailwind CSS, pnpm
- **Auth:** JWT HS256 (access 2h, refresh 30d), SMS OTP через SMS Aero
- **AI:** OpenRouter (GPT-4o-mini), Anthropic SDK (fallback)
- **Payments:** YooKassa
- **Storage:** Локальные файлы (avatars, images) через Nginx /static/

## Деплой (двухфазный: test → prod)

**Только через `scripts/deploy.sh`.** Деплой идёт **из git** — никаких rsync с локалки. Пайплайн:

1. **PHASE 1 — test.linkeon.io** (`dv@85.192.61.231`). `git pull` → build → `pm2 restart` → smoke (`BASE_URL=https://test.linkeon.io`, `BASIC_AUTH=<линкеон>:<пароль>` из gitignored `scripts/test-server.env.local`).
2. **PHASE 2 — my.linkeon.io** (`dvolkov@212.113.106.202`). То же на проде. **Запускается ТОЛЬКО если PHASE 1 smoke зелёный.** Если test красный — deploy.sh выходит с кодом 1 ДО касания прода.

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Раскладка путей одинакова в обеих средах (с заменой `dvolkov` ↔ `dv`):
- `~/spirits_back/` — git-клон `dvvolkovv/spirits_back`, ветка `b2b`
- `~/spirits_front_src/` — git-клон `dvvolkovv/spirits` (build делается тут)
- `~/spirits_front/` — nginx-served `dist/`

Полезные флаги: `TEST_ONLY=1`, `PROD_ONLY=1` (hotfix), `FRONT_ONLY=1`, `BACK_ONLY=1`, `SKIP_SMOKE=1`, `SKIP_TEST_SMOKE=1`, `SKIP_PROD_SMOKE=1`, `SMOKE_ONLY=1`. Полный список — в шапке `scripts/deploy.sh`.

### Тестовый сервер

`test.linkeon.io` (`dv@85.192.61.231`, Ubuntu 24.04). Полный зеркальный стек: PostgreSQL/Redis/Neo4j/MinIO. SMS Aero и YooKassa отключены через пустые env. `DEBUG_SMS_CODES=true`. Доступ закрыт Basic Auth на уровне Nginx.

**Bootstrap (один раз):** `bash scripts/provision-test.sh`. Скрипт идемпотентный, можно перезапускать. Креды генерятся и складываются в `scripts/test-server.env.local` (gitignored).

**Почему git, а не rsync**: `rsync --delete` много раз сносил `.env`, `public/agent-avatars/` и `worker/.env` потому что они gitignored / отсутствовали локально. Каждое такое падение приводило к выпадению SMSAERO / OPENAI / ANTHROPIC / MCP_SECRET / NEO4J_* / KLING / PEXELS. Git-pull трогает **только tracked-файлы** — `.env` и `public/` на проде живут постоянно, никем не задеваются.

**Prerequisites на проде** (one-time setup):
- Pubkey `~/.ssh/id_rsa.pub` добавлен как Deploy Key в обоих GitHub-репах (read-only access)
- Обе репы клонированы (`/home/dvolkov/spirits_back`, `/home/dvolkov/spirits_front_src`)
- `pnpm` установлен в `~/.npm-global/` (PATH прописан в `~/.bashrc`)
- В `.env` на проде лежат секреты (см. бэкап `/home/dvolkov/backups/linkeon/`)

### Ручные команды (если что-то сломалось)

**Бэк** (через ssh):
```bash
ssh dvolkov@212.113.106.202 "cd /home/dvolkov/spirits_back && git fetch origin && git reset --hard origin/b2b && npm ci && npm run build && pm2 restart linkeon-api"
```

**Фронт**:
```bash
ssh dvolkov@212.113.106.202 "
  export PATH=\$HOME/.npm-global/bin:\$PATH
  cd /home/dvolkov/spirits_front_src && git fetch origin && git reset --hard origin/b2b
  echo 'VITE_BACKEND_URL=https://my.linkeon.io' > .env
  pnpm install --frozen-lockfile && pnpm build
  rsync -az --delete dist/ /home/dvolkov/spirits_front/
"
```
После ручного деплоя **ОБЯЗАТЕЛЬНО** прогнать smoke: `bash ~/Downloads/spirits_back/tests/smoke/run.sh`.

## 💾 Бэкапы

Скрипт: `/home/dvolkov/backups/linkeon/backup.sh` на проде. Cron daily 03:00 UTC. Ретеншн 30 дней. Каждый снапшот → `/home/dvolkov/backups/linkeon/YYYYMMDD-HHMMSS/`:

| Файл | Что |
|------|-----|
| `spirits_back.env` | основной `.env` бэкенда (часто пропадал — главная причина существования этого backup'а) |
| `spirits_back-worker.env` | `.env` SMM-воркера |
| `linkeon.sql.gz` | `pg_dump` базы `linkeon` (chat history, profiles, payments, tokens, agents) |
| `neo4j.dump.gz` | offline `neo4j-admin database dump` (Profile + Value/Belief/Desire/Intent/Interest/Skill nodes + relationships). Делается через краткую остановку контейнера (~20с). |
| `agent-avatars.tar.gz` | PNG/JPG из `public/agent-avatars/` |

**Лог**: `/home/dvolkov/backups/linkeon/backup.log` (append).

**Ручной запуск**:
```bash
ssh dvolkov@212.113.106.202 "/home/dvolkov/backups/linkeon/backup.sh"
```

**Локальная копия на Mac** (отдельная машина — на случай если прод-сервер потеряется):
```bash
LATEST=$(ssh dvolkov@212.113.106.202 'ls -t /home/dvolkov/backups/linkeon/2*/ -d | head -1')
rsync -az "dvolkov@212.113.106.202:$LATEST" ~/Downloads/spirits_backups/$(date -u +%Y%m%d-%H%M%S)/
```

### Восстановление

**`.env`** — `scp` файла обратно на сервер, `pm2 restart linkeon-api`.

**PostgreSQL `linkeon`**:
```bash
scp linkeon.sql.gz dvolkov@212.113.106.202:/tmp/
ssh dvolkov@212.113.106.202 "gunzip -c /tmp/linkeon.sql.gz | PGPASSWORD=linkeon_pass_2026 psql -h localhost -p 5433 -U linkeon -d linkeon"
```
Дамп с `--clean --if-exists` — DROP'ит существующие таблицы перед INSERT'ом, так что чистая накатка поверх работает.

**Neo4j**:
```bash
scp neo4j.dump.gz dvolkov@212.113.106.202:/tmp/
ssh dvolkov@212.113.106.202 "
  gunzip /tmp/neo4j.dump.gz
  docker cp /tmp/neo4j.dump neo4j:/tmp/neo4j.dump
  docker stop neo4j
  docker run --rm --volumes-from neo4j neo4j:5 neo4j-admin database load neo4j --from-path=/tmp --overwrite-destination=true
  docker start neo4j
"
```

**Avatars**:
```bash
scp agent-avatars.tar.gz dvolkov@212.113.106.202:/tmp/
ssh dvolkov@212.113.106.202 "tar xzf /tmp/agent-avatars.tar.gz -C /home/dvolkov/spirits_back/public/"
```

## Тестовые аккаунты
| | Телефон | Роль |
|--|---------|------|
| Admin | `79030169187` | isadmin=true, реферальный лидер (test-leader) |
| Test | `70000000000` | тестовый пользователь |

DEBUG_SMS_CODES=true — код можно получить через `GET /webhook/debug/sms-code/:phone`

## 🧪 ОБЯЗАТЕЛЬНЫЕ ТЕСТЫ

### Smoke-пайплайн (после **каждого** деплоя)

Три слоя × ~1.5 мин, 24 проверки. Запускается автоматически через `scripts/deploy.sh` (шаг 6), либо отдельно:

```bash
bash ~/Downloads/spirits_back/tests/smoke/run.sh         # все три слоя
bash ~/Downloads/spirits_back/tests/smoke/run.sh unit    # 12 unit-тестов (Jest)
bash ~/Downloads/spirits_back/tests/smoke/run.sh api     # 9 API+DB (Node)
bash ~/Downloads/spirits_back/tests/smoke/run.sh browser # 3 Playwright
```

**Слой 1 — Jest unit** ([tests/unit/extractJsonObject.test.js](tests/unit/extractJsonObject.test.js))
Пинит толерантный JSON-парсер для `Neo4jService.consolidateFromChat` — 12 кейсов: markdown-fences, прозa до/после, вложенные `{}`, эскейпы, регрессия на «position 105».

**Слой 2 — API + DB smoke** ([tests/smoke/smoke.js](tests/smoke/smoke.js))
9 критических путей против `https://my.linkeon.io`:
1. `/webhook/agents` отдаёт 14 ассистентов, Райя на месте
2. SMS-send + debug-OTP + check-code → JWT (доказывает что `DEBUG_SMS_CODES=true`)
3. `/webhook/profile` и `/webhook/user/tokens/` с JWT
4. `/webhook/soulmate/chat` стримит ответ (покрывает `streamUniversalAgent` → r.linkeon.io)
5. `custom_chat_history` получил свежие строки (покрывает `saveChatHistory` в `setImmediate`) — DB-чек через SSH+psql
6. Аватар Райи отдаётся (image/jpeg)

**Слой 3 — Playwright** ([tests/playwright/smoke.spec.js](tests/playwright/smoke.spec.js))
3 сценария в headless Chromium:
1. Логин через debug-OTP → `/chat` → сайдбар с ассистентами рендерится
2. Chat-interface работает с pre-selected ассистентом
3. **Per-tab independence** (регрессия на cross-tab leak): два browser-context'а держат разные `sessionStorage.selected_assistant` без перетеканий

### Глубокое покрытие (запускается выборочно при больших изменениях)

#### API-suite (32 теста)
Все эндпоинты: auth, profile, agents, chat, tokens, payments, referral, admin, search, compatibility, imagegen.
```bash
cd ~/Downloads/spirits_back/tests && node runner.js --suite api
```

#### E2E с авторизацией (18 тестов)
SMS OTP → JWT → профиль → агенты → стриминг → история → смена агента → email → аватар → реферал.
```bash
cd ~/Downloads/spirits_back/tests && node runner.js --suite e2e
```

#### Реферальная система E2E (20 сценариев, на сервере)
```bash
scp ~/Downloads/spirits_back/tests/referral.e2e.sh dvolkov@212.113.106.202:/tmp/
ssh dvolkov@212.113.106.202 "bash /tmp/referral.e2e.sh"
```
Покрывает: создание L1/L2 лидеров, slug-регистрацию, повторную регистрацию, деактивацию, комиссии (direct+upstream), множественные оплаты, статистику, admin mark_paid / mark_all_paid / toggle, summary, cleanup.

#### Video / chat-tools E2E
```bash
bash ~/Downloads/spirits_back/tests/video.e2e.sh
bash ~/Downloads/spirits_back/tests/chat-tools.e2e.sh
```

#### Все «глубокие» разом
```bash
cd ~/Downloads/spirits_back/tests && node runner.js  # api (32) + e2e (18) = 50
```

## API Endpoints

### Auth (публичные)
- `GET /webhook/{uuid}/sms/:phone` — запрос SMS кода
- `GET /webhook/{uuid}/check-code/:phone/:code` — проверка кода, возврат JWT
- `POST /webhook/auth/refresh` — обновление JWT
- `GET /webhook/debug/sms-code/:phone` — debug: получить код из Redis

### Profile
- `GET /webhook/profile` — профиль с данными из Neo4j (values, beliefs, desires, intents, interests, skills)
- `POST /webhook/profile-update` — обновление profile_data
- `DELETE /webhook/profile` — удаление аккаунта
- `GET /webhook/user-profile?userId=` — профиль другого пользователя
- `POST /webhook/set-email` — установка email

### Avatar
- `GET /webhook/avatar` — аватар пользователя (binary file)
- `POST /webhook/avatar` — загрузка аватара
- `PUT /webhook/avatar` — загрузка аватара (альтернативный метод)
- `GET /webhook/{uuid}/agent/avatar/:agentId` — аватар агента (redirect)

### Agents
- `GET /webhook/agents` — список агентов (публичный)
- `GET /webhook/agent-details` — агенты с system_prompt (auth)
- `POST /webhook/change-agent` — смена предпочтительного агента
- `POST /webhook/agent` — создание/обновление агента (urlencoded: agent-id, name, system_prompt, description)

### Chat
- `POST /webhook/soulmate/chat` — стриминг чат (NDJSON: begin/item/end). Body: `{chatInput, assistant}` или `{message, assistantId}`
- `GET /webhook/chat/history?assistantId=` — история чата
- `DELETE /webhook/chat/history?assistantId=` — очистка истории

### Tokens & Payments
- `GET /webhook/user/tokens/` — баланс токенов
- `POST /webhook/yookassa/create-payment` — создание платежа YooKassa
- `POST /webhook/yookassa/verify-payment` — проверка статуса платежа
- `POST /webhook/yookassa/notification` — webhook от YooKassa
- `POST /webhook/coupon/redeem` — активация купона

### Search & Compatibility
- `POST /webhook/search-mate` — поиск людей (стриминг NDJSON с search_result: JSON)
- `POST /webhook/analyze-compatibility` — анализ совместимости (стриминг markdown)

### Referral
- `POST /webhook/referral/register` — регистрация по реферальной ссылке `{slug}`
- `GET /webhook/referral/stats` — статистика лидера (commissions, referees, breakdown)

### Admin
- `POST /webhook/admin/coupons` — CRUD купонов `{action: list|create|update|delete}`
- `GET /webhook/admin/referral/stats` — полная статистика рефералов (summary + leaders)
- `POST /webhook/admin/referral` — управление рефералами `{action: create|toggle|mark_paid|mark_all_paid}`

### Misc
- `POST /webhook/imagegen` — генерация изображений (заглушка)
- `POST /webhook/scan-document` — сканирование документа (заглушка)

## Credentials (на сервере ~/spirits_back/.env)
- `DATABASE_URL` — PostgreSQL local
- `REDIS_URL` — Redis local
- `NEO4J_URI` / `NEO4J_PASSWORD` — Neo4j Docker
- `JWT_SECRET` — JWT signing
- `OPENROUTER_API_KEY` — OpenRouter для LLM
- `SMSAERO_LOGIN` / `SMSAERO_API_KEY` — SMS Aero
- `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` — YooKassa
- `DEBUG_SMS_CODES=true` — debug endpoint для SMS кодов

## Важные особенности
- Системный промпт каждого ассистента включает контекст платформы и список всех ассистентов
- Профиль обогащается данными из Neo4j (values, beliefs, desires, intents, interests, skills)
- Chat history хранится в `custom_chat_history` (individual rows: session_id, sender_type, agent, content)
- Token accounting scheduler: `@Cron('*/5 * * * * *')`, enum: pending/processing/completed/failed
- Реферальная система: 2 уровня комиссий, commissions в `referral_commissions`
- Аватарки и изображения раздаются из `/static/` через Nginx (файлы в `~/spirits_back/public/`)

## 📋 Tasks — операционная память пользователя (cross-agent)

Каждый юзер имеет автоматически создаваемые **задачи** — структурированный контекст текущих и прошлых проектов/обязательств. **Все ассистенты видят все задачи** одного юзера и могут продолжать работу с того места, где её бросил другой ассистент.

**Таблицы** (миграция [src/tasks/migrations/001_tasks.sql](src/tasks/migrations/001_tasks.sql) применяется в `TasksService.onModuleInit`):
- `tasks` — id (uuid), user_id, title, summary, claudemd, claudemd_locked, status (`active|archived|done`), last_active_at, embedding (`double precision[]` 256-dim), created_at, updated_at
- `task_events` — id (bigserial), task_id, kind (`user_message|agent_response|note|milestone|decision|status_change`), content, agent_id, created_at

**Структура задачи**:
- `claudemd` — стабильная инструкция/manual задачи (цель, контекст, участники, ограничения). Перезаписывается редко.
- `summary` — текущее «где мы сейчас» (1-3 предложения). Регенерится после каждого значимого события.
- `task_events` — append-only timeline: что произошло, кем, когда.

**Auto-extract** ([TasksService.extractFromTurn](src/tasks/tasks.service.ts)): после каждой пары `human+ai` в chat history (`setImmediate` рядом с `consolidateFromChat`) делается 1 LLM-вызов Haiku 4.5 (~$0.001) который возвращает одно из:
- `none` — реплика бытовая
- `append` — про существующую задачу: добавить event, обновить summary, опционально переписать claudemd (если `claudemd_locked=false`)
- `create` — новая задача: title/summary/claudemd/первый event

**Context injection** ([TasksService.buildContextForPrompt](src/tasks/tasks.service.ts)): перед каждым chat-turn'ом в system_prompt инжектится:
1. **Активные задачи** — топ-5 по cosine между embedding юзер-сообщения и task.embedding (или по recency если OPENAI_API_KEY отсутствует). Только `title + summary`.
2. **Архивные задачи (recall)** — топ-3 archived с cosine ≥ 0.62 к текущему сообщению. Авто-всплытие старых проектов когда юзер «помнишь, мы делали X?».

**Cron** ([scheduler/task-archiver.service.ts](src/scheduler/task-archiver.service.ts)): `0 30 04 * * *` (04:30 UTC) переводит active задачи без событий >60 дней в `archived`. **Задачи никогда не удаляются** — archived доступны через recall и admin drawer.

**Admin endpoints** ([tasks.controller.ts](src/tasks/tasks.controller.ts)):
- `GET /webhook/admin/users/:phone/tasks` — список всех задач юзера (active first, потом archived/done)
- `GET /webhook/admin/tasks/:taskId?limit=N` — полный объект задачи + последние N событий

**Admin UI** ([UserActivityDrawer.tsx](src/components/admin/UserActivityDrawer.tsx)): секция «Задачи» в drawer'е юзера показывает список с статус-pill'ами и `claudemd_locked` бейджем; click на задачу раскрывает inline её `claudemd` + timeline событий.

**Стоимость per turn**: +1 Haiku 4.5 call (~$0.001) + 1 OpenAI embedding (~$0.00002 при text-embedding-3-large dim=256). Не блокирует ответ юзеру (всё в `setImmediate`).

**Что вне scope текущей реализации**:
- User-facing UI для управления задачами (rename / merge / archive вручную)
- LLM-tool `get_task(id)` — пока инжектится только title+summary, полный claudemd видит только админ через drawer
- Follow-up reminders («N дней нет активности по задаче — напомнить?»)
- `claudemd_locked=true` существует в схеме, но UI для блокировки manual-а пока нет — выставлять напрямую через UPDATE


## ➕ Добавление нового ассистента

Каждый ассистент = одна строка в таблице `agents`. UI берёт список из `GET /webhook/agents`, никаких отдельных шагов на фронте делать не нужно.

### Обязательные поля при INSERT в `agents`

| Поле | Зачем |
|------|-------|
| `name` | **Технический идентификатор** (snake_case, уникальный). Используется в `chat.service.ts` для роутинга и в `changeAgentOnServer` на фронте. После создания **не меняется**. |
| `display_name` | Что видит пользователь (`Юлия`, `Михаил`). Если совпадает с `name` — можно не задавать, fallback на `name`. |
| `description` | **Критично** — попадает в системный промпт ВСЕХ остальных ассистентов через блок «Коллеги-ассистенты в Linkeon» ([chat.service.ts:538](src/chat/chat.service.ts#L538)). Без этого описания коллеги не смогут представить нового сотрудника пользователю. Формат: «Юрист — помогает разобраться в правовых вопросах». |
| `system_prompt` | Персональный prompt — характер, методики, ограничения, тон. Используется в `streamUniversalAgent` после блока «Персона и инструкции ассистента». |
| `category` | `business` / `personal` / `assistant` / `smm` — определяет в каком разделе UI группируется (см. `AssistantSelection.tsx`). |

### Дополнительные шаги

1. **Аватарка**: положить квадратный JPEG (рекомендуем 1024×1024, < 500 KB) в `~/spirits_back/public/agent-avatars/<id>.jpg`. Раздаётся через `/webhook/0cdacf32-7bfd-4888-b24f-3a6af3b5f99e/agent/avatar/<id>`. Если меняешь аватарку существующего ассистента — bump `DB_VERSION` в `spirits_front/src/utils/avatarCache.ts` чтобы IndexedDB-кеш у клиентов очистился.

2. **Если у ассистента нестандартный pipeline** (как Юля с in-process MCP tools и Claude Agent SDK через OAuth): добавить ветку в `chat.service.ts` `streamChat()` по `agent.name === '<your_name>'` ДО fallback на `streamUniversalAgent`. Пример: блок `if (agent?.name === 'smm_producer')` на line ~96.

3. **Знание о новом ассистенте у коллег — автоматическое** (из его `description` поля). Никаких ручных правок в существующих system_prompt'ах делать не нужно. Это гарантирует [chat.service.ts:538-557](src/chat/chat.service.ts#L538-L557) — на каждом запросе перечитывается список из БД.

### Smoke-проверка

После добавления:
```bash
curl -s https://my.linkeon.io/webhook/agents | jq '.[] | select(.name == "<your_name>")'
# Должно вернуть запись с display_name + description + category.
```
И через любого другого ассистента в чате спросить «расскажи про <display_name>» — он должен корректно представить новичка.


## 📞 Outbound AI calls — общая инфраструктура с Taler ID

my.linkeon.io может использовать готовую инфраструктуру обзвона из Taler ID. Разворачивать свой SIP/LiveKit/агента НЕ нужно — всё shared.

### Что даёт shared-инфраструктура

- **PSTN-звонки в РФ** через SIPNET (номер caller-ID `74951086247`, проходит через Asterisk-proxy на Selectel)
- **Real-time streaming AI** — Deepgram STT + GPT-4o + ElevenLabs TTS в room LiveKit
- **Запись MP3** — MeetingSummary + upload через ваш backend
- **Listen-in** — клиент может подключиться к live-room как слушатель (canSubscribe только)

Latency end-to-end ~700-1000мс (как у «звонит живой человек»).

### Какие компоненты переиспользуются

| Компонент | Адрес | Описание |
|-----------|-------|----------|
| **LiveKit server** | `http://167.172.181.34:7880` (DO Frankfurt) | REST API + WSS для agent/listener |
| **LiveKit WSS (TLS proxy)** | `wss://id.taler.tirol/livekit-outbound` | для mobile/web клиентов-слушателей |
| **SIP trunk** | `ST_BpnXtg7BirH6` | outbound через Asterisk@Selectel → SIPNET |
| **Python agent** | `agent_name="outbound-call-agent"` | livekit-agents worker, ведёт диалог |
| **Recorder** | `http://167.172.181.34:3100` | `/record` + `/stop-record`, пишет MP3, uploads на ваш backend |

### API ключи (запросить у админа Taler ID)

```env
LIVEKIT_HOST_OUTBOUND=http://167.172.181.34:7880
LIVEKIT_API_KEY_OUTBOUND=<ask admin>
LIVEKIT_API_SECRET_OUTBOUND=<ask admin>
LIVEKIT_WS_URL_OUTBOUND=wss://id.taler.tirol/livekit-outbound
SIP_TRUNK_ID=ST_BpnXtg7BirH6
RECORDER_URL_OUTBOUND=http://167.172.181.34:3100
OUTBOUND_AGENT_NAME=outbound-call-agent
OUTBOUND_CALLBACK_SECRET=<свой секрет>
```

### Минимальный NestJS-сервис (пример)

```typescript
import { Injectable } from '@nestjs/common';
import { AgentDispatchClient, SipClient, RoomServiceClient, AccessToken } from 'livekit-server-sdk';
import { v4 as uuidv4 } from 'uuid';

const LK = process.env.LIVEKIT_HOST_OUTBOUND!;
const LK_KEY = process.env.LIVEKIT_API_KEY_OUTBOUND!;
const LK_SEC = process.env.LIVEKIT_API_SECRET_OUTBOUND!;
const LK_WS = process.env.LIVEKIT_WS_URL_OUTBOUND!;
const TRUNK = process.env.SIP_TRUNK_ID!;
const RECORDER = process.env.RECORDER_URL_OUTBOUND!;
const BACKEND = 'https://my.linkeon.io';  // куда слать callback

@Injectable()
export class OutboundCallService {
  private rooms = new RoomServiceClient(LK, LK_KEY, LK_SEC);
  private dispatcher = new AgentDispatchClient(LK, LK_KEY, LK_SEC);
  private sip = new SipClient(LK, LK_KEY, LK_SEC);

  async callPhone(opts: {
    phone: string;        // +7...
    callId: string;       // ваш ID для трекинга
    prompt: string;       // промпт агента
    questions: string[];  // что узнать
    taskContext?: string;
  }) {
    const roomName = `linkeon-${uuidv4()}`;
    await this.rooms.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 5 });

    const metadata = JSON.stringify({
      businessName: 'Клиент',
      phoneNumber: opts.phone,
      questionsToAsk: opts.questions,
      taskContext: opts.taskContext || '',
      agentPrompt: opts.prompt,
      callId: opts.callId,
      campaignId: opts.callId,                 // agent требует оба поля
      callbackUrl: `${BACKEND}/webhook/outbound-callback`,
    });

    await this.dispatcher.createDispatch(roomName, 'outbound-call-agent', { metadata });

    // Non-blocking: SIP может ждать ответа до 90с
    this.sip.createSipParticipant(TRUNK, opts.phone, roomName, {
      participantIdentity: `sip-${opts.phone}`,
      participantName: opts.phone,
      waitUntilAnswered: true,
      timeout: 90,
    }).catch(e => console.warn('sip:', e.message));

    // Start recorder 5s later
    setTimeout(() => {
      fetch(`${RECORDER}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName, withAi: false }),
      }).catch(() => {});
    }, 5000);

    return { roomName };
  }

  async stopRecording(roomName: string) {
    await fetch(`${RECORDER}/stop-record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName }),
    });
    // URL появится в вашей MeetingSummary через 30-90с (recorder.js uploads на ${BACKEND}/voice/recordings/upload)
  }

  // Листенер подключения (отдаётся клиенту, он WSS'ится в room)
  async generateListenToken(userId: string, roomName: string) {
    const token = new AccessToken(LK_KEY, LK_SEC, {
      identity: `listener-${userId}`, name: 'Слушатель',
    });
    token.addGrant({ room: roomName, roomJoin: true, canPublish: false, canSubscribe: true });
    return { token: await token.toJwt(), wsUrl: LK_WS, roomName };
  }

  async hangup(roomName: string) {
    try { await this.rooms.deleteRoom(roomName); } catch {}
  }
}
```

### Callback-endpoint на Linkeon

```typescript
@Controller('webhook')
export class OutboundCallbackController {
  @Post('outbound-callback')
  async callback(
    @Headers('x-outbound-secret') secret: string,
    @Body() data: {
      callId: string; campaignId: string;
      transcript: any[];           // turnы диалога
      summary: string;
      durationSec: number;
      status: 'completed' | 'failed' | 'no_answer';
    },
  ) {
    if (secret !== process.env.OUTBOUND_CALLBACK_SECRET) throw new UnauthorizedException();
    // сохранить transcript, обновить свой Call status, выпустить event пользователю
    return { ok: true };
  }
}
```

**Важно**: agent шлёт `transcript` как **массив** объектов `{role, content}` — сохраняйте как JSON (не spread-ите как объект).

### Recorder upload (опционально)

Recorder на DO после `/stop-record` микширует MP3 и POST-ит на `${BACKEND}/voice/recordings/upload` (multipart). Linkeon нужно реализовать этот endpoint (или указать другой `BACKEND_URL` в env рекордера — для этого надо поднять свой recorder на DO, shared recorder сейчас заточен на Taler backend).

**Проще**: использовать свой recorder — скопировать `~/livekit-ai-agent/` с Taler DO-сервера, поднять на отдельном port (например 3101), задать `BACKEND_URL=https://my.linkeon.io`.

### Стоимость

- **SIPNET**: ~2-3 руб/мин за исходящие по РФ (баланс на общем аккаунте)
- **OpenAI GPT-4o**: ~$0.5-1 за 5-мин звонок
- **ElevenLabs**: ~$0.3 за 5-мин звонок
- **Deepgram**: ~$0.03/мин

**~15-20 руб за 5-минутный звонок**. Нужно вести учёт на стороне Linkeon и списывать токены.

### Ограничения shared setup

- **Один agent_name** `outbound-call-agent` — если нужны разные стили/промпты, передавайте через `metadata.agentPrompt`
- **SIPNET аккаунт общий** — все звонки имеют caller-ID `+74951086247`
- **Recording upload** по умолчанию идёт на Taler backend (нужен свой recorder чтобы получать MP3 на Linkeon backend)
- **Balance пополняет владелец Taler** — договориться о биллинге отдельно

### Что делать НЕ нужно

- ❌ Разворачивать свой LiveKit/SIP/Asterisk/Agent
- ❌ Регистрироваться в SIPNET отдельно
- ❌ Платить за серверы DigitalOcean/Selectel

### Что может понадобиться потом

- **Свой caller-ID номер** — отдельный SIP ID в SIPNET + отдельный trunk в Asterisk (5 мин настройки админом Taler)
- **Свой agent** с другим голосом/промптом по умолчанию — дубль `outbound-call-agent` с новым `agent_name` на DO
- **Отдельный biling / квоты** — tracking на стороне Linkeon
