# Мост «ассистент во внешней встрече» (Taler ID) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь кидает в чат с ассистентом ссылку на комнату Taler ID, жмёт «Зайти» — ассистент входит в встречу участником, молчит, пока не назовут по имени, и по окончании кладёт в ленту резюме.

**Architecture:** Отдельный процесс-мост держит два конца — комнату Taler ID (участником, по публичному токену) и нашу LiveKit-комнату. Аудио всех участников встречи сводится в одну дорожку и публикуется в нашу комнату; звук ассистента идёт обратно. Воркер `voice-host` в чужую комнату не ходит: он как сидел в нашей комнате по dispatch, так и сидит.

**Tech Stack:** NestJS 10 + Postgres (бэкенд), `@livekit/agents` 1.7 + `@livekit/rtc-node` 0.13 + OpenAI Realtime (воркер и мост), React 18 + i18next (фронт), pm2 (процессы).

**Спека:** `docs/superpowers/specs/2026-08-27-meeting-bridge-talerid-design.md` — читать целиком перед началом.

---

## Решения, принятые при написании плана

Спека их не фиксировала, а реализация без них невозможна. Если владелец не согласен — правится здесь, до начала работ.

1. **Ссылка в чате не вызывает ответ ассистента.** Обнаружив ссылку на живую комнату, бэкенд коротко замыкает ход: пишет сообщение пользователя в историю, отдаёт карточку `{{meeting_join:…}}` и не идёт в модель. Иначе за каждую вставленную ссылку платим ход LLM и получаем два ответа вместо одного. Прецедент уже есть — `chat.service.ts:643-658` (приветствие) и `:466-468` (нет токенов) замыкают ход ровно так же.
2. **Мост живёт внутри пакета `voice-host/`, вторым процессом pm2.** Не отдельный пакет: `deploy.sh:200-207` уже собирает `voice-host` и делает `pm2 startOrReload` его `ecosystem.config.cjs`. Второе приложение в том же файле подхватывается без единой правки в `deploy.sh`, а `backend.ts` и `hmac` переиспользуются вместо копирования.
3. **Частота и формат аудио на всём пути — 48 кГц, моно, Int16.** `AudioStream` умеет отдавать в заданной частоте, `AudioSource` принимает в ней же. Ресемплинга в нашем коде нет нигде.
4. **Сведение — тик 20 мс с джиттер-буфером на участника.** Кадры от разных участников приходят вразнобой; тикер каждые 20 мс забирает по 960 сэмплов из буфера каждого, суммирует с ограничением и отдаёт один кадр. Нет данных — тишина.

---

## Структура файлов

**Бэкенд** (`~/Downloads/spirits_back/src/`):

| Файл | Ответственность |
|---|---|
| `voice-call/meeting-link.ts` | Разбор ссылки Taler ID → код комнаты. Чистая функция |
| `voice-call/meeting-link.spec.ts` | Тесты разбора |
| `voice-call/talerid-room.client.ts` | HTTP к Taler ID: инфо о комнате, получение токена |
| `voice-call/talerid-room.client.spec.ts` | Тесты клиента на замоканном fetch |
| `voice-call/meeting.service.ts` | Жизненный цикл входа: запись в `voice_calls`, токен, dispatch, запуск моста, выход |
| `voice-call/meeting.service.spec.ts` | Тесты сервиса |
| `voice-call/meeting.controller.ts` | `POST /webhook/meeting/join`, `POST /webhook/meeting/:id/leave`, `GET /webhook/meeting/active` |
| `voice-call/bridge.client.ts` | HTTP-команды мосту (`start`/`stop`), подпись HMAC |
| `voice-call/migrations/003_meeting_provider.sql` | `provider`, `external_room` в `voice_calls` |
| `voice-call/voice-call.types.ts` | +провайдеры, +константы окон (правка) |
| `voice-call/voice-call.service.ts` | Параметризация `agentId` и preamble (правка) |
| `voice-call/voice-call-internal.controller.ts` | +ручка `meeting-empty` от моста (правка) |
| `voice-call/voice-call-reaper.service.ts` | Потолок 2 часа для встреч (правка) |
| `voice-call/voice-call.module.ts` | Регистрация новых провайдеров (правка) |
| `chat/chat.service.ts` | Короткое замыкание хода на карточку (правка, ~строка 483) |

**Воркер и мост** (`~/Downloads/spirits_back/voice-host/src/`):

| Файл | Ответственность |
|---|---|
| `name-gate.ts` | Обращались ли по имени; окно продолжения. Чистая логика |
| `name-gate.test.ts` | Тесты гейта |
| `prompts.ts` | Инструкции для звонка и для встречи |
| `agent.ts` | +режим встречи (правка) |
| `bridge/mixer.ts` | Сведение N потоков Int16 в один. Чистая логика |
| `bridge/mixer.test.ts` | Тесты сведения |
| `bridge/occupancy.ts` | Кто живой в комнате, когда выходить. Чистая логика |
| `bridge/occupancy.test.ts` | Тесты присутствия |
| `bridge/bridge.ts` | Один мост: два `Room`, подписки, публикация |
| `bridge/server.ts` | HTTP-ручки `start`/`stop`, реестр мостов. Точка входа процесса |
| `ecosystem.config.cjs` | +второе приложение `linkeon-room-bridge` (правка) |

**Фронт** (`~/Downloads/spirits_front/src/`):

| Файл | Ответственность |
|---|---|
| `components/chat/MeetingJoinCard.tsx` | Карточка «Зайти во встречу» |
| `components/chat/MeetingStatusBar.tsx` | Плашка «ассистент на встрече» + «Выйти» |
| `components/chat/useMeeting.ts` | Состояние встречи, опрос статуса |
| `utils/customMarkdown.tsx` | Тег `{{meeting_join:…}}` (правка) |
| `utils/customMarkdown.test.ts` | Тесты тега (правка) |
| `components/chat/ChatInterface.tsx` | Подключение карточки и плашки (правка) |
| `i18n/locales/{ru,en,es,de,fr,pt,zh}.json` | Строки (правка) |

---

## Где что запускать

**Тесты и сборки — на тестовой ноде, не на маке** (`CLAUDE.md`, «Сборки и тесты»). Мак не тянет: `pnpm build` на ноде 6 секунд, полный jest на маке уходит в таймаут 300 с.

```bash
# локально: закоммитить и запушить ветку
git push -u origin <ветка>

# на ноде: CI-клон на конкретный sha (не на имя ветки — туда коммитит параллельная сессия)
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q <sha>'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npm ci && npx jest src/voice-call --silent'
```

`source ~/.nvm/nvm.sh` обязателен в каждой ssh-команде. Работать только в `~/ci/`, никогда в `~/spirits_back` — оттуда работает живой API `test.linkeon.io`.

**`npm test` в `spirits_back` красный и без наших правок** (jest скребёт `.worktrees/`, два теста падают на `main`). Свою работу мерить дельтой: запускать точечно `npx jest src/voice-call`, `npx jest src/chat`.

**Мост и воркер** тестируются `node --test` внутри `voice-host/` — там ESM и свой `package.json`.

---

## Task 1: Спайк — снять два риска до того, как писать всё остальное

Спека называет два места, где рассуждение ничего не доказывает. Пока они не проверены, остальные задачи писать бессмысленно: провал любого меняет архитектуру.

**Files:**
- Create: `voice-host/src/spike/spike-agent-session.ts` (временный, удаляется в конце задачи)

- [ ] **Step 1: Проверить, что `AgentSession` работает с самостоятельно подключённой комнатой**

Воркер сейчас получает `ctx.room` от фреймворка. Мост даст обычную комнату, подключённую руками. Проверяем, что `session.start({ agent, room })` это принимает.

```typescript
// voice-host/src/spike/spike-agent-session.ts
import 'dotenv/config';
import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { Room } from '@livekit/rtc-node';

const url = process.env.LIVEKIT_URL!;
const token = process.env.SPIKE_TOKEN!; // токен участника, выпустить руками

const room = new Room();
await room.connect(url, token, { autoSubscribe: true, dynacast: true });
console.log('connected, participants:', room.remoteParticipants.size);

const session = new voice.AgentSession({
  llm: new openai.realtime.RealtimeModel({ model: 'gpt-realtime-2.1', voice: 'cedar' }),
});

await session.start({
  agent: new voice.Agent({ instructions: 'Скажи по-русски одну короткую фразу и замолчи.' }),
  room,
});
session.generateReply({ instructions: 'Скажи «спайк работает» и замолчи.' });
```

- [ ] **Step 2: Запустить спайк и записать результат**

Токен выпустить локальным скриптом через `livekit-server-sdk` (он уже в зависимостях бэкенда) на тестовый LiveKit.

Run: `cd voice-host && npx tsx src/spike/spike-agent-session.ts`
Expected: процесс подключается, в комнате слышна фраза. Если `session.start` падает или молчит — риск сработал.

**Если сработал:** сведение переезжает внутрь воркера — мост остаётся чистым транспортом, а `AgentSession` получает `ctx.room` как сейчас, и микс приходит туда обычным участником. Это меняет Task 8 и Task 9, но не остальные. Записать вывод в конце файла плана и согласовать с владельцем до продолжения.

- [ ] **Step 3: Проверить, пробрасывает ли плагин `create_response: false`**

На этом флаге держится весь гейт по имени: модель должна распознавать речь, но не начинать ответ сама.

```typescript
const model = new openai.realtime.RealtimeModel({
  model: 'gpt-realtime-2.1',
  voice: 'cedar',
  turnDetection: {
    type: 'server_vad',
    threshold: 0.65,
    prefix_padding_ms: 300,
    silence_duration_ms: 900,
    create_response: false,
  },
});
```

Проверить двумя способами:
1. Типы: `npx tsc --noEmit` — принимает ли `create_response` в объекте `turnDetection`.
2. Поведение: подключиться, поговорить в микрофон — модель обязана молчать, а `session.generateReply()` обязан по-прежнему заставлять её отвечать.

Run: `cd voice-host && npx tsc --noEmit && npx tsx src/spike/spike-agent-session.ts`
Expected: типы проходят, модель на речь не отвечает, на `generateReply` отвечает.

**Если сработал:** прежде чем соглашаться на запасной путь (генерировать всегда и глушить — то есть платить за выброшенное), посмотреть, нельзя ли дотянуться до сырой сессии в обход плагина: `session.llm` хранит клиент Realtime, и `session.update` со своим `turn_detection` может пройти мимо типов плагина.

- [ ] **Step 4: Записать выводы и удалить спайк**

Дописать в конец этого файла раздел «Результаты спайка» — что подтвердилось, что нет, какие задачи меняются.

```bash
rm -rf voice-host/src/spike
git add docs/superpowers/plans/2026-08-27-meeting-bridge-talerid.md
git commit -m "docs: результаты спайка по AgentSession и create_response"
```

---

## Task 2: Разбор ссылки на комнату Taler ID

**Files:**
- Create: `src/voice-call/meeting-link.ts`
- Test: `src/voice-call/meeting-link.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/voice-call/meeting-link.spec.ts
import { parseMeetingLink } from './meeting-link';

describe('parseMeetingLink', () => {
  it('находит код в ссылке на api.talerid.io', () => {
    expect(parseMeetingLink('заходи https://api.talerid.io/room/AB12CD сегодня')).toEqual({
      provider: 'talerid',
      code: 'AB12CD',
    });
  });

  // Их собственная страница отдаётся ещё и с edge-доменов: абсолютные ссылки
  // на api.talerid.io у пользователей из СНГ режет DPI, поэтому в переписке
  // ходят именно эти адреса.
  it.each(['ru.talerid.io', 'ru2.talerid.io', 'talerid.io'])('находит код на %s', (host) => {
    expect(parseMeetingLink(`https://${host}/room/XYZ789`)).toEqual({
      provider: 'talerid',
      code: 'XYZ789',
    });
  });

  it('игнорирует хвост пути и query', () => {
    expect(parseMeetingLink('https://api.talerid.io/room/AB12CD?lang=ru#top')).toEqual({
      provider: 'talerid',
      code: 'AB12CD',
    });
  });

  it('берёт первую ссылку, если их несколько', () => {
    const text = 'https://api.talerid.io/room/FIRST1 или https://api.talerid.io/room/SECOND';
    expect(parseMeetingLink(text)?.code).toBe('FIRST1');
  });

  it('возвращает null на ссылке без кода', () => {
    expect(parseMeetingLink('https://api.talerid.io/room/')).toBeNull();
  });

  it('возвращает null на резюме встречи — это не комната', () => {
    expect(parseMeetingLink('https://api.talerid.io/meeting/caa29d32-f925-43ae-9d73-98ef88ba1b5c')).toBeNull();
  });

  it('возвращает null на постороннем домене', () => {
    expect(parseMeetingLink('https://evil.com/room/AB12CD')).toBeNull();
  });

  it('не ловит домен, который лишь заканчивается на talerid.io', () => {
    expect(parseMeetingLink('https://nottalerid.io/room/AB12CD')).toBeNull();
  });

  it('возвращает null на тексте без ссылок', () => {
    expect(parseMeetingLink('созвонимся завтра')).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/voice-call/meeting-link.spec.ts`
Expected: FAIL — `Cannot find module './meeting-link'`

- [ ] **Step 3: Минимальная реализация**

```typescript
// src/voice-call/meeting-link.ts

/** Провайдеры внешних встреч. Zoom добавится сюда же. */
export type MeetingProvider = 'talerid';

export interface MeetingLink {
  provider: MeetingProvider;
  code: string;
}

/**
 * Хосты, на которых живёт комната Taler ID.
 *
 * Их страница отдаётся не только с api.talerid.io: в её собственном коде есть
 * комментарий, что абсолютные ссылки на api.talerid.io CORP-блокируются и
 * режутся DPI у пользователей из СНГ, поэтому в ходу edge-домены ru/ru2.
 * Ловить надо все, иначе половина реальных ссылок пройдёт мимо.
 *
 * Точка перед talerid.io обязательна: без неё сюда попадёт nottalerid.io.
 */
const TALERID_ROOM_REGEX =
  /https?:\/\/(?:[a-z0-9-]+\.)?talerid\.io\/room\/([A-Za-z0-9_-]+)/i;

/**
 * Первая ссылка на комнату Taler ID в тексте, или null.
 *
 * Первая, а не последняя: если человек прислал две, он почти наверняка имеет
 * в виду ту, о которой говорит дальше по тексту.
 */
export function parseMeetingLink(text: string): MeetingLink | null {
  const m = TALERID_ROOM_REGEX.exec(text || '');
  if (!m) return null;
  return { provider: 'talerid', code: m[1] };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/voice-call/meeting-link.spec.ts`
Expected: PASS, 9 тестов

- [ ] **Step 5: Сломать проверку нарочно**

Зелёный результат ничего не доказывает, пока не увидел, как он краснеет. Временно заменить `talerid\.io` на `example\.io`, прогнать — тесты обязаны упасть. Вернуть обратно.

Run: `npx jest src/voice-call/meeting-link.spec.ts`
Expected: сначала FAIL на 5+ тестах, после возврата PASS

- [ ] **Step 6: Коммит**

```bash
git add src/voice-call/meeting-link.ts src/voice-call/meeting-link.spec.ts
git commit -m "feat(meeting): разбор ссылки на комнату Taler ID"
```

---

## Task 3: Клиент Taler ID

**Files:**
- Create: `src/voice-call/talerid-room.client.ts`
- Test: `src/voice-call/talerid-room.client.spec.ts`

⚠️ **Перед этой задачей — разговор с командой Taler ID.** Публичный вход вытащен реверсом их страницы, а не согласован. Если они дадут штатный путь для серверных участников (тот, которым ходят их рекордер и переводчик) — реализовать его, а этот клиент оставить фолбэком.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/voice-call/talerid-room.client.spec.ts
import { TalerIdRoomClient } from './talerid-room.client';

describe('TalerIdRoomClient', () => {
  let client: TalerIdRoomClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    client = new TalerIdRoomClient();
  });

  it('отдаёт информацию о комнате', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ title: 'Планёрка', creatorName: 'Сергей' }),
    });

    await expect(client.info('AB12CD')).resolves.toEqual({ title: 'Планёрка', creatorName: 'Сергей' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.talerid.io/api/voice/rooms/public/AB12CD',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('возвращает null, если комнаты нет', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ message: 'Room not found' }) });
    await expect(client.info('NOPE')).resolves.toBeNull();
  });

  it('возвращает null при недоступности Taler ID, а не бросает', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client.info('AB12CD')).resolves.toBeNull();
  });

  it('получает токен участника с переданным именем', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'jwt-here' }) });

    await expect(client.join('AB12CD', 'Роман · ассистент')).resolves.toBe('jwt-here');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.talerid.io/api/voice/rooms/public/AB12CD/join',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Роман · ассистент' }),
      }),
    );
  });

  it('бросает, если токен не выдан — молча продолжать нечем', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ message: 'Room not found' }) });
    await expect(client.join('NOPE', 'Роман')).rejects.toThrow('talerid join failed: 404');
  });

  it('бросает, если ответ без токена', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(client.join('AB12CD', 'Роман')).rejects.toThrow('talerid join: no token');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/voice-call/talerid-room.client.spec.ts`
Expected: FAIL — `Cannot find module './talerid-room.client'`

- [ ] **Step 3: Минимальная реализация**

```typescript
// src/voice-call/talerid-room.client.ts
import { Injectable, Logger } from '@nestjs/common';

export interface TalerIdRoomInfo {
  title?: string;
  creatorName?: string;
}

/**
 * Публичный вход в комнату Taler ID.
 *
 * Контракт вытащен чтением их страницы `api.talerid.io/room/`, а не
 * согласован с их командой (проверено 27.08.2026: ручки живые, на
 * несуществующий код обе отвечают 404 «Room not found»). Он может закрыться
 * авторизацией или капчей в любой день, и узнаем мы об этом от пользователя.
 * Поэтому `info()` деградирует в null молча — «комнаты нет» и «Taler ID лежит»
 * для карточки в чате одно и то же, показывать пользователю нечего.
 *
 * `join()` наоборот бросает: если токена нет, входить некуда, и притворяться,
 * что вход состоялся, нельзя.
 */
@Injectable()
export class TalerIdRoomClient {
  private readonly logger = new Logger(TalerIdRoomClient.name);

  private get base(): string {
    return process.env.TALERID_ROOM_API || 'https://api.talerid.io/api';
  }

  async info(code: string): Promise<TalerIdRoomInfo | null> {
    try {
      const res = await fetch(`${this.base}/voice/rooms/public/${encodeURIComponent(code)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as TalerIdRoomInfo;
    } catch (e: any) {
      this.logger.warn(`talerid info ${code}: ${e?.message}`);
      return null;
    }
  }

  async join(code: string, name: string): Promise<string> {
    const res = await fetch(`${this.base}/voice/rooms/public/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`talerid join failed: ${res.status}`);
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error('talerid join: no token');
    return data.token;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/voice-call/talerid-room.client.spec.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/voice-call/talerid-room.client.ts src/voice-call/talerid-room.client.spec.ts
git commit -m "feat(meeting): клиент публичного входа в комнату Taler ID"
```

---

## Task 4: Схема — провайдер и код внешней комнаты

**Files:**
- Create: `src/voice-call/migrations/003_meeting_provider.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- 003_meeting_provider.sql
-- Вход ассистента во внешнюю встречу переиспользует voice_calls: жизненный
-- цикл, завершение, учёт стоимости и карточка в ленте у встречи те же, что у
-- звонка. Отдельная таблица означала бы дублирование complete/fail/reaper.
--
-- provider: 'linkeon' — наш звонок из интерфейса (всё, что было до этого),
-- 'talerid' — комната Taler ID. Дальше сюда добавится 'zoom'.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'linkeon';

-- Код комнаты у провайдера. Не UNIQUE: в одну комнату могут по очереди
-- заходить разные ассистенты разных пользователей, и история этих входов
-- должна сохраняться.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS external_room TEXT;

-- Момент, когда в комнате впервые появился живой участник. Пока NULL —
-- действует ожидание MEETING_LOBBY_MS, а не правило «комната опустела».
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS first_human_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS voice_calls_provider_room_idx
  ON voice_calls (provider, external_room) WHERE external_room IS NOT NULL;
```

- [ ] **Step 2: Проверить миграцию против живой базы на тестовой ноде**

На проде `npm run migrate` не докатывает: раннер застревает на `base/001` (`CREATE TYPE payment_status_enum`) и не применяет ничего после. На тестовой ноде проверяем именно SQL, а не раннер.

```bash
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -f ~/ci/spirits_back/src/voice-call/migrations/003_meeting_provider.sql'
ssh dv@85.192.61.231 'psql "$DATABASE_URL" -c "\d voice_calls"'
```

Expected: три новые колонки и индекс в выводе `\d`. Повторный запуск не падает (`IF NOT EXISTS` везде).

- [ ] **Step 3: Коммит**

```bash
git add src/voice-call/migrations/003_meeting_provider.sql
git commit -m "feat(meeting): provider и external_room в voice_calls"
```

---

## Task 5: Гейт по имени

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
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('погода сегодня хорошая', 1000), 'silent');
  });

  test('отвечает, когда назвали', () => {
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('Роман, твоё мнение?', 1000), 'respond');
  });

  test('внутри окна отвечает и без имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, твоё мнение?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 5000), 'respond');
  });

  test('после истечения окна снова молчит', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, твоё мнение?', 1000);
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
    // noteReplied не вызывался — модель не ответила
    assert.equal(gate.decide('а почему?', 5000), 'silent');
  });

  // Решение владельца 26.08.2026: «Роман, пока слушай» — уходит в режим
  // слушателя. Дословная формулировка в docs/meeting-bot.md.
  test('команда слушать уводит в режим слушателя', () => {
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('Роман, пока слушай', 1000), 'ack_listen');
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
    // Иначе фраза «вопрос к тебе», сказанная одним человеком другому,
    // возвращала бы ассистента в разговор, из которого его убрали.
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('вопрос к тебе, Сергей', 2000), 'silent');
  });

  test('обычное обращение вне режима слушателя не считается командой', () => {
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('Роман, вопрос к тебе', 1000), 'respond');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd voice-host && npx tsx --test src/name-gate.test.ts`
Expected: FAIL — `Cannot find module './name-gate.js'`

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

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Основа имени для склонения: у имён на гласную она без неё (Анна → анн),
 * у остальных — само имя (Роман → роман).
 */
function stemOf(name: string): string {
  const n = normalize(name).trim();
  return /[аеиоуыэюя]$/.test(n) ? n.slice(0, -1) : n;
}

/** Прозвучало ли в реплике обращение к ассистенту с этим именем. */
export function addressedByName(text: string, name: string): boolean {
  const stem = stemOf(name);
  if (!stem) return false;
  const words = normalize(text).split(/[^a-zа-я0-9]+/).filter(Boolean);
  return words.some((w) => {
    if (!w.startsWith(stem)) return false;
    return ENDINGS.includes(w.slice(stem.length));
  });
}

/** Что делать с репликой, которую только что распознали. */
export type GateDecision =
  /** промолчать */
  | 'silent'
  /** дать модели ход */
  | 'respond'
  /** подтвердить уход в режим слушателя одной фразой */
  | 'ack_listen'
  /** подтвердить возвращение в диалог одной фразой */
  | 'ack_resume';

/** «Роман, пока слушай» и синонимы. */
const LISTEN_CMD = /\b(пока\s+слушай|просто\s+слушай|молчи|в\s+режим\w*\s+слушател)/i;
/** «Роман, вопрос к тебе» и синонимы. */
const RESUME_CMD = /\b(вопрос\s+к\s+тебе|можешь\s+говорить|возвращайся|подключайся|включайся)/i;

/**
 * Когда ассистенту позволено говорить на встрече.
 *
 * По умолчанию — молчит. Отвечает, если назвали по имени, и дальше некоторое
 * время отвечает без имени: иначе доспросить его «а почему?» было бы
 * невозможно, пришлось бы каждый раз звать заново.
 *
 * Окно открывает ФАКТ ответа (noteReplied), а не факт обращения. Если модель
 * промолчала — разговора нет, и продолжать нечего.
 *
 * Поверх этого — режим слушателя по голосовой команде (решение владельца
 * 26.08.2026, docs/meeting-bot.md). Команды распознаются ТОЛЬКО вместе с
 * именем: «вопрос к тебе», сказанное одним живым участником другому, не должно
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
      // Окно тоже гасим: без этого следующая же реплика прошла бы по нему,
      // и режим слушателя включился бы с задержкой в полминуты.
      this.openUntil = 0;
      return 'ack_listen';
    }

    // Обратная команда работает только из режима слушателя. Иначе обычное
    // «Роман, вопрос к тебе» превращалось бы в подтверждение вместо ответа.
    if (this.muted && addressed && RESUME_CMD.test(text)) {
      this.muted = false;
      return 'ack_resume';
    }

    if (this.muted) return 'silent';
    if (addressed) return 'respond';
    return now < this.openUntil ? 'respond' : 'silent';
  }

  /** Ассистент только что закончил реплику — окно продолжения продлевается. */
  noteReplied(now: number): void {
    if (!this.muted) this.openUntil = now + this.windowMs;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd voice-host && npx tsx --test src/name-gate.test.ts`
Expected: PASS, 13 тестов

- [ ] **Step 5: Зарегистрировать тест в скрипте пакета**

```json
"test": "tsx --test src/pending.test.ts src/name-gate.test.ts"
```

Run: `cd voice-host && npm test`
Expected: PASS, оба файла

- [ ] **Step 6: Коммит**

```bash
git add voice-host/src/name-gate.ts voice-host/src/name-gate.test.ts voice-host/package.json
git commit -m "feat(meeting): гейт по имени для поведения на встрече"
```

---

## Task 6: Сведение аудио участников

**Files:**
- Create: `voice-host/src/bridge/mixer.ts`
- Test: `voice-host/src/bridge/mixer.test.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// voice-host/src/bridge/mixer.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Mixer, SAMPLES_PER_TICK } from './mixer.js';

describe('Mixer', () => {
  test('без участников отдаёт тишину нужной длины', () => {
    const m = new Mixer();
    const out = m.tick();
    assert.equal(out.length, SAMPLES_PER_TICK);
    assert.ok(out.every((v) => v === 0));
  });

  test('один участник проходит без изменений', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 100));
    const out = m.tick();
    assert.equal(out[0], 100);
    assert.equal(out[SAMPLES_PER_TICK - 1], 100);
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

  test('участник без данных отдаёт тишину, а не тормозит остальных', () => {
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
    assert.equal(m.tick()[0], 0); // третий тик — данных больше нет
  });

  test('кадр короче тика дополняется тишиной', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: 10 }, () => 500));
    const out = m.tick();
    assert.equal(out[0], 500);
    assert.equal(out[9], 500);
    assert.equal(out[10], 0);
  });

  test('ушедший участник перестаёт влиять на микс', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK * 3 }, () => 100));
    m.remove('alice');
    assert.equal(m.tick()[0], 0);
  });

  test('буфер не растёт бесконечно, если участник шлёт быстрее, чем мы читаем', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) {
      m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK }, () => 100));
    }
    assert.ok(m.bufferedTicks('alice') <= Mixer.MAX_BUFFERED_TICKS);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd voice-host && npx tsx --test src/bridge/mixer.test.ts`
Expected: FAIL — `Cannot find module './mixer.js'`

- [ ] **Step 3: Минимальная реализация**

```typescript
// voice-host/src/bridge/mixer.ts

/** Частота на всём пути моста. Ресемплинга в нашем коде нет нигде. */
export const SAMPLE_RATE = 48_000;
/** Длина тика. 20 мс — стандартный размер пакета WebRTC. */
export const TICK_MS = 20;
export const SAMPLES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000; // 960

/**
 * Сведение речи участников встречи в один поток.
 *
 * Realtime принимает ровно один входной поток, а во встрече дорожек столько,
 * сколько людей. Сводить обязан кто-то, и мост — единственное место, где
 * дорожки видны все сразу.
 *
 * Кадры от разных участников приходят вразнобой и разной длины, поэтому
 * микшер не пытается их выравнивать: у каждого участника свой буфер, а тикер
 * раз в 20 мс забирает из каждого по 960 сэмплов. Нет данных — тишина, и
 * молчащий участник не тормозит говорящего.
 */
export class Mixer {
  /**
   * Потолок буфера — полсекунды.
   *
   * Участник может слать быстрее, чем мы читаем (рассинхрон часов, всплеск
   * сети). Без потолка буфер растёт неограниченно: сначала это задержка,
   * которая только копится, потом память. Лучше выкинуть старое: во встрече
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

  /** Снять с очереди ровно тик; если данных меньше — сколько есть. */
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
        // subarray, а не slice: slice на Int16Array поверх чужого буфера
        // ведёт себя непредсказуемо, про это есть прямое предупреждение в
        // примерах rtc-node.
        queue[0] = head.subarray(need);
        filled += need;
      }
    }
    // Длина всегда SAMPLES_PER_TICK: недобранный хвост остаётся нулями, то
    // есть тишиной. Возвращать короткий кадр нельзя — тик обязан быть ровным,
    // иначе поток в Realtime поедет по времени.
    return out;
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd voice-host && npx tsx --test src/bridge/mixer.test.ts`
Expected: PASS, 10 тестов

- [ ] **Step 5: Сломать проверку нарочно**

Убрать ограничение суммы (`out[i] = sum`) и прогнать: тесты на переполнение обязаны покраснеть. Вернуть.

Run: `cd voice-host && npx tsx --test src/bridge/mixer.test.ts`
Expected: сначала FAIL на двух тестах, после возврата PASS

- [ ] **Step 6: Коммит**

```bash
git add voice-host/src/bridge/mixer.ts voice-host/src/bridge/mixer.test.ts
git commit -m "feat(meeting): сведение аудио участников встречи"
```

---

## Task 7: Правила присутствия и выхода

**Files:**
- Create: `voice-host/src/bridge/occupancy.ts`
- Test: `voice-host/src/bridge/occupancy.test.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// voice-host/src/bridge/occupancy.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Occupancy, LOBBY_MS, HARD_CAP_MS } from './occupancy.js';

describe('Occupancy', () => {
  test('пустая комната сразу после входа — не повод выходить', () => {
    const occ = new Occupancy(0);
    assert.equal(occ.verdict(1000), 'stay');
  });

  test('никто не пришёл за время ожидания — вход не состоялся', () => {
    const occ = new Occupancy(0);
    assert.equal(occ.verdict(LOBBY_MS + 1), 'never_started');
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

Run: `cd voice-host && npx tsx --test src/bridge/occupancy.test.ts`
Expected: FAIL — `Cannot find module './occupancy.js'`

- [ ] **Step 3: Минимальная реализация**

```typescript
// voice-host/src/bridge/occupancy.ts

/**
 * Сколько ждём первого человека.
 *
 * Правило «нет живых участников → выходим» без этой отсрочки выкидывало бы
 * ассистента мгновенно: пользователь вполне может нажать «Зайти» раньше, чем
 * встреча началась, и комната в этот момент пуста.
 */
export const LOBBY_MS = 15 * 60 * 1000;

/**
 * Грубый предохранитель на общую длительность. Продуктовое решение, не
 * ограничение API: у звонка из интерфейса потолок час, у встречи — два, потому
 * что переговоры регулярно длиннее часа.
 */
export const HARD_CAP_MS = 2 * 60 * 60 * 1000;

export type Verdict =
  /** остаёмся в комнате */
  | 'stay'
  /** за всё ожидание никто не пришёл — вход не состоялся */
  | 'never_started'
  /** люди были и разошлись */
  | 'empty'
  /** уперлись в потолок */
  | 'hard_cap';

/**
 * Кто живой в комнате и пора ли выходить.
 *
 * Чистая логика без таймеров и сети: мост скармливает ей события и текущее
 * время, она отвечает вердиктом. Так правила выхода проверяются тестами, а не
 * двухчасовым сидением в реальной встрече.
 *
 * Участники считаются множеством, а не счётчиком: LiveKit может прислать
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
    // где на самом деле сработал предохранитель.
    if (now - this.startedAt >= HARD_CAP_MS) return 'hard_cap';
    if (!this.everHadHuman) {
      return now - this.startedAt >= LOBBY_MS ? 'never_started' : 'stay';
    }
    return this.humans.size === 0 ? 'empty' : 'stay';
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `cd voice-host && npx tsx --test src/bridge/occupancy.test.ts`
Expected: PASS, 10 тестов

- [ ] **Step 5: Коммит**

```bash
git add voice-host/src/bridge/occupancy.ts voice-host/src/bridge/occupancy.test.ts
git commit -m "feat(meeting): правила присутствия и выхода из встречи"
```

---

## Task 8: Мост между комнатами

**Files:**
- Create: `voice-host/src/bridge/bridge.ts`
- Create: `voice-host/src/bridge/server.ts`
- Modify: `voice-host/ecosystem.config.cjs`

⚠️ Если Task 1 показал, что `AgentSession` не принимает самостоятельно подключённую комнату — эта задача не меняется, а меняется Task 9: микс приходит в нашу комнату обычным участником, и воркер получает его через dispatch как сейчас. Мост в обоих случаях один и тот же.

- [ ] **Step 1: Написать мост**

```typescript
// voice-host/src/bridge/bridge.ts
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { Mixer, SAMPLE_RATE, SAMPLES_PER_TICK, TICK_MS } from './mixer.js';
import { Occupancy, type Verdict } from './occupancy.js';

export interface BridgeConfig {
  callId: string;
  /** Комната Taler ID */
  externalUrl: string;
  externalToken: string;
  /** Наша комната, где сидит воркер */
  internalUrl: string;
  internalToken: string;
  /** Как назвать смикшированную дорожку в нашей комнате */
  trackName: string;
  now: () => number;
  onVerdict: (verdict: Exclude<Verdict, 'stay'>) => Promise<void>;
  onFirstHuman: () => Promise<void>;
}

/**
 * Один мост: комната Taler ID ↔ наша комната.
 *
 * Наружу отдаёт смикшированную речь участников, внутрь принимает голос
 * ассистента. Про Realtime, промпты и специалистов ничего не знает — это
 * транспорт, и заменить в нём предстоит только внешний конец, когда дойдёт
 * очередь до Zoom.
 */
export class Bridge {
  private external = new Room();
  private internal = new Room();
  private mixer = new Mixer();
  private occupancy: Occupancy;
  private toInternal?: AudioSource;
  private toExternal?: AudioSource;
  private ticker?: NodeJS.Timeout;
  private closed = false;
  private firstHumanReported = false;

  constructor(private readonly cfg: BridgeConfig) {
    this.occupancy = new Occupancy(cfg.now());
  }

  async start(): Promise<void> {
    await this.external.connect(this.cfg.externalUrl, this.cfg.externalToken, {
      autoSubscribe: true,
      dynacast: true,
    });
    await this.internal.connect(this.cfg.internalUrl, this.cfg.internalToken, {
      autoSubscribe: true,
      dynacast: true,
    });

    this.toInternal = new AudioSource(SAMPLE_RATE, 1);
    const mixTrack = LocalAudioTrack.createAudioTrack(this.cfg.trackName, this.toInternal);
    const mixOpts = new TrackPublishOptions();
    mixOpts.source = TrackSource.SOURCE_MICROPHONE;
    await this.internal.localParticipant.publishTrack(mixTrack, mixOpts);

    this.toExternal = new AudioSource(SAMPLE_RATE, 1);
    const voiceTrack = LocalAudioTrack.createAudioTrack('assistant', this.toExternal);
    const voiceOpts = new TrackPublishOptions();
    voiceOpts.source = TrackSource.SOURCE_MICROPHONE;
    await this.external.localParticipant.publishTrack(voiceTrack, voiceOpts);

    // Уже сидящие в комнате до нашего входа: событие participantConnected по
    // ним не придёт, и без этого прохода встреча, начавшаяся раньше нас,
    // считалась бы пустой и мы вышли бы через LOBBY_MS.
    for (const [identity] of this.external.remoteParticipants) {
      this.occupancy.joined(identity, this.cfg.now());
    }

    this.external.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      this.occupancy.joined(p.identity, this.cfg.now());
      void this.reportFirstHuman();
    });
    this.external.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      this.occupancy.left(p.identity, this.cfg.now());
      this.mixer.remove(p.identity);
    });
    this.external.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void this.pumpIntoMixer(track, p.identity);
    });

    this.internal.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void this.pumpToExternal(track);
    });

    if (this.occupancy.liveCount > 0) await this.reportFirstHuman();

    this.ticker = setInterval(() => void this.onTick(), TICK_MS);
  }

  private async reportFirstHuman(): Promise<void> {
    if (this.firstHumanReported) return;
    this.firstHumanReported = true;
    try {
      await this.cfg.onFirstHuman();
    } catch (e: any) {
      console.error(`[bridge ${this.cfg.callId}] onFirstHuman failed: ${e?.message}`);
    }
  }

  /** Речь участника встречи → буфер микшера. */
  private async pumpIntoMixer(track: RemoteTrack, identity: string): Promise<void> {
    const stream = new AudioStream(track, SAMPLE_RATE, 1);
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        if (value) this.mixer.push(identity, value.data);
      }
    } catch (e: any) {
      console.error(`[bridge ${this.cfg.callId}] поток ${identity} оборвался: ${e?.message}`);
    } finally {
      reader.releaseLock();
      this.mixer.remove(identity);
    }
  }

  /** Голос ассистента из нашей комнаты → комната Taler ID. */
  private async pumpToExternal(track: RemoteTrack): Promise<void> {
    const stream = new AudioStream(track, SAMPLE_RATE, 1);
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        if (value && this.toExternal) await this.toExternal.captureFrame(value);
      }
    } catch (e: any) {
      console.error(`[bridge ${this.cfg.callId}] голос ассистента оборвался: ${e?.message}`);
    } finally {
      reader.releaseLock();
    }
  }

  private async onTick(): Promise<void> {
    if (this.closed) return;

    const verdict = this.occupancy.verdict(this.cfg.now());
    if (verdict !== 'stay') {
      console.log(`[bridge ${this.cfg.callId}] выходим: ${verdict}`);
      await this.stop();
      try {
        await this.cfg.onVerdict(verdict);
      } catch (e: any) {
        console.error(`[bridge ${this.cfg.callId}] onVerdict failed: ${e?.message}`);
      }
      return;
    }

    const samples = this.mixer.tick();
    if (!this.toInternal) return;
    try {
      await this.toInternal.captureFrame(new AudioFrame(samples, SAMPLE_RATE, 1, SAMPLES_PER_TICK));
    } catch (e: any) {
      console.error(`[bridge ${this.cfg.callId}] captureFrame failed: ${e?.message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    // Порядок важен: сначала снимаем источники, потом рвём комнаты. Иначе
    // captureFrame успевает уйти в закрытый handle и роняет процесс, унося с
    // собой соседние живые мосты.
    await this.toInternal?.close().catch(() => {});
    await this.toExternal?.close().catch(() => {});
    await this.external.disconnect().catch(() => {});
    await this.internal.disconnect().catch(() => {});
  }
}
```

- [ ] **Step 2: Написать HTTP-обёртку и реестр мостов**

```typescript
// voice-host/src/bridge/server.ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { Bridge } from './bridge.js';
import { backend, verifySignature } from '../backend.js';

const PORT = Number(process.env.BRIDGE_PORT || 8138);

const bridges = new Map<string, Bridge>();

async function startBridge(body: any): Promise<void> {
  const { callId, externalUrl, externalToken, internalToken, trackName } = body;
  if (bridges.has(callId)) throw new Error('bridge already running');

  const bridge = new Bridge({
    callId,
    externalUrl,
    externalToken,
    internalUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',
    internalToken,
    trackName: trackName || 'meeting',
    now: () => Date.now(),
    onFirstHuman: () => backend.meetingFirstHuman(callId),
    onVerdict: async (verdict) => {
      bridges.delete(callId);
      await backend.meetingEnded(callId, verdict);
    },
  });

  await bridge.start();
  bridges.set(callId, bridge);
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Ровно та же схема, что у воркера: ручки моста подписаны HMAC. Открытая
      // ручка «зайди в комнату по этому токену» — это чужая встреча, в которую
      // может зайти кто угодно. Ровно на этом в своё время пришлось выпиливать
      // dozvon: там ручка приёма записи не проверяла ничего.
      if (!verifySignature(raw, req.headers['x-voice-signature'] as string | undefined)) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"bad signature"}');
        return;
      }
      try {
        const body = JSON.parse(raw);
        if (req.url === '/bridge/start') {
          await startBridge(body);
        } else if (req.url === '/bridge/stop') {
          const b = bridges.get(body.callId);
          bridges.delete(body.callId);
          await b?.stop();
        } else {
          res.writeHead(404).end('{"error":"not found"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      } catch (e: any) {
        console.error(`[bridge-server] ${req.url}: ${e?.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: e?.message || 'failed' }));
      }
    })();
  });
});

server.listen(PORT, () => console.log(`[bridge-server] слушаю :${PORT}, мостов: ${bridges.size}`));
```

- [ ] **Step 3: Добавить проверку подписи и вызовы бэкенда**

В `voice-host/src/backend.ts` уже есть подписанные вызовы (`ask`, `document`, `complete`, `failed`), приватные `sign()` и `post()`. `post()` сам приклеивает префикс `/webhook/voice-call/internal/`, поэтому новые ручки попадают туда же, где живут остальные.

Дописать в `backend.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка входящей подписи — для ручек моста.
 *
 * Constant-time, как на бэкенде (src/voice-call/hmac.ts): обычное сравнение
 * строк на HMAC — таймингový оракул. Любой мусор на входе даёт false, а не
 * исключение: ручка обязана отвечать 401, а не 500.
 */
export function verifySignature(rawBody: string, signature: string | undefined): boolean {
  if (!SECRET || !signature || typeof signature !== 'string') return false;
  const expected = sign(rawBody);
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
```

Дописать таймауты в существующий `TIMEOUT_MS` — иначе оба вызова получат дефолтные 10 секунд, а мост в этот момент уже вышел из комнаты и ждать ему нечего:

```typescript
const TIMEOUT_MS: Record<string, number> = {
  ask: 2_000, document: 2_000, complete: 15_000, failed: 5_000,
  'meeting-first-human': 5_000, 'meeting-ended': 10_000,
};
```

И два метода в объект `backend`:

```typescript
  meetingFirstHuman: (callId: string) =>
    post<{ ok: true }>('meeting-first-human', { callId }),
  meetingEnded: (callId: string, verdict: string) =>
    post<{ ok: true }>('meeting-ended', { callId, verdict }),
```

В `server.ts` импортировать `verifySignature` из `../backend.js` и заменить проверку:

```typescript
if (!verifySignature(raw, req.headers['x-voice-signature'] as string | undefined)) {
  res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"bad signature"}');
  return;
}
```

- [ ] **Step 4: Второе приложение в pm2**

```javascript
// voice-host/ecosystem.config.cjs — добавить в apps[]
{
  name: 'linkeon-room-bridge',
  cwd: __dirname,
  script: 'dist/bridge/server.js',
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_memory_restart: '1G',
  // Драйн такой же, как у воркера: рестарт посреди встречи обрывает мост
  // молча — ни ошибки, ни строки в истории.
  kill_timeout: 600000,
  env: { NODE_ENV: 'production' },
},
```

`deploy.sh` уже делает `pm2 startOrReload voice-host/ecosystem.config.cjs` (строки 200-207 и 415-422) — второе приложение подхватится без правок скрипта.

- [ ] **Step 5: Собрать и убедиться, что типы сходятся**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm ci && npx tsc --noEmit'`
Expected: без ошибок

- [ ] **Step 6: Коммит**

```bash
git add voice-host/src/bridge/ voice-host/src/backend.ts voice-host/ecosystem.config.cjs
git commit -m "feat(meeting): мост между комнатой Taler ID и нашей комнатой"
```

---

## Task 9: Воркер — режим встречи

**Files:**
- Create: `voice-host/src/prompts.ts`
- Modify: `voice-host/src/agent.ts`

- [ ] **Step 1: Вынести инструкции в отдельный файл**

Перенести существующую `instructions()` из `agent.ts:36-64` в `prompts.ts` без изменений (переименовав в `callInstructions`) и добавить вариант для встречи:

Функция звонка переезжает **дословно**, вместе с сигнатурой и комментариями: у неё своё поведение, свой захардкоженный Роман, и трогать её в этой задаче нечего. Меняется только имя (`instructions` → `callInstructions`) и место.

```typescript
// voice-host/src/prompts.ts

/** Контекст встречи. У звонка его нет — там ведущий всегда Роман. */
export interface MeetingPromptContext {
  /** Имя ассистента, как его знают люди */
  name: string;
  /** Его собственный системный промпт из таблицы agents */
  persona: string;
  preamble: string;
  specialists: { name: string; role: string }[];
}

/**
 * Инструкции звонка. Перенесены из agent.ts:36-64 дословно, включая
 * комментарии: сигнатура и текст не меняются, меняется только имя функции.
 */
export function callInstructions(
  preamble: string,
  specialists: { name: string; role: string }[],
): string {
  /* тело переносится из agent.ts:37-63 как есть */
}

/**
 * Первая фраза звонка. Перенесена из agent.ts:359-363 дословно — там она
 * лежит инлайном в generateReply, и вынести её надо, чтобы вызов у звонка и
 * у встречи выглядел одинаково.
 */
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
 * Отличие от звонка не в тоне, а в том, что собеседник тут не один и разговор
 * идёт не с ассистентом. Молчание — рабочий режим, а не сбой.
 *
 * Правило про имя дублирует то, что уже обеспечено гейтом (name-gate.ts):
 * гейт решает, дать ли модели ход, а промпт — как себя вести, когда ход дали.
 * Одного гейта мало: получив ход, модель без этой инструкции отвечает так,
 * будто разговаривают только с ней.
 */
export function meetingInstructions(ctx: MeetingPromptContext): string {
  const roster = ctx.specialists.map((s) => `  • ${s.name} — ${s.role}`).join('\n');
  return [
    'ГОВОРИ ТОЛЬКО ПО-РУССКИ — правило важнее всех остальных.',
    '',
    `Ты ${ctx.name}. ${ctx.persona}`,
    '',
    'Ты находишься на РАБОЧЕЙ ВСТРЕЧЕ, где несколько живых участников.',
    'Разговор идёт между ними, а не с тобой. Ты слышишь всех сразу, одним',
    'потоком, и не всегда можешь понять, кто именно говорит — не делай вид,',
    'что знаешь, и не обращайся к людям по именам наугад.',
    '',
    'Тебе дают слово, только когда к тебе обратились. Получив слово:',
    '  • отвечай коротко, одной-двумя фразами, как человек в переговорах;',
    '  • не пересказывай, что уже было сказано;',
    '  • не зачитывай списки вслух;',
    '  • закончил мысль — замолчи, не заполняй паузу.',
    '',
    'Ты можешь спросить коллег-специалистов. Выбирай строго по профилю:',
    roster,
    'Инструмент ask_specialist ставит вопрос в работу и возвращается мгновенно —',
    'ответа в нём НЕТ. Скажи вслух, что отправил вопрос, и не жди молча.',
    '',
    'Просят документ, письмо, план, список договорённостей — вызывай',
    'create_document. Он тоже возвращается мгновенно.',
    '',
    ctx.preamble ? `Контекст прошлой переписки:\n${ctx.preamble}` : 'Прошлой переписки нет.',
  ].join('\n');
}

/**
 * Первая фраза на встрече — представление.
 *
 * Единственное исключение из молчания: произносится сразу после подключения,
 * до всякого обращения. Люди в комнате должны узнать, кто к ним зашёл и что
 * идёт запись, не выясняя это по списку участников.
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
 * Подтверждения переключения режима. Короткие и заданные явно, а не отданные
 * модели на импровизацию: это служебная реакция, и звучать она должна
 * одинаково, чтобы участники понимали, что команда услышана.
 */
export function listenAck(): string {
  return 'Скажи ПО-РУССКИ ровно «Хорошо, слушаю» и замолчи. Больше ни слова.';
}

export function resumeAck(): string {
  return 'Скажи ПО-РУССКИ ровно «Снова на связи» и замолчи. Больше ни слова.';
}
```

- [ ] **Step 2: Подключить режим встречи в `agent.ts`**

Метаданные задания расширяются полями режима. Разбор в начале `entry`:

```typescript
const meta = JSON.parse(ctx.job.metadata || '{}') as {
  callId: string;
  userId: string;
  preamble: string;
  specialists: { name: string; role: string }[];
  // Ниже — только для режима встречи
  mode?: 'call' | 'meeting';
  agentName?: string;
  agentPersona?: string;
  agentVoice?: string;
  ownerName?: string;
};
const isMeeting = meta.mode === 'meeting';
```

Модель получает гейт, если это встреча:

```typescript
llm: new openai.realtime.RealtimeModel({
  model: process.env.VOICE_MODEL || 'gpt-realtime-2.1',
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
    // На встрече модель не начинает ответ сама: решение принимает гейт.
    ...(isMeeting ? { create_response: false } : {}),
  },
}),
```

Гейт и его подключение:

```typescript
import { NameGate } from './name-gate.js';
import { callInstructions, meetingInstructions, meetingIntro } from './prompts.js';

/** Сколько после своей реплики ассистент отвечает без повторного зова. */
const FOLLOWUP_WINDOW_MS = 30_000;

const gate = isMeeting ? new NameGate(meta.agentName || 'Роман', FOLLOWUP_WINDOW_MS) : null;
```

В существующем обработчике `ConversationItemAdded` (там, где сейчас копится транскрипт) — после записи в транскрипт:

```typescript
if (gate) {
  if (normalizedRole === 'user') {
    // Реплика человека: спрашиваем гейт, дать ли модели ход. Синтетические
    // вставки (ответы коллег) сюда не попадают — они отсеяны выше по
    // INTERNAL_PREFIX и должны звучать всегда, их пользователь уже ждёт.
    switch (gate.decide(textContent, Date.now())) {
      case 'respond':
        session.generateReply();
        break;
      case 'ack_listen':
        session.generateReply({ instructions: listenAck() });
        break;
      case 'ack_resume':
        session.generateReply({ instructions: resumeAck() });
        break;
      case 'silent':
        break;
    }
  } else {
    gate.noteReplied(Date.now());
  }
}
```

Импорты в `agent.ts` пополняются: `listenAck`, `resumeAck` из `./prompts.js`.

⚠️ **Ответы специалистов и готовые документы приходят по data-каналу и звучат независимо от гейта** — они идут через `pushLine`/`flushPending`, минуя `ConversationItemAdded`. Это правильно: вопрос коллеге задал сам ассистент по просьбе участника, ответа ждут, и молчать в режиме слушателя тут нельзя. Но проверить на живой встрече: если участники ушли в режим слушателя, а ответ специалиста прилетел — он прозвучит.

```typescript
// (конец фрагмента)
```

Инструкции и первая фраза:

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
});

session.generateReply({
  instructions: isMeeting
    ? meetingIntro(agentName, meta.ownerName || 'пользователя')
    : callIntro(),
});
```

Существующий блок комментариев над `generateReply` (`agent.ts:348-357` — про гудки дозвона и про то, что до первой реплики Realtime уходит в английский) остаётся на месте: он объясняет, почему первая фраза задаётся явно, и для встречи это верно ровно так же.

- [ ] **Step 3: Поднять потолок сессии для встречи**

`SESSION_LIMIT_MS` в `agent.ts:279` сейчас час. Сделать зависимым от режима:

```typescript
// Встреча — два часа против часа у звонка: переговоры регулярно длиннее часа.
// Это второй предохранитель; первый живёт в мосте (occupancy.ts, HARD_CAP_MS)
// и срабатывает раньше. Держать их согласованными: если мост промолчит,
// последним рубежом остаётся этот.
const SESSION_LIMIT_MS = (isMeeting ? 2 : 1) * 60 * 60 * 1000;
```

- [ ] **Step 4: Собрать и прогнать тесты воркера**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsc --noEmit && npm test'`
Expected: типы проходят, тесты `pending` / `name-gate` / `mixer` / `occupancy` зелёные

- [ ] **Step 5: Коммит**

```bash
git add voice-host/src/prompts.ts voice-host/src/agent.ts
git commit -m "feat(meeting): режим встречи в воркере — гейт по имени и представление"
```

---

## Task 10: Сервис входа во встречу

**Files:**
- Create: `src/voice-call/meeting.service.ts`
- Create: `src/voice-call/bridge.client.ts`
- Create: `src/voice-call/meeting.controller.ts`
- Test: `src/voice-call/meeting.service.spec.ts`
- Modify: `src/voice-call/voice-call.module.ts`
- Modify: `src/voice-call/voice-call.types.ts`

- [ ] **Step 1: Написать падающий тест сервиса**

```typescript
// src/voice-call/meeting.service.spec.ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { MeetingService } from './meeting.service';

describe('MeetingService.join', () => {
  const rooms = { info: jest.fn(), join: jest.fn() };
  const livekit = { userToken: jest.fn(), dispatchAgent: jest.fn(), closeRoom: jest.fn() };
  const bridge = { start: jest.fn(), stop: jest.fn() };
  const calls = { buildPreamble: jest.fn() };
  let pg: { query: jest.Mock };
  let svc: MeetingService;

  beforeEach(() => {
    jest.clearAllMocks();
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    rooms.info.mockResolvedValue({ title: 'Планёрка', creatorName: 'Сергей' });
    rooms.join.mockResolvedValue('external-token');
    livekit.userToken.mockResolvedValue('internal-token');
    calls.buildPreamble.mockResolvedValue('Пользователь: привет');
    svc = new MeetingService(pg as any, calls as any, livekit as any, rooms as any, bridge as any);
  });

  const agentRow = { id: 7, display_name: 'Андрей', system_prompt: 'Ты помогаешь с запуском.', realtime_voice: 'ash' };

  function withAgent() {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [agentRow] };
      return { rows: [], rowCount: 0 };
    });
  }

  it('заводит запись, берёт токен и поднимает мост', async () => {
    withAgent();
    const res = await svc.join('user-1', 7, 'talerid', 'AB12CD', 'Дмитрий');

    expect(rooms.join).toHaveBeenCalledWith('AB12CD', expect.stringContaining('Андрей'));
    expect(bridge.start).toHaveBeenCalledWith(
      expect.objectContaining({ externalToken: 'external-token', internalToken: 'internal-token' }),
    );
    expect(res.callId).toEqual(expect.any(String));
  });

  it('передаёт воркеру режим встречи и данные ассистента', async () => {
    withAgent();
    await svc.join('user-1', 7, 'talerid', 'AB12CD', 'Дмитрий');

    expect(livekit.dispatchAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        mode: 'meeting',
        agentName: 'Андрей',
        agentVoice: 'ash',
        ownerName: 'Дмитрий',
      }),
    );
  });

  it('не пускает второй вход при живом первом', async () => {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [agentRow] };
      if (sql.includes('SELECT id FROM voice_calls')) return { rows: [{ id: 'existing' }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(svc.join('user-1', 7, 'talerid', 'AB12CD', 'Дмитрий')).rejects.toThrow(ConflictException);
  });

  it('не входит в несуществующую комнату', async () => {
    withAgent();
    rooms.info.mockResolvedValue(null);
    await expect(svc.join('user-1', 7, 'talerid', 'NOPE', 'Дмитрий')).rejects.toThrow(NotFoundException);
    expect(rooms.join).not.toHaveBeenCalled();
  });

  it('если мост не поднялся — запись не остаётся висеть активной', async () => {
    withAgent();
    bridge.start.mockRejectedValue(new Error('bridge down'));

    await expect(svc.join('user-1', 7, 'talerid', 'AB12CD', 'Дмитрий')).rejects.toThrow('bridge down');

    const failed = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("status = 'failed'"));
    expect(failed).toBeDefined();
    expect(livekit.closeRoom).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/voice-call/meeting.service.spec.ts`
Expected: FAIL — `Cannot find module './meeting.service'`

- [ ] **Step 3: Реализовать клиент моста**

```typescript
// src/voice-call/bridge.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { signBody } from './hmac';

export interface BridgeStart {
  callId: string;
  externalUrl: string;
  externalToken: string;
  internalToken: string;
  trackName: string;
}

/** HTTP-команды процессу моста. Подписаны тем же секретом, что и ручки воркера. */
@Injectable()
export class BridgeClient {
  private readonly logger = new Logger(BridgeClient.name);

  private get base(): string {
    return process.env.BRIDGE_URL || 'http://127.0.0.1:8138';
  }

  private async post(path: string, body: unknown): Promise<void> {
    const raw = JSON.stringify(body);
    const secret = process.env.VOICE_CALLBACK_SECRET;
    if (!secret) throw new Error('VOICE_CALLBACK_SECRET не задан — мост не примет команду');

    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-voice-signature': signBody(secret, raw) },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`bridge ${path} failed: ${res.status}`);
  }

  start(cfg: BridgeStart): Promise<void> {
    return this.post('/bridge/start', cfg);
  }

  /** Best-effort: моста может уже не быть, и это нормальный исход. */
  async stop(callId: string): Promise<void> {
    try {
      await this.post('/bridge/stop', { callId });
    } catch (e: any) {
      this.logger.warn(`bridge stop ${callId}: ${e?.message}`);
    }
  }
}
```

- [ ] **Step 4: Реализовать сервис**

```typescript
// src/voice-call/meeting.service.ts
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from './livekit.client';
import { TalerIdRoomClient } from './talerid-room.client';
import { BridgeClient } from './bridge.client';
import { VoiceCallService } from './voice-call.service';
import { MeetingProvider } from './meeting-link';
import { SPECIALIST_ROLES, SPECIALISTS, TALERID_LIVEKIT_URL } from './voice-call.types';

@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly calls: VoiceCallService,
    private readonly livekit: LiveKitClient,
    private readonly rooms: TalerIdRoomClient,
    private readonly bridge: BridgeClient,
  ) {}

  async join(
    userId: string,
    agentId: number,
    provider: MeetingProvider,
    code: string,
    ownerName: string,
  ): Promise<{ callId: string; title: string }> {
    const agentRes = await this.pg.query(
      `SELECT id, display_name, system_prompt, realtime_voice FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new NotFoundException('agent not found');

    // Один активный вход на пользователя — та же причина, что у звонка: минута
    // Realtime стоит реальных денег, а без проверки N вкладок дают N сессий.
    const active = await this.pg.query(
      `SELECT id FROM voice_calls WHERE user_id = $1 AND status IN ('dialing','active') LIMIT 1`,
      [userId],
    );
    if (active.rows[0]) {
      throw new ConflictException({ message: 'call already in progress', callId: active.rows[0].id });
    }

    const info = await this.rooms.info(code);
    if (!info) throw new NotFoundException('meeting room not found');

    const callId = randomUUID();
    const roomName = `meet_${callId}`;

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, provider, external_room)
       VALUES ($1, $2, $3, $4, 'dialing', $5, $6)`,
      [callId, userId, agentId, roomName, provider, code],
    );

    try {
      // Имя в списке участников встречи. Люди в комнате должны понимать, кто
      // зашёл и чей он, не спрашивая вслух.
      const displayName = `${agent.display_name} · ассистент ${ownerName}`;

      const [externalToken, internalToken, preamble] = await Promise.all([
        this.rooms.join(code, displayName),
        this.livekit.userToken(roomName, `bridge_${callId}`),
        this.calls.buildPreamble(userId, agentId),
      ]);

      await this.livekit.dispatchAgent(roomName, {
        callId,
        userId,
        preamble,
        mode: 'meeting',
        agentName: agent.display_name,
        agentPersona: agent.system_prompt || '',
        agentVoice: agent.realtime_voice || undefined,
        ownerName,
        // Специалисты — все, кроме самого ведущего: спрашивать себя незачем.
        specialists: Object.keys(SPECIALISTS)
          .filter((n) => SPECIALISTS[n] !== agentId)
          .map((n) => ({ name: n, role: SPECIALIST_ROLES[n] || '' })),
        callbackUrl: `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/voice-call/internal`,
      });

      await this.bridge.start({
        callId,
        externalUrl: process.env.TALERID_LIVEKIT_URL || TALERID_LIVEKIT_URL,
        externalToken,
        internalToken,
        trackName: 'meeting',
      });
    } catch (e: any) {
      // Запись, оставшаяся в 'dialing', намертво блокирует пользователю
      // следующую попытку — лимит «один активный вход» смотрит именно на неё.
      this.logger.error(`[join] call=${callId} не поднялся: ${e?.message}`);
      await this.pg.query(
        `UPDATE voice_calls SET status = 'failed', ended_at = now(), summary = $1 WHERE id = $2`,
        [`Вход во встречу не состоялся: ${e?.message}`, callId],
      );
      await this.livekit.closeRoom(roomName);
      throw e;
    }

    this.logger.log(`[join] call=${callId} agent=${agentId} room=${code}`);
    return { callId, title: info.title || 'Встреча' };
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
   * Мост вышел. Закрываем нашу комнату — воркер получит disconnect и сам
   * пришлёт complete с транскриптом. Карточку и резюме делает он же.
   */
  async noteEnded(callId: string, verdict: string): Promise<void> {
    const call = await this.calls.load(callId);
    if (verdict === 'never_started') {
      await this.calls.fail(callId, 'во встречу так никто и не пришёл');
    }
    await this.livekit.closeRoom(call.room_name);
    this.logger.log(`[ended] call=${callId} verdict=${verdict}`);
  }

  /** Пользователь нажал «Выйти». */
  async leave(callId: string): Promise<void> {
    await this.bridge.stop(callId);
    await this.calls.markInterrupted(callId);
  }
}
```

- [ ] **Step 5: Добавить константы в `voice-call.types.ts`**

```typescript
/** LiveKit, на котором живут комнаты Taler ID. Их страница ходит именно сюда. */
export const TALERID_LIVEKIT_URL = 'wss://api.talerid.io/livekit/';
```

- [ ] **Step 6: Параметризовать `buildPreamble`**

`VoiceCallService.buildPreamble` сейчас жёстко читает историю чата с Романом (`voice-call.service.ts:49-69`). Добавить второй аргумент:

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

- [ ] **Step 7: Контроллер**

```typescript
// src/voice-call/meeting.controller.ts
import { Body, Controller, ForbiddenException, Param, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { MeetingService } from './meeting.service';
import { VoiceCallService } from './voice-call.service';

@Controller('meeting')
@UseGuards(JwtGuard)
export class MeetingController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly calls: VoiceCallService,
  ) {}

  /** v1 — только админы. Проверка серверная, как у звонка. */
  @Post('join')
  async join(
    @CurrentUser() u: any,
    @Body() body: { agentId: number; provider: 'talerid'; code: string },
  ) {
    if (!u?.isAdmin) throw new ForbiddenException('meetings are admin-only in v1');
    return this.meetings.join(u.userId, Number(body.agentId), body.provider, body.code, u.name || 'пользователя');
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

- [ ] **Step 8: Ручки для моста во внутреннем контроллере**

В `voice-call-internal.controller.ts` — две ручки, подписанные так же, как соседние:

```typescript
@Post('meeting-first-human')
async meetingFirstHuman(@Headers('x-voice-signature') signature: string, @Req() req: Request) {
  const body = this.parseSigned<{ callId: string }>(req, signature);
  await this.meetings.noteFirstHuman(body.callId);
  return { ok: true };
}

@Post('meeting-ended')
async meetingEnded(@Headers('x-voice-signature') signature: string, @Req() req: Request) {
  const body = this.parseSigned<{ callId: string; verdict: string }>(req, signature);
  await this.meetings.noteEnded(body.callId, body.verdict);
  return { ok: true };
}
```

Путь `/webhook/voice-call/internal/meeting-*` должен попасть под сырой парсер тела в `main.ts` — проверить, что там указан префикс, а не полные пути каждой ручки.

- [ ] **Step 9: Регистрация в модуле**

```typescript
controllers: [VoiceCallController, VoiceCallInternalController, VoiceCallStatusController, MeetingController],
providers: [
  VoiceCallService, SpecialistJobService, VoiceDocumentService, LiveKitClient,
  VoiceCallReaperService, MeetingService, TalerIdRoomClient, BridgeClient,
],
exports: [VoiceCallService, MeetingService, TalerIdRoomClient],
```

- [ ] **Step 10: Прогнать тесты**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call --silent'`
Expected: PASS, включая существующие тесты `voice-call.service.spec.ts` и `specialist-job.service.spec.ts` — они не должны покраснеть от правки `buildPreamble`.

Спека требует автотест на идемпотентность `complete` — он **уже есть**: `voice-call.service.spec.ts:133`, «повторный complete не создаёт вторую карточку». Заводить второй не надо, надо убедиться, что этот остался зелёным: встреча ходит через тот же `complete`, и повторный вызов от моста и от воркера — сценарий более вероятный, чем у звонка.

- [ ] **Step 11: Коммит**

```bash
git add src/voice-call/
git commit -m "feat(meeting): вход ассистента во встречу Taler ID"
```

---

## Task 11: Карточка встречи в чате

**Files:**
- Modify: `src/chat/chat.service.ts` (~строка 483, до ветки smm_producer)
- Test: `src/chat/meeting-card.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/chat/meeting-card.spec.ts
import { buildMeetingCard } from './meeting-card';

describe('buildMeetingCard', () => {
  it('собирает тег с кодом, провайдером и названием', () => {
    expect(buildMeetingCard('talerid', 'AB12CD', 'Планёрка', 'Сергей'))
      .toBe('{{meeting_join: provider=talerid code=AB12CD title=Планёрка creator=Сергей}}');
  });

  it('вычищает фигурные скобки и переводы строк из названия', () => {
    // Название приходит от Taler ID и в наш тег попадает как есть. Скобка
    // внутри рвёт разбор на фронте, и вместо карточки пользователь видит сырой
    // текст тега.
    expect(buildMeetingCard('talerid', 'AB12CD', 'Пла}}нёрка\nвтор', 'Сергей'))
      .toBe('{{meeting_join: provider=talerid code=AB12CD title=Планёрка втор creator=Сергей}}');
  });

  it('переживает пустое название', () => {
    expect(buildMeetingCard('talerid', 'AB12CD', '', ''))
      .toBe('{{meeting_join: provider=talerid code=AB12CD title=Встреча creator=}}');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/chat/meeting-card.spec.ts`
Expected: FAIL — `Cannot find module './meeting-card'`

- [ ] **Step 3: Реализовать сборку тега**

```typescript
// src/chat/meeting-card.ts

/** Убрать из значения всё, что сломает разбор тега на фронте. */
function clean(s: string): string {
  return (s || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildMeetingCard(
  provider: string,
  code: string,
  title: string,
  creator: string,
): string {
  return `{{meeting_join: provider=${provider} code=${code} title=${clean(title) || 'Встреча'} creator=${clean(creator)}}}`;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest src/chat/meeting-card.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Замкнуть ход в `streamChat`**

Вставить сразу после вычисления `chatSessionId` и до ветки `smm_producer` (`chat.service.ts:485`):

```typescript
// Ссылка на комнату Taler ID замыкает ход: показываем карточку «Зайти во
// встречу» и в модель не идём. Иначе за каждую вставленную ссылку платим ход
// LLM и получаем два ответа — карточку и рассуждение ассистента о ней.
const meetingLink = parseMeetingLink(message);
if (meetingLink) {
  const info = await this.talerIdRooms.info(meetingLink.code);
  if (info) {
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

    const card = buildMeetingCard(meetingLink.provider, meetingLink.code, info.title || '', info.creatorName || '');
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
  // Комнаты нет или Taler ID недоступен — это была обычная ссылка в разговоре,
  // идём обычным путём.
}
```

`TalerIdRoomClient` внедрить в конструктор `ChatService`, а `VoiceCallModule` добавить в импорты `ChatModule`. **Проверить на циклический импорт:** `VoiceCallModule` уже импортирует `ChatModule`. Если Nest ругается — вынести `TalerIdRoomClient` в `CommonModule` либо обернуть в `forwardRef`.

- [ ] **Step 6: Прогнать тесты чата**

Run: `ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/chat --silent'`
Expected: PASS; приложение поднимается без ошибок циклического импорта — проверить `npx jest src/app.module.spec.ts`, если такой есть, иначе `npm run build`

- [ ] **Step 7: Коммит**

```bash
git add src/chat/meeting-card.ts src/chat/meeting-card.spec.ts src/chat/chat.service.ts src/chat/chat.module.ts
git commit -m "feat(meeting): карточка «Зайти во встречу» по ссылке в чате"
```

---

## Task 12: Фронт — карточка, плашка, локали

**Files:**
- Create: `src/components/chat/MeetingJoinCard.tsx`
- Create: `src/components/chat/MeetingStatusBar.tsx`
- Modify: `src/utils/customMarkdown.tsx`
- Modify: `src/utils/customMarkdown.test.ts`
- Modify: `src/components/chat/ChatInterface.tsx`
- Modify: `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json`

Репозиторий: `~/Downloads/spirits_front`.

- [ ] **Step 1: Написать падающий тест разбора тега**

```typescript
// в src/utils/customMarkdown.test.ts
describe('meeting_join', () => {
  it('вынимает поля встречи', () => {
    const { meetings } = parseCustomMarkdown(
      '{{meeting_join: provider=talerid code=AB12CD title=Планёрка creator=Сергей}}',
    );
    expect([...meetings.values()][0]).toEqual({
      provider: 'talerid',
      code: 'AB12CD',
      title: 'Планёрка',
      creator: 'Сергей',
    });
  });

  it('переживает пустого создателя', () => {
    const { meetings } = parseCustomMarkdown(
      '{{meeting_join: provider=talerid code=AB12CD title=Встреча creator=}}',
    );
    expect([...meetings.values()][0].creator).toBe('');
  });

  it('не трогает обычный текст', () => {
    const { meetings } = parseCustomMarkdown('просто сообщение');
    expect(meetings.size).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd ~/Downloads/spirits_front && npx vitest run src/utils/customMarkdown.test.ts`
Expected: FAIL — `meetings` не существует в результате

- [ ] **Step 3: Добавить разбор тега**

По образцу `VOICE_CALL_REGEX` (`customMarkdown.tsx:44`):

```typescript
// Карточка входа во встречу: бэкенд, увидев в сообщении ссылку на комнату,
// кладёт в историю сообщение ассистента с этим тегом вместо ответа модели.
// Как и у voice_call, тег подменяется маркером, чтобы карточка ожила из
// сохранённой истории, а не только в момент отправки.
const MEETING_JOIN_REGEX =
  /\{\{meeting_join:\s*provider=([a-z]+)\s+code=([A-Za-z0-9_-]+)\s+title=([^}]*?)\s+creator=([^}]*?)\}\}/g;
```

Добавить `meetings: Map<string, MeetingInfo>` в возвращаемый тип и в тело функции — по образцу `voiceCalls`.

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx vitest run src/utils/customMarkdown.test.ts`
Expected: PASS

- [ ] **Step 5: Написать карточку**

```tsx
// src/components/chat/MeetingJoinCard.tsx
import { useState } from 'react';
import { Video, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/apiClient';

interface Props {
  provider: string;
  code: string;
  title: string;
  creator: string;
  agentId: number;
  onJoined: (callId: string) => void;
}

export default function MeetingJoinCard({ provider, code, title, creator, agentId, onJoined }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post('/webhook/meeting/join', { agentId, provider, code });
      if (!res.ok) {
        // 409 — ассистент уже где-то сидит. Это не поломка, и текст должен
        // объяснять, что делать, а не пугать.
        throw new Error(res.status === 409 ? t('chat.meeting.already_in') : t('chat.meeting.join_failed'));
      }
      const data = await res.json();
      onJoined(data.callId);
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
          {creator && <p className="text-xs text-gray-500 truncate">{t('chat.meeting.created_by', { name: creator })}</p>}
        </div>
        <button
          onClick={join}
          disabled={busy}
          data-testid="meeting-join"
          className="px-3 py-1.5 rounded-lg bg-forest-700 text-white text-xs font-medium disabled:opacity-50 hover:bg-forest-800 transition-colors"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t('chat.meeting.join')}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Написать плашку статуса**

```tsx
// src/components/chat/MeetingStatusBar.tsx
import { useState } from 'react';
import { Video, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/apiClient';

export default function MeetingStatusBar({ callId, onLeft }: { callId: string; onLeft: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    setBusy(true);
    try {
      await apiClient.post(`/webhook/meeting/${callId}/leave`);
    } catch { /* best-effort: мост мог выйти сам */ }
    setBusy(false);
    onLeft();
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-forest-100 border-b border-forest-200">
      <Video className="w-4 h-4 text-forest-700 animate-pulse flex-shrink-0" />
      <span className="text-xs text-forest-900 flex-1">{t('chat.meeting.in_progress')}</span>
      <button
        onClick={leave}
        disabled={busy}
        data-testid="meeting-leave"
        className="px-2 py-1 rounded-md bg-white text-forest-800 text-xs font-medium disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t('chat.meeting.leave')}
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Подключить в `ChatInterface`**

Состояние встречи — рядом с остальным состоянием компонента:

```tsx
// Ассистент сидит в внешней встрече. null — не сидит.
const [meetingCallId, setMeetingCallId] = useState<string | null>(null);
```

Плашка — над лентой сообщений, первым элементом внутри контейнера чата:

```tsx
{meetingCallId && (
  <MeetingStatusBar callId={meetingCallId} onLeft={() => setMeetingCallId(null)} />
)}
```

Карточка — в обоих местах, где сейчас рендерится `VoiceCallCard` (`ChatInterface.tsx:244` и `:2499`); там уже есть цикл по маркерам, куда добавляется ветка:

```tsx
const meeting = meetings.get(marker);
if (meeting) {
  parts.push(
    <MeetingJoinCard
      key={`meeting-${idx}`}
      provider={meeting.provider}
      code={meeting.code}
      title={meeting.title}
      creator={meeting.creator}
      agentId={Number(selectedAssistant.id)}
      onJoined={setMeetingCallId}
    />,
  );
  return;
}
```

`agentId` берётся из текущего выбранного ассистента — карточка живёт в его чате, и заходить должен именно он. Если в компоненте ассистент называется иначе, взять существующее имя переменной, а не заводить новое.

- [ ] **Step 8: Строки в семи локалях**

Добавить блок `chat.meeting` рядом с существующим `chat.voice_call` (`ru.json:206`) во **все семь** файлов: `ru`, `en`, `es`, `de`, `fr`, `pt`, `zh`.

```json
"meeting": {
  "join": "Зайти",
  "created_by": "Создал: {{name}}",
  "in_progress": "Ассистент на встрече",
  "leave": "Выйти",
  "already_in": "Ассистент уже на другой встрече или на звонке",
  "join_failed": "Не удалось зайти во встречу"
}
```

Множественных форм здесь нет — категории по языкам разные, и `_few`/`_many` из русского в чужую локаль переносить нельзя. Если понадобится счётчик, брать категории из `Intl.PluralRules`.

- [ ] **Step 9: Проверить полноту локалей**

```bash
cd ~/Downloads/spirits_front
for f in src/i18n/locales/*.json; do
  echo -n "$f: "; node -e "const j=require('./$f'); console.log(Object.keys(j.chat?.meeting||{}).length)"
done
```

Expected: `6` во всех семи файлах.

- [ ] **Step 10: Прогнать тесты и сборку на ноде**

```bash
git push -u origin <ветка>
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front checkout -q <sha>'
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && source ~/.nvm/nvm.sh && pnpm install && pnpm test && pnpm build'
```

Expected: тесты зелёные, сборка проходит

- [ ] **Step 11: Коммит**

```bash
git add src/components/chat/MeetingJoinCard.tsx src/components/chat/MeetingStatusBar.tsx \
        src/utils/customMarkdown.tsx src/utils/customMarkdown.test.ts \
        src/components/chat/ChatInterface.tsx src/i18n/locales/
git commit -m "feat(meeting): карточка входа во встречу и плашка статуса"
```

---

## Task 13: Реапер — потолок для встреч

**Files:**
- Modify: `src/voice-call/voice-call-reaper.service.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/voice-call/voice-call-reaper.spec.ts
import { VoiceCallReaperService } from './voice-call-reaper.service';

describe('VoiceCallReaperService', () => {
  it('порог для встречи больше, чем для звонка', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const livekit = { closeRoom: jest.fn() };
    const bridge = { stop: jest.fn() };
    const svc = new VoiceCallReaperService(pg as any, livekit as any, bridge as any);

    await svc.reap();

    const call = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("provider = 'linkeon'"));
    const meeting = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("provider <> 'linkeon'"));
    expect(Number(call![1][0])).toBeLessThan(Number(meeting![1][0]));
  });

  it('гасит мост у подобранной встречи, а не только комнату', async () => {
    const pg = {
      query: jest.fn().mockImplementation(async (sql: string) =>
        sql.includes("provider <> 'linkeon'")
          ? { rows: [{ id: 'stale-meeting', room_name: 'meet_x' }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      ),
    };
    const livekit = { closeRoom: jest.fn() };
    const bridge = { stop: jest.fn() };
    const svc = new VoiceCallReaperService(pg as any, livekit as any, bridge as any);

    await svc.reap();

    expect(bridge.stop).toHaveBeenCalledWith('stale-meeting');
    expect(livekit.closeRoom).toHaveBeenCalledWith('meet_x');
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest src/voice-call/voice-call-reaper.spec.ts`
Expected: FAIL — конструктор принимает два аргумента, запросов с `provider` нет

- [ ] **Step 3: Реализовать**

Разделить существующий запрос на два порога и погасить мост:

```typescript
/** Звонок: наш потолок час плюс запас. */
const STALE_CALL_MS = 70 * 60 * 1000;
/**
 * Встреча: потолок два часа плюс запас.
 *
 * Отдельный порог обязателен. С общим часовым реапер подбирал бы живые
 * встречи на втором часу и обрывал их как зависшие — то есть предохранитель
 * убивал бы ровно то, ради чего потолок и подняли.
 */
const STALE_MEETING_MS = 130 * 60 * 1000;
```

`BridgeClient` внедряется третьим аргументом конструктора. Существующий запрос по звонкам получает условие по провайдеру, и рядом появляется второй — по встречам:

```typescript
const stale = await this.pg.query(
  `UPDATE voice_calls
      SET status = 'interrupted', ended_at = now()
    WHERE status IN ('dialing', 'active')
      AND provider = 'linkeon'
      AND started_at < now() - ($1 || ' milliseconds')::interval
    RETURNING id, room_name`,
  [String(STALE_CALL_MS)],
);
for (const row of stale.rows) {
  this.logger.warn(`[reap] звонок ${row.id} висел дольше порога — закрываю комнату`);
  await this.livekit.closeRoom(row.room_name);
}

const staleMeetings = await this.pg.query(
  `UPDATE voice_calls
      SET status = 'interrupted', ended_at = now()
    WHERE status IN ('dialing', 'active')
      AND provider <> 'linkeon'
      AND started_at < now() - ($1 || ' milliseconds')::interval
    RETURNING id, room_name`,
  [String(STALE_MEETING_MS)],
);
for (const row of staleMeetings.rows) {
  this.logger.warn(`[reap] встреча ${row.id} висела дольше порога — гашу мост и комнату`);
  // Мост гасим ПЕРВЫМ. Закрыть только нашу комнату мало: процесс моста
  // останется сидеть в чужой встрече и продолжит публиковать туда тишину —
  // посторонний участник, которого никто не звал и которого некому выгнать.
  await this.bridge.stop(row.id);
  await this.livekit.closeRoom(row.room_name);
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

## Task 14: Окружение и выкат

- [ ] **Step 1: Переменные окружения**

Дописать в `.env` на тесте и проде (и в `voice-host/.env` — мост живёт там же):

```env
# Мост в чужие встречи
BRIDGE_URL=http://127.0.0.1:8138          # бэкенд → мост
BRIDGE_PORT=8138                          # порт процесса моста
TALERID_ROOM_API=https://api.talerid.io/api
TALERID_LIVEKIT_URL=wss://api.talerid.io/livekit/
```

`VOICE_CALLBACK_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` уже заданы для звонка — мост берёт их же.

**Порт проверить перед выбором.** 8081 в своё время уже был занят nginx, и воркер уходил в цикл перезапусков pm2 с `EADDRINUSE`:

```bash
ssh dvolkov@212.113.106.202 'ss -ltnp | grep -E ":8138|:8137"'
```

Expected: пусто, кроме уже работающего 8137 (воркер).

- [ ] **Step 2: Колонка голоса у ассистентов**

`meeting.service.ts` читает `agents.realtime_voice`. Если колонки нет — миграция:

```sql
-- src/voice-call/migrations/004_agent_realtime_voice.sql
-- Голос ассистента в Realtime. NULL — берётся дефолт из env.
--
-- Голосов у Realtime десять на двадцать с лишним ассистентов, так что часть
-- будет звучать одинаково. Подбирать НА СЛУХ: описания врут — в agent.ts
-- голос дважды выбирали по названию и дважды промахивались мимо пола.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS realtime_voice TEXT;
```

- [ ] **Step 3: Применить миграции на проде вручную**

`npm run migrate` на проде **не работает**: раннер застревает на `base/001` (`CREATE TYPE payment_status_enum`) и не докатывает ничего после. Применять через psql и вручную отмечать в `schema_migrations`, иначе следующий запуск раннера попробует применить их повторно.

```bash
ssh dvolkov@212.113.106.202 'psql "$DATABASE_URL" -f ~/spirits_back/src/voice-call/migrations/003_meeting_provider.sql'
ssh dvolkov@212.113.106.202 'psql "$DATABASE_URL" -f ~/spirits_back/src/voice-call/migrations/004_agent_realtime_voice.sql'
ssh dvolkov@212.113.106.202 'psql "$DATABASE_URL" -c "INSERT INTO schema_migrations (filename) VALUES (\x27voice-call/003_meeting_provider.sql\x27), (\x27voice-call/004_agent_realtime_voice.sql\x27) ON CONFLICT DO NOTHING"'
```

- [ ] **Step 4: Живая проверка на тесте**

Двухфазный `deploy.sh` сам катит сначала на `test.linkeon.io`. **Не запускать его без явного согласия владельца** — раскатку может вести параллельная сессия.

После выката на тест:
1. Создать комнату в Taler ID, взять ссылку.
2. Кинуть её в чат с ассистентом на `test.linkeon.io` — должна появиться карточка с названием встречи, а не ответ модели.
3. Нажать «Зайти» — ассистент появляется в списке участников встречи и произносит представление.
4. Помолчать две минуты при живом разговоре двух людей — ассистент обязан молчать.
5. Позвать по имени — отвечает. Доспросить без имени в течение 30 секунд — отвечает. Подождать минуту и доспросить — молчит.
6. Попросить вслух спросить профильного коллегу — приходит ответ специалиста.
7. Всем выйти из встречи — ассистент выходит, в ленте появляется карточка с резюме.
8. Проверить учёт: `SELECT provider, duration_sec, cost_usd, model FROM voice_calls ORDER BY started_at DESC LIMIT 1`.

- [ ] **Step 5: Проверить, что сборка моста реально доехала**

`deploy.sh` глотал падение сборки подпроектов: `set -e` без `pipefail` плюс `| tail` — воркер не собирался, а деплой ехал дальше. Сверять не «файл на месте», а свежесть:

```bash
ssh dv@85.192.61.231 'pm2 list | grep -E "linkeon-voice-host|linkeon-room-bridge"'
ssh dv@85.192.61.231 'stat -c "%y %n" ~/spirits_back/voice-host/dist/bridge/server.js'
```

Expected: оба процесса `online`, время файла — сегодняшнее. `pm2 list` со статусом `online` при нулевом аптайме означает цикл перезапусков, а не работу.

- [ ] **Step 6: Коммит и выкат на прод**

Выкат — только `bash ~/Downloads/spirits_back/scripts/deploy.sh` без флагов (test → smoke → prod → smoke), и только с явного согласия владельца. Никакого `rsync`, никакой правки файлов на сервере.

Фоновый запуск — **без `tail`**: конвейер копит вывод до конца, и лог все десять минут выглядит пустым.

---

## Результаты спайка

*Заполняется в Task 1, Step 4.*

---

## Что осталось за рамками

Zoom (следующий шаг: адаптер Attendee к этому же мосту), Google Meet, Яндекс Телемост, видео и аватар, диаризация «кто сказал», списание токенов с баланса, вход по календарю заранее, доступ кому-либо кроме админов.
