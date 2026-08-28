# Голосовой звонок ассистенту (Роман) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь-админ звонит голосом ассистенту Роману из веб-интерфейса Linkeon; Роман разговаривает в реальном времени и асинхронно консультируется у профильных ассистентов, продолжая беседу, пока те думают.

**Architecture:** Браузер соединяется по WebRTC с нашей LiveKit-комнатой. В комнату входит воркер `linkeon-voice-host` (отдельный pm2-процесс на `@livekit/agents`), который проксирует аудио в OpenAI Realtime. Тул `ask_specialist` возвращает управление модели мгновенно, а NestJS-модуль `VoiceCallModule` в фоне гоняет специалиста через `ChatService.generateAgentReply()` и доставляет ответ обратно data-сообщением LiveKit.

**Tech Stack:** NestJS 10, TypeScript, PostgreSQL, jest (бэк) / vitest (фронт), `livekit-server-sdk` ^2.15.1, `@livekit/agents` + `@livekit/agents-plugin-openai` (воркер), `livekit-client` (фронт), React 18 + Tailwind.

**Спека:** `docs/superpowers/specs/2026-08-25-voice-call-roman-design.md`

---

## Прежде чем начинать

**Сборки и тесты — на тестовой ноде, не на маке.** Мак не тянет; `jest` уходит в таймаут. Порядок:

```bash
git push -u origin <ветка>
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q <sha>'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && pnpm install && npx jest src/voice-call'
```

`source ~/.nvm/nvm.sh` обязателен в каждой ssh-команде. Работать только в `~/ci/`, никогда в `~/spirits_back` — там живой чекаут `test.linkeon.io`.

**`npm test` целиком красный by design** (jest скребёт `.worktrees/`, два теста падают на `main`). Свою работу мерить дельтой: гонять `npx jest src/voice-call` и `npx jest src/dozvon` точечно.

**Деплой — только `bash ~/Downloads/spirits_back/scripts/deploy.sh`**, без флагов, и только после явного «ок» от владельца.

---

## Карта файлов

**Бэкенд (`spirits_back`), новое:**

| Файл | Ответственность |
|---|---|
| `src/voice-call/voice-call.module.ts` | сборка модуля |
| `src/voice-call/voice-call.controller.ts` | публичные ручки: `/start`, `/:id/end`, `/:id` — под `JwtGuard` + гейт `isAdmin` |
| `src/voice-call/voice-call-internal.controller.ts` | ручки воркера: `/internal/ask`, `/internal/complete`, `/internal/failed` — под HMAC |
| `src/voice-call/voice-call.service.ts` | жизненный цикл звонка: создание, preamble, токен, диспатч, завершение |
| `src/voice-call/specialist-job.service.ts` | асинхронный мост: очередь job, вызов специалиста, доставка ответа в комнату |
| `src/voice-call/livekit.client.ts` | тонкая обёртка над `livekit-server-sdk`: токен, диспатч, `sendData` |
| `src/voice-call/hmac.ts` | подпись и проверка `x-voice-signature` |
| `src/voice-call/voice-call.types.ts` | типы data-сообщений и DTO |
| `src/voice-call/migrations/001_voice_calls.sql` | таблицы |

**Воркер (`spirits_back/voice-host/`), новое** — отдельный подпроект по образцу `worker/`:

| Файл | Ответственность |
|---|---|
| `voice-host/package.json` | свои зависимости, `build`/`start` |
| `voice-host/tsconfig.json` | сборка в `dist/` |
| `voice-host/ecosystem.config.js` | pm2-процесс `linkeon-voice-host` |
| `voice-host/src/agent.ts` | точка входа: сессия Realtime, тулы, приём data-сообщений |
| `voice-host/src/backend.ts` | HTTP-клиент к нашему бэку с HMAC |
| `voice-host/src/pending.ts` | буфер ответов, ждущих паузы в речи |

**Инфраструктура, новое:** `infra/livekit/livekit.yaml`, `infra/livekit/docker-compose.yml`, `infra/livekit/README.md`.

**Фронт (`spirits_front`), новое:** `src/components/chat/VoiceCallModal.tsx`, `src/components/chat/useVoiceCall.ts`, `src/components/chat/VoiceCallCard.tsx`.

**Изменяемое:**

| Файл | Что |
|---|---|
| `src/app.module.ts` | убрать `DozvonModule`, добавить `VoiceCallModule` |
| `src/utils/customMarkdown.tsx` (фронт) | regex `{{voice_call:id=…}}` |
| `src/components/chat/ChatInterface.tsx:2143,2275` (фронт) | кнопка «Позвонить» рядом с тумблером «Чистый лист» |
| `src/i18n/locales/*.json` (фронт) | строки UI |

**Удаляемое:** `src/dozvon/` целиком (10 файлов).

---

### Task 1: Выпилить модуль `dozvon`

Предусловие остальной работы: модуль нерабочий (ключей LiveKit в env нет), UI удалён в июне, но кроны тикают и висит неаутентифицированный эндпоинт `recording-upload`, а `recorder.service.ts:19` шлёт адрес этого эндпоинта на чужой сервер `167.172.181.34:3100`.

**Files:**
- Delete: `src/dozvon/` (весь каталог)
- Modify: `src/app.module.ts`

- [ ] **Step 1: Зафиксировать образцы вызовов SDK, которые понадобятся позже**

Прочитать и запомнить (не копировать в новый код, только как образец рабочих вызовов):

```bash
sed -n '1,55p' src/dozvon/voice-agent.service.ts   # AgentDispatchClient.createDispatch
grep -n "SipClient\|createSipParticipant" src/dozvon/sip.service.ts
```

`createDispatch(roomName, agentName, { metadata })` — та же механика нужна в Task 6. `sip.service.ts` пригодится подсистеме D (телефония), она за границами этого плана.

- [ ] **Step 2: Убедиться, что на модуль никто не ссылается снаружи**

Проверять надо **импорты**, а не вхождения слова: по слову `dozvon` найдутся комментарии в `admin.controller.ts` и сырой SQL к таблицам `dozvon_calls` / `dozvon_campaigns` в `admin.service.ts:1641` и `monitoring/product/content.service.ts`. Это не зависимости от модуля — таблицы мы оставляем, а запросы к ним обёрнуты в `try/catch` с graceful 0.

Run:
```bash
grep -rnE "from ['\"].*dozvon" --include="*.ts" src/ | grep -v "^src/dozvon/"
```
Expected: ровно одна строка — `src/app.module.ts:20`. Если найдётся что-то ещё — остановиться и разобраться, не удалять вслепую.

Учти, что запись `DozvonModule,` в массиве `imports` (строка ~70) этим grep не ловится — снимать её всё равно надо, см. следующий шаг.

- [ ] **Step 3: Удалить каталог и снять регистрацию модуля**

```bash
git rm -r src/dozvon
```

В `src/app.module.ts` удалить строку 20 (`import { DozvonModule } from './dozvon/dozvon.module';`) и строку 69 (`DozvonModule,` в массиве `imports`).

- [ ] **Step 4: Убедиться, что проект собирается**

Run (на тест-ноде):
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx tsc --noEmit'
```
Expected: без ошибок. Если `tsc` ругается на несуществующий `./dozvon/dozvon.module` — импорт снят не полностью.

- [ ] **Step 5: Убедиться, что не сломались чужие тесты**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/chat src/tokens 2>&1 | tail -20'
```
Expected: то же число падений, что было до удаления (на `main` их два — мерить дельтой, а не абсолютом).

- [ ] **Step 6: Commit**

```bash
git add -A src/dozvon src/app.module.ts
git commit -m "chore(dozvon): удалить мёртвый модуль обзвона

Модуль нерабочий: ключей LIVEKIT_* в прод-.env нет, UI удалён в июне,
последний успешный звонок 27.04.2026. При этом висели две проблемы:

- POST /webhook/dozvon/internal/recording-upload не проверял ничего
  (соседние ручки закрыты секретами), тело без лимита писалось
  в public/dozvon/ и отдавалось с нашего домена;
- recorder.service.ts слал адрес этой ручки на 167.172.181.34:3100 —
  бокс, который с июля принадлежит постороннему.

Таблицы dozvon_calls и кампании оставлены: там 53 исторических звонка."
```

Таблицы в БД **не трогаем** — данные остаются.

---

### Task 2: Конфиг LiveKit в git

Сейчас `livekit.yaml` существует в единственном экземпляре на прод-машине (`~/livekit-dozvon/livekit.yaml`), `deploy.sh` его не катает, восстанавливать после пересборки сервера не по чему.

**Files:**
- Create: `infra/livekit/livekit.yaml`, `infra/livekit/docker-compose.yml`, `infra/livekit/README.md`

- [ ] **Step 1: Снять текущий конфиг с прода как основу**

Run:
```bash
ssh dvolkov@212.113.106.202 'cat ~/livekit-dozvon/livekit.yaml'
```
Expected: порт 7880, `port_range 50000-60000`, `tcp_port 7881`, redis `localhost:6380`, ключ `dozvon0987ebaed0ef3b8c`.

- [ ] **Step 2: Записать конфиг в репозиторий с правками из спеки**

Create `infra/livekit/livekit.yaml`:

```yaml
# LiveKit SFU для голосовых звонков Linkeon.
# Применяется на прод-хосте как ~/livekit-dozvon/livekit.yaml — см. README.md рядом.
#
# Отличия от исходного конфига (16.04.2026):
#   * udp_port вместо port_range — UDP mux. Без него каждый участник занимает
#     2 UDP-порта, диапазон 50000-60000 упирается в ~2500 комнат «1+1» на ноду.
#     Диапазон mux не меньше числа vCPU: один сокет — точка сериализации.
#   * node_selector — на одной ноде ни на что не влияет, но когда появится
#     вторая, дефолтный sort_by: random раскидывает комнаты вслепую и
#     складывает их на одну ноду (задокументированное «стадное» поведение).
port: 7880

bind_addresses:
  - ""

rtc:
  udp_port: 7882-7892
  tcp_port: 7881
  use_external_ip: true

redis:
  address: localhost:6380

node_selector:
  kind: any
  sort_by: cpuload
  algorithm: twochoice

keys:
  # Ключи в git не кладём. Реальный файл на хосте содержит секции keys:
  # с парами <api-key>: <api-secret>. См. README.md, раздел «Ключи».
  # Плейсхолдер оставлен, чтобы конфиг был валиден при локальной проверке.
  devkey: devsecret_at_least_32_characters_long_x

logging:
  level: info
```

- [ ] **Step 3: Записать определение контейнера**

Create `infra/livekit/docker-compose.yml`:

```yaml
services:
  livekit:
    image: livekit/livekit-server:v1.9
    container_name: livekit-linkeon
    restart: unless-stopped
    network_mode: host
    command: --config /etc/livekit.yaml
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
```

Тег версии зафиксирован: `:latest` на проде уже привёл к тому, что никто не знает, какая версия работает.

- [ ] **Step 4: Записать процедуру применения**

Create `infra/livekit/README.md`:

```markdown
# LiveKit SFU

Работает на прод-хосте `212.113.106.202` как контейнер (исторически
`livekit-dozvon`, поднят 16.04.2026 вручную и до 25.08.2026 отсутствовал в git).

## Ключи

В git не хранятся. На хосте в `~/livekit-dozvon/livekit.yaml` секция `keys:`
содержит пары `<api-key>: <api-secret>`. Для голосовых звонков заведён
отдельный ключ `voicecall*`, ключ `dozvon*` не переиспользуется.

Бэкенд читает их из `.env`: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`LIVEKIT_URL` (по умолчанию `ws://localhost:7880`).

## Применить изменения конфига

    scp infra/livekit/livekit.yaml dvolkov@212.113.106.202:~/livekit-dozvon/livekit.yaml.new
    ssh dvolkov@212.113.106.202
    # вручную перенести секцию keys: из старого файла в новый
    mv ~/livekit-dozvon/livekit.yaml.new ~/livekit-dozvon/livekit.yaml
    sudo docker restart livekit-dozvon
    curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7880   # ждём 200

Рестарт рвёт активные звонки. Перед применением проверить, что их нет:

    psql -c "SELECT count(*) FROM voice_calls WHERE status IN ('dialing','active')"

## Настройки хоста

Отдельно от конфига, разово (см. спеку, раздел «Инфраструктурная гигиена»):

    ulimit -n 65535
    sysctl -w net.core.rmem_max=25165824
    sysctl -w net.core.wmem_max=25165824
    sysctl -w net.core.somaxconn=65535
```

- [ ] **Step 5: Починить `CLAUDE.md`**

Раздел «📞 Outbound AI calls — общая инфраструктура с Taler ID» (строки ~509–690) неверен целиком и уже один раз увёл расследование не туда: он утверждает «Разворачивать свой SIP/LiveKit/агента НЕ нужно — всё shared» и «❌ Разворачивать свой LiveKit», тогда как свой LiveKit работает с апреля, а shared-инфраструктура мертва.

Заменить весь раздел на короткий, с датой проверки:

```markdown
## 📞 Голосовая инфраструктура

**Свой LiveKit SFU** работает на прод-хосте как контейнер `livekit-dozvon`
(исторический номер, поднят 16.04.2026). Конфиг и процедура применения —
`infra/livekit/`. Переменные бэкенда: `LIVEKIT_URL` (default
`ws://localhost:7880`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

**Модуль `dozvon` удалён 25.08.2026** — обзвон не работал с апреля, ручка
приёма записи была без авторизации. Таблицы `dozvon_calls` и
`dozvon_campaigns` оставлены: 53 исторических звонка, их читает дашборд
мониторинга.

**Историческая справка (не актуально, проверено 25.08.2026).** Раньше здесь
был раздел про общую инфраструктуру обзвона с Taler ID: LiveKit на
`167.172.181.34`, SIP-транк через Asterisk на Selectel, рекордер на :3100.
Ничего из этого больше нет — бокс с июля принадлежит постороннему, Asterisk
демонтирован 22.06.2026. Если встретишь ссылки на эти адреса в старых
документах или задачах — они мертвы.

Голосовые звонки ассистенту — см. `docs/superpowers/specs/2026-08-25-voice-call-roman-design.md`.
```

Проверить, что не осталось других мест с тем же мифом:

```bash
grep -n "167.172.181.34\|outbound-call-agent\|ST_BpnXtg7BirH6\|LIVEKIT_HOST_OUTBOUND\|RECORDER_URL_OUTBOUND" CLAUDE.md
```
Expected: пусто после правки.

- [ ] **Step 6: Commit**

```bash
git add infra/livekit CLAUDE.md
git commit -m "infra(livekit): конфиг SFU в git, починить CLAUDE.md

Конфиг существовал в одном экземпляре на прод-машине с апреля, deploy.sh
его не катает. Добавлены UDP mux (снимает потолок ~2500 комнат на ноду)
и node_selector cpuload/twochoice, версия образа зафиксирована вместо latest.

Раздел про shared-инфраструктуру Taler ID переписан: он утверждал
«не разворачивать свой LiveKit» при работающем своём с апреля и описывал
серверы, которых у нас с июня нет. Этот текст уже один раз увёл
расследование не туда."
```

Применение конфига на прод — отдельно, вручную по README, не в рамках этого коммита.

---

### Task 3: Таблицы

**Files:**
- Create: `src/voice-call/migrations/001_voice_calls.sql`

- [ ] **Step 1: Написать миграцию**

Create `src/voice-call/migrations/001_voice_calls.sql`:

```sql
-- user_id TEXT, не varchar: у пользователей через email/OAuth идентификатор это
-- gen_random_uuid()::text (36 символов), а не телефон.
CREATE TABLE IF NOT EXISTS voice_calls (
  id             UUID PRIMARY KEY,
  user_id        TEXT NOT NULL,
  agent_id       INTEGER NOT NULL,
  room_name      TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  duration_sec   INTEGER,
  transcript     JSONB,
  summary        TEXT,
  recording_url  TEXT,
  cost_usd       NUMERIC(10,4),
  model          TEXT
);

CREATE INDEX IF NOT EXISTS voice_calls_user_started_idx
  ON voice_calls (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_active_idx
  ON voice_calls (status) WHERE status IN ('dialing', 'active');

CREATE TABLE IF NOT EXISTS voice_call_jobs (
  id                   UUID PRIMARY KEY,
  call_id              UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  specialist_agent_id  INTEGER NOT NULL,
  question             TEXT NOT NULL,
  status               TEXT NOT NULL,
  answer               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ,
  latency_ms           INTEGER
);

CREATE INDEX IF NOT EXISTS voice_call_jobs_call_status_idx
  ON voice_call_jobs (call_id, status);
```

- [ ] **Step 2: Проверить синтаксис на тест-ноде**

Переменной `TEST_DATABASE_URL` на ноде нет. Реквизиты — в `.env` живого чекаута тестового стенда; читать оттуда можно, но **ветку в `~/spirits_back` не переключать**, это работающий стенд `test.linkeon.io`. База — `linkeon`, PostgreSQL 16.14.

Run:
```bash
scp src/voice-call/migrations/001_voice_calls.sql dv@85.192.61.231:/tmp/
ssh dv@85.192.61.231 'set -a; . ~/spirits_back/.env; set +a; \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/001_voice_calls.sql && \
  psql "$DATABASE_URL" -c "\d voice_calls" && psql "$DATABASE_URL" -c "\d voice_call_jobs"'
```
Expected: `CREATE TABLE` без ошибок, `\d voice_calls` показывает 13 колонок, `\d voice_call_jobs` — 9.

Миграция идемпотентна (`IF NOT EXISTS`), повторный прогон безопасен. **На прод сейчас не накатывать** — это шаг задачи 14.

- [ ] **Step 3: Commit**

```bash
git add src/voice-call/migrations/001_voice_calls.sql
git commit -m "feat(voice-call): таблицы voice_calls и voice_call_jobs"
```

**Накат на прод** делается отдельно и вручную: `npm run migrate` на проде застрял на `base/001` (падает на `CREATE TYPE payment_status_enum`) и ничего после не докатывает. Порядок — `psql -f` плюс ручной `INSERT INTO schema_migrations`.

---

### Task 4: HMAC для внутренних ручек

**Files:**
- Create: `src/voice-call/hmac.ts`, `src/voice-call/hmac.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Create `src/voice-call/hmac.spec.ts`:

```typescript
import { signBody, verifyBody } from './hmac';

describe('voice-call HMAC', () => {
  const secret = 'test-secret-value';
  const body = JSON.stringify({ callId: 'abc', question: 'привет' });

  it('подпись проходит проверку своим же секретом', () => {
    expect(verifyBody(secret, body, signBody(secret, body))).toBe(true);
  });

  it('чужая подпись не проходит', () => {
    expect(verifyBody(secret, body, signBody('other-secret', body))).toBe(false);
  });

  it('подмена тела ломает подпись', () => {
    const sig = signBody(secret, body);
    expect(verifyBody(secret, body.replace('привет', 'пока'), sig)).toBe(false);
  });

  it('пустая или кривая подпись отвергается, а не падает', () => {
    expect(verifyBody(secret, body, '')).toBe(false);
    expect(verifyBody(secret, body, 'не-hex')).toBe(false);
    expect(verifyBody(secret, body, undefined as unknown as string)).toBe(false);
  });

  it('подпись кириллицы стабильна между вызовами', () => {
    expect(signBody(secret, 'вопрос юристу')).toBe(signBody(secret, 'вопрос юристу'));
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/hmac.spec.ts'
```
Expected: FAIL — `Cannot find module './hmac'`.

- [ ] **Step 3: Реализовать**

Create `src/voice-call/hmac.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

/** hex-подпись HMAC-SHA256 над сырым телом запроса. */
export function signBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Сравнение constant-time. Любой мусор на входе — false, а не исключение:
 * ручка должна отвечать 401, а не 500.
 */
export function verifyBody(secret: string, rawBody: string, signature: string): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signBody(secret, rawBody);
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/hmac.spec.ts'
```
Expected: PASS, 5 тестов.

- [ ] **Step 5: Commit**

```bash
git add src/voice-call/hmac.ts src/voice-call/hmac.spec.ts
git commit -m "feat(voice-call): HMAC-подпись внутренних ручек"
```

---

### Task 5: Типы data-сообщений

**Files:**
- Create: `src/voice-call/voice-call.types.ts`

- [ ] **Step 1: Описать контракт**

Create `src/voice-call/voice-call.types.ts`:

```typescript
/**
 * Сообщения, которые бэкенд шлёт в LiveKit-комнату (topic 'linkeon').
 * Поле v версионирует контракт: подсистемы C (Zoom) и D (телефония)
 * будут слушать тот же канал.
 *
 * Слушают оба: воркер (реагирует на answer/failed) и фронт (рисует плашки).
 */
export const VOICE_DATA_TOPIC = 'linkeon';

export type VoiceDataMessage =
  | { v: 1; type: 'specialist_pending'; jobId: string; specialist: string }
  | { v: 1; type: 'specialist_answer'; jobId: string; specialist: string; text: string }
  | { v: 1; type: 'specialist_failed'; jobId: string; specialist: string; reason: 'timeout' | 'error' };

/** Ответ на /internal/ask. rejected — не ошибка: модель должна это озвучить. */
export type AskResult =
  | { status: 'asked'; jobId: string; specialist: string }
  | { status: 'rejected'; reason: 'too_many_pending' | 'unknown_specialist' };

export interface CompletePayload {
  transcript: { role: 'user' | 'assistant'; text: string; ts: number }[];
  usage: { audioInputTokens: number; audioOutputTokens: number; model: string };
}

/**
 * Кому Роман может задавать вопросы. Ключ — то, что произносит модель,
 * значение — id в таблице agents.
 */
export const SPECIALISTS: Record<string, number> = {
  'Алексей': 10,     // юрист
  'Анна': 9,         // бухгалтер
  'Виталий': 17,     // финансовый директор
  'Андрей': 7,       // бизнес
  'Александра': 11,  // маркетинг
};

/** Роман — ведущий разговора. */
export const HOST_AGENT_ID = 12;

/** Больше трёх параллельных job на звонок не берём. */
export const MAX_PENDING_JOBS = 3;

/** Дольше этого специалиста не ждём — Роман извиняется и отвечает сам. */
export const JOB_TIMEOUT_MS = 180_000;
```

- [ ] **Step 2: Проверить, что типы компилируются**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx tsc --noEmit'
```
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/voice-call/voice-call.types.ts
git commit -m "feat(voice-call): контракт data-сообщений и реестр специалистов"
```

---

### Task 6: Обёртка над LiveKit SDK

**Files:**
- Create: `src/voice-call/livekit.client.ts`

- [ ] **Step 1: Реализовать обёртку**

Три вызова SDK в одном месте, чтобы сервисы не знали про SDK. Образец `createDispatch` — из удалённого `dozvon/voice-agent.service.ts`.

Create `src/voice-call/livekit.client.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { VOICE_DATA_TOPIC, VoiceDataMessage } from './voice-call.types';

@Injectable()
export class LiveKitClient {
  private readonly logger = new Logger(LiveKitClient.name);

  private get wsUrl(): string { return process.env.LIVEKIT_URL || 'ws://localhost:7880'; }
  private get httpUrl(): string {
    return this.wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  }
  private get apiKey(): string { return process.env.LIVEKIT_API_KEY || ''; }
  private get apiSecret(): string { return process.env.LIVEKIT_API_SECRET || ''; }

  /** Токен участника-человека. TTL с запасом на 60-минутный потолок сессии. */
  async userToken(roomName: string, identity: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity, ttl: '2h' });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
  }

  /** Позвать воркера в комнату. metadata приезжает к нему в JobContext. */
  async dispatchAgent(roomName: string, metadata: Record<string, unknown>): Promise<void> {
    const agentName = process.env.VOICE_AGENT_NAME || 'linkeon-voice-host';
    const client = new AgentDispatchClient(this.httpUrl, this.apiKey, this.apiSecret);
    await client.createDispatch(roomName, agentName, { metadata: JSON.stringify(metadata) });
    this.logger.log(`[dispatch] room=${roomName} agent=${agentName}`);
  }

  /** Доставка сообщения в комнату. Слушают и воркер, и фронт. */
  async send(roomName: string, msg: VoiceDataMessage): Promise<void> {
    const client = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    await client.sendData(roomName, payload, 0 /* RELIABLE */, { topic: VOICE_DATA_TOPIC });
  }
}
```

- [ ] **Step 2: Проверить компиляцию и сигнатуры SDK**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx tsc --noEmit'
```
Expected: без ошибок. Если `sendData` или `addGrant` ругаются на типы — открыть `node_modules/livekit-server-sdk/dist/index.d.ts` и поправить вызов под установленную версию 2.15.x, не подгоняя типами `any`.

- [ ] **Step 3: Commit**

```bash
git add src/voice-call/livekit.client.ts
git commit -m "feat(voice-call): обёртка над livekit-server-sdk"
```

---

### Task 7: `SpecialistJobService` — асинхронный мост

Ядро фичи. Инвариант, ради которого всё строится: **`ask()` возвращает управление мгновенно и не трогает LLM.**

**Files:**
- Create: `src/voice-call/specialist-job.service.ts`, `src/voice-call/specialist-job.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Create `src/voice-call/specialist-job.service.spec.ts`:

```typescript
import { SpecialistJobService } from './specialist-job.service';

/** Заглушка PgService: помнит job'ы в памяти. */
function makePg() {
  const jobs: any[] = [];
  return {
    jobs,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO voice_call_jobs/i.test(sql)) {
        jobs.push({ id: params[0], call_id: params[1], specialist_agent_id: params[2], status: 'queued' });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE voice_call_jobs/i.test(sql)) {
        const j = jobs.find((x) => x.id === params[params.length - 1]);
        if (j) j.status = /status\s*=\s*'done'|\$1/i.test(sql) ? 'done' : j.status;
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT count/i.test(sql)) {
        const pending = jobs.filter((x) => x.status === 'queued' || x.status === 'running').length;
        return { rows: [{ count: String(pending) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

describe('SpecialistJobService', () => {
  const ROOM = 'voice_test_room';
  const CALL = '11111111-1111-1111-1111-111111111111';

  it('ask() отвечает быстро и НЕ вызывает LLM синхронно', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'ответ юриста') };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    const started = Date.now();
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    const elapsed = Date.now() - started;

    expect(res).toMatchObject({ status: 'asked', specialist: 'Алексей' });
    expect(elapsed).toBeLessThan(200);
    // Главное: на момент ответа модель ещё не звали.
    expect(chat.generateAgentReply).not.toHaveBeenCalled();
  });

  it('после завершения job ответ уходит в комнату', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'ответ юриста') };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    const res = await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'Можно ли так?');
    await svc.drainForTests();

    expect(chat.generateAgentReply).toHaveBeenCalledTimes(1);
    const sent = lk.send.mock.calls.map((c: any[]) => c[1]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'specialist_pending' }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'specialist_answer',
      specialist: 'Алексей',
      text: 'ответ юриста',
      jobId: (res as any).jobId,
    }));
  });

  it('каждый job получает изолированную сессию — иначе релей отдаёт пустой поток', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => 'ok') };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос один');
    await svc.ask(CALL, ROOM, 'user-1', 'Анна', 'вопрос два');
    await svc.drainForTests();

    const sessions = chat.generateAgentReply.mock.calls.map((c: any[]) => c[3]);
    expect(sessions.every((s: string) => typeof s === 'string' && s.length > 0)).toBe(true);
    expect(new Set(sessions).size).toBe(2);
  });

  it('падение специалиста превращается в specialist_failed, а не в исключение', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(async () => { throw new Error('релей лёг'); }) };
    const lk = { send: jest.fn(async () => {}) };
    const svc = new SpecialistJobService(pg as any, chat as any, lk as any);

    await svc.ask(CALL, ROOM, 'user-1', 'Алексей', 'вопрос');
    await expect(svc.drainForTests()).resolves.toBeUndefined();

    expect(lk.send.mock.calls.map((c: any[]) => c[1])).toContainEqual(
      expect.objectContaining({ type: 'specialist_failed', reason: 'error' }),
    );
  });

  it('неизвестный специалист отклоняется без создания job', async () => {
    const pg = makePg();
    const svc = new SpecialistJobService(pg as any, { generateAgentReply: jest.fn() } as any, { send: jest.fn() } as any);
    const res = await svc.ask(CALL, ROOM, 'user-1', 'Гэндальф', 'вопрос');
    expect(res).toEqual({ status: 'rejected', reason: 'unknown_specialist' });
    expect(pg.jobs).toHaveLength(0);
  });

  it('четвёртый параллельный вопрос отклоняется', async () => {
    const pg = makePg();
    const chat = { generateAgentReply: jest.fn(() => new Promise<string>(() => {})) }; // висит
    const svc = new SpecialistJobService(pg as any, chat as any, { send: jest.fn(async () => {}) } as any);

    await svc.ask(CALL, ROOM, 'u', 'Алексей', 'раз');
    await svc.ask(CALL, ROOM, 'u', 'Анна', 'два');
    await svc.ask(CALL, ROOM, 'u', 'Виталий', 'три');
    const fourth = await svc.ask(CALL, ROOM, 'u', 'Андрей', 'четыре');

    expect(fourth).toEqual({ status: 'rejected', reason: 'too_many_pending' });
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/specialist-job.service.spec.ts'
```
Expected: FAIL — `Cannot find module './specialist-job.service'`.

- [ ] **Step 3: Реализовать сервис**

Create `src/voice-call/specialist-job.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import { AskResult, JOB_TIMEOUT_MS, MAX_PENDING_JOBS, SPECIALISTS } from './voice-call.types';

/**
 * Мост между быстрым голосовым ведущим и медленными профильными ассистентами.
 *
 * Весь смысл в том, что ask() не ждёт ответа: OpenAI Realtime исполняет тул
 * синхронно и держит разговор, пока тот не вернётся. Поэтому ask() пишет job,
 * отдаёт jobId и уходит, а ответ доставляется отдельным data-сообщением.
 */
@Injectable()
export class SpecialistJobService {
  private readonly logger = new Logger(SpecialistJobService.name);
  /** Незавершённые фоновые задачи — нужны только тестам, чтобы дождаться. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly pg: PgService,
    private readonly chat: ChatService,
    private readonly livekit: LiveKitClient,
  ) {}

  async ask(
    callId: string,
    roomName: string,
    userId: string,
    specialist: string,
    question: string,
  ): Promise<AskResult> {
    const agentId = SPECIALISTS[specialist];
    if (!agentId) return { status: 'rejected', reason: 'unknown_specialist' };

    const pending = await this.pg.query(
      `SELECT count(*) FROM voice_call_jobs WHERE call_id = $1 AND status IN ('queued','running')`,
      [callId],
    );
    if (Number(pending.rows[0]?.count ?? 0) >= MAX_PENDING_JOBS) {
      return { status: 'rejected', reason: 'too_many_pending' };
    }

    const jobId = randomUUID();
    await this.pg.query(
      `INSERT INTO voice_call_jobs (id, call_id, specialist_agent_id, question, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [jobId, callId, agentId, question],
    );

    // Фоновая часть. Промис намеренно не ждём.
    const task = this.run(jobId, callId, roomName, userId, specialist, agentId, question)
      .catch((e) => this.logger.error(`job ${jobId} crashed: ${e?.message}`))
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);

    return { status: 'asked', jobId, specialist };
  }

  private async run(
    jobId: string, callId: string, roomName: string, userId: string,
    specialist: string, agentId: number, question: string,
  ): Promise<void> {
    const started = Date.now();
    await this.pg.query(`UPDATE voice_call_jobs SET status = 'running' WHERE id = $1`, [jobId]);
    await this.safeSend(roomName, { v: 1, type: 'specialist_pending', jobId, specialist });

    try {
      // Изолированная эфемерная сессия обязательна: при коллизии с реальной
      // сессией пользователя релей отдаёт пустой поток — инцидент 2026-07-12,
      // см. quality-monitor.service.ts:probeOnce.
      const sessionId = `voice_${callId}_${jobId}`;
      const text = await this.withTimeout(
        this.chat.generateAgentReply(userId, String(agentId), question, sessionId),
        JOB_TIMEOUT_MS,
      );

      const answer = (text || '').trim();
      if (!answer) throw new Error('пустой ответ специалиста');

      await this.pg.query(
        `UPDATE voice_call_jobs SET status = 'done', answer = $1, finished_at = now(), latency_ms = $2 WHERE id = $3`,
        [answer, Date.now() - started, jobId],
      );
      await this.safeSend(roomName, { v: 1, type: 'specialist_answer', jobId, specialist, text: answer });
    } catch (e: any) {
      const reason = e?.message === 'timeout' ? 'timeout' : 'error';
      this.logger.warn(`job ${jobId} (${specialist}) failed: ${e?.message}`);
      await this.pg.query(
        `UPDATE voice_call_jobs SET status = 'failed', finished_at = now(), latency_ms = $1 WHERE id = $2`,
        [Date.now() - started, jobId],
      );
      await this.safeSend(roomName, { v: 1, type: 'specialist_failed', jobId, specialist, reason });
    }
  }

  /** Сбой доставки не должен ронять job: он уже записан в БД. */
  private async safeSend(roomName: string, msg: any): Promise<void> {
    try {
      await this.livekit.send(roomName, msg);
    } catch (e: any) {
      this.logger.warn(`sendData failed room=${roomName}: ${e?.message}`);
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Только для тестов: дождаться всех фоновых job. */
  async drainForTests(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/specialist-job.service.spec.ts'
```
Expected: PASS, 6 тестов.

- [ ] **Step 5: Commit**

```bash
git add src/voice-call/specialist-job.service.ts src/voice-call/specialist-job.service.spec.ts
git commit -m "feat(voice-call): асинхронный мост к профильным ассистентам

ask() отдаёт jobId за миллисекунды и не трогает LLM — иначе Realtime-сессия
висит в тишине, пока Opus думает. Ответ доставляется data-сообщением.
Каждый job идёт в изолированной сессии: при коллизии с сессией пользователя
релей отдаёт пустой поток (инцидент 2026-07-12)."
```

---

### Task 8: `VoiceCallService` — жизненный цикл звонка

**Files:**
- Create: `src/voice-call/voice-call.service.ts`, `src/voice-call/voice-call.service.spec.ts`

- [ ] **Step 1: Написать падающий тест на preamble и завершение**

Create `src/voice-call/voice-call.service.spec.ts`:

```typescript
import { VoiceCallService } from './voice-call.service';

function makeDeps(historyRows: any[] = []) {
  const inserted: any[] = [];
  const pg = {
    inserted,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM custom_chat_history/i.test(sql)) return { rows: historyRows, rowCount: historyRows.length };
      if (/INSERT INTO custom_chat_history/i.test(sql)) { inserted.push(params); return { rows: [], rowCount: 1 }; }
      if (/FROM voice_calls/i.test(sql)) {
        return { rows: [{ id: 'call-1', user_id: 'u1', room_name: 'room-1', started_at: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const chat = { generateAgentReply: jest.fn(async () => 'краткое резюме звонка') };
  const livekit = { userToken: jest.fn(async () => 'jwt-token'), dispatchAgent: jest.fn(async () => {}), send: jest.fn(async () => {}) };
  return { pg, chat, livekit };
}

describe('VoiceCallService', () => {
  it('на пустой истории preamble пустой', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    expect(await svc.buildPreamble('u1')).toBe('');
  });

  it('короткую историю отдаёт как есть, без похода в LLM', async () => {
    const d = makeDeps([
      { sender_type: 'human', content: 'привет' },
      { sender_type: 'ai', content: 'здравствуйте' },
    ]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const p = await svc.buildPreamble('u1');
    expect(p).toContain('привет');
    expect(p).toContain('здравствуйте');
    expect(d.chat.generateAgentReply).not.toHaveBeenCalled();
  });

  it('длинную историю сжимает через LLM', async () => {
    const long = Array.from({ length: 20 }, () => ({ sender_type: 'human', content: 'х'.repeat(300) }));
    const d = makeDeps(long);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const p = await svc.buildPreamble('u1');
    expect(d.chat.generateAgentReply).toHaveBeenCalled();
    expect(p).toBe('краткое резюме звонка');
  });

  it('start отдаёт токен и зовёт воркера', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const res = await svc.start('u1');
    expect(res.token).toBe('jwt-token');
    expect(res.roomName).toMatch(/^voice_/);
    expect(d.livekit.dispatchAgent).toHaveBeenCalledWith(res.roomName, expect.objectContaining({ callId: res.callId }));
  });

  it('complete пишет карточку в историю чата с тегом voice_call', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }, { role: 'assistant', text: 'здравствуйте', ts: 2 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });
    const card = d.pg.inserted.find((p) => String(p[2]).includes('{{voice_call:'));
    expect(card).toBeDefined();
    expect(String(card[2])).toContain('{{voice_call: id=call-1}}');
  });

  it('стоимость считается по ставкам аудио-токенов', () => {
    const svc = new VoiceCallService({} as any, {} as any, {} as any);
    // 600 in по $32/1M + 1200 out по $64/1M = 0.0192 + 0.0768 ... = 0.0960 центов
    expect(svc.costUsd(600, 1200)).toBeCloseTo(600 / 1e6 * 32 + 1200 / 1e6 * 64, 6);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/voice-call.service.spec.ts'
```
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать сервис**

Create `src/voice-call/voice-call.service.ts`:

```typescript
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import { CompletePayload, HOST_AGENT_ID, SPECIALISTS } from './voice-call.types';

/** Ставки OpenAI Realtime за 1M аудио-токенов, флагман. */
const AUDIO_IN_USD_PER_1M = 32;
const AUDIO_OUT_USD_PER_1M = 64;

const PREAMBLE_MSG_LIMIT = 20;
const PREAMBLE_CHAR_LIMIT = 4000;

@Injectable()
export class VoiceCallService {
  private readonly logger = new Logger(VoiceCallService.name);

  constructor(
    private readonly pg: PgService,
    private readonly chat: ChatService,
    private readonly livekit: LiveKitClient,
  ) {}

  /**
   * Контекст, с которым Роман входит в разговор: последние сообщения из чата
   * с ним же. Если их много — сжимаем, иначе съедим контекст Realtime-сессии,
   * а он и без того переотправляется на каждый ход.
   */
  async buildPreamble(userId: string): Promise<string> {
    const res = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [`${userId}_${HOST_AGENT_ID}`, PREAMBLE_MSG_LIMIT],
    );
    const rows = [...res.rows].reverse();
    if (!rows.length) return '';

    const flat = rows
      .map((r: any) => `${r.sender_type === 'human' ? 'Пользователь' : 'Роман'}: ${r.content}`)
      .join('\n');
    if (flat.length <= PREAMBLE_CHAR_LIMIT) return flat;

    const prompt =
      `Сожми переписку в один абзац до 1500 символов: о чём говорили, что решили, ` +
      `что осталось открытым. Только сам абзац, без вступлений.\n\n${flat}`;
    const short = await this.chat.generateAgentReply(
      userId, String(HOST_AGENT_ID), prompt, `voice_preamble_${randomUUID()}`,
    );
    return (short || '').trim().slice(0, 1500);
  }

  async start(userId: string): Promise<{ callId: string; roomName: string; token: string; wsUrl: string }> {
    const callId = randomUUID();
    const roomName = `voice_${callId}`;

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status) VALUES ($1, $2, $3, $4, 'dialing')`,
      [callId, userId, HOST_AGENT_ID, roomName],
    );

    const [token, preamble] = await Promise.all([
      this.livekit.userToken(roomName, `user_${userId}`),
      this.buildPreamble(userId),
    ]);

    await this.livekit.dispatchAgent(roomName, {
      callId,
      userId,
      preamble,
      specialists: Object.keys(SPECIALISTS),
      callbackUrl: `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/voice-call/internal`,
    });

    return { callId, roomName, token, wsUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || 'ws://localhost:7880' };
  }

  costUsd(audioIn: number, audioOut: number): number {
    return (audioIn / 1e6) * AUDIO_IN_USD_PER_1M + (audioOut / 1e6) * AUDIO_OUT_USD_PER_1M;
  }

  async complete(callId: string, payload: CompletePayload): Promise<void> {
    const call = await this.load(callId);
    const durationSec = Math.max(0, Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000));
    const cost = this.costUsd(payload.usage.audioInputTokens, payload.usage.audioOutputTokens);

    const summary = await this.summarize(call.user_id, payload.transcript);

    await this.pg.query(
      `UPDATE voice_calls SET status = 'completed', ended_at = now(), duration_sec = $1,
         transcript = $2, summary = $3, cost_usd = $4, model = $5 WHERE id = $6`,
      [durationSec, JSON.stringify(payload.transcript), summary, cost, payload.usage.model, callId],
    );

    // Карточка в ленте. Схема истории не меняется: это обычное сообщение,
    // фронт узнаёт его по тегу.
    const minutes = Math.max(1, Math.round(durationSec / 60));
    const content = `{{voice_call: id=${callId}}}\n\nРазговор ${minutes} мин.\n\n${summary}`;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
       VALUES ($1, 'ai', $2, $3, 'text', 0)`,
      [`${call.user_id}_${HOST_AGENT_ID}`, HOST_AGENT_ID, content],
    );

    // Учитываем, но не списываем: тариф назначать пока не из чего.
    await this.pg.query(
      `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume, metadata)
       VALUES ($1, $2, 'pending', $3, $4, $5, 0, $6)`,
      [
        Math.floor(Math.random() * 2_000_000_000), call.user_id, HOST_AGENT_ID,
        payload.usage.audioInputTokens, payload.usage.audioOutputTokens,
        JSON.stringify({ kind: 'voice_call', callId, costUsd: cost, durationSec, model: payload.usage.model }),
      ],
    );

    this.logger.log(`[complete] call=${callId} ${durationSec}s cost=$${cost.toFixed(4)}`);
  }

  async fail(callId: string, reason: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls SET status = 'failed', ended_at = now(), summary = $1, cost_usd = 0 WHERE id = $2`,
      [`Звонок не состоялся: ${reason}`, callId],
    );
  }

  async markInterrupted(callId: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls SET status = 'interrupted', ended_at = now() WHERE id = $1 AND status IN ('dialing','active')`,
      [callId],
    );
  }

  async load(callId: string): Promise<any> {
    const res = await this.pg.query(`SELECT * FROM voice_calls WHERE id = $1`, [callId]);
    if (!res.rows[0]) throw new NotFoundException('call not found');
    return res.rows[0];
  }

  private async summarize(userId: string, transcript: CompletePayload['transcript']): Promise<string> {
    if (!transcript?.length) return 'Разговор без реплик.';
    const flat = transcript.map((t) => `${t.role === 'user' ? 'Пользователь' : 'Роман'}: ${t.text}`).join('\n');
    const prompt =
      `Ниже расшифровка голосового разговора. Напиши краткое резюме: о чём говорили, ` +
      `какие решения приняты, что осталось сделать. До 800 символов, без вступлений.\n\n${flat}`;
    try {
      const s = await this.chat.generateAgentReply(userId, String(HOST_AGENT_ID), prompt, `voice_summary_${randomUUID()}`);
      return (s || '').trim() || 'Резюме не сформировано.';
    } catch (e: any) {
      this.logger.warn(`summarize failed: ${e?.message}`);
      return 'Резюме не сформировано.';
    }
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/voice-call.service.spec.ts'
```
Expected: PASS, 6 тестов.

- [ ] **Step 5: Commit**

```bash
git add src/voice-call/voice-call.service.ts src/voice-call/voice-call.service.spec.ts
git commit -m "feat(voice-call): жизненный цикл звонка, preamble, резюме, учёт стоимости"
```

---

### Task 9: Контроллеры и модуль

**Files:**
- Create: `src/voice-call/voice-call.controller.ts`, `src/voice-call/voice-call-internal.controller.ts`, `src/voice-call/voice-call.module.ts`, `src/voice-call/voice-call-internal.controller.spec.ts`
- Modify: `src/app.module.ts`, `src/main.ts`

- [ ] **Step 1: Написать падающий тест на гейты доступа**

Create `src/voice-call/voice-call-internal.controller.spec.ts`:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { VoiceCallInternalController } from './voice-call-internal.controller';
import { signBody } from './hmac';

describe('VoiceCallInternalController: доступ', () => {
  const SECRET = 'secret-for-tests';
  const body = { callId: 'call-1', specialist: 'Алексей', question: 'вопрос' };
  const raw = JSON.stringify(body);

  function makeCtl() {
    const jobs = { ask: jest.fn(async () => ({ status: 'asked', jobId: 'j1', specialist: 'Алексей' })) };
    const calls = { load: jest.fn(async () => ({ id: 'call-1', user_id: 'u1', room_name: 'room-1' })), complete: jest.fn(), fail: jest.fn() };
    return { ctl: new VoiceCallInternalController(jobs as any, calls as any), jobs, calls };
  }

  beforeEach(() => { process.env.VOICE_CALLBACK_SECRET = SECRET; });

  it('без подписи — 401', async () => {
    const { ctl } = makeCtl();
    await expect(ctl.ask('' as any, { rawBody: Buffer.from(raw) } as any, body as any))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('с чужой подписью — 401', async () => {
    const { ctl } = makeCtl();
    await expect(ctl.ask(signBody('wrong', raw), { rawBody: Buffer.from(raw) } as any, body as any))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('с верной подписью — проходит', async () => {
    const { ctl, jobs } = makeCtl();
    const res = await ctl.ask(signBody(SECRET, raw), { rawBody: Buffer.from(raw) } as any, body as any);
    expect(res).toMatchObject({ status: 'asked' });
    expect(jobs.ask).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call/voice-call-internal.controller.spec.ts'
```
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать внутренний контроллер**

Create `src/voice-call/voice-call-internal.controller.ts`:

```typescript
import { BadRequestException, Controller, Headers, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { SpecialistJobService } from './specialist-job.service';
import { VoiceCallService } from './voice-call.service';
import { verifyBody } from './hmac';
import { AskResult, CompletePayload } from './voice-call.types';

/**
 * Ручки, которые зовёт воркер linkeon-voice-host. Закрыты HMAC-подписью тела.
 *
 * Ровно та ошибка, из-за которой пришлось выпиливать dozvon: там аналогичная
 * ручка приёма записи не проверяла ничего. Здесь проверка обязательная, и без
 * секрета в окружении модуль не поднимается (см. voice-call.module.ts).
 */
@Controller('voice-call/internal')
export class VoiceCallInternalController {
  private readonly logger = new Logger(VoiceCallInternalController.name);

  constructor(
    private readonly jobs: SpecialistJobService,
    private readonly calls: VoiceCallService,
  ) {}

  /**
   * Тело здесь — Buffer, а не разобранный объект: на этот путь в main.ts
   * навешен сырой парсер. Проверяем подпись по байтам и разбираем сами.
   */
  private parseSigned<T>(req: Request, signature: string): T {
    const raw: Buffer | string = (req as any).body;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    if (!verifyBody(process.env.VOICE_CALLBACK_SECRET as string, text, signature)) {
      throw new UnauthorizedException('bad signature');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BadRequestException('malformed json');
    }
  }

  @Post('ask')
  async ask(
    @Headers('x-voice-signature') signature: string,
    @Req() req: Request,
  ): Promise<AskResult> {
    const body = this.parseSigned<{ callId: string; specialist: string; question: string }>(req, signature);
    const call = await this.calls.load(body.callId);
    return this.jobs.ask(body.callId, call.room_name, call.user_id, body.specialist, body.question);
  }

  @Post('complete')
  async complete(
    @Headers('x-voice-signature') signature: string,
    @Req() req: Request,
  ) {
    const body = this.parseSigned<{ callId: string } & CompletePayload>(req, signature);
    await this.calls.complete(body.callId, { transcript: body.transcript, usage: body.usage });
    return { ok: true };
  }

  @Post('failed')
  async failed(
    @Headers('x-voice-signature') signature: string,
    @Req() req: Request,
  ) {
    const body = this.parseSigned<{ callId: string; reason: string }>(req, signature);
    await this.calls.fail(body.callId, body.reason);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Реализовать публичный контроллер**

Create `src/voice-call/voice-call.controller.ts`:

```typescript
import { Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { VoiceCallService } from './voice-call.service';

@Controller('voice-call')
@UseGuards(JwtGuard)
export class VoiceCallController {
  constructor(private readonly calls: VoiceCallService) {}

  /**
   * v1 — только админы. Проверка серверная: скрытая кнопка на фронте это
   * удобство, а не защита.
   */
  @Post('start')
  async start(@CurrentUser() u: any) {
    if (!u?.isAdmin) throw new ForbiddenException('voice calls are admin-only in v1');
    return this.calls.start(u.userId);
  }

  @Post(':id/end')
  async end(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your call');
    await this.calls.markInterrupted(id);
    return { ok: true };
  }

  @Get(':id')
  async get(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your call');
    return call;
  }
}
```

- [ ] **Step 5: Собрать модуль с проверкой секрета на старте**

Create `src/voice-call/voice-call.module.ts`:

```typescript
import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ChatModule } from '../chat/chat.module';
import { VoiceCallController } from './voice-call.controller';
import { VoiceCallInternalController } from './voice-call-internal.controller';
import { VoiceCallService } from './voice-call.service';
import { SpecialistJobService } from './specialist-job.service';
import { LiveKitClient } from './livekit.client';

@Module({
  imports: [CommonModule, ChatModule],
  controllers: [VoiceCallController, VoiceCallInternalController],
  providers: [VoiceCallService, SpecialistJobService, LiveKitClient],
  exports: [VoiceCallService],
})
export class VoiceCallModule implements OnModuleInit {
  private readonly logger = new Logger(VoiceCallModule.name);

  onModuleInit(): void {
    // Без секрета внутренние ручки были бы открыты всему интернету.
    // Падаем на старте, а не отдаём дыру в прод.
    if (!process.env.VOICE_CALLBACK_SECRET) {
      throw new Error('VOICE_CALLBACK_SECRET не задан — VoiceCallModule не может стартовать');
    }
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      this.logger.warn('LIVEKIT_API_KEY/SECRET не заданы — звонки работать не будут');
    }
  }
}
```

- [ ] **Step 6: Включить сырое тело запроса и зарегистрировать модуль**

`rawBody: true` здесь **не сработает**: приложение создаётся как `NestFactory.create(AppModule, { bodyParser: false })`, парсеры навешиваются вручную, и опция Nest на них не влияет.

В проекте уже есть решение ровно этой задачи — коллбэк «Приёма» ([main.ts:16](../../src/main.ts#L16), [priem.controller.ts:91](../../src/payments/priem.controller.ts#L91)). Повторяем его.

В `src/main.ts`, рядом со строкой про `/webhook/priem/callback` и **обязательно до** глобального `bodyParser.json`:

```typescript
  // Внутренние ручки голосового звонка — сырым телом, как и коллбэк «Приёма»:
  // HMAC считается по пришедшим байтам, пересобранный JSON подпись не пройдёт.
  app.use('/webhook/voice-call/internal', bodyParser.raw({ type: '*/*', limit: '1mb' }));
```

В `src/app.module.ts` добавить импорт и запись в `imports`:

```typescript
import { VoiceCallModule } from './voice-call/voice-call.module';
```
```typescript
    VoiceCallModule,
```

- [ ] **Step 7: Прогнать тесты модуля целиком**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call && npx tsc --noEmit'
```
Expected: PASS — 3 файла тестов, 15 тестов; `tsc` без ошибок.

- [ ] **Step 8: Commit**

```bash
git add src/voice-call src/app.module.ts src/main.ts
git commit -m "feat(voice-call): контроллеры, гейт isAdmin, обязательный HMAC

Модуль не стартует без VOICE_CALLBACK_SECRET: открытая внутренняя ручка —
ровно та ошибка, из-за которой пришлось выпиливать dozvon."
```

---

### Task 10: Воркер `linkeon-voice-host`

Отдельный подпроект по образцу `worker/` (свой `package.json`, свой `tsconfig`, свой pm2-процесс).

**Files:**
- Create: `voice-host/package.json`, `voice-host/tsconfig.json`, `voice-host/ecosystem.config.js`, `voice-host/src/agent.ts`, `voice-host/src/backend.ts`, `voice-host/src/pending.ts`, `voice-host/.env.example`

- [ ] **Step 1: Завести подпроект**

Create `voice-host/package.json`:

```json
{
  "name": "linkeon-voice-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/agent.js start",
    "dev": "tsx src/agent.ts dev"
  },
  "dependencies": {
    "@livekit/agents": "^1.0.0",
    "@livekit/agents-plugin-openai": "^1.0.0",
    "@livekit/rtc-node": "^0.13.0",
    "dotenv": "^16.6.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

Create `voice-host/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `voice-host/.env.example`:

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
OPENAI_API_KEY=
BACKEND_URL=https://my.linkeon.io
VOICE_CALLBACK_SECRET=
VOICE_MODEL=gpt-realtime-2.1
VOICE_NAME=alloy
```

- [ ] **Step 2: Установить зависимости и свериться с реальным API SDK**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && pnpm install'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && ls node_modules/@livekit/agents/dist/*.d.ts && sed -n "1,60p" node_modules/@livekit/agents/README.md'
```

Код ниже написан под API `@livekit/agents` 1.x (`defineAgent`, `voice.AgentSession`, `llm.tool`, `cli.runApp`). **Сверить имена с установленной версией и поправить вызовы, если они разошлись** — подгонять через `as any` нельзя, лучше исправить под реальную сигнатуру.

- [ ] **Step 3: Клиент к бэкенду**

Create `voice-host/src/backend.ts`:

```typescript
import { createHmac } from 'node:crypto';

const BACKEND = process.env.BACKEND_URL || 'https://my.linkeon.io';
const SECRET = process.env.VOICE_CALLBACK_SECRET || '';

function sign(raw: string): string {
  return createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BACKEND}/webhook/voice-call/internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-voice-signature': sign(raw) },
    body: raw,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export type AskResult =
  | { status: 'asked'; jobId: string; specialist: string }
  | { status: 'rejected'; reason: string };

export const backend = {
  ask: (callId: string, specialist: string, question: string) =>
    post<AskResult>('ask', { callId, specialist, question }),

  complete: (callId: string, transcript: unknown[], usage: unknown) =>
    post<{ ok: true }>('complete', { callId, transcript, usage }),

  failed: (callId: string, reason: string) =>
    post<{ ok: true }>('failed', { callId, reason }),
};
```

- [ ] **Step 4: Буфер ответов, ждущих паузы**

Create `voice-host/src/pending.ts`:

```typescript
/**
 * Ответ специалиста нельзя вставлять, пока Роман говорит: он перебьёт сам себя
 * на полуслове. Копим и отдаём по сигналу «речь закончилась».
 */
export class PendingAnswers {
  private queue: string[] = [];
  private speaking = false;

  setSpeaking(v: boolean): void { this.speaking = v; }

  /** Вернёт текст, если вставлять можно прямо сейчас; иначе положит в очередь. */
  offer(text: string): string | null {
    if (this.speaking) { this.queue.push(text); return null; }
    return text;
  }

  /** Забрать накопленное — звать после окончания реплики. */
  drain(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get size(): number { return this.queue.length; }
}
```

- [ ] **Step 5: Точка входа воркера**

Create `voice-host/src/agent.ts`:

```typescript
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { cli, defineAgent, llm, voice, WorkerOptions, type JobContext } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomEvent } from '@livekit/rtc-node';
import { z } from 'zod';
import { backend } from './backend.js';
import { PendingAnswers } from './pending.js';

const TOPIC = 'linkeon';

function instructions(preamble: string, specialists: string[]): string {
  return [
    'Ты Роман — ведущий голосового разговора на платформе LINKEON.',
    'Говори по-русски, коротко, живой разговорной речью. Не зачитывай списки вслух.',
    '',
    `Ты можешь спросить коллег-специалистов: ${specialists.join(', ')}.`,
    'Инструмент ask_specialist ставит вопрос в работу и возвращается мгновенно —',
    'ответа в нём НЕТ. Получив подтверждение, скажи вслух, что отправил вопрос,',
    'и продолжай разговор: ответ придёт отдельно, и ты его озвучишь.',
    'Никогда не молчи в ожидании ответа.',
    '',
    preamble ? `Контекст прошлой переписки:\n${preamble}` : 'Прошлой переписки нет.',
  ].join('\n');
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const meta = JSON.parse(ctx.job.metadata || '{}') as {
      callId: string; userId: string; preamble: string; specialists: string[];
    };
    const pending = new PendingAnswers();
    const transcript: { role: 'user' | 'assistant'; text: string; ts: number }[] = [];
    let audioIn = 0;
    let audioOut = 0;

    await ctx.connect();

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: process.env.VOICE_MODEL || 'gpt-realtime-2.1',
        voice: process.env.VOICE_NAME || 'alloy',
      }),
    });

    const tools = {
      ask_specialist: llm.tool({
        description:
          'Поставить вопрос профильному специалисту. Возвращается сразу, БЕЗ ответа. ' +
          'Ответ придёт позже, и ты озвучишь его сам.',
        parameters: z.object({
          specialist: z.string().describe('Имя специалиста'),
          question: z.string().describe('Вопрос целиком, со всем нужным контекстом'),
        }),
        execute: async ({ specialist, question }) => {
          const r = await backend.ask(meta.callId, specialist, question);
          return r.status === 'asked'
            ? { status: 'asked', specialist }
            : { status: 'rejected', reason: r.reason };
        },
      }),
      list_specialists: llm.tool({
        description: 'Список доступных специалистов.',
        parameters: z.object({}),
        execute: async () => ({ specialists: meta.specialists }),
      }),
    };
    // Тулов ровно два. Третий из ранней редакции спеки (save_note) снят:
    // в голосовом разговоре он дублирует резюме звонка, а каждый лишний тул —
    // лишний повод модели уйти не туда. Ручка POST /webhook/notes существует
    // (коммит f8097a7), так что вернуть его при надобности дёшево.

    // Ответы специалистов приходят из бэкенда через data-канал комнаты.
    ctx.room.on(RoomEvent.DataReceived, (payload: Uint8Array, _p, _k, topic?: string) => {
      if (topic !== TOPIC) return;
      let msg: any;
      try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }

      if (msg.type === 'specialist_answer') {
        const line = `[Внутреннее сообщение от коллеги ${msg.specialist}]: ${msg.text}`;
        const now = pending.offer(line);
        if (now) void session.generateReply({ userInput: now });
      } else if (msg.type === 'specialist_failed') {
        const line = `[Внутреннее сообщение: ${msg.specialist} не ответил (${msg.reason}). Извинись и ответь сам.]`;
        const now = pending.offer(line);
        if (now) void session.generateReply({ userInput: now });
      }
    });

    session.on('agent_state_changed', (ev: any) => {
      const speaking = ev?.newState === 'speaking';
      pending.setSpeaking(speaking);
      if (!speaking) {
        for (const line of pending.drain()) void session.generateReply({ userInput: line });
      }
    });

    session.on('conversation_item_added', (ev: any) => {
      const role = ev?.item?.role === 'user' ? 'user' : 'assistant';
      const text = ev?.item?.textContent ?? '';
      if (text) transcript.push({ role, text, ts: Date.now() });
    });

    session.on('metrics_collected', (ev: any) => {
      audioIn += ev?.metrics?.inputAudioTokens ?? 0;
      audioOut += ev?.metrics?.outputAudioTokens ?? 0;
    });

    // Потолок Realtime-сессии — 60 минут, дальше прилетает session_expired и
    // сокет закрывается. Graceful-миграции контекста у OpenAI нет, поэтому
    // единственное, что мы можем дать пользователю, — предупредить заранее
    // и дать Роману подвести итог, а не оборваться на полуслове.
    const SESSION_LIMIT_MS = 60 * 60 * 1000;
    const warnAt = setTimeout(() => {
      void session.generateReply({
        userInput: '[Внутреннее сообщение: до конца звонка минута. Подведи короткий итог и попрощайся.]',
      });
    }, SESSION_LIMIT_MS - 60_000);

    const hardStop = setTimeout(() => {
      void backend.failed(meta.callId, 'session_expired').catch(() => {});
    }, SESSION_LIMIT_MS);

    // Один shutdown-колбэк на всё: таймеры и отправка итогов.
    ctx.addShutdownCallback(async () => {
      clearTimeout(warnAt);
      clearTimeout(hardStop);
      try {
        await backend.complete(meta.callId, transcript, {
          audioInputTokens: audioIn,
          audioOutputTokens: audioOut,
          model: process.env.VOICE_MODEL || 'gpt-realtime-2.1',
        });
      } catch (e) {
        console.error('complete callback failed', e);
      }
    });

    try {
      await session.start({
        agent: new voice.Agent({ instructions: instructions(meta.preamble, meta.specialists), tools }),
        room: ctx.room,
      });
    } catch (e: any) {
      await backend.failed(meta.callId, e?.message || 'session start failed');
      throw e;
    }
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'linkeon-voice-host',
    // realtime-прокси нечего прогревать; дефолт min(cores,4) держит лишние
    // процессы впустую
    numIdleProcesses: 1,
  }),
);
```

- [ ] **Step 6: Собрать воркер**

Run:
```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && pnpm build'
```
Expected: `dist/agent.js` создан, ошибок компиляции нет. Если SDK разошёлся с кодом — править под реальные сигнатуры (шаг 2).

- [ ] **Step 7: pm2-конфиг**

Create `voice-host/ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'linkeon-voice-host',
      cwd: __dirname,
      script: 'dist/agent.js',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      // Драйн: воркер должен успеть довести живые звонки и отправить
      // complete-коллбэки. Рестарт посреди разговора убивает ответ молча.
      kill_timeout: 600000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

- [ ] **Step 8: Commit**

```bash
git add voice-host
git commit -m "feat(voice-host): воркер LiveKit Agents с OpenAI Realtime

Тул ask_specialist возвращается мгновенно и явно говорит модели, что ответа
в нём нет. Ответы специалистов приезжают data-каналом и вставляются только
в паузу — иначе Роман перебивает сам себя на полуслове."
```

---

### Task 11: Фронт — карточка звонка в ленте

**Files:**
- Modify: `src/utils/customMarkdown.tsx` (репозиторий `spirits_front`)
- Modify: `src/utils/customMarkdown.test.ts`

- [ ] **Step 1: Написать падающий тест**

Дописать в `src/utils/customMarkdown.test.ts`:

```typescript
describe('parseCustomMarkdown: карточка голосового звонка', () => {
  const ID = 'caa29d32-f925-43ae-9d73-98ef88ba1b5c';

  it('вытаскивает id звонка и подменяет тег маркером', () => {
    const { content, voiceCalls } = parseCustomMarkdown(`{{voice_call: id=${ID}}}\n\nРазговор 12 мин.`);
    expect(voiceCalls.size).toBe(1);
    expect([...voiceCalls.values()][0]).toBe(ID);
    expect(content).not.toContain('{{voice_call');
    expect(content).toContain('Разговор 12 мин.');
  });

  it('текст без тега не трогает', () => {
    const { voiceCalls } = parseCustomMarkdown('обычное сообщение про voice_call');
    expect(voiceCalls.size).toBe(0);
  });

  it('кривой id не считает карточкой', () => {
    const { voiceCalls } = parseCustomMarkdown('{{voice_call: id=не-uuid}}');
    expect(voiceCalls.size).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run:
```bash
cd ~/Downloads/spirits_front && npx vitest run src/utils/customMarkdown.test.ts
```
Expected: FAIL — `voiceCalls` не существует в результате `parseCustomMarkdown`.

- [ ] **Step 3: Реализовать**

В `src/utils/customMarkdown.tsx` рядом с `AUDIO_CLIP_REGEX` (строка 38) добавить:

```typescript
const VOICE_CALL_REGEX = /\{\{voice_call:\s*id=([a-f0-9-]{36})\}\}/g;
```

В интерфейс результата (рядом с `audioClips: Map<string, string>;`, строка 53) добавить:

```typescript
  voiceCalls: Map<string, string>;
```

Рядом с `const audioClips = new Map<string, string>();` (строка 63):

```typescript
  const voiceCalls = new Map<string, string>();
```

Рядом с блоком `AUDIO_CLIP_REGEX` (строка 115):

```typescript
  parsedContent = parsedContent.replace(VOICE_CALL_REGEX, (_match, callId) => {
    const key = `voicecall_${callId}`;
    voiceCalls.set(key, callId);
    return `__VOICECALL_${key}__`;
  });
```

В `return` (строка 133) добавить `voiceCalls` в объект.

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run:
```bash
cd ~/Downloads/spirits_front && npx vitest run src/utils/customMarkdown.test.ts
```
Expected: PASS, все тесты файла включая три новых.

- [ ] **Step 5: Commit**

```bash
cd ~/Downloads/spirits_front
git add src/utils/customMarkdown.tsx src/utils/customMarkdown.test.ts
git commit -m "feat(chat): тег {{voice_call:id=…}} для карточки звонка"
```

---

### Task 12: Фронт — хук звонка

**Files:**
- Create: `src/components/chat/useVoiceCall.ts` (репозиторий `spirits_front`)

- [ ] **Step 1: Поставить клиент LiveKit**

Run:
```bash
cd ~/Downloads/spirits_front && pnpm add livekit-client
```
Expected: `livekit-client` в `dependencies`.

- [ ] **Step 2: Реализовать хук**

Create `src/components/chat/useVoiceCall.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { apiClient } from '../../services/apiClient';

export type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export interface ThinkingSpecialist {
  jobId: string;
  specialist: string;
}

/**
 * Звонок Роману. Комната LiveKit, воркер уже в ней; наше дело — отдать
 * микрофон, играть входящий звук и показывать, кого Роман сейчас спрашивает.
 */
export function useVoiceCall() {
  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState<ThinkingSpecialist[]>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);

  const hangUp = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) { try { await room.disconnect(); } catch { /* уже отключились */ } }
    if (callId) { try { await apiClient.post(`/webhook/voice-call/${callId}/end`); } catch { /* best-effort */ } }
    setState('ended');
    setThinking([]);
  }, [callId]);

  const start = useCallback(async () => {
    setState('connecting');
    setError(null);
    try {
      const res = await apiClient.post('/webhook/voice-call/start');
      if (!res.ok) throw new Error(res.status === 403 ? 'Звонки пока доступны только админам' : `Ошибка ${res.status}`);
      const { callId: id, token, wsUrl } = await res.json();
      setCallId(id);

      const room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) track.attach();
      });

      room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
        if (topic !== 'linkeon') return;
        let msg: any;
        try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
        if (msg.type === 'specialist_pending') {
          setThinking((prev) => [...prev, { jobId: msg.jobId, specialist: msg.specialist }]);
        } else if (msg.type === 'specialist_answer' || msg.type === 'specialist_failed') {
          setThinking((prev) => prev.filter((t) => t.jobId !== msg.jobId));
        }
      });

      room.on(RoomEvent.Disconnected, () => { setState('ended'); setThinking([]); });

      await room.connect(wsUrl, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setState('active');
    } catch (e: any) {
      setError(e?.message || 'Не удалось соединиться');
      setState('error');
      roomRef.current = null;
    }
  }, []);

  // Уходя со страницы, кладём трубку: иначе комната живёт до таймаута воркера.
  useEffect(() => () => { void roomRef.current?.disconnect(); }, []);

  return { state, error, thinking, callId, start, hangUp };
}
```

- [ ] **Step 3: Проверить сборку**

Run:
```bash
cd ~/Downloads/spirits_front && npx tsc --noEmit
```
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/useVoiceCall.ts package.json pnpm-lock.yaml
git commit -m "feat(chat): хук голосового звонка на livekit-client"
```

---

### Task 13: Фронт — модалка и кнопка

**Files:**
- Create: `src/components/chat/VoiceCallModal.tsx`
- Modify: `src/components/chat/ChatInterface.tsx:2143,2275`
- Modify: `src/i18n/locales/ru.json`, `en.json`

- [ ] **Step 1: Модалка**

Create `src/components/chat/VoiceCallModal.tsx`:

```tsx
import { PhoneOff, Loader2, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVoiceCall } from './useVoiceCall';

interface Props {
  assistantName: string;
  onClose: () => void;
}

export function VoiceCallModal({ assistantName, onClose }: Props) {
  const { t } = useTranslation();
  const { state, error, thinking, start, hangUp } = useVoiceCall();

  const close = async () => { await hangUp(); onClose(); };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6 text-center">
        <h3 className="text-lg font-semibold mb-1">{assistantName}</h3>

        <p className="text-sm text-gray-500 mb-6">
          {state === 'idle' && t('voice_call.ready')}
          {state === 'connecting' && t('voice_call.connecting')}
          {state === 'active' && t('voice_call.active')}
          {state === 'ended' && t('voice_call.ended')}
          {state === 'error' && (error || t('voice_call.error'))}
        </p>

        {thinking.length > 0 && (
          <div className="mb-4 space-y-1">
            {thinking.map((tk) => (
              <div key={tk.jobId} className="flex items-center justify-center gap-2 text-xs text-forest-700">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t('voice_call.specialist_thinking', { name: tk.specialist })}
              </div>
            ))}
          </div>
        )}

        {state === 'idle' || state === 'error' ? (
          <button
            onClick={start}
            data-testid="voice-call-start"
            className="w-full py-3 rounded-xl bg-forest-600 text-white font-medium hover:bg-forest-700 flex items-center justify-center gap-2"
          >
            <Mic className="w-4 h-4" />
            {t('voice_call.start')}
          </button>
        ) : (
          <button
            onClick={close}
            data-testid="voice-call-hangup"
            className="w-full py-3 rounded-xl bg-red-600 text-white font-medium hover:bg-red-700 flex items-center justify-center gap-2"
          >
            <PhoneOff className="w-4 h-4" />
            {t('voice_call.hang_up')}
          </button>
        )}

        <button onClick={close} className="mt-3 text-xs text-gray-400 hover:text-gray-600">
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Строки локализации**

В `src/i18n/locales/ru.json` добавить блок:

```json
  "voice_call": {
    "start": "Позвонить",
    "ready": "Готов к разговору",
    "connecting": "Соединяем…",
    "active": "Разговор идёт",
    "ended": "Звонок завершён",
    "error": "Не удалось соединиться",
    "hang_up": "Положить трубку",
    "specialist_thinking": "{{name}} думает…",
    "button_title": "Позвонить ассистенту голосом"
  },
```

В `en.json` тот же блок с английскими строками:

```json
  "voice_call": {
    "start": "Call",
    "ready": "Ready to talk",
    "connecting": "Connecting…",
    "active": "Call in progress",
    "ended": "Call ended",
    "error": "Could not connect",
    "hang_up": "Hang up",
    "specialist_thinking": "{{name}} is thinking…",
    "button_title": "Call the assistant by voice"
  },
```

Остальные локали (`de`, `es`, `fr`, `zh`, `pt`) — тот же блок. Непереведённый ключ уезжает русским текстом в чужую локаль, а не падает, поэтому пропускать нельзя.

- [ ] **Step 3: Кнопка в шапке чата**

В `src/components/chat/ChatInterface.tsx` рядом с `renderFreshToggle` (строка 2065) добавить:

```tsx
  // Кнопка живёт там же, где тумблер «Чистый лист»: на десктопе с подписью,
  // на мобиле иконкой. Видна только админам и только в чате Романа —
  // серверная проверка всё равно своя, это чтобы не мозолила глаза.
  const renderCallButton = (testId: string, wrapperClass: string) => (
    isAdmin && selectedAssistant?.id === 12 ? (
      <button
        onClick={() => setShowVoiceCall(true)}
        data-testid={testId}
        className={clsx(
          'items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors',
          'border-gray-200 text-gray-500 hover:text-forest-700 hover:border-forest-300',
          wrapperClass,
        )}
        title={t('voice_call.button_title')}
        aria-label={t('voice_call.start')}
      >
        <Phone className="w-4 h-4" />
        <span className="hidden md:inline text-xs font-medium">{t('voice_call.start')}</span>
      </button>
    ) : null
  );
```

Рядом с объявлением `freshTs` (строка 519) добавить состояние:

```tsx
  const [showVoiceCall, setShowVoiceCall] = useState(false);
```

`isAdmin` берётся из `useAuth()` — если хука в компоненте ещё нет, добавить `const { isAdmin } = useAuth();` рядом с остальными хуками. Импорты: `Phone` из `lucide-react`, `VoiceCallModal` из `./VoiceCallModal`.

Вызвать рядом с обоими вызовами тумблера — строка 2143 и строка 2275:

```tsx
                {renderCallButton('voice-call-btn-mobile', 'flex md:hidden')}
```
```tsx
            {renderCallButton('voice-call-btn', 'hidden md:flex')}
```

И отрисовать модалку рядом с `{showTokenPackages && …}` (строка 2088):

```tsx
      {showVoiceCall && selectedAssistant && (
        <VoiceCallModal
          assistantName={selectedAssistant.displayName ?? selectedAssistant.name}
          onClose={() => setShowVoiceCall(false)}
        />
      )}
```

- [ ] **Step 4: Проверить сборку и линт**

Run:
```bash
cd ~/Downloads/spirits_front && npx tsc --noEmit && pnpm lint
```
Expected: без ошибок.

- [ ] **Step 5: Проверить, что ничего не сломалось в существующих тестах**

Run:
```bash
cd ~/Downloads/spirits_front && npx vitest run
```
Expected: то же число проходящих тестов, что и до изменений, плюс три новых.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/VoiceCallModal.tsx src/components/chat/ChatInterface.tsx src/i18n/locales
git commit -m "feat(chat): кнопка «Позвонить» и модалка голосового звонка"
```

---

### Task 14: Развёртывание и ручная проверка

**Files:**
- Modify: `scripts/deploy.sh` (репозиторий `spirits_back`)

- [ ] **Step 1: Прописать переменные окружения на проде и тесте**

На обоих серверах в `.env` бэкенда:

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_WS_URL=wss://my.linkeon.io/livekit
LIVEKIT_API_KEY=voicecall<...>
LIVEKIT_API_SECRET=<...>
VOICE_CALLBACK_SECRET=<длинная случайная строка>
VOICE_AGENT_NAME=linkeon-voice-host
```

В `voice-host/.env` — те же `LIVEKIT_*`, плюс `OPENAI_API_KEY`, `BACKEND_URL`, `VOICE_CALLBACK_SECRET` (тот же, что у бэкенда).

Ключ `voicecall*` добавить в секцию `keys:` файла `~/livekit-dozvon/livekit.yaml` и перезапустить контейнер по процедуре из `infra/livekit/README.md`.

- [x] **Step 2: Проброс WSS через nginx — НЕ ТРЕБУЕТСЯ**

Проверено 25.08.2026: в конфиге `spirits` уже есть рабочий проброс, заведённый
когда-то под dozvon и переживший удаление модуля:

```nginx
location /livekit-dozvon/ {
    proxy_pass http://127.0.0.1:7880/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

Снаружи отвечает: `https://my.linkeon.io/livekit-dozvon/` → `200 OK`,
`/livekit-dozvon/rtc/validate` → `401` (LiveKit требует токен — значит проброс
доходит до него). `proxy_read_timeout 86400` с большим запасом на часовой звонок.

Поэтому nginx не трогаем вообще, а в `.env` ставим существующий путь:
`LIVEKIT_WS_URL=wss://my.linkeon.io/livekit-dozvon`. Имя пути историческое и
к удалённому модулю отношения больше не имеет — переименование потребовало бы
правки прод-nginx ради косметики.

**Файрвол:** `ufw` неактивен, DROP-правил по UDP в iptables нет — медиа-диапазон
50000–60000 не заблокирован. Отсутствие слушающих UDP-сокетов в простое нормально:
в режиме port-range LiveKit выделяет порт под соединение.

- [ ] **Step 3: Добавить воркер в деплой**

В `scripts/deploy.sh` рядом с блоком сборки `worker/` добавить сборку и перезапуск `voice-host`, и **проверку живых звонков перед рестартом**:

```bash
# Голосовой воркер. Рестарт посреди разговора убивает ответ молча —
# ни ошибки, ни ретрая, ни строки в истории.
ACTIVE=$(ssh "$HOST" "psql \"\$DATABASE_URL\" -tAc \"SELECT count(*) FROM voice_calls WHERE status IN ('dialing','active')\"" 2>/dev/null || echo 0)
if [ "${ACTIVE:-0}" -gt 0 ]; then
  echo "⚠️  Активных голосовых звонков: $ACTIVE. Рестарт voice-host отложен."
else
  ssh "$HOST" "cd $APP_DIR/voice-host && pnpm install --prod=false && pnpm build && pm2 startOrReload ecosystem.config.js"
fi
```

- [ ] **Step 4: Выкатить**

Только после явного согласия владельца — деплой идёт на прод:

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Скрипт сам катит `test.linkeon.io` → smoke → прод → smoke. Флаги не добавлять.

- [ ] **Step 5: Проверить, что воркер поднялся и зарегистрировался**

Run:
```bash
ssh dvolkov@212.113.106.202 'pm2 list --no-color | grep voice-host && pm2 logs linkeon-voice-host --lines 30 --nostream'
```
Expected: статус `online`, в логах строка о регистрации воркера на LiveKit-сервере. Если воркер не видит LiveKit — проверить `LIVEKIT_API_KEY` в `voice-host/.env` против секции `keys:` в `livekit.yaml`.

- [ ] **Step 6: Ручной чек-лист**

Пройти под админским аккаунтом `79030169187` в чате Романа. Отмечать каждый пункт:

1. Кнопка «Позвонить» видна в шапке; под не-админом её нет.
2. `POST /webhook/voice-call/start` из-под не-админа отдаёт `403` (проверить curl'ом, не только по кнопке).
3. Звонок соединяется, Роман здоровается и помнит контекст прошлой переписки.
4. «Спроси Алексея, законно ли …» → Роман **вслух** говорит, что отправил вопрос, и **продолжает разговор**, а не молчит.
5. Плашка «Алексей думает…» появляется и исчезает по приходу ответа.
6. Роман озвучивает ответ Алексея, не перебивая сам себя на полуслове.
7. Два вопроса разным специалистам одновременно — оба ответа приходят и озвучиваются.
8. Четвёртый параллельный вопрос — Роман говорит, что вопросов уже слишком много.
9. Перебить Романа голосом посреди его реплики — он замолкает и слушает.
10. Разговор длиной 25 минут — реконнект на 20-й минуте проходит незаметно.
11. Обрыв сети (выключить Wi-Fi) — модалка показывает завершение, запись в БД `interrupted`.
12. Положить трубку → в чате появляется карточка с длительностью и резюме.
13. `SELECT cost_usd, duration_sec FROM voice_calls ORDER BY started_at DESC LIMIT 1` — стоимость посчитана и ненулевая.

- [ ] **Step 7: Снять первые метрики**

Run:
```bash
ssh dvolkov@212.113.106.202 "psql \"\$DATABASE_URL\" -c \"
  SELECT duration_sec, cost_usd, model,
         round(cost_usd / GREATEST(duration_sec,1) * 60, 4) AS usd_per_min
  FROM voice_calls WHERE status = 'completed' ORDER BY started_at DESC LIMIT 10\""
ssh dvolkov@212.113.106.202 "psql \"\$DATABASE_URL\" -c \"
  SELECT specialist_agent_id, status, round(avg(latency_ms)) AS avg_ms, count(*)
  FROM voice_call_jobs GROUP BY 1,2 ORDER BY 1\""
```

Плюс то, что в БД не попадает и снимается с хоста во время звонка:

```bash
# RSS и CPU job-процесса воркера
ssh dvolkov@212.113.106.202 'ps -o pid,rss,pcpu,etime,cmd -C node | grep -i voice'
# Тип ICE-кандидата — доля relay (TURN) под РФ и мобильных операторов
# смотрится в браузере: chrome://webrtc-internals, поле candidate-pair → remote candidateType
```

Time-to-first-audio замерять по логам воркера: разница между строкой о входе в комнату и первым `agent_state_changed → speaking`.

Публичного бенчмарка для нашей формы нагрузки не существует — эти цифры и есть единственный источник правды для планирования рунгов 50 и 500. Записать их в спеку отдельным разделом «Замеры v1».

- [ ] **Step 8: Commit**

```bash
git add scripts/deploy.sh
git commit -m "chore(deploy): сборка voice-host с проверкой активных звонков"
```

---

## Порядок и зависимости

Task 1–2 независимы и могут идти параллельно. Task 3 → 4 → 5 → 6 → 7 → 8 → 9 строго последовательны (бэкенд). Task 10 (воркер) зависит от 9. Task 11–13 (фронт) зависят только от контракта из Task 5 и могут идти параллельно с 6–10. Task 14 — последний.

Первая точка, где что-то можно потрогать руками без голоса: после Task 9 внутренние ручки проверяются curl'ом с ручной HMAC-подписью.
