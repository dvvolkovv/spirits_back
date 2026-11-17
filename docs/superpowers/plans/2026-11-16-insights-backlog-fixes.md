# Затыки недели 16.11 — план исправлений

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть девять одобренных пунктов бэклога из «Затыков недели» 16.11: ход не теряется при выкате релея, ответ не склеивается после шага работы, у ассистентов есть правила результата, отказ по балансу подсказывает выход, тексты сбоев — на языке человека, файлы с кириллицей не затирают друг друга.

**Architecture:** Один общий помощник `postRelayWithDrainRetry` повторяет POST /chat к релею, пока тот за шлагбаумом выката (502/503/ECONNREFUSED), — его зовут все пять мест вызова. Выкат релея по умолчанию сначала ждёт тишины и ставит шлагбаум только на рестарт. Разделитель блоков, правила результата, подсказка отказа и тексты сбоев — маленькие чистые модули. Имена загрузок на релее получают хеш при потере символов и суффикс при совпадении.

**Tech Stack:** NestJS 10 + TypeScript (jest), relay-agent Node ESM (`node --test`), bash (`scripts/deploy-relay.sh`, тест через заглушки).

**Спек (источник истины):** `docs/superpowers/specs/2026-11-16-insights-backlog-fixes-design.md`. При расхождении плана и спека прав спек — остановиться и спросить.

---

## Контекст для инженера с нулевым контекстом

- Бэкенд — NestJS, пути `/webhook/*`. Ходы ассистентов исполняет **релей** (`relay-agent/`, отдельный сервер `r.linkeon.io`): бэк шлёт ему `POST /chat` (multipart), релей отвечает SSE-потоком событий `delta`/`text`, `tool`, `notice`, `result`, `done`.
- Пять мест, откуда бэк зовёт `POST /chat`:
  1. текстовый ход кабинета — `callUpstreamOnce` внутри `streamUniversalAgent` в `src/chat/chat.service.ts`;
  2. фоновый ответ (рутины, day-framing поездок) — `agentReply` в `src/chat/chat.service.ts`;
  3. ход с файлом — `uploadAndChat` в `src/chat/chat.controller.ts`;
  4. «чистый вопрос» — `callRelay` в `src/ask/clean-ask.service.ts`;
  5. автоблог — `ask` в `src/blog/blog-relay.client.ts`.
- **Выкат релея** (`scripts/deploy-relay.sh`) ставит «шлагбаум» — файл-маркер, после которого релей отвечает 503 на новые ходы, ждёт, пока доработают текущие, и рестартует процесс. nginx во время рестарта отдаёт 502. Сейчас бэк на 503 просто падает: человек видит пустой ответ, рутина теряется (пункт aa27b1d5).
- Повтор безопасен только для 502, 503 и `ECONNREFUSED` — в этих случаях релей ход точно не начинал. ECONNRESET, 504, 500 и таймаут — нельзя: ход мог начаться и списать деньги.
- `relayRunning` (`Map<relaySid, mark>` в `ChatService`) — «у этой сессии релея сейчас идёт ход с такой меткой». Новый ход той же сессии получает новую метку; старый по несовпадению метки понимает, что его перебили. Отсюда же служебная заметка `INTERRUPTED_TURN_NOTE` («тот ход прерван») в начале следующего сообщения.
- Сборка из магазина (`storeBuild`, заголовок `x-linkeon-distribution`) по правилу Apple 3.1.1 не говорит о токенах, балансе, оплате и не даёт ссылок.
- Языки интерфейса: `ru`, `en`, `es`, `de`, `fr`, `zh`, `pt`. По умолчанию `ru`. Язык человека в коде — `userLanguage` (`this.language.resolveUserLanguage`).
- Клиенты (веб, Flutter, Capacitor) особо обрабатывают только `reason: 'no_tokens'` в событии `end`; новое `reason: 'relay_draining'` старые клиенты молча игнорируют.

## Глобальные правила (читать перед КАЖДОЙ задачей)

1. **Где работать.** Ветка `fix/insights-backlog-1116`, воркдерево `/Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116`. Общий чекаут `~/Downloads/spirits_back` не трогать. Bash сбрасывает cwd после каждого вызова — `cd <воркдерево> && …` в каждой команде.
2. **Тесты и tsc — только на тестовой ноде** `dv@85.192.61.231`, в CI-воркдереве `~/ci/wt/ins1116-back`, на конкретном sha. Мак jest не тянет. Шаблон прогона:
   ```bash
   cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git push -q -u origin fix/insights-backlog-1116 && SHA=$(git rev-parse HEAD) && \
   ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest <файлы> 2>&1 | tail -40"
   ```
   - `source ~/.nvm/nvm.sh` — в каждой ssh-команде; `ssh -n` — всегда.
   - Тесты релея: `cd ~/ci/wt/ins1116-back/relay-agent && source ~/.nvm/nvm.sh && node --test <файл>`.
   - Гейт типов: `npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK` (jest типы не проверяет).
   - На ноде не трогать `~/spirits_back`, `~/spirits_front`, `~/dev` — только `~/ci/`.
3. **TDD.** Красный тест — отдельным коммитом `test(<область>): … — красный`, запушен и проверен красным на ноде. Затем реализация отдельным коммитом. Без amend, force, rebase.
4. **Коммиты.** Явные пути в `git add` (никаких `-A` и `.`). Пушить только `fix/insights-backlog-1116`. Каждое сообщение коммита заканчивается строкой:
   ```
   Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
   ```
5. **Никаких выкатов** в ходе задач. `deploy.sh` и `deploy-relay.sh` — только после ревью, мержа и явного OK владельца.
6. **Репозиторий публичный:** ни секретов, ни телефонов, ни имён и цитат пользователей. В тестах — `u1` / `u-1`.
7. **Кириллицу и CJK писать буквально.** Инструмент Write портит `\uXXXX`.
8. **Номера строк — подсказки.** Искать по тексту-якорю: файлы меняются параллельными сессиями.
9. **Чужие ожидания в тестах не переписывать вслепую** — только перечисленные в задаче.
10. Комментарии в коде — по-русски, в духе соседнего кода. В текстах для людей — «ассистент», не «агент».
11. **zsh:** глобы в кавычках, разделители — `echo '---'`.
12. Перед Task 5: `git fetch origin && git log --oneline 949e81fd..origin/main -- src/chat/chat.controller.ts src/chat/chat.service.ts`. Если параллельная сессия (память загрузок) что-то туда принесла — `git merge origin/main` (не rebase), прогнать затронутые спеки и только потом начинать.

## Карта файлов

| Файл | Что | Задача |
|---|---|---|
| `src/chat/chat-failure-texts.ts`, `chat-failure-texts.spec.ts` (новые) | Тексты сбоев на 7 языках, `chatFailureText`, `allChatFailureTexts`; страж старых строк | 1 |
| `src/monitoring/product/funnel.service.ts`, `funnel.failure-stubs.spec.ts` (новый) | Фильтр заглушек всех языков (`$6`) | 1 |
| `src/chat/chat.service.product-actions-attach.spec.ts` | Ожидание «Ошибка запуска ассистента» | 1 |
| `tests/shankara-ayurveda.e2e.mjs`, `scripts/synthetic-runner.js` | Новые маркеры заглушек | 1 |
| `src/chat/relay-drain-retry.ts`, `relay-drain-retry.spec.ts` (новые) | `postRelayWithDrainRetry`, `RelayDrainingError` | 2 |
| `src/chat/interrupted-turn.ts`, `interrupted-turn.spec.ts` | `RelayCarry`, `relayUndeliveredNote` | 3 |
| `src/chat/chat.relay-waiting.spec.ts` (новый) | Учёт ждущего хода: заметки, перенос, `postRelayTurn` | 3 |
| `src/chat/chat.service.ts` | Тексты сбоев; `relayWaiting` и `postRelayTurn`; веб-путь; agentReply; разделитель; `resultRules` | 1, 3, 4, 6, 9, 10 |
| `src/chat/chat.relay-drain.spec.ts` (новый) | Веб-ход и загрузка под шлагбаумом | 4, 5 |
| `src/chat/chat.controller.ts` | Загрузка: тексты, повтор и перенос, разделитель | 1, 5, 9 |
| `src/chat/chat.service.routine-turns.spec.ts` | agentReply под шлагбаумом | 6 |
| `src/routine-push/routine-push.service.ts`, `routine-push.controller.ts`, `routine-push.busy-retry.spec.ts` | `draining` — как busy | 6 |
| `src/trip/trip.service.ts`, `trip.service.spec.ts` | day-framing откладывается | 6 |
| `src/ask/clean-ask.service.ts`, `clean-ask.service.spec.ts` | Повтор на 503 | 7 |
| `src/blog/blog-relay.client.ts`, `blog-relay.client.spec.ts` | Повтор на 503 | 7 |
| `scripts/deploy-relay.sh`, `tests/scripts/deploy-relay-drain.test.js`, `relay-agent/README.md` | Сначала тишина, шлагбаум — на перепроверку и рестарт | 8 |
| `src/chat/block-separator.ts`, `block-separator.spec.ts` (новые) | `blockSeparator`, `BlockJoiner` | 9 |
| `src/chat/chat.tool-separator.spec.ts` (новый) | Разделитель у трёх потребителей потока релея | 9 |
| `src/chat/result-rules.ts`, `result-rules.spec.ts` (новые) | Правила результата в системном промпте | 10 |
| `src/chat/chat-tools.ts`, `src/chat/balance-context-delivery.spec.ts` | `hint` в отказе по балансу | 11 |
| `relay-agent/paths.mjs`, `paths.test.mjs`, `server.mjs`, `server-sandbox.test.mjs` | Хеш в имени при потере символов, суффикс вместо перезаписи | 12 |

**Порядок задач:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13. Задачи 8, 10, 11, 12 от 2–7 не зависят и могут идти параллельно, но коммитить последовательно в одну ветку. Задача 9 — только после 4–6: она правит те же обработчики потока.

---

### Task 0: Воркдерево на ноде и базовая линия

**Files:** нет изменений в репозитории.

- [ ] **Step 1: Создать CI-воркдерево на ноде**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git push -q -u origin fix/insights-backlog-1116 && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && (test -d ~/ci/wt/ins1116-back || git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/ins1116-back ${SHA}) && cd ~/ci/wt/ins1116-back && git checkout -q --detach ${SHA} && git log --oneline -1"
```
Expected: строка с sha ветки.

- [ ] **Step 2: Установить зависимости (корень и релей)**

```bash
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund >/dev/null 2>&1 && echo ROOT_OK && cd relay-agent && npm ci --no-audit --no-fund >/dev/null 2>&1 && echo RELAY_OK"
```
Expected: `ROOT_OK`, `RELAY_OK`.

- [ ] **Step 3: Базовая линия — tsc, сборка и обе половины jest, как в smoke**

```bash
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && source ~/.nvm/nvm.sh && (npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK) > ~/ci/wt/ins1116-baseline.txt 2>&1; (npm run build >/dev/null 2>&1 && echo BUILD_OK) >> ~/ci/wt/ins1116-baseline.txt; (cd tests && npx jest unit/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)') >> ~/ci/wt/ins1116-baseline.txt; npx jest src/ tests/scripts/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)' >> ~/ci/wt/ins1116-baseline.txt; cat ~/ci/wt/ins1116-baseline.txt"
```
Expected: `TSC_OK`, `BUILD_OK` и итоговые строки двух прогонов. Это две половины smoke (`tests/smoke/run.sh`): `tests/unit` грузит собранный `dist/`, поэтому сборка — до него, иначе проверяется старый код. Путь `src/` указан явно: без него jest подхватывает чужие `.worktrees/`. Полный jest бэка красный «by design» — список `FAIL` запоминаем как базу, в Task 13 сравниваем дельтой.

- [ ] **Step 4: Базовая линия релея**

```bash
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back/relay-agent && source ~/.nvm/nvm.sh && node --test *.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'"
```
Expected: `# fail 0` — тот же набор, что `deploy-relay.sh` гоняет в staging. Если что-то красное уже на базе — записать и в Task 12 и 13 сравнивать дельтой.

---

### Task 1: Тексты сбоев на языке человека

Пункт aa27b1d5. Спек §6.

**Files:**
- Create: `src/chat/chat-failure-texts.ts`
- Create: `src/chat/chat-failure-texts.spec.ts`
- Create: `src/monitoring/product/funnel.failure-stubs.spec.ts`
- Modify: `src/chat/chat.service.ts` (cliFatal в `persistResponse` ~2193, заглушка `aiText` ~2234, `errText` в главном catch ~2914, `UploadHandoff` ~67, `buildUploadHandoff` return ~1170, `persistUploadTurn` ~3632–3660)
- Modify: `src/chat/chat.controller.ts` (`errText` ~646, вызов `persistUploadTurn` ~675)
- Modify: `src/monitoring/product/funnel.service.ts` (`chatBackedStep` ~87–108)
- Modify: `src/chat/chat.service.product-actions-attach.spec.ts:262`
- Modify: `tests/shankara-ayurveda.e2e.mjs:83`, `scripts/synthetic-runner.js:139–145`

- [ ] **Step 1: Красный тест модуля текстов**

Create `src/chat/chat-failure-texts.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { chatFailureText, allChatFailureTexts, ChatFailureKind } from './chat-failure-texts';
import { ChatService } from './chat.service';
import { looksLikeFailure } from '../routine-push/routine-push.service';

const LANGS = ['ru', 'en', 'es', 'de', 'fr', 'zh', 'pt'];
const KINDS: ChatFailureKind[] = ['relayUpdating', 'startFailed', 'fileFailed', 'noReply', 'cliFatal'];
const VARIANTS = [{}, { upload: true }, { storeBuild: true }, { storeBuild: true, upload: true }];
const MONEY = /token|токен|jeton|代币|balance|баланс|saldo|guthaben|solde|余额|пополн/i;

describe('chatFailureText', () => {
  it('7 языков × 5 видов × 4 варианта — ни одного пустого', () => {
    for (const lang of LANGS) for (const kind of KINDS) for (const v of VARIANTS) {
      expect(chatFailureText(kind, lang, v).trim().length).toBeGreaterThan(10);
    }
  });

  it('магазинные варианты не говорят о токенах ни на одном языке', () => {
    for (const lang of LANGS) for (const kind of KINDS) {
      expect(chatFailureText(kind, lang, { storeBuild: true })).not.toMatch(MONEY);
      expect(chatFailureText(kind, lang, { storeBuild: true, upload: true })).not.toMatch(MONEY);
    }
  });

  it('обычный relayUpdating и cliFatal честно говорят, что не списано', () => {
    expect(chatFailureText('relayUpdating', 'ru')).toContain('Токены не списаны');
    expect(chatFailureText('cliFatal', 'en')).toContain('No tokens were charged');
  });

  it('загрузка просит прислать и файлы', () => {
    expect(chatFailureText('relayUpdating', 'ru', { upload: true })).toContain('файлы');
    expect(chatFailureText('relayUpdating', 'de', { upload: true })).toContain('Dateien');
  });

  it('не-русские тексты без кириллицы', () => {
    for (const lang of LANGS.filter((l) => l !== 'ru')) for (const kind of KINDS) for (const v of VARIANTS) {
      expect(chatFailureText(kind, lang, v)).not.toMatch(/[а-яё]/i);
    }
  });

  it('неизвестный язык и пустой — русский', () => {
    expect(chatFailureText('noReply', 'xx')).toBe(chatFailureText('noReply', 'ru'));
    expect(chatFailureText('noReply', undefined)).toBe(chatFailureText('noReply', 'ru'));
    expect(chatFailureText('noReply', 'EN')).toBe(chatFailureText('noReply', 'en'));
  });

  it('ни один текст не принимается за сбой CLI или генерации', () => {
    const looksCliFailure = (t: string) => (ChatService.prototype as any).looksCliFailure.call({}, t);
    for (const t of allChatFailureTexts()) {
      expect(looksCliFailure(t)).toBe(false);
      expect(looksLikeFailure(t)).toBe(false);
    }
  });

  it('allChatFailureTexts — без повторов и с каждым вариантом', () => {
    const all = allChatFailureTexts();
    expect(new Set(all).size).toBe(all.length);
    for (const lang of LANGS) for (const kind of KINDS) for (const v of VARIANTS) {
      expect(all).toContain(chatFailureText(kind, lang, v));
    }
  });

  it('старые русские строки больше не зашиты в чат-сервис и контроллер', () => {
    for (const file of ['chat.service.ts', 'chat.controller.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).not.toContain('Ошибка запуска агента');
      for (const t of allChatFailureTexts()) expect(src).not.toContain(`'${t}'`);
    }
  });
});
```

- [ ] **Step 2: Красный тест воронки**

Create `src/monitoring/product/funnel.failure-stubs.spec.ts`. Перед написанием открыть `src/monitoring/product/stats-fail-soft.spec.ts` и сверить, как там строится `FunnelService` и какие аргументы у `getFunnel` — повторить ровно так же.

```ts
import { FunnelService } from './funnel.service';
import { allChatFailureTexts } from '../../chat/chat-failure-texts';

const FROM = '2026-11-04T00:00:00.000Z';
const TO = '2026-11-05T00:00:00.000Z';

describe('воронка: заглушки сбоев на всех языках не считаются ответами', () => {
  it('шаг ai-ответа исключает все тексты allChatFailureTexts(), шаг сообщения — нет', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new FunnelService(pg as any).getFunnel(FROM, TO, null);
    const history = pg.query.mock.calls.filter(([sql]: any[]) => /custom_chat_history/.test(String(sql)));
    const ai = history.find(([, params]: any[]) => params?.[4] === 'ai');
    const human = history.find(([, params]: any[]) => params?.[4] === 'human');
    expect(ai).toBeDefined();
    expect(human).toBeDefined();
    expect(String(ai![0])).toContain('<> ALL($6::text[])');
    expect(ai![1][5]).toEqual(allChatFailureTexts());
    expect(String(human![0])).not.toContain('$6');
    expect(human![1]).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Обновить ожидание в спеке прикрепления действий**

В `src/chat/chat.service.product-actions-attach.spec.ts` (~262) заменить:

```ts
    expect(end.content).toBe('Ошибка запуска агента. Попробуйте ещё раз.');
```
на
```ts
    expect(end.content).toBe('Ошибка запуска ассистента. Попробуйте ещё раз.');
```

- [ ] **Step 4: Запушить и убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat-failure-texts.spec.ts src/monitoring/product/funnel.failure-stubs.spec.ts src/chat/chat.service.product-actions-attach.spec.ts && git commit -q -m "test(chat): тексты сбоев на языке человека и фильтр воронки — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q -u origin fix/insights-backlog-1116 && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat-failure-texts.spec.ts src/monitoring/product/funnel.failure-stubs.spec.ts src/chat/chat.service.product-actions-attach.spec.ts 2>&1 | tail -30"
```
Expected: FAIL — `Cannot find module './chat-failure-texts'`, и в attach-спеке ожидание не совпадает.

- [ ] **Step 5: Модуль текстов**

Create `src/chat/chat-failure-texts.ts`:

```ts
/**
 * Тексты, которые человек видит, когда ход не получился, — на его языке.
 *
 * Откуда («Затыки недели» 16.11.2026, пункты aa27b1d5 и faa0d127): заглушки
 * сбоев были зашиты по-русски в трёх местах чат-сервиса и контроллера, и
 * человек с английским интерфейсом получал «Ошибка запуска агента» посреди
 * английского разговора. Здесь — один источник: чат-сервис, загрузка и
 * воронка (funnel.service.ts исключает заглушки из счёта ответов) берут
 * тексты отсюда.
 *
 * Магазинная сборка (правило Apple 3.1.1) не говорит о токенах, поэтому у
 * текстов, где обычный вариант обещает «токены не списаны», есть вариант
 * `store`. Загрузка просит прислать и файлы — вариант `upload`.
 *
 * Тексты в курсиве (`_…_`) — так их рисует кабинет. Ни один не должен
 * попадаться на looksCliFailure (chat.service.ts) и looksLikeFailure
 * (routine-push.service.ts): иначе сервис принял бы свою же заглушку за
 * сбой CLI. Это сторожит chat-failure-texts.spec.ts.
 */
export type ChatFailureKind = 'relayUpdating' | 'startFailed' | 'fileFailed' | 'noReply' | 'cliFatal';

interface Variants { text: string; upload?: string; store?: string; storeUpload?: string }

const TEXTS: Record<ChatFailureKind, Record<string, Variants>> = {
  relayUpdating: {
    ru: {
      text: '_Ассистент сейчас обновляется и не успел взяться за сообщение. Токены не списаны — отправьте его ещё раз через пару минут._',
      upload: '_Ассистент сейчас обновляется и не успел взяться за сообщение. Токены не списаны — отправьте сообщение и файлы ещё раз через пару минут._',
      store: '_Ассистент сейчас обновляется и не успел взяться за сообщение — отправьте его ещё раз через пару минут._',
      storeUpload: '_Ассистент сейчас обновляется и не успел взяться за сообщение — отправьте сообщение и файлы ещё раз через пару минут._',
    },
    en: {
      text: "_The assistant is updating right now and didn't get to your message. No tokens were charged — please send it again in a couple of minutes._",
      upload: "_The assistant is updating right now and didn't get to your message. No tokens were charged — please send the message and files again in a couple of minutes._",
      store: "_The assistant is updating right now and didn't get to your message — please send it again in a couple of minutes._",
      storeUpload: "_The assistant is updating right now and didn't get to your message — please send the message and files again in a couple of minutes._",
    },
    es: {
      text: '_El asistente se está actualizando y no llegó a tu mensaje. No se han descontado tokens: envíalo de nuevo en un par de minutos._',
      upload: '_El asistente se está actualizando y no llegó a tu mensaje. No se han descontado tokens: envía el mensaje y los archivos de nuevo en un par de minutos._',
      store: '_El asistente se está actualizando y no llegó a tu mensaje. Envíalo de nuevo en un par de minutos._',
      storeUpload: '_El asistente se está actualizando y no llegó a tu mensaje. Envía el mensaje y los archivos de nuevo en un par de minutos._',
    },
    de: {
      text: '_Der Assistent wird gerade aktualisiert und ist nicht zu deiner Nachricht gekommen. Es wurden keine Tokens abgebucht – sende sie in ein paar Minuten erneut._',
      upload: '_Der Assistent wird gerade aktualisiert und ist nicht zu deiner Nachricht gekommen. Es wurden keine Tokens abgebucht – sende die Nachricht und die Dateien in ein paar Minuten erneut._',
      store: '_Der Assistent wird gerade aktualisiert und ist nicht zu deiner Nachricht gekommen – sende sie in ein paar Minuten erneut._',
      storeUpload: '_Der Assistent wird gerade aktualisiert und ist nicht zu deiner Nachricht gekommen – sende die Nachricht und die Dateien in ein paar Minuten erneut._',
    },
    fr: {
      text: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Aucun jeton n'a été débité : renvoie-le dans quelques minutes._",
      upload: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Aucun jeton n'a été débité : renvoie le message et les fichiers dans quelques minutes._",
      store: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Renvoie-le dans quelques minutes._",
      storeUpload: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Renvoie le message et les fichiers dans quelques minutes._",
    },
    pt: {
      text: '_O assistente está a ser atualizado e não chegou a pegar na sua mensagem. Não foram descontados tokens — envie-a novamente daqui a uns minutos._',
      upload: '_O assistente está a ser atualizado e não chegou a pegar na sua mensagem. Não foram descontados tokens — envie a mensagem e os ficheiros novamente daqui a uns minutos._',
      store: '_O assistente está a ser atualizado e não chegou a pegar na sua mensagem — envie-a novamente daqui a uns minutos._',
      storeUpload: '_O assistente está a ser atualizado e não chegou a pegar na sua mensagem — envie a mensagem e os ficheiros novamente daqui a uns minutos._',
    },
    zh: {
      text: '_助手正在更新，未能处理这条消息。未扣除代币——请几分钟后重新发送。_',
      upload: '_助手正在更新，未能处理这条消息。未扣除代币——请几分钟后重新发送消息和文件。_',
      store: '_助手正在更新，未能处理这条消息——请几分钟后重新发送。_',
      storeUpload: '_助手正在更新，未能处理这条消息——请几分钟后重新发送消息和文件。_',
    },
  },
  startFailed: {
    ru: { text: 'Ошибка запуска ассистента. Попробуйте ещё раз.' },
    en: { text: 'The assistant failed to start. Please try again.' },
    es: { text: 'No se pudo iniciar el asistente. Inténtalo de nuevo.' },
    de: { text: 'Der Assistent konnte nicht starten. Versuch es noch einmal.' },
    fr: { text: "L'assistant n'a pas pu démarrer. Réessaie." },
    pt: { text: 'Não foi possível iniciar o assistente. Tente novamente.' },
    zh: { text: '助手启动失败，请重试。' },
  },
  fileFailed: {
    ru: { text: 'Ошибка обработки файла. Попробуйте ещё раз.' },
    en: { text: "Couldn't process the file. Please try again." },
    es: { text: 'No se pudo procesar el archivo. Inténtalo de nuevo.' },
    de: { text: 'Die Datei konnte nicht verarbeitet werden. Versuch es noch einmal.' },
    fr: { text: 'Impossible de traiter le fichier. Réessaie.' },
    pt: { text: 'Não foi possível processar o ficheiro. Tente novamente.' },
    zh: { text: '文件处理失败，请重试。' },
  },
  noReply: {
    ru: { text: '_Ответ не пришёл. Попробуйте отправить сообщение ещё раз._' },
    en: { text: '_No reply came through. Please try sending the message again._' },
    es: { text: '_No llegó la respuesta. Intenta enviar el mensaje de nuevo._' },
    de: { text: '_Es kam keine Antwort. Versuch, die Nachricht noch einmal zu senden._' },
    fr: { text: "_La réponse n'est pas arrivée. Essaie de renvoyer le message._" },
    pt: { text: '_A resposta não chegou. Tente enviar a mensagem novamente._' },
    zh: { text: '_没有收到回复，请重新发送消息。_' },
  },
  cliFatal: {
    ru: {
      text: '_Не получилось: временный сбой на стороне платформы. Токены за этот ход не списаны — попробуйте отправить сообщение ещё раз._',
      store: '_Не получилось: временный сбой на стороне платформы — попробуйте отправить сообщение ещё раз._',
    },
    en: {
      text: "_That didn't work: a temporary platform error. No tokens were charged for this turn — please try sending the message again._",
      store: "_That didn't work: a temporary platform error — please try sending the message again._",
    },
    es: {
      text: '_No ha funcionado: fallo temporal de la plataforma. No se han descontado tokens por este turno: intenta enviar el mensaje de nuevo._',
      store: '_No ha funcionado: fallo temporal de la plataforma. Intenta enviar el mensaje de nuevo._',
    },
    de: {
      text: '_Das hat nicht geklappt: vorübergehender Fehler der Plattform. Für diesen Schritt wurden keine Tokens abgebucht – versuch, die Nachricht noch einmal zu senden._',
      store: '_Das hat nicht geklappt: vorübergehender Fehler der Plattform – versuch, die Nachricht noch einmal zu senden._',
    },
    fr: {
      text: "_Ça n'a pas marché : panne temporaire de la plateforme. Aucun jeton n'a été débité pour ce tour : essaie de renvoyer le message._",
      store: "_Ça n'a pas marché : panne temporaire de la plateforme. Essaie de renvoyer le message._",
    },
    pt: {
      text: '_Não resultou: falha temporária da plataforma. Não foram descontados tokens por esta resposta — tente enviar a mensagem novamente._',
      store: '_Não resultou: falha temporária da plataforma — tente enviar a mensagem novamente._',
    },
    zh: {
      text: '_未能完成：平台临时故障。本次未扣除代币——请重新发送消息。_',
      store: '_未能完成：平台临时故障——请重新发送消息。_',
    },
  },
};

export function chatFailureText(
  kind: ChatFailureKind,
  lang: string | null | undefined,
  opts: { upload?: boolean; storeBuild?: boolean } = {},
): string {
  const byLang = TEXTS[kind];
  const v = byLang[String(lang || '').toLowerCase()] ?? byLang.ru;
  if (opts.storeBuild && opts.upload) return v.storeUpload ?? v.store ?? v.upload ?? v.text;
  if (opts.storeBuild) return v.store ?? v.text;
  if (opts.upload) return v.upload ?? v.text;
  return v.text;
}

/** Все варианты всех текстов — для воронки (исключить заглушки из счёта ответов). */
export function allChatFailureTexts(): string[] {
  const out = new Set<string>();
  for (const byLang of Object.values(TEXTS)) {
    for (const v of Object.values(byLang)) {
      for (const t of [v.text, v.upload, v.store, v.storeUpload]) if (t) out.add(t);
    }
  }
  return [...out];
}
```

- [ ] **Step 6: Язык в handoff загрузки и в `persistUploadTurn`**

В `src/chat/chat.service.ts`:

1. В `interface UploadHandoff` (рядом с `profilingBlocks: RelayProfilingBlocks;`) добавить последним полем:
   ```ts
     /** Язык человека — для текстов сбоев хода с файлом (chat-failure-texts.ts). */
     userLanguage?: string;
   ```
2. В `buildUploadHandoff` заменить строку возврата:
   ```ts
       return { baseSessionId, sessionId, systemPrompt, history, uploadContext, products, linkeon, profilingBlocks };
   ```
   на
   ```ts
       return { baseSessionId, sessionId, systemPrompt, history, uploadContext, products, linkeon, profilingBlocks, userLanguage };
   ```
3. В параметры `persistUploadTurn(p: {…})` после `sessionIdOverride?: string;` добавить:
   ```ts
       /** Язык и сборка — для текста сбоя CLI на языке человека. */
       userLanguage?: string;
       storeBuild?: boolean;
   ```
4. Там же, в ветке `if (this.looksCliFailure(text)) {`, заменить присваивание `text = '_Не получилось: …_';` на:
   ```ts
         text = chatFailureText('cliFatal', p.userLanguage, { storeBuild: p.storeBuild });
   ```
5. В импорты наверху файла (рядом с `import { WORK_RULES } …`) добавить:
   ```ts
   import { chatFailureText } from './chat-failure-texts';
   ```

- [ ] **Step 7: Тексты веб-пути**

В `streamUniversalAgent` (`src/chat/chat.service.ts`):

1. В `persistResponse`, ветка `if (this.looksCliFailure(fullText)) {` — заменить `fullText = '_Не получилось: …_';` на:
   ```ts
           fullText = chatFailureText('cliFatal', userLanguage, { storeBuild });
   ```
2. Заглушка пустого ответа:
   ```ts
         const aiText = fullText
           || (final && !selfHealSkippedForTakeover ? '_Ответ не пришёл. Попробуйте отправить сообщение ещё раз._' : '');
   ```
   заменить на
   ```ts
         const aiText = fullText
           || (final && !selfHealSkippedForTakeover ? chatFailureText('noReply', userLanguage) : '');
   ```
3. В главном `catch (err)` хода:
   ```ts
         const errText = 'Ошибка запуска агента. Попробуйте ещё раз.';
   ```
   заменить на
   ```ts
         const errText = chatFailureText('startFailed', userLanguage);
   ```

- [ ] **Step 8: Тексты загрузки**

В `src/chat/chat.controller.ts`:

1. Импорт рядом с остальными из `./`:
   ```ts
   import { chatFailureText } from './chat-failure-texts';
   ```
2. В `finally` после вызова релея:
   ```ts
           const errText = 'Ошибка обработки файла. Попробуйте ещё раз.';
   ```
   заменить на
   ```ts
           const errText = chatFailureText('fileFailed', handoff.userLanguage);
   ```
3. В вызов `this.chatService.persistUploadTurn({ … sessionIdOverride: freshSessionId, })` добавить после `sessionIdOverride: freshSessionId,`:
   ```ts
                 userLanguage: handoff.userLanguage,
                 storeBuild,
   ```

- [ ] **Step 9: Воронка**

В `src/monitoring/product/funnel.service.ts`:

1. Импорт:
   ```ts
   import { allChatFailureTexts } from '../../chat/chat-failure-texts';
   ```
2. В `chatBackedStep` заменить
   ```ts
         const stubFilter = excludeStubs
           ? `AND content NOT ILIKE '%Ответ не пришёл%' AND content NOT ILIKE 'Ошибка запуска%'`
           : '';
   ```
   на
   ```ts
         // Заглушки сбоев на всех языках (chat-failure-texts.ts) — точным
         // совпадением; ILIKE остаются для строк, записанных до 16.11.2026.
         const stubFilter = excludeStubs
           ? `AND content NOT ILIKE '%Ответ не пришёл%' AND content NOT ILIKE 'Ошибка запуска%' AND content <> ALL($6::text[])`
           : '';
   ```
3. Там же `params: [eventName, from, to, excluded, senderType],` заменить на
   ```ts
           params: excludeStubs
             ? [eventName, from, to, excluded, senderType, allChatFailureTexts()]
             : [eventName, from, to, excluded, senderType],
   ```
4. В комментарии над методом `excludeStubs убирает заглушки-ошибки ("Ответ не пришёл"/"Ошибка запуска")` дописать `и все тексты chat-failure-texts.ts`.

- [ ] **Step 10: Маркеры заглушек в e2e и синтетике**

1. `tests/shankara-ayurveda.e2e.mjs:83` — массив `STUBS` дополнить двумя строками в конец:
   ```js
   const STUBS = ['я ещё обрабатываю ваш предыдущий', 'Этот запрос я только что обработал', 'Ошибка запуска агента', 'Ошибка обработки файла', 'Ошибка запуска ассистента', 'Ассистент сейчас обновляется'];
   ```
2. `scripts/synthetic-runner.js` — в `AI_ERROR_MARKERS` после `'Ошибка запуска агента',` добавить:
   ```js
     'Ошибка запуска ассистента',
     'Ассистент сейчас обновляется',
   ```
   ⚠️ synthetic-runner на node-3 живёт вне `deploy.sh` — после мержа его обновляют вручную (отметить в отчёте владельцу).

- [ ] **Step 11: Зелёный прогон и tsc**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat-failure-texts.ts src/chat/chat.service.ts src/chat/chat.controller.ts src/monitoring/product/funnel.service.ts tests/shankara-ayurveda.e2e.mjs scripts/synthetic-runner.js && git commit -q -m "fix(chat): тексты сбоев на языке человека, магазинные — без токенов

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat-failure-texts.spec.ts src/monitoring/product/ src/chat/chat.service.product-actions-attach.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.upload-chat-files.spec.ts src/chat/chat.cost-growth.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: все PASS, `TSC_OK`.

---

### Task 2: Помощник повтора под шлагбаумом

Пункт aa27b1d5. Спек §1.

**Files:**
- Create: `src/chat/relay-drain-retry.ts`
- Create: `src/chat/relay-drain-retry.spec.ts`

- [ ] **Step 1: Красный тест**

Create `src/chat/relay-drain-retry.spec.ts`:

```ts
import { Readable } from 'stream';
import { postRelayWithDrainRetry, RelayDrainingError, isRelayDrainingError, RELAY_DRAIN_DELAYS_MS } from './relay-drain-retry';

const httpErr = (status: number) => {
  const data = Readable.from([]);
  return Object.assign(new Error(String(status)), { response: { status, data } });
};
const codeErr = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe('isRelayDrainingError', () => {
  it.each([[httpErr(502), true], [httpErr(503), true], [codeErr('ECONNREFUSED'), true],
    [httpErr(500), false], [httpErr(504), false], [codeErr('ECONNRESET'), false],
    [codeErr('ECONNABORTED'), false], [new Error('timeout of 300000ms exceeded'), false]])(
    '%s → %s', (err, expected) => expect(isRelayDrainingError(err)).toBe(expected));
});

describe('postRelayWithDrainRetry', () => {
  it('502, 503 и ECONNREFUSED повторяются по расписанию задержек, затем успех', async () => {
    const errs = [httpErr(503), httpErr(502), codeErr('ECONNREFUSED')];
    const make = jest.fn(async () => { const e = errs.shift(); if (e) throw e; return 'ok'; });
    const slept: number[] = [];
    const retries: [number, number][] = [];
    const r = await postRelayWithDrainRetry(make, {
      delaysMs: [3, 5, 7], sleep: async (ms) => { slept.push(ms); }, onRetry: (n, d) => retries.push([n, d]),
    });
    expect(r).toBe('ok');
    expect(make).toHaveBeenCalledTimes(4);
    expect(retries).toEqual([[1, 3], [2, 5], [3, 7]]);
    expect(slept).toEqual([3, 5, 7]);
  });

  it('задержка дробится на шаги не длиннее секунды', async () => {
    const make = jest.fn().mockRejectedValueOnce(httpErr(503)).mockResolvedValueOnce('ok');
    const slept: number[] = [];
    await postRelayWithDrainRetry(make, { delaysMs: [2500], sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([1000, 1000, 500]);
  });

  it.each([[httpErr(500)], [httpErr(504)], [codeErr('ECONNRESET')], [new Error('timeout of 1ms exceeded')]])(
    '%s бросается сразу, без повтора', async (err) => {
      const make = jest.fn().mockRejectedValue(err);
      await expect(postRelayWithDrainRetry(make, { delaysMs: [1, 1], sleep: noSleep })).rejects.toBe(err);
      expect(make).toHaveBeenCalledTimes(1);
    });

  it('фабрика зовётся на каждой попытке, тело отказа закрывается', async () => {
    const e1 = httpErr(503);
    const destroy = jest.spyOn(e1.response.data, 'destroy');
    const make = jest.fn().mockRejectedValueOnce(e1).mockResolvedValueOnce('ok');
    await postRelayWithDrainRetry(make, { delaysMs: [1], sleep: noSleep });
    expect(make).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalled();
  });

  it('бюджет исчерпан → RelayDrainingError(superseded=false)', async () => {
    const make = jest.fn().mockRejectedValue(httpErr(503));
    const err = await postRelayWithDrainRetry(make, { delaysMs: [1, 1], sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    expect(err.attempts).toBe(3);
    expect(make).toHaveBeenCalledTimes(3);
  });

  it('shouldStop во время ожидания → superseded не позже чем через секунду', async () => {
    let stop = false;
    let steps = 0;
    const make = jest.fn().mockRejectedValue(httpErr(503));
    const err = await postRelayWithDrainRetry(make, {
      delaysMs: [30000], shouldStop: () => stop,
      sleep: async () => { steps++; if (steps === 2) stop = true; },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
    expect(steps).toBe(2);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('первая попытка не спрашивает shouldStop', async () => {
    const make = jest.fn().mockResolvedValue('ok');
    await expect(postRelayWithDrainRetry(make, { shouldStop: () => true })).resolves.toBe('ok');
  });

  it('боевое расписание укладывается в ~2.5 минуты', () => {
    const total = RELAY_DRAIN_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(120_000);
    expect(total).toBeLessThanOrEqual(180_000);
  });
});
```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/relay-drain-retry.spec.ts && git commit -q -m "test(chat): повтор POST /chat под шлагбаумом выката — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/relay-drain-retry.spec.ts 2>&1 | tail -15"
```
Expected: FAIL — `Cannot find module './relay-drain-retry'`.

- [ ] **Step 3: Реализация**

Create `src/chat/relay-drain-retry.ts`:

```ts
/**
 * Повтор POST /chat к релею, пока тот за шлагбаумом выката.
 *
 * Откуда («Затыки недели» 16.11.2026, пункт aa27b1d5): deploy-relay.sh ставит
 * маркер, после которого релей отвечает 503 на новые ходы, а на время рестарта
 * nginx отдаёт 502. Бэк на этом падал: человек получал пустой ответ, рутина —
 * терялась. Теперь все пять мест вызова (веб, загрузка, agentReply, clean-ask,
 * блог) идут через этот помощник.
 *
 * Повторяем ТОЛЬКО 502, 503 и ECONNREFUSED: в этих случаях релей ход точно не
 * начинал. ECONNRESET, 504, 500 и таймаут — нет: ход мог начаться и списаться.
 *
 * Форма multipart — поток, второй раз её не отправить, поэтому на вход —
 * фабрика запроса, а не готовый запрос. Ожидание дробится на шаги по секунде:
 * если за это время пришло новое сообщение той же сессии (shouldStop), ход
 * сдаётся как перебитый (superseded), а не висит до конца бюджета.
 */
export const RELAY_DRAIN_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000];

export class RelayDrainingError extends Error {
  constructor(public readonly superseded: boolean, public readonly attempts: number) {
    super(superseded ? 'relay draining: superseded' : 'relay draining: budget exhausted');
    this.name = 'RelayDrainingError';
  }
}

export function isRelayDrainingError(err: any): boolean {
  const status = err?.response?.status;
  return status === 502 || status === 503 || err?.code === 'ECONNREFUSED';
}

export interface DrainRetryOpts {
  /** true — ход перебит новым сообщением той же сессии: сдаться. */
  shouldStop?: () => boolean;
  /** Перед каждым ожиданием: номер повтора (с 1) и задержка. */
  onRetry?: (attempt: number, delayMs: number) => void;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Отказ при responseType: 'stream' держит открытое тело — закрываем, чтобы
// не копить сокеты на каждом повторе.
function closeBody(err: any) {
  const d = err?.response?.data;
  if (d && typeof d.destroy === 'function') { try { d.destroy(); } catch {} }
}

export async function postRelayWithDrainRetry<T>(makePost: () => Promise<T>, opts: DrainRetryOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? RELAY_DRAIN_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && opts.shouldStop?.()) throw new RelayDrainingError(true, attempt);
    try {
      return await makePost();
    } catch (err) {
      if (!isRelayDrainingError(err)) throw err;
      closeBody(err);
      if (attempt >= delays.length) throw new RelayDrainingError(false, attempt + 1);
      const delay = delays[attempt];
      opts.onRetry?.(attempt + 1, delay);
      for (let waited = 0; waited < delay; ) {
        const step = Math.min(1000, delay - waited);
        await sleep(step);
        waited += step;
        if (opts.shouldStop?.()) throw new RelayDrainingError(true, attempt + 1);
      }
    }
  }
}
```

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/relay-drain-retry.ts && git commit -q -m "feat(chat): postRelayWithDrainRetry — повтор POST /chat на 502/503/ECONNREFUSED

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/relay-drain-retry.spec.ts 2>&1 | tail -15"
```
Expected: PASS.

---

### Task 3: Ход, ждущий релей, — не «прерван»

Пункт aa27b1d5. Спек §1.

**Files:**
- Modify: `src/chat/interrupted-turn.ts`
- Modify: `src/chat/interrupted-turn.spec.ts`
- Modify: `src/chat/chat.service.ts` (импорт в строке 21, комментарий у `relayRunning` ~447–479, новые члены класса сразу после `private readonly relayRunning = new Map<string, number>();`)
- Create: `src/chat/chat.relay-waiting.spec.ts`

Смысл: ход, который ждёт релей за шлагбаумом выката, ещё не дошёл до модели. Если в это время придёт следующее сообщение той же сессии, оно перебьёт ждущий ход (метка `relayRunning` уйдёт новому ходу), но скажет модели не «тот ход прерван», а «предыдущее сообщение до тебя не дошло — вот оно» и понесёт его текст и имена файлов.

- [ ] **Step 1: Красный тест**

1. В `src/chat/interrupted-turn.spec.ts` импорт `import { INTERRUPTED_TURN_NOTE } from './interrupted-turn';` заменить на
   ```ts
   import { INTERRUPTED_TURN_NOTE, relayUndeliveredNote } from './interrupted-turn';
   ```
   и дописать в конец файла:
   ```ts
   describe('relayUndeliveredNote', () => {
     const carry = { message: 'посчитай смету', files: ['смета.xlsx', 'фото.jpg'] };

     it('говорит, что сообщение не дошло из-за обновления платформы', () => {
       const n = relayUndeliveredNote(carry);
       expect(n).toContain('не дошло');
       expect(n).toContain('платформа обновлялась');
     });

     it('цитирует текст недошедшего сообщения', () => {
       expect(relayUndeliveredNote(carry)).toContain('«посчитай смету»');
     });

     it('пустой или пробельный текст — без «Вот оно»', () => {
       expect(relayUndeliveredNote({ message: '', files: ['a.pdf'] })).not.toContain('Вот оно');
       expect(relayUndeliveredNote({ message: '  \n ', files: ['a.pdf'] })).not.toContain('Вот оно');
     });

     it('файлы перечисляются и просятся заново только когда они были', () => {
       const withFiles = relayUndeliveredNote(carry);
       expect(withFiles).toContain('смета.xlsx, фото.jpg');
       expect(withFiles).toContain('прислать их ещё раз');
       const noFiles = relayUndeliveredNote({ message: 'привет', files: [] });
       expect(noFiles).not.toContain('прислать их ещё раз');
       expect(noFiles).not.toContain('приложены');
     });

     it('не говорит «тот ход прерван» — ход не прерван, а не начинался', () => {
       expect(relayUndeliveredNote(carry)).not.toContain('тот ход прерван');
     });
   });
   ```

2. Create `src/chat/chat.relay-waiting.spec.ts`:
   ```ts
   import { Readable } from 'stream';
   import { ChatService } from './chat.service';
   import { INTERRUPTED_TURN_NOTE, relayUndeliveredNote } from './interrupted-turn';
   import { RelayDrainingError } from './relay-drain-retry';

   jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

   /**
    * Пункт aa27b1d5: ход, который ждёт релей за шлагбаумом выката, не прерван —
    * его сообщение до модели ещё не дошло. Следующее сообщение той же сессии
    * говорит модели «не дошло» и несёт текст ждущего, а не «тот ход прерван».
    * Здесь — сами примитивы; проводка веба и загрузки — chat.relay-drain.spec.ts.
    */

   const SID = 'u1_7_ru';

   function makeService() {
     const pg = { query: jest.fn(async () => ({ rows: [] })) };
     const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
     return new ChatService(
       pg as any, null as any, null as any, null as any, language as any,
       undefined, undefined, undefined, undefined,
     );
   }

   const note = (svc: ChatService) => (svc as any).relayPendingNote(SID) as string;
   const err503 = () => Object.assign(new Error('503'), { response: { status: 503, data: Readable.from([]) } });
   const carry = { message: 'первое', files: ['a.pdf'] };

   describe('ожидание релея за шлагбаумом', () => {
     it('свободная сессия — без заметки', () => {
       expect(note(makeService())).toBe('');
     });

     it('идущий ход — «тот ход прерван»', () => {
       const svc = makeService();
       svc.beginRelayRun(SID);
       expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);
     });

     it('ждущий ход — заметка о недошедшем с его текстом и файлами', () => {
       const svc = makeService();
       const mark = svc.beginRelayRun(SID);
       svc.markRelayWaiting(SID, mark, carry);
       expect(note(svc)).toBe(relayUndeliveredNote(carry));
       expect(svc.relayCarryNote(SID)).toBe(relayUndeliveredNote(carry));
       expect(svc.relayCarryFor(SID, { message: 'второе', files: ['b.png'] }))
         .toEqual({ message: 'первое\n\nвторое', files: ['a.pdf', 'b.png'] });
     });

     it('ждущий фоновый ход (carry = null) — без заметки, своё сообщение как есть', () => {
       const svc = makeService();
       const mark = svc.beginRelayRun(SID);
       svc.markRelayWaiting(SID, mark, null);
       expect(note(svc)).toBe('');
       expect(svc.relayCarryNote(SID)).toBe('');
       const own = { message: 'второе', files: [] };
       expect(svc.relayCarryFor(SID, own)).toBe(own);
     });

     it('устаревшая метка ожидания — ход уже другой, снова «прерван»', () => {
       const svc = makeService();
       const mark = svc.beginRelayRun(SID);
       svc.markRelayWaiting(SID, mark, carry);
       svc.beginRelayRun(SID);
       expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);
       expect(svc.relayCarryNote(SID)).toBe('');
     });

     it('clearRelayWaiting с чужой меткой ничего не снимает', () => {
       const svc = makeService();
       const mark = svc.beginRelayRun(SID);
       svc.markRelayWaiting(SID, mark, carry);
       svc.clearRelayWaiting(SID, mark + 1000);
       expect(note(svc)).toBe(relayUndeliveredNote(carry));
     });

     it('postRelayTurn снимает ожидание и при успехе, и при исчерпанном бюджете', async () => {
       const svc = makeService();
       svc.relayDrainDelaysMs = [0];
       const mark = svc.beginRelayRun(SID);

       const ok = jest.fn().mockRejectedValueOnce(err503()).mockResolvedValueOnce('ok');
       await expect(svc.postRelayTurn(SID, mark, carry, ok)).resolves.toBe('ok');
       expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);

       const bad = jest.fn(async () => { throw err503(); });
       await expect(svc.postRelayTurn(SID, mark, carry, bad)).rejects.toBeInstanceOf(RelayDrainingError);
       expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);
     });

     it('ожидание ставится только на повторе: первая попытка — ход идёт', async () => {
       const svc = makeService();
       svc.relayDrainDelaysMs = [0];
       const mark = svc.beginRelayRun(SID);
       const seen: string[] = [];
       let calls = 0;
       await svc.postRelayTurn(SID, mark, carry, async () => {
         seen.push(note(svc));
         if (++calls === 1) throw err503();
         return 'ok';
       });
       expect(seen).toEqual([INTERRUPTED_TURN_NOTE, relayUndeliveredNote(carry)]);
     });

     it('новое сообщение во время ожидания — ход сдаётся как перебитый', async () => {
       const svc = makeService();
       let wake: () => void = () => {};
       svc.relayDrainDelaysMs = [1000];
       svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });
       const mark = svc.beginRelayRun(SID);
       const post = jest.fn(async () => { throw err503(); });

       const p = svc.postRelayTurn(SID, mark, carry, post).catch((e) => e);
       for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
       svc.beginRelayRun(SID);
       wake();

       const err = await p;
       expect(err).toBeInstanceOf(RelayDrainingError);
       expect(err.superseded).toBe(true);
       expect(post).toHaveBeenCalledTimes(1);
     });
   });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/interrupted-turn.spec.ts src/chat/chat.relay-waiting.spec.ts && git commit -q -m "test(chat): ход, ждущий релей, — «не дошло», а не «прерван» — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/interrupted-turn.spec.ts src/chat/chat.relay-waiting.spec.ts 2>&1 | tail -15"
```
Expected: FAIL — `relayUndeliveredNote is not a function`, `svc.markRelayWaiting is not a function`.

- [ ] **Step 3: Реализация**

1. `src/chat/interrupted-turn.ts` — в doc-комментарии абзац, который начинается со «Строку получает только ТЕКСТОВЫЙ ход — у него одного есть эта проверка.» и кончается «…заводить её ради симметрии незачем.», заменить целиком на:
   ```
    * Строку получает только ТЕКСТОВЫЙ ход. Загрузка файла, пришедшая посреди
    * текстового хода, прерывает его на релее точно так же (общий relaySid), но
    * «тот ход прерван» не получает — у ChatController.uploadAndChat этой
    * проверки нет. Зато оба пути получают relayUndeliveredNote, если предыдущий
    * ход той же сессии не прерван, а ЖДЁТ релей за шлагбаумом выката
    * (relay-drain-retry.ts): его сообщение до модели ещё не дошло, и новое
    * сообщение несёт его с собой (с 16.11.2026, пункт aa27b1d5).
   ```
   Дописать в конец файла:
   ```ts
   /** Недошедшее сообщение человека: текст и имена приложенных файлов. */
   export interface RelayCarry {
     message: string;
     files: string[];
   }

   /**
    * Служебная строка для модели: прошлое сообщение человека не дошло — ход
    * ждал релей за шлагбаумом выката, и его перебило это сообщение. Файлы
    * повторно не отправляются (их байты остались в том запросе) — модель
    * просит прислать их ещё раз.
    */
   export function relayUndeliveredNote(carry: RelayCarry): string {
     const parts = ['[Служебно: предыдущее сообщение человека до тебя не дошло — платформа обновлялась.'];
     const text = carry.message.trim();
     if (text) parts.push(`Вот оно: «${text}».`);
     if (carry.files.length) {
       parts.push(`К нему были приложены файлы: ${carry.files.join(', ')} — до тебя они не дошли; попроси человека прислать их ещё раз.`);
     }
     parts.push('Ответь с учётом обоих сообщений.]');
     return parts.join(' ');
   }
   ```

2. `src/chat/chat.service.ts`, строка 21: `import { INTERRUPTED_TURN_NOTE } from './interrupted-turn';` заменить на
   ```ts
   import { INTERRUPTED_TURN_NOTE, relayUndeliveredNote, RelayCarry } from './interrupted-turn';
   import { postRelayWithDrainRetry, RELAY_DRAIN_DELAYS_MS, DrainRetryOpts } from './relay-drain-retry';
   ```

3. Там же в комментарии над `private readonly relayRunning = new Map<string, number>();` абзац, который начинается со «Слепая зона:» (про agentReply без своей метки — устарел: с 05.11 agentReply зовёт `beginRelayRun`), заменить целиком на:
   ```
    * Фоновые ходы. agentReply (рутины, «Путь», план действий, итоги звонков,
    * проба качества) пишет в ТУ ЖЕ сессию релея, что и обычный чат. С 05.11
    * ход основной сессии берёт здесь свою метку и отказывается от занятой
    * сессии (RelaySessionBusyError) — так он не перебивает человека. Ход,
    * который ждёт релей за шлагбаумом выката (relay-drain-retry.ts), метку
    * сохраняет: следующее сообщение по-прежнему перебивает его, но вместо
    * «тот ход прерван» получает relayUndeliveredNote с текстом и файлами
    * ждущего — см. relayWaiting ниже. Фоновый ждущий ход (carry = null)
    * заметки не даёт: его промпт человек не писал.
   ```

4. Сразу после строки `private readonly relayRunning = new Map<string, number>();` вставить:
   ```ts

     /**
      * Ход, который ждёт релей за шлагбаумом выката (relay-drain-retry.ts), — по
      * relaySid, с меткой того же хода, что в relayRunning. Ставится только в
      * onRetry, то есть после первого 502/503: пока идёт первая попытка и пока
      * читается поток, ход считается идущим, и следующее сообщение получает
      * «тот ход прерван». carry — текст и имена файлов ждущего хода человека;
      * у фонового хода (agentReply) — null: его промпт человек не писал.
      * Снимается в finally postRelayTurn — и при успехе, и при отказе.
      */
     private readonly relayWaiting = new Map<string, { mark: number; carry: RelayCarry | null }>();
     /** Расписание повторов под шлагбаумом; тесты подменяют. */
     relayDrainDelaysMs: readonly number[] = RELAY_DRAIN_DELAYS_MS;
     relayDrainSleep: ((ms: number) => Promise<void>) | undefined = undefined;

     markRelayWaiting(relaySid: string, mark: number, carry: RelayCarry | null): void {
       this.relayWaiting.set(relaySid, { mark, carry });
     }

     clearRelayWaiting(relaySid: string, mark: number): void {
       if (this.relayWaiting.get(relaySid)?.mark === mark) this.relayWaiting.delete(relaySid);
     }

     /**
      * POST /chat к релею с повтором под шлагбаумом. Ход сдаётся как перебитый
      * (RelayDrainingError.superseded), как только метку его сессии забрал новый
      * ход — тот уже несёт его сообщение (relayCarryFor).
      */
     async postRelayTurn<T>(
       relaySid: string,
       mark: number,
       carry: RelayCarry | null,
       makePost: () => Promise<T>,
     ): Promise<T> {
       const opts: DrainRetryOpts = {
         delaysMs: this.relayDrainDelaysMs,
         sleep: this.relayDrainSleep,
         shouldStop: () => this.relayRunning.get(relaySid) !== mark,
         onRetry: (attempt, delayMs) => {
           this.markRelayWaiting(relaySid, mark, carry);
           // Без relaySid: в ключе сессии номер телефона (журналы — без номеров).
           this.logger.warn(`релей обновляется (502/503) — повтор ${attempt} через ${delayMs} мс`);
         },
       };
       try {
         return await postRelayWithDrainRetry(makePost, opts);
       } finally {
         this.clearRelayWaiting(relaySid, mark);
       }
     }

     /** carry ждущего хода — только если ждёт именно текущий ход сессии. */
     private waitingCarry(relaySid: string): RelayCarry | null {
       const w = this.relayWaiting.get(relaySid);
       return w && w.mark === this.relayRunning.get(relaySid) ? w.carry : null;
     }

     /** Своё сообщение хода плюс недошедшее ждущего — то, что новый ход несёт с собой. */
     relayCarryFor(relaySid: string, own: RelayCarry): RelayCarry {
       const c = this.waitingCarry(relaySid);
       if (!c) return own;
       return {
         message: [c.message, own.message].filter(Boolean).join('\n\n'),
         files: [...c.files, ...own.files],
       };
     }

     /** Заметка о недошедшем сообщении для загрузки (у неё нет «тот ход прерван»). */
     relayCarryNote(relaySid: string): string {
       const c = this.waitingCarry(relaySid);
       return c ? relayUndeliveredNote(c) : '';
     }

     /** Заметка текстовому ходу: «тот ход прерван», «не дошло» или ничего. */
     private relayPendingNote(relaySid: string): string {
       const running = this.relayRunning.get(relaySid);
       if (running === undefined) return '';
       const w = this.relayWaiting.get(relaySid);
       if (w && w.mark === running) return w.carry ? relayUndeliveredNote(w.carry) : '';
       return INTERRUPTED_TURN_NOTE;
     }
   ```
   Логгер в классе — `this.logger` (уже есть). `relayDrainSleep = undefined` значит «настоящий setTimeout» (`defaultSleep` в relay-drain-retry.ts).

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/interrupted-turn.ts src/chat/chat.service.ts && git commit -q -m "feat(chat): учёт хода, ждущего релей за шлагбаумом выката

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/interrupted-turn.spec.ts src/chat/chat.relay-waiting.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.service.turn-marks.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`. Члены пока никем не вызываются — проводка в задачах 4–6.

---

### Task 4: Веб-ход ждёт релей, а не падает

Пункт aa27b1d5. Спек §1.

**Files:**
- Modify: `src/chat/chat.service.ts` (`streamUniversalAgent`)
- Create: `src/chat/chat.relay-drain.spec.ts`

Что меняется для человека: во время выката релея (шлагбаум отвечает 503, nginx при рестарте — 502) сообщение больше не получает «Ошибку запуска» за доли секунды. Ход тихо повторяет запрос по расписанию `RELAY_DRAIN_DELAYS_MS` (около трёх минут). Не дождался — короткое честное «ассистент обновляется, токены не списаны» на языке человека, ход не тарифицируется и не учит профиль. Пришло новое сообщение, пока ход ждал, — ждущий ход тихо сдаётся, а новое сообщение несёт его текст (задача 3).

- [ ] **Step 1: Красный тест**

Create `src/chat/chat.relay-drain.spec.ts`:

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { chatFailureText } from './chat-failure-texts';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Пункт aa27b1d5: на выкате релей отвечает 502/503 (шлагбаум deploy-relay.sh,
 * nginx при рестарте). Ход ждёт и повторяет (relay-drain-retry.ts), а не падает
 * сразу. Здесь — настоящая проводка: веб-ход (streamUniversalAgent) и загрузка
 * (ChatController.uploadAndChat), та же обвязка, что в chat.relay-running.spec.ts.
 */

const NOTE = 'тот ход прерван';
const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';

function makeServiceWithPgCalls() {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
  return { svc, calls };
}

const queue: (Readable | Error)[] = [];
const post = jest.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('апстрим для этого вызова не подготовлен тестом');
  if (next instanceof Error) throw next;
  return { data: next };
});

beforeEach(() => {
  queue.length = 0;
  post.mockClear();
  (axios as any).default = { post };
  (axios as any).post = post;
});
afterEach(() => jest.useRealTimers());

/** Значение поля multipart-формы, которой ушёл вызов axios.post под номером call. */
function field(call: any[], name: string): string {
  const parts: any[] = (call[1] as any)._streams || [];
  const idx = parts.findIndex((p) => typeof p === 'string' && new RegExp(`name="${name}"`).test(p));
  return String(parts[idx + 1] ?? '');
}
const msg = (i: number) => field(post.mock.calls[i], 'message');
const sid = (i: number) => field(post.mock.calls[i], 'sessionId');

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const err503 = () => Object.assign(new Error('Request failed with status code 503'), {
  response: { status: 503, data: Readable.from([]) },
});
const stream = () => new Readable({ read() {} });

/** Строки NDJSON, ушедшие клиенту. */
function writes(res: any): any[] {
  const out: any[] = [];
  for (const c of res.write.mock.calls) {
    for (const line of String(c[0]).split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* не JSON — не наше */ }
    }
  }
  return out;
}
const ends = (res: any) => writes(res).filter((w) => w.type === 'end');
const items = (res: any) => writes(res).filter((w) => w.type === 'item').map((w) => w.content);

function newRes(): any {
  return {
    status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
    end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
  };
}

function turn(svc: ChatService, message: string, upstreams: (Readable | Error)[], lang?: string) {
  queue.push(...upstreams);
  const res = newRes();
  const done = (svc as any).streamUniversalAgent(
    'u1', message, '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined, lang,
  );
  return { done, res };
}

const tokenInserts = (calls: { sql: string }[]) => calls.filter((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
const savedStrings = (calls: { params: any[] }[]) => calls.flatMap((c) => c.params).filter((p) => typeof p === 'string');

describe('веб-ход под шлагбаумом выката релея', () => {
  it('W1: 503, потом поток — ответ доходит, ход тарифицируется как обычный', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const up = stream();
    const t = turn(svc, 'привет', [err503(), up]);
    await settle();
    up.push(DELTA); up.push(DONE); up.push(null);
    await t.done;
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(sid(1)).toBe(sid(0));
    expect(ends(t.res)[0].content).toContain('ответ');
    expect(tokenInserts(calls).length).toBe(1);
  });

  it('W2: бюджет исчерпан — заглушка «обновляется» на языке человека, без списания', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const track = jest.fn();
    (svc as any).events = { track };
    const t = turn(svc, 'hello', [err503(), err503()], 'en');
    await t.done;
    await settle();

    const stub = chatFailureText('relayUpdating', 'en');
    expect(items(t.res)).toEqual([stub]);
    expect(ends(t.res)).toEqual([expect.objectContaining({ type: 'end', content: stub, reason: 'relay_draining' })]);
    expect(track).toHaveBeenCalledWith('chat_quality', expect.objectContaining({
      props: expect.objectContaining({ failed: true, fail_reason: 'relay_draining' }),
    }));
    expect(tokenInserts(calls)).toEqual([]);
    expect(savedStrings(calls)).toContain(stub);
  });

  it('W3: новое сообщение, пока ход ждёт, — несёт его текст, ждущий сдаётся молча', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    let wake: () => void = () => {};
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });

    const a = turn(svc, 'первое', [err503()]);
    await settle();
    const upB = stream();
    const b = turn(svc, 'второе', [upB]);
    upB.push(DELTA);
    await settle();

    expect(msg(1)).toContain('не дошло');
    expect(msg(1)).toContain('первое');
    expect(msg(1)).toContain('второе');
    expect(msg(1)).not.toContain(NOTE);
    expect(sid(1)).toBe(sid(0));

    wake();
    await a.done;
    await settle();
    expect(ends(a.res)).toEqual([expect.objectContaining({ type: 'end', content: '' })]);
    expect(items(a.res)).toEqual([]);

    upB.push(DONE); upB.push(null);
    await b.done;
    await settle();
    const saved = savedStrings(calls).join('\n');
    expect(saved).not.toContain('обновляется');
    expect(saved).not.toContain('Ответ не пришёл');
  });

  it('W4: повтор self-heal тоже ждёт релей, а не глотает 503', async () => {
    // setImmediate/nextTick настоящие — см. T2 в chat.relay-running.spec.ts.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const { svc } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const empty = stream();
    const retry = stream();
    const t = turn(svc, 'привет', [empty, err503(), retry]);
    await settle();
    empty.push(null); // пустой поток — self-heal ждёт 800 мс и повторяет
    await settle();
    jest.advanceTimersByTime(800);
    await settle();

    expect(post).toHaveBeenCalledTimes(3);
    retry.push(DELTA); retry.push(DONE); retry.push(null);
    await t.done;
    expect(ends(t.res)[0].content).toContain('ответ');
  });
});
```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat.relay-drain.spec.ts && git commit -q -m "test(chat): веб-ход под шлагбаумом выката релея — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.relay-drain.spec.ts 2>&1 | tail -20"
```
Expected: FAIL — W1: `post` вызван 1 раз, клиенту ушла заглушка `startFailed`; W2/W3/W4 — нет повтора и заметки.

- [ ] **Step 3: Реализация**

Всё в `src/chat/chat.service.ts`, метод `streamUniversalAgent`.

1. Импорт из задачи 3 `import { postRelayWithDrainRetry, RELAY_DRAIN_DELAYS_MS, DrainRetryOpts } from './relay-drain-retry';` заменить на
   ```ts
   import { postRelayWithDrainRetry, RELAY_DRAIN_DELAYS_MS, DrainRetryOpts, RelayDrainingError } from './relay-drain-retry';
   ```

2. Место заметки (~2019–2035). Комментарий над проверкой оставить, а блок
   ```ts
       if (!probe && this.relayRunning.has(relaySid)) {
         contextPrefix += `${INTERRUPTED_TURN_NOTE}\n\n`;
       }
   ```
   заменить на
   ```ts
       // Если прошлый ход этой сессии не прерван, а ждёт релей за шлагбаумом
       // выката, — вместо «тот ход прерван» заметка о недошедшем
       // (relayUndeliveredNote), и его текст этот ход несёт с собой (relayCarry).
       const pending = probe ? '' : this.relayPendingNote(relaySid);
       if (pending) contextPrefix += `${pending}\n\n`;
       const relayCarry = probe ? null : this.relayCarryFor(relaySid, { message, files: [] });
   ```
   Оба вызова должны стоять ДО `let relayMark = this.beginRelayRun(relaySid);` (они там и стоят: заметка ~2030, метка ~2528). После `beginRelayRun` ждущий ход уже не текущий, и его carry не найдётся. Импорт `INTERRUPTED_TURN_NOTE` остаётся — его использует `relayPendingNote` из задачи 3.

3. После строки `let selfHealSkippedForTakeover = false;` вставить:
   ```ts
       // Заглушка в историю, когда повтор под шлагбаумом исчерпан. В fullText не
       // идёт — ход не тарифицируется и не учит профиль.
       let failureStub = '';
   ```

4. В `persistResponse` (после задачи 1):
   ```ts
         const aiText = fullText
           || (final && !selfHealSkippedForTakeover ? chatFailureText('noReply', userLanguage) : '');
   ```
   заменить на
   ```ts
         const aiText = fullText
           || failureStub
           || (final && !selfHealSkippedForTakeover ? chatFailureText('noReply', userLanguage) : '');
   ```

5. `callUpstreamOnce` (~2371).
   - Сигнатуру `const callUpstreamOnce = async (attempt: { sessionId: string; systemPrompt: string }): Promise<void> => {` заменить на
     ```ts
       const callUpstreamOnce = async (attempt: { sessionId: string; systemPrompt: string }, mark: number): Promise<void> => {
     ```
   - Строку `const tid = await this.taleridAgentFields(userId);` вместе с комментарием над ней и строку `const pf = productsRelayFields(userId, { … });` вместе с комментарием над ней перенести вверх — сразу после `linkeonFields = attemptLinkeonFields;`. Ниже остаются только их `fd.append(...)` (у `tid` — весь `if (tid) { … }`).
   - Всё от `const FormData = require('form-data');` до `appendLinkeonFields(fd, attemptLinkeonFields);` включительно (порядок полей и комментарии не менять) обернуть в фабрику:
     ```ts
         // Форма multipart — поток: второй раз её не отправить, поэтому на каждый
         // повтор под шлагбаумом — новая (relay-drain-retry.ts).
         const buildForm = () => {
           const FormData = require('form-data');
           const fd = new FormData();
           // … все прежние fd.append без изменений …
           appendLinkeonFields(fd, attemptLinkeonFields);
           return fd;
         };
     ```
     Внутри фабрики не должно остаться `await` — поэтому `tid` и `pf` вынесены выше.
   - Вызов
     ```ts
         const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
           headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
           responseType: 'stream',
           timeout: RELAY_TURN_BUDGET_MS,
           maxRedirects: 0,
         });
     ```
     заменить на
     ```ts
         const agentRes: any = await this.postRelayTurn(attempt.sessionId, mark, relayCarry, () => {
           const fd = buildForm();
           return axios.post(`${AGENT_URL}/chat`, fd, {
             headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
             responseType: 'stream',
             timeout: RELAY_TURN_BUDGET_MS,
             maxRedirects: 0,
           });
         });
     ```
     Метку передаём явно: `relayMark` и `relaySid` — `let`, при смене режима в self-heal они переезжают на новый ключ (см. `runUpstreamAttempt`).

6. В `runUpstreamAttempt` строку `await callUpstreamOnce(attempt);` заменить на
   ```ts
         await callUpstreamOnce(attempt, relayMark);
   ```
   В self-heal строку
   ```ts
             try { await runUpstreamAttempt(true); } catch (e: any) { this.logger.warn(`self-heal retry failed: ${e.message}`); }
   ```
   заменить на
   ```ts
             try {
               await runUpstreamAttempt(true);
             } catch (e: any) {
               // Шлагбаум выката — не «повтор не удался»: исход решает главный catch.
               if (e instanceof RelayDrainingError) throw e;
               this.logger.warn(`self-heal retry failed: ${e.message}`);
             }
   ```

7. Главный `catch (err)` хода (~2865). После задачи 1 там стоит:
   ```ts
         // Try to write error to response; safeWrite is a no-op if client gone.
         const errText = chatFailureText('startFailed', userLanguage);
         safeWrite({ type: 'item', content: errText });
         safeWrite({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } });
   ```
   Заменить эти четыре строки на:
   ```ts
         // Try to write error to response; safeWrite is a no-op if client gone.
         if (err instanceof RelayDrainingError && err.superseded) {
           // Ход ждал релей за шлагбаумом, и его перебило новое сообщение: оно
           // уже несёт текст этого хода (relayCarryFor). Тихий конец — без
           // заглушки и без строки ассистента в истории.
           turnFailed = true;
           failReason = 'preempted';
           selfHealSkippedForTakeover = true;
           safeWrite({ type: 'end', content: '', usage: { input: 0, output: 0, total: 0 } });
         } else if (err instanceof RelayDrainingError) {
           // Релей обновлялся дольше бюджета повтора. Токены не списаны —
           // turnFailed, а заглушка не в fullText.
           turnFailed = true;
           failReason = 'relay_draining';
           failureStub = chatFailureText('relayUpdating', userLanguage, { storeBuild });
           safeWrite({ type: 'item', content: failureStub });
           safeWrite({
             type: 'end', content: failureStub, reason: 'relay_draining', usage: { input: 0, output: 0, total: 0 },
           });
         } else {
           const errText = chatFailureText('startFailed', userLanguage);
           safeWrite({ type: 'item', content: errText });
           safeWrite({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } });
         }
   ```
   `res.end()` и `setImmediate(() => { void persistResponse(true); })` ниже остаются как были. Почему это верно:
   - перебитый: `fullText` и `failureStub` пусты, `selfHealSkippedForTakeover` — `aiText` пуст, `persistResponse` выходит на `if (!aiText) return;`. Строка человека уже сохранена раньше (`saveUserMessageRow`), её текст несёт следующий ход;
   - исчерпанный: `aiText = failureStub` ложится в историю, `textCost = 0` (`turnFailed`). Списание, consolidate, задачи и businessProfile стоят под `if (fullText.length > 0)` — пустой `fullText` их не запускает. `chat_quality` получит `failed: true, fail_reason: 'relay_draining'`.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat.service.ts && git commit -q -m "feat(chat): веб-ход ждёт релей на выкате вместо «Ошибки запуска»

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.relay-drain.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.relay-waiting.spec.ts src/chat/chat.service.turn-marks.spec.ts src/chat/chat.service.upstream-error-billing.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 5: Загрузка файла ждёт релей

Пункт aa27b1d5. Спек §1.

**Files:**
- Modify: `src/chat/chat.controller.ts` (`uploadAndChat`)
- Modify: `src/chat/chat.relay-drain.spec.ts`

⚠️ Перед задачей — правило 12: параллельные сессии (upload-media-memory, chat-files) правят `uploadAndChat`.
```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git fetch -q origin && git log --oneline 949e81fd..origin/main -- src/chat/chat.controller.ts src/chat/chat.service.ts
```
Если вывод не пуст — `git merge origin/main` (не rebase), прогнать задачи 1–4 заново и только потом продолжать. Номера строк ниже — по 949e81fd.

- [ ] **Step 1: Красный тест**

В `src/chat/chat.relay-drain.spec.ts` после функции `turn` добавить:
```ts
function uploadTurnWith(svc: ChatService, upstreams: (Readable | Error)[], bodyExtra: Record<string, any> = {}) {
  queue.push(...upstreams);
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
  const req = {
    headers: { authorization: 'Bearer t' },
    files: [{ originalname: 'a.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
    body: { message: 'смотри файл', assistantId: '7', ...bodyExtra },
  } as any;
  const res = newRes();
  const done = ctrl.uploadAndChat(req, res);
  return { done, res };
}
```
и в конец файла:
```ts
describe('загрузка файла под шлагбаумом выката релея', () => {
  it('U-W1: бюджет исчерпан — заглушка про сообщение и файлы на языке человека', async () => {
    const { svc } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const u = uploadTurnWith(svc, [err503(), err503()], { lang: 'de' });
    await u.done;
    await settle();

    const stub = chatFailureText('relayUpdating', 'de', { upload: true });
    expect(items(u.res)).toEqual([stub]);
    expect(ends(u.res)).toEqual([expect.objectContaining({
      type: 'end', content: stub, reason: 'relay_draining', usage: { input: 0, output: 0, total: 0 },
    })]);
  });

  it('U-W2: загрузка ждёт — текстовый ход несёт её текст и просит файлы заново', async () => {
    const { svc } = makeServiceWithPgCalls();
    let wake: () => void = () => {};
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });

    const u = uploadTurnWith(svc, [err503()]);
    await settle();
    const upT = stream();
    const t = turn(svc, 'ну что там?', [upT]);
    upT.push(DELTA);
    await settle();

    expect(msg(1)).toContain('a.pdf');
    expect(msg(1)).toContain('прислать их ещё раз');
    expect(msg(1)).toContain('смотри файл');
    expect(msg(1)).not.toContain(NOTE);

    wake();
    await u.done;
    await settle();
    expect(ends(u.res)).toEqual([expect.objectContaining({ type: 'end', content: '' })]);
    expect(items(u.res)).toEqual([]);

    upT.push(DONE); upT.push(null);
    await t.done;
  });

  it('U-W3: текстовый ход ждёт — загрузка несёт его текст', async () => {
    const { svc } = makeServiceWithPgCalls();
    let wake: () => void = () => {};
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });

    const a = turn(svc, 'первое', [err503()]);
    await settle();
    const upU = stream();
    const u = uploadTurnWith(svc, [upU]);
    await settle();

    expect(msg(1)).toContain('не дошло');
    expect(msg(1)).toContain('первое');
    expect(msg(1)).toContain('смотри файл');
    expect(sid(1)).toBe(sid(0));

    wake();
    await a.done;
    upU.push(DELTA); upU.push(DONE); upU.push(null);
    await u.done;
    await settle();
    expect(ends(a.res)).toEqual([expect.objectContaining({ type: 'end', content: '' })]);
  });
});
```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat.relay-drain.spec.ts && git commit -q -m "test(chat): загрузка файла под шлагбаумом выката релея — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.relay-drain.spec.ts 2>&1 | tail -20"
```
Expected: FAIL — U-W1 получает заглушку `fileFailed` без `reason`, U-W2/U-W3 — нет повтора и заметки. W1–W4 зелёные.

- [ ] **Step 3: Реализация**

Всё в `src/chat/chat.controller.ts`, метод `uploadAndChat`.

1. Импорт рядом с остальными из `./`:
   ```ts
   import { RelayDrainingError } from './relay-drain-retry';
   ```

2. Блок
   ```ts
       const fullMessage = [handoff.uploadContext, message || 'Проанализируй этот файл']
         .filter(Boolean)
         .join('\n\n');
   ```
   (~396) удалить, а комментарий над ним («Профиль уехал в systemPrompt…») перенести вместе с новой сборкой — сразу после строки `handoff = await this.chatService.finalizeUploadHandoffForDispatch(userId, handoff);`:
   ```ts
       // Профиль уехал в systemPrompt вместе с персоной — в тело реплики его
       // больше не клеим: там он оседал копией на каждый ход с файлом. Память
       // прошлых загрузок сессии (uploadContext) — наоборот, в теле: подписанные
       // ссылки пер-ходовые, в кэшируемом systemPrompt им места нет.
       //
       // Если прошлый ход этой сессии ждёт релей за шлагбаумом выката, его текст
       // идёт первым (relayCarryNote), а этот ход несёт его дальше (relayCarry).
       // Оба — до beginRelayRun ниже: после него ждущий ход уже не текущий.
       const carryNote = this.chatService.relayCarryNote(handoff.sessionId);
       const relayCarry = this.chatService.relayCarryFor(handoff.sessionId, {
         message,
         files: files.map((f: any) => f.originalname),
       });
       const fullMessage = [carryNote, handoff.uploadContext, message || 'Проанализируй этот файл']
         .filter(Boolean)
         .join('\n\n');
   ```

3. Сборка формы (~433). Строки `const FormData = require('form-data');` и `const axios = require('axios');` оставить, а всё от `const fd = new FormData();` до `for (const [k, v] of Object.entries(relayProviderFields(false, answerRoute.provider))) fd.append(k, v);` включительно (комментарии и порядок не менять) обернуть:
   ```ts
       // Форма multipart — поток: на каждый повтор под шлагбаумом — новая
       // (relay-drain-retry.ts). Буферы файлов в памяти, повтор их не теряет,
       // но заливает заново: nginx релея по умолчанию принимает тело целиком до
       // проксирования, так что каждый повтор — снова весь объём файлов, а
       // буферы держатся в памяти, пока ход ждёт (до ~150 с).
       const buildForm = () => {
         const fd = new FormData();
         // … все прежние fd.append без изменений …
         for (const [k, v] of Object.entries(relayProviderFields(false, answerRoute.provider))) fd.append(k, v);
         return fd;
       };
   ```

4. После `let failReason = '';` (~476) вставить:
   ```ts
       // Исход ожидания релея за шлагбаумом выката: перебит новым сообщением
       // той же сессии или бюджет повтора исчерпан (relay-drain-retry.ts).
       let drainOutcome: 'superseded' | 'exhausted' | null = null;
   ```

5. Вызов
   ```ts
         const agentRes = await axios.default.post(`${AGENT_URL}/chat`, fd, {
           headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
           responseType: 'stream',
           timeout: 600000,
           maxRedirects: 0,
         });
   ```
   заменить на
   ```ts
         const agentRes: any = await this.chatService.postRelayTurn(handoff.sessionId, relayMark, relayCarry, () => {
           const fd = buildForm();
           return axios.default.post(`${AGENT_URL}/chat`, fd, {
             headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
             responseType: 'stream',
             timeout: 600000,
             maxRedirects: 0,
           });
         });
   ```

6. Внутренний catch
   ```ts
       } catch (err: any) {
         upstreamError = err;
       } finally {
   ```
   заменить на
   ```ts
       } catch (err: any) {
         if (err instanceof RelayDrainingError) {
           drainOutcome = err.superseded ? 'superseded' : 'exhausted';
           turnFailed = true;
           failReason = err.superseded ? 'preempted' : 'relay_draining';
           if (!err.superseded) {
             // Релей обновлялся дольше бюджета повтора. Заглушка уходит в chunks —
             // и клиенту, и в историю; turnFailed — без списания.
             const stub = chatFailureText('relayUpdating', handoff.userLanguage, { upload: true, storeBuild });
             chunks.push(stub);
             safeWrite({ type: 'item', content: stub });
           }
         } else {
           upstreamError = err;
         }
       } finally {
   ```

7. В finally строку
   ```ts
           safeWrite({ type: 'end', content: fullText, usage: { input: 0, output: shown, total: shown } });
   ```
   заменить на
   ```ts
           safeWrite({
             type: 'end',
             content: fullText,
             ...(drainOutcome === 'exhausted' ? { reason: 'relay_draining' } : {}),
             usage: { input: 0, output: shown, total: shown },
           });
   ```
   и после ветки `} else if (upstreamError) { … }` (заглушка `fileFailed` из задачи 1) дописать:
   ```ts
         } else if (drainOutcome === 'superseded') {
           // Ждал релей, и его перебило новое сообщение — оно несёт текст и имена
           // файлов этого хода. Тихий конец, без заглушки.
           safeWrite({ type: 'end', content: '', usage: { input: 0, output: 0, total: 0 } });
         }
   ```
   (закрывающая скобка `}` прежней ветки `upstreamError` переходит в `} else if`).

8. В персисте условие `if (fullText.length > 0) {` перед `consolidateAfterChatPublic` заменить на
   ```ts
               if (fullText.length > 0 && !drainOutcome) {
   ```
   — заглушка «обновляется» не материал для профиля. `persistUploadTurn` получает `turnFailed` и сам не списывает.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat.controller.ts && git commit -q -m "feat(chat): загрузка файла ждёт релей на выкате

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.relay-drain.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.upload-chat-files.spec.ts src/chat/chat.relay-waiting.spec.ts 2>&1 | tail -15 && npx jest src/chat/ -t 'upload' 2>&1 | tail -8 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 6: Фоновые ходы и их потребители

Пункт aa27b1d5. Спек §1 (agentReply).

**Files:**
- Modify: `src/chat/chat.service.ts` (`agentReply`)
- Modify: `src/chat/chat.service.routine-turns.spec.ts`
- Modify: `src/routine-push/routine-push.service.ts`
- Modify: `src/routine-push/routine-push.controller.ts:69`
- Modify: `src/routine-push/routine-push.busy-retry.spec.ts`
- Modify: `src/trip/trip.service.ts:400`
- Modify: `src/trip/trip.service.spec.ts`

Смысл: рутины, «Путь», план действий и итоги звонков на выкате тоже ждут релей. Если человек написал, пока фоновый ход ждал, — фоновый уступает (как при занятой сессии: `RelaySessionBusyError`), а человеку заметка не нужна: промпт фонового хода он не писал. Исчерпан бюджет — рутина откладывается так же, как при занятой сессии, а не теряется на день.

- [ ] **Step 1: Красный тест**

1. В `src/chat/chat.service.routine-turns.spec.ts` уже есть `Readable`, `axios` (замокан), `RelaySessionBusyError`, `makeService()` (язык `ru`, ключ сессии `u-1_12_ru`) и `flush(n)`. Добавить в шапку один импорт:
   ```ts
   import { RelayDrainingError } from './relay-drain-retry';
   ```
   и дописать в конец файла:
   ```ts
   describe('фоновый ход под шлагбаумом выката релея', () => {
     const SID = 'u-1_12_ru';
     const err503 = () => Object.assign(new Error('503'), { response: { status: 503, data: Readable.from([]) } });

     beforeEach(() => jest.clearAllMocks());

     it('человек написал, пока фоновый ход ждал, — фоновый уступает как busy, человеку без заметки', async () => {
       const svc = makeService();
       let wake: () => void = () => {};
       svc.relayDrainDelaysMs = [1000];
       svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });
       (axios.post as jest.Mock).mockRejectedValueOnce(err503());

       const p = svc.generateAgentReply('u-1', '12', 'напомни').catch((e) => e);
       await flush(20);
       expect((svc as any).relayPendingNote(SID)).toBe('');

       const humanMark = svc.beginRelayRun(SID);
       wake();
       expect(await p).toBeInstanceOf(RelaySessionBusyError);
       expect(axios.post).toHaveBeenCalledTimes(1);
       svc.endRelayRun(SID, humanMark);
     });

     it('бюджет исчерпан — RelayDrainingError(superseded=false), метка снята', async () => {
       const svc = makeService();
       svc.relayDrainDelaysMs = [0];
       (axios.post as jest.Mock).mockRejectedValueOnce(err503()).mockRejectedValueOnce(err503());

       const err = await svc.generateAgentReply('u-1', '12', 'напомни').catch((e) => e);
       expect(err).toBeInstanceOf(RelayDrainingError);
       expect(err.superseded).toBe(false);
       expect((svc as any).relayRunning.size).toBe(0);
     });
   });
   ```

2. В `src/routine-push/routine-push.busy-retry.spec.ts` импорт дополнить:
   ```ts
   import { RelayDrainingError } from '../chat/relay-drain-retry';
   ```
   и внутри `describe('рутина при занятой сессии человека', …)` перед последним `});` дописать:
   ```ts
     it('релей обновляется дольше бюджета — как busy: retry без history', async () => {
       const chat = jest.fn(async () => { throw new RelayDrainingError(false, 9); });
       const { svc, store } = makeService(chat);

       await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
         .resolves.toEqual({ delivered: 0, draining: true });
       expect(store.releaseToday).not.toHaveBeenCalled();
       expect((svc as any).retryTimers.size).toBe(1);
       expect((svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]))).toEqual([]);
     });

     it('runDue: релей обновляется — claim освобождается с исходным prev', async () => {
       const chat = jest.fn(async () => { throw new RelayDrainingError(false, 9); });
       const previous = new Date('2026-11-04T00:00:00Z');
       const { svc, store } = makeService(chat, {
         listEnabled: jest.fn(async () => [dueRow({ last_sent_date: previous })]),
       });

       await svc.runDue();

       expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05', 'u-1');
       expect(store.releaseToday).toHaveBeenCalledWith('r-1', '2026-11-05', '2026-11-04');
     });
   ```

3. В `src/trip/trip.service.spec.ts` импорт дополнить:
   ```ts
   import { RelayDrainingError } from '../chat/relay-drain-retry';
   ```
   и сразу после теста `'занятая relay-сессия откладывает фрейминг без ошибки и userId в логе'` дописать:
   ```ts
       it('релей обновляется — фрейминг откладывается, как при занятой сессии', async () => {
         const store = { get: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
         const chat = { generateAgentReply: jest.fn().mockRejectedValue(new RelayDrainingError(false, 9)) };
         const svc = makeTripService({ dayFramingStore: store, chat });
         const logger = { log: jest.fn(), warn: jest.fn() };
         (svc as any).logger = logger;

         await expect(
           svc.generateFramingAsync('u1', 'morning', [], [], new Date('2026-08-06T02:30:00Z')),
         ).resolves.toBeUndefined();

         expect(store.upsert).not.toHaveBeenCalled();
         expect(logger.warn).not.toHaveBeenCalled();
         expect(logger.log).toHaveBeenCalledWith('day-framing отложен: релей обновляется (morning)');
         expect(logger.log.mock.calls[0][0]).not.toContain('u1');
       });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat.service.routine-turns.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/trip/trip.service.spec.ts && git commit -q -m "test(routine-push): фоновые ходы под шлагбаумом выката релея — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.service.routine-turns.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/trip/trip.service.spec.ts 2>&1 | tail -20"
```
Expected: FAIL — agentReply не повторяет (ошибка 503 наружу как есть), `deliver` пробрасывает `RelayDrainingError`, фрейминг пишет `warn`.

- [ ] **Step 3: Реализация**

1. `src/chat/chat.service.ts`, `agentReply` (~3196–3250).
   - Строки
     ```ts
         const outboundPrompt = opts.testMode === true ? neutralizeAtMentions(prompt) : prompt;
         const outboundStablePrefix = opts.testMode === true
           ? neutralizeAtMentions(dispatchStablePrefix)
           : dispatchStablePrefix;
     ```
     перенести выше — перед `const FormData = require('form-data');`.
   - Всё от `const fd = new FormData();` до конца блока `if (opts.linkeonTools === true) … else { … }` (fs_key) включительно — без изменений внутри — обернуть:
     ```ts
         // Форма multipart — поток: на каждый повтор под шлагбаумом — новая.
         const buildForm = () => {
           const fd = new FormData();
           // … все прежние fd.append и ветка linkeonTools/fs_key без изменений …
           return fd;
         };
     ```
   - Вызов
     ```ts
         const resp = await axios.post(`${AGENT_URL}/chat`, fd, {
           headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
           responseType: 'stream',
           timeout: 300000,
           maxRedirects: 0,
         });
     ```
     заменить на
     ```ts
         // Фоновый ход ждёт релей за шлагбаумом выката, как и ход человека, но без
         // carry: его промпт человек не писал. Если человек написал, пока фоновый
         // ход ждал, — уступаем, как при занятой сессии (routine-push отложит).
         let resp: any;
         try {
           resp = await this.postRelayTurn(relaySid, relayMark, null, () => {
             const fd = buildForm();
             return axios.post(`${AGENT_URL}/chat`, fd, {
               headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
               responseType: 'stream',
               timeout: 300000,
               maxRedirects: 0,
             });
           });
         } catch (e) {
           if (e instanceof RelayDrainingError && e.superseded) throw new RelaySessionBusyError(relaySid);
           throw e;
         }
     ```
     `finally { this.endStream(); this.endRelayRun(relaySid, relayMark); }` ниже не трогать — он снимает метку и при броске.

2. `src/routine-push/routine-push.service.ts`:
   - импорт рядом с `ChatService, RelaySessionBusyError`:
     ```ts
     import { RelayDrainingError } from '../chat/relay-drain-retry';
     ```
   - в `DeliverResult` после поля `busy?: boolean;`:
     ```ts
       /** Релей за шлагбаумом выката дольше бюджета повтора: как busy. */
       draining?: boolean;
     ```
   - комментарий над `retryTimers` «Повтор только для busy/preempted, …» заменить на «Повтор только для busy/preempted/релей обновляется, …» (остальной текст тот же);
   - в `releaseDeferred`:
     ```ts
         const deferred = result.busy === true
           || (result.failed === true && result.failReason === 'preempted');
     ```
     заменить на
     ```ts
         const deferred = result.busy === true
           || result.draining === true
           || (result.failed === true && result.failReason === 'preempted');
     ```
     и строку лога
     ```ts
           `routine ${routineId} отложена: ${result.busy ? 'занята сессия' : 'ход перебит (preempted)'}`,
     ```
     на
     ```ts
           `routine ${routineId} отложена: ${result.busy ? 'занята сессия' : result.draining ? 'релей обновляется' : 'ход перебит (preempted)'}`,
     ```
   - в `deliver`, в catch после ветки `RelaySessionBusyError`:
     ```ts
           if (e instanceof RelayDrainingError) {
             if (routineId) await this.scheduleRetry(userId, routineId);
             return { delivered: 0, draining: true };
           }
     ```

3. `src/routine-push/routine-push.controller.ts:69`: `...(r.busy ? { busy: true } : {}),` заменить на
   ```ts
               ...(r.busy || r.draining ? { busy: true } : {}),
   ```
   Кабинет уже понимает `busy` («ассистент занят, попробуйте позже»); отдельный флаг ему не нужен.

4. `src/trip/trip.service.ts` — импорт:
   ```ts
   import { RelayDrainingError } from '../chat/relay-drain-retry';
   ```
   и в catch `generateFramingAsync` после ветки `RelaySessionBusyError` (~400):
   ```ts
         if (e instanceof RelayDrainingError) {
           this.logger.log(`day-framing отложен: релей обновляется (${window})`);
           return;
         }
   ```

5. Остальные потребители не меняются (сверено по 949e81fd): `action-plans.service.ts:127` (ошибка уходит наружу как 5xx — человек жмёт кнопку ещё раз), `quality-monitor.service.ts:76` (`hardFail` с текстом ошибки — проба на выкате честно краснеет), `voice-call.service.ts:903` и `voice-document.service.ts:271/458` (общий catch → «Резюме не сформировано» / повтор документа). Ветки по `e.response?.status` нет ни у кого — `RelayDrainingError` для них просто ещё одна ошибка, но приходит после ~3 минут ожидания, а не сразу.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat.service.ts src/routine-push/routine-push.service.ts src/routine-push/routine-push.controller.ts src/trip/trip.service.ts && git commit -q -m "feat(routine-push): фоновые ходы ждут релей на выкате, рутина откладывается

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.service.routine-turns.spec.ts src/routine-push/ src/trip/trip.service.spec.ts src/chat/chat.relay-drain.spec.ts src/chat/chat.relay-waiting.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 7: «Поговорить начисто» и автоблог

Пункт aa27b1d5. Спек §1.

**Files:**
- Modify: `src/ask/clean-ask.service.ts` (`callRelay`)
- Modify: `src/ask/clean-ask.service.spec.ts`
- Modify: `src/blog/blog-relay.client.ts` (`ask`)
- Modify: `src/blog/blog-relay.client.spec.ts`

У этих путей нет сессии человека и метки `relayRunning` — им нужен только сам повтор (`postRelayWithDrainRetry`), без ожидания-как-хода.

- [ ] **Step 1: Красный тест**

1. В `src/ask/clean-ask.service.spec.ts`, внутри `describe('CleanAskService: модель общего рубильника в запросе к релею', …)` перед его закрывающей `});` дописать:
   ```ts
     it('релей обновляется (503) — повтор с той же сессией и новой формой', async () => {
       post.mockReset();
       post
         .mockImplementationOnce(async () => {
           throw Object.assign(new Error('503'), { response: { status: 503, data: Readable.from([]) } });
         })
         .mockImplementationOnce(async () => ({ data: Readable.from(['data: {"type":"delta","text":"ок"}\n']) }));
       const svc = new CleanAskService({} as any);
       (svc as any).drainOpts = { delaysMs: [0] };

       expect(await (svc as any).callRelay('вопрос')).toBe('ок');
       expect(post).toHaveBeenCalledTimes(2);
       expect(post.mock.calls[1][1]).not.toBe(post.mock.calls[0][1]);
       expect(fieldsOf(post.mock.calls[1][1]).sessionId).toBe(fieldsOf(post.mock.calls[0][1]).sessionId);
     });
   ```

2. В `src/blog/blog-relay.client.spec.ts`, внутри `describe('BlogRelayClient: модель общего рубильника …', …)` перед его закрывающей `});` дописать:
   ```ts
     it('релей обновляется (503) — повтор с новой формой', async () => {
       post.mockReset();
       post
         .mockImplementationOnce(async () => {
           throw Object.assign(new Error('503'), { response: { status: 503, data: Readable.from([]) } });
         })
         .mockImplementationOnce(async () => ({ data: Readable.from(['data: {"type":"delta","text":"пост"}\n\n']) }));
       const c = new BlogRelayClient();
       (c as any).drainOpts = { delaysMs: [0] };

       expect(await c.ask('sys', 'msg', 's-1')).toBe('пост');
       expect(post).toHaveBeenCalledTimes(2);
       expect(post.mock.calls[1][1]).not.toBe(post.mock.calls[0][1]);
       expect(fieldsOf(post.mock.calls[1][1]).sessionId).toBe('s-1');
     });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/ask/clean-ask.service.spec.ts src/blog/blog-relay.client.spec.ts && git commit -q -m "test(ask): «начисто» и автоблог под шлагбаумом выката релея — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/ask/clean-ask.service.spec.ts src/blog/blog-relay.client.spec.ts 2>&1 | tail -15"
```
Expected: FAIL — ошибка 503 выходит наружу, `post` вызван один раз.

- [ ] **Step 3: Реализация**

1. `src/ask/clean-ask.service.ts`:
   - импорт:
     ```ts
     import { postRelayWithDrainRetry, DrainRetryOpts } from '../chat/relay-drain-retry';
     ```
   - поле класса сразу после `constructor(…) {}`:
     ```ts
       /** Повтор под шлагбаумом выката релея; тесты подменяют расписание. */
       drainOpts: DrainRetryOpts = {};
     ```
   - тело `callRelay` от `const FormData = require('form-data');` до закрывающей `});` вызова `axios.post` заменить на:
     ```ts
         const FormData = require('form-data');
         // Эфемерная, ни к кому не привязанная сессия — новая на каждый запрос,
         // но одна на все повторы этого запроса под шлагбаумом выката.
         const sessionId = `anon_${randomUUID()}`;
         const provider = this.globalProvider ? await this.globalProvider.get() : 'claude';
         // Форма multipart — поток: на каждый повтор — новая (relay-drain-retry.ts).
         const buildForm = () => {
           const fd = new FormData();
           fd.append('message', message);
           fd.append('sessionId', sessionId);
           // probe=false — цепочка релея (Claude → Qwen → Kimi → Codex) сохранена намеренно
           // (spec 2026-10-31-global-llm-switch §4), в отличие от гостей пробы
           // (§6, guest-turn.service.ts — без цепочки): у первого контакта и
           // «поговорить начисто» нет экрана «войдите» как запасного варианта,
           // если выбранная модель недоступна.
           for (const [k, v] of Object.entries(relayProviderFields(false, provider))) fd.append(k, v);
           return fd;
         };

         const chunks: string[] = [];
         const resp: any = await postRelayWithDrainRetry(() => {
           const fd = buildForm();
           return axios.post(`${AGENT_URL}/chat`, fd, {
             headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
             responseType: 'stream',
             timeout: 300000,
             maxRedirects: 0,
           });
         }, this.drainOpts);
     ```
     Разбор потока ниже (`await new Promise<void>(…)`) не меняется.

2. `src/blog/blog-relay.client.ts`:
   - импорт:
     ```ts
     import { postRelayWithDrainRetry, DrainRetryOpts } from '../chat/relay-drain-retry';
     ```
   - поле класса сразу после `constructor(…) {}`:
     ```ts
       /** Повтор под шлагбаумом выката релея; тесты подменяют расписание. */
       drainOpts: DrainRetryOpts = {};
     ```
   - в `ask` всё от `const FormData = require('form-data');` до закрывающей `});` вызова `axios.post` заменить на:
     ```ts
         const FormData = require('form-data');
         const provider = opts.followSwitch !== false
           ? (this.globalProvider ? await this.globalProvider.get() : 'claude')
           : null;
         // Форма multipart — поток: на каждый повтор под шлагбаумом — новая.
         const buildForm = () => {
           const fd = new FormData();
           fd.append('message', message);
           fd.append('systemPrompt', systemPrompt);
           fd.append('sessionId', sessionId);
           if (provider !== null) {
             for (const [k, v] of Object.entries(relayProviderFields(false, provider))) fd.append(k, v);
           }
           return fd;
         };

         const resp: any = await postRelayWithDrainRetry(() => {
           const fd = buildForm();
           return axios.post(`${agentUrl}/chat`, fd, {
             headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
             responseType: 'stream',
             timeout: 300_000,
             maxRedirects: 0,
           });
         }, this.drainOpts);
     ```
     Тест `followSwitch: false — рубильник не читается` должен остаться зелёным: при `followSwitch === false` `globalProvider.get()` не вызывается.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/ask/clean-ask.service.ts src/blog/blog-relay.client.ts && git commit -q -m "feat(ask): «начисто» и автоблог ждут релей на выкате

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/ask/ src/blog/ 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 8: Выкат релея — сначала тишина, потом короткий шлагбаум

Пункт aa27b1d5. Спек §2.

**Files:**
- Modify: `scripts/deploy-relay.sh` (шапка, локальные переменные ~14–18, REMOTE: переменные ~76–80, функции после `inflight_count`, ожидание ~337–375, строка ssh в конце)
- Modify: `tests/scripts/deploy-relay-drain.test.js`
- Modify: `relay-agent/README.md` (абзац про marker, ~79)

Сейчас скрипт ставит шлагбаум (`/tmp/linkeon-relay-drain`) сразу и ждёт под ним, пока не доработают все ходы, — до 30 минут. Один долгий ход держит `/chat` закрытым всё это время, и повтор на бэке (≤ 150 с) не спасает. Новый порядок по умолчанию (`RELAY_DRAIN_MODE=quiet`): ждать тишины без шлагбаума, потом поставить шлагбаум и перепроверить тишину не дольше `DRAIN_GATE_WINDOW_SECONDS` (90 с); если ход проскочил и не кончился — снять шлагбаум и ждать снова. Старый порядок — `RELAY_DRAIN_MODE=gate`. Legacy-релей (без `inflight` в health) — как был.

Ловушки, которые держат соседние тесты:
- `tests/scripts/deploy-relay-empty-children.test.cjs` ищет в исходнике точную строку `CHILDREN=$(ps --ppid "$PID" -o pid= || true)` — она должна остаться.
- `tests/scripts/deploy-relay-bash32.mjs` гоняет локальную часть скрипта под `/bin/bash` 3.2 (мак) — в локальной части только конструкции bash 3.2.
- Функции, которые зовутся в условии цикла (`until relay_quiet`), работают с выключенным `set -e` — сбой health внутри них надо разбирать явно, иначе пустая строка сойдёт за ноль.

- [ ] **Step 1: Красный тест**

Всё в `tests/scripts/deploy-relay-drain.test.js`.

1. В `runRollout` сразу после блока
   ```js
     if (['legacy', 'legacy-upload', 'target-fails'].includes(health)) {
       write(path.join(work, 'old-worker-alive'), '4243\n');
     }
   ```
   добавить:
   ```js
     // Сценарий inflight-seq: значения inflight в health по очереди, по одному на вызов.
     if (options.inflightSeq) {
       write(path.join(work, 'inflight-seq'), options.inflightSeq.map((n) => `${n}\n`).join(''));
     }
   ```

2. В заглушке `curl` (шаблонная строка JS — внутри неё нельзя писать `${`, иначе это подстановка JS) перед строкой `  legacy) echo '{"status":"ok"}'; exit 0 ;;` вставить:
   ```
     inflight-seq)
       n=$(head -n 1 "$WORK/inflight-seq" 2>/dev/null || true)
       if [[ -n "$n" ]]; then
         tail -n +2 "$WORK/inflight-seq" > "$WORK/inflight-seq.next"
         mv "$WORK/inflight-seq.next" "$WORK/inflight-seq"
       else
         n=0
       fi
       echo "inflight=$n gate=$gate" >> "$WORK/inflight.log"
       printf '{"status":"ok","inflight":%s}' "$n"
       exit 0 ;;
     inflight-by-gate)
       if [[ "$gate" == yes ]]; then n=$INFLIGHT_GATED; else n=$INFLIGHT_OPEN; fi
       echo "inflight=$n gate=$gate" >> "$WORK/inflight.log"
       printf '{"status":"ok","inflight":%s}' "$n"
       exit 0 ;;
   ```
   (`$gate` заглушка уже вычисляет выше, до `case`.)

3. В объекте `env` после `PAUSE_FILE: options.pauseFile || '',` добавить:
   ```js
       ...(options.env || {}),
   ```

4. В `finish` в возвращаемый объект после строки `curls: …,` добавить:
   ```js
         inflight: fs.existsSync(path.join(work, 'inflight.log'))
           ? fs.readFileSync(path.join(work, 'inflight.log'), 'utf8').trim().split('\n')
           : [],
   ```

5. Тест `'ждёт и in-flight counter, и PM2 children до replacement/restart'` переводится на старый порядок — он проверяет именно его. Заменить его заголовок и первую строку:
   ```js
     it('RELAY_DRAIN_MODE=gate: шлагбаум сразу, ждёт и in-flight counter, и PM2 children до replacement/restart', () => {
       const r = runRollout('inflight-then-zero', { env: { RELAY_DRAIN_MODE: 'gate' } });
   ```
   Остальное тело теста не трогать.

6. В конец файла (после закрывающей `});` describe) дописать:
   ```js
   describe('deploy-relay: сначала тишина, потом короткий шлагбаум (RELAY_DRAIN_MODE=quiet)', () => {
     it('ход идёт — ждёт тишины без шлагбаума; шлагбаум ставится, только когда тихо', () => {
       const r = runRollout('inflight-seq', { inflightSeq: [2, 1, 0, 0] });
       try {
         expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
         expect(r.inflight).toEqual([
           'inflight=2 gate=no', // INITIAL_INFLIGHT: релей не legacy
           'inflight=1 gate=no', // фаза 1: ход идёт, шлагбаума нет
           'inflight=0 gate=no', // фаза 1: тишина
           'inflight=0 gate=yes', // фаза 2: под шлагбаумом по-прежнему тихо
           'inflight=0 gate=yes', // health после рестарта
         ]);
         expect(r.restarts).toBe('restart gate=yes\n');
         expect(r.liveServer).toContain('target');
         expect(r.drainExists).toBe(false);
       } finally {
         r.cleanup();
       }
     });

     it('ход проскочил под шлагбаум и не кончился за окно — шлагбаум снят, ожидание тишины заново', () => {
       const r = runRollout('inflight-seq', {
         inflightSeq: [0, 0, 1, 0, 0],
         env: { DRAIN_GATE_WINDOW_SECONDS: '0' },
       });
       try {
         expect(r.status).toBe(0);
         expect(r.inflight).toEqual([
           'inflight=0 gate=no',
           'inflight=0 gate=no',
           'inflight=1 gate=yes', // проскочил; окно 0 с — шлагбаум снимается сразу
           'inflight=0 gate=no', // снова фаза 1, шлагбаума нет
           'inflight=0 gate=yes',
           'inflight=0 gate=yes', // health после рестарта
         ]);
         expect(r.stderr).toContain('снова ждём тишины');
         expect(r.restarts).toBe('restart gate=yes\n');
         expect(r.liveServer).toContain('target');
         expect(r.drainExists).toBe(false);
       } finally {
         r.cleanup();
       }
     });

     it('под шлагбаумом тихо не становится до конца ожидания — выход 1, замены нет, шлагбаум снят', () => {
       const r = runRollout('inflight-by-gate', {
         env: { INFLIGHT_OPEN: '0', INFLIGHT_GATED: '1', DRAIN_GATE_WINDOW_SECONDS: '0', DRAIN_WAIT_SECONDS: '0' },
       });
       try {
         expect(r.status).toBe(1);
         expect(r.inflight).toEqual(['inflight=0 gate=no', 'inflight=0 gate=no', 'inflight=1 gate=yes']);
         expect(r.stderr).toContain('не дождались');
         expect(r.restarts).toBe('');
         expect(r.liveServer).toContain('base');
         expect(r.drainExists).toBe(false);
       } finally {
         r.cleanup();
       }
     });

     it('тишины нет совсем — выход 1 без шлагбаума, без рестарта, база живая', () => {
       const r = runRollout('inflight-by-gate', {
         env: { INFLIGHT_OPEN: '1', INFLIGHT_GATED: '1', DRAIN_WAIT_SECONDS: '0' },
       });
       try {
         expect(r.status).toBe(1);
         expect(r.inflight).toEqual(['inflight=1 gate=no', 'inflight=1 gate=no']);
         expect(r.stderr).toContain('не дождались');
         expect(r.restarts).toBe('');
         expect(r.liveServer).toContain('base');
         expect(r.drainExists).toBe(false);
       } finally {
         r.cleanup();
       }
     });

     it.each([
       ['RELAY_DRAIN_MODE', 'bogus'],
       ['DRAIN_GATE_WINDOW_SECONDS', '9x'],
     ])('%s=%s — выход 2 до любых изменений на релее', (name, value) => {
       const r = runRollout('ok', { env: { [name]: value } });
       try {
         expect(r.status).toBe(2);
         expect(r.stderr).toContain(name);
         expect(r.restarts).toBe('');
         expect(r.liveServer).toContain('base');
         expect(r.nginxConfig).toContain('alias /tmp/agent-output/;');
         expect(r.drainExists).toBe(false);
       } finally {
         r.cleanup();
       }
     });

     it('неверный RELAY_DRAIN_MODE останавливает скрипт ещё на маке — до git и ssh', () => {
       const r = spawnSync('bash', [DEPLOY, 'no-such-base', 'no-such-target'], {
         encoding: 'utf8',
         env: { ...process.env, RELAY_DRAIN_MODE: 'bogus' },
       });
       expect(r.status).toBe(2);
       expect(r.stderr).toContain('RELAY_DRAIN_MODE');
     });

     it('режим и окно шлагбаума уезжают на релей в ssh-вызове', () => {
       const line = source.split('\n').find((l) => l.startsWith('tar -cf - -C "$LOCAL_BUNDLE"'));
       expect(line).toContain('RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE');
       expect(line).toContain('DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS');
     });
   });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add tests/scripts/deploy-relay-drain.test.js && git commit -q -m "test(deploy-relay): сначала тишина, потом короткий шлагбаум — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest tests/scripts/deploy-relay-drain.test.js 2>&1 | tail -25"
```
Expected: FAIL — новые тесты видят `gate=yes` уже в фазе 1, неверный режим даёт 0, а не 2, локальная проверка — 128 (`git cat-file`), в ssh-строке нет новых переменных. Прежние тесты и тест gate — зелёные.

- [ ] **Step 3: Реализация**

Всё в `scripts/deploy-relay.sh`, кроме п. 7.

1. Шапка: после строки `# BASE_SHA — коммит, чьё содержимое relay-agent совпадает с живым релеем.` вставить:
   ```bash
   #
   # Ожидание перед заменой (с 16.11.2026, пункт бэклога aa27b1d5):
   #   RELAY_DRAIN_MODE=quiet (по умолчанию) — ждать тишины БЕЗ шлагбаума (ни одного
   #     принятого /chat и ни одного процесса CLI), потом поставить шлагбаум и
   #     перепроверять тишину не дольше DRAIN_GATE_WINDOW_SECONDS (90 с — меньше
   #     бюджета повтора бэка, 150 с, src/chat/relay-drain-retry.ts). Ход проскочил
   #     под шлагбаум и не закончился за окно — шлагбаум снимается, ожидание
   #     тишины начинается заново.
   #   RELAY_DRAIN_MODE=gate — прежний порядок, для аварийного выката, когда тишины
   #     не дождаться: шлагбаум сразу, ждать тишины под ним.
   #   DRAIN_WAIT_SECONDS (1800) — сколько всего ждать тишины.
   # Релей без inflight в /health (legacy) выкатывается по-прежнему — шлагбаумом в nginx.
   ```

2. Локальная часть: после строки `DRAIN_WAIT_SECONDS=${DRAIN_WAIT_SECONDS:-1800}` (до `ROOT=…`) вставить:
   ```bash
   RELAY_DRAIN_MODE=${RELAY_DRAIN_MODE:-quiet}
   DRAIN_GATE_WINDOW_SECONDS=${DRAIN_GATE_WINDOW_SECONDS:-90}
   # Проверка до git и ssh: опечатка в режиме не должна молча включить другой порядок.
   if [[ "$RELAY_DRAIN_MODE" != quiet && "$RELAY_DRAIN_MODE" != gate ]]; then
     echo "RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE: допустимо quiet или gate" >&2
     exit 2
   fi
   if [[ ! "$DRAIN_GATE_WINDOW_SECONDS" =~ ^[0-9]+$ ]]; then
     echo "DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS: нужно целое число секунд" >&2
     exit 2
   fi
   ```

3. REMOTE (между `<<'REMOTE'` и `REMOTE`): после строки `DRAIN_WAIT_SECONDS=${DRAIN_WAIT_SECONDS:-1800}` вставить тот же блок из п. 2 (переменные и обе проверки) — релей проверяет сам, до marker и nginx.

4. REMOTE: сразу после функции `inflight_count() { … }` вставить:
   ```bash

   relay_has_children() {
     local CHILDREN
     CHILDREN=$(ps --ppid "$PID" -o pid= || true)
     grep -q . <<< "$CHILDREN"
   }

   # Тишина на релее: ни одного процесса CLI (PM2 children) и ни одного принятого
   # /chat (inflight). Зовётся в условии цикла — там set -e не действует, поэтому
   # сбой health разбирается явно: не ответил — не тихо.
   relay_quiet() {
     local inflight
     if relay_has_children; then return 1; fi
     if ! inflight=$(inflight_count); then
       echo "health релея не ответил при проверке тишины" >&2
       return 1
     fi
     [[ "$inflight" =~ ^[0-9]+$ ]] && (( inflight == 0 ))
   }

   gate_on() {
     ( umask 077; printf '%s\n' "$TARGET_SHORT" > "$DRAIN_FILE.tmp.$$" && mv "$DRAIN_FILE.tmp.$$" "$DRAIN_FILE" )
     GATE_CREATED=1
   }

   # Снять marker этого выката ДО замены файлов (quiet: ход проскочил под
   # шлагбаум). После замены marker снимает только health_and_release.
   gate_off() {
     rm -f -- "$DRAIN_FILE"
     GATE_CREATED=0
   }
   ```

5. REMOTE: всё от строки `INITIAL_INFLIGHT=$(inflight_count)` до `done` цикла ожидания включительно (последняя строка перед `REPLACED=1`) заменить на:
   ```bash
   INITIAL_INFLIGHT=$(inflight_count)

   # PID — до любого шлагбаума: без живого file-agent рестарт невозможен, и
   # закрывать admission незачем.
   PID=$(pm2 pid file-agent)
   if [[ ! "$PID" =~ ^[1-9][0-9]*$ ]]; then
     echo "PM2 file-agent не запущен (pid=$PID) — рестарт невозможен" >&2
     exit 1
   fi

   DRAIN_STARTED=$SECONDS
   drain_deadline() {
     (( SECONDS - DRAIN_STARTED >= DRAIN_WAIT_SECONDS ))
   }

   if [[ "$INITIAL_INFLIGHT" == legacy ]]; then
     # Релей без inflight в health — прежний порядок: шлагбаум в nginx и marker
     # сразу, ждать детей CLI и старых Nginx workers.
     nginx_drain_on
     gate_on
     until ! relay_has_children && legacy_workers_drained; do
       if drain_deadline; then
         echo "Ходы, принятые запросы или старые Nginx workers не завершились за $DRAIN_WAIT_SECONDS с — замена отменена" >&2
         exit 1
       fi
       sleep 5
     done
   elif [[ "$RELAY_DRAIN_MODE" == gate ]]; then
     # Аварийный порядок: marker сразу, ждать тишины под ним.
     gate_on
     until relay_quiet; do
       if drain_deadline; then
         echo "Ходы, принятые запросы или старые Nginx workers не завершились за $DRAIN_WAIT_SECONDS с — замена отменена" >&2
         exit 1
       fi
       sleep 5
     done
   else
     # quiet: сначала тишина без шлагбаума — долгий ход (10 минут агентной
     # работы) не держит /chat закрытым. Шлагбаум — только на перепроверку,
     # замену и рестарт; бэк эти секунды переждёт повтором.
     while true; do
       until relay_quiet; do
         if drain_deadline; then
           echo "Тишины на релее не дождались за $DRAIN_WAIT_SECONDS с — ничего не заменено, шлагбаум не стоит" >&2
           exit 1
         fi
         sleep 5
       done
       gate_on
       GATE_STARTED=$SECONDS
       until relay_quiet; do
         if (( SECONDS - GATE_STARTED >= DRAIN_GATE_WINDOW_SECONDS )); then
           gate_off
           echo "Ход проскочил под шлагбаум и не закончился за $DRAIN_GATE_WINDOW_SECONDS с — шлагбаум снят, снова ждём тишины" >&2
           if drain_deadline; then
             echo "Тишины на релее не дождались за $DRAIN_WAIT_SECONDS с — ничего не заменено, шлагбаум не стоит" >&2
             exit 1
           fi
           continue 2
         fi
         sleep 1
       done
       break
     done
   fi
   ```
   Прежние строки `( umask 077; … )`, `GATE_CREATED=1`, проверка `PID` и цикл `while true; do CHILDREN=… done` уходят целиком — их заменили `gate_on`, `relay_has_children`/`relay_quiet` и ветки выше. Убедиться, что `CHILDREN=$(ps --ppid "$PID" -o pid= || true)` осталась ровно в `relay_has_children`.

6. Строка ssh в конце файла: после `DRAIN_WAIT_SECONDS=$DRAIN_WAIT_SECONDS` вставить ` RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS` (перед ` bash ~/$STAGE/deploy-relay-remote.sh`).

7. `relay-agent/README.md`: абзац, который начинается со «Перед ожиданием завершения ходов скрипт атомарно создаёт `/tmp/linkeon-relay-drain`…» и кончается «…(по умолчанию 1800 секунд).», заменить на:
   ```markdown
   Порядок ожидания задаёт `RELAY_DRAIN_MODE`. По умолчанию (`quiet`, с 16.11.2026) скрипт сначала ждёт тишины **без** marker: ноль принятых запросов (`inflight`) и ни одного PM2 child, не дольше `DRAIN_WAIT_SECONDS` (1800 с); не дождался — выход, ничего не заменено. Дождался — атомарно создаёт `/tmp/linkeon-relay-drain` вне дерева приложения и раз в секунду перепроверяет тишину под ним, не дольше `DRAIN_GATE_WINDOW_SECONDS` (90 с — меньше бюджета повтора бэка, 150 с, `src/chat/relay-drain-retry.ts`). Если ход проскочил между проверкой и marker и не закончился за окно, marker снимается, и ожидание тишины начинается заново. Так `/chat` отвечает 503 секунды, а не всё время долгого хода. `RELAY_DRAIN_MODE=gate` — прежний порядок для аварийного выката: marker сразу, ждать тишины под ним. `drain-gate.mjs` проверяет marker при **каждом** новом `POST /chat` и отвечает 503; бэк такой ответ (и 502 nginx во время рестарта) повторяет. Файл переживает PM2 restart; `/health` остаётся доступен. `inflight.mjs` считает каждый принятый `/chat` с middleware до response `finish`/`close`, а health отдаёт это число полем `inflight`. Ноль нужен **и у принятых запросов, и у PM2 children**, поэтому upload, принятый непосредственно перед marker и ещё не породивший child, тоже завершается до замены. Marker удерживается через замену файлов, restart и health, а снимается только после успешного health. Пути marker/ожидания переопределяются через `RELAY_DRAIN_FILE` и `DRAIN_WAIT_SECONDS`.
   ```
   Остальные абзацы README (legacy, откат, живой test записи) не трогать — их сторожит `deploy-relay-write-gate.test.js`.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add scripts/deploy-relay.sh relay-agent/README.md && git commit -q -m "feat(deploy-relay): сначала тишина, шлагбаум — только на перепроверку и рестарт

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest tests/scripts/deploy-relay-drain.test.js tests/scripts/deploy-relay-early-lock.test.js tests/scripts/deploy-relay-write-gate.test.js 2>&1 | tail -12 && node --test tests/scripts/deploy-relay-empty-children.test.cjs 2>&1 | grep -E '^# (pass|fail)' && node tests/scripts/deploy-relay-bash32.mjs"
```
Expected: jest PASS, `# fail 0`, строка `✓ deploy-relay empty arrays accepted by /bin/bash …`.

Тот же bash32 — под настоящим bash 3.2 мака (быстро, ssh в нём заглушен, на релей ничего не уходит):
```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && node tests/scripts/deploy-relay-bash32.mjs
```
Expected: `✓ deploy-relay empty arrays accepted by /bin/bash without remote effects`.

---

### Task 9: Разрыв между текстом до и после шага работы

Пункты edf8fe49, c3e49a84. Спек §3.

**Files:**
- Create: `src/chat/block-separator.ts`
- Create: `src/chat/block-separator.spec.ts`
- Create: `src/chat/chat.tool-separator.spec.ts`
- Modify: `src/chat/chat.service.ts` (обработчик потока в `callUpstreamOnce`, обработчик в `agentReply`)
- Modify: `src/chat/chat.controller.ts` (обработчик потока в `uploadAndChat`)

Релей шлёт шаг работы отдельным событием `tool` без текста. Модель пишет «Сейчас посмотрю файл.», зовёт инструмент, потом «Готово: …» — и в ответе это склеивалось в «файл.Готово». Первый кусок текста после шага получает разделитель — и в поток клиенту, и в `chunks` (из них собирается история), так что живой показ и история совпадают.

- [ ] **Step 1: Красный тест**

1. Create `src/chat/block-separator.spec.ts`:
   ```ts
   import { blockSeparator, BlockJoiner } from './block-separator';

   describe('blockSeparator', () => {
     it.each([
       ['', 'Готово.', ''],
       ['  \n ', 'Готово.', ''],
       ['Сейчас посмотрю.', 'Готово.', '\n\n'],
       ['Сейчас посмотрю.  ', 'Готово.', '\n\n'],
       ['Сейчас посмотрю.\n', 'Готово.', '\n'],
       ['Сейчас посмотрю.', '\nГотово.', '\n'],
       ['Сейчас посмотрю.\n', '\nГотово.', ''],
       ['Сейчас посмотрю.\n\n', 'Готово.', ''],
       ['Сейчас посмотрю.\n \n', 'Готово.', ''],
       ['Сейчас посмотрю.', '\n\nГотово.', ''],
     ])('%j + %j → %j', (prev, next, sep) => {
       expect(blockSeparator(prev, next)).toBe(sep);
     });

     it('после склейки между блоками ровно одна пустая строка', () => {
       for (const [prev, next] of [['а.', 'б'], ['а.\n', 'б'], ['а.', '\nб'], ['а.\n', '\nб']]) {
         expect(prev + blockSeparator(prev, next) + next).toBe('а.\n\nб');
       }
     });
   });

   describe('BlockJoiner', () => {
     it('разделитель получает только первый кусок после шага работы', () => {
       const chunks: string[] = [];
       const j = new BlockJoiner(() => chunks.join(''));
       chunks.push(j.text('Сейчас посмотрю.'));
       j.tool();
       chunks.push(j.text('Гото'));
       chunks.push(j.text('во.'));
       expect(chunks.join('')).toBe('Сейчас посмотрю.\n\nГотово.');
     });

     it('шаг в самом начале ответа — без разделителя', () => {
       const chunks: string[] = [];
       const j = new BlockJoiner(() => chunks.join(''));
       j.tool();
       chunks.push(j.text('Готово.'));
       expect(chunks.join('')).toBe('Готово.');
     });

     it('пустой кусок не съедает разделитель', () => {
       const chunks: string[] = [];
       const j = new BlockJoiner(() => chunks.join(''));
       chunks.push(j.text('А.'));
       j.tool();
       chunks.push(j.text(''));
       chunks.push(j.text('Б.'));
       expect(chunks.join('')).toBe('А.\n\nБ.');
     });

     it('несколько шагов подряд — один разделитель', () => {
       const chunks: string[] = [];
       const j = new BlockJoiner(() => chunks.join(''));
       chunks.push(j.text('А.'));
       j.tool();
       j.tool();
       chunks.push(j.text('Б.'));
       expect(chunks.join('')).toBe('А.\n\nБ.');
     });
   });
   ```

2. Create `src/chat/chat.tool-separator.spec.ts`:
   ```ts
   import { Readable } from 'stream';
   import axios from 'axios';
   import { ChatService } from './chat.service';
   import { ChatController } from './chat.controller';

   jest.mock('axios');
   jest.mock('../common/telegram-alert', () => ({
     sendTelegramAlert: jest.fn(async () => {}),
     sendTelegramPayload: jest.fn(async () => {}),
   }));

   /**
    * Пункты edf8fe49, c3e49a84: текст до шага работы и текст после него
    * склеивались («файл.Готово»). Разделитель (block-separator.ts) ставится у
    * всех трёх потребителей потока релея — веб-ход, ход с файлом, agentReply — и
    * в поток клиенту, и в то, что ложится в историю.
    */

   const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };
   const ev = (e: object) => `data: ${JSON.stringify(e)}\n`;
   const STREAM = [
     ev({ type: 'delta', text: 'Сейчас посмотрю файл.' }),
     ev({ type: 'tool', tool: 'Read', input: '{}' }),
     ev({ type: 'delta', text: 'Готово: всё сходится.' }),
     ev({ type: 'done', costUsd: 0.1 }),
   ];
   const JOINED = 'Сейчас посмотрю файл.\n\nГотово: всё сходится.';

   function makeService() {
     const calls: { sql: string; params: any[] }[] = [];
     const pg = {
       query: jest.fn(async (sql: string, params: any[] = []) => {
         calls.push({ sql, params });
         if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
         if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
         if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
         if (/SELECT profile_data FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ profile_data: {} }] };
         return { rows: [] };
       }),
     };
     const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
     const svc = new ChatService(
       pg as any, null as any, null as any, null as any, language as any,
       undefined, undefined, undefined, undefined,
     );
     return { svc, calls };
   }

   const post = jest.fn();
   beforeEach(() => {
     post.mockReset();
     (axios as any).default = { post };
     (axios as any).post = post;
   });

   async function settle() {
     for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
   }

   function newRes(): any {
     return {
       status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
       end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
     };
   }
   function writes(res: any): any[] {
     const out: any[] = [];
     for (const c of res.write.mock.calls) {
       for (const line of String(c[0]).split('\n')) {
         if (!line) continue;
         try { out.push(JSON.parse(line)); } catch { /* не JSON — не наше */ }
       }
     }
     return out;
   }
   const items = (res: any) => writes(res).filter((w) => w.type === 'item').map((w) => w.content);
   const ends = (res: any) => writes(res).filter((w) => w.type === 'end');
   const saved = (calls: { params: any[] }[]) => calls.flatMap((c) => c.params).filter((p) => typeof p === 'string');

   describe('разделитель после шага работы — у всех потребителей потока релея', () => {
     it('веб-ход: в потоке клиенту, в end и в истории', async () => {
       const { svc, calls } = makeService();
       post.mockResolvedValueOnce({ data: Readable.from(STREAM) });
       const res = newRes();
       await (svc as any).streamUniversalAgent(
         'u1', 'проверь', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
       );
       await settle();

       expect(items(res).join('')).toBe(JOINED);
       expect(ends(res)[0].content).toBe(JOINED);
       expect(saved(calls)).toContain(JOINED);
     });

     it('ход с файлом: в потоке клиенту, в end и в истории', async () => {
       const { svc, calls } = makeService();
       post.mockResolvedValueOnce({ data: Readable.from(STREAM) });
       const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
       const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
       const req = {
         headers: { authorization: 'Bearer t' },
         files: [{ originalname: 'a.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
         body: { message: 'смотри файл', assistantId: '7' },
       } as any;
       const res = newRes();
       await ctrl.uploadAndChat(req, res);
       await settle();

       expect(items(res).join('')).toBe(JOINED);
       expect(ends(res)[0].content).toBe(JOINED);
       expect(saved(calls)).toContain(JOINED);
     });

     it('agentReply (рутины, «Путь»): возвращённый текст', async () => {
       const { svc } = makeService();
       post.mockResolvedValueOnce({ data: Readable.from(STREAM) });
       await expect(svc.generateAgentReply('u1', '12', 'напомни')).resolves.toBe(JOINED);
     });
   });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/block-separator.spec.ts src/chat/chat.tool-separator.spec.ts && git commit -q -m "test(chat): разрыв между текстом до и после шага работы — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/block-separator.spec.ts src/chat/chat.tool-separator.spec.ts 2>&1 | tail -20"
```
Expected: FAIL — `Cannot find module './block-separator'`; в спеке потребителей текст склеен: `Сейчас посмотрю файл.Готово: всё сходится.`

- [ ] **Step 3: Реализация**

1. Create `src/chat/block-separator.ts`:
   ```ts
   /**
    * Разделитель между текстом до шага работы (инструмента) и текстом после него.
    *
    * Релей шлёт ответ кусками (delta), а шаг работы — отдельным событием `tool`,
    * без текста. Модель часто пишет «Сейчас посмотрю файл.» → шаг → «Готово: …»
    * без переноса между ними, и в ответе это склеивалось в «файл.Готово»
    * (бэклог edf8fe49, c3e49a84, 16.11.2026). Первый кусок текста после шага
    * получает разделитель — и в поток клиенту, и в историю, поэтому живой показ
    * и перечитанная история совпадают.
    *
    * '' — в начале ответа или если пустая строка на стыке уже есть;
    * '\n' — если на стыке уже стоит одиночный перенос; иначе '\n\n'.
    */
   export function blockSeparator(prev: string, next: string): string {
     if (!prev || !prev.trim()) return '';
     if (/\n\s*\n\s*$/.test(prev) || /^\s*\n\s*\n/.test(next)) return '';
     const prevBreak = /\n[ \t]*$/.test(prev);
     const nextBreak = /^[ \t]*\n/.test(next);
     if (prevBreak && nextBreak) return '';
     if (prevBreak || nextBreak) return '\n';
     return '\n\n';
   }

   /**
    * Следит за шагами работы в потоке релея: tool() — был шаг, text() — кусок
    * текста, с разделителем, если он первый после шага. soFar — уже накопленный
    * текст ответа (у потребителей это chunks.join('')).
    */
   export class BlockJoiner {
     private afterTool = false;

     constructor(private readonly soFar: () => string) {}

     tool(): void {
       this.afterTool = true;
     }

     text(next: string): string {
       if (!this.afterTool || !next) return next;
       this.afterTool = false;
       return blockSeparator(this.soFar(), next) + next;
     }
   }
   ```

2. `src/chat/chat.service.ts` — импорт рядом с остальными из `./`:
   ```ts
   import { BlockJoiner } from './block-separator';
   ```

3. Веб-ход, `callUpstreamOnce`: перед строкой `await new Promise<void>((resolve, reject) => {`, которая читает `agentRes.data`, вставить:
   ```ts
           // Шаг работы (tool) между кусками текста: первый кусок после него
           // получает разделитель (block-separator.ts), иначе «файл.Готово».
           const joiner = new BlockJoiner(() => chunks.join(''));
   ```
   В обработчике:
   - ветку
     ```ts
                     if (ev.type === 'delta' || ev.type === 'text') {
                       chunks.push(ev.text);
                       safeWrite({ type: 'item', content: ev.text });
     ```
     заменить на
     ```ts
                     if (ev.type === 'delta' || ev.type === 'text') {
                       const text = joiner.text(ev.text);
                       chunks.push(text);
                       safeWrite({ type: 'item', content: text });
     ```
   - в ветке `} else if (ev.type === 'notice' && ev.text) {` (комментарий оставить) строки
     ```ts
                       chunks.push(ev.text);
                       safeWrite({ type: 'item', content: ev.text });
     ```
     заменить на
     ```ts
                       const text = joiner.text(ev.text);
                       chunks.push(text);
                       safeWrite({ type: 'item', content: text });
     ```
   - в ветке `} else if (ev.type === 'tool') {` первой строкой, перед комментарием «Шаг работы для клиента…», вставить:
     ```ts
                       joiner.tool();
     ```
     Комментарий «В chunks не идёт: к тексту ответа отношения не имеет.» остаётся верным: сам шаг в chunks не идёт.

4. `agentReply`: перед строкой `await new Promise<void>((resolve, reject) => {`, которая читает `resp.data`, вставить:
   ```ts
       // Разделитель после шага работы — как у веб-хода (block-separator.ts).
       const joiner = new BlockJoiner(() => chunks.join(''));
   ```
   и строки
   ```ts
               if (ev.type === 'delta' || ev.type === 'text') chunks.push(ev.text);
               else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
   ```
   заменить на
   ```ts
               if (ev.type === 'delta' || ev.type === 'text') chunks.push(joiner.text(ev.text));
               else if (ev.type === 'tool') joiner.tool();
               else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
   ```

5. `src/chat/chat.controller.ts` — импорт:
   ```ts
   import { BlockJoiner } from './block-separator';
   ```
   В `uploadAndChat` перед строкой `await new Promise<void>((resolve) => {`, которая читает `agentRes.data`, вставить:
   ```ts
         // Разделитель после шага работы — как у веб-хода (block-separator.ts).
         const joiner = new BlockJoiner(() => chunks.join(''));
   ```
   В обработчике:
   - ветку
     ```ts
                 if (ev.type === 'delta' || ev.type === 'text') {
                   chunks.push(ev.text);
                   safeWrite({ type: 'item', content: ev.text });
     ```
     заменить на
     ```ts
                 if (ev.type === 'delta' || ev.type === 'text') {
                   const text = joiner.text(ev.text);
                   chunks.push(text);
                   safeWrite({ type: 'item', content: text });
     ```
   - в ветке `} else if (ev.type === 'notice' && ev.text) {` (комментарий оставить) так же заменить `chunks.push(ev.text); safeWrite({ type: 'item', content: ev.text });` на `const text = joiner.text(ev.text); chunks.push(text); safeWrite({ type: 'item', content: text });` (по строке на вызов, как в п. 3);
   - в ветке `} else if (ev.type === 'tool') {` первой строкой вставить `joiner.tool();`.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/block-separator.ts src/chat/chat.service.ts src/chat/chat.controller.ts && git commit -q -m "fix(chat): пустая строка между текстом до и после шага работы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/block-separator.spec.ts src/chat/chat.tool-separator.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.relay-drain.spec.ts src/chat/chat.service.routine-turns.spec.ts src/chat/chat.upload-chat-files.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 10: Правила сдачи результата в системном промпте

Пункты 3bc89c7b, a43117a5, 7184d911, 66c272b5, edf8fe49, c3e49a84, faa0d127. Спек §4.

**Files:**
- Create: `src/chat/result-rules.ts`
- Create: `src/chat/result-rules.spec.ts`
- Modify: `src/chat/chat.service.ts` (импорт ~32, `buildRelayStablePrefix` ~931 и комментарий сторожа размера ~996)

Блок встаёт в стабильную часть промпта релея сразу после `WORK_RULES` — тем же путём, что `WORK_RULES` 02.11: выкат через `deploy.sh`, `SYSTEM_PROMPT` релея не трогаем. У магазинной сборки (`opts.storeBuild`) правило 4 другое: в нём не должно быть слов «токен», «баланс», «пополн», «стоимост», ссылок и цены (спек, раздел «Тесты»).

- [ ] **Step 1: Красный тест**

Create `src/chat/result-rules.spec.ts`:

```ts
import { ChatService } from './chat.service';
import { WORK_RULES } from './work-rules';
import { resultRules } from './result-rules';

/** Стабильная часть промпта релея — то, что уходит в --system-prompt. */
async function stablePrefix(storeBuild: boolean): Promise<string> {
  const pg = {
    query: jest.fn(async (sql: string) => /SELECT profile_data FROM ai_profiles_consolidated/.test(sql)
      ? { rows: [{ profile_data: { automaticProfiling: true } }] }
      : { rows: [] }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
  return (svc as any).buildRelayStablePrefix({
    agentId: '12', agentName: 'Роман', agentDescription: '', agentSystemPrompt: 'Ты ассистент.',
    userId: 'u1', userLanguage: 'ru', profileText: 'ПРОФИЛЬ-МАРКЕР', storeBuild,
  });
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const WEB = resultRules();
const STORE = resultRules({ store: true });

describe('resultRules — правила сдачи результата', () => {
  it('пять правил под своим заголовком', () => {
    for (const r of [WEB, STORE]) {
      expect(r.startsWith('--- Правила результата ---\n')).toBe(true);
      for (const n of ['1. ', '2. ', '3. ', '4. ', '5. ']) expect(r).toContain(`\n${n}`);
    }
  });

  it('то, что просили: сверить тип результата, двусмысленное — один вопрос до начала', () => {
    expect(WEB).toContain('сверь тип результата с просьбой');
    expect(WEB).toContain('один короткий вопрос до начала');
  });

  it('проверка перед «готово»: pdfinfo, qpdf --check, pdftoppm; две попытки — сказать прямо', () => {
    expect(WEB).toContain('pdfinfo');
    expect(WEB).toContain('qpdf --check');
    expect(WEB).toContain('pdftoppm');
    expect(WEB).toContain('Две попытки не помогли');
  });

  it('итог хода: без заметок для себя, последний абзац — итог, повтор просьбы — показать готовое', () => {
    expect(WEB).toContain('Не пиши заметок для себя');
    expect(WEB).toContain('Последний абзац ответа — итог');
    expect(WEB).toContain('покажи, где он');
  });

  it('платные действия в вебе: цена до серии, отказ по балансу — с выходом', () => {
    expect(WEB).toContain('назови цену и спроси');
    expect(WEB).toContain('по блоку о балансе');
    expect(WEB).toContain('своими средствами');
  });

  it('магазинная сборка: выход и вопрос есть, денег нет (Apple 3.1.1)', () => {
    expect(STORE).toContain('предложи, что можно сделать иначе');
    expect(STORE).toContain('спроси, как продолжить');
    expect(STORE).not.toMatch(/токен|баланс|пополн|стоимост|цен[аеуы]|https?:\/\//i);
  });

  it('большие файлы и ссылки: 100 МБ, ffmpeg, облачные диски по белому списку, без base64 в HTML', () => {
    for (const r of [WEB, STORE]) {
      expect(r).toContain('до 100 МБ');
      expect(r).toContain('ffmpeg');
      expect(r).toContain('белому списку');
      expect(r).toContain('не обещай скачать');
      expect(r).toContain('base64');
    }
  });

  it('бюджет блока — 6 КБ в обоих вариантах', () => {
    expect(Buffer.byteLength(WEB, 'utf8')).toBeLessThanOrEqual(6144);
    expect(Buffer.byteLength(STORE, 'utf8')).toBeLessThanOrEqual(6144);
  });
});

describe('resultRules в стабильной части промпта релея', () => {
  it('ровно один раз, сразу за WORK_RULES и до профиля', async () => {
    const prefix = await stablePrefix(false);
    expect(count(prefix, WEB)).toBe(1);
    expect(prefix.indexOf(WEB)).toBe(prefix.indexOf(WORK_RULES) + WORK_RULES.length + 2);
    expect(prefix.indexOf(WEB)).toBeLessThan(prefix.indexOf('ПРОФИЛЬ-МАРКЕР'));
  });

  it('магазинной сборке — магазинный вариант, веб-варианта нет', async () => {
    const prefix = await stablePrefix(true);
    expect(count(prefix, STORE)).toBe(1);
    expect(prefix).not.toContain(WEB);
  });
});
```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/result-rules.spec.ts && git commit -q -m "test(chat): правила сдачи результата в промпте релея — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/result-rules.spec.ts 2>&1 | tail -15"
```
Expected: FAIL — `Cannot find module './result-rules'`.

- [ ] **Step 3: Реализация**

1. Create `src/chat/result-rules.ts`:
   ```ts
   /**
    * Правила сдачи результата — всем ассистентам релея (штатным и
    * пользовательским), в стабильной части системного промпта, сразу после
    * WORK_RULES (work-rules.ts).
    *
    * Откуда: находки «Затыков недели» 16.11.2026 — пункты бэклога 3bc89c7b,
    * a43117a5, 7184d911, 66c272b5, edf8fe49, c3e49a84, faa0d127: сделано
    * «похожее» вместо просимого, «готово» без проверки результата, заметки для
    * себя вместо итога, отказ инструмента по балансу без выхода, обещание
    * скачать файл, до которого песочница не дотянется.
    *
    * Магазинная сборка (правило Apple 3.1.1): правило 4 — без цены, баланса и
    * ссылок; слов о деньгах в этом варианте нет вовсе (result-rules.spec.ts).
    * Признак сборки меняет промпт — переключение стоит один ход по холодному
    * кэшу, как у platformGuide.
    *
    * Промпт уходит в CLI одним аргументом (предел 128 КБ) — блок держим ≤ 6 КБ,
    * размер сторожит result-rules.spec.ts.
    */
   const HEADER = '--- Правила результата ---';

   const RULE_1 = '1. ТО, ЧТО ПРОСИЛИ. Перед работой сверь тип результата с просьбой: вещь или услуга, текст или слайды, файл или ссылка, формат, ограничения. Если просьбу можно понять двумя способами и они ведут к разной работе — задай один короткий вопрос до начала, а не делай «похожее».';

   const RULE_2 = '2. ПРОВЕРКА ПЕРЕД «ГОТОВО». Не пиши «готово» или «исправлено», пока не проверил сам результат. PDF: pdfinfo (число страниц; при склейке — сумма страниц исходников), qpdf --check, отрисуй страницы через pdftoppm и посмотри на них. Картинка: увеличь место дефекта и сравни с исходником. Две попытки не помогли — скажи прямо, что не выходит, и предложи другой путь.';

   const RULE_3 = '3. ИТОГ ХОДА. Человек видит весь текст хода, в том числе написанный между шагами работы. Не пиши заметок для себя («сейчас проверю», «план такой») — только то, что адресовано человеку. Последний абзац ответа — итог: что сделано, какие файлы приложены, что нужно от человека. Если человек повторяет просьбу, а ответ уже готов, — покажи, где он, а не делай заново.';

   const RULE_4_WEB = '4. ПЛАТНЫЕ ДЕЙСТВИЯ. Перед серией платных действий (несколько картинок, видео, озвучка) назови цену и спроси, делать ли. Цену знаешь из описания инструмента и справки. Инструмент отказал из-за баланса — скажи об этом по блоку о балансе и предложи, что можно сделать без этой операции своими средствами, а не ограничивайся отказом.';

   const RULE_4_STORE = '4. НЕДОСТУПНОЕ ДЕЙСТВИЕ. Действие недоступно или инструмент отказал — предложи, что можно сделать иначе своими средствами, и спроси, как продолжить. О деньгах и покупках в этой сборке не говори вовсе, даже если в ответе инструмента есть суммы или адреса.';

   const RULE_5 = '5. БОЛЬШИЕ ФАЙЛЫ И ССЫЛКИ. В кабинете в чат загружается файл до 100 МБ, у других каналов свои пределы. Файл больше — объясни и предложи сжать у себя (как именно — на телефоне и на компьютере), прислать фрагмент или по частям. Загруженное видео можно сжать здесь, через ffmpeg. Файлы по ссылкам на облачные диски (Яндекс.Диск, Google Drive и т. п.) из рабочей среды не скачиваются: сеть там открыта только по белому списку — скажи об этом честно и попроси загрузить файл в чат, не обещай скачать. Видео с ограниченным доступом недоступно — объясни почему. Для Tilda и других конструкторов не вшивай видео в HTML (base64): видео — отдельным файлом или вставкой с видеохостинга.';

   export function resultRules(opts: { store?: boolean } = {}): string {
     return [HEADER, RULE_1, RULE_2, RULE_3, opts.store ? RULE_4_STORE : RULE_4_WEB, RULE_5].join('\n');
   }
   ```

2. `src/chat/chat.service.ts`: после `import { WORK_RULES } from './work-rules';` добавить
   ```ts
   import { resultRules } from './result-rules';
   ```

3. В `buildRelayStablePrefix` после строки `stablePrefix += `${WORK_RULES}\n\n`;` вставить:
   ```ts

       // Правила сдачи результата (result-rules.ts; «Затыки недели» 16.11.2026) —
       // сразу за правилами работы с файлами и тоже до профиля. У магазинной
       // сборки правило 4 — без цены и баланса (Apple 3.1.1).
       stablePrefix += `${resultRules({ store: opts.storeBuild === true })}\n\n`;
   ```

4. Там же в комментарии сторожа размера фразу `WORK_RULES держит свой бюджет (≤ 6 КБ,` и следующую за ней `work-rules.spec.ts), но персона ассистента` заменить на
   ```
       // 128 КБ на аргумент) — WORK_RULES и resultRules держат свои бюджеты (≤ 6 КБ
       // каждый, work-rules.spec.ts и result-rules.spec.ts), но персона ассистента,
   ```
   (только текст комментария; переносы строк подогнать под соседние строки).

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/result-rules.ts src/chat/chat.service.ts && git commit -q -m "feat(chat): правила сдачи результата в стабильной части промпта релея

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/result-rules.spec.ts src/chat/work-rules.spec.ts src/chat/ask-rule.spec.ts src/chat/platform-guide.spec.ts src/chat/crisis-rule.spec.ts src/chat/colleagues-rule.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`. Соседние спеки — сторожа той же стабильной части промпта.

---

### Task 11: Отказ по балансу — с подсказкой выхода

Пункт faa0d127. Спек §5.

**Files:**
- Modify: `src/chat/chat-tools.ts` (`insufficientTokens`, ~16–31)
- Modify: `src/chat/balance-context-delivery.spec.ts` (describe `insufficientTokens`)

`insufficientTokens` — единая точка отказа: её возвращают пять инструментов картинок (`generate_image`, `generate_banner`, `edit_image`, `compose_image`, `upscale_image`) и общий перехват `InsufficientTokensError` в `executeTool` (отказ видео). Поле `hint` попадает во все шесть мест сразу.

- [ ] **Step 1: Красный тест**

В `src/chat/balance-context-delivery.spec.ts`:
1. Импорт `import { insufficientTokens } from './chat-tools';` заменить на
   ```ts
   import { insufficientTokens, INSUFFICIENT_TOKENS_HINT } from './chat-tools';
   ```
2. В describe `'insufficientTokens — единый ответ на нехватку токенов'` перед его закрывающей `});` дописать:
   ```ts
     it('подсказывает выход: не повторять вызов, предложить возможное сейчас, спросить', () => {
       const { hint } = insufficientTokens(3000, 10000);
       expect(hint).toBe(INSUFFICIENT_TOKENS_HINT);
       expect(hint).toContain('Не повторяй этот же вызов');
       expect(hint).toContain('std вместо hd');
       expect(hint).toContain('SVG');
       expect(hint).toContain('Спроси, как продолжить');
     });

     it('в подсказке нет сумм и ссылок — их несёт блок баланса', () => {
       expect(INSUFFICIENT_TOKENS_HINT).not.toMatch(/\d/);
       expect(INSUFFICIENT_TOKENS_HINT).not.toMatch(/https?:|linkeon\.io/);
     });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/balance-context-delivery.spec.ts && git commit -q -m "test(chat-tools): подсказка выхода при отказе по балансу — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/balance-context-delivery.spec.ts 2>&1 | tail -15"
```
Expected: FAIL — `hint` равен `undefined` (jest типы не проверяет, отсутствующий экспорт приходит как `undefined`).

- [ ] **Step 3: Реализация**

В `src/chat/chat-tools.ts` перед doc-комментарием `/** Единый ответ инструмента на нехватку токенов.` вставить:
```ts
/**
 * Подсказка ассистенту к отказу по балансу (бэклог faa0d127, 16.11.2026):
 * кроме кода ошибки у него не было выхода, и разговор кончался отказом. Сумм и
 * ссылок здесь нет: вне магазинной сборки их несёт блок баланса, а в магазинной
 * правило 4 (result-rules.ts) запрещает говорить о деньгах.
 */
export const INSUFFICIENT_TOKENS_HINT =
  'Не повторяй этот же вызов. Предложи человеку вариант, который возможен сейчас: качество std вместо hd, если оно укладывается в баланс, или то, что можно сделать своими средствами без платной генерации (например, схему или простой рисунок в SVG — с согласия человека и с оговоркой, что это не генерация нейросетью; доработать готовый файл из рабочей папки). Спроси, как продолжить.';
```
и в объекте, который возвращает `insufficientTokens`, после строки `topUpUrl: TOP_UP_URL,` добавить:
```ts
    hint: INSUFFICIENT_TOKENS_HINT,
```

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add src/chat/chat-tools.ts && git commit -q -m "feat(chat-tools): отказ по балансу подсказывает выход

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/balance-context-delivery.spec.ts src/chat/chat-tools.hd.spec.ts src/chat/chat-tools.calendar.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 12: Имена загрузок на релее — без совпадений и перезаписи

Попутная находка. Спек §7.

**Files:**
- Modify: `relay-agent/paths.mjs` (`uploadFileName` ~76–83, новая `uniqueUploadPath`, импорт `crypto`)
- Modify: `relay-agent/paths.test.mjs`
- Modify: `relay-agent/server.mjs` (импорт из `./paths.mjs` ~10, цикл переименования загрузок ~570–587)
- Modify: `relay-agent/server-sandbox.test.mjs`

Сейчас очистка имени превращает каждый не-ASCII символ в `_`, поэтому «смета.xlsx» и «отчет.xlsx» (по пять букв) обе становятся `<ключ>_` + пять `_` + `.xlsx`, а `renameSync` молча перезаписывает первую. То же с двумя «image.jpg» с iPhone и с повторной загрузкой.

Решения:
- Хеш — только когда очистка что-то потеряла (замена символов или обрезка): к основе `-` и 8 hex sha256 исходного имени, основа режется на 9 байт короче — бюджет имени прежний. Имена без потерь (`egrul.pdf`) не меняются: на это опираются действующие тесты и легаси-пути.
- `uniqueUploadPath(dir, name, exists, random)`: занято — `-2` … `-99` перед расширением, дальше 8 hex из `randomUUID` (полный uuid, +37 байт, не влезает в 255 при длинном имени), не нашлось за 5 попыток — ошибка. Префикс `<ключ>_` сохраняется всегда: легаси-сессии читают загрузки по маске `Read(<uploads>/<ключ>_*)`.
- Показ шага работы (`src/chat/activity-map.ts`) выводит очищенное имя; у кириллицы там и так были подчёркивания, теперь к ним добавится `-xxxxxxxx`. Бэк имён загрузок релея не предсказывает.

- [ ] **Step 1: Красный тест**

1. `relay-agent/paths.test.mjs`:
   - в список импорта из `"./paths.mjs"` после `fallbackFileName,` добавить `uniqueUploadPath,`;
   - строку `import { randomUUID } from "crypto";` заменить на `import { randomUUID, createHash } from "crypto";`;
   - в конец файла дописать:
   ```js
   test("кириллические имена одной длины больше не совпадают", () => {
     const a = uploadFileName("смета.xlsx", FS_KEY);
     const b = uploadFileName("отчет.xlsx", FS_KEY);
     assert.notEqual(a, b);
     const hash = createHash("sha256").update("смета.xlsx").digest("hex").slice(0, 8);
     assert.equal(a, `${FS_KEY}_${"_".repeat(5)}-${hash}.xlsx`);
     assert.equal(tryCreate(a), null);
     assert.equal(tryCreate(b), null);
   });

   test("одно и то же имя — один и тот же результат", () => {
     assert.equal(uploadFileName("смета.xlsx", FS_KEY), uploadFileName("смета.xlsx", FS_KEY));
   });

   test("имя без потерь остаётся как было — без хеша", () => {
     assert.equal(uploadFileName("egrul-2026_v2.pdf", FS_KEY), `${FS_KEY}_egrul-2026_v2.pdf`);
   });

   test("обрезанное длинное ASCII-имя тоже получает хеш: общее начало не склеивает файлы", () => {
     const a = uploadFileName("a".repeat(200) + "1.pdf", FS_KEY);
     const b = uploadFileName("a".repeat(200) + "2.pdf", FS_KEY);
     assert.notEqual(a, b);
     assert.match(a, /-[0-9a-f]{8}\.pdf$/);
   });

   test("длинное кириллическое имя с хешем укладывается в прежний бюджет и сохраняет расширение", () => {
     const built = uploadFileName("Выписка".repeat(60) + ".pdf", sessionFsKey("9".repeat(300), "x"));
     assert.ok(Buffer.byteLength(built) <= 241, String(Buffer.byteLength(built)));
     assert.match(built, /-[0-9a-f]{8}\.pdf$/);
     assert.equal(tryCreate(built), null);
   });

   test("uniqueUploadPath: свободное имя — как есть", () => {
     assert.equal(uniqueUploadPath("/u", "k_a.pdf", () => false), path.join("/u", "k_a.pdf"));
   });

   test("uniqueUploadPath: занятое — суффикс -2, -3… перед расширением", () => {
     const taken = new Set([path.join("/u", "k_a.pdf"), path.join("/u", "k_a-2.pdf")]);
     assert.equal(uniqueUploadPath("/u", "k_a.pdf", (p) => taken.has(p)), path.join("/u", "k_a-3.pdf"));
   });

   test("uniqueUploadPath: заняты -2…-99 — 8 hex из uuid, префикс ключа на месте", () => {
     const built = uniqueUploadPath("/u", "k_a.pdf", (p) => !/-[0-9a-f]{8}\.pdf$/.test(p), () => "0123abcd");
     assert.equal(built, path.join("/u", "k_a-0123abcd.pdf"));
   });

   test("uniqueUploadPath: занято всё — ошибка, а не тихая перезапись", () => {
     assert.throws(() => uniqueUploadPath("/u", "k_a.pdf", () => true, () => "0123abcd"));
   });

   test("самое длинное имя с запасным суффиксом укладывается в NAME_MAX", () => {
     const name = uploadFileName("Выписка".repeat(60) + ".pdf", sessionFsKey("9".repeat(300), "x"));
     const built = path.basename(uniqueUploadPath(DIR, name, (p) => !/-0123abcd\.pdf$/.test(p), () => "0123abcd"));
     assert.ok(Buffer.byteLength(built) <= 255);
     assert.equal(tryCreate(built), null);
   });
   ```
   (`FS_KEY`, `DIR`, `tryCreate`, `sessionFsKey` в файле уже есть.)

2. `relay-agent/server-sandbox.test.mjs` — в конец файла дописать:
   ```js
   test('server: одинаковые имена и кириллица одной длины — ни один файл не затёрт', async (t) => {
     const f = await fixture(t, { mode: 'on' });
     const { response } = await f.requestUpload([
       { name: 'image.docx', body: 'first-body' },
       { name: 'image.docx', body: 'second-body' },
       { name: 'смета.docx', body: 'smeta-body' },
       { name: 'отчет.docx', body: 'otchet-body' },
     ]);
     assert.equal(response.status, 200);

     const dir = path.join(f.dirs.uploadDir, FS_KEY);
     const names = fs.readdirSync(dir).filter((name) => name.endsWith('.docx'));
     assert.equal(names.length, 4);
     assert.ok(names.includes(`${FS_KEY}_image.docx`));
     assert.ok(names.includes(`${FS_KEY}_image-2.docx`));
     const bodies = names.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).sort();
     assert.deepEqual(bodies, ['first-body', 'otchet-body', 'second-body', 'smeta-body']);
   });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add relay-agent/paths.test.mjs relay-agent/server-sandbox.test.mjs && git commit -q -m "test(relay): совпадающие имена загрузок затирают друг друга — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && cd relay-agent && source ~/.nvm/nvm.sh && node --test paths.test.mjs server-sandbox.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'"
```
Expected: FAIL — `uniqueUploadPath` не экспортируется (paths.test.mjs падает на импорте целиком), в server-sandbox файлов меньше четырёх.

- [ ] **Step 3: Реализация**

1. `relay-agent/paths.mjs`:
   - после `import path from "path";` добавить:
     ```js
     import { createHash, randomUUID } from "crypto";
     ```
   - после `const EXT_MAX = 12;` добавить:
     ```js
     // Хеш исходного имени, когда очистка что-то потеряла: "-" + 8 hex = 9 байт,
     // на столько короче режется основа — бюджет имени прежний.
     const NAME_HASH_LEN = 8;
     ```
   - функцию `uploadFileName` целиком (doc-комментарий над ней оставить) заменить на:
     ```js
     export function uploadFileName(originalname, fsKey) {
       const rawExt = path.extname(originalname);
       const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, "").slice(0, EXT_MAX);
       const baseRaw = path.basename(originalname, rawExt);
       const cleaned = baseRaw.replace(/[^a-zA-Z0-9._-]/g, "_");
       // Без потерь (только [a-zA-Z0-9._-] и в пределах длины) — как было:
       // на эти имена опираются легаси-пути и тесты.
       if (cleaned === baseRaw && cleaned.length <= BASE_MAX && ext === rawExt) {
         return fsKey + "_" + cleaned + ext;
       }
       // Потери были: «смета.xlsx» и «отчет.xlsx» иначе обе давали "_____.xlsx"
       // и вторая затирала первую (16.11.2026). Хеш — от исходного имени.
       const hash = createHash("sha256").update(String(originalname)).digest("hex").slice(0, NAME_HASH_LEN);
       return fsKey + "_" + cleaned.slice(0, BASE_MAX - NAME_HASH_LEN - 1) + "-" + hash + ext;
     }
     ```
   - после функции `fallbackFileName` добавить:
     ```js
     // Путь для загрузки, который ничего не перезаписывает: две «image.jpg» с
     // iPhone, повторная загрузка того же файла. Занято — суффикс -2…-99 перед
     // расширением, дальше 8 hex из uuid (полный uuid не влезает в NAME_MAX при
     // длинном имени). Префикс "<ключ>_" сохраняется: легаси-сессии читают
     // загрузки по маске <ключ>_*. exists — проверка занятости (fs.existsSync
     // в сервере, заглушка в тестах).
     export function uniqueUploadPath(dir, name, exists, random = () => randomUUID().slice(0, 8)) {
       const first = path.join(dir, name);
       if (!exists(first)) return first;
       const ext = path.extname(name);
       const base = name.slice(0, name.length - ext.length);
       for (let i = 2; i <= 99; i++) {
         const candidate = path.join(dir, `${base}-${i}${ext}`);
         if (!exists(candidate)) return candidate;
       }
       for (let attempt = 0; attempt < 5; attempt++) {
         const candidate = path.join(dir, `${base}-${random()}${ext}`);
         if (!exists(candidate)) return candidate;
       }
       throw new Error("нет свободного имени для загрузки: " + name);
     }
     ```

2. `relay-agent/server.mjs`:
   - в строке импорта из `"./paths.mjs"` после `fallbackFileName,` добавить ` uniqueUploadPath,`;
   - в цикле `for (const f of req.files)` строки
     ```js
           const newPath = path.join(uploadSessionDir, uploadFileName(f.originalname, fsKey));
           try {
             fileOps.renameSync(f.path, newPath);
     ```
     заменить на
     ```js
           try {
             // Занятое имя не перезаписываем молча — суффикс (paths.mjs,
             // uniqueUploadPath). Ошибка подбора уходит в запасное имя ниже.
             const newPath = uniqueUploadPath(
               uploadSessionDir,
               uploadFileName(f.originalname, fsKey),
               (p) => fileOps.existsSync(p),
             );
             fileOps.renameSync(f.path, newPath);
     ```
     Остальное (`renamedFiles.push({ path: newPath, … })`, запасной `fallbackFileName`, `unlinkSync`) не меняется. `fileOps` в тестах — `{ ...fs, renameSync }`, `existsSync` у него есть.

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git add relay-agent/paths.mjs relay-agent/server.mjs && git commit -q -m "fix(relay): имена загрузок — хеш при потере символов, суффикс вместо перезаписи

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && cd relay-agent && source ~/.nvm/nvm.sh && for f in *.mjs; do node --check \"\$f\" || echo CHECK_FAIL \$f; done && node --test *.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'"
```
Expected: ни одного `CHECK_FAIL` и `not ok`, `# fail 0`. Это тот же набор, что `deploy-relay.sh` гоняет в staging (`node --check` и `node --test *.test.mjs`; живой test записи там включается отдельной переменной и здесь пропускается).

---

### Task 13: Итоговая проверка ветки

**Files:** нет изменений, кроме возможного merge.

- [ ] **Step 1: Свежий main в ветку**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git fetch -q origin && git log --oneline HEAD..origin/main | head -20
```
Если вывод не пуст — `git merge --no-edit origin/main` (не rebase); конфликты разрешать по смыслу обеих сторон, не выбрасывая чужое; затем `git push -q`. Если merge принёс правки в `src/chat/chat.controller.ts` или `src/chat/chat.service.ts` — перед Step 2 прогнать спеки задач 1, 3–6 и 9 (список — в карте файлов).

- [ ] **Step 2: tsc, сборка и обе половины jest — как в smoke**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund >/dev/null 2>&1 && echo DEPS_OK; (npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK) > ~/ci/wt/ins1116-final.txt 2>&1; (npm run build >/dev/null 2>&1 && echo BUILD_OK) >> ~/ci/wt/ins1116-final.txt; (cd tests && npx jest unit/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)') >> ~/ci/wt/ins1116-final.txt; npx jest src/ tests/scripts/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)' >> ~/ci/wt/ins1116-final.txt; cat ~/ci/wt/ins1116-final.txt; echo '--- новые FAIL относительно базы:'; diff <(grep '^FAIL' ~/ci/wt/ins1116-baseline.txt | sort) <(grep '^FAIL' ~/ci/wt/ins1116-final.txt | sort) | grep '^>' || echo нет"
```
Expected: `DEPS_OK`, `TSC_OK`, `BUILD_OK`; после «новые FAIL относительно базы» — `нет`. `tests/unit` грузит `dist/`, поэтому сборка — до него (без неё проверяется старый код). Одиночный красный `src/insights/deidentify.spec.ts` — известный флак по времени: перепрогнать его отдельно. Любой другой новый `FAIL` — разобраться до мержа.

- [ ] **Step 3: Релей и скрипты выката**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins1116-back && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && (cd relay-agent && node --test *.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)') && node --test tests/scripts/deploy-relay-empty-children.test.cjs 2>&1 | grep -E '^# (pass|fail)' && node tests/scripts/deploy-relay-bash32.mjs" && \
node tests/scripts/deploy-relay-bash32.mjs
```
Expected: `# fail 0` дважды и строка `✓ deploy-relay empty arrays accepted…` дважды (нода и мак с bash 3.2).

- [ ] **Step 4: Карта пунктов — ничего не потеряно**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/insights-1116 && git log --oneline 949e81fd..HEAD && echo '---' && git diff --stat 949e81fd..HEAD | tail -3 && echo '---' && git grep -n 'Ошибка запуска агента' -- src/chat/chat.service.ts src/chat/chat.controller.ts || echo 'старых строк нет'
```
Expected: пары «красный → реализация» по задачам 1–12; `старых строк нет`.

---

## После плана — только с OK владельца

Исполнитель плана на этом останавливается. Дальше — отдельными шагами, каждый с явным OK:

1. Ревью ветки (superpowers:requesting-code-review) → `git merge --no-ff` в `main` из свежего клона, пуш `main` (сверить merge-base, не пушить detached HEAD).
2. `bash ~/Downloads/spirits_back/scripts/deploy.sh` — без флагов, из `main`, не в 18:00–18:40 МСК (съёмка роликов), после проверки, что параллельно никто не катит. Бэк должен уехать раньше релея: повтор на бэке страхует новый порядок выката.
3. `bash scripts/deploy-relay.sh <BASE_SHA> <TARGET_SHA>` — BASE_SHA = коммит, совпадающий с живым релеем (сверить, на проде релей бывал не из main). Этот выкат сам проверяет новый порядок (quiet): в журнале должно быть видно ожидание тишины без шлагбаума.
4. Живая проверка: во время выката релея сообщение тестового аккаунта доходит после короткой паузы; два файла с кириллическими именами одной длины — два разных файла на релее.
5. **В тот же день, что и выкат бэка:** synthetic-runner на node-3 живёт вне `deploy.sh` — обновить его маркеры заглушек вручную (Task 1, Step 10). Без этого synthetic слепнет ровно к сценарию «релей недоступен»: бэк шлёт «Ошибка запуска ассистента», поток не пустой, HTTP 200 — и проверка остаётся зелёной (ревью Task 1).
   Владельцу заодно сказать: воронка (`funnel.service.ts`) теперь исключает и прежнюю русскую заглушку `cliFatal` — цифры за прошлые периоды немного сдвинутся.
6. Комментарии в бэклоге по каждому пункту и перевод в done. Перевод в done создаёт тему поста автоблога — отклонять темы заранее только с OK.
