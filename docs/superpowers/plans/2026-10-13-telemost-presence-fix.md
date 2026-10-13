# Ассистент выходит из живой встречи Телемоста — починка

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ассистент не уходит из встречи, где люди разговаривают, даже если счётчик участников сломался.

**Architecture:** Речь человека становится вторым, независимым от вёрстки источником присутствия — ровно тем, чем для Meet уже служит `meet_speaking`. Присутствие это **затухающее**, а не флаг: иначе правила выхода ломаются в другую сторону. Отдельно — проба разметки счётчика, чтобы починить и сам счётчик.

**Tech Stack:** TypeScript (воркер `voice-host`), JavaScript ESM (бот `infra/meeting-bot`), `node:test` в обоих.

---

## Что сломалось и почему

Живая встреча в Телемосте 13.10.2026: ассистент вышел ровно через 15 минут, хотя люди были и разговаривали.

**Механизм установлен.** Это вердикт `never_started` (`occupancy.ts`): `LOBBY_MS` ровно 15 минут, и срабатывает он ТОЛЬКО при `everHadHuman === false`. То есть за всю встречу ассистент не засчитал ни одного участника.

**Единая точка отказа.** У своего бота присутствие держится на одной зацепке и не имеет дубля:

- состав читается счётчиком на кнопке `[data-testid="participants-button"]` в `payload/telemost.mjs`, и там два молчаливых `return` — кнопки нет, или в её тексте нет цифр. Ни лога, ни пробы, в отличие от ленты чата с её `chat_probe`;
- второго источника нет. В Meet через Attendee есть страховка: `meet_speaking` зовёт `occupancy.joined()` с комментарием «речь — доказательство присутствия, и оно сильнее вранья Meet о составе». Свой бот событий речи не шлёт вовсе — `grep -c speaking` по `telemost.mjs` и `bot.mjs` даёт ноль.

**Какая из трёх причин сломала счётчик — не установлено:** кнопки нет в новой вёрстке; кнопка есть, но счётчик не в её тексте; счётчик не включает бота и вычитание единицы занижает счёт. Разделяет их только разметка с живой встречи — за ней и нужна проба.

## Ловушка, которую обязательно обойти

Напрашивающаяся правка — «при речи поднять `everHadHuman`» — делает ХУЖЕ.

`emptyGraceMs` у Телемоста равен нулю: выдержка в `agent.ts` даётся только `provider === 'meet'`. При поднятом флаге и пустом составе `verdict()` уходит в ветку `if (this.emptyGraceMs <= 0) return 'empty'` немедленно. Ассистент выходил бы не через 15 минут, а через 5 секунд после первой реплики человека — на следующем же тике сторожевого таймера.

Поэтому речь даёт **присутствие с затуханием**: пока человек говорил недавно, состав считается непустым независимо от счётчика.

**Почему щедрое время затухания безопасно.** Вердикт `empty` — это подстраховка, а не основной выход. Когда встреча реально кончается, бот закрывает вебсокет (`bot.mjs`, `stop()`), воркер видит потерю звука и уходит через `onLost` → `abortMeet` примерно за 90 секунд. Десять минут затухания стоят нам только тех случаев, когда этот путь тоже не сработал.

## Область

Только мост (`isBridged`) и только речь как присутствие плюс проба Телемоста.

НЕ трогаем:
- **правила выхода для своих комнат и Taler ID** — там состав берётся из LiveKit и не врёт, дубль не нужен и только задержал бы выход;
- **потолок в одну одновременную встречу** — решение владельца 13.10.2026: отдельной задачей;
- **счётчик Zoom** — он читает имена другим путём (`data.people`), этой поломки у него нет.

## Файлы

| Файл | Что с ним |
|---|---|
| `voice-host/src/occupancy.ts` | `speechHeard()`, затухание, правка `verdict()` |
| `voice-host/src/occupancy.test.ts` | Тесты правил выхода |
| `voice-host/src/agent.ts` | Кормим occupancy из транскрипта, только на мосту |
| `infra/meeting-bot/src/payload/telemost.mjs` | Проба разметки счётчика |
| `infra/meeting-bot/src/bot.mjs` | Событие `participants_probe` в лог |
| `infra/meeting-bot/test/payloads.test.mjs` | Проверка наличия пробы |

---

### Task 0: Ветка

- [ ] **Step 1: Создать ветку от актуального main**

```bash
cd spirits_back
git checkout main
git pull --ff-only
git checkout -b fix/telemost-presence
```

- [ ] **Step 2: Убедиться, что оба набора зелёные до правок**

Run: `cd voice-host && npm test`
Expected: `# fail 0`.

Run: `cd ../infra/meeting-bot && npm test`
Expected: `# fail 0`.

---

### Task 1: Речь как присутствие в правилах выхода

**Files:**
- Modify: `voice-host/src/occupancy.ts`
- Test: `voice-host/src/occupancy.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `src/occupancy.test.ts`:

```typescript
/**
 * Речь как присутствие.
 *
 * Живая встреча в Телемосте 13.10.2026: ассистент вышел через 15 минут при
 * живых участниках. Состав у своего бота читается одной зацепкой в вёрстке, и
 * когда она молчит, людей для правил выхода не существует. В Meet от этого
 * спасает meet_speaking; у своего бота событий речи нет, и дубля не было
 * никакого.
 *
 * Присутствие ЗАТУХАЮЩЕЕ, а не флаг. Выдержка на опустевшую встречу у
 * Телемоста нулевая, и флаг everHadHuman без непустого состава дал бы вердикт
 * empty на следующем же тике — выход через пять секунд вместо пятнадцати
 * минут.
 */
describe('речь как присутствие', () => {
  const TTL = 60_000;

  test('речь держит ассистента во встрече при пустом составе', () => {
    const o = new Occupancy(0, 0, TTL);
    o.speechHeard(1_000);
    // Состав пуст — счётчик сломан. Но человек только что говорил.
    assert.equal(o.verdict(2_000), 'stay');
    // И на пятнадцатой минуте тоже, пока люди продолжают говорить: ровно
    // здесь прежняя редакция выносила вердикт never_started.
    o.speechHeard(LOBBY_MS);
    assert.equal(o.verdict(LOBBY_MS + 1_000), 'stay', 'лобби-таймер больше не выгоняет');
  });

  test('затухло — встреча считается опустевшей, а не несостоявшейся', () => {
    // Причина выхода обязана называться честно: разговор был, транскрипт есть,
    // и помечать звонок «во встречу так никто и не пришёл» нельзя.
    const o = new Occupancy(0, 0, TTL);
    o.speechHeard(1_000);
    assert.equal(o.verdict(1_000 + TTL), 'empty');
  });

  test('без речи и без состава правило прежнее', () => {
    const o = new Occupancy(0, 0, TTL);
    assert.equal(o.verdict(LOBBY_MS - 1), 'stay');
    assert.equal(o.verdict(LOBBY_MS), 'never_started');
  });

  test('живой состав важнее затухшей речи', () => {
    const o = new Occupancy(0, 0, TTL);
    o.speechHeard(1_000);
    o.joined('участник-1');
    assert.equal(o.verdict(1_000 + TTL * 5), 'stay', 'человек в составе — уходить не за чем');
  });

  test('речь не отменяет двухчасовой потолок', () => {
    const o = new Occupancy(0, 0, TTL);
    o.speechHeard(HARD_CAP_MS - 1);
    assert.equal(o.verdict(HARD_CAP_MS), 'hard_cap');
  });
});
```

Импортов добавлять не надо: `Occupancy`, `LOBBY_MS`, `HARD_CAP_MS`, `describe` и `test` в этом файле уже есть.

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd voice-host && npx tsx --test src/occupancy.test.ts`
Expected: FAIL — `o.speechHeard is not a function`.

Реально запусти и покажи вывод.

- [ ] **Step 3: Добавить затухающее присутствие**

В `src/occupancy.ts` рядом с `MEET_EMPTY_GRACE_MS` добавить константу:

```typescript
/**
 * Сколько речь человека считается доказательством его присутствия.
 *
 * Нужна там, где состав приходит из вёрстки и может молчать (свой бот), а не
 * из LiveKit. Десять минут: в живом разговоре люди говорят куда чаще, а цена
 * ошибки в большую сторону — лишние минуты Realtime после конца встречи,
 * тогда как цена ошибки в меньшую — выход из живых переговоров при клиенте.
 *
 * Перебор здесь дёшев ещё и потому, что это не основной путь выхода: когда
 * встреча кончается, бот закрывает вебсокет, и воркер уходит по потере звука
 * (onLost → abortMeet) примерно за полторы минуты.
 */
export const SPEECH_PRESENCE_TTL_MS = 10 * 60_000;
```

В классе `Occupancy` добавить поле рядом с `emptyAt`:

```typescript
  /** Когда человек говорил в последний раз. `null` — не говорил вовсе. */
  private lastSpeechAt: number | null = null;
```

Расширить конструктор третьим параметром:

```typescript
  /**
   * `emptyGraceMs` — выдержка перед вердиктом «опустела». Ноль для своих
   * комнат, MEET_EMPTY_GRACE_MS для Meet: там источник состава врёт.
   * `speechTtlMs` — сколько речь считается присутствием. Параметр ради
   * тестов: десять минут в юнит-тесте не подождёшь.
   */
  constructor(
    private readonly startedAt: number,
    private readonly emptyGraceMs = 0,
    private readonly speechTtlMs = SPEECH_PRESENCE_TTL_MS,
  ) {}
```

Добавить метод рядом с `joined`/`left`:

```typescript
  /**
   * Человек говорил — значит он здесь.
   *
   * Источник, не зависящий от вёрстки: состав у своего бота читается зацепкой
   * на странице, а расшифровка речи приходит из звука встречи. Когда зацепка
   * молчит, это единственное свидетельство, что встреча живая.
   *
   * everHadHuman поднимаем здесь же: разговор был, и вердикт «во встречу так
   * никто и не пришёл» после него — неправда, за которую звонок пометят
   * failed.
   *
   * Личности у говорящего нет и не нужно: в Телемосте имён в разметке нет
   * вовсе, а для правил выхода важно лишь, что живой человек тут есть.
   */
  speechHeard(now: number): void {
    this.lastSpeechAt = now;
    this.everHadHuman = true;
  }
```

В `verdict()` — две правки. Было:

```typescript
    if (now - this.startedAt >= HARD_CAP_MS) return 'hard_cap';
    if (!this.everHadHuman) {
      return now - this.startedAt >= LOBBY_MS ? 'never_started' : 'stay';
    }
    if (this.humans.size > 0) {
      this.emptyAt = null;
      return 'stay';
    }
```

Станет:

```typescript
    if (now - this.startedAt >= HARD_CAP_MS) return 'hard_cap';
    if (!this.everHadHuman) {
      return now - this.startedAt >= LOBBY_MS ? 'never_started' : 'stay';
    }
    // Недавняя речь равносильна непустому составу. Проверяется ВМЕСТЕ с
    // размером, а не вместо: при живом составе уходить не за чем и без речи,
    // а при сломанном счётчике речь — единственное, что остаётся.
    const speaking = this.lastSpeechAt !== null && now - this.lastSpeechAt < this.speechTtlMs;
    if (this.humans.size > 0 || speaking) {
      this.emptyAt = null;
      return 'stay';
    }
```

Потолок `HARD_CAP_MS` остаётся первым и речью не отменяется — это предохранитель по деньгам.

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd voice-host && npx tsx --test src/occupancy.test.ts`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
cd spirits_back
git add voice-host/src/occupancy.ts voice-host/src/occupancy.test.ts
git commit -m "fix(voice-host): речь человека — присутствие в правилах выхода"
```

---

### Task 2: Кормим occupancy из транскрипта

**Files:**
- Modify: `voice-host/src/agent.ts`

- [ ] **Step 1: Найти место**

В `src/agent.ts` в обработчике транскрипта есть блок (около строки 1159):

```typescript
      if (isMeeting && normalizedRole === 'user') {
        currentSpeaker = speakers?.takeDominant(Date.now());
      }
```

Это ровно та точка, где реплика уже признана человеческой: синтетические вставки отсеяны по `INTERNAL_PREFIX` выше, эхо подсказки распознаванию — тоже (`isTranscriptionEcho`).

- [ ] **Step 2: Добавить отметку о присутствии**

```typescript
      if (isMeeting && normalizedRole === 'user') {
        currentSpeaker = speakers?.takeDominant(Date.now());
        // Речь человека — доказательство присутствия, не зависящее от вёрстки.
        //
        // Только на мосту: там состав читает со страницы свой бот, и когда
        // зацепка молчит, людей для правил выхода не существует — живая
        // встреча в Телемосте 13.10.2026 кончилась выходом через LOBBY_MS.
        // В своих комнатах и у Taler ID состав берётся из LiveKit и не врёт;
        // лишний источник там только задержал бы выход из опустевшей комнаты.
        //
        // Тот же принцип, что и у meet_speaking выше, — просто у своего бота
        // событий речи нет, и свидетельство приходится брать из расшифровки.
        if (isBridged) occupancy?.speechHeard(Date.now());
      }
```

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
git commit -m "fix(voice-host): на мосту речь из транскрипта держит встречу живой"
```

---

### Task 3: Проба разметки счётчика участников

**Files:**
- Modify: `infra/meeting-bot/src/payload/telemost.mjs`
- Modify: `infra/meeting-bot/src/bot.mjs`
- Test: `infra/meeting-bot/test/payloads.test.mjs`

НАПОМИНАНИЕ: внутри сценария страницы НЕТ обратных кавычек — литерал закроется раньше времени, и браузер не выполнит сценарий вовсе. Строки склеивай через `+`. Это закреплено тестами «разбирается как код» и «не оборван на полуслове».

- [ ] **Step 1: Написать падающий тест**

Добавить в конец `test/payloads.test.mjs`:

```javascript
/**
 * Счётчик участников Телемоста.
 *
 * 13.10.2026 он молчал всю встречу, и ассистент вышел через LOBBY_MS. Узнать
 * причину было неоткуда: оба отказа в чтении — молчаливый return. Проба
 * отдаёт разметку в лог ровно так же, как это уже сделано для ленты чата.
 */
describe('счётчик участников Телемоста', () => {
  test('проба разметки объявлена', () => {
    assert.match(TELEMOST_PAYLOAD, /participants_probe/);
  });

  test('проба уходит один раз, а не каждые две секунды', () => {
    assert.match(TELEMOST_PAYLOAD, /participantsProbed/);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `cd infra/meeting-bot && node --test test/payloads.test.mjs`
Expected: FAIL — `participants_probe` в сценарии не найден.

- [ ] **Step 3: Добавить пробу в сценарий**

В `src/payload/telemost.mjs` блок чтения состава сейчас такой:

```javascript
  setInterval(() => {
    try {
      const btn = document.querySelector('[data-testid="participants-button"]');
      if (!btn) return;
      const m = (btn.innerText || '').match(/\\d+/);
      if (!m) return;
      // Минус мы сами: площадка считает и бота.
      send('participants', { humans: Math.max(0, Number(m[0]) - 1) });
    } catch (e) { console.error('[бот] состав не прочитался', e); }
  }, 2000);
```

Станет (объявление флага — ПЕРЕД `setInterval`):

```javascript
  // Отказ в чтении состава был молчаливым, и встреча 13.10.2026 кончилась
  // выходом ассистента через пятнадцать минут: людей для правил выхода не
  // существовало. Отдаём разметку в лог — один раз за встречу, как chat_probe.
  let participantsProbed = false;

  setInterval(() => {
    try {
      const btn = document.querySelector('[data-testid="participants-button"]');
      const m = btn && (btn.innerText || '').match(/\\d+/);
      if (!m) {
        if (participantsProbed) return;
        participantsProbed = true;
        const panel = document.querySelector(
          '[class*="control"], [class*="toolbar"], [data-testid*="control"], [data-testid*="toolbar"]',
        );
        send('participants_probe', {
          found: !!btn,
          html: String((btn && btn.outerHTML) || (panel && panel.outerHTML) || '').slice(0, 4000),
        });
        return;
      }
      // Минус мы сами: площадка считает и бота.
      send('participants', { humans: Math.max(0, Number(m[0]) - 1) });
    } catch (e) { console.error('[бот] состав не прочитался', e); }
  }, 2000);
```

- [ ] **Step 4: Принять событие в боте**

В `src/bot.mjs` в `onPageEvent`, рядом с `case 'chat_probe'`:

```javascript
      case 'participants_probe':
        // Счётчик участников не прочитался. Для правил выхода это значит, что
        // людей во встрече как бы нет, и через LOBBY_MS ассистент уйдёт из
        // живого разговора — ровно это и случилось 13.10.2026. Разметку в лог,
        // вторую редакцию зацепки пишем по факту.
        this.log.warn?.(
          `[${this.id}] счётчик участников не прочитался (кнопка ${data?.found ? 'есть, цифр нет' : 'не найдена'}): ` +
          `${String(data?.html || '').slice(0, 1200)}`,
        );
        break;
```

- [ ] **Step 5: Запустить тесты**

Run: `cd infra/meeting-bot && node --test test/payloads.test.mjs`
Expected: PASS, `# fail 0`.

Тесты «разбирается как код» и «не оборван на полуслове» обязаны остаться зелёными.

- [ ] **Step 6: Прогнать весь набор бота**

Run: `cd infra/meeting-bot && npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Коммит**

```bash
cd spirits_back
git add infra/meeting-bot/src/payload/telemost.mjs infra/meeting-bot/src/bot.mjs infra/meeting-bot/test/payloads.test.mjs
git commit -m "fix(meeting-bot): счётчик участников не прочитался — разметка в лог"
```

---

### Task 4: Живая встреча

Ручная, выполняет владелец.

- [ ] **Step 1: Выкатить на тестовый стенд**

```bash
cd spirits_back
TEST_ONLY=1 BACK_ONLY=1 bash scripts/deploy.sh
```

- [ ] **Step 2: Встреча в Телемосте дольше 15 минут**

- ассистент остаётся во встрече после пятнадцатой минуты, пока люди говорят;
- в логе воркера нет строки `выходим из встречи: never_started`.

- [ ] **Step 3: Забрать разметку счётчика**

В логе бота искать:

```
счётчик участников не прочитался (кнопка ...): <...>
```

Если строки нет — счётчик работает, и причина выхода была в другом; тогда остановиться и разобрать заново, а не чинить дальше. Если строка есть — это материал для второй редакции зацепки, отдельной маленькой правкой.

- [ ] **Step 4: Прод**

Только после зелёного пункта 2.

---

## Чего в этом плане нет

- **Потолок в одну одновременную встречу.** Разобран: это диапазон портов под звук (`ATTENDEE_WS_PORT_MIN`/`MAX`, оба 8140) плюс регулярка в двух конфигах nginx. Причина потолка относится только к Attendee — у него боты в одном контейнере делят аудиоустройства. Для Zoom и Телемоста через свой бот она не действует. Решение владельца 13.10.2026: отдельной задачей.
- **Вторая редакция зацепки счётчика** — пишется по разметке из Task 4, не раньше.
- **Счётчик Zoom** — он читает имена другим путём, этой поломки у него нет.
