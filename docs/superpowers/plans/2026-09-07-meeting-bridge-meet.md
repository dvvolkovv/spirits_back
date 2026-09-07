# Ассистент во внешней встрече Google Meet — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ассистент заходит во встречу Google Meet по ссылке из чата, слушает всех участников и говорит в встречу — с тем же поведением, что уже обкатано на встречах Taler ID.

**Architecture:** Attendee (самохостинг) держит Chrome-бота в встрече и обменивается с нами звуком по вебсокету, который поднимаем мы. LiveKit-комната остаётся пустой и нужна только чтобы получить job и провести дата-канал — обобщение паттерна Taler ID. Присутствие участников приходит вебхуками Attendee и доезжает до воркера по существующему дата-каналу, потому что в LiveKit-комнате участников нет вовсе.

**Tech Stack:** NestJS 10, TypeScript, `@livekit/agents@1.7.0`, `@livekit/rtc-node`, `ws`, OpenAI Realtime, Attendee (Django в Docker), Postgres, Redis. Тесты: jest в бэкенде, `node:test` через `tsx --test` в `voice-host`, vitest во фронте.

**Спека:** [2026-09-06-meeting-bridge-meet-design.md](../specs/2026-09-06-meeting-bridge-meet-design.md)

---

## Поправки к спеке, найденные при планировании

Три вещи изменились по сравнению с текстом спеки. Спеку править не нужно — эти
решения фиксируются здесь, а в спеку уедут вместе с результатами спайка.

1. **Подпись вебхука Attendee — не как у нас.** У нас `x-voice-signature` — hex
   от HMAC над **сырыми байтами**. У Attendee `X-Webhook-Signature` — **base64**
   от HMAC-SHA256 над **канонизированным JSON**. Значит `verifyBody` из
   `voice-call/hmac.ts` переиспользовать нельзя, и сырое тело для этой ручки
   **не нужно** — наоборот, тело надо разобрать и пересобрать канонично.
   Правки в `main.ts` не требуется.
2. **Разметка говорящего не теряется.** В спеке записано, что она пропадёт
   совсем. Нашёлся триггер `participant_events.speech_start_stop` — он даёт
   ровно то же приближение, что и `ActiveSpeakersChanged` в своих комнатах, и
   идёт по тому же вебхуку. Берём: это не новая фича, а отсутствие регрессии.
3. **`mixer.ts` всё-таки нужен.** В спеке сказано, что он не нужен, потому что
   Attendee микширует сам. Микширование действительно не нужно — а вот
   **ритм** нужен: Realtime ждёт ровный поток кадров каждые 20 мс, а куски по
   вебсокету приходят вразнобой. `Mixer` именно это и делает (буфер, потолок
   полсекунды, добивка тишиной), и с одним участником сумма вырождается в
   проброс. Параметризуем его частотой и переиспользуем.

## Структура файлов

**Бэкенд** — `spirits_back/src/meeting/`:

| Файл | Ответственность |
|---|---|
| `meeting-link.ts` (изменить) | Разбор ссылки; добавляется `MEET_LINK_REGEX` и провайдер `'meet'` |
| `attendee.client.ts` (создать) | HTTP-клиент Attendee: создать бота, удалить бота. Ничего не знает про встречи |
| `attendee-signature.ts` (создать) | Проверка `X-Webhook-Signature`. Чистая функция, без Nest |
| `meet-webhook.controller.ts` (создать) | Приём вебхуков, перекладывание присутствия в дата-канал |
| `meeting.service.ts` (изменить) | Ветка `provider='meet'` |
| `meeting.module.ts` (изменить) | Проводка новых провайдеров и контроллера |

Разделение намеренное: клиент, подпись и контроллер не знают друг о друге, и
каждый проверяется отдельно. `attendee.client.ts` кладём в `MeetingModule`, а не
в `RoomModule` (где лежит `TalerIdRoomClient`): комнаты Meet нам не
принадлежат и `RoomService` про них ничего не знает.

**Воркер** — `spirits_back/voice-host/src/`:

| Файл | Ответственность |
|---|---|
| `mixer.ts` (изменить) | Параметризация частотой; поведение по умолчанию не меняется |
| `attendee-audio.ts` (создать) | Вебсокет-сервер + `AttendeeAudioInput` + `AttendeeAudioOutput` |
| `presence.ts` (создать) | Состав участников из вебхуков. Чистая логика, полностью тестируемая |
| `agent.ts` (изменить) | Третья ветка источника аудио и присутствия |

**Фронт** — `spirits/src/`: `utils/customMarkdown.tsx`, `components/chat/MeetingJoinCard.tsx`.

**Инфраструктура**: `spirits_back/infra/attendee/`.

## Как гонять тесты

Локально не гонять — решение владельца 15.08.2026. Цикл на каждой задаче:

```bash
# 1. Локально
git push -u origin feat/meeting-meet

# 2. На ноде — встать на КОНКРЕТНЫЙ sha, не на имя ветки
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q <sha>'

# 3. Прогон
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npm ci && npx jest src/meeting --maxWorkers=2'
```

`source ~/.nvm/nvm.sh` обязателен в каждой команде. Работать только в `~/ci/`,
никогда в `~/spirits_back` — там живой чекаут `test.linkeon.io`.

---

### Task 1: Поднять Attendee на отдельном хосте

**Files:**
- Create: `spirits_back/infra/attendee/docker-compose.yml`
- Create: `spirits_back/infra/attendee/README.md`

Прод не подходит: там уже API, Postgres, Redis, Neo4j и LiveKit, а каждый бот —
полный Chrome. Конкуренция за CPU ударит по SFU.

- [ ] **Step 1: Завести compose**

```yaml
# spirits_back/infra/attendee/docker-compose.yml
#
# Версия образа ЗАПИНЕНА. Attendee ходит по живой вёрстке Google Meet, и
# `latest` сломает встречу в неожиданный момент — ровно та ошибка, которую
# infra/livekit/README.md описывает про уехавший тег.
services:
  attendee:
    image: attendeelabs/attendee:v0.5.0
    container_name: attendee-linkeon
    restart: unless-stopped
    env_file: ./.env
    ports:
      - "8000:8000"
    depends_on: [postgres, redis]
    # Бот запускает Chrome; shm по умолчанию 64 МБ, и вкладка Meet падает.
    shm_size: "2gb"

  postgres:
    image: postgres:16
    container_name: attendee-pg
    restart: unless-stopped
    environment:
      POSTGRES_DB: attendee
      POSTGRES_USER: attendee
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [attendee-pg:/var/lib/postgresql/data]

  redis:
    image: redis:7
    container_name: attendee-redis
    restart: unless-stopped

volumes:
  attendee-pg:
```

- [ ] **Step 2: Поднять и убедиться, что API отвечает**

```bash
docker compose -f infra/attendee/docker-compose.yml up -d
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/
```

Ожидается: `200` либо `302` (редирект на логин UI). Любой `5xx` — смотреть
`docker logs attendee-linkeon`.

- [ ] **Step 3: Завести проект и API-ключ**

Через UI на `:8000`: создать проект, выпустить API-ключ. Ключ положить в
`.env` бэкенда как `ATTENDEE_API_KEY`, базовый адрес — `ATTENDEE_BASE_URL`.
В git ключи не кладём — как и в `infra/livekit`.

- [ ] **Step 4: Записать процедуру в README**

Скопировать структуру `infra/livekit/README.md`: где живёт, как применять
конфиг, что рестарт рвёт активные встречи, как проверить здоровье.

- [ ] **Step 5: Commit**

```bash
git add infra/attendee/
git commit -m "infra(attendee): compose и процедура запуска на отдельном хосте"
```

---

### Task 2: Спайк — гейт

**Files:** none (одноразовый скрипт, удалить после)

Пока три вопроса не закрыты, задачи 9–10 (аудио-мост) не начинаем. Задачи 3–8
от результата спайка не зависят и могут идти параллельно.

- [ ] **Step 1: Заглушка вебсокета**

Положить в корень репозитория (`ts-node` не резолвит модули проекта из `/tmp`),
удалить сразу после.

```ts
// spike-ws.ts — удалить после спайка
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8138 });
let frames = 0;
wss.on('connection', (ws) => {
  console.log('[спайк] Attendee подключился');
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.trigger !== 'realtime_audio.mixed') { console.log('[спайк]', msg.trigger); return; }
    const pcm = Buffer.from(msg.data.chunk, 'base64');
    if (++frames % 50 === 0) {
      console.log(`[спайк] кусков ${frames}, последний ${pcm.length} байт, rate ${msg.data.sample_rate}`);
    }
    // Эхо обратно: если участники услышат своё эхо — путь в обе стороны жив.
    ws.send(JSON.stringify({
      trigger: 'realtime_audio.bot_output',
      data: { chunk: msg.data.chunk, sample_rate: msg.data.sample_rate },
    }));
  });
});
console.log('[спайк] жду на :8138');
```

- [ ] **Step 2: Создать бота в настоящую встречу**

```bash
curl -sX POST "$ATTENDEE_BASE_URL/api/v1/bots" \
  -H "Authorization: Token $ATTENDEE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "meeting_url": "https://meet.google.com/abc-defg-hij",
    "bot_name": "Роман · ассистент Дмитрия",
    "metadata": {"callId": "spike"},
    "websocket_settings": {"audio": {"url": "wss://<хост>/spike", "sample_rate": 24000}},
    "webhooks": [{"url": "https://<хост>/spike-hook",
                  "triggers": ["bot.state_change", "participant_events.join_leave",
                               "participant_events.speech_start_stop"]}]
  }'
```

- [ ] **Step 3: Ответить на вопросы и записать ответы в спеку**

| № | Вопрос | Что именно записать |
|---|---|---|
| 1 | Пускает ли Meet бота | Полная последовательность `new_state` из `bot.state_change`; как называется состояние ожидания впуска и состояние отказа; сколько секунд до входа |
| 2 | Проходит ли звук | Слышно ли эхо в встрече; фактические `sample_rate` и размер куска; time-to-first-audio |
| 3 | `session.start()` без живой комнаты | Заводится ли сессия с нашей пустой комнатой; если нет — работает ли `session.start()` вовсе без `room`. **Главный риск плана** |
| 4 | Виден ли бот сам себе | Приходит ли `participant_events.join_leave` про самого бота. От этого зависит, надо ли исключать себя в `presence.ts` |
| 5 | Канонизация подписи | `grep -rn "X-Webhook-Signature" .` в исходниках Attendee → точный алгоритм для Task 4 |
| 6 | Точный контракт создания бота | Какие поля приняты, какие проигнорированы; форма ответа |
| 7 | Есть ли сброс очереди звука | Умеет ли Attendee выбросить недосказанное при перебивании. Если нет — перебивание будет слышно хуже, чем в своих комнатах, и это идёт в спеку как ограничение (см. `clearBuffer` в Task 9) |

- [ ] **Step 4: Удалить заглушку и зафиксировать**

```bash
rm spike-ws.ts
git add docs/superpowers/specs/2026-09-06-meeting-bridge-meet-design.md
git commit -m "docs(spec): результаты спайка Attendee + Google Meet"
```

---

### Task 3: Разбор ссылки Google Meet

**Files:**
- Modify: `spirits_back/src/meeting/meeting-link.ts`
- Test: `spirits_back/src/meeting/meeting-link.spec.ts`

От спайка не зависит.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `describe('parseMeetingLink', …)`, рядом с блоком про Taler ID:

```ts
  describe('встречи Google Meet', () => {
    it('находит код встречи', () => {
      expect(parseMeetingLink('созвон https://meet.google.com/abc-defg-hij в пять')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('приводит код к нижнему регистру', () => {
      // Код у Meet всегда строчный; вставленный из письма ВЕРСАЛОМ должен
      // сойтись с тем, что мы положим в external_room и в meeting_url.
      expect(parseMeetingLink('https://meet.google.com/ABC-DEFG-HIJ')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('игнорирует query и хвост', () => {
      expect(parseMeetingLink('https://meet.google.com/abc-defg-hij?authuser=0')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('находит внутри markdown', () => {
      expect(parseMeetingLink('[созвон](https://meet.google.com/abc-defg-hij)')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('отвергает домен, лишь оканчивающийся на meet.google.com', () => {
      // Поддомен здесь НЕ необязателен, в отличие от linkeon.io и talerid.io:
      // у Meet его не бывает, а группа (?:[a-z0-9-]+\.)? пропустила бы это.
      expect(parseMeetingLink('https://notmeet.google.com/abc-defg-hij')).toBeNull();
      expect(parseMeetingLink('https://meet.google.com.evil.ru/abc-defg-hij')).toBeNull();
    });

    it('отвергает код неверной формы', () => {
      expect(parseMeetingLink('https://meet.google.com/abcd-efgh-ijkl')).toBeNull();
      expect(parseMeetingLink('https://meet.google.com/abc-def-hij')).toBeNull();
      expect(parseMeetingLink('https://meet.google.com/abc123-defg-hij')).toBeNull();
    });

    it('не путает с другими путями Meet', () => {
      expect(parseMeetingLink('https://meet.google.com/lookup/abc-defg-hij')).toBeNull();
    });

    it('ссылки трёх провайдеров не путаются', () => {
      expect(parseMeetingLink('https://my.linkeon.io/room/ABC234')?.provider).toBe('linkeon');
      expect(parseMeetingLink('https://api.talerid.io/room/36fc367a')?.provider).toBe('talerid');
      expect(parseMeetingLink('https://meet.google.com/abc-defg-hij')?.provider).toBe('meet');
    });
  });
```

- [ ] **Step 2: Прогнать и убедиться, что падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/meeting-link --maxWorkers=2'
```

Ожидается: FAIL — `provider: 'meet'` не бывает, все новые тесты красные.

- [ ] **Step 3: Реализовать**

В `meeting-link.ts` после `TALERID_LINK_REGEX`:

```ts
/**
 * Ссылка на встречу Google Meet.
 *
 * Хост точный, БЕЗ необязательного поддомена — в отличие от linkeon.io и
 * talerid.io. У Meet поддоменов не бывает, а группа `(?:[a-z0-9-]+\.)?`
 * пропустила бы `notmeet.google.com`. Хвост домена закрыт границей `\/`
 * сразу после `com`, иначе прошёл бы `meet.google.com.evil.ru`.
 *
 * Код — три-четыре-три СТРОЧНЫЕ буквы (`abc-defg-hij`). Цифр в нём не бывает,
 * поэтому алфавит узкий: так `/lookup/` и прочие пути Meet сюда не попадают.
 * Начало кода прижато к `\/`, конец — отрицательным просмотром, иначе из
 * `abcd-efgh-ijkl` регулярка выкусила бы середину.
 */
const MEET_LINK_REGEX = /https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z0-9-])/i;
```

`MeetingProvider` и разбор:

```ts
export type MeetingProvider = 'linkeon' | 'talerid' | 'meet';
```

В `parseMeetingLink`, перед финальным `return null`:

```ts
  const meet = MEET_LINK_REGEX.exec(text);
  if (meet) {
    // К нижнему регистру: код у Meet строчный, а из письма его вставляют
    // как попало. Он же уедет в external_room и в meeting_url для Attendee,
    // и расхождение регистра развело бы одну встречу на две записи.
    return { provider: 'meet', code: meet[1].toLowerCase() };
  }
```

- [ ] **Step 4: Прогнать — зелено**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/meeting-link --maxWorkers=2'
```

Ожидается: PASS, все прежние тесты тоже.

- [ ] **Step 5: Commit**

```bash
git add src/meeting/meeting-link.ts src/meeting/meeting-link.spec.ts
git commit -m "feat(meeting): разбор ссылки на встречу Google Meet"
```

---

### Task 4: Проверка подписи вебхука Attendee

**Files:**
- Create: `spirits_back/src/meeting/attendee-signature.ts`
- Test: `spirits_back/src/meeting/attendee-signature.spec.ts`

Своя реализация, а не `voice-call/hmac.ts`: там hex над сырыми байтами, здесь
base64 над канонизированным JSON.

- [ ] **Step 1: Уточнить канонизацию по исходникам**

Ответ из Task 2, шага 3, вопрос 5. Если спайк ещё не прошёл — сделать сейчас,
это одна команда в чекауте Attendee:

```bash
grep -rn "X-Webhook-Signature\|def sign\|canonical" --include='*.py' .
```

Ниже реализация под наиболее вероятную канонизацию: рекурсивно отсортированные
ключи, разделители без пробелов, UTF-8. **Если исходники говорят иначе —
поправить `canonicalJson` и тесты, остальное не меняется.**

- [ ] **Step 2: Написать падающие тесты**

```ts
import { canonicalJson, verifyAttendeeSignature } from './attendee-signature';
import { createHmac } from 'crypto';

const SECRET = 'test-secret';
const sign = (payload: unknown) =>
  createHmac('sha256', SECRET).update(canonicalJson(payload), 'utf8').digest('base64');

describe('canonicalJson', () => {
  it('сортирует ключи на всех уровнях', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('не ставит пробелов', () => {
    expect(canonicalJson({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });

  it('порядок элементов массива сохраняет', () => {
    // Массив — это данные, а не набор: сортировка здесь исказила бы payload.
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('null и вложенную пустоту не теряет', () => {
    expect(canonicalJson({ a: null, b: {}, c: [] })).toBe('{"a":null,"b":{},"c":[]}');
  });
});

describe('verifyAttendeeSignature', () => {
  const payload = { bot_id: 'b1', trigger: 'bot.state_change', data: { new_state: 'joined' } };

  it('принимает верную подпись', () => {
    expect(verifyAttendeeSignature(SECRET, payload, sign(payload))).toBe(true);
  });

  it('подпись не зависит от порядка ключей в присланном JSON', () => {
    // Ровно ради этого канонизация и нужна: Django пересобирает JSON своим
    // сериализатором, и байты его вывода нашим не равны.
    const reordered = { data: { new_state: 'joined' }, trigger: 'bot.state_change', bot_id: 'b1' };
    expect(verifyAttendeeSignature(SECRET, reordered, sign(payload))).toBe(true);
  });

  it('отвергает чужую подпись', () => {
    expect(verifyAttendeeSignature(SECRET, payload, sign({ bot_id: 'other' }))).toBe(false);
  });

  it('отвергает подмену данных', () => {
    const tampered = { ...payload, data: { new_state: 'left' } };
    expect(verifyAttendeeSignature(SECRET, tampered, sign(payload))).toBe(false);
  });

  it('мусор вместо подписи — false, а не исключение', () => {
    // Ручка обязана отвечать 401, а не 500.
    expect(verifyAttendeeSignature(SECRET, payload, '')).toBe(false);
    expect(verifyAttendeeSignature(SECRET, payload, 'не base64!!')).toBe(false);
    expect(verifyAttendeeSignature(SECRET, payload, undefined as any)).toBe(false);
  });
});
```

- [ ] **Step 3: Прогнать — падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/attendee-signature --maxWorkers=2'
```

Ожидается: FAIL — `Cannot find module './attendee-signature'`.

- [ ] **Step 4: Реализовать**

```ts
// spirits_back/src/meeting/attendee-signature.ts
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Проверка `X-Webhook-Signature` вебхуков Attendee.
 *
 * Своя реализация, а не `voice-call/hmac.ts`: там hex от HMAC над СЫРЫМИ
 * байтами тела, здесь base64 над КАНОНИЗИРОВАННЫМ JSON. Из-за этого различия
 * сырое тело нам не нужно вовсе — наоборот, JSON надо разобрать и пересобрать
 * канонично, поэтому на этот путь в main.ts ничего навешивать не требуется.
 */

/**
 * JSON с рекурсивно отсортированными ключами и без пробелов.
 *
 * Порядок элементов массива сохраняется: массив — это данные, а не набор.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}

/** Сравнение constant-time. Любой мусор — false, а не исключение. */
export function verifyAttendeeSignature(
  secret: string,
  payload: unknown,
  signature: string,
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(canonicalJson(payload), 'utf8').digest('base64');
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'base64'), Buffer.from(expected, 'base64'));
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Прогнать — зелено, и закоммитить**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/attendee-signature --maxWorkers=2'
git add src/meeting/attendee-signature.ts src/meeting/attendee-signature.spec.ts
git commit -m "feat(meeting): проверка подписи вебхуков Attendee"
```

---

### Task 5: Клиент Attendee

**Files:**
- Create: `spirits_back/src/meeting/attendee.client.ts`
- Test: `spirits_back/src/meeting/attendee.client.spec.ts`

Шаблон — `talerid-room.client.ts`: короткий таймаут, любая неожиданность →
`null` и строка в лог, а не исключение наружу.

- [ ] **Step 1: Написать падающие тесты**

Стиль мока `fetch` — как в `talerid-room.client.spec.ts`.

```ts
import { AttendeeClient } from './attendee.client';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as any;

describe('AttendeeClient', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.ATTENDEE_BASE_URL = 'https://attendee.test';
    process.env.ATTENDEE_API_KEY = 'k1';
    process.env.ATTENDEE_WEBHOOK_URL = 'https://my.linkeon.io/webhook/meet/attendee';
    process.env.ATTENDEE_AUDIO_WS_URL = 'wss://voice.linkeon.io/attendee';
  });
  afterEach(() => { global.fetch = realFetch; });

  describe('createBot', () => {
    it('возвращает id бота', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ id: 'bot_1', state: 'joining' })) as any;
      const r = await new AttendeeClient().createBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
        callId: 'c1',
      });
      expect(r).toEqual({ botId: 'bot_1' });
    });

    it('шлёт имя, метаданные, вебсокет и триггеры', async () => {
      const spy = jest.fn().mockResolvedValue(ok({ id: 'bot_1' }));
      global.fetch = spy as any;
      await new AttendeeClient().createBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
        callId: 'c1',
      });
      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://attendee.test/api/v1/bots');
      expect((init.headers as any).Authorization).toBe('Token k1');
      const body = JSON.parse(init.body);
      expect(body.meeting_url).toBe('https://meet.google.com/abc-defg-hij');
      expect(body.bot_name).toBe('Роман · ассистент Дмитрия');
      // callId в metadata — так вебхук находит звонок без своей таблицы.
      expect(body.metadata).toEqual({ callId: 'c1' });
      expect(body.websocket_settings.audio).toEqual({
        url: 'wss://voice.linkeon.io/attendee?callId=c1',
        sample_rate: 24000,
      });
      expect(body.webhooks[0].triggers).toEqual([
        'bot.state_change',
        'participant_events.join_leave',
        'participant_events.speech_start_stop',
      ]);
    });

    it('HTTP-ошибка — null, а не исключение', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('ответ без id — null', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ state: 'joining' })) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('падение сети — null', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('без ключа в окружении — null и ни одного запроса', async () => {
      delete process.env.ATTENDEE_API_KEY;
      const spy = jest.fn();
      global.fetch = spy as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('removeBot', () => {
    it('зовёт leave и говорит об успехе', async () => {
      const spy = jest.fn().mockResolvedValue(ok({}));
      global.fetch = spy as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBe(true);
      expect(spy.mock.calls[0][0]).toBe('https://attendee.test/api/v1/bots/bot_1/leave');
    });

    it('не падает, если бота уже нет', async () => {
      // Реапер и leave могут прийти одновременно; 404 здесь — норма.
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBe(false);
    });
  });
});
```

- [ ] **Step 2: Прогнать — падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/attendee.client --maxWorkers=2'
```

Ожидается: FAIL — модуля нет.

- [ ] **Step 3: Реализовать**

```ts
// spirits_back/src/meeting/attendee.client.ts
import { Injectable, Logger } from '@nestjs/common';

/**
 * Attendee — мост в встречи площадок без LiveKit.
 *
 * Живёт на отдельном хосте: каждый бот — полный Chrome со страницей Meet, и
 * рядом с LiveKit ему не место. Мы его самохостим, то есть недоступность —
 * наша проблема, а не чужая; всё равно ведём себя как с чужим сервисом:
 * короткий таймаут, любая неожиданность → null и строка в лог. Вход во встречу
 * не должен падать 500-й из-за того, что контейнер перезапускается.
 */

/** Дольше вход во встречу не ждём: человек смотрит на кнопку. */
const TIMEOUT_MS = 10_000;

/**
 * Частота звука. 24 кГц — родная для OpenAI Realtime, поэтому на всём пути
 * нет ни одного ресемпла. Attendee принимает 8000, 16000 или 24000.
 */
export const ATTENDEE_SAMPLE_RATE = 24_000;

/**
 * Что слушаем.
 *
 * `speech_start_stop` — не украшение: в LiveKit-комнате участников нет вовсе,
 * и без него пропала бы разметка говорящего, которая в своих комнатах берётся
 * из ActiveSpeakersChanged. `join_leave` держит правила выхода и гейт по имени.
 */
const TRIGGERS = [
  'bot.state_change',
  'participant_events.join_leave',
  'participant_events.speech_start_stop',
];

export interface CreateBotParams {
  meetingUrl: string;
  botName: string;
  callId: string;
}

@Injectable()
export class AttendeeClient {
  private readonly logger = new Logger(AttendeeClient.name);

  private base(): string {
    return (process.env.ATTENDEE_BASE_URL || '').replace(/\/+$/, '');
  }

  private async call(path: string, init: RequestInit): Promise<any | null> {
    const base = this.base();
    const key = process.env.ATTENDEE_API_KEY;
    // Без настроек молчим, а не бьёмся в пустой адрес: на стендах без Attendee
    // встречи Meet просто недоступны, и это не повод падать.
    if (!base || !key) {
      this.logger.warn('attendee не настроен (ATTENDEE_BASE_URL / ATTENDEE_API_KEY)');
      return null;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(`attendee ${path}: HTTP ${res.status}`);
        return null;
      }
      return await res.json().catch(() => ({}));
    } catch (e: any) {
      this.logger.warn(`attendee ${path}: ${e?.name === 'AbortError' ? 'таймаут' : e?.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Отправить бота во встречу. `null` — не получилось, причина уже в логе. */
  async createBot(p: CreateBotParams): Promise<{ botId: string } | null> {
    const ws = process.env.ATTENDEE_AUDIO_WS_URL || '';
    const hook = process.env.ATTENDEE_WEBHOOK_URL || '';
    const d = await this.call('/api/v1/bots', {
      method: 'POST',
      body: JSON.stringify({
        meeting_url: p.meetingUrl,
        bot_name: p.botName,
        // callId в метаданных — так вебхук находит звонок, не завод я своей
        // таблицы соответствий bot_id → call. Attendee возвращает metadata
        // обратно в каждом событии полем bot_metadata.
        metadata: { callId: p.callId },
        websocket_settings: {
          // callId в query — воркер по нему узнаёт, чей это звук, ещё до
          // первого сообщения. Одного вебсокет-сервера хватает на все встречи.
          audio: { url: `${ws}?callId=${encodeURIComponent(p.callId)}`, sample_rate: ATTENDEE_SAMPLE_RATE },
        },
        webhooks: [{ url: hook, triggers: TRIGGERS }],
      }),
    });
    if (!d || typeof d.id !== 'string' || !d.id) return null;
    return { botId: d.id };
  }

  /**
   * Вывести бота из встречи.
   *
   * Обязательно при любом выходе ассистента: без этого Chrome остаётся сидеть
   * в встрече и после того, как ассистент ушёл. `false` — бота уже не было,
   * это нормальный исход, реапер и leave могут прийти одновременно.
   */
  async removeBot(botId: string): Promise<boolean> {
    const d = await this.call(`/api/v1/bots/${encodeURIComponent(botId)}/leave`, { method: 'POST' });
    return d !== null;
  }
}
```

- [ ] **Step 4: Прогнать — зелено, и закоммитить**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/attendee.client --maxWorkers=2'
git add src/meeting/attendee.client.ts src/meeting/attendee.client.spec.ts
git commit -m "feat(meeting): клиент Attendee — создание и вывод бота"
```

---

### Task 6: Типы дата-канала

**Files:**
- Modify: `spirits_back/src/voice-call/voice-call.types.ts`

Присутствие идёт в воркер по тому же каналу, что ответы специалистов — ровно
подо что заводилось поле `v`.

- [ ] **Step 1: Добавить варианты**

В конец объединения `VoiceDataMessage`, перед закрывающей `;`:

```ts
  /**
   * Состав участников встречи на площадке без LiveKit.
   *
   * В нашей комнате при такой встрече участников нет вовсе, поэтому
   * `occupancy` и гейт по имени в воркере остались бы без входных данных:
   * `remoteParticipants.size` там всегда ноль. Из этого следовали три поломки
   * разом — гейт срывался в solo и ассистент отвечал на каждую реплику,
   * `voice_calls.status` навсегда оставался `dialing` и запирал пользователю
   * следующий вход, а правила выхода уводили ассистента из живой встречи через
   * LOBBY_MS. Поэтому состав приезжает сюда вебхуками Attendee.
   *
   * Событие — дельта, а не снимок: Attendee присылает join/leave по одному.
   * `uuid` — ключ участника, `name` показываем в разметке говорящего.
   */
  | { v: 1; type: 'meet_participant'; event: 'join' | 'leave'; uuid: string; name: string }
  /** Кто говорит сейчас. Приближение — то же, что ActiveSpeakersChanged. */
  | { v: 1; type: 'meet_speaking'; uuid: string; name: string; speaking: boolean }
  /**
   * Состояние бота Attendee. Воркеру нужно только «не пустили» — тогда
   * встречи не будет и сидеть в пустой комнате незачем.
   */
  | { v: 1; type: 'meet_bot_state'; state: string; fatal: boolean }
```

- [ ] **Step 2: Проверить, что типы сходятся**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx tsc --noEmit -p tsconfig.json'
```

Ожидается: без ошибок. Объединение расширяется, существующие ветки `switch` по
`type` не обязаны знать новые варианты.

- [ ] **Step 3: Commit**

```bash
git add src/voice-call/voice-call.types.ts
git commit -m "feat(voice-call): события присутствия Meet в дата-канале"
```

---

### Task 7: Состав участников в воркере

**Files:**
- Create: `spirits_back/voice-host/src/presence.ts`
- Test: `spirits_back/voice-host/src/presence.test.ts`
- Modify: `spirits_back/voice-host/package.json` (добавить файл в `test`)

Тесты — `node:test`, не jest. Импорты внутри `voice-host` идут с `.js`.

- [ ] **Step 1: Написать падающие тесты**

```ts
// spirits_back/voice-host/src/presence.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Presence } from './presence.js';

describe('Presence', () => {
  test('пустая при создании', () => {
    const p = new Presence();
    assert.equal(p.count, 0);
    assert.deepEqual(p.names, []);
  });

  test('вход и выход считаются', () => {
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.apply({ event: 'join', uuid: 'u2', name: 'Дмитрий' });
    assert.equal(p.count, 2);
    p.apply({ event: 'leave', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.count, 1);
    assert.deepEqual(p.names, ['Дмитрий']);
  });

  test('повторный вход того же uuid не удваивает', () => {
    // Вебхуки могут повториться при retry, а Attendee ретраит настойчиво.
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.count, 1);
  });

  test('выход неизвестного никого не ломает', () => {
    const p = new Presence();
    p.apply({ event: 'leave', uuid: 'нет такого', name: '' });
    assert.equal(p.count, 0);
  });

  test('сам бот в счёт не идёт', () => {
    // Бот Attendee — полноправный участник встречи Meet и приходит в
    // join_leave наравне с людьми. Без исключения себя гейт по имени считал
    // бы, что в комнате всегда есть собеседник, и никогда не переходил в solo.
    const p = new Presence('Роман · ассистент Дмитрия');
    p.apply({ event: 'join', uuid: 'bot', name: 'Роман · ассистент Дмитрия' });
    assert.equal(p.count, 0);
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.count, 1);
  });

  test('наедине — когда остался один человек', () => {
    const p = new Presence();
    assert.equal(p.solo, false, 'в пустой комнате solo включать нельзя');
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.solo, true);
    p.apply({ event: 'join', uuid: 'u2', name: 'Дмитрий' });
    assert.equal(p.solo, false);
  });

  test('говорящий запоминается и сбрасывается', () => {
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.speech('u1', 'Сергей', true);
    assert.equal(p.speaker, 'Сергей');
    p.speech('u1', 'Сергей', false);
    assert.equal(p.speaker, undefined);
  });

  test('чужое «замолчал» не сбивает текущего говорящего', () => {
    const p = new Presence();
    p.speech('u1', 'Сергей', true);
    p.speech('u2', 'Дмитрий', false);
    assert.equal(p.speaker, 'Сергей');
  });

  test('вышедший перестаёт быть говорящим', () => {
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.speech('u1', 'Сергей', true);
    p.apply({ event: 'leave', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.speaker, undefined);
  });
});
```

- [ ] **Step 2: Прогнать — падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsx --test src/presence.test.ts'
```

Ожидается: FAIL — `Cannot find module './presence.js'`.

- [ ] **Step 3: Реализовать**

```ts
// spirits_back/voice-host/src/presence.ts

/**
 * Кто во встрече на площадке без LiveKit.
 *
 * На своих комнатах и в Taler ID состав берётся из `room.remoteParticipants`.
 * В Meet разговор идёт вне LiveKit, наша комната пуста, и `remoteParticipants`
 * там всегда нулевой — то есть источник состава нужен другой. Им становятся
 * вебхуки Attendee, доезжающие сюда по дата-каналу.
 *
 * Класс чистый: ни сети, ни таймеров. Воркер скармливает события, он отвечает
 * составом, флагом «наедине» и текущим говорящим. Именно поэтому это
 * единственная часть моста, покрытая тестами полностью.
 */
export interface ParticipantEvent {
  event: 'join' | 'leave';
  uuid: string;
  name: string;
}

export class Presence {
  /** uuid → имя. Множество, а не счётчик: вебхуки повторяются при retry. */
  private readonly people = new Map<string, string>();
  private speakingUuid?: string;
  /**
   * Имя говорящего из самого события.
   *
   * Нужно потому, что `speech_start` может опередить `join`: события идут
   * разными вебхуками и порядок между ними не гарантирован. Без запаса имени
   * первая реплика встречи осталась бы без разметки говорящего.
   */
  private speakingName?: string;

  /**
   * @param selfName имя, под которым в встрече сидит наш же бот. Attendee
   *   присылает его в join_leave наравне с людьми, и без исключения себя
   *   комната никогда не выглядела бы пустой: правила выхода не срабатывали
   *   бы, а гейт по имени не переходил бы в solo.
   */
  constructor(private readonly selfName?: string) {}

  apply(e: ParticipantEvent): void {
    if (this.selfName && e.name === this.selfName) return;
    if (e.event === 'join') {
      this.people.set(e.uuid, e.name);
      return;
    }
    this.people.delete(e.uuid);
    // Вышедший не может оставаться говорящим: иначе разметка транскрипта
    // приписывала бы реплики человеку, которого в встрече уже нет.
    if (this.speakingUuid === e.uuid) this.speakingUuid = undefined;
  }

  speech(uuid: string, name: string, speaking: boolean): void {
    if (this.selfName && name === this.selfName) return;
    if (speaking) {
      this.speakingUuid = uuid;
      this.speakingName = name;
      return;
    }
    // Гасим только если замолчал именно текущий: события двух участников
    // приходят вперемешку, и чужое «замолчал» иначе стирало бы говорящего.
    if (this.speakingUuid === uuid) {
      this.speakingUuid = undefined;
      this.speakingName = undefined;
    }
  }

  get count(): number {
    return this.people.size;
  }

  get names(): string[] {
    return [...this.people.values()];
  }

  /**
   * Наедине ассистент отвечает без обращения по имени.
   *
   * Ровно ноль — это НЕ наедине: пустая встреча означает, что люди ещё не
   * собрались, и включать свободный режим там нельзя.
   */
  get solo(): boolean {
    return this.people.size === 1;
  }

  /**
   * Имя говорящего. Сначала из состава, потом из самого события — на случай,
   * когда `speech_start` опередил `join`.
   */
  get speaker(): string | undefined {
    if (!this.speakingUuid) return undefined;
    return this.people.get(this.speakingUuid) ?? this.speakingName;
  }
}
```

- [ ] **Step 4: Прогнать — зелено**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsx --test src/presence.test.ts'
```

- [ ] **Step 5: Вписать в прогон пакета и закоммитить**

В `voice-host/package.json`, скрипт `test` — добавить `src/presence.test.ts` в
список, иначе файл не попадёт в общий прогон.

```bash
git add voice-host/src/presence.ts voice-host/src/presence.test.ts voice-host/package.json
git commit -m "feat(voice-host): состав участников встречи из вебхуков"
```

---

### Task 8: Параметризовать микшер частотой

**Files:**
- Modify: `spirits_back/voice-host/src/mixer.ts`
- Test: `spirits_back/voice-host/src/mixer.test.ts`

Микширование для Meet не нужно — Attendee отдаёт готовый микс. Нужен **ритм**:
Realtime ждёт ровный кадр каждые 20 мс, а куски по вебсокету приходят вразнобой.
`Mixer` это уже умеет (буфер, потолок полсекунды, добивка тишиной), но частота в
нём прибита константой 48 кГц, а нам нужно 24.

- [ ] **Step 1: Написать падающий тест**

Добавить в `mixer.test.ts`:

```ts
  test('частота задаётся конструктором', () => {
    // 20 мс при 24 кГц — 480 сэмплов. Нужно для встреч Meet, где звук идёт
    // через Attendee на родной частоте Realtime.
    const m = new Mixer(480);
    assert.equal(m.tick().length, 480);
  });

  test('по умолчанию остаётся 48 кГц', () => {
    // Свои комнаты и Taler ID не должны заметить этой правки.
    assert.equal(new Mixer().tick().length, 960);
  });

  test('потолок буфера считается в тиках новой частоты', () => {
    const m = new Mixer(480);
    for (let i = 0; i < 100; i++) m.push('u1', new Int16Array(480));
    assert.ok(m.bufferedTicks('u1') <= Mixer.MAX_BUFFERED_TICKS);
  });
```

- [ ] **Step 2: Прогнать — падает**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsx --test src/mixer.test.ts'
```

Ожидается: FAIL — `new Mixer(480).tick().length` равно 960.

- [ ] **Step 3: Реализовать**

В `mixer.ts` добавить конструктор и заменить три обращения к константе:

```ts
export class Mixer {
  static readonly MAX_BUFFERED_TICKS = 25;

  private buffers = new Map<string, Int16Array[]>();

  /**
   * @param samplesPerTick сколько сэмплов в тике. По умолчанию 960 — это
   *   48 кГц, частота LiveKit, на которой работают свои комнаты и Taler ID.
   *   Встречи через Attendee идут на 24 кГц (родная частота Realtime, ни
   *   одного ресемпла на пути), там тик — 480.
   */
  constructor(private readonly samplesPerTick: number = SAMPLES_PER_TICK) {}
```

Далее в `tick()`, `countTicks()` и `takeTick()` заменить `SAMPLES_PER_TICK` на
`this.samplesPerTick`. Экспорт константы оставить: на неё ссылается
`mixed-audio-input.ts`.

- [ ] **Step 4: Прогнать оба файла — зелено**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
```

Ожидается: PASS во всех файлах, включая `mixer.test.ts` без правок старых
тестов.

- [ ] **Step 5: Commit**

```bash
git add voice-host/src/mixer.ts voice-host/src/mixer.test.ts
git commit -m "refactor(voice-host): микшер принимает частоту, дефолт не меняется"
```

---

### Task 9: Аудио-мост — вебсокет, вход и выход

**Files:**
- Create: `spirits_back/voice-host/src/attendee-audio.ts`
- Modify: `spirits_back/voice-host/package.json` (зависимость `ws`)

**Требует Task 2.** Шаблон выхода — `external-room-output.ts` целиком, вместе с
сегментами и `playbackPosition` в секундах.

Транспорт проверяется живой встречей, но **машина сегментов — тестами**: это
чистый автомат над `captureFrame` / `flush` / `clearBuffer`, и именно в нём
жила ошибка, дважды выбивавшая ассистента из встречи. Спека требует покрыть
её и единицу измерения позиции.

- [ ] **Step 1: Добавить зависимость**

```bash
cd voice-host && npm install ws @types/ws --save
```

- [ ] **Step 2: Написать модуль**

```ts
// spirits_back/voice-host/src/attendee-audio.ts
import { voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { WebSocketServer, type WebSocket } from 'ws';
import { Mixer, TICK_MS } from './mixer.js';

/**
 * Звук встречи на площадке без LiveKit — через вебсокет Attendee.
 *
 * Пара к mixed-audio-input.ts и external-room-output.ts: те же два конца
 * сессии, но снаружи не вторая комната LiveKit, а вебсокет. Attendee
 * подключается К НАМ (и ретраит до 30 раз с интервалом 2 с), поэтому здесь
 * сервер, а не клиент.
 *
 * Частота 24 кГц на всём пути: родная для OpenAI Realtime, ресемплинга нет
 * нигде — ни у нас, ни в Attendee.
 */

export const SAMPLE_RATE = 24_000;
export const SAMPLES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000; // 480

/** Что Attendee присылает нам. */
interface InboundAudio {
  trigger: 'realtime_audio.mixed';
  data: { chunk: string; sample_rate: number; timestamp_ms?: number };
}

/**
 * Один сервер на все встречи: `callId` приходит в query, по нему находим,
 * чьё это соединение. Отдельный порт на звонок означал бы дырявый файрвол и
 * гонку за портами между заданиями.
 */
export class AttendeeAudioHub {
  private readonly wss: WebSocketServer;
  private readonly waiting = new Map<string, (ws: WebSocket) => void>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws, req) => {
      const callId = new URL(req.url ?? '', 'http://x').searchParams.get('callId') ?? '';
      const claim = this.waiting.get(callId);
      if (!claim) {
        // Задание ещё не поднялось или уже завершилось. Рвать соединение
        // нельзя молча: Attendee ретраит, и в логе должно быть видно, почему.
        console.log(`[attendee] соединение для неизвестного callId=${callId}`);
        ws.close();
        return;
      }
      this.waiting.delete(callId);
      console.log(`[attendee] звук подключился, callId=${callId}`);
      claim(ws);
    });
    console.log(`[attendee] жду звук на :${port}`);
  }

  /** Занять место под звонок до того, как Attendee подключится. */
  expect(callId: string): Promise<WebSocket> {
    return new Promise((resolve) => this.waiting.set(callId, resolve));
  }

  close(): void {
    this.wss.close();
  }
}

/**
 * Вход сессии из вебсокета.
 *
 * Микширование не нужно — Attendee отдаёт готовый микс. Нужен РИТМ: Realtime
 * ждёт ровный кадр каждые 20 мс, а куски по сети приходят вразнобой и разной
 * длины. Mixer именно это и делает — буфер с потолком полсекунды и добивка
 * тишиной; с одним участником сумма вырождается в проброс.
 */
export class AttendeeAudioInput extends voice.AudioInput {
  private mixer = new Mixer(SAMPLES_PER_TICK);
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;
  private push: (f: AudioFrame) => void = () => {};
  private framesIn = 0;
  private ticks = 0;

  constructor(private readonly ws: WebSocket) {
    super();

    const source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.push = (frame) => {
          if (this.closed) return;
          try { controller.enqueue(frame); } catch { /* поток закрыт раньше тика */ }
        };
      },
    });
    this.multiStream.addInputStream(source);

    this.ws.on('message', (raw) => {
      let msg: InboundAudio;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.trigger !== 'realtime_audio.mixed' || !msg.data?.chunk) return;
      const buf = Buffer.from(msg.data.chunk, 'base64');
      // PCM16 little-endian. Копируем в свой буфер: Int16Array поверх чужого
      // Buffer живёт ровно до следующего сообщения ws.
      const pcm = new Int16Array(buf.byteLength / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
      this.framesIn++;
      this.mixer.push('meet', pcm);
    });

    this.ticker = setInterval(() => {
      if (this.closed) return;
      this.push(new AudioFrame(this.mixer.tick(), SAMPLE_RATE, 1, SAMPLES_PER_TICK));
      // Без этой строки «никто не говорит» и «звук до нас не доходит»
      // выглядят одинаково — тишиной. На своих комнатах я гадал здесь трижды.
      if (++this.ticks % 250 === 0) {
        console.log(`[вход] тиков: ${this.ticks}, кусков от Attendee: ${this.framesIn}`);
      }
    }, TICK_MS);
    // unref обязателен: иначе таймер держит event loop, задание не завершается,
    // и фреймворк убивает его как «unresponsive» вместе с недоотправленным
    // complete. Так дважды терялся транскрипт целиком.
    this.ticker.unref?.();
  }

  override async close(): Promise<void> {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    await super.close();
  }
}

/**
 * Голос ассистента — в вебсокет.
 *
 * Зеркало ExternalRoomAudioOutput, вместе с двумя вещами, которые там стоили
 * живых встреч: сегменты открываются первым кадром и закрываются только после
 * доигрывания, а `playbackPosition` считается В СЕКУНДАХ. Миллисекунды OpenAI
 * отбивал («Audio content of 34350ms is already shorter than 10799999ms»),
 * сегмент зависал, и ассистент выпадал из встречи посреди фразы.
 *
 * Отличие одно: ждать доигрывания нечего — очередь держит уже не наш
 * AudioSource, а Attendee. Позицию сообщаем сразу по flush.
 */
export class AttendeeAudioOutput extends voice.AudioOutput {
  private segmentOpen = false;
  private segment = 0;
  private pushedSec = 0;
  private interrupted = false;
  private frames = 0;

  constructor(private readonly ws: WebSocket) {
    super(SAMPLE_RATE);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.segment += 1;
      console.log(`[сегмент ${this.segment}] открыт`);
      this.onPlaybackStarted(Date.now());
    }
    const buf = Buffer.alloc(frame.data.length * 2);
    for (let i = 0; i < frame.data.length; i++) buf.writeInt16LE(frame.data[i], i * 2);
    this.ws.send(JSON.stringify({
      trigger: 'realtime_audio.bot_output',
      data: { chunk: buf.toString('base64'), sample_rate: SAMPLE_RATE },
    }));
    this.pushedSec += frame.samplesPerChannel / SAMPLE_RATE;
    if (++this.frames % 250 === 0) console.log(`[выход] кадров ассистента: ${this.frames}`);
  }

  flush(): void {
    super.flush();
    if (!this.segmentOpen) return;
    this.finishSegment(this.interrupted);
  }

  private finishSegment(interrupted: boolean): void {
    if (!this.segmentOpen) return;
    const position = this.pushedSec;
    console.log(`[сегмент ${this.segment}] закрыт: ${position.toFixed(1)}с${interrupted ? ', прерван' : ''}`);
    this.segmentOpen = false;
    this.pushedSec = 0;
    this.interrupted = false;
    // В СЕКУНДАХ. См. комментарий в шапке класса.
    this.onPlaybackFinished({ playbackPosition: position, interrupted });
  }

  /**
   * Ассистента перебили.
   *
   * Своей очереди у нас нет, поэтому гасить нечего — но сегмент закрыть
   * обязаны, иначе сессия ждёт конца реплики, которой уже не будет.
   *
   * ВНИМАНИЕ: недосказанное всё ещё лежит в буфере Attendee и договорится
   * поверх нового собеседника. Есть ли у Attendee команда сброса очереди —
   * вопрос к спайку; если нет, перебивание будет слышно хуже, чем в своих
   * комнатах, и это надо записать в спеку как известное ограничение.
   */
  clearBuffer(): void {
    this.interrupted = true;
    if (this.segmentOpen) this.finishSegment(true);
  }
}
```

- [ ] **Step 3: Тесты машины сегментов**

`voice-host/src/attendee-audio.test.ts`. Вебсокет подменяем заглушкой —
нужны только `readyState`, `OPEN`, `send` и `on`.

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFrame } from '@livekit/rtc-node';
import { AttendeeAudioOutput, SAMPLE_RATE } from './attendee-audio.js';

/** Минимальная заглушка ws: копит отправленное, слушателей не зовёт. */
function fakeWs() {
  const sent: any[] = [];
  return {
    OPEN: 1, readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    on: () => {},
    sent,
  } as any;
}

/** Кадр на 20 мс: 480 сэмплов при 24 кГц. */
const frame = () => new AudioFrame(new Int16Array(480), SAMPLE_RATE, 1, 480);

describe('AttendeeAudioOutput', () => {
  test('кадр уходит в ws правильным триггером и частотой', async () => {
    const ws = fakeWs();
    await new AttendeeAudioOutput(ws).captureFrame(frame());
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].trigger, 'realtime_audio.bot_output');
    assert.equal(ws.sent[0].data.sample_rate, 24_000);
    // 480 сэмплов PCM16 → 960 байт → base64 длиной 1280.
    assert.equal(Buffer.from(ws.sent[0].data.chunk, 'base64').length, 960);
  });

  test('позиция сегмента считается В СЕКУНДАХ', async () => {
    // Главная проверка этого файла. Миллисекунды OpenAI отбивал командой
    // обрезки («Audio content of 34350ms is already shorter than
    // 10799999ms»), сегмент зависал, и ассистент выпадал из встречи посреди
    // фразы. Живая встреча 03.09.2026.
    const ws = fakeWs();
    const out = new AttendeeAudioOutput(ws);
    let finished: any;
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    for (let i = 0; i < 50; i++) await out.captureFrame(frame()); // 50 × 20 мс = 1 с
    out.flush();
    assert.ok(Math.abs(finished.playbackPosition - 1) < 1e-6, `ожидалась 1 секунда, получено ${finished.playbackPosition}`);
    assert.equal(finished.interrupted, false);
  });

  test('сегмент открывается ровно раз на серию кадров', async () => {
    const ws = fakeWs();
    const out = new AttendeeAudioOutput(ws);
    let starts = 0;
    (out as any).onPlaybackStarted = () => { starts++; };
    await out.captureFrame(frame());
    await out.captureFrame(frame());
    assert.equal(starts, 1);
  });

  test('flush без кадров ничего не закрывает', async () => {
    // Иначе сессия получила бы конец реплики, которой не было.
    const out = new AttendeeAudioOutput(fakeWs());
    let closed = 0;
    (out as any).onPlaybackFinished = () => { closed++; };
    out.flush();
    assert.equal(closed, 0);
  });

  test('второй flush поверх закрытого сегмента не повторяет событие', async () => {
    const out = new AttendeeAudioOutput(fakeWs());
    let closed = 0;
    (out as any).onPlaybackFinished = () => { closed++; };
    await out.captureFrame(frame());
    out.flush();
    out.flush();
    assert.equal(closed, 1);
  });

  test('перебивание закрывает сегмент как прерванный', async () => {
    // Без этого сессия ждала бы конца реплики, которой уже не будет.
    const out = new AttendeeAudioOutput(fakeWs());
    let finished: any;
    (out as any).onPlaybackFinished = (e: any) => { finished = e; };
    await out.captureFrame(frame());
    out.clearBuffer();
    assert.equal(finished.interrupted, true);
  });

  test('следующий сегмент начинает счёт с нуля', async () => {
    const out = new AttendeeAudioOutput(fakeWs());
    const positions: number[] = [];
    (out as any).onPlaybackFinished = (e: any) => { positions.push(e.playbackPosition); };
    await out.captureFrame(frame());
    out.flush();
    await out.captureFrame(frame());
    await out.captureFrame(frame());
    out.flush();
    assert.equal(positions.length, 2);
    assert.ok(positions[1] > positions[0], 'счётчик не обнулился между сегментами');
  });

  test('закрытый ws кадры не роняют', async () => {
    const ws = fakeWs();
    ws.readyState = 3; // CLOSED
    const out = new AttendeeAudioOutput(ws);
    await out.captureFrame(frame());
    assert.equal(ws.sent.length, 0);
  });
});
```

- [ ] **Step 4: Прогнать — сначала падают, после реализации зелено**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npx tsx --test src/attendee-audio.test.ts'
```

Добавить файл в скрипт `test` в `voice-host/package.json`.

- [ ] **Step 5: Собрать**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm ci && npm run build && npm test'
```

Ожидается: сборка без ошибок, все тесты зелёные.

- [ ] **Step 6: Commit**

```bash
git add voice-host/src/attendee-audio.ts voice-host/src/attendee-audio.test.ts \
        voice-host/package.json voice-host/package-lock.json
git commit -m "feat(voice-host): аудио-мост в встречу через вебсокет Attendee"
```

---

### Task 10: Проводка в agent.ts

**Files:**
- Modify: `spirits_back/voice-host/src/agent.ts`

**Требует Task 2, 7, 9.** Третья ветка рядом с `foreign`. Ветку `stage` не
ломаем — своим комнатам и Taler ID эта задача ничего не меняет.

- [ ] **Step 1: Хаб вебсокета — один на процесс**

Рядом с `cli.runApp(...)`, до `defineAgent`:

```ts
const ATTENDEE_WS_PORT = Number(process.env.ATTENDEE_WS_PORT || 8138);
/** Один хаб на процесс воркера: задания приходят в него по callId. */
const attendeeHub = new AttendeeAudioHub(ATTENDEE_WS_PORT);
```

- [ ] **Step 2: Признак ветки, состав и подключение**

Рядом с `isForeign`, то есть **до** обработчика `DataReceived` (он объявлен
около строки 314) и до блока `occupancy` (около 530). Порядок объявлений здесь
принципиален: обе эти части читают `presence`, и если объявить его внутри
блока `occupancy`, обработчик данных его не увидит — код просто не соберётся.

```ts
    /**
     * Встреча на площадке без LiveKit (Meet через Attendee). Отличается от
     * isForeign тем, что второй комнаты нет вовсе: звук идёт вебсокетом, а
     * наша комната остаётся пустой и нужна только ради job и дата-канала.
     */
    const isMeet = isMeeting && meta.provider === 'meet';

    /**
     * Состав встречи Meet. В нашей комнате участников нет вовсе, поэтому
     * источник состава — вебхуки Attendee, доезжающие по дата-каналу.
     * Исключаем себя: бот Attendee сидит в встрече полноправным участником и
     * приходит в join_leave наравне с людьми.
     */
    const presence = isMeet
      ? new Presence(`${agentName} · ассистент ${meta.ownerName || 'пользователя'}`)
      : null;

    /**
     * Раздать состав тем, кто на него опирается.
     *
     * Без этого гейт по имени срывался бы в solo и ассистент отвечал на каждую
     * реплику встречи, а правила выхода уводили бы его из живой встречи через
     * LOBBY_MS.
     */
    const syncFromPresence = (): void => {
      if (!presence || !occupancy) return;
      gate?.setSolo(presence.solo);
      console.log(`[гейт] участников: ${presence.count} → ${presence.solo ? 'наедине' : 'строгий гейт'}`);
    };
```

После блока `if (isForeign) { … }`:

```ts
    let attendeeWs: WebSocket | null = null;
    if (isMeet) {
      // Место занимаем ДО ожидания: Attendee мог подключиться, пока
      // поднималось задание, и тогда соединение уже ждёт нас.
      attendeeWs = await attendeeHub.expect(meta.callId);
      console.log('[meet] звук Attendee на связи');
    }
```

- [ ] **Step 3: Подмена концов сессии — ДО `session.start()`**

Там, где сейчас выставляются `session.input.audio` и `session.output.audio`:

```ts
    // Порядок критичен: свой вход выставляется ДО start(). Поставленный после
    // молча игнорируется с записью `input.audio is already set, ignoring`.
    if (isMeet && attendeeWs) {
      session.input.audio = new AttendeeAudioInput(attendeeWs);
      session.output.audio = new AttendeeAudioOutput(attendeeWs);
    } else {
      const stage = foreign ?? ctx.room;
      session.input.audio = new MixedRoomAudioInput(stage);
      if (foreign) { /* существующая ветка без изменений */ }
    }
```

Комнату для `session.start()` определить по результату спайка (вопрос 3):

```ts
    await session.start({
      agent: new voice.Agent({ instructions, tools }),
      // Для Meet — наша пустая комната: разговор идёт вне LiveKit, привязывать
      // сессию больше некуда. На Taler ID именно такая привязка остановила
      // планировщик речи («skipping user input, speech scheduling is paused»),
      // но там причиной была РАССОГЛАСОВАННОСТЬ: вход брался из чужой комнаты,
      // а сессия сидела в нашей, и RoomIO ждал участников там, где их не будет.
      // Здесь вход вообще не из комнаты, поэтому RoomIO не создаётся.
      //
      // ЕСЛИ спайк (вопрос 3) показал, что планировщик всё равно встаёт —
      // убрать `room` из вызова для ветки Meet целиком: свои входы и выходы у
      // нас уже выставлены, комната сессии нужна только штатному RoomIO.
      room: isMeet ? ctx.room : (foreign ?? ctx.room),
      inputOptions: { closeOnDisconnect: false },
    });
```

- [ ] **Step 4: Присутствие из дата-канала**

В обработчике `RoomEvent.DataReceived` (там, где разбираются `document_ready`
и ответы специалистов), добавить ветки:

```ts
      if (msg.type === 'meet_participant') {
        presence?.apply({ event: msg.event, uuid: msg.uuid, name: msg.name });
        // occupancy ведёт участников множеством по ключу — отдаём ему uuid,
        // а не имя: тёзки иначе схлопнулись бы в одного, и уход одного из них
        // выглядел бы как уход обоих.
        if (msg.event === 'join') occupancy?.joined(msg.uuid);
        else occupancy?.left(msg.uuid);
        syncFromPresence();
        if (msg.event === 'join') {
          // Отметка «встреча началась». Без неё voice_calls.status навсегда
          // остаётся dialing и запирает пользователю следующий вход до
          // реапера — то есть на 130 минут.
          void backend.meetingFirstHuman(meta.callId).catch(() => {});
        }
        return;
      }
      if (msg.type === 'meet_speaking') {
        presence?.speech(msg.uuid, msg.name, msg.speaking);
        currentSpeaker = presence?.speaker;
        return;
      }
      if (msg.type === 'meet_bot_state' && msg.fatal) {
        // Не пустили или бот умер: сидеть в пустой комнате незачем.
        console.log(`[meet] бот в состоянии ${msg.state} — выходим`);
        void backend.failed(meta.callId, `бот Attendee: ${msg.state}`).catch(() => {});
        void session.close().catch(() => {});
        return;
      }
```

- [ ] **Step 5: Не подписываться на события комнаты в ветке Meet**

Существующий блок `if (occupancy) { … }` целиком заворачивается в развилку:
подписки на `ParticipantConnected` / `ParticipantDisconnected` для Meet
бессмысленны — в нашей комнате никого не будет, а состав уже приходит по
дата-каналу (Step 4).

```ts
    if (occupancy) {
      if (isMeet) {
        // Состав приезжает вебхуками. Здесь только начальная раздача: до
        // первого события гейт обязан быть строгим, а не solo.
        syncFromPresence();
      } else {
        const stage = foreign ?? ctx.room;
        // ВЕСЬ существующий код блока без изменений: предзаполнение из
        // stage.remoteParticipants, локальный syncSolo, подписки на
        // ParticipantConnected / ParticipantDisconnected.
      }

      // Таймер вердикта — общий для всех ветвей, из развилки его не выносить.
      const watch = setInterval(() => { /* существующий код */ }, 5_000);
      watch.unref?.();
    }
```

Локальный `syncSolo` в ветке не-Meet остаётся как есть: он читает комнату, и
для своих встреч и Taler ID это по-прежнему верный источник.

- [ ] **Step 6: Уборка**

В `ctx.addShutdownCallback`, рядом с закрытием чужой комнаты:

```ts
      // Закрываем только соединение: своей очереди звука у вывода нет, и
      // метода close() у него, в отличие от ExternalRoomAudioOutput, тоже —
      // публиковать и снимать дорожку здесь нечего.
      try { attendeeWs?.close(); } catch {}
```

Бот Attendee выводится из встречи не здесь, а на стороне бэкенда (Task 15):
воркер о его id не знает, а `voice_calls.external_bot_id` читает реапер.

- [ ] **Step 7: Собрать и закоммитить**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm run build && npm test'
git add voice-host/src/agent.ts
git commit -m "feat(voice-host): ветка встречи Meet — звук вебсокетом, состав вебхуками"
```

---

### Task 11: Контроллер вебхуков

**Files:**
- Create: `spirits_back/src/meeting/meet-webhook.controller.ts`
- Test: `spirits_back/src/meeting/meet-webhook.controller.spec.ts`

**Требует Task 4, 6.** Тело разбирается обычным JSON-парсером — правки в
`main.ts` не нужно, подпись считается по канонизированному JSON.

- [ ] **Step 1: Написать падающие тесты**

```ts
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { MeetWebhookController } from './meet-webhook.controller';
import { canonicalJson } from './attendee-signature';
import { createHmac } from 'crypto';

const SECRET = 's1';
const sign = (p: unknown) => createHmac('sha256', SECRET).update(canonicalJson(p), 'utf8').digest('base64');

describe('MeetWebhookController', () => {
  let livekit: { send: jest.Mock };
  let calls: { load: jest.Mock };
  let ctl: MeetWebhookController;

  beforeEach(() => {
    process.env.ATTENDEE_WEBHOOK_SECRET = SECRET;
    livekit = { send: jest.fn().mockResolvedValue(undefined) };
    calls = { load: jest.fn().mockResolvedValue({ id: 'c1', room_name: 'meet_c1', status: 'active' }) };
    ctl = new MeetWebhookController(livekit as any, calls as any);
  });

  const hook = (trigger: string, data: unknown) => ({
    idempotency_key: 'k1', bot_id: 'b1', bot_metadata: { callId: 'c1' }, trigger, data,
  });

  it('вход участника уходит в комнату звонка', async () => {
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join', timestamp_ms: 1,
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).toHaveBeenCalledWith('meet_c1', {
      v: 1, type: 'meet_participant', event: 'join', uuid: 'u1', name: 'Сергей',
    });
  });

  it('выход участника тоже', async () => {
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'leave', timestamp_ms: 2,
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].event).toBe('leave');
  });

  it('говорящий уходит отдельным событием', async () => {
    const p = hook('participant_events.speech_start_stop', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'speech_start',
    });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_speaking', uuid: 'u1', name: 'Сергей', speaking: true,
    });
  });

  it('смертельное состояние бота помечается fatal', async () => {
    const p = hook('bot.state_change', { new_state: 'fatal_error', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1]).toEqual({
      v: 1, type: 'meet_bot_state', state: 'fatal_error', fatal: true,
    });
  });

  it('обычное состояние бота не считается смертельным', async () => {
    const p = hook('bot.state_change', { new_state: 'joined_recording', old_state: 'joining' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send.mock.calls[0][1].fatal) .toBe(false);
  });

  it('повтор по idempotency_key не дублируется', async () => {
    // Attendee ретраит настойчиво; дубль «вошёл» ничего не сломает в Presence,
    // но чистить канал от повторов дешевле здесь.
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join', timestamp_ms: 1,
    });
    await ctl.receive(sign(p), p as any);
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).toHaveBeenCalledTimes(1);
  });

  it('плохая подпись — 401 и ничего не отправлено', async () => {
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive('мусор', p as any)).rejects.toThrow(UnauthorizedException);
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('без секрета — 503', async () => {
    delete process.env.ATTENDEE_WEBHOOK_SECRET;
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).rejects.toThrow(ServiceUnavailableException);
  });

  it('событие без callId в метаданных игнорируется молча', async () => {
    const p = { idempotency_key: 'k9', bot_id: 'b1', trigger: 'bot.state_change', data: { new_state: 'joined' } };
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('завершённый звонок не получает событий', async () => {
    calls.load.mockResolvedValue({ id: 'c1', room_name: 'meet_c1', status: 'completed' });
    const p = hook('bot.state_change', { new_state: 'joined' });
    await ctl.receive(sign(p), p as any);
    expect(livekit.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Прогнать — падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/meet-webhook --maxWorkers=2'
```

- [ ] **Step 3: Реализовать**

```ts
// spirits_back/src/meeting/meet-webhook.controller.ts
import {
  Body, Controller, Headers, Logger, Post, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { verifyAttendeeSignature } from './attendee-signature';

/**
 * Вебхуки Attendee.
 *
 * Через них в воркер попадает то, чего он на встрече Meet не видит сам: состав
 * участников и кто говорит. В нашей LiveKit-комнате при такой встрече никого
 * нет, `remoteParticipants` всегда пуст, и без этого канала гейт по имени
 * срывался бы в solo, а правила выхода уводили ассистента из живой встречи.
 *
 * Тело разбирается обычным JSON-парсером, в отличие от `voice-call/internal`:
 * подпись Attendee считается по КАНОНИЗИРОВАННОМУ JSON, а не по сырым байтам,
 * поэтому сырое тело здесь не нужно и в main.ts ничего вешать не требуется.
 */

/** Состояния, после которых встречи не будет. */
const FATAL_STATES = new Set(['fatal_error', 'denied_entry', 'removed_from_meeting', 'ended']);

interface AttendeeHook {
  idempotency_key?: string;
  bot_id?: string;
  bot_metadata?: { callId?: string };
  trigger: string;
  data: Record<string, any>;
}

@Controller('meet')
export class MeetWebhookController {
  private readonly logger = new Logger(MeetWebhookController.name);
  /**
   * Уже обработанные события.
   *
   * Attendee ретраит настойчиво, а дубли «вошёл» копили бы участников в
   * Presence. Память процесса — этого достаточно: событие живёт секунды, а
   * рестарт означает, что и звонка уже нет.
   */
  private readonly seen = new Set<string>();

  constructor(
    private readonly livekit: LiveKitClient,
    private readonly calls: VoiceCallService,
  ) {}

  @Post('attendee')
  async receive(
    @Headers('x-webhook-signature') signature: string,
    @Body() body: AttendeeHook,
  ): Promise<{ ok: true }> {
    // Секрет читаем на КАЖДОМ запросе: process.env наполняется ConfigModule
    // позже вычисления module-level констант. На звонках эта ошибка уже
    // оставляла внутренние ручки мёртвыми при заданном секрете.
    const secret = process.env.ATTENDEE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('attendee webhooks are not configured');
    if (!verifyAttendeeSignature(secret, body, signature)) {
      throw new UnauthorizedException('bad signature');
    }

    const callId = body.bot_metadata?.callId;
    // Без callId событие адресовать некуда. Молча, а не ошибкой: это могут
    // быть события бота, заведённого не нами (например, вручную в UI).
    if (!callId) return { ok: true };

    const key = body.idempotency_key ? `${callId}:${body.idempotency_key}` : '';
    if (key && this.seen.has(key)) return { ok: true };
    if (key) this.seen.add(key);

    const call = await this.calls.load(callId).catch(() => null);
    // Звонок уже закрыт — отправлять в комнату нечего, она удалена.
    if (!call || !this.calls.isActive(call)) return { ok: true };

    const msg = this.toDataMessage(body);
    if (!msg) return { ok: true };
    await this.livekit.send(call.room_name, msg as any).catch((e: any) => {
      this.logger.warn(`[meet] событие ${body.trigger} не доехало: ${e?.message}`);
    });
    return { ok: true };
  }

  private toDataMessage(body: AttendeeHook): Record<string, unknown> | null {
    const d = body.data || {};
    switch (body.trigger) {
      case 'participant_events.join_leave':
        return {
          v: 1, type: 'meet_participant',
          event: d.event_type === 'leave' ? 'leave' : 'join',
          uuid: String(d.participant_uuid ?? ''),
          name: String(d.participant_name ?? ''),
        };
      case 'participant_events.speech_start_stop':
        return {
          v: 1, type: 'meet_speaking',
          uuid: String(d.participant_uuid ?? ''),
          name: String(d.participant_name ?? ''),
          speaking: d.event_type === 'speech_start',
        };
      case 'bot.state_change':
        return {
          v: 1, type: 'meet_bot_state',
          state: String(d.new_state ?? ''),
          fatal: FATAL_STATES.has(String(d.new_state ?? '')),
        };
      default:
        return null;
    }
  }
}
```

- [ ] **Step 4: Прогнать — зелено, и закоммитить**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting --maxWorkers=2'
git add src/meeting/meet-webhook.controller.ts src/meeting/meet-webhook.controller.spec.ts
git commit -m "feat(meeting): вебхуки Attendee — состав и говорящий в дата-канал"
```

---

### Task 12: Ветка provider='meet' во входе

**Files:**
- Modify: `spirits_back/src/meeting/meeting.service.ts`
- Modify: `spirits_back/src/meeting/meeting.module.ts`
- Test: `spirits_back/src/meeting/meeting.service.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

Дописать в существующий `meeting.service.spec.ts`, следуя его стилю моков:

```ts
  describe('встреча Google Meet', () => {
    it('создаёт бота и диспатчит агента в свою пустую комнату', async () => {
      const { svc, pg, livekit, attendee } = build();
      attendee.createBot.mockResolvedValue({ botId: 'bot_1' });
      const r = await svc.join('u1', 12, 'abc-defg-hij', 'meet');

      expect(attendee.createBot).toHaveBeenCalledWith(expect.objectContaining({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
      }));
      // Комната по callId, а не по коду встречи: одну и ту же встречу могут
      // позвать дважды, и имя по коду столкнулось бы с прошлой записью.
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        `meet_${r.callId}`,
        expect.objectContaining({ mode: 'meeting', provider: 'meet' }),
      );
      expect(pg.query.mock.calls.some(([sql, args]: any) =>
        /INSERT INTO voice_calls/.test(sql) && args.includes('meet') && args.includes('abc-defg-hij'),
      )).toBe(true);
    });

    it('комнату заводит заранее с запасом на всю встречу', async () => {
      // Наша комната пуста по замыслу, а дефолтный empty_timeout LiveKit —
      // 300 секунд: без этого ассистента выбрасывало ровно на 301-й секунде.
      const { svc, livekit, attendee } = build();
      attendee.createBot.mockResolvedValue({ botId: 'bot_1' });
      await svc.join('u1', 12, 'abc-defg-hij', 'meet');
      expect(livekit.ensureRoom).toHaveBeenCalledWith(expect.stringMatching(/^meet_/), 7200);
    });

    it('запоминает id бота — без него его не вывести из встречи', async () => {
      const { svc, pg, attendee } = build();
      attendee.createBot.mockResolvedValue({ botId: 'bot_1' });
      await svc.join('u1', 12, 'abc-defg-hij', 'meet');
      expect(pg.query.mock.calls.some(([sql, args]: any) =>
        /UPDATE voice_calls SET external_bot_id/.test(sql) && args.includes('bot_1'),
      )).toBe(true);
    });

    it('бот не поднялся — звонок помечен failed, а не оставлен в dialing', async () => {
      // Запись в dialing намертво блокирует пользователю следующий вход:
      // лимит «один активный» смотрит именно на неё.
      const { svc, pg, attendee } = build();
      attendee.createBot.mockResolvedValue(null);
      await expect(svc.join('u1', 12, 'abc-defg-hij', 'meet')).rejects.toThrow();
      expect(pg.query.mock.calls.some(([sql]: any) => /status = 'failed'/.test(sql))).toBe(true);
    });

    it('в комнату Meet не ходит за информацией — её негде взять', async () => {
      // У Meet нет публичной ручки «существует ли встреча». Проверить вход
      // заранее нельзя, узнаём из состояния бота.
      const { svc, rooms, talerid, attendee } = build();
      attendee.createBot.mockResolvedValue({ botId: 'bot_1' });
      await svc.join('u1', 12, 'abc-defg-hij', 'meet');
      expect(rooms.info).not.toHaveBeenCalled();
      expect(talerid.info).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Миграция под id бота**

```sql
-- spirits_back/src/meeting/migrations/004_meet_bot.sql
--
-- id бота Attendee. Нужен ровно для одного: вывести Chrome из встречи, когда
-- ассистент вышел. Без него бот остаётся сидеть в встрече — видимый участник,
-- которого никто не звал.
--
-- Отдельная колонка, а не JSON в summary: её читает реапер, и запрос по полю
-- честнее, чем разбор текста.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS external_bot_id TEXT;
```

- [ ] **Step 3: Реализовать ветку**

В `meeting.service.ts`. Константа рядом с существующими:

```ts
/** Он же для встреч Google Meet через Attendee. */
const PROVIDER_MEET = 'meet';
```

Конструктор — добавить `private readonly attendee: AttendeeClient`.

В `join()`, где определяется `title` / `roomName`:

```ts
    const isForeign = provider === 'talerid';
    const isMeet = provider === 'meet';
    const callId = randomUUID();

    let title: string;
    let roomName: string;
    let external: { url: string; token: string } | undefined;

    if (isMeet) {
      // За информацией о встрече идти некуда: публичной ручки «существует ли
      // такая встреча» у Meet нет. Значит и карточку мы показываем, не
      // проверив вход, и узнаём о неудаче из состояния бота уже после захода.
      // Название берём нейтральное — настоящего у нас нет.
      title = 'Встреча Google Meet';
      // По callId, а не по коду: одну встречу могут позвать дважды, а
      // room_name с уникальностью уже намучил (см. 003_drop_room_name_unique).
      roomName = `meet_${callId}`;
    } else if (isForeign) {
      // существующая ветка Taler ID без изменений
    } else {
      // существующая ветка своей комнаты без изменений
    }
```

Провайдер в `INSERT`:

```ts
      [callId, userId, agentId, roomName,
       isMeet ? PROVIDER_MEET : isForeign ? PROVIDER_TALERID : PROVIDER, code],
```

Внутри `try`, после `preamble` и `ownerName`:

```ts
      let botId: string | null = null;
      if (isMeet) {
        const bot = await this.attendee.createBot({
          meetingUrl: `https://meet.google.com/${code}`,
          // То же имя, что в своих комнатах и в Taler ID: участники должны
          // видеть, кто к ним пришёл и от кого.
          botName: `${agent.display_name} · ассистент ${ownerName}`,
          callId,
        });
        // Причина уже в логе клиента. Наружу — внятный отказ: молчаливое 500
        // выглядит поломкой, а это может быть просто выключенный Attendee.
        if (!bot) throw new ConflictException({ message: 'meeting bot is unavailable' });
        botId = bot.botId;
        await this.pg.query(`UPDATE voice_calls SET external_bot_id = $1 WHERE id = $2`, [botId, callId]);
      }
```

`ensureRoom` — теперь для обоих внешних провайдеров:

```ts
      // Наша комната при внешней встрече пуста, и LiveKit удалил бы её через
      // пять минут по дефолтному empty_timeout — ассистента выбрасывало ровно
      // на 301-й секунде. Заводим заранее с запасом на всю встречу.
      if (isForeign || isMeet) await this.livekit.ensureRoom(roomName, 2 * 60 * 60);
```

Метаданные диспатча:

```ts
        ...(isMeet ? { provider: PROVIDER_MEET } : {}),
        ...(external ? { provider: PROVIDER_TALERID, externalUrl: external.url, externalToken: external.token } : {}),
```

- [ ] **Step 4: Проводка модуля**

```ts
// meeting.module.ts
providers: [MeetingService, AttendeeClient],
controllers: [MeetingController, MeetWebhookController],
```

- [ ] **Step 5: Прогнать и накатить миграцию**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting --maxWorkers=2'
```

Миграции `src/*/migrations` на проде накатываются вручную через `psql` —
общий `npm run migrate` застревает на `base/001`:

```bash
ssh dvolkov@212.113.106.202 "PGPASSWORD=... psql -h localhost -p 5433 -U linkeon -d linkeon \
  -c \"ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS external_bot_id TEXT;\" \
  -c \"INSERT INTO schema_migrations (filename) VALUES ('meeting/004_meet_bot.sql') ON CONFLICT DO NOTHING;\""
```

- [ ] **Step 6: Commit**

```bash
git add src/meeting/meeting.service.ts src/meeting/meeting.module.ts \
        src/meeting/meeting.service.spec.ts src/meeting/migrations/004_meet_bot.sql
git commit -m "feat(meeting): вход ассистента во встречу Google Meet"
```

---

### Task 13: Карточка «Зайти» для Meet

**Files:**
- Modify: `spirits_back/src/chat/meeting-card.ts`
- Modify: `spirits_back/src/chat/chat.service.ts`
- Test: `spirits_back/src/chat/meeting-card.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```ts
  it('карточка встречи Meet несёт провайдера и код', () => {
    expect(buildMeetingCard('abc-defg-hij', 'Планёрка', 'meet'))
      .toBe('{{meeting_join: provider=meet code=abc-defg-hij title=Планёрка}}');
  });

  it('своя карточка осталась байт в байт прежней', () => {
    // В истории их накопилось, и менять формат задним числом значит сломать
    // разбор старых сообщений на фронте.
    expect(buildMeetingCard('ABC234', 'Планёрка')).toBe('{{meeting_join: code=ABC234 title=Планёрка}}');
  });
```

- [ ] **Step 2: Прогнать — падает**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/chat/meeting-card --maxWorkers=2'
```

Ожидается: FAIL по типам — `'meet'` не входит в тип параметра.

- [ ] **Step 3: Реализовать**

`meeting-card.ts` — расширить тип, логика уже общая:

```ts
  provider: 'linkeon' | 'talerid' | 'meet' = 'linkeon',
```

`chat.service.ts`, в блоке `if (meetingLink)` — третья ветка:

Ветка Meet встаёт **первой** в цепочке, ветки Taler ID и своей комнаты
переносятся без изменений:

```ts
      const room = meetingLink.provider === 'meet'
        // Проверять нечего: публичной ручки «существует ли встреча» у Meet
        // нет. Карточку показываем сразу — цена ошибки невелика (кнопка
        // приведёт к внятному отказу бота), а требовать проверки значит не
        // показывать карточку никогда.
        ? { code: meetingLink.code, title: 'Встреча Google Meet', active: true }
        : meetingLink.provider === 'talerid'
        ? await this.talerIdRooms
            ?.info(meetingLink.code)
            .then((r) => (r && r.isActive && !r.requiresPassword
              ? { code: r.code, title: r.title || r.creatorName, active: true }
              : null))
            .catch(() => null) ?? null
        : await this.rooms!.info(meetingLink.code).catch(() => null);
```

- [ ] **Step 4: Прогнать — зелено, и закоммитить**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/chat --maxWorkers=2'
git add src/chat/meeting-card.ts src/chat/meeting-card.spec.ts src/chat/chat.service.ts
git commit -m "feat(chat): карточка входа во встречу Google Meet"
```

---

### Task 14: Фронт

**Files:**
- Modify: `spirits/src/utils/customMarkdown.tsx`
- Test: `spirits/src/utils/customMarkdown.test.ts`
- Modify: `spirits/src/components/chat/MeetingJoinCard.tsx`

⚠️ **Первым делом**: тест `customMarkdown.test.ts:93` ждёт
`toEqual({ code, title })`, а реализация кладёт ещё и `provider`. Похоже, он
красный с момента появления Taler ID. Прогнать файл, убедиться, и починить
ожидание — иначе задача упрётся в чужую поломку.

- [ ] **Step 1: Проверить исходное состояние**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && source ~/.nvm/nvm.sh && pnpm install && npx vitest run src/utils/customMarkdown.test.ts'
```

Записать результат: если красный — это предсуществующая поломка, а не наша.

- [ ] **Step 2: Написать тесты**

```ts
  it('вынимает встречу Google Meet', () => {
    const { meetings } = parseCustomMarkdown(
      '{{meeting_join: provider=meet code=abc-defg-hij title=Планёрка}}',
    );
    expect([...meetings.values()][0]).toEqual({
      code: 'abc-defg-hij', title: 'Планёрка', provider: 'meet',
    });
  });

  it('своя встреча по-прежнему linkeon', () => {
    const { meetings } = parseCustomMarkdown('{{meeting_join: code=ABC234 title=Планёрка}}');
    expect([...meetings.values()][0].provider).toBe('linkeon');
  });

  it('встреча Taler ID не задета', () => {
    const { meetings } = parseCustomMarkdown(
      '{{meeting_join: provider=talerid code=36fc367a title=Созвон}}',
    );
    expect([...meetings.values()][0].provider).toBe('talerid');
  });

  it('незнакомый провайдер не проходит', () => {
    expect(parseCustomMarkdown(
      '{{meeting_join: provider=zoom code=abc-defg-hij title=Х}}',
    ).meetings.size).toBe(0);
  });
```

- [ ] **Step 3: Прогнать — падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && source ~/.nvm/nvm.sh && npx vitest run src/utils/customMarkdown.test.ts'
```

- [ ] **Step 4: Реализовать**

Регулярка (строка 66) — третья альтернатива провайдера и кода:

```ts
const MEETING_JOIN_REGEX =
  /\{\{meeting_join:\s*(?:provider=(talerid|meet)\s+)?code=([2-9A-HJ-NP-Z]{6}|[A-Fa-f0-9]{6,64}|[a-z]{3}-[a-z]{4}-[a-z]{3})\s+title=([^}]*?)\}\}/g;
```

Маппинг (строка 164):

```ts
      provider: provider === 'talerid' ? 'talerid' : provider === 'meet' ? 'meet' : 'linkeon',
```

Тип провайдера в интерфейсе карточки — добавить `'meet'`.

- [ ] **Step 5: Состояние «ждём, пока впустят» в карточке**

Единственный новый UX. В Meet бота обязан впустить хозяин встречи, и без этой
плашки человек видит «Зайти» → тишина и не понимает, что мяч на его стороне.

В `MeetingJoinCard.tsx`, в обработчике успешного `POST /webhook/meeting/join`:

```tsx
  // В Meet бот попадает в комнату ожидания, и впустить его должен хозяин
  // встречи. Без этой подсказки человек ждёт ассистента, а ассистент — его.
  const [waitingAdmit, setWaitingAdmit] = useState(false);

  // …в onJoin, после успешного ответа:
  if (provider === 'meet') {
    setWaitingAdmit(true);
    // Дольше ждать нет смысла: либо не заметили запрос, либо отказали.
    // Совпадает с AGENT_WAIT_MS звонка по духу, но встреча медленнее —
    // Attendee сам поднимает Chrome и грузит страницу Meet.
    setTimeout(() => setWaitingAdmit(false), 90_000);
  }
```

```tsx
  {waitingAdmit && (
    <p className="text-sm text-gray-500 mt-2">{t('meeting.waitingAdmit')}</p>
  )}
```

Ключ `meeting.waitingAdmit` — «Ассистент просит впустить его во встречу.
Подтвердите вход в Google Meet» — добавить во все семь локалей
(`ru en es de fr pt zh`). `pnpm check-locales` и `pnpm check-keys` это
проверяют, и без ключей сборка на ноде упадёт.

- [ ] **Step 6: Прогнать и закоммитить**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && source ~/.nvm/nvm.sh && pnpm test && pnpm build && pnpm check-locales'
```

```bash
git -C ../spirits add src/utils/customMarkdown.tsx src/utils/customMarkdown.test.ts \
  src/components/chat/MeetingJoinCard.tsx src/i18n/locales
git -C ../spirits commit -m "feat(chat): карточка входа во встречу Google Meet"
```

Использовать `git -C`: `cd` переносится между звеньями `&&`, и вторая половина
молча отработает в первом репозитории — так уже терялся push фронта.

---

### Task 15: Вывод бота при выходе ассистента

**Files:**
- Modify: `spirits_back/src/meeting/meeting.service.ts`
- Modify: `spirits_back/src/voice-call/voice-call-reaper.service.ts`
- Test: оба spec-файла

Без этого Chrome остаётся сидеть в встрече после того, как ассистент вышел.

- [ ] **Step 1: Написать падающие тесты**

Подпись — `leave(callId)`, один аргумент: владельца проверяет контроллер
(`meeting.controller.ts:37`), а не сервис.

```ts
// meeting.service.spec.ts
  it('leave выводит бота из встречи', async () => {
    const { svc, calls, attendee } = build();
    calls.load.mockResolvedValue({ id: 'c1', provider: 'meet', external_bot_id: 'bot_1' });
    await svc.leave('c1');
    expect(attendee.removeBot).toHaveBeenCalledWith('bot_1');
  });

  it('leave своей встречи бота не трогает', async () => {
    const { svc, calls, attendee } = build();
    calls.load.mockResolvedValue({ id: 'c1', provider: 'linkeon_room', external_bot_id: null });
    await svc.leave('c1');
    expect(attendee.removeBot).not.toHaveBeenCalled();
  });

  it('недоступность Attendee не мешает ассистенту выйти', async () => {
    // Выход ассистента важнее уборки бота: если removeBot упал, звонок всё
    // равно обязан закрыться, иначе пользователь заперт лимитом активных.
    const { svc, calls, attendee } = build();
    calls.load.mockResolvedValue({ id: 'c1', provider: 'meet', external_bot_id: 'bot_1' });
    attendee.removeBot.mockRejectedValue(new Error('сеть'));
    await svc.leave('c1');
    expect(calls.markInterruptedKeepingRoom).toHaveBeenCalledWith('c1');
  });
```

```ts
// voice-call-reaper.service.spec.ts
  it('зависшая встреча Meet — бот выведен, комната не закрыта', async () => {
    // Комнату при внешней встрече закрывать нельзя: у Taler ID в ней живые
    // люди, у Meet она наша и пустая, но её удаление ничего не решает.
    const { svc, pg, attendee, livekit } = build();
    pg.query.mockResolvedValue({ rows: [{ id: 'c1', room_name: 'meet_c1', provider: 'meet', external_bot_id: 'bot_1' }] });
    await svc.reap();
    expect(attendee.removeBot).toHaveBeenCalledWith('bot_1');
    expect(livekit.closeRoom).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Прогнать — падают**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting src/voice-call --maxWorkers=2'
```

- [ ] **Step 3: Реализовать**

`MeetingService.leave()` сейчас состоит из одной строки и звонок не загружает
— придётся загрузить, иначе id бота взять негде:

```ts
  async leave(callId: string): Promise<void> {
    // Ассистент вышел — бот обязан выйти вместе с ним. Иначе в встрече
    // остаётся сидеть Chrome: видимый участник, которого никто не звал.
    //
    // Загрузка и уборка обёрнуты в catch: выход ассистента важнее уборки
    // бота. Если Attendee недоступен, звонок всё равно обязан закрыться —
    // иначе запись останется активной и запрёт пользователю следующий вход.
    try {
      const call = await this.calls.load(callId);
      if (call?.external_bot_id) await this.attendee.removeBot(call.external_bot_id);
    } catch (e: any) {
      this.logger.warn(`[leave] бот call=${callId} не выведен: ${e?.message}`);
    }
    await this.calls.markInterruptedKeepingRoom(callId);
  }
```

То же в `VoiceCallReaperService.reap()`, в ветке `provider <> 'linkeon'` — там,
где сейчас `removeAgents`. `SELECT` там дополнить полем `external_bot_id`.
Реапер живёт в `VoiceCallModule`, а `AttendeeClient` — в `MeetingModule`,
поэтому внедрять его туда через `forwardRef`-импорт `MeetingModule` и
`@Optional()`: без Attendee реапер обязан продолжать работать.

- [ ] **Step 4: Прогнать — зелено, и закоммитить**

```bash
git add src/meeting/meeting.service.ts src/meeting/meeting.service.spec.ts \
        src/voice-call/voice-call-reaper.service.ts src/voice-call/voice-call-reaper.service.spec.ts
git commit -m "fix(meeting): бот Attendee выходит из встречи вместе с ассистентом"
```

---

### Task 16: Живая проверка и деплой

**Files:** none

- [ ] **Step 1: Полный прогон на ноде**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src --maxWorkers=2'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
ssh dv@85.192.61.231 'cd ~/ci/spirits_front && source ~/.nvm/nvm.sh && pnpm test && pnpm build'
```

- [ ] **Step 2: Окружение**

В `.env` бэкенда: `ATTENDEE_BASE_URL`, `ATTENDEE_API_KEY`,
`ATTENDEE_WEBHOOK_SECRET`, `ATTENDEE_WEBHOOK_URL`, `ATTENDEE_AUDIO_WS_URL`.
В `voice-host/.env`: `ATTENDEE_WS_PORT=8138`.

Порт вебсокета должен быть доступен Attendee снаружи — завести проксирование
в nginx рядом с существующим `/voice/stream`, иначе бот не подключится и
встреча будет тихой без единой ошибки в логе.

- [ ] **Step 3: Не добавлять Attendee в smoke**

Решение, а не упущение. Проверка встречи Meet потребовала бы живой встречи с
живым человеком, который впустит бота, — в smoke это невоспроизводимо. А
простая проверка «Attendee отвечает на `/`» валила бы деплой при перезапуске
контейнера, то есть блокировала бы несвязанные выкатки.

Ставим то же правило, что у генерации картинок: апстрим-падение даёт `⊘ SKIP`
с предупреждением, а не `fail`. Практически это означает — в `tests/smoke/`
проверки Attendee **не добавляем вовсе**, а здоровье моста смотрим
мониторингом (`src/monitoring/`), как это сделано для SMS и платежей. Отдельной
задачей, не здесь.

- [ ] **Step 4: Деплой**

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Только так. Двухфазный: `test.linkeon.io` → smoke → прод → smoke.

Шаг сборки `voice-host` в `deploy.sh` уже есть (строки 202–218 и 435–454), но
выполняется лишь при наличии `voice-host/.env` — проверить, что файл на месте,
иначе новый воркер молча не соберётся и встречи Meet будут тихими.

- [ ] **Step 5: Живая встреча — двое человек и ассистент**

| Проверка | Ожидание |
|---|---|
| Ссылка в чат | Карточка «Зайти» появилась |
| Кнопка | Бот попросил впуска, карточка показала ожидание |
| Впустили | Представился, проговорил правило обращения и запись |
| Разговор мимо ассистента | **Молчит** — гейт не сорвался в solo. Главный риск |
| «Роман, что думаешь?» | Ответил |
| «Роман, пока слушай» | Умолк, потом «Роман, вопрос к тебе» — вернулся |
| «Роман, это не тебе» | Умолк **молча** |
| Перебивание | Не говорит поверх человека |
| `ask_specialist` | Ответ коллеги озвучен |
| Все вышли | Ассистент вышел, бот удалён, Chrome не висит |

- [ ] **Step 6: Проверить учёт**

```sql
SELECT id, status, first_human_at, duration_sec, tokens_charged, external_bot_id
  FROM voice_calls WHERE provider = 'meet' ORDER BY started_at DESC LIMIT 5;
```

`status` обязан уйти из `dialing`, `first_human_at` — заполниться. Иначе
пользователь заперт на 130 минут до реапера. Проверить и разметку говорящего в
`transcript`.

- [ ] **Step 7: Замерить и дописать в спеку**

RSS бота Attendee на живой встрече, time-to-first-audio, стоимость часа.
Плюс раздел «Результаты спайка», если он ещё не дописан.

```bash
git add docs/superpowers/specs/2026-09-06-meeting-bridge-meet-design.md
git commit -m "docs(spec): замеры первой живой встречи Google Meet"
```

---

## Порядок и зависимости

```
Task 1 (Attendee) ──► Task 2 (СПАЙК — гейт) ──► Task 9 ──► Task 10 ──┐
                                                                      │
Task 3 (ссылка) ─────────────────────────────────────┐                │
Task 4 (подпись) ──► Task 11 (вебхуки) ──────────────┤                │
Task 5 (клиент) ─────────────────────────────────────┼──► Task 12 ────┼──► Task 16
Task 6 (типы) ──► Task 7 (presence) ─────────────────┤    (вход)      │    (живьём)
Task 8 (микшер) ─────────────────────────────────────┘                │
Task 13 (карточка) ──► Task 14 (фронт) ──────────────────────────────┤
Task 15 (уборка бота) ───────────────────────────────────────────────┘
```

Задачи 3–8 и 13–14 от спайка не зависят — можно делать параллельно, пока
поднимается Attendee. Задачи 9–10 без результатов спайка не начинать.
