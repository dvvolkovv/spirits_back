# Микрофон Романа в режиме слушателя — Телемост

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Когда ассистента просят помолчать, бот выключает микрофон на площадке — участники видят это значком, а не догадываются по тишине.

**Architecture:** Воркер уже знает момент смены режима — `noteListening()` в `agent.ts`. Оттуда уходит новый триггер `bot_mute` в тот же вебсокет, которым идёт голос. Бот принимает его и нажимает настоящую кнопку микрофона на странице встречи. Свой аудиограф не трогаем: площадка его не видит, а значок нужен именно площадочный.

**Tech Stack:** TypeScript (воркер `voice-host`), JavaScript ESM + Playwright (бот `infra/meeting-bot`), `node:test` в обоих.

**Основа:** [2026-10-12-roman-meeting-presence-design.md](../specs/2026-10-12-roman-meeting-presence-design.md), пункт 4.

**Область:** ТОЛЬКО Телемост. Zoom идёт следующим планом и переиспользует задачи 1–3 целиком — там меняется лишь сценарий страницы. Свои комнаты и Taler ID — отдельный путь (серверный API LiveKit и снятие дорожки), к этому плану отношения не имеют. Meet и Teams невозможны: у Attendee такой ручки нет.

---

## Главная неизвестность и как мы с ней обходимся

Кнопки микрофона в разметке Телемоста **никто не видел**. В `TELEMOST_JOIN` есть `cameraOff: '[role="button"][aria-label*="камер" i]'` — микрофонную зацепку пишем по тому же образцу, но это догадка.

Поэтому вторым слоем идёт проба разметки — тот же приём, которым в боте уже разбирали ленту чата (`chat_probe`, `window.__botChatSample`): если кнопка не нашлась, страница отдаёт кусок панели управления в лог. Одна живая встреча тогда либо подтверждает догадку, либо даёт точную разметку для второй редакции. Гадать дважды не придётся.

## Ограничение сценариев страниц

Сценарии собираются шаблонными строками и уезжают в браузер текстом. **Обратных кавычек внутри быть не может** — ни в коде, ни в комментариях: литерал закроется раньше времени, и браузер не выполнит сценарий ВООБЩЕ. Это ловилось дважды (22.09.2026 и 28.09.2026, второй раз на живой встрече) и закреплено тестом `payloads.test.mjs`. Там же проверяется, что сценарий разбирается как код.

## Файлы

| Файл | Что с ним |
|---|---|
| `voice-host/src/attendee-audio.ts` | Форма команды: `BotMute`, `muteCommand()` |
| `voice-host/src/attendee-audio.test.ts` | Тесты формы |
| `voice-host/src/agent.ts` | Отправка из `noteListening()` |
| `infra/meeting-bot/src/bot.mjs` | Маршрутизация сообщений воркера, `setMicMuted()` |
| `infra/meeting-bot/src/payload/telemost.mjs` | `__botSetMicMuted`, `__botMicSample` |
| `infra/meeting-bot/test/mic.test.mjs` | Новый файл: обработка команды ботом |

---

### Task 0: Ветка

- [ ] **Step 1: Создать ветку от актуального main**

```bash
cd spirits_back
git checkout main
git pull --ff-only
git checkout -b feat/roman-mic-mute
```

- [ ] **Step 2: Убедиться, что оба набора тестов зелёные до правок**

Run: `cd voice-host && npm test`
Expected: `# fail 0`.

Run: `cd ../infra/meeting-bot && npm test`
Expected: `# fail 0`.

Если что-то красное до начала — остановиться и разобраться, а не чинить попутно.

---

### Task 1: Форма команды

**Files:**
- Modify: `voice-host/src/attendee-audio.ts`
- Test: `voice-host/src/attendee-audio.test.ts`

Команда живёт рядом с описанием протокола, а не в `agent.ts`: вебсокет к боту — это протокол, и обе его стороны описаны здесь.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `voice-host/src/attendee-audio.test.ts`:

```typescript
/**
 * Команда микрофона.
 *
 * Триггер НЕ из контракта Attendee — он там и не нужен: по исходникам
 * (спайк 09.09.2026) Attendee принимает ровно realtime_audio.bot_output, а
 * всё прочее пишет в лог как неизвестное сообщение. То есть на площадках,
 * которые ходят через него, команда безвредно потеряется, а свой бот её
 * поймёт. Расхождение с контрактом одностороннее и сознательное.
 */
describe('команда микрофона', () => {
  test('уход в режим слушателя — микрофон выключить', () => {
    assert.deepEqual(muteCommand(true), { trigger: 'bot_mute', data: { on: true } });
  });

  test('возврат в разговор — включить', () => {
    assert.deepEqual(muteCommand(false), { trigger: 'bot_mute', data: { on: false } });
  });

  test('не путается с голосом ассистента', () => {
    // Оба сообщения идут одним сокетом, и бот различает их только триггером.
    assert.notEqual(muteCommand(true).trigger, 'realtime_audio.bot_output');
  });
});
```

Импорт `muteCommand` добавить к существующему импорту из `./attendee-audio.js` в начале файла.

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd voice-host && npx tsx --test src/attendee-audio.test.ts`
Expected: FAIL — `muteCommand is not a function` или ошибка импорта.

Реально запусти и посмотри вывод.

- [ ] **Step 3: Добавить команду**

В `voice-host/src/attendee-audio.ts`, рядом с интерфейсом `InboundAudio` (около строки 48):

```typescript
/**
 * Команда боту: выключить или включить микрофон на площадке.
 *
 * Выключается НАСТОЯЩАЯ кнопка встречи, а не наш аудиограф. Граф участники не
 * видят вовсе — бот отдаёт площадке подменённую дорожку, и для неё микрофон
 * включён всегда. А нужен именно привычный значок у бота в списке: на слух
 * «молчит» и «завис» неразличимы, и на живых встречах это уже принимали за
 * сбой.
 *
 * Триггера bot_mute в контракте Attendee нет, и это осознанно: он принимает
 * ровно realtime_audio.bot_output, остальное пишет в лог как неизвестное
 * (прочитано по исходникам 09.09.2026). Значит на Meet и Teams команда просто
 * потеряется — там индикации не будет, это принятая цена.
 */
export interface BotMute {
  trigger: 'bot_mute';
  data: { on: boolean };
}

/** @param on выключить ли микрофон. true — ассистент ушёл в режим слушателя. */
export function muteCommand(on: boolean): BotMute {
  return { trigger: 'bot_mute', data: { on } };
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd voice-host && npx tsx --test src/attendee-audio.test.ts`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
cd spirits_back
git add voice-host/src/attendee-audio.ts voice-host/src/attendee-audio.test.ts
git commit -m "feat(voice-host): команда bot_mute в протоколе моста"
```

---

### Task 2: Отправка на смену режима

**Files:**
- Modify: `voice-host/src/agent.ts`

- [ ] **Step 1: Добавить импорт**

В `src/agent.ts` найди импорт из `./attendee-audio.js` и добавь `muteCommand` к тому, что уже импортируется оттуда.

- [ ] **Step 2: Отправлять команду из `noteListening()`**

Функция `noteListening()` в `src/agent.ts` (около строки 215) сейчас только пишет в лог. Станет:

```typescript
    let wasListening = false;
    function noteListening(): void {
      if (!gate || gate.listening === wasListening) return;
      wasListening = gate.listening;
      console.log(
        wasListening
          ? '[гейт] режим слушателя включён'
          : '[гейт] режим слушателя снят — отвечаю, когда зовут по имени',
      );
      // Микрофон бота — следом за режимом, и только на мосту. Своя комната и
      // чужая комната Taler ID идут другим путём (см. спеку, пункт 4): там
      // вебсокета к боту нет вовсе.
      if (isBridged) attendeeHub?.send(muteCommand(wasListening));
    }
```

ВАЖНО, не «чини» это: `attendeeHub` объявлен НИЖЕ по файлу (около строки 448, через `let`), а `noteListening` — выше. Это рабочий случай, а не ошибка. Объявление функции поднимается, а вызывается она только из обработчика транскрипта, который навешивается много позже строки 448 — к этому моменту `attendeeHub` уже инициализирован. Переносить объявления местами не надо.

`isBridged` объявлен около строки 175, то есть выше `noteListening`.

- [ ] **Step 3: Собрать проект**

Run: `cd voice-host && npm run build`
Expected: сборка проходит без ошибок.

- [ ] **Step 4: Прогнать тесты воркера**

Run: `cd voice-host && npm test`
Expected: `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
cd spirits_back
git add voice-host/src/agent.ts
git commit -m "feat(voice-host): режим слушателя гасит микрофон бота"
```

---

### Task 3: Бот принимает команду

**Files:**
- Modify: `infra/meeting-bot/src/bot.mjs`
- Test: `infra/meeting-bot/test/mic.test.mjs` (создать)

Сейчас `playFromWorker()` разбирает сообщение и сам же играет звук. Триггеров становится два, поэтому разбор отделяется от действия.

- [ ] **Step 1: Написать падающие тесты**

Создать `infra/meeting-bot/test/mic.test.mjs`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingBot } from '../src/bot.mjs';

/**
 * Команда микрофона от воркера.
 *
 * Бота заводим настоящего — конструктор ничего не запускает, — а наружу
 * подменяем ровно одно: кадр страницы. Так проверяется и разбор сообщения, и
 * поведение при ненайденной кнопке, которого в браузере по заказу не добиться.
 */
function botWith(results) {
  const warns = [];
  const infos = [];
  const bot = new MeetingBot({
    id: 'тест',
    meetingUrl: 'x',
    displayName: 'Бот',
    platform: 'telemost',
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
  });
  const args = [];
  bot.micFrame = async () => ({
    async evaluate(_fn, arg) {
      args.push(arg);
      return results.shift();
    },
  });
  return { bot, args, warns, infos };
}

const msg = (trigger, data) => Buffer.from(JSON.stringify({ trigger, data }));

describe('микрофон по команде воркера', () => {
  test('bot_mute с on:true выключает микрофон', async () => {
    const { bot, args, infos } = botWith([{ ok: true, how: 'кнопкой' }]);
    await bot.onWorkerMessage(msg('bot_mute', { on: true }));
    assert.deepEqual(args, [true]);
    assert.match(infos.join(' '), /микрофон выключен/);
  });

  test('bot_mute с on:false включает обратно', async () => {
    const { bot, args, infos } = botWith([{ ok: true, how: 'кнопкой' }]);
    await bot.onWorkerMessage(msg('bot_mute', { on: false }));
    assert.deepEqual(args, [false]);
    assert.match(infos.join(' '), /микрофон включён/);
  });

  test('кнопка не нашлась — разметка панели уезжает в лог', async () => {
    // Зацепка написана по догадке, живьём её никто не видел. Проба нужна,
    // чтобы вторая редакция писалась по факту, а не по второй догадке.
    const { bot, warns } = botWith([
      { ok: false, reason: 'кнопка микрофона не найдена' },
      '<div class="controls">кнопки</div>',
    ]);
    await bot.onWorkerMessage(msg('bot_mute', { on: true }));
    const log = warns.join(' ');
    assert.match(log, /кнопка микрофона не найдена/);
    assert.match(log, /class="controls"/);
  });

  test('голос ассистента по-прежнему играется', async () => {
    const { bot, args } = botWith([undefined]);
    await bot.onWorkerMessage(msg('realtime_audio.bot_output', { chunk: 'AAAA' }));
    assert.deepEqual(args, ['AAAA'], 'в страницу уходит сам кусок PCM');
  });

  test('мусор и чужие триггеры не роняют бота', async () => {
    const { bot, args } = botWith([]);
    await bot.onWorkerMessage(Buffer.from('не json'));
    await bot.onWorkerMessage(msg('bot.something_else', {}));
    assert.deepEqual(args, []);
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd infra/meeting-bot && node --test test/mic.test.mjs`
Expected: FAIL — `bot.onWorkerMessage is not a function`.

Реально запусти и посмотри вывод.

- [ ] **Step 3: Разделить разбор и действие**

В `infra/meeting-bot/src/bot.mjs` в `connectAudio()` заменить строку:

```javascript
    ws.on('message', (raw) => this.playFromWorker(raw));
```

на:

```javascript
    ws.on('message', (raw) => this.onWorkerMessage(raw));
```

Затем заменить метод `playFromWorker` целиком (вместе с его комментарием `/** Кусок голоса ассистента — в страницу. */`) на три метода:

```javascript
  /**
   * Сообщение от воркера.
   *
   * Триггеров два, и разбор у них общий. Чужие молча пропускаем: сокет тот же
   * самый, что и у голоса, и падать из-за незнакомого сообщения нельзя.
   */
  async onWorkerMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.trigger === 'realtime_audio.bot_output' && msg.data?.chunk) {
      return this.playChunk(msg.data.chunk);
    }
    if (msg.trigger === 'bot_mute') {
      return this.setMicMuted(!!msg.data?.on);
    }
  }

  /** Кусок голоса ассистента — в страницу. */
  async playChunk(chunk) {
    // Строку отдаём странице как есть: разбор PCM дешевле сделать там, чем
    // гнать через мост CDP массив чисел.
    try {
      const frame = await this.micFrame();
      await frame?.evaluate((c) => window.__botPlayPcm?.(c), chunk);
    } catch (e) {
      // Страница могла уйти — это не повод рушить встречу.
      this.log.warn?.(`[${this.id}] голос не доиграл: ${e?.message}`);
    }
  }

  /**
   * Микрофон бота на площадке — выключить или включить.
   *
   * Жмём настоящую кнопку встречи: наш аудиограф площадка не видит, а значок
   * нужен участникам. Кадр берём тот же, в котором живёт микрофон, — на новом
   * Телемосте встреча сидит в дочернем кадре, и панель управления там же.
   *
   * Не вышло — не беда: ассистент в режиме слушателя и так молчит, теряется
   * только индикация. Поэтому вместо ошибки пишем разметку панели в лог и
   * чиним зацепку по факту. Тот же приём, что и с лентой чата (chat_probe).
   */
  async setMicMuted(on) {
    try {
      const frame = await this.micFrame();
      const res = await frame?.evaluate((want) => window.__botSetMicMuted?.(want), on);
      if (res?.ok) {
        this.log.info?.(`[${this.id}] микрофон ${on ? 'выключен' : 'включён'} (${res.how})`);
        return;
      }
      this.log.warn?.(`[${this.id}] микрофон не переключился: ${res?.reason || 'сценарий не ответил'}`);
      const html = await frame?.evaluate(() => window.__botMicSample?.() || '').catch(() => '');
      if (html) this.log.warn?.(`[${this.id}] разметка панели: ${String(html).slice(0, 1200)}`);
    } catch (e) {
      this.log.warn?.(`[${this.id}] микрофон не переключился: ${e?.message}`);
    }
  }
```

- [ ] **Step 4: Запустить новые тесты**

Run: `cd infra/meeting-bot && node --test test/mic.test.mjs`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Прогнать весь набор бота**

Run: `cd infra/meeting-bot && npm test`
Expected: `# fail 0`. Проверь особенно `participants.test.mjs` — он тоже заводит настоящего `MeetingBot`.

- [ ] **Step 6: Коммит**

```bash
cd spirits_back
git add infra/meeting-bot/src/bot.mjs infra/meeting-bot/test/mic.test.mjs
git commit -m "feat(meeting-bot): команда bot_mute — жмём кнопку микрофона площадки"
```

---

### Task 4: Кнопка микрофона в Телемосте

**Files:**
- Modify: `infra/meeting-bot/src/payload/telemost.mjs`
- Test: `infra/meeting-bot/test/payloads.test.mjs` (добавить проверку)

НАПОМИНАНИЕ: внутри сценария НЕТ обратных кавычек. Строки склеивай через `+`.

- [ ] **Step 1: Написать падающий тест**

Добавить в конец `infra/meeting-bot/test/payloads.test.mjs`:

```javascript
/**
 * Микрофон площадки.
 *
 * Зацепка написана по образцу cameraOff — живьём разметку панели никто не
 * видел. Тест держит не саму зацепку, а наличие обеих ручек: без пробы
 * ненайденная кнопка молчит, и вторую редакцию пришлось бы писать по новой
 * догадке.
 */
describe('микрофон в сценарии Телемоста', () => {
  test('обе ручки объявлены', () => {
    assert.match(TELEMOST_PAYLOAD, /window\.__botSetMicMuted\s*=/);
    assert.match(TELEMOST_PAYLOAD, /window\.__botMicSample\s*=/);
  });

  test('ищется кнопка микрофона, а не камеры', () => {
    assert.match(TELEMOST_PAYLOAD, /aria-label\*=.микрофон/i);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd infra/meeting-bot && node --test test/payloads.test.mjs`
Expected: FAIL — `__botSetMicMuted` в сценарии не найден.

- [ ] **Step 3: Добавить ручки в сценарий**

В `infra/meeting-bot/src/payload/telemost.mjs`, в теле `TELEMOST_PAYLOAD`, прямо перед строкой `send('ready', { url: location.host + location.pathname });`:

```javascript
  // ── Микрофон площадки ────────────────────────────────────────────────────
  //
  // Жмём настоящую кнопку встречи, а не глушим свой аудиограф: граф площадка
  // не видит вовсе, а участникам нужен привычный значок.
  //
  // Зацепка — догадка по образцу cameraOff из TELEMOST_JOIN: панель
  // управления живьём никто не разбирал. Не сработает — __botMicSample отдаст
  // разметку в лог, и вторая редакция будет написана по факту.
  const MIC_BTN = '[role="button"][aria-label*="микрофон" i], button[aria-label*="микрофон" i]';

  window.__botSetMicMuted = (want) => {
    try {
      const btn = document.querySelector(MIC_BTN);
      if (!btn) return { ok: false, reason: 'кнопка микрофона не найдена' };
      // Подпись описывает ДЕЙСТВИЕ кнопки, а не состояние: «Выключить
      // микрофон» висит на включённом микрофоне. Поэтому «включить» без
      // «выключить» означает, что микрофон сейчас выключен.
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const muted = label.indexOf('включить') >= 0 && label.indexOf('выключить') < 0;
      if (muted === !!want) return { ok: true, how: 'уже в нужном состоянии' };
      btn.click();
      return { ok: true, how: 'кнопкой' };
    } catch (e) {
      return { ok: false, reason: String(e && e.message) };
    }
  };

  /** Кусок панели управления — для разбора зацепок по факту, а не по догадке. */
  window.__botMicSample = () => {
    try {
      const el = document.querySelector(
        '[class*="control"], [class*="toolbar"], [data-testid*="control"], [data-testid*="toolbar"]',
      ) || document.body;
      return el ? el.outerHTML.slice(0, 4000) : '';
    } catch (e) { return ''; }
  };

```

- [ ] **Step 4: Запустить тесты**

Run: `cd infra/meeting-bot && node --test test/payloads.test.mjs`
Expected: PASS, `# fail 0`.

Тесты «разбирается как код» и «не оборван на полуслове» из того же файла обязаны остаться зелёными — они и ловят обратную кавычку.

- [ ] **Step 5: Прогнать весь набор бота**

Run: `cd infra/meeting-bot && npm test`
Expected: `# fail 0`.

- [ ] **Step 6: Коммит**

```bash
cd spirits_back
git add infra/meeting-bot/src/payload/telemost.mjs infra/meeting-bot/test/payloads.test.mjs
git commit -m "feat(meeting-bot): кнопка микрофона Телемоста — зацепка и проба разметки"
```

---

### Task 5: Живая встреча

Ручная, выполняет владелец. Вёрстка площадки тестами не проверяется в принципе.

- [ ] **Step 1: Выкатить на тестовый стенд**

```bash
cd spirits_back
TEST_ONLY=1 BACK_ONLY=1 bash scripts/deploy.sh
```

Бот `meeting-bot` живёт отдельным сервисом — проверь, что выкат его тоже перезапустил, иначе страница поедет старая.

- [ ] **Step 2: Встреча в Телемосте вдвоём**

- сказать «Роман, пока слушай» — он подтверждает фразой, и **значок микрофона у него в списке участников гаснет**;
- сказать «Роман, вопрос к тебе» — он отвечает, значок загорается обратно;
- повторить второй раз: переключение должно работать не только единожды.

- [ ] **Step 3: Если значок не погас — забрать разметку из лога**

В логе бота ищи строки:

```
микрофон не переключился: кнопка микрофона не найдена
разметка панели: <...>
```

Эта разметка — готовый материал для второй редакции зацепки `MIC_BTN`. Правка будет в одну строку, и это ожидаемый исход, а не провал: мы ровно за этим пробу и завели.

- [ ] **Step 4: Прод**

Только после зелёного пункта 2.

---

## Чего в этом плане нет

- **Zoom** — следующим планом. Задачи 1–3 переиспользуются целиком, меняется только сценарий страницы: там есть и кнопка `[aria-label="mute my microphone"]`, и `ZoomMtg.mute()`.
- **Свои комнаты и Taler ID** — отдельный путь, вебсокета к боту там нет. Своим комнатам нужен `RoomServiceClient.mutePublishedTrack()` через бэкенд, Taler ID — снятие дорожки с публикации.
- **Meet и Teams** — невозможны без форка Attendee.
- **Триггер режима слушателя** (пункт 3 спеки) — по-прежнему ждёт лога прода. Этот план ничего в гейте не меняет: он реагирует на смену режима, а не решает, когда она происходит.
