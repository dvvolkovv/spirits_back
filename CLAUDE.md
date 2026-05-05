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

## Деплой бэкенда
```bash
cd ~/Downloads/spirits_back
rsync -az src/ dvolkov@212.113.106.202:~/spirits_back/src/
ssh dvolkov@212.113.106.202 "cd ~/spirits_back && npm run build && pm2 restart linkeon-api"
```

## Деплой фронтенда
```bash
cd ~/Downloads/spirits_front
echo "VITE_BACKEND_URL=https://my.linkeon.io" > .env
pnpm build
rsync -az --delete dist/ dvolkov@212.113.106.202:/home/dvolkov/spirits_front/
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
scp ~/Downloads/spirits_back/tests/referral.e2e.sh dvolkov@212.113.106.202:/tmp/
ssh dvolkov@212.113.106.202 "bash /tmp/referral.e2e.sh"
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
