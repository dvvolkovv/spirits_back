# My.Linkeon (b.linkeon.io)

## Обзор
Платформа для поиска единомышленников. NestJS бэкенд + React фронтенд.

## Окружения

| | Test | Prod |
|--|------|------|
| URL | https://b.linkeon.io | https://my.linkeon.io |
| Сервер | `ssh -p 60322 dvolkov@82.202.197.230` | n8n на Railway (migrating) |
| БД | PostgreSQL local (`linkeon`) | Railway PostgreSQL |
| Neo4j | Docker local (bolt://localhost:7687) | Railway Neo4j |
| PM2 | `linkeon-api` (port 3001) | — |

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

## Деплой бэкенда
```bash
cd ~/Downloads/spirits_back
rsync -az -e "ssh -p 60322" src/ dvolkov@82.202.197.230:~/spirits_back/src/
ssh -p 60322 dvolkov@82.202.197.230 "cd ~/spirits_back && npm run build && pm2 restart linkeon-api"
```

## Деплой фронтенда
```bash
cd ~/Downloads/spirits_front
echo "VITE_BACKEND_URL=https://b.linkeon.io" > .env
pnpm build
rsync -az --delete -e "ssh -p 60322" dist/ dvolkov@82.202.197.230:/var/www/spirits/dist/
```

## Тестовые аккаунты
| | Телефон | Роль |
|--|---------|------|
| Admin | `79030169187` | isadmin=true, реферальный лидер (test-leader) |
| Test | `70000000000` | тестовый пользователь |

DEBUG_SMS_CODES=true — код можно получить через `GET /webhook/debug/sms-code/:phone`

## 🧪 ОБЯЗАТЕЛЬНЫЕ ТЕСТЫ

### 1. API smoke-тесты (32 теста)
Проверяет все эндпоинты: auth, profile, agents, chat, tokens, payments, referral, admin, search, compatibility, imagegen.
```bash
cd ~/Downloads/spirits_back/tests && npm install && node runner.js --suite api
```
- 32/32 должны быть зелёными.

### 2. E2E тесты с авторизацией (18 тестов)
Полный цикл: SMS OTP → JWT → профиль → агенты → стриминг чат → история → смена агента → email → аватар → реферал.
```bash
cd ~/Downloads/spirits_back/tests && node runner.js --suite e2e
```
- 18/18 должны быть зелёными.
- Использует debug endpoint для получения SMS кода.

### 3. Реферальная система E2E (20 сценариев)
Запускается на сервере (нужен доступ к PostgreSQL).
```bash
scp -P 60322 ~/Downloads/spirits_back/tests/referral.e2e.sh dvolkov@82.202.197.230:/tmp/
ssh -p 60322 dvolkov@82.202.197.230 "bash /tmp/referral.e2e.sh"
```
Проверяет:
- Создание лидеров L1/L2
- Регистрация рефералов по slug
- Защита от повторной регистрации
- Регистрация по несуществующему/деактивированному slug
- Начисление комиссий при оплате (L1 direct + L2 upstream)
- Множественные оплаты
- Статистика лидера (direct/upstream breakdown)
- Admin: mark_paid одна комиссия
- Admin: mark_all_paid все комиссии лидера
- Admin: toggle active/inactive
- Не-лидер получает isLeader=false
- Admin summary (total/paid/pending)
- Cleanup тестовых данных

### 4. Все тесты разом
```bash
cd ~/Downloads/spirits_back/tests && npm install && node runner.js
```
Запускает api (32) + e2e (18) = 50 тестов.

### 5. Проверка через браузер (Playwright)
```bash
cd /tmp/pw_test && node final_test.js
```
Скриншоты сохраняются в `/tmp/screenshots/`. Проверяет 8 вкладок:
- /chat — выбор ассистента, стриминг чат
- /profile — данные, аватар, ценности из Neo4j
- /search — поиск людей
- /compatibility — анализ совместимости
- /tokens — пакеты токенов, YooKassa
- /referral — партнёрская программа (для лидеров)
- /admin — ассистенты, купоны, рефералы (для isadmin=true)
- /image-gen — генерация изображений

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
