# Чат комнаты Taler ID: ассистент пишет и читает

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ассистент на встрече в чужой комнате Taler ID получает текстовый канал: кладёт в чат комнаты ссылку на готовый документ, пишет туда сам по своему решению и слышит то, что участники пишут текстом.

**Architecture:** Запись — REST `POST {base}/voice/rooms/{roomName}/chat` с participant-токеном, который бэкенд уже добывает в `MeetingService.join()`. Чтения по REST нет вовсе, зато их сервер публикует каждое сообщение чата в саму LiveKit-комнату data-пакетом — а воркер к этой комнате уже подключён (`foreign`). Значит весь канал живёт в воркере: бэкенд лишь передаёт ему готовый URL ручки в метаданных job. Схему БД не трогаем и токен нигде не храним — событие о готовом документе и так приходит воркеру data-каналом нашей комнаты вместе с полем `url`.

**Tech Stack:** NestJS 10 (бэкенд), `@livekit/rtc-node` + `@livekit/agents` 1.7.0 (воркер `voice-host`, ESM, тесты на `node:test` через `tsx --test`), jest + ts-jest (бэкенд).

---

## Что проверено живьём (07.09.2026, комната `36fc367a`, roomName `personal-c79530ed-36fc367a`)

Это факты, снятые curl-ом и подключением к их LiveKit, а не догадки. На них опирается весь план.

| Проверка | Результат |
|---|---|
| `POST /voice/rooms/{roomName}/chat`, `Authorization: Bearer <participant token>`, тело `{"text","name"}` | `201 {"ts":1788768370404}` |
| То же с префиксом `/api/` | тоже `201` — работают оба пути |
| Без `Authorization` | `401 {"message":"No token"}` |
| Чужой roomName тем же токеном | `403 {"message":"No access to this room"}` |
| `GET .../chat`, `GET .../messages` | `404 Cannot GET` — читать по REST нечего |
| Сообщение в LiveKit-комнате | data-пакет, `kind=RELIABLE`, `topic` пустой, participant пустой (публикует их сервер, а не участник) |
| Payload пакета | `{"type":"chat_message","text":"…","name":"probe-writer","ts":1788768440123,"msgId":"server_f46cf041-…"}` |

**Ловушка, ради которой этот раздел и написан:** своё же отправленное сообщение прилетает обратно тем же пакетом, и прилетает РАНЬШЕ, чем резолвится промис отправляющего `fetch` — в логе пробы строка `DATA …` встала выше строки `POST /chat → 201`. Поэтому отбрасывать эхо по `ts`, полученному из ответа POST, НЕЛЬЗЯ: к моменту прихода эха этого `ts` у нас ещё нет. Отбрасываем по полю `name` — сервер возвращает его ровно таким, каким мы его послали.

## Структура файлов

**Создаём:**
- `voice-host/src/external-chat.ts` — весь канал: отправка через их REST, разбор входящего data-пакета, отсев собственного эха. Без импортов LiveKit и без состояния встречи — чистый модуль, который тестируется без комнаты.
- `voice-host/src/external-chat.test.ts` — тесты к нему.

**Меняем:**
- `src/meeting/talerid-room.client.ts` — метод `chatUrl(roomName)`.
- `src/meeting/talerid-room.client.spec.ts` — тесты к нему.
- `src/meeting/meeting.service.ts:160-192` — кладём `externalChatUrl` в метаданные dispatch.
- `src/meeting/meeting.service.spec.ts` — проверка метаданных.
- `voice-host/src/agent.ts` — создание канала, тул `write_to_chat`, ссылка на документ, чтение чата.
- `voice-host/src/prompts.ts` — строка про чат в `meetingInstructions`, новая функция `answerToChat`.
- `voice-host/src/prompts.test.ts` — тесты к ним.
- `voice-host/package.json` — новый тест-файл в скрипт `test`.

**Не трогаем:** схему `voice_calls`, `voice-document.service.ts`, поведение звонка и своих встреч. Всё новое включается только при `isForeign` — то есть когда в метаданных пришёл `externalChatUrl`.

## Где запускать

По решению владельца (CLAUDE.md, «Сборки и тесты — на тестовой ноде») jest и сборки идут на `dv@85.192.61.231` в CI-клоне, а не на маке. Клоны на месте: `~/ci/spirits_back` и `~/ci/spirits_back/voice-host/node_modules` существуют (проверено 07.09.2026).

Шаблон прогона — сначала запушить ветку, потом встать в клоне на конкретный sha:

```bash
git push -u origin feat/talerid-room-chat
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q <sha> && source ~/.nvm/nvm.sh && npx jest src/meeting/talerid-room.client.spec.ts'
```

`source ~/.nvm/nvm.sh` обязателен в каждой ssh-команде — без nvm на ноде нет node.

Полный `npm test` в spirits_back красный и без наших правок (jest скребёт `.worktrees/`, два теста падают на main). Мерить свою работу дельтой: гонять только те файлы, что перечислены в задачах.

Ветка: создать от `main` в `~/Downloads/spirits_back`.

---

### Task 1: `chatUrl` в клиенте комнат Taler ID

Бэкенду самому в чат писать не придётся — но URL ручки собирается из `TALERID_BASE_URL`, а воркер этой переменной не знает и знать не должен: на стенде база другая (`staging.id.taler.tirol`), и дублировать её вывод в воркере значит однажды написать в прод со стенда.

**Files:**
- Modify: `src/meeting/talerid-room.client.ts:104` (после метода `info`, перед `join`)
- Test: `src/meeting/talerid-room.client.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Добавить в `src/meeting/talerid-room.client.spec.ts` перед закрывающей скобкой `describe('TalerIdRoomClient', …)`:

```ts
  describe('chatUrl', () => {
    it('собирает путь чата из базы и roomName', () => {
      // Путь берёт roomName, а не код комнаты, и живёт БЕЗ префикса /api —
      // проверено живьём 07.09.2026, оба варианта отвечают 201.
      expect(new TalerIdRoomClient().chatUrl('personal-c79530ed-36fc367a')).toBe(
        'https://api.talerid.io/voice/rooms/personal-c79530ed-36fc367a/chat',
      );
    });

    it('слушается TALERID_BASE_URL — иначе стенд писал бы в прод', () => {
      process.env.TALERID_BASE_URL = 'https://staging.id.taler.tirol/';
      expect(new TalerIdRoomClient().chatUrl('room-1')).toBe(
        'https://staging.id.taler.tirol/voice/rooms/room-1/chat',
      );
    });

    it('экранирует имя комнаты', () => {
      expect(new TalerIdRoomClient().chatUrl('a b/c')).toBe(
        'https://api.talerid.io/voice/rooms/a%20b%2Fc/chat',
      );
    });
  });
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
git add -A && git commit -m "test(meeting): chatUrl комнаты Taler ID" && git push
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $(git rev-parse origin/feat/talerid-room-chat) && source ~/.nvm/nvm.sh && npx jest src/meeting/talerid-room.client.spec.ts'
```

Ожидание: FAIL, `chatUrl is not a function`.

- [ ] **Step 3: Реализовать**

В `src/meeting/talerid-room.client.ts` после метода `info()` вставить:

```ts
  /**
   * Куда писать в чат комнаты.
   *
   * Ручка берёт roomName, а НЕ код из ссылки: `/voice/rooms/{roomName}/chat`.
   * Префикс `/api` тут необязателен (проверены оба варианта, 07.09.2026), но
   * база обязана приезжать из окружения — иначе стенд напишет в прод.
   *
   * Сам метод только собирает адрес: писать будет воркер, у которого есть
   * participant-токен и подключение к комнате. Хранить токен на бэкенде ради
   * этого не нужно.
   */
  chatUrl(roomName: string): string {
    return `${this.base()}/voice/rooms/${encodeURIComponent(roomName)}/chat`;
  }
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
git add -A && git commit -m "feat(meeting): chatUrl комнаты Taler ID" && git push
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $(git rev-parse origin/feat/talerid-room-chat) && source ~/.nvm/nvm.sh && npx jest src/meeting/talerid-room.client.spec.ts'
```

Ожидание: PASS, все тесты файла зелёные.

---

### Task 2: URL чата — в метаданные job

**Files:**
- Modify: `src/meeting/meeting.service.ts:127` (тип `external`), `:164-166` (заполнение), `:185` (метаданные dispatch)
- Test: `src/meeting/meeting.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

В `src/meeting/meeting.service.spec.ts` рядом с существующей проверкой метаданных чужой комнаты (там, где сейчас сверяются `externalUrl` и `externalToken`, ~строка 198) добавить:

```ts
    it('кладёт в метаданные адрес чата чужой комнаты', async () => {
      await service.join('u1', 1, '36fc367a', 'talerid');
      const meta = livekit.dispatchAgent.mock.calls[0][1] as any;
      expect(meta.externalChatUrl).toBe(
        'https://api.talerid.io/voice/rooms/personal-c79530ed-36fc367a/chat',
      );
    });

    it('без roomName адрес чата не кладёт — писать всё равно некуда', async () => {
      // join у них всегда отдаёт roomName, но клиент подставляет '' при его
      // отсутствии. Полусобранный URL хуже отсутствующего: воркер решил бы,
      // что чат есть, и молча ронял бы каждую отправку в 404.
      talerIdRooms.join.mockResolvedValue({
        token: 'jwt.body.sig',
        roomName: '',
        url: 'wss://api.talerid.io/livekit/',
      });
      await service.join('u1', 1, '36fc367a', 'talerid');
      const meta = livekit.dispatchAgent.mock.calls[0][1] as any;
      expect(meta.externalChatUrl).toBeUndefined();
    });

    it('на своей встрече адреса чата нет', async () => {
      await service.join('u1', 1, 'ABC234');
      const meta = livekit.dispatchAgent.mock.calls[0][1] as any;
      expect(meta.externalChatUrl).toBeUndefined();
    });
```

Мок `talerIdRooms` в этом файле уже есть, но `chatUrl` в нём не замокан. Дописать его туда, где создаются моки (рядом с `livekit = { … }`, ~строка 51):

```ts
    talerIdRooms = {
      info: jest.fn(),
      join: jest.fn(),
      chatUrl: jest.fn((r: string) => `https://api.talerid.io/voice/rooms/${r}/chat`),
    };
```

Остальные поля мока (то, что уже возвращают `info` и `join` в существующих тестах) оставить как есть.

- [ ] **Step 2: Убедиться, что тест падает**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $(git rev-parse origin/feat/talerid-room-chat) && source ~/.nvm/nvm.sh && npx jest src/meeting/meeting.service.spec.ts'
```

Ожидание: FAIL — `expect(received).toBe(expected)`, получено `undefined`.

- [ ] **Step 3: Реализовать**

В `src/meeting/meeting.service.ts` расширить объявление `external` (строка 127):

```ts
    let external: { url: string; token: string; chatUrl?: string } | undefined;
```

Заполнение (после `if (!t) throw new NotFoundException('room not found');`):

```ts
        external = {
          url: t.url,
          token: t.token,
          // Пустой roomName — это не «чат без имени», а сломанный URL. Лучше
          // не давать воркеру канал вовсе, чем дать такой, который молча
          // отвечает 404 на каждую отправку.
          ...(t.roomName ? { chatUrl: this.talerIdRooms.chatUrl(t.roomName) } : {}),
        };
```

В метаданных dispatch (строка ~185) дописать поле:

```ts
        ...(external
          ? {
              provider: PROVIDER_TALERID,
              externalUrl: external.url,
              externalToken: external.token,
              // Чат комнаты. Пишет и читает воркер: чтения по REST у них нет
              // вовсе, входящие приезжают data-пакетом в ту же комнату.
              ...(external.chatUrl ? { externalChatUrl: external.chatUrl } : {}),
            }
          : {}),
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $(git rev-parse origin/feat/talerid-room-chat) && source ~/.nvm/nvm.sh && npx jest src/meeting/meeting.service.spec.ts src/meeting/talerid-room.client.spec.ts'
```

Ожидание: PASS в обоих файлах.

- [ ] **Step 5: Коммит**

```bash
git add src/meeting/meeting.service.ts src/meeting/meeting.service.spec.ts
git commit -m "feat(meeting): адрес чата чужой комнаты в метаданных job"
git push
```

---

### Task 3: модуль `ExternalRoomChat` в воркере

Единственное место, где живёт знание об их чате: как послать, как разобрать входящее, как не услышать себя.

**Files:**
- Create: `voice-host/src/external-chat.ts`
- Create: `voice-host/src/external-chat.test.ts`
- Modify: `voice-host/package.json` (скрипт `test`)

- [ ] **Step 1: Написать падающий тест**

Создать `voice-host/src/external-chat.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalRoomChat } from './external-chat.js';

const URL = 'https://api.talerid.io/voice/rooms/personal-c79530ed-36fc367a/chat';
const NAME = 'Роман · ассистент Дмитрий';

/** Ответ их ручки, снятый живьём 07.09.2026. */
const created = () => ({ ok: true, status: 201, json: async () => ({ ts: 1788768370404 }) });

const pack = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Настоящий пакет из их комнаты, снятый живьём 07.09.2026. */
const incoming = (over: Record<string, unknown> = {}) =>
  pack({
    type: 'chat_message',
    text: 'Вот документ: https://linkeon.io/doc/42',
    name: 'Дмитрий Волков',
    ts: 1788768440123,
    msgId: 'server_f46cf041-b5da-4bb3-918a-af832a2d4255',
    ...over,
  });

describe('send', () => {
  test('шлёт текст с Bearer и своим именем', async () => {
    const calls: any[] = [];
    const chat = new ExternalRoomChat(URL, 'jwt.body.sig', NAME, async (u: any, i: any) => {
      calls.push([String(u), i]);
      return created() as any;
    });

    assert.equal(await chat.send('Документ готов'), true);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer jwt.body.sig');
    assert.deepEqual(JSON.parse(init.body), { text: 'Документ готов', name: NAME });
  });

  test('пустой текст никуда не шлёт', async () => {
    let called = 0;
    const chat = new ExternalRoomChat(URL, 't', NAME, async () => { called++; return created() as any; });
    assert.equal(await chat.send('   '), false);
    assert.equal(called, 0);
  });

  test('403 не исключение, а false', async () => {
    // Их ручка отвечает 403 «No access to this room» на чужую комнату и 401
    // без токена. Тул модели должен получить внятный отказ, а не падение.
    const chat = new ExternalRoomChat(URL, 't', NAME, async () =>
      ({ ok: false, status: 403, text: async () => 'No access to this room' }) as any);
    assert.equal(await chat.send('привет'), false);
  });

  test('упавшая сеть тоже false', async () => {
    const chat = new ExternalRoomChat(URL, 't', NAME, async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(await chat.send('привет'), false);
  });
});

describe('parse', () => {
  const chat = () => new ExternalRoomChat(URL, 't', NAME, async () => created() as any);

  test('разбирает настоящий пакет их комнаты', () => {
    assert.deepEqual(chat().parse(incoming()), {
      text: 'Вот документ: https://linkeon.io/doc/42',
      name: 'Дмитрий Волков',
      ts: 1788768440123,
    });
  });

  test('своё эхо отбрасывает по имени', () => {
    // Отбрасывать по ts из ответа POST нельзя: эхо приходит РАНЬШЕ, чем
    // резолвится промис отправки (снято живьём 07.09.2026). К этому моменту
    // никакого ts у нас ещё нет, зато имя своё.
    assert.equal(chat().parse(incoming({ name: NAME })), null);
  });

  test('имя сравнивается без учёта регистра и лишних пробелов', () => {
    assert.equal(chat().parse(incoming({ name: `  ${NAME.toUpperCase()} ` })), null);
  });

  test('чужой тип пакета — не чат', () => {
    assert.equal(chat().parse(pack({ type: 'reaction', name: 'Дмитрий' })), null);
  });

  test('битый JSON не роняет', () => {
    assert.equal(chat().parse(new TextEncoder().encode('{не json')), null);
  });

  test('пустой текст игнорируем', () => {
    assert.equal(chat().parse(incoming({ text: '   ' })), null);
  });

  test('без имени отправитель называется участником', () => {
    assert.equal(chat().parse(incoming({ name: '' }))?.name, 'участник');
  });
});
```

- [ ] **Step 2: Зарегистрировать тест-файл**

В `voice-host/package.json` дописать файл в скрипт `test` (он перечисляет файлы поимённо — новый сам не подхватится):

```json
    "test": "tsx --test src/pending.test.ts src/name-gate.test.ts src/occupancy.test.ts src/mixer.test.ts src/prompts.test.ts src/speaker-ledger.test.ts src/external-chat.test.ts"
```

- [ ] **Step 3: Убедиться, что тест падает**

```bash
git add -A && git commit -m "test(voice-host): чат чужой комнаты" && git push
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $(git rev-parse origin/feat/talerid-room-chat) && cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm install && npm test'
```

Ожидание: FAIL — `Cannot find module './external-chat.js'`.

- [ ] **Step 4: Реализовать**

Создать `voice-host/src/external-chat.ts`:

```ts
/**
 * Текстовый чат чужой комнаты Taler ID.
 *
 * Канал устроен несимметрично, и это не наш выбор: писать надо их REST-ручкой
 * `POST {base}/voice/rooms/{roomName}/chat`, а читать — из самой LiveKit-комнаты,
 * куда их сервер публикует каждое сообщение data-пакетом. GET-ручки чата у них
 * нет вовсе (`/chat` и `/messages` отвечают 404 «Cannot GET», проверено
 * 07.09.2026), поллить нечего и не надо.
 *
 * Модуль намеренно не знает ни про LiveKit, ни про сессию: на вход — байты
 * пакета, на выход — разобранное сообщение. Так его можно проверить без комнаты.
 */

/** Ручка чата отвечает мгновенно; висеть на ней дольше секунды нечего. */
const TIMEOUT_MS = 4_000;

export interface IncomingChat {
  text: string;
  /** Как отправитель подписан у них в комнате. */
  name: string;
  ts: number;
}

export class ExternalRoomChat {
  constructor(
    private readonly url: string,
    private readonly token: string,
    /** Наше имя в комнате — им же отсеиваем собственное эхо. */
    private readonly displayName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Написать в чат. `false` — не ушло; исключений наружу не бывает. */
  async send(text: string): Promise<boolean> {
    const body = (text || '').trim();
    if (!body) return false;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: body, name: this.displayName }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // 401 «No token» и 403 «No access to this room» — их штатные отказы.
        // Модель получит status: rejected и скажет об этом словами; падение
        // тула вместо этого заставило бы её замолчать.
        console.error(`[чат] отправка отбита: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e: any) {
      console.error(`[чат] отправка не ушла: ${e?.message}`);
      return false;
    }
  }

  /**
   * Разобрать data-пакет комнаты. `null` — это не чат либо это мы сами.
   *
   * Собственное эхо отбрасываем ПО ИМЕНИ, а не по `ts` из ответа на отправку:
   * пакет с эхом приходит раньше, чем резолвится промис `fetch` (снято живьём
   * 07.09.2026 — строка `DATA …` встала в логе выше строки `POST → 201`).
   * К моменту прихода эха никакого `ts` у нас ещё нет, а имя — есть, и сервер
   * возвращает его ровно таким, каким мы его послали.
   */
  parse(payload: Uint8Array): IncomingChat | null {
    let msg: any;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
    if (msg?.type !== 'chat_message') return null;

    const name = String(msg.name ?? '').trim();
    if (this.isSelf(name)) return null;

    const text = String(msg.text ?? '').trim();
    if (!text) return null;

    return { text, name: name || 'участник', ts: Number(msg.ts) || 0 };
  }

  private isSelf(name: string): boolean {
    return name.toLowerCase() === this.displayName.trim().toLowerCase();
  }
}
```

- [ ] **Step 5: Убедиться, что тест проходит**

Двумя ssh-командами, а не одной склейкой: рабочий каталог переносится между звеньями `&&`, и вторая половина молча отработает не в том репозитории — на этом уже теряли push.

```bash
git add -A && git commit -m "feat(voice-host): модуль чата чужой комнаты" && git push
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q origin/feat/talerid-room-chat'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
```

Ожидание: PASS, 12 тестов в `external-chat.test.ts`, остальные файлы по-прежнему зелёные.

---

### Task 4: тул `write_to_chat`

**Files:**
- Modify: `voice-host/src/agent.ts:26-34` (импорт), `:128-135` (создание канала), `:312-370` (тулы)
- Modify: `voice-host/src/prompts.ts:139-149` (блок про документ в `meetingInstructions`)
- Test: `voice-host/src/prompts.test.ts`

- [ ] **Step 1: Написать падающий тест на промпт**

Инструмент, о котором не сказано в промпте, модель не вызовет ни разу — проверяем именно строку промпта. В `voice-host/src/prompts.test.ts` добавить:

```ts
describe('чат встречи', () => {
  test('на встрече промпт объясняет, что в чат можно писать', () => {
    const s = flat(meetingInstructions({
      name: 'Роман', persona: '', preamble: '', specialists: SPECIALISTS,
    }));
    assert.match(s, /write_to_chat/);
    assert.match(s, /ссылк/i);
    // Пересказ вслух того, что уже написано текстом, — главный способ
    // испортить встречу: участники слышат зачитанный URL посимвольно.
    assert.match(s, /не дублируй|не зачитывай/i);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
```

Ожидание: FAIL — `The input did not match the regular expression /write_to_chat/`.

- [ ] **Step 3: Дописать промпт**

В `voice-host/src/prompts.ts`, в `meetingInstructions`, сразу после блока про `create_document` (перед строкой с `ctx.preamble`) вставить:

```ts
    '',
    'У встречи есть текстовый чат, его видят все участники. Инструмент',
    'write_to_chat кладёт туда сообщение. Пиши в чат то, что на слух не',
    'воспринимается: ссылки, адреса, номера, короткие списки. Голосом при этом',
    'скажи одной фразой, что написал в чат, и НЕ зачитывай написанное вслух —',
    'не дублируй в речи то, что уже отправил текстом.',
    'Чат — не замена разговора: обычные ответы произноси голосом.',
```

- [ ] **Step 4: Убедиться, что тест на промпт проходит**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
```

Ожидание: PASS.

- [ ] **Step 5: Завести канал в агенте**

В `voice-host/src/agent.ts` в импорты добавить:

```ts
import { ExternalRoomChat } from './external-chat.js';
```

В тип `meta` (после `externalToken?: string;`) добавить поле:

```ts
      /**
       * Ручка чата чужой комнаты. Приходит только для talerid и только когда
       * их join отдал roomName — собирает её бэкенд, потому что база живёт в
       * его окружении (на стенде она другая).
       */
      externalChatUrl?: string;
```

Сразу после блока подключения к чужой комнате (после `console.log(\`[чужая] подключились к ${meta.externalUrl}\`);`, внутри того же `if (isForeign)`) добавить:

```ts
      if (meta.externalChatUrl) {
        chat = new ExternalRoomChat(
          meta.externalChatUrl,
          meta.externalToken!,
          // Имя ровно то же, под которым мы вошли в комнату: по нему же
          // отсеивается собственное эхо.
          `${agentName} · ассистент ${meta.ownerName || 'пользователя'}`,
        );
        console.log('[чат] канал комнаты подключён');
      }
```

Объявление рядом с `foreign`/`foreignOutput` (строки 126-127):

```ts
    let chat: ExternalRoomChat | null = null;
```

- [ ] **Step 6: Добавить тул**

В объекте `tools` (после `create_document`) добавить:

```ts
      // Тул появляется только на чужой встрече с чатом. У звонка и своих
      // комнат канала нет, и объявлять модели инструмент, который всегда
      // отказывает, — прямой способ получить «я отправил в чат» в пустоту.
      ...(chat
        ? {
            write_to_chat: llm.tool({
              description:
                'Написать текстом в чат встречи — сообщение увидят все участники. ' +
                'Для того, что на слух не воспринимается: ссылки, адреса, номера, ' +
                'короткие списки. Голосом скажи, что написал в чат, и не зачитывай ' +
                'написанное вслух.',
              parameters: z.object({
                text: z.string().describe('Текст сообщения целиком, готовый к отправке'),
              }),
              execute: async ({ text }) => {
                const ok = await chat!.send(text);
                return ok ? { status: 'sent' } : { status: 'rejected', reason: 'chat_unavailable' };
              },
            }),
          }
        : {}),
```

- [ ] **Step 7: Проверить сборку воркера**

```bash
git add -A && git commit -m "feat(voice-host): тул write_to_chat" && git push
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q origin/feat/talerid-room-chat'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm run build && npm test'
```

Ожидание: `tsc` без ошибок, тесты зелёные.

---

### Task 5: ссылка на готовый документ — в чат комнаты

Документ дописывается на бэкенде, и о готовности воркер узнаёт data-пакетом `document_ready` в НАШЕЙ комнате — вместе с полем `url`, которое сейчас не используется вовсе. Хранить participant-токен на бэкенде ради этого не нужно: ссылку отправит воркер, который уже держит канал.

**Files:**
- Modify: `voice-host/src/agent.ts:387-407` (обработчик `document_ready`)

- [ ] **Step 1: Отправлять ссылку**

В обработчике `ctx.room.on(RoomEvent.DataReceived, …)`, в ветке `msg.type === 'document_ready'`, перед `return;` добавить:

```ts
        // Ссылка — участникам встречи, а не только владельцу.
        //
        // Документ ложится в личный чат владельца в Linkeon, и остальным в
        // комнате он не виден: у них аккаунта у нас нет. Пересказ вслух эту
        // дыру не закрывает — по надиктованному URL не перейти.
        if (chat && msg.url) {
          void chat.send(`Документ «${msg.title}»: ${msg.url}`);
        }
```

Ветку `document_failed` не трогаем: об этом Роман скажет голосом, ссылки нет.

- [ ] **Step 2: Проверить сборку**

```bash
git add -A && git commit -m "feat(voice-host): ссылка на документ в чат комнаты" && git push
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q origin/feat/talerid-room-chat'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm run build && npm test'
```

Ожидание: сборка чистая, тесты зелёные.

---

### Task 6: чтение чата комнаты

**Files:**
- Modify: `voice-host/src/prompts.ts` (новая функция `answerToChat` рядом с `answerTo`, строка ~202)
- Modify: `voice-host/src/agent.ts` (обработчик входящих чата — после блока разметки говорящего, ~строка 527)
- Test: `voice-host/src/prompts.test.ts`

- [ ] **Step 1: Написать падающий тест на `answerToChat`**

В `voice-host/src/prompts.test.ts` (импорт дополнить: `import { answerTo, answerToChat, callInstructions, meetingInstructions } from './prompts.js';`) добавить:

```ts
describe('answerToChat', () => {
  test('называет автора и приводит текст', () => {
    const s = flat(answerToChat('Дмитрий Волков', 'скинь ссылку на смету'));
    assert.match(s, /Дмитрий Волков/);
    assert.match(s, /скинь ссылку на смету/);
  });

  test('велит отвечать голосом, а ссылки класть в чат', () => {
    const s = flat(answerToChat('Дмитрий', 'дай ссылку'));
    assert.match(s, /вслух|голос/i);
    assert.match(s, /write_to_chat/);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
```

Ожидание: FAIL — `answerToChat is not a function`.

- [ ] **Step 3: Реализовать `answerToChat`**

В `voice-host/src/prompts.ts` после `answerTo` добавить:

```ts
/**
 * Обращение пришло текстом, а не голосом.
 *
 * Отдельно от answerTo по двум причинам. Автор письменного сообщения известен
 * точно (его присылает их сервер), а у речи он угадан по активному
 * говорящему — этим стоит воспользоваться. И ответ на письменную просьбу
 * часто сам просится текстом: ссылку, продиктованную вслух, никто не наберёт.
 */
export function answerToChat(who: string, text: string): string {
  return (
    `${who} написал в чат встречи: «${text}». Ответь ПО-РУССКИ вслух, коротко, ` +
    'обращаясь к нему. Если ответ — ссылка, адрес, номер или список, отправь ' +
    'его инструментом write_to_chat, а голосом скажи одной фразой, что написал ' +
    'в чат. Остальное, что звучало без обращения к тебе, — фон встречи: не ' +
    'отвечай на это.'
  );
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm test'
```

Ожидание: PASS.

- [ ] **Step 5: Слушать чат в агенте**

В `voice-host/src/agent.ts` дополнить импорт промптов: `answerToChat` в список из `./prompts.js`.

После блока разметки говорящего (`if (isMeeting) { … ActiveSpeakersChanged … }`, заканчивается на строке ~527) добавить:

```ts
    /**
     * Написанное в чате комнаты — такое же обращение, как сказанное вслух.
     *
     * Проходит через тот же гейт по имени: комната общая, участники пишут и
     * друг другу тоже, и отвечать на каждое сообщение ассистент не должен.
     * Своё эхо отсеивает ExternalRoomChat.parse — их сервер возвращает нам
     * наши же отправки тем же пакетом.
     */
    if (foreign && chat) {
      foreign.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        const msg = chat!.parse(payload);
        if (!msg) return;
        console.log(`[чат] ${msg.name}: ${msg.text.slice(0, 80)}`);

        // В транскрипт — с автором. Здесь он точный, в отличие от речи, где
        // говорящий угадан по активности микрофона.
        transcript.push({ role: 'user', text: msg.text, ts: Date.now(), speaker: msg.name });

        const decision = gate ? gate.decide(msg.text, Date.now(), msg.name) : 'respond';
        console.log(`[гейт/чат] ${decision} ← «${msg.text.slice(0, 80)}»`);
        switch (decision) {
          case 'respond':
            replyOrDefer(answerToChat(msg.name, msg.text));
            break;
          case 'ack_listen':
            replyOrDefer(listenAck());
            break;
          case 'ack_resume':
            replyOrDefer(resumeAck());
            break;
          case 'silent':
            break;
        }
      });
    }
```

- [ ] **Step 6: Проверить сборку и тесты**

```bash
git add -A && git commit -m "feat(voice-host): ассистент читает чат комнаты" && git push
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q origin/feat/talerid-room-chat'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm run build && npm test'
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/meeting/'
```

Ожидание: сборка чистая, тесты воркера зелёные, тесты `src/meeting/` зелёные.

---

### Task 7: проверка на живой комнате

Зелёные юнит-тесты здесь не доказывают ничего: и гейт, и эхо, и права токена проверяются только настоящей встречей. Комната для проверки — личная комната владельца `36fc367a` (в ней уже лежат тестовые сообщения от 07.09.2026).

**Files:** правок нет — только прогон.

- [ ] **Step 1: Выкатить на тест**

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Запускать отвязанно (конвейер копит вывод и идёт дольше лимита инструмента), без `| tail`. Прод не трогать до ручной проверки: если нужен только тестовый стенд — `TEST_ONLY=1`.

- [ ] **Step 2: Проверить письменный канал**

Открыть комнату `https://api.talerid.io/room/36fc367a`, позвать в неё ассистента из Linkeon и проверить по очереди:

1. Написать в чат комнаты «Роман, напиши в чат ссылку на наш сайт» → в чате появляется сообщение от `Роман · ассистент …`, голосом Роман говорит, что написал, и НЕ зачитывает URL.
2. Написать в чат что-то без имени («ок, договорились») → Роман молчит (гейт), в логе `[гейт/чат] silent`.
3. Голосом попросить документ → после готовности в чат комнаты приходит `Документ «…»: https://…`, ссылка открывается в браузере.
4. Убедиться, что Роман не отвечает на собственные сообщения в чате (эхо отсеяно) — в логе не должно быть `[чат] Роман · ассистент …`.

- [ ] **Step 3: Снять лог**

```bash
ssh dvolkov@212.113.106.202 'pm2 logs linkeon-voice-host --lines 200 --nostream' | grep -E '\[чат|\[гейт/чат'
```

Ожидание: строки `[чат] канал комнаты подключён`, входящие сообщения участников, решения гейта. Ни одной строки с нашим собственным именем во входящих.

- [ ] **Step 4: Финальный коммит и слияние в main**

```bash
git checkout main && git merge --no-ff feat/talerid-room-chat && git push origin main
```
