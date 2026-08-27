# Ассистент во встрече Linkeon — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь создаёт голосовую встречу в Linkeon, зовёт людей ссылкой, а ассистента — той же ссылкой в чат. Ассистент входит участником, молчит пока не позовут по имени, по окончании кладёт в ленту резюме.

**Architecture:** Встреча — это комната в нашем собственном LiveKit. Гости входят по публичной ссылке, ассистент — тем же `dispatchAgent`, каким сегодня заходит в звонок. Одна комната, никакого моста между комнатами.

**Tech Stack:** NestJS 10 + Postgres + Redis (бэкенд), `@livekit/agents` 1.7 + OpenAI Realtime mini (воркер), React 18 + `livekit-client` + i18next (фронт), pm2.

**Спека:** `docs/superpowers/specs/2026-08-27-linkeon-meeting-rooms-design.md` — читать целиком перед началом.

**Отменено:** `2026-08-27-meeting-bridge-talerid.md` — план моста в комнаты Taler ID. Владелец 27.08 решил идти своим путём. Оттуда переиспользованы гейт по имени, правила присутствия, промпты и карточка в чате.

---

## Решения, принятые при написании плана

Спека их не фиксировала, реализация без них невозможна.

1. **Ссылка на комнату в чате замыкает ход**: показываем карточку «Зайти» и в модель не идём. Иначе за каждую вставленную ссылку платим ход LLM и получаем два ответа. Прецеденты в коде: `chat.service.ts:643-658` и `:466-468`.
2. **Код комнаты — 6 символов из алфавита без двусмысленных знаков** (`0/O`, `1/I/l` исключены). Встречу диктуют по телефону. 32⁶ ≈ 10⁹ комбинаций, перебор закрывается ограничением частоты.
3. **Ограничение частоты — в Redis**, он уже в стеке (прод: порт 6380). Публичные ручки без него — это перебор кода из шести символов.
4. **Страница комнаты — маршрут в существующем React-приложении**, а не отдельный статический файл. Публичные маршруты в `App.tsx` уже есть, `/tokens` работает без авторизации.

---

## Структура файлов

**Бэкенд** (`~/Downloads/spirits_back/src/`):

| Файл | Ответственность |
|---|---|
| `meeting/room-code.ts` | Генерация и проверка кода комнаты. Чистая функция |
| `meeting/room-code.spec.ts` | Тесты кода |
| `meeting/meeting-link.ts` | Разбор ссылки на комнату Linkeon в тексте |
| `meeting/meeting-link.spec.ts` | Тесты разбора |
| `meeting/room.service.ts` | Создание комнаты, выдача токена гостю, закрытие |
| `meeting/room.service.spec.ts` | Тесты сервиса комнат |
| `meeting/room.controller.ts` | `POST /webhook/room`, публичные `GET/POST /webhook/room/public/:code` |
| `meeting/room-rate-limit.ts` | Ограничение частоты по коду и IP |
| `meeting/room-rate-limit.spec.ts` | Тесты ограничения |
| `meeting/meeting.service.ts` | Вход ассистента: запись в `voice_calls`, dispatch, выход |
| `meeting/meeting.service.spec.ts` | Тесты входа |
| `meeting/meeting.controller.ts` | `POST /webhook/meeting/join`, `POST /webhook/meeting/:id/leave` |
| `meeting/meeting.module.ts` | Регистрация |
| `meeting/migrations/001_meeting_rooms.sql` | `meeting_rooms` + колонки в `voice_calls` |
| `voice-call/voice-call.service.ts` | Параметризация `buildPreamble`, имена в резюме (правка) |
| `voice-call/voice-call.types.ts` | Провайдеры (правка) |
| `voice-call/voice-call-reaper.service.ts` | Отдельный порог для встреч (правка) |
| `chat/meeting-card.ts` | Сборка тега карточки |
| `chat/meeting-card.spec.ts` | Тесты сборки |
| `chat/chat.service.ts` | Короткое замыкание хода на карточку (правка, ~строка 483) |

**Воркер** (`~/Downloads/spirits_back/voice-host/src/`):

| Файл | Ответственность |
|---|---|
| `name-gate.ts` | Обращались ли по имени, режим слушателя, окно продолжения |
| `name-gate.test.ts` | Тесты гейта |
| `occupancy.ts` | Кто живой в комнате, когда выходить |
| `occupancy.test.ts` | Тесты присутствия |
| `prompts.ts` | Инструкции звонка и встречи |
| `agent.ts` | Режим встречи (правка) |

**Фронт** (`~/Downloads/spirits_front/src/`):

| Файл | Ответственность |
|---|---|
| `pages/RoomPage.tsx` | Публичная страница комнаты `/room/:code` |
| `components/room/JoinForm.tsx` | Ввод имени и запрос микрофона |
| `components/room/RoomStage.tsx` | Список участников, подсветка говорящего, микрофон, выход |
| `components/room/useRoom.ts` | Подключение `livekit-client`, состояние комнаты |
| `components/chat/MeetingJoinCard.tsx` | Карточка «Зайти во встречу» |
| `components/chat/MeetingStatusBar.tsx` | Плашка «ассистент на встрече» |
| `components/chat/CreateMeetingButton.tsx` | Создание встречи и показ ссылки |
| `utils/customMarkdown.tsx` | Тег `{{meeting_join:…}}` (правка) |
| `components/chat/ChatInterface.tsx` | Подключение карточки и плашки (правка) |
| `components/chat/VoiceCallCard.tsx` | Имена говорящих в расшифровке (правка) |
| `App.tsx` | Публичный маршрут `/room/:code` (правка) |
| `i18n/locales/{ru,en,es,de,fr,pt,zh}.json` | Строки (правка) |

---

## Где что запускать

**Тесты и сборки — на тестовой ноде, не на маке** (`CLAUDE.md`, «Сборки и тесты»).

```bash
git push -u origin <ветка>
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q <sha>'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npm ci && npx jest src/meeting --silent'
```

`source ~/.nvm/nvm.sh` обязателен в каждой ssh-команде. Работать только в `~/ci/`, никогда в `~/spirits_back` — оттуда работает живой API `test.linkeon.io`.

**`npm test` красный и без наших правок** (jest скребёт `.worktrees/`, два теста падают на `main`). Мерить дельтой: `npx jest src/meeting`, `npx jest src/chat`, `npx jest src/voice-call`.

Воркер — `node --test` внутри `voice-host/`, там ESM и свой `package.json`.

---

## Task 1: Спайк — снять два риска до того, как писать всё остальное

> **Выполнено статически 27.08.2026.** Оба риска сняты по типам SDK, см. «Результаты
> спайка» в конце файла. Коротко: `create_response` есть — гейт жизнеспособен;
> `AgentSession` слышит **ровно одного** участника, поэтому нужен свой микшер, но
> подключается он не мостом, а через сеттер `session.input.audio` (Task 8а).
>
> Живьём остались Steps 2–4: состязание с `RoomIO`, поддержка `create_response` именно у
> mini и звучание голоса на mini. Они требуют комнаты с двумя говорящими людьми — делать
> после Task 12, на первой живой комнате.

От первого зависит, есть ли в проекте микшер вообще.

**Files:**
- Create: `voice-host/src/spike/spike.ts` (временный, удаляется в конце задачи)

- [ ] **Step 1: Проверить, слышит ли `AgentSession` нескольких участников**

```typescript
// voice-host/src/spike/spike.ts
import 'dotenv/config';
import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { Room, RoomEvent } from '@livekit/rtc-node';

const room = new Room();
await room.connect(process.env.LIVEKIT_URL!, process.env.SPIKE_TOKEN!, { autoSubscribe: true });
console.log('участников в комнате:', room.remoteParticipants.size);

room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
  console.log('говорят:', speakers.map((s) => s.name || s.identity));
});

const session = new voice.AgentSession({
  // Именно mini: на нём поедут встречи. Набор голосов и поддержка
  // turnDetection у моделей могут отличаться, проверять надо ту, что поедет.
  llm: new openai.realtime.RealtimeModel({ model: 'gpt-realtime-2.1-mini', voice: 'cedar' }),
});

await session.start({
  agent: new voice.Agent({ instructions: 'Отвечай ПО-РУССКИ одной короткой фразой.' }),
  room,
});
```

- [ ] **Step 2: Запустить и проверить с ДВУМЯ живыми участниками**

Токен выпустить локальным скриптом через `livekit-server-sdk` (он в зависимостях бэкенда). Открыть комнату в двух вкладках браузера, говорить по очереди и одновременно.

Run: `cd voice-host && npx tsx src/spike/spike.ts`

Expected, и проверять надо всё три:
1. Ассистент реагирует на речь **обоих** участников, а не только первого вошедшего.
2. `ActiveSpeakersChanged` печатает имена и меняется при смене говорящего.
3. При одновременной речи ассистент не глохнет.

**Если реагирует только на одного:** сведение дорожек в один поток придётся делать внутри воркера — подписываться на всех, микшировать тиками по 20 мс и отдавать `AgentSession` одну дорожку. Это отдельная задача на день; записать вывод и согласовать с владельцем до продолжения.

- [ ] **Step 3: Проверить `create_response: false`**

```typescript
llm: new openai.realtime.RealtimeModel({
  model: 'gpt-realtime-2.1-mini',
  voice: 'cedar',
  turnDetection: {
    type: 'server_vad',
    threshold: 0.65,
    prefix_padding_ms: 300,
    silence_duration_ms: 900,
    create_response: false,
  },
}),
```

Проверить двумя способами: типы (`npx tsc --noEmit` — принимает ли плагин поле) и поведение (говорить в микрофон — модель обязана молчать; `session.generateReply()` — обязан заставить её ответить).

Run: `cd voice-host && npx tsc --noEmit && npx tsx src/spike/spike.ts`
Expected: типы проходят, на речь молчит, на `generateReply` отвечает.

**Если не проходит:** прежде чем соглашаться на запасной путь (генерировать всегда и глушить — платить за выброшенное), посмотреть, нельзя ли дотянуться до сырой сессии в обход плагина: `session.llm` хранит клиент Realtime, и `session.update` со своим `turn_detection` может пройти мимо типов.

- [ ] **Step 4: Проверить голос на mini**

Голоса сравнивались на флагмане, и выбранный `cedar` может у mini отсутствовать или звучать иначе. Канонический список отдаёт сам API на неверном значении.

Expected: голос принят, звучит мужским (для Романа). Если нет — подобрать заново **на слух**, не по описанию: в `agent.ts` на этом месте стоит предупреждение, там дважды промахнулись мимо пола голоса.

- [ ] **Step 5: Записать выводы и удалить спайк**

Дописать в конец этого файла раздел «Результаты спайка».

```bash
rm -rf voice-host/src/spike
git add docs/superpowers/plans/2026-08-27-linkeon-meeting-rooms.md
git commit -m "docs: результаты спайка по AgentSession, create_response и голосу mini"
```

---

## Task 2: Код комнаты

**Files:**
- Create: `src/meeting/room-code.ts`
- Test: `src/meeting/room-code.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/meeting/room-code.spec.ts
import { generateRoomCode, isValidRoomCode, ROOM_CODE_ALPHABET } from './room-code';

describe('generateRoomCode', () => {
  it('шесть символов из разрешённого алфавита', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect([...code].every((c) => ROOM_CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('не содержит двусмысленных знаков — код диктуют голосом', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(bad);
    }
  });

  it('не повторяется на двухстах генерациях', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRoomCode()));
    expect(seen.size).toBe(200);
  });
});

describe('isValidRoomCode', () => {
  it('принимает свой же вывод', () => {
    expect(isValidRoomCode(generateRoomCode())).toBe(true);
  });

  it('не зависит от регистра — код диктуют и записывают как попало', () => {
    expect(isValidRoomCode(generateRoomCode().toLowerCase())).toBe(true);
  });

  it.each(['', 'ABC', 'ABCDEFG', 'ABC-DE', 'ABC0DE', 'АБВГДЕ'])('отвергает %p', (bad) => {
    expect(isValidRoomCode(bad)).toBe(false);
  });

  it('отвергает не строку, а не падает', () => {
    expect(isValidRoomCode(undefined as any)).toBe(false);
    expect(isValidRoomCode(null as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/meeting/room-code.spec.ts`
Expected: FAIL — `Cannot find module './room-code'`

- [ ] **Step 3: Минимальная реализация**

```typescript
// src/meeting/room-code.ts
import { randomInt } from 'crypto';

/**
 * Алфавит кода комнаты.
 *
 * Без 0/O и 1/I/L: код диктуют вслух и записывают на слух, а «ноль или о» —
 * это ещё одна попытка входа и звонок «у меня не открывается». Убраны и
 * строчные — код показывается заглавными и сравнивается без регистра.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

/**
 * randomInt из crypto, а не Math.random: код комнаты — это пропуск в чужие
 * переговоры, и предсказуемый генератор здесь означает предсказуемый пропуск.
 */
export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

export function isValidRoomCode(code: unknown): boolean {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
  const upper = code.toUpperCase();
  return [...upper].every((c) => ROOM_CODE_ALPHABET.includes(c));
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/meeting/room-code.spec.ts`
Expected: PASS

- [ ] **Step 5: Сломать проверку нарочно**

Вернуть `0` и `O` в алфавит, прогнать — тест на двусмысленные знаки обязан покраснеть. Вернуть обратно. Зелёный результат ничего не доказывает, пока не увидел, как он краснеет.

- [ ] **Step 6: Коммит**

```bash
git add src/meeting/room-code.ts src/meeting/room-code.spec.ts
git commit -m "feat(meeting): код комнаты без двусмысленных знаков"
```

---

## Task 3: Схема

**Files:**
- Create: `src/meeting/migrations/001_meeting_rooms.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- 001_meeting_rooms.sql
-- Голосовая комната Linkeon. Живёт дольше одного входа ассистента и
-- существует без него вовсе: люди могут собраться и поговорить сами.
CREATE TABLE IF NOT EXISTS meeting_rooms (
  code           TEXT PRIMARY KEY,
  -- TEXT, не varchar(20): у пользователей через email/OAuth идентификатор это
  -- gen_random_uuid()::text (36 символов), а не телефон.
  owner_user_id  TEXT NOT NULL,
  title          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS meeting_rooms_owner_idx
  ON meeting_rooms (owner_user_id, created_at DESC);

-- Вход ассистента переиспользует voice_calls: жизненный цикл, завершение,
-- учёт стоимости и карточка в ленте у встречи те же, что у звонка. Отдельная
-- таблица означала бы дублирование complete/fail/reaper.
--
-- provider: 'linkeon' — звонок из интерфейса (всё, что было до этого),
-- 'linkeon_room' — встреча. Дальше сюда добавится 'zoom'.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'linkeon';
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS external_room TEXT;

-- Момент, когда в комнате впервые появился живой участник. Пока NULL —
-- действует ожидание LOBBY_MS, а не правило «комната опустела».
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS first_human_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS voice_calls_provider_room_idx
  ON voice_calls (provider, external_room) WHERE external_room IS NOT NULL;
```

- [ ] **Step 2: Проверить против живой базы на тестовой ноде**

```bash
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -f ~/ci/spirits_back/src/meeting/migrations/001_meeting_rooms.sql'
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -c "\d meeting_rooms" -c "\d voice_calls"'
```

Expected: таблица и три новые колонки в выводе. Повторный запуск не падает — `IF NOT EXISTS` везде.

- [ ] **Step 3: Коммит**

```bash
git add src/meeting/migrations/001_meeting_rooms.sql
git commit -m "feat(meeting): таблица комнат и провайдер в voice_calls"
```

---

## Task 4: Ограничение частоты на публичных ручках

**Files:**
- Create: `src/meeting/room-rate-limit.ts`
- Test: `src/meeting/room-rate-limit.spec.ts`

Публичные ручки входа — это единственное место в проекте, куда можно стучаться без токена. Код из шести символов без ограничения перебирается, а за ним чужие переговоры.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/meeting/room-rate-limit.spec.ts
import { RoomRateLimit, JOIN_LIMIT_PER_IP, LOOKUP_LIMIT_PER_IP } from './room-rate-limit';

describe('RoomRateLimit', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let limit: RoomRateLimit;

  beforeEach(() => {
    redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    limit = new RoomRateLimit({ getClient: () => redis } as any);
  });

  it('первое обращение проходит', async () => {
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('ставит TTL на первом обращении, иначе счётчик вечный', async () => {
    await limit.checkLookup('1.2.3.4');
    expect(redis.expire).toHaveBeenCalled();
  });

  it('не переставляет TTL на последующих — иначе окно не закончится никогда', async () => {
    redis.incr.mockResolvedValue(2);
    await limit.checkLookup('1.2.3.4');
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('отвергает после превышения предела', async () => {
    redis.incr.mockResolvedValue(LOOKUP_LIMIT_PER_IP + 1);
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(false);
  });

  it('у входа предел строже, чем у справки', async () => {
    expect(JOIN_LIMIT_PER_IP).toBeLessThan(LOOKUP_LIMIT_PER_IP);
  });

  it('считает по IP раздельно', async () => {
    await limit.checkLookup('1.2.3.4');
    await limit.checkLookup('5.6.7.8');
    const keys = redis.incr.mock.calls.map(([k]: [string]) => k);
    expect(new Set(keys).size).toBe(2);
  });

  it('при недоступном Redis пропускает, а не запирает вход', async () => {
    // Отказ Redis не должен превращаться в «никто не может войти во встречу».
    // Перебор кода — риск, сорванная встреча у всех сразу — точно ущерб.
    redis.incr.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/meeting/room-rate-limit.spec.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Минимальная реализация**

```typescript
// src/meeting/room-rate-limit.ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';

/** Справка о комнате дешёвая — предел щедрый. */
export const LOOKUP_LIMIT_PER_IP = 60;
/** Вход выпускает токен в комнату — предел строже. */
export const JOIN_LIMIT_PER_IP = 10;
const WINDOW_SEC = 60;

@Injectable()
export class RoomRateLimit {
  private readonly logger = new Logger(RoomRateLimit.name);

  constructor(private readonly redis: RedisService) {}

  checkLookup(ip: string): Promise<boolean> {
    return this.hit(`room:lookup:${ip}`, LOOKUP_LIMIT_PER_IP);
  }

  checkJoin(ip: string): Promise<boolean> {
    return this.hit(`room:join:${ip}`, JOIN_LIMIT_PER_IP);
  }

  private async hit(key: string, limit: number): Promise<boolean> {
    try {
      const client = this.redis.getClient();
      const n = await client.incr(key);
      // TTL ставим только на первом попадании. Иначе окно продлевается с
      // каждым запросом и не заканчивается никогда — вместо «60 в минуту»
      // получается «60 навсегда».
      if (n === 1) await client.expire(key, WINDOW_SEC);
      return n <= limit;
    } catch (e: any) {
      // Отказ Redis не должен запирать вход всем сразу.
      this.logger.warn(`rate limit ${key} недоступен: ${e?.message}`);
      return true;
    }
  }
}
```

Сверить имя и API сервиса Redis с тем, что реально в `src/common/services/` — если обёртки нет, взять её так же, как берут соседние модули.

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/meeting/room-rate-limit.spec.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/meeting/room-rate-limit.ts src/meeting/room-rate-limit.spec.ts
git commit -m "feat(meeting): ограничение частоты на публичных ручках комнаты"
```

---

## Task 5: Сервис и ручки комнаты

**Files:**
- Create: `src/meeting/room.service.ts`, `src/meeting/room.controller.ts`
- Test: `src/meeting/room.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/meeting/room.service.spec.ts
import { NotFoundException } from '@nestjs/common';
import { RoomService } from './room.service';

describe('RoomService', () => {
  const livekit = { userToken: jest.fn().mockResolvedValue('guest-token'), closeRoom: jest.fn() };
  let pg: { query: jest.Mock };
  let svc: RoomService;

  beforeEach(() => {
    jest.clearAllMocks();
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    svc = new RoomService(pg as any, livekit as any);
  });

  it('создаёт комнату и возвращает код', async () => {
    const res = await svc.create('u1', 'Планёрка');
    expect(res.code).toHaveLength(6);
    const insert = pg.query.mock.calls.find(([s]: [string]) => s.includes('INSERT INTO meeting_rooms'));
    expect(insert).toBeDefined();
  });

  it('справка по живой комнате', async () => {
    pg.query.mockResolvedValue({ rows: [{ code: 'ABC234', title: 'Планёрка', closed_at: null }], rowCount: 1 });
    await expect(svc.info('ABC234')).resolves.toMatchObject({ title: 'Планёрка', active: true });
  });

  it('справка не зависит от регистра — код записывают как попало', async () => {
    pg.query.mockResolvedValue({ rows: [{ code: 'ABC234', title: 'x', closed_at: null }], rowCount: 1 });
    await svc.info('abc234');
    expect(pg.query.mock.calls[0][1]).toContain('ABC234');
  });

  it('несуществующая комната — null, а не исключение', async () => {
    await expect(svc.info('ZZZZZZ')).resolves.toBeNull();
  });

  it('невалидный код не доходит до базы', async () => {
    await expect(svc.info('../../etc')).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('выдаёт гостю токен на имя комнаты', async () => {
    pg.query.mockResolvedValue({ rows: [{ code: 'ABC234', title: 'x', closed_at: null }], rowCount: 1 });
    const res = await svc.joinGuest('ABC234', 'Сергей');
    expect(res.token).toBe('guest-token');
    expect(livekit.userToken).toHaveBeenCalledWith('room_ABC234', expect.any(String), 'Сергей');
  });

  it('в закрытую комнату не пускает', async () => {
    pg.query.mockResolvedValue({ rows: [{ code: 'ABC234', title: 'x', closed_at: new Date() }], rowCount: 1 });
    await expect(svc.joinGuest('ABC234', 'Сергей')).rejects.toThrow(NotFoundException);
  });

  it('пустое имя заменяется, а не уезжает пустым в список участников', async () => {
    pg.query.mockResolvedValue({ rows: [{ code: 'ABC234', title: 'x', closed_at: null }], rowCount: 1 });
    await svc.joinGuest('ABC234', '   ');
    expect(livekit.userToken).toHaveBeenCalledWith('room_ABC234', expect.any(String), 'Гость');
  });

  it('у двух гостей разные identity, иначе LiveKit выкинет первого', async () => {
    pg.query.mockResolvedValue({ rows: [{ code: 'ABC234', title: 'x', closed_at: null }], rowCount: 1 });
    await svc.joinGuest('ABC234', 'Сергей');
    await svc.joinGuest('ABC234', 'Сергей');
    const ids = livekit.userToken.mock.calls.map((c: any[]) => c[1]);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/meeting/room.service.spec.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Реализовать сервис**

```typescript
// src/meeting/room.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from '../voice-call/livekit.client';
import { generateRoomCode, isValidRoomCode } from './room-code';

export interface RoomInfo {
  code: string;
  title: string;
  active: boolean;
}

@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);

  constructor(
    private readonly pg: PgService,
    private readonly livekit: LiveKitClient,
  ) {}

  /** Имя комнаты в LiveKit. Отделено от кода префиксом, чтобы коды встреч не
   *  сталкивались с именами комнат звонков (`voice_<uuid>`). */
  private roomName(code: string): string {
    return `room_${code}`;
  }

  async create(userId: string, title?: string): Promise<{ code: string; title: string }> {
    const code = generateRoomCode();
    await this.pg.query(
      `INSERT INTO meeting_rooms (code, owner_user_id, title) VALUES ($1, $2, $3)`,
      [code, userId, title || null],
    );
    this.logger.log(`[create] комната ${code} у ${userId}`);
    return { code, title: title || 'Встреча' };
  }

  async info(code: string): Promise<RoomInfo | null> {
    // Проверка ДО базы: невалидный код это мусор или перебор, и гонять его в
    // запрос незачем.
    if (!isValidRoomCode(code)) return null;
    const upper = code.toUpperCase();
    const res = await this.pg.query(
      `SELECT code, title, closed_at FROM meeting_rooms WHERE code = $1`,
      [upper],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { code: row.code, title: row.title || 'Встреча', active: !row.closed_at };
  }

  async joinGuest(code: string, name: string): Promise<{ token: string; wsUrl: string }> {
    const room = await this.info(code);
    if (!room || !room.active) throw new NotFoundException('room not found');

    // identity уникальна на каждого входящего. LiveKit считает identity
    // ключом участника: два человека с одинаковой identity — это один
    // участник, и второй вход выкидывает первого из комнаты.
    const identity = `guest_${randomUUID()}`;
    const display = (name || '').trim() || 'Гость';

    const token = await this.livekit.userToken(this.roomName(room.code), identity, display);
    return { token, wsUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || 'ws://localhost:7880' };
  }

  async close(code: string): Promise<void> {
    await this.pg.query(
      `UPDATE meeting_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL`,
      [code.toUpperCase()],
    );
    await this.livekit.closeRoom(this.roomName(code.toUpperCase()));
  }
}
```

- [ ] **Step 4: Дать `userToken` отображаемое имя**

`LiveKitClient.userToken(roomName, identity)` сейчас имени не принимает, а в комнате оно нужно: список участников и разметка говорящего берут `participant.name`.

```typescript
// src/voice-call/livekit.client.ts
async userToken(roomName: string, identity: string, name?: string): Promise<string> {
  // name отдельно от identity: identity — ключ участника и обязана быть
  // уникальной, name — то, что видят люди, и совпадать у тёзок вправе.
  const at = new AccessToken(this.apiKey, this.apiSecret, { identity, name, ttl: '3h' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}
```

TTL поднят с `2h` до `3h`: потолок встречи два часа, и токен обязан пережить её с запасом.

- [ ] **Step 5: Контроллер**

```typescript
// src/meeting/room.controller.ts
import { Body, Controller, ForbiddenException, Get, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { RoomService } from './room.service';
import { RoomRateLimit } from './room-rate-limit';

@Controller('room')
export class RoomController {
  constructor(
    private readonly rooms: RoomService,
    private readonly limit: RoomRateLimit,
  ) {}

  /** Создание — только для своих. v1 админский, как и всё остальное. */
  @Post()
  @UseGuards(JwtGuard)
  async create(@CurrentUser() u: any, @Body() body: { title?: string }) {
    if (!u?.isAdmin) throw new ForbiddenException('meetings are admin-only in v1');
    return this.rooms.create(u.userId, body?.title);
  }

  /**
   * Публично: гости не пользователи Linkeon, токена у них нет.
   *
   * Ответ на несуществующую и на закрытую комнату одинаковый — 404 с тем же
   * телом. Различать их означало бы подсказывать перебирающему, что код угадан
   * верно, а встреча просто закончилась.
   */
  @Get('public/:code')
  async info(@Param('code') code: string, @Ip() ip: string) {
    if (!(await this.limit.checkLookup(ip))) return { error: 'too many requests' };
    const room = await this.rooms.info(code);
    if (!room || !room.active) return { error: 'not found' };
    return { title: room.title, active: true };
  }

  @Post('public/:code/join')
  async join(@Param('code') code: string, @Body() body: { name: string }, @Ip() ip: string) {
    if (!(await this.limit.checkJoin(ip))) return { error: 'too many requests' };
    return this.rooms.joinGuest(code, body?.name || '');
  }
}
```

Проверить, что `@Ip()` отдаёт реальный адрес, а не адрес прокси: перед нами Nginx, а перед ним Selectel-прокси `92.53.64.147`. Если в приложении не включён `trust proxy`, все запросы придут с одного адреса и ограничение частоты запрёт вход всем сразу. Смотреть `main.ts`.

- [ ] **Step 6: Запустить тесты**

Run: `npx jest src/meeting --silent`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add src/meeting/room.service.ts src/meeting/room.service.spec.ts \
        src/meeting/room.controller.ts src/voice-call/livekit.client.ts
git commit -m "feat(meeting): комнаты Linkeon и публичный вход по коду"
```

---

## Task 6: Разбор ссылки на комнату

**Files:**
- Create: `src/meeting/meeting-link.ts`
- Test: `src/meeting/meeting-link.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/meeting/meeting-link.spec.ts
import { parseMeetingLink } from './meeting-link';

describe('parseMeetingLink', () => {
  it('находит код в нашей ссылке', () => {
    expect(parseMeetingLink('заходи https://my.linkeon.io/room/ABC234 в три')).toEqual({ code: 'ABC234' });
  });

  it('находит на тестовом домене', () => {
    expect(parseMeetingLink('https://test.linkeon.io/room/ABC234')).toEqual({ code: 'ABC234' });
  });

  it('приводит код к верхнему регистру', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/abc234')).toEqual({ code: 'ABC234' });
  });

  it('игнорирует хвост и query', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/ABC234?x=1#top')).toEqual({ code: 'ABC234' });
  });

  it('берёт первую из нескольких', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/AAA234 и https://my.linkeon.io/room/BBB234')?.code)
      .toBe('AAA234');
  });

  it('отвергает код с двусмысленным знаком — такого мы не выдаём', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/ABC01D')).toBeNull();
  });

  it('отвергает чужой домен', () => {
    expect(parseMeetingLink('https://evil.com/room/ABC234')).toBeNull();
  });

  it('не ловит домен, лишь заканчивающийся на linkeon.io', () => {
    expect(parseMeetingLink('https://notlinkeon.io/room/ABC234')).toBeNull();
  });

  it('текст без ссылок — null', () => {
    expect(parseMeetingLink('созвонимся завтра')).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/meeting/meeting-link.spec.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Минимальная реализация**

```typescript
// src/meeting/meeting-link.ts
import { isValidRoomCode } from './room-code';

/**
 * Точка перед linkeon.io обязательна: без неё сюда попадёт notlinkeon.io.
 * Домен без поддомена тоже ловим — лендинг живёт на linkeon.io.
 */
const ROOM_LINK_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?linkeon\.io\/room\/([A-Za-z0-9]+)/i;

export function parseMeetingLink(text: string): { code: string } | null {
  const m = ROOM_LINK_REGEX.exec(text || '');
  if (!m) return null;
  const code = m[1].toUpperCase();
  // Проверяем алфавитом: ссылка вида /room/ABC01D синтаксически похожа, но
  // такого кода мы не выдаём, и идти с ним в базу незачем.
  return isValidRoomCode(code) ? { code } : null;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/meeting/meeting-link.spec.ts`
Expected: PASS, 9 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/meeting/meeting-link.ts src/meeting/meeting-link.spec.ts
git commit -m "feat(meeting): разбор ссылки на комнату Linkeon"
```

---

## Task 7: Гейт по имени

**Files:**
- Create: `voice-host/src/name-gate.ts`
- Test: `voice-host/src/name-gate.test.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// voice-host/src/name-gate.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addressedByName, NameGate } from './name-gate.js';

describe('addressedByName', () => {
  test('ловит имя в именительном падеже', () => {
    assert.equal(addressedByName('Роман, что скажешь?', 'Роман'), true);
  });

  test('ловит косвенные падежи', () => {
    for (const s of ['спросим Романа', 'передай Роману', 'с Романом', 'о Романе']) {
      assert.equal(addressedByName(s, 'Роман'), true, s);
    }
  });

  test('не срабатывает на слове, которое лишь начинается с имени', () => {
    assert.equal(addressedByName('это романтика какая-то', 'Роман'), false);
    assert.equal(addressedByName('он романист', 'Роман'), false);
  });

  test('работает с женскими именами на гласную', () => {
    for (const s of ['Анна, посчитай', 'спросите Анну', 'у Анны', 'к Анне', 'с Анной']) {
      assert.equal(addressedByName(s, 'Анна'), true, s);
    }
  });

  test('не путает Анну с аннотацией', () => {
    assert.equal(addressedByName('дай аннотацию', 'Анна'), false);
  });

  test('не зависит от регистра и от ё', () => {
    assert.equal(addressedByName('РОМАН!', 'Роман'), true);
    assert.equal(addressedByName('алёна тут?', 'Алена'), true);
  });

  test('пустой текст — не обращение', () => {
    assert.equal(addressedByName('', 'Роман'), false);
    assert.equal(addressedByName('   ', 'Роман'), false);
  });
});

describe('NameGate', () => {
  test('молчит, пока не назвали по имени', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('погода хорошая', 1000), 'silent');
  });

  test('отвечает, когда назвали', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('Роман, твоё мнение?', 1000), 'respond');
  });

  test('внутри окна отвечает и без имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, твоё мнение?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 5000), 'respond');
  });

  test('после истечения окна снова молчит', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 40_000), 'silent');
  });

  test('каждый ответ продлевает окно', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    gate.decide('а дальше?', 20_000);
    gate.noteReplied(21_000);
    assert.equal(gate.decide('и что теперь?', 45_000), 'respond');
  });

  test('окно не открывается само, без ответа ассистента', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    assert.equal(gate.decide('а почему?', 5000), 'silent');
  });

  test('команда слушать уводит в режим слушателя', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('Роман, пока слушай', 1000), 'ack_listen');
  });

  test('в режиме слушателя молчит даже когда зовут по имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('Роман, что скажешь?', 2000), 'silent');
  });

  test('в режиме слушателя не действует и окно продолжения', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    gate.decide('Роман, пока слушай', 3000);
    assert.equal(gate.decide('а почему?', 4000), 'silent');
  });

  test('обратная команда возвращает в диалог', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('Роман, вопрос к тебе', 2000), 'ack_resume');
    assert.equal(gate.decide('Роман, так что?', 3000), 'respond');
  });

  test('обратная команда без имени не поднимает из режима слушателя', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('вопрос к тебе, Сергей', 2000), 'silent');
  });

  test('обычное обращение вне режима слушателя не считается командой', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('Роман, вопрос к тебе', 1000), 'respond');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd voice-host && npx tsx --test src/name-gate.test.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Минимальная реализация**

```typescript
// voice-host/src/name-gate.ts

/**
 * Окончания, с которыми имя остаётся обращением.
 *
 * Список закрытый, а не «имя плюс до трёх букв»: свободный хвост превращает
 * «Роман» в «романтику», а «Анну» в «аннотацию» — то есть ассистент влезал бы
 * в чужой разговор, не будучи позванным. Ложное молчание дешевле ложной
 * реплики при клиенте.
 */
const ENDINGS = ['', 'а', 'у', 'е', 'ы', 'и', 'ом', 'ой', 'ей', 'ю', 'я', 'ье', 'ем'];

/** «Роман, пока слушай» и синонимы. */
const LISTEN_CMD = /(пока\s+слушай|просто\s+слушай|молчи|в\s+режим\w*\s+слушател)/i;
/** «Роман, вопрос к тебе» и синонимы. */
const RESUME_CMD = /(вопрос\s+к\s+тебе|можешь\s+говорить|возвращайся|подключайся|включайся)/i;

export type GateDecision = 'silent' | 'respond' | 'ack_listen' | 'ack_resume';

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е');
}

/** Основа для склонения: у имён на гласную — без неё (Анна → анн). */
function stemOf(name: string): string {
  const n = normalize(name).trim();
  return /[аеиоуыэюя]$/.test(n) ? n.slice(0, -1) : n;
}

export function addressedByName(text: string, name: string): boolean {
  const stem = stemOf(name);
  if (!stem) return false;
  return normalize(text)
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean)
    .some((w) => w.startsWith(stem) && ENDINGS.includes(w.slice(stem.length)));
}

/**
 * Когда ассистенту позволено говорить на встрече.
 *
 * По умолчанию молчит. Отвечает, если назвали по имени, и дальше некоторое
 * время отвечает без имени: иначе доспросить «а почему?» было бы невозможно.
 *
 * Окно открывает ФАКТ ответа (noteReplied), а не факт обращения: если модель
 * промолчала, разговора нет и продолжать нечего.
 *
 * Поверх — режим слушателя по голосовой команде (решение владельца 26.08.2026,
 * docs/meeting-bot.md). Команды распознаются ТОЛЬКО вместе с именем:
 * «вопрос к тебе», сказанное одним живым участником другому, не должно
 * возвращать в разговор ассистента, которого оттуда специально убрали.
 */
export class NameGate {
  private openUntil = 0;
  private muted = false;

  constructor(
    private readonly name: string,
    private readonly windowMs: number,
  ) {}

  decide(text: string, now: number): GateDecision {
    const addressed = addressedByName(text, this.name);

    if (addressed && LISTEN_CMD.test(text)) {
      this.muted = true;
      // Окно тоже гасим: иначе следующая реплика прошла бы по нему и режим
      // слушателя включился бы с задержкой в полминуты.
      this.openUntil = 0;
      return 'ack_listen';
    }

    if (this.muted && addressed && RESUME_CMD.test(text)) {
      this.muted = false;
      return 'ack_resume';
    }

    if (this.muted) return 'silent';
    if (addressed) return 'respond';
    return now < this.openUntil ? 'respond' : 'silent';
  }

  noteReplied(now: number): void {
    if (!this.muted) this.openUntil = now + this.windowMs;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd voice-host && npx tsx --test src/name-gate.test.ts`
Expected: PASS, 19 тестов

- [ ] **Step 5: Зарегистрировать в скрипте пакета**

```json
"test": "tsx --test src/pending.test.ts src/name-gate.test.ts src/occupancy.test.ts"
```

- [ ] **Step 6: Коммит**

```bash
git add voice-host/src/name-gate.ts voice-host/src/name-gate.test.ts voice-host/package.json
git commit -m "feat(meeting): гейт по имени и режим слушателя"
```

---

## Task 8: Правила присутствия и выхода

**Files:**
- Create: `voice-host/src/occupancy.ts`
- Test: `voice-host/src/occupancy.test.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// voice-host/src/occupancy.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Occupancy, LOBBY_MS, HARD_CAP_MS } from './occupancy.js';

describe('Occupancy', () => {
  test('пустая комната сразу после входа — не повод выходить', () => {
    assert.equal(new Occupancy(0).verdict(1000), 'stay');
  });

  test('никто не пришёл за время ожидания — вход не состоялся', () => {
    assert.equal(new Occupancy(0).verdict(LOBBY_MS + 1), 'never_started');
  });

  test('пришёл человек — ожидание больше не действует', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    assert.equal(occ.verdict(LOBBY_MS + 1), 'stay');
  });

  test('все ушли — выходим', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    occ.left('alice', 5000);
    assert.equal(occ.verdict(5001), 'empty');
  });

  test('ушёл один из двух — остаёмся', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    occ.joined('bob', 1100);
    occ.left('alice', 5000);
    assert.equal(occ.verdict(5001), 'stay');
  });

  test('вернувшийся участник отменяет выход', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    occ.left('alice', 5000);
    occ.joined('alice', 6000);
    assert.equal(occ.verdict(6001), 'stay');
  });

  test('повторный joined того же участника не удваивает счётчик', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    occ.joined('alice', 1500);
    occ.left('alice', 5000);
    assert.equal(occ.verdict(5001), 'empty');
  });

  test('left неизвестного участника ничего не ломает', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    occ.left('ghost', 2000);
    assert.equal(occ.verdict(2001), 'stay');
  });

  test('потолок срабатывает даже при живой встрече', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    assert.equal(occ.verdict(HARD_CAP_MS + 1), 'hard_cap');
  });

  test('потолок важнее пустой комнаты — причина выхода не должна врать', () => {
    const occ = new Occupancy(0);
    occ.joined('alice', 1000);
    occ.left('alice', HARD_CAP_MS + 1);
    assert.equal(occ.verdict(HARD_CAP_MS + 2), 'hard_cap');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd voice-host && npx tsx --test src/occupancy.test.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Минимальная реализация**

```typescript
// voice-host/src/occupancy.ts

/**
 * Сколько ждём первого человека.
 *
 * Правило «нет живых участников → выходим» без отсрочки выкидывало бы
 * ассистента мгновенно: его могут позвать раньше, чем соберутся люди.
 */
export const LOBBY_MS = 15 * 60 * 1000;

/**
 * Потолок длительности. Продуктовое решение: у звонка час, у встречи два —
 * переговоры регулярно длиннее часа. Это ещё и потолок по деньгам.
 */
export const HARD_CAP_MS = 2 * 60 * 60 * 1000;

export type Verdict = 'stay' | 'never_started' | 'empty' | 'hard_cap';

/**
 * Кто живой в комнате и пора ли выходить.
 *
 * Чистая логика без таймеров и сети: воркер скармливает события и время, она
 * отвечает вердиктом. Так правила проверяются тестами, а не двухчасовым
 * сидением в реальной встрече.
 *
 * Участники — множество, а не счётчик: LiveKit может прислать
 * participantConnected дважды на переподключении, и счётчик после этого уже
 * никогда не дойдёт до нуля — ассистент остался бы в пустой комнате навсегда.
 */
export class Occupancy {
  private readonly humans = new Set<string>();
  private everHadHuman = false;

  constructor(private readonly startedAt: number) {}

  joined(identity: string, _now: number): void {
    this.humans.add(identity);
    this.everHadHuman = true;
  }

  left(identity: string, _now: number): void {
    this.humans.delete(identity);
  }

  get liveCount(): number {
    return this.humans.size;
  }

  verdict(now: number): Verdict {
    // Потолок проверяется первым: если истекли оба условия, причина выхода
    // должна называться честно, иначе в логах будет «встреча опустела» там,
    // где сработал предохранитель.
    if (now - this.startedAt >= HARD_CAP_MS) return 'hard_cap';
    if (!this.everHadHuman) {
      return now - this.startedAt >= LOBBY_MS ? 'never_started' : 'stay';
    }
    return this.humans.size === 0 ? 'empty' : 'stay';
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd voice-host && npm test`
Expected: PASS, все три файла

- [ ] **Step 5: Коммит**

```bash
git add voice-host/src/occupancy.ts voice-host/src/occupancy.test.ts
git commit -m "feat(meeting): правила присутствия и выхода из встречи"
```

---

## Task 8а: Сведение речи участников в один поток

Подтверждено спайком: `AgentSession` слышит одного участника. Сводим сами и подаём через `session.input.audio`.

**Files:**
- Create: `voice-host/src/mixer.ts`, `voice-host/src/mixer.test.ts`
- Create: `voice-host/src/mixed-audio-input.ts`

- [ ] **Step 1: Написать падающий тест микшера**

```typescript
// voice-host/src/mixer.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Mixer, SAMPLES_PER_TICK } from './mixer.js';

describe('Mixer', () => {
  test('без участников отдаёт тишину нужной длины', () => {
    const out = new Mixer().tick();
    assert.equal(out.length, SAMPLES_PER_TICK);
    assert.ok(out.every((v) => v === 0));
  });

  test('один участник проходит без изменений', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 100));
    assert.equal(m.tick()[0], 100);
  });

  test('двое складываются', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 100));
    m.push('bob', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 50));
    assert.equal(m.tick()[0], 150);
  });

  test('сумма ограничивается, а не переполняется', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 30000));
    m.push('bob', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 30000));
    assert.equal(m.tick()[0], 32767);
  });

  test('ограничивается и снизу', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => -30000));
    m.push('bob', Int16Array.from({ length: SAMPLES_PER_TICK }, () => -30000));
    assert.equal(m.tick()[0], -32768);
  });

  test('участник без данных не тормозит остальных', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 100));
    m.push('bob', new Int16Array(0));
    assert.equal(m.tick()[0], 100);
  });

  test('лишние сэмплы остаются на следующий тик', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK * 2 }, () => 77));
    assert.equal(m.tick()[0], 77);
    assert.equal(m.tick()[0], 77);
    assert.equal(m.tick()[0], 0);
  });

  test('кадр короче тика дополняется тишиной', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: 10 }, () => 500));
    const out = m.tick();
    assert.equal(out[0], 500);
    assert.equal(out[10], 0);
  });

  test('ушедший участник перестаёт влиять на микс', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK * 3 }, () => 100));
    m.remove('alice');
    assert.equal(m.tick()[0], 0);
  });

  test('буфер не растёт бесконечно', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) {
      m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 100));
    }
    assert.ok(m.bufferedTicks('alice') <= Mixer.MAX_BUFFERED_TICKS);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd voice-host && npx tsx --test src/mixer.test.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Реализовать микшер**

```typescript
// voice-host/src/mixer.ts

/** Частота на всём пути. Ресемплинга в нашем коде нет нигде. */
export const SAMPLE_RATE = 48_000;
/** 20 мс — стандартный размер пакета WebRTC. */
export const TICK_MS = 20;
export const SAMPLES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000; // 960

/**
 * Сведение речи участников встречи в один поток.
 *
 * Realtime принимает ровно один вход, а AgentSession из коробки слышит только
 * одного участника (RoomInputOptions.participantIdentity: «link to the first
 * participant»). Сводить обязан кто-то.
 *
 * Складываем сэмплы, а не перемежаем кадры. Встроенный MultiInputStream умеет
 * fan-in, но он именно перемежает: при пятерых участниках в поток пошло бы
 * пять кадров на каждые 20 мс реального времени, и Realtime получал бы аудио
 * впятеро быстрее реального.
 *
 * Кадры приходят вразнобой и разной длины, поэтому выравнивать их не пытаемся:
 * у каждого участника свой буфер, тикер раз в 20 мс забирает из каждого по 960
 * сэмплов. Нет данных — тишина, и молчащий не тормозит говорящего.
 */
export class Mixer {
  /**
   * Потолок буфера — полсекунды.
   *
   * Участник может слать быстрее, чем мы читаем (рассинхрон часов, всплеск
   * сети). Без потолка буфер растёт неограниченно: сначала это задержка,
   * которая только копится, потом память. Лучше выкинуть старое — во встрече
   * важна свежая речь, а не полная.
   */
  static readonly MAX_BUFFERED_TICKS = 25;

  private buffers = new Map<string, Int16Array[]>();

  push(participant: string, samples: Int16Array): void {
    if (!samples.length) return;
    const queue = this.buffers.get(participant) || [];
    queue.push(samples);
    while (this.countTicks(queue) > Mixer.MAX_BUFFERED_TICKS) queue.shift();
    this.buffers.set(participant, queue);
  }

  remove(participant: string): void {
    this.buffers.delete(participant);
  }

  bufferedTicks(participant: string): number {
    return this.countTicks(this.buffers.get(participant) || []);
  }

  /** Один смикшированный кадр. Вызывается ровно раз в TICK_MS. */
  tick(): Int16Array {
    const out = new Int16Array(SAMPLES_PER_TICK);
    for (const queue of this.buffers.values()) {
      const chunk = this.takeTick(queue);
      for (let i = 0; i < chunk.length; i++) {
        const sum = out[i] + chunk[i];
        out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
      }
    }
    return out;
  }

  private countTicks(queue: Int16Array[]): number {
    let n = 0;
    for (const c of queue) n += c.length;
    return Math.ceil(n / SAMPLES_PER_TICK);
  }

  private takeTick(queue: Int16Array[]): Int16Array {
    const out = new Int16Array(SAMPLES_PER_TICK);
    let filled = 0;
    while (filled < SAMPLES_PER_TICK && queue.length) {
      const head = queue[0];
      const need = SAMPLES_PER_TICK - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        queue.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        // subarray, а не slice: slice на Int16Array поверх чужого буфера ведёт
        // себя непредсказуемо, про это есть прямое предупреждение в примерах
        // rtc-node.
        queue[0] = head.subarray(need);
        filled += need;
      }
    }
    // Длина всегда SAMPLES_PER_TICK: недобранный хвост остаётся тишиной. Тик
    // обязан быть ровным, иначе поток в Realtime поедет по времени.
    return out;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd voice-host && npx tsx --test src/mixer.test.ts`
Expected: PASS, 10 тестов

- [ ] **Step 5: Сломать проверку нарочно**

Убрать ограничение суммы (`out[i] = sum`), прогнать — два теста на переполнение обязаны покраснеть. Вернуть.

- [ ] **Step 6: Обернуть микшер в `AudioInput`**

```typescript
// voice-host/src/mixed-audio-input.ts
import { voice } from '@livekit/agents';
import { AudioFrame, AudioStream, RoomEvent, TrackKind, type RemoteTrack, type Room } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { Mixer, SAMPLE_RATE, SAMPLES_PER_TICK, TICK_MS } from './mixer.js';

/**
 * Вход сессии, собранный из ВСЕХ участников комнаты.
 *
 * Подставляется вместо штатного через `session.input.audio` — тот слышит
 * только одного участника и, что хуже, закрывает сессию, когда именно он
 * отключился (RoomInputOptions.closeOnDisconnect).
 */
export class MixedRoomAudioInput extends voice.AudioInput {
  private mixer = new Mixer();
  private ticker?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly room: Room) {
    super();

    const controller = { push: (_f: AudioFrame) => {} };
    const source = new ReadableStream<AudioFrame>({
      start: (c) => { controller.push = (f) => c.enqueue(f); },
    });
    this.multiStream.addInputStream(source);

    for (const p of this.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track) this.attach(pub.track, p.identity);
      }
    }

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p) => {
      this.attach(track, p.identity);
    });
    this.room.on(RoomEvent.ParticipantDisconnected, (p) => this.mixer.remove(p.identity));

    this.ticker = setInterval(() => {
      if (this.closed) return;
      controller.push(new AudioFrame(this.mixer.tick(), SAMPLE_RATE, 1, SAMPLES_PER_TICK));
    }, TICK_MS);
    // unref обязателен: без него таймер держит event loop, процесс задания не
    // может завершиться, и фреймворк через минуту убивает его как «job is
    // unresponsive» — вместе с недоотправленным complete. Так дважды терялся
    // транскрипт (25 и 26.08.2026).
    this.ticker.unref?.();
  }

  private attach(track: RemoteTrack, identity: string): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      const reader = new AudioStream(track, SAMPLE_RATE, 1).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.closed) break;
          if (value) this.mixer.push(identity, value.data);
        }
      } catch (e) {
        console.error(`поток участника ${identity} оборвался`, e);
      } finally {
        reader.releaseLock();
        this.mixer.remove(identity);
      }
    })();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    await super.close();
  }
}
```

⚠️ Точная форма `voice.AudioInput` и того, как подкладывать кадры в `multiStream`, проверяется первым же `tsc --noEmit`: класс абстрактный, а `multiStream` — `protected`. Если конструктор `ReadableStream` в этой связке не подойдёт, взять `TransformStream` и писать во `writable`.

- [ ] **Step 7: Собрать**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsc --noEmit && npm test'`
Expected: типы проходят, тесты зелёные

- [ ] **Step 8: Коммит**

```bash
git add voice-host/src/mixer.ts voice-host/src/mixer.test.ts voice-host/src/mixed-audio-input.ts voice-host/package.json
git commit -m "feat(meeting): сведение речи участников в один вход сессии"
```

---

## Task 9: Воркер — режим встречи

**Files:**
- Create: `voice-host/src/prompts.ts`
- Modify: `voice-host/src/agent.ts`, `voice-host/src/backend.ts`
- Modify: `src/voice-call/voice-call.types.ts`, `src/voice-call/voice-call.service.ts`

- [ ] **Step 1: Вынести инструкции в отдельный файл**

Функция звонка переезжает **дословно**, вместе с сигнатурой и комментариями: у неё своё поведение и свой захардкоженный Роман. Меняется только имя (`instructions` → `callInstructions`) и место.

```typescript
// voice-host/src/prompts.ts

export interface MeetingPromptContext {
  name: string;
  /** Системный промпт ассистента из таблицы agents */
  persona: string;
  preamble: string;
  specialists: { name: string; role: string }[];
}

/** Перенесено из agent.ts:36-64 дословно, включая комментарии. */
export function callInstructions(
  preamble: string,
  specialists: { name: string; role: string }[],
): string {
  /* тело переносится из agent.ts:37-63 как есть */
}

/** Перенесено из agent.ts:359-363 дословно — там оно лежит инлайном. */
export function callIntro(): string {
  return (
    'Ты только что снял трубку. Скажи ПО-РУССКИ ровно одну короткую фразу: ' +
    'поздоровайся и сообщи, что ты на связи и слушаешь. Например: ' +
    '«Привет, Роман на связи, слушаю». Ни одного английского слова, ' +
    'никаких вопросов о делах и никаких списков — только это.'
  );
}

/**
 * Инструкции для встречи с живыми людьми.
 *
 * Отличие от звонка не в тоне, а в том, что собеседник не один и разговор идёт
 * не с ассистентом. Молчание — рабочий режим, а не сбой.
 *
 * Правило про имя дублирует то, что уже обеспечено гейтом (name-gate.ts): гейт
 * решает, дать ли ход, а промпт — как себя вести, когда ход дали. Одного гейта
 * мало: получив ход, модель без этой инструкции отвечает так, будто
 * разговаривают только с ней.
 */
export function meetingInstructions(ctx: MeetingPromptContext): string {
  const roster = ctx.specialists.map((s) => `  • ${s.name} — ${s.role}`).join('\n');
  return [
    'ГОВОРИ ТОЛЬКО ПО-РУССКИ — правило важнее всех остальных.',
    '',
    `Ты ${ctx.name}. ${ctx.persona}`,
    '',
    'Ты на РАБОЧЕЙ ВСТРЕЧЕ, где несколько живых участников.',
    'Разговор идёт между ними, а не с тобой. Ты слышишь всех сразу и не всегда',
    'понимаешь, кто именно говорит — не делай вид, что знаешь, и не обращайся',
    'к людям по именам наугад.',
    '',
    'Тебе дают слово, только когда к тебе обратились. Получив слово:',
    '  • отвечай коротко, одной-двумя фразами, как человек в переговорах;',
    '  • не пересказывай уже сказанное;',
    '  • не зачитывай списки вслух;',
    '  • закончил мысль — замолчи, не заполняй паузу.',
    '',
    'Ты можешь спросить коллег-специалистов. Выбирай строго по профилю:',
    roster,
    'Инструмент ask_specialist ставит вопрос в работу и возвращается мгновенно —',
    'ответа в нём НЕТ. Скажи вслух, что отправил вопрос, и не жди молча.',
    '',
    'Просят документ, письмо, план, договорённости — вызывай create_document.',
    'Он тоже возвращается мгновенно.',
    '',
    ctx.preamble ? `Контекст прошлой переписки:\n${ctx.preamble}` : 'Прошлой переписки нет.',
  ].join('\n');
}

/**
 * Первая фраза на встрече — представление.
 *
 * Единственное исключение из молчания. Правило обращения проговаривается
 * обязательно (решение владельца 26.08.2026): без него участники не догадаются,
 * что к ассистенту можно обратиться, и он честно промолчит всю встречу.
 */
export function meetingIntro(name: string, ownerName: string): string {
  return (
    'Ты только что вошёл во встречу. Скажи ПО-РУССКИ две коротких фразы и замолчи. ' +
    `Первая: представься как ${name}, ассистент ${ownerName}, и скажи, что разговор ` +
    'записывается. Вторая: объясни правило обращения — если вопрос к тебе, надо ' +
    `сказать «${name}, вопрос к тебе», а если нужно, чтобы ты просто слушал — ` +
    `«${name}, пока слушай». Ни одного английского слова, никаких вопросов о делах ` +
    'и никаких списков.'
  );
}

/**
 * Подтверждения переключения режима — заданы явно, а не отданы модели на
 * импровизацию: это служебная реакция, и звучать она должна одинаково, чтобы
 * участники понимали, что команда услышана.
 */
export function listenAck(): string {
  return 'Скажи ПО-РУССКИ ровно «Хорошо, слушаю» и замолчи. Больше ни слова.';
}

export function resumeAck(): string {
  return 'Скажи ПО-РУССКИ ровно «Снова на связи» и замолчи. Больше ни слова.';
}
```

- [ ] **Step 2: Разбор метаданных и модель**

```typescript
const meta = JSON.parse(ctx.job.metadata || '{}') as {
  callId: string;
  userId: string;
  preamble: string;
  specialists: { name: string; role: string }[];
  mode?: 'call' | 'meeting';
  agentName?: string;
  agentPersona?: string;
  agentVoice?: string;
  ownerName?: string;
};
const isMeeting = meta.mode === 'meeting';

/**
 * Встреча идёт на mini, звонок остаётся на флагмане.
 *
 * Отдельная переменная, а не общая VOICE_MODEL: у звонка разговор один на один
 * и качество ответа видно сразу, а встреча длится вдвое дольше и почти вся
 * состоит из молчаливого прослушивания. Решение владельца 27.08.2026.
 */
const model = isMeeting
  ? process.env.VOICE_MEETING_MODEL || 'gpt-realtime-2.1-mini'
  : process.env.VOICE_MODEL || 'gpt-realtime-2.1';
```

Модель подставляется в `RealtimeModel({ model, … })` и — **обязательно** — в `usage.model` при отправке `complete` (`agent.ts:323-327`, там сейчас захардкожен флагман). Иначе встреча на mini будет посчитана по ставкам флагмана и завысит расход втрое. Пересчёт ставок делать не надо: `ratesFor()` в `voice-call.service.ts` выбирает их по `/mini/i` в имени.

```typescript
llm: new openai.realtime.RealtimeModel({
  model,
  // Голос сравнивался на флагмане — Task 1 Step 4 проверяет его на mini.
  voice: meta.agentVoice || process.env.VOICE_NAME || 'cedar',
  inputAudioNoiseReduction: {
    // far_field — микрофон посреди переговорной, а не гарнитура: на встрече
    // источник звука это чужие колонки и общий микрофон, а не рот рядом.
    type: isMeeting ? 'far_field' : 'near_field',
  },
  turnDetection: {
    type: 'server_vad',
    threshold: 0.65,
    prefix_padding_ms: 300,
    silence_duration_ms: 900,
    // На встрече модель не начинает ответ сама: решает гейт.
    ...(isMeeting ? { create_response: false } : {}),
  },
}),
```

- [ ] **Step 3: Подключить гейт**

```typescript
import { NameGate } from './name-gate.js';
import { MixedRoomAudioInput } from './mixed-audio-input.js';
import { Occupancy } from './occupancy.js';
import { callInstructions, callIntro, meetingInstructions, meetingIntro, listenAck, resumeAck } from './prompts.js';

/** Сколько после своей реплики ассистент отвечает без повторного зова. */
const FOLLOWUP_WINDOW_MS = 30_000;

const gate = isMeeting ? new NameGate(meta.agentName || 'Роман', FOLLOWUP_WINDOW_MS) : null;
```

В существующем обработчике `ConversationItemAdded`, после записи в транскрипт:

```typescript
if (gate) {
  if (normalizedRole === 'user') {
    // Синтетические вставки (ответы коллег) сюда не попадают — они отсеяны
    // выше по INTERNAL_PREFIX и звучат всегда, их уже ждут.
    switch (gate.decide(textContent, Date.now())) {
      case 'respond': session.generateReply(); break;
      case 'ack_listen': session.generateReply({ instructions: listenAck() }); break;
      case 'ack_resume': session.generateReply({ instructions: resumeAck() }); break;
      case 'silent': break;
    }
  } else {
    gate.noteReplied(Date.now());
  }
}
```

⚠️ **Ответы специалистов и готовые документы звучат независимо от гейта** — они идут через `pushLine`/`flushPending`, минуя `ConversationItemAdded`. Это правильно: вопрос коллеге задал сам ассистент по просьбе участника, ответа ждут. Но проверить на живой встрече: если участники ушли в режим слушателя, а ответ прилетел — он прозвучит.

- [ ] **Step 4: Разметка говорящего**

LiveKit определяет говорящего сам — считать громкость руками не нужно.

```typescript
/** Кто из участников говорит сейчас. */
let currentSpeaker: string | undefined;

ctx.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
  // Берём первого: при перебивании активных несколько, а реплика в
  // транскрипте одна. Разметка приблизительная, и здесь это видно прямо.
  const top = speakers[0];
  currentSpeaker = top ? top.name || top.identity : undefined;
});
```

Тип реплики пополняется в `voice-host/src/backend.ts` и в `CompletePayload['transcript']` (`voice-call.types.ts`):

```typescript
export type TranscriptEntry = {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** Кто это сказал, по активному говорящему LiveKit. Нет на звонке. */
  speaker?: string;
};
```

Колонка `transcript` — JSONB, миграция не нужна.

Проставление там же, где сейчас `transcript.push`:

```typescript
transcript.push({
  role: normalizedRole,
  text: textContent,
  ts: Date.now(),
  // Только человеческие реплики: у ассистента говорящий известен и так.
  ...(normalizedRole === 'user' && currentSpeaker ? { speaker: currentSpeaker } : {}),
});
```

И в `VoiceCallService.summarize` строка склеивается как `${t.role === 'user' ? 'Пользователь' : 'Роман'}: ${t.text}`. Заменить на `t.speaker || 'Участник'` у человеческих реплик — иначе весь смысл разметки теряется на последнем шаге.

- [ ] **Step 5: Присутствие и выход**

```typescript
const occupancy = isMeeting ? new Occupancy(Date.now()) : null;

if (occupancy) {
  // Уже сидящие до нашего входа: participantConnected по ним не придёт, и без
  // этого прохода начавшаяся раньше встреча считалась бы пустой.
  for (const [identity] of ctx.room.remoteParticipants) occupancy.joined(identity, Date.now());

  ctx.room.on(RoomEvent.ParticipantConnected, (p) => {
    occupancy.joined(p.identity, Date.now());
    void backend.meetingFirstHuman(meta.callId).catch(() => {});
  });
  ctx.room.on(RoomEvent.ParticipantDisconnected, (p) => occupancy.left(p.identity, Date.now()));

  const watch = setInterval(() => {
    const verdict = occupancy.verdict(Date.now());
    if (verdict === 'stay') return;
    clearInterval(watch);
    console.log(`выходим из встречи: ${verdict}`);
    void (async () => {
      if (verdict === 'never_started') await backend.failed(meta.callId, 'во встречу так никто и не пришёл');
      try { await session.close(); } catch (e) { console.error('session.close()', e); }
      try { await ctx.room.disconnect(); } catch (e) { console.error('room.disconnect()', e); }
    })();
  }, 5_000);
  // unref обязателен: без него таймер держит event loop, процесс не может
  // завершиться, и фреймворк через минуту убивает его как «job is
  // unresponsive» — вместе с недоотправленным complete. Так дважды терялся
  // транскрипт (25 и 26.08.2026).
  watch.unref?.();
}
```

Добавить в `voice-host/src/backend.ts` метод и таймаут:

```typescript
  meetingFirstHuman: (callId: string) => post<{ ok: true }>('meeting-first-human', { callId }),
```

```typescript
const TIMEOUT_MS: Record<string, number> = {
  ask: 2_000, document: 2_000, complete: 15_000, failed: 5_000,
  'meeting-first-human': 5_000,
};
```

- [ ] **Step 6: Инструкции, первая фраза и потолок**

```typescript
const agentName = meta.agentName || 'Роман';

await session.start({
  agent: new voice.Agent({
    instructions: isMeeting
      ? meetingInstructions({
          name: agentName,
          persona: meta.agentPersona || '',
          preamble: meta.preamble,
          specialists: meta.specialists,
        })
      : callInstructions(meta.preamble, meta.specialists),
    tools,
  }),
  room: ctx.room,
  // На встрече штатный вход RoomIO гасим: он слышит только первого вошедшего
  // и закрывает сессию, когда именно тот отключился. Своим входом (ниже)
  // слышим всех. Вывод RoomIO остаётся — голос ассистента публикует он.
  ...(isMeeting
    ? { inputOptions: { audioEnabled: false, closeOnDisconnect: false } }
    : {}),
});

if (isMeeting) {
  // Подменяем вход ПОСЛЕ start(): до него сессия ещё не собрала свой
  // AgentInput, и присвоение потерялось бы молча — ассистент сидел бы на
  // встрече глухим.
  session.input.audio = new MixedRoomAudioInput(ctx.room);
}

session.generateReply({
  instructions: isMeeting ? meetingIntro(agentName, meta.ownerName || 'пользователя') : callIntro(),
});
```

Существующий блок комментариев над `generateReply` (`agent.ts:348-357` — про гудки дозвона и про то, что до первой реплики Realtime уходит в английский) остаётся: для встречи это верно так же.

Потолок сессии (`agent.ts:279`):

```typescript
// Встреча — два часа против часа у звонка. Это второй предохранитель; первый
// живёт в Occupancy и срабатывает раньше. Держать их согласованными.
const SESSION_LIMIT_MS = (isMeeting ? 2 : 1) * 60 * 60 * 1000;
```

- [ ] **Step 7: Собрать и прогнать тесты**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsc --noEmit && npm test'`
Expected: типы проходят, тесты зелёные

- [ ] **Step 8: Коммит**

```bash
git add voice-host/src/prompts.ts voice-host/src/agent.ts voice-host/src/backend.ts \
        src/voice-call/voice-call.types.ts src/voice-call/voice-call.service.ts
git commit -m "feat(meeting): режим встречи в воркере — гейт, представление, говорящий, выход"
```

---

## Task 10: Вход ассистента во встречу

**Files:**
- Create: `src/meeting/meeting.service.ts`, `src/meeting/meeting.controller.ts`, `src/meeting/meeting.module.ts`
- Test: `src/meeting/meeting.service.spec.ts`
- Modify: `src/voice-call/voice-call-internal.controller.ts`, `src/voice-call/voice-call.service.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/meeting/meeting.service.spec.ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { MeetingService } from './meeting.service';

describe('MeetingService.join', () => {
  const rooms = { info: jest.fn() };
  const livekit = { dispatchAgent: jest.fn(), closeRoom: jest.fn() };
  const calls = { buildPreamble: jest.fn(), load: jest.fn(), fail: jest.fn(), markInterruptedKeepingRoom: jest.fn() };
  let pg: { query: jest.Mock };
  let svc: MeetingService;

  const agentRow = { id: 7, display_name: 'Андрей', system_prompt: 'Помогаю с запуском.', realtime_voice: 'ash' };

  beforeEach(() => {
    jest.clearAllMocks();
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    rooms.info.mockResolvedValue({ code: 'ABC234', title: 'Планёрка', active: true });
    calls.buildPreamble.mockResolvedValue('Пользователь: привет');
    svc = new MeetingService(pg as any, calls as any, livekit as any, rooms as any);
  });

  function withAgent() {
    pg.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM agents') ? { rows: [agentRow] } : { rows: [], rowCount: 0 });
  }

  it('заводит запись и зовёт воркера в комнату встречи', async () => {
    withAgent();
    const res = await svc.join('u1', 7, 'ABC234', 'Дмитрий');
    expect(res.callId).toEqual(expect.any(String));
    // Комната именно встречи, а не новая: ассистент входит туда, где люди.
    expect(livekit.dispatchAgent).toHaveBeenCalledWith('room_ABC234', expect.any(Object));
  });

  it('передаёт режим встречи и данные ассистента', async () => {
    withAgent();
    await svc.join('u1', 7, 'ABC234', 'Дмитрий');
    expect(livekit.dispatchAgent).toHaveBeenCalledWith('room_ABC234', expect.objectContaining({
      mode: 'meeting', agentName: 'Андрей', agentVoice: 'ash', ownerName: 'Дмитрий',
    }));
  });

  it('берёт preamble из чата с ЭТИМ ассистентом, а не с Романом', async () => {
    withAgent();
    await svc.join('u1', 7, 'ABC234', 'Дмитрий');
    expect(calls.buildPreamble).toHaveBeenCalledWith('u1', 7);
  });

  it('не зовёт самого ведущего в список специалистов', async () => {
    withAgent();
    await svc.join('u1', 7, 'ABC234', 'Дмитрий');
    const meta = livekit.dispatchAgent.mock.calls[0][1] as any;
    expect(meta.specialists.map((s: any) => s.name)).not.toContain('Андрей');
  });

  it('не пускает второй вход при живом первом', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [agentRow] };
      if (sql.includes('SELECT id FROM voice_calls')) return { rows: [{ id: 'existing' }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(svc.join('u1', 7, 'ABC234', 'Дмитрий')).rejects.toThrow(ConflictException);
  });

  it('не входит в несуществующую комнату', async () => {
    withAgent();
    rooms.info.mockResolvedValue(null);
    await expect(svc.join('u1', 7, 'ZZZZZZ', 'Дмитрий')).rejects.toThrow(NotFoundException);
    expect(livekit.dispatchAgent).not.toHaveBeenCalled();
  });

  it('не входит в закрытую комнату', async () => {
    withAgent();
    rooms.info.mockResolvedValue({ code: 'ABC234', title: 'x', active: false });
    await expect(svc.join('u1', 7, 'ABC234', 'Дмитрий')).rejects.toThrow(NotFoundException);
  });

  it('если dispatch не удался — запись не остаётся висеть активной', async () => {
    withAgent();
    livekit.dispatchAgent.mockRejectedValue(new Error('livekit down'));
    await expect(svc.join('u1', 7, 'ABC234', 'Дмитрий')).rejects.toThrow('livekit down');
    const failed = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("status = 'failed'"));
    expect(failed).toBeDefined();
  });

  it('выход не закрывает комнату — люди продолжают встречу без ассистента', async () => {
    calls.load.mockResolvedValue({ id: 'c1', room_name: 'room_ABC234', user_id: 'u1' });
    await svc.leave('c1');
    // Именно KeepingRoom: обычный markInterrupted закрывает комнату, и на
    // встрече это выкинуло бы живых людей.
    expect(calls.markInterruptedKeepingRoom).toHaveBeenCalledWith('c1');
    expect(livekit.closeRoom).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/meeting/meeting.service.spec.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Реализовать сервис**

```typescript
// src/meeting/meeting.service.ts
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { SPECIALIST_ROLES, SPECIALISTS } from '../voice-call/voice-call.types';
import { RoomService } from './room.service';

@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly calls: VoiceCallService,
    private readonly livekit: LiveKitClient,
    private readonly rooms: RoomService,
  ) {}

  async join(userId: string, agentId: number, code: string, ownerName: string): Promise<{ callId: string; title: string }> {
    const agentRes = await this.pg.query(
      `SELECT id, display_name, system_prompt, realtime_voice FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new NotFoundException('agent not found');

    // Один активный вход на пользователя. Минута Realtime стоит реальных
    // денег, а без проверки N вкладок дают N оплачиваемых сессий.
    const active = await this.pg.query(
      `SELECT id FROM voice_calls WHERE user_id = $1 AND status IN ('dialing','active') LIMIT 1`,
      [userId],
    );
    if (active.rows[0]) {
      throw new ConflictException({ message: 'call already in progress', callId: active.rows[0].id });
    }

    const room = await this.rooms.info(code);
    if (!room || !room.active) throw new NotFoundException('room not found');

    const callId = randomUUID();
    const roomName = `room_${room.code}`;

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, provider, external_room)
       VALUES ($1, $2, $3, $4, 'dialing', 'linkeon_room', $5)`,
      [callId, userId, agentId, roomName, room.code],
    );

    try {
      const preamble = await this.calls.buildPreamble(userId, agentId);
      await this.livekit.dispatchAgent(roomName, {
        callId,
        userId,
        preamble,
        mode: 'meeting',
        agentName: agent.display_name,
        agentPersona: agent.system_prompt || '',
        agentVoice: agent.realtime_voice || undefined,
        ownerName,
        // Все, кроме самого ведущего: спрашивать себя незачем.
        specialists: Object.keys(SPECIALISTS)
          .filter((n) => SPECIALISTS[n] !== agentId)
          .map((n) => ({ name: n, role: SPECIALIST_ROLES[n] || '' })),
        callbackUrl: `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/voice-call/internal`,
      });
    } catch (e: any) {
      // Запись в 'dialing' намертво блокирует следующую попытку — лимит
      // «один активный вход» смотрит именно на неё.
      this.logger.error(`[join] call=${callId} не поднялся: ${e?.message}`);
      await this.pg.query(
        `UPDATE voice_calls SET status = 'failed', ended_at = now(), summary = $1 WHERE id = $2`,
        [`Вход во встречу не состоялся: ${e?.message}`, callId],
      );
      throw e;
    }

    this.logger.log(`[join] call=${callId} agent=${agentId} room=${room.code}`);
    return { callId, title: room.title };
  }

  /** Первый живой участник появился — встреча реально началась. */
  async noteFirstHuman(callId: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls SET status = 'active', first_human_at = COALESCE(first_human_at, now())
        WHERE id = $1 AND status = 'dialing'`,
      [callId],
    );
  }

  /**
   * Пользователь позвал ассистента выйти.
   *
   * Комнату НЕ закрываем: она не наша по смыслу — в ней люди, и они
   * продолжают встречу без ассистента. Закрытие выкинуло бы всех.
   * Этим встреча принципиально отличается от звонка, где markInterrupted
   * закрывает комнату (voice-call.service.ts:200-208).
   */
  async leave(callId: string): Promise<void> {
    await this.calls.markInterruptedKeepingRoom(callId);
  }
}
```

- [ ] **Step 4: Разделить «положить трубку» и «выйти из встречи»**

`VoiceCallService.markInterrupted` закрывает комнату — для звонка это правильно (иначе воркер остаётся жечь Realtime), для встречи губительно. Добавить вариант без закрытия:

```typescript
/**
 * Пометить оборванным, комнату НЕ трогать.
 *
 * Для встречи комната принадлежит людям, а не ассистенту: закрытие выкинуло бы
 * из неё всех. Но пометки в базе недостаточно — воркер о ней не узнает и
 * останется в комнате жечь Realtime-сессию. Поэтому участника-ассистента надо
 * удалить явно: он получит disconnect и отправит complete, как при обычном
 * завершении.
 */
async markInterruptedKeepingRoom(callId: string): Promise<void> {
  const res = await this.pg.query(
    `UPDATE voice_calls SET status = 'interrupted', ended_at = now()
      WHERE id = $1 AND status IN ('dialing','active') RETURNING room_name`,
    [callId],
  );
  const roomName = res.rows[0]?.room_name;
  if (roomName) await this.livekit.removeAgent(roomName, callId);
}
```

И в `LiveKitClient`:

```typescript
/**
 * Выгнать из комнаты только участника-агента.
 *
 * closeRoom здесь нельзя: в комнате живые люди, и удаление комнаты выкинет
 * их всех. Identity агента задаёт фреймворк при dispatch — если она окажется
 * непредсказуемой, брать её из room.participants по признаку агента.
 */
async removeAgent(roomName: string, callId: string): Promise<void> {
  const client = new RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret);
  const participants = await client.listParticipants(roomName);
  for (const p of participants) {
    if (p.identity.includes(callId) || p.kind === ParticipantInfo_Kind.AGENT) {
      await client.removeParticipant(roomName, p.identity);
    }
  }
}
```

⚠️ Проверить в Task 1, какую identity фреймворк даёт агенту — от этого зависит условие. Если по ней не опознать, оставить только проверку `kind`.

- [ ] **Step 5: Контроллер и модуль**

```typescript
// src/meeting/meeting.controller.ts
@Controller('meeting')
@UseGuards(JwtGuard)
export class MeetingController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly calls: VoiceCallService,
  ) {}

  @Post('join')
  async join(@CurrentUser() u: any, @Body() body: { agentId: number; code: string }) {
    if (!u?.isAdmin) throw new ForbiddenException('meetings are admin-only in v1');
    return this.meetings.join(u.userId, Number(body.agentId), body.code, u.name || 'пользователя');
  }

  @Post(':id/leave')
  async leave(@CurrentUser() u: any, @Param('id') id: string) {
    const call = await this.calls.load(id);
    if (call.user_id !== u.userId) throw new ForbiddenException('not your meeting');
    await this.meetings.leave(id);
    return { ok: true };
  }
}
```

Модуль `MeetingModule` импортирует `CommonModule` и `VoiceCallModule`, регистрирует `RoomService`, `RoomController`, `RoomRateLimit`, `MeetingService`, `MeetingController`. `VoiceCallModule` должен экспортировать `LiveKitClient` и `VoiceCallService`.

- [ ] **Step 6: Ручка для воркера**

В `voice-call-internal.controller.ts`, рядом с соседними подписанными:

```typescript
@Post('meeting-first-human')
async meetingFirstHuman(@Headers('x-voice-signature') signature: string, @Req() req: Request) {
  const body = this.parseSigned<{ callId: string }>(req, signature);
  await this.meetings.noteFirstHuman(body.callId);
  return { ok: true };
}
```

Проверить, что путь попадает под сырой парсер тела в `main.ts` — там должен быть указан префикс, а не полные пути каждой ручки.

- [ ] **Step 7: Параметризовать `buildPreamble`**

`voice-call.service.ts:49` жёстко читает историю чата с Романом:

```typescript
async buildPreamble(userId: string, agentId: number = HOST_AGENT_ID): Promise<string> {
  const res = await this.pg.query(
    `SELECT sender_type, content FROM custom_chat_history
     WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [`${userId}_${agentId}`, PREAMBLE_MSG_LIMIT],
  );
  // …
}
```

Внутри цикла подпись `'Роман'` заменить на нейтральное `'Ассистент'`: preamble уходит модели, которая сама и есть этот ассистент, и чужое имя в её собственных репликах сбивает.

- [ ] **Step 8: Прогнать тесты**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting src/voice-call --silent'`

Expected: PASS. Существующие тесты `voice-call.service.spec.ts` не должны покраснеть от правки `buildPreamble`. Спека требует автотест на идемпотентность `complete` — он **уже есть** (`voice-call.service.spec.ts:133`), заводить второй не надо, надо убедиться что остался зелёным.

- [ ] **Step 9: Коммит**

```bash
git add src/meeting/ src/voice-call/
git commit -m "feat(meeting): вход ассистента во встречу Linkeon"
```

---

## Task 11: Карточка встречи в чате

**Files:**
- Create: `src/chat/meeting-card.ts`, `src/chat/meeting-card.spec.ts`
- Modify: `src/chat/chat.service.ts` (~строка 483), `src/chat/chat.module.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/chat/meeting-card.spec.ts
import { buildMeetingCard } from './meeting-card';

describe('buildMeetingCard', () => {
  it('собирает тег с кодом и названием', () => {
    expect(buildMeetingCard('ABC234', 'Планёрка'))
      .toBe('{{meeting_join: code=ABC234 title=Планёрка}}');
  });

  it('вычищает фигурные скобки и переводы строк', () => {
    // Название задаёт пользователь. Скобка внутри рвёт разбор на фронте, и
    // вместо карточки он видит сырой текст тега.
    expect(buildMeetingCard('ABC234', 'Пла}}нёрка\nвтор'))
      .toBe('{{meeting_join: code=ABC234 title=Планёрка втор}}');
  });

  it('переживает пустое название', () => {
    expect(buildMeetingCard('ABC234', '')).toBe('{{meeting_join: code=ABC234 title=Встреча}}');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/chat/meeting-card.spec.ts`
Expected: FAIL — модуля нет

- [ ] **Step 3: Реализовать**

```typescript
// src/chat/meeting-card.ts

/** Убрать всё, что сломает разбор тега на фронте. */
function clean(s: string): string {
  return (s || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildMeetingCard(code: string, title: string): string {
  return `{{meeting_join: code=${code} title=${clean(title) || 'Встреча'}}}`;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/chat/meeting-card.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Замкнуть ход в `streamChat`**

Вставить после вычисления `chatSessionId` и до ветки `smm_producer` (`chat.service.ts:485`):

```typescript
// Ссылка на комнату замыкает ход: показываем карточку «Зайти во встречу» и в
// модель не идём. Иначе за каждую вставленную ссылку платим ход LLM и получаем
// два ответа — карточку и рассуждение ассистента о ней.
const link = parseMeetingLink(message);
if (link) {
  const room = await this.rooms.info(link.code);
  if (room?.active) {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'human', $2, $3, 'text')`,
      [chatSessionId, agent.id, message],
    );

    const card = buildMeetingCard(room.code, room.title);
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
       VALUES ($1, 'ai', $2, $3, 'text', 0)`,
      [chatSessionId, agent.id, card],
    );

    res.write(JSON.stringify({ type: 'begin' }) + '\n');
    res.write(JSON.stringify({ type: 'item', content: card }) + '\n');
    res.write(JSON.stringify({ type: 'end', content: card, usage: { input: 0, output: 0, total: 0 } }) + '\n');
    res.end();
    return;
  }
  // Комнаты нет или закрыта — это была обычная ссылка в разговоре, идём дальше.
}
```

`RoomService` внедрить в конструктор `ChatService`, `MeetingModule` — в импорты `ChatModule`. **Проверить на циклический импорт:** `MeetingModule` импортирует `VoiceCallModule`, а тот — `ChatModule`. Если Nest ругается — вынести `RoomService` в отдельный модуль без зависимости от `VoiceCallModule` либо обернуть в `forwardRef`.

- [ ] **Step 6: Прогнать тесты и сборку**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/chat --silent && npm run build'`
Expected: PASS, сборка проходит — она же поймает циклический импорт

- [ ] **Step 7: Коммит**

```bash
git add src/chat/
git commit -m "feat(meeting): карточка «Зайти во встречу» по ссылке в чате"
```

---

## Task 12: Фронт — страница комнаты

**Files:**
- Create: `src/components/room/useRoom.ts`, `src/components/room/JoinForm.tsx`, `src/components/room/RoomStage.tsx`, `src/pages/RoomPage.tsx`
- Modify: `src/App.tsx`, `package.json`

Репозиторий: `~/Downloads/spirits_front`.

- [ ] **Step 1: Поставить клиент LiveKit**

```bash
cd ~/Downloads/spirits_front && pnpm add livekit-client
```

- [ ] **Step 2: Хук подключения**

```typescript
// src/components/room/useRoom.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

export interface Peer {
  identity: string;
  name: string;
  speaking: boolean;
}

/**
 * Подключение к голосовой комнате.
 *
 * Только аудио: видео и демонстрации экрана в v1 нет, камеру не просим вовсе —
 * лишний запрос разрешения отпугивает гостя, которому просто дали ссылку.
 */
export function useRoom() {
  const roomRef = useRef<Room | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [micOn, setMicOn] = useState(true);

  const refresh = useCallback((room: Room) => {
    const list: Peer[] = [...room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      name: p.name || p.identity,
      speaking: p.isSpeaking,
    }));
    list.unshift({
      identity: room.localParticipant.identity,
      name: room.localParticipant.name || 'Вы',
      speaking: room.localParticipant.isSpeaking,
    });
    setPeers(list);
  }, []);

  const connect = useCallback(async (wsUrl: string, token: string) => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      // Звук отдаём через элемент, который создаёт сам SDK: своя <audio> в
      // React-дереве переживает ре-рендер плохо и глохнет на переподключении.
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
    });

    for (const ev of [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.ActiveSpeakersChanged,
    ]) {
      room.on(ev as any, () => refresh(room));
    }

    await room.connect(wsUrl, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    setConnected(true);
    refresh(room);
  }, [refresh]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  }, [micOn]);

  const leave = useCallback(async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setConnected(false);
  }, []);

  // Уход со страницы обязан рвать соединение: иначе участник остаётся в
  // комнате призраком, и правило «все ушли → ассистент выходит» не сработает.
  useEffect(() => () => { void roomRef.current?.disconnect(); }, []);

  return { peers, connected, micOn, connect, toggleMic, leave };
}
```

- [ ] **Step 3: Форма входа и сцена**

`JoinForm` — поле имени и кнопка «Войти»; по нажатию `POST /webhook/room/public/:code/join`, затем `connect(wsUrl, token)`. Ошибку показывать текстом, не молчать.

`RoomStage` — название встречи, список `peers` с подсветкой `speaking`, кнопки микрофона и выхода. Ассистента в списке видно как обычного участника — отдельной пометки в v1 нет.

- [ ] **Step 4: Страница и маршрут**

```tsx
// src/pages/RoomPage.tsx — по коду из useParams грузит GET /webhook/room/public/:code,
// показывает JoinForm до входа и RoomStage после.
```

В `App.tsx` маршрут `/room/:code` **вне блока авторизации** — гости не пользователи Linkeon. Смотреть, как сделан публичный `/tokens`, и повторить.

- [ ] **Step 5: Строки в семи локалях**

Блок `room` рядом с `chat.voice_call`, во **все семь** файлов (`ru`, `en`, `es`, `de`, `fr`, `pt`, `zh`):

```json
"room": {
  "your_name": "Как вас зовут?",
  "join": "Войти",
  "joining": "Подключение…",
  "not_found": "Встреча не найдена или уже закончилась",
  "join_failed": "Не удалось подключиться",
  "mic_on": "Микрофон включён",
  "mic_off": "Микрофон выключен",
  "leave": "Выйти",
  "participants": "Участники"
}
```

Множественных форм не заводим: категории по языкам разные, `_few`/`_many` из русского в чужую локаль не переносятся. Понадобится счётчик — брать категории из `Intl.PluralRules`.

- [ ] **Step 6: Проверить полноту локалей**

```bash
cd ~/Downloads/spirits_front
for f in src/i18n/locales/*.json; do
  echo -n "$f: "; node -e "const j=require('./$f'); console.log(Object.keys(j.room||{}).length)"
done
```

Expected: `9` во всех семи.

- [ ] **Step 7: Собрать на ноде**

```bash
git push -u origin <ветка>
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front checkout -q <sha>'
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && source ~/.nvm/nvm.sh && pnpm install && pnpm test && pnpm build'
```

Expected: тесты зелёные, сборка проходит

- [ ] **Step 8: Коммит**

```bash
git add src/components/room/ src/pages/RoomPage.tsx src/App.tsx src/i18n/locales/ package.json pnpm-lock.yaml
git commit -m "feat(room): публичная голосовая комната Linkeon"
```

---

## Task 13: Фронт — создание встречи, карточка, плашка

**Files:**
- Create: `src/components/chat/MeetingJoinCard.tsx`, `MeetingStatusBar.tsx`, `CreateMeetingButton.tsx`
- Modify: `src/utils/customMarkdown.tsx`, `customMarkdown.test.ts`, `ChatInterface.tsx`, `VoiceCallCard.tsx`, локали

- [ ] **Step 1: Написать падающий тест разбора тега**

```typescript
// в src/utils/customMarkdown.test.ts
describe('meeting_join', () => {
  it('вынимает код и название', () => {
    const { meetings } = parseCustomMarkdown('{{meeting_join: code=ABC234 title=Планёрка}}');
    expect([...meetings.values()][0]).toEqual({ code: 'ABC234', title: 'Планёрка' });
  });

  it('не трогает обычный текст', () => {
    expect(parseCustomMarkdown('просто сообщение').meetings.size).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx vitest run src/utils/customMarkdown.test.ts`
Expected: FAIL — `meetings` нет в результате

- [ ] **Step 3: Добавить разбор тега**

По образцу `VOICE_CALL_REGEX` (`customMarkdown.tsx:44`):

```typescript
// Карточка входа во встречу: бэкенд, увидев в сообщении ссылку на комнату,
// кладёт в историю сообщение ассистента с этим тегом вместо ответа модели.
// Как и у voice_call, тег подменяется маркером, чтобы карточка ожила из
// сохранённой истории, а не только в момент отправки.
const MEETING_JOIN_REGEX = /\{\{meeting_join:\s*code=([A-Z0-9]{6})\s+title=([^}]*?)\}\}/g;
```

Добавить `meetings: Map<string, { code: string; title: string }>` в возвращаемый тип и в тело — по образцу `voiceCalls`.

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx vitest run src/utils/customMarkdown.test.ts`
Expected: PASS

- [ ] **Step 5: Карточка входа**

```tsx
// src/components/chat/MeetingJoinCard.tsx
export default function MeetingJoinCard({ code, title, agentId, onJoined }: {
  code: string; title: string; agentId: number; onJoined: (callId: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post('/webhook/meeting/join', { agentId, code });
      if (!res.ok) {
        // 409 — ассистент уже где-то сидит. Не поломка, и текст должен
        // объяснять, что делать, а не пугать.
        throw new Error(res.status === 409 ? t('chat.meeting.already_in') : t('chat.meeting.join_failed'));
      }
      onJoined((await res.json()).callId);
    } catch (e: any) {
      setError(e?.message || t('chat.meeting.join_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-2 rounded-xl border border-forest-200 bg-forest-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <Video className="w-4 h-4 text-forest-700 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-forest-900 truncate">{title}</p>
          <p className="text-xs text-gray-500">{code}</p>
        </div>
        <button onClick={join} disabled={busy} data-testid="meeting-join"
          className="px-3 py-1.5 rounded-lg bg-forest-700 text-white text-xs font-medium disabled:opacity-50 hover:bg-forest-800 transition-colors">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t('chat.meeting.join')}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Плашка статуса и кнопка создания**

`MeetingStatusBar` — «Ассистент на встрече» + «Выйти» (`POST /webhook/meeting/:id/leave`, ошибку глотаем: ассистент мог выйти сам).

`CreateMeetingButton` — `POST /webhook/room` с названием, показывает готовую ссылку `${location.origin}/room/${code}` и кнопку «Скопировать».

- [ ] **Step 7: Подключить в `ChatInterface`**

```tsx
// Ассистент сидит во встрече. null — не сидит.
const [meetingCallId, setMeetingCallId] = useState<string | null>(null);
```

Плашка — первым элементом над лентой:

```tsx
{meetingCallId && <MeetingStatusBar callId={meetingCallId} onLeft={() => setMeetingCallId(null)} />}
```

Карточка — в обоих местах, где рендерится `VoiceCallCard` (`ChatInterface.tsx:244` и `:2499`):

```tsx
const meeting = meetings.get(marker);
if (meeting) {
  parts.push(
    <MeetingJoinCard key={`meeting-${idx}`} code={meeting.code} title={meeting.title}
      agentId={Number(selectedAssistant.id)} onJoined={setMeetingCallId} />,
  );
  return;
}
```

`agentId` — из текущего выбранного ассистента: карточка живёт в его чате, и заходить должен он. Если переменная называется иначе, взять существующее имя.

- [ ] **Step 8: Имена говорящих в расшифровке**

`VoiceCallCard.tsx:81` рисует роль двумя вариантами — «Вы» и «Ассистент». На встрече людей несколько, и «Вы» там неверно: реплику мог сказать клиент.

```tsx
<span className="font-medium text-forest-800">
  {line.role === 'user'
    ? line.speaker || t('chat.voice_call.speaker_you')
    : t('chat.voice_call.speaker_assistant')}:
</span>{' '}
```

```tsx
transcript: { role: 'user' | 'assistant'; text: string; ts: number; speaker?: string }[] | null;
```

Фолбэк на «Вы» обязателен: у звонков в истории `speaker` нет и не появится, а карточка одна на звонок и встречу.

- [ ] **Step 9: Строки в семи локалях**

```json
"meeting": {
  "join": "Зайти",
  "in_progress": "Ассистент на встрече",
  "leave": "Выйти",
  "already_in": "Ассистент уже на другой встрече или на звонке",
  "join_failed": "Не удалось зайти во встречу",
  "create": "Создать встречу",
  "copy_link": "Скопировать ссылку",
  "link_copied": "Ссылка скопирована"
}
```

- [ ] **Step 10: Проверить полноту и собрать**

```bash
for f in src/i18n/locales/*.json; do
  echo -n "$f: "; node -e "const j=require('./$f'); console.log(Object.keys(j.chat?.meeting||{}).length)"
done
```

Expected: `8` во всех семи. Затем сборка на ноде, как в Task 12 Step 7.

- [ ] **Step 11: Коммит**

```bash
git add src/components/chat/ src/utils/customMarkdown.tsx src/utils/customMarkdown.test.ts src/i18n/locales/
git commit -m "feat(meeting): создание встречи, карточка входа, имена в расшифровке"
```

---

## Task 14: Реапер — порог для встреч

**Files:**
- Modify: `src/voice-call/voice-call-reaper.service.ts`
- Test: `src/voice-call/voice-call-reaper.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/voice-call/voice-call-reaper.spec.ts
import { VoiceCallReaperService } from './voice-call-reaper.service';

describe('VoiceCallReaperService', () => {
  it('порог для встречи больше, чем для звонка', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const livekit = { closeRoom: jest.fn(), removeAgent: jest.fn() };
    await new VoiceCallReaperService(pg as any, livekit as any).reap();

    const call = pg.query.mock.calls.find(([s]: [string]) => s.includes("provider = 'linkeon'"));
    const meeting = pg.query.mock.calls.find(([s]: [string]) => s.includes("provider <> 'linkeon'"));
    expect(Number(call![1][0])).toBeLessThan(Number(meeting![1][0]));
  });

  it('у зависшей встречи выгоняет агента, но НЕ закрывает комнату с людьми', async () => {
    const pg = {
      query: jest.fn().mockImplementation(async (sql: string) =>
        sql.includes("provider <> 'linkeon'")
          ? { rows: [{ id: 'stale', room_name: 'room_ABC234' }], rowCount: 1 }
          : { rows: [], rowCount: 0 }),
    };
    const livekit = { closeRoom: jest.fn(), removeAgent: jest.fn() };
    await new VoiceCallReaperService(pg as any, livekit as any).reap();

    expect(livekit.removeAgent).toHaveBeenCalledWith('room_ABC234', 'stale');
    expect(livekit.closeRoom).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/voice-call/voice-call-reaper.spec.ts`
Expected: FAIL — запросов с `provider` нет

- [ ] **Step 3: Реализовать**

```typescript
/** Звонок: наш потолок час плюс запас. */
const STALE_CALL_MS = 70 * 60 * 1000;
/**
 * Встреча: потолок два часа плюс запас.
 *
 * Отдельный порог обязателен. С общим часовым реапер подбирал бы живые встречи
 * на втором часу и обрывал их как зависшие — то есть предохранитель убивал бы
 * ровно то, ради чего потолок и подняли.
 */
const STALE_MEETING_MS = 130 * 60 * 1000;
```

```typescript
const stale = await this.pg.query(
  `UPDATE voice_calls SET status = 'interrupted', ended_at = now()
    WHERE status IN ('dialing','active') AND provider = 'linkeon'
      AND started_at < now() - ($1 || ' milliseconds')::interval
    RETURNING id, room_name`,
  [String(STALE_CALL_MS)],
);
for (const row of stale.rows) {
  this.logger.warn(`[reap] звонок ${row.id} висел дольше порога — закрываю комнату`);
  await this.livekit.closeRoom(row.room_name);
}

const staleMeetings = await this.pg.query(
  `UPDATE voice_calls SET status = 'interrupted', ended_at = now()
    WHERE status IN ('dialing','active') AND provider <> 'linkeon'
      AND started_at < now() - ($1 || ' milliseconds')::interval
    RETURNING id, room_name`,
  [String(STALE_MEETING_MS)],
);
for (const row of staleMeetings.rows) {
  this.logger.warn(`[reap] встреча ${row.id} висела дольше порога — выгоняю ассистента`);
  // Комнату НЕ закрываем: в ней могут быть живые люди, и закрытие выкинет их
  // всех из-за того, что зависла наша половина.
  await this.livekit.removeAgent(row.room_name, row.id);
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/voice-call/voice-call-reaper.spec.ts`
Expected: PASS, 2 теста

- [ ] **Step 5: Коммит**

```bash
git add src/voice-call/voice-call-reaper.service.ts src/voice-call/voice-call-reaper.spec.ts
git commit -m "feat(meeting): отдельный порог реапера для встреч"
```

---

## Task 15: Окружение и выкат

- [ ] **Step 1: Переменные окружения**

В `.env` бэкенда на тесте и проде:

```env
# Модель встречи. Отдельно от VOICE_MODEL: звонок остаётся на флагмане.
VOICE_MEETING_MODEL=gpt-realtime-2.1-mini
```

Та же строка — в `voice-host/.env`, её читает воркер. `LIVEKIT_*`, `VOICE_CALLBACK_SECRET`, `BACKEND_URL` уже заданы для звонка.

- [ ] **Step 2: Колонка голоса у ассистентов**

`meeting.service.ts` читает `agents.realtime_voice`. Если колонки нет:

```sql
-- src/meeting/migrations/002_agent_realtime_voice.sql
-- Голос ассистента в Realtime. NULL — дефолт из env.
--
-- Голосов у Realtime десять на двадцать с лишним ассистентов, часть будет
-- звучать одинаково. Подбирать НА СЛУХ: в agent.ts на этом месте стоит
-- предупреждение, там дважды промахнулись мимо пола голоса по описанию.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS realtime_voice TEXT;
```

- [ ] **Step 3: Применить миграции на проде вручную**

`npm run migrate` на проде **не работает**: раннер застревает на `base/001` (`CREATE TYPE payment_status_enum`) и не докатывает ничего после. Применять через psql и вручную отмечать в `schema_migrations`, иначе следующий запуск раннера попробует применить повторно.

```bash
ssh dvolkov@212.113.106.202 'psql "$DATABASE_URL" -f ~/spirits_back/src/meeting/migrations/001_meeting_rooms.sql'
ssh dvolkov@212.113.106.202 'psql "$DATABASE_URL" -f ~/spirits_back/src/meeting/migrations/002_agent_realtime_voice.sql'
ssh dvolkov@212.113.106.202 'psql "$DATABASE_URL" -c "INSERT INTO schema_migrations (filename) VALUES (\x27meeting/001_meeting_rooms.sql\x27), (\x27meeting/002_agent_realtime_voice.sql\x27) ON CONFLICT DO NOTHING"'
```

- [ ] **Step 4: Проверить nginx на маршруте `/room/`**

Фронт — SPA, Nginx отдаёт `index.html` на все маршруты. Убедиться, что `/room/ABC234` попадает в SPA-фолбэк, а не в 404 и не в проксирование на API.

⚠️ **SPA-фолбэк подделывает 200**: на linkeon.io любой путь отдаёт 200 с HTML. Проверять `content-type` и содержимое, а не код ответа.

- [ ] **Step 5: Живая проверка на тесте**

Двухфазный `deploy.sh` сам катит сначала на `test.linkeon.io`. **Не запускать без явного согласия владельца** — раскатку может вести параллельная сессия. Фоновый запуск **без `tail`**: конвейер копит вывод до конца, лог все десять минут выглядит пустым.

Сценарий на тесте:
1. Создать встречу, получить ссылку.
2. Открыть ссылку в двух разных браузерах, войти под разными именами — слышно друг друга.
3. Кинуть ссылку в чат с ассистентом — появляется карточка, а не ответ модели.
4. «Зайти» — ассистент появляется в списке участников и произносит представление с правилом обращения.
5. Поговорить вдвоём две минуты — ассистент молчит.
6. Позвать по имени — отвечает. Доспросить без имени в течение 30 секунд — отвечает. Подождать минуту и доспросить — молчит.
7. «Роман, пока слушай» — подтверждает и замолкает. Позвать по имени — молчит. «Роман, вопрос к тебе» — возвращается.
8. Попросить спросить коллегу — приходит ответ специалиста.
9. Всем выйти — ассистент выходит, в ленте карточка с резюме, **в расшифровке видны имена**.
10. Проверить учёт: `SELECT provider, model, duration_sec, cost_usd FROM voice_calls ORDER BY started_at DESC LIMIT 1` — модель обязана быть `gpt-realtime-2.1-mini`.

- [ ] **Step 6: Проверить, что сборка доехала**

`deploy.sh` глотал падение сборки подпроектов: `set -e` без `pipefail` плюс `| tail`. Сверять не «файл на месте», а свежесть:

```bash
ssh dv@85.192.61.231 'pm2 list | grep linkeon-voice-host'
ssh dv@85.192.61.231 'stat -c "%y %n" ~/spirits_back/voice-host/dist/agent.js'
```

Expected: процесс `online` с ненулевым аптаймом (нулевой = цикл перезапусков), время файла — сегодняшнее.

---

## Результаты спайка

Часть Task 1 выполнена 27.08.2026 **статически** — по объявлениям типов
`@livekit/agents@1.7.0` и `@livekit/agents-plugin-openai@1.7.0`. Оба риска сняты, живая
сессия для этого не понадобилась. Что осталось на живой прогон — в конце раздела.

### Риск 2 — снят. `create_response` есть

`api_proto.d.ts:44-56` объявляет `TurnDetectionType` для обоих режимов VAD:

```typescript
export type TurnDetectionType =
  | { type: 'semantic_vad'; eagerness?: …; create_response?: boolean; interrupt_response?: boolean }
  | { type: 'server_vad'; threshold?: number; prefix_padding_ms?: number;
      silence_duration_ms?: number; create_response?: boolean; interrupt_response?: boolean };
```

Плагин принимает `turnDetection` этого типа и передаёт в сессию. **Гейт по имени
жизнеспособен, запасной путь (генерировать всегда и глушить) не нужен.**

Заодно нашлось `interrupt_response` — им же выключается перебивание ассистента чужой
речью. На встрече это, скорее всего, нужно: перебить его должен тот, кто к нему
обратился, а не любой звук в переговорной. В план не заложено, проверить на живой встрече.

### Риск 1 — подтвердился. `AgentSession` слышит ровно одного

`RoomInputOptions.participantIdentity` (`room_io.d.ts`):

> The participant to link to. **If not provided, link to the first participant.**

И вход устроен строго под одного: `ParticipantAudioInputStream` держит одну
`participantIdentity`, одну `publication` и метод `setParticipant()`. То есть в комнате на
пятерых ассистент слышал бы **только того, кто вошёл первым**.

Там же нашлось второе, не менее опасное: `closeOnDisconnect` — «Close the AgentSession if
the linked participant disconnects». Первый вошедший выходит покурить — сессия
закрывается, хотя встреча идёт. **Обязательно `false`.**

### Решение оказалось чище, чем ожидалось

`AgentInput` (`io.d.ts:167-178`) имеет **сеттер**:

```typescript
get audio(): AudioInput | null;
set audio(stream: AudioInput | null);
```

Значит вход можно подменить своим: подписаться на всех участников, свести в один поток и
отдать сессии. Ни фиктивного участника, ни второй комнаты, ни моста — того самого, ради
которого затевалась отменённая редакция.

### Почему именно сведение, а не встроенный fan-in

`AudioInput.multiStream` — это `MultiInputStream<AudioFrame>`, и он умеет
`addInputStream()` для каждого участника. Соблазнительно: свести не нужно вовсе, фреймворк
сам всё смерджит.

**Так делать нельзя.** `MultiInputStream` — «fan-in multiplexer that merges multiple
inputs into a single output», то есть он **перемежает кадры, а не складывает сэмплы**.
Пока говорит один — сойдёт. Но дорожки LiveKit публикуются непрерывно, и при пятерых
участниках в поток пошло бы пять кадров на каждые 20 мс реального времени: Realtime
получал бы аудио впятеро быстрее реального и не понял бы ничего — не только во время
наложения речи, а всё время.

Оговорка: если у дорожек включён DTX, молчащие участники не шлют ничего, и эффект слабее.
Полагаться на это нельзя — DTX зависит от настроек публикации, а сведение корректно в
обоих случаях. **Микшер из отменённой редакции возвращается** (Task 8а), но теперь как
источник для `session.input.audio`, а не как отдельный процесс.

### Что осталось проверить живьём

Статика не отвечает на три вопроса, и они требуют комнаты с двумя говорящими людьми:

1. Нет ли у `session.input.audio` состязания с `RoomIO`: порядок присвоения и нужно ли
   гасить его вход через `inputOptions: { audioEnabled: false }`.
2. Принимает ли OpenAI `create_response: false` **у mini** — типы плагина общие для всех
   моделей, а поддержка может отличаться.
3. Голос `cedar` на mini: есть ли он и звучит ли мужским.

Это Task 1 Steps 2–4 в исходном виде. Сделать на первой же живой комнате — то есть после
Task 12.

---

## Что осталось за рамками

Zoom (следующий шаг: Attendee + мост, который здесь не понадобился), Google Meet, Телемост. Видео, демонстрация экрана, чат в комнате, запись в файл. Настоящая диаризация. Списание аудио с баланса. Вход по календарю заранее. Доступ кому-либо кроме админов. Планирование встреч, повторяющиеся комнаты, waiting room, модерация.
