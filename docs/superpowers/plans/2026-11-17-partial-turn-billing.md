# Списание за оборванный ход — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оборванный ход, после которого человек что-то получил (текст модели или файл), списывается по фактическому расходу хода — одним решением для индикатора «N токенов» и для списания, в веб-ходе и в ходе с файлом.

**Architecture:** Чистый модуль `src/chat/partial-billing.ts` — список причин и `billingDecision`. `ChatService.turnBilling` добавляет к нему отказ CLI, долетевший текстом. Веб-ход (`streamUniversalAgent`) и загрузка (`uploadAndChat` → `persistUploadTurn`) копят текст модели отдельно от служебных реплик релея и принимают решение один раз по итогам потока. От решения зависят индикатор в `end`, сумма, строка `token_consumption_tasks` (с `partial`), сторожа, журнал и `chat_quality`.

**Tech Stack:** NestJS 10 + TypeScript, jest (ts-jest). Тесты и `tsc` — только на тестовой ноде.

**Спек (источник истины):** `docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md`. План покрывает его разделы 1–3, правку комментариев, тесты и выкат. При расхождении плана и спека прав спек — остановиться и спросить.

**Раздел 4 спека (реплики релея) в этот план НЕ входит.** Его сделали в ветке `fix/insights-backlog-1116` коммитами `e6a23a24` (красный тест `relay-agent/notice-texts.test.mjs`) и `1103de42` (`fix(relay): реплики обрыва без обещания «не списаны»`). Он уезжает с выкатом релея по плану insights (`deploy-relay.sh`). **Бэк из этого плана можно выкатывать только после того, как релей с новыми репликами работает на r.linkeon.io.** Иначе будет окно, когда релей пишет «Токены за этот ход не списаны», а бэк уже списывает (см. «После плана»).

---

## Контекст для инженера с нулевым контекстом

- Бэкенд — NestJS, пути `/webhook/*`. Ходы ассистентов исполняет **релей** (`relay-agent/`, отдельный сервер `r.linkeon.io`). Бэк шлёт ему `POST /chat`, релей отвечает SSE-потоком событий:
  - `delta`/`text` — куски текста модели;
  - `notice` — служебная реплика платформы («ответ оборван…»), дописывается всегда;
  - `tool` — шаг работы;
  - `result` — итоговый текст, если `delta` не было;
  - `done` — конец хода: `usage`, `costUsd`, `turnCostUsd`, `outputFiles`, а при обрыве ещё `failed: true` и `failReason`.
- Причины обрыва, после которых человек мог что-то получить (решение владельца 16–17.11.2026 — **списывать**):
  - `transient_after_partial` — связь оборвалась посреди ответа;
  - `max_turns` — задача не уложилась в три захода;
  - `preempted` — человек сам отправил новое сообщение;
  - `transient_after_write` — связь оборвалась после действия.

  Остальные — сбой до ответа, **не списывать**: `cli_fatal` и `transient` от релея, а на бэке `cli_fatal_text` (отказ CLI долетел текстом, `looksCliFailure`), `relay_draining` и `relay_superseded` (шлагбаум выката).
- «Пришло» — это текст модели (`delta`/`text`/`result`) или файлы хода (`outputFiles`). Служебная реплика `notice` «пришедшим» не считается: релей шлёт её и тогда, когда модель не успела сказать ни слова.
- Сумма — прежняя `computeSdkCharge(usage, costUsd, text, turnCostUsd)`: счёт CLI → формула из usage → длина текста × 2. У оборванного хода запасной путь по длине берёт текст модели, а не весь ответ со служебной репликой.
- Две точки списания:
  1. веб-ход — замыкание `persistResponse` внутри `streamUniversalAgent` (`src/chat/chat.service.ts`). Число для индикатора там же считается отдельно, перед `safeWrite({ type: 'end', … })`;
  2. ход с файлом — `ChatService.persistUploadTurn`. Индикатор `shown` считает контроллер (`ChatController.uploadAndChat`, `src/chat/chat.controller.ts`).
- Списание — строка `INSERT INTO token_consumption_tasks` через `addTokenTask(userId, 0, tokens, agentId, facts)`. `facts` (`ChargeFacts`) целиком уезжает в `metadata`, оттуда `TokenAccountingService` переносит их в `token_transactions` без фильтра полей.
- Что сознательно **не меняется**:
  - голосовые вызовы (`generateAgentReplyWithCharge`) и фоновые ходы (`agentReply`);
  - Telegram-боты;
  - обучение профиля, строка истории, приписка пробы (`guestCarryConsumed` — только успех);
  - поле `replyChars` метаданных;
  - ход, у которого поток релея упал без `done` (главный `catch` веб-хода, `upstreamError` загрузки): решение по нему то же, что сегодня.
- Справка ассистентов (`src/platform-kb/articles/chat.ts`, `tokens.ts`) обещает «оборванный ход не списывается». Спек её не упоминает, но концепция требует «без ложных обещаний», а по справке отвечают ассистенты и ИИ-поддержка. Поэтому правим её отдельной задачей (Task 4).

## Глобальные правила (читать перед КАЖДОЙ задачей)

1. **Где работать.** Ветка `feat/partial-turn-billing`, воркдерево `/Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing`. Общий чекаут `~/Downloads/spirits_back` и чужие воркдеревья (`.worktrees/insights-1116` и др.) не трогать. Bash сбрасывает cwd после каждого вызова — `cd <воркдерево> && …` в каждой команде.
2. **Тесты и tsc — только на тестовой ноде** `dv@85.192.61.231`, в CI-воркдереве `~/ci/wt/pb1117-back`, на конкретном sha. Мак jest не тянет. Шаблон прогона:
   ```bash
   cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git push -q -u origin feat/partial-turn-billing && SHA=$(git rev-parse HEAD) && \
   ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest <файлы> 2>&1 | tail -40"
   ```
   - `source ~/.nvm/nvm.sh` — в каждой ssh-команде; `ssh -n` — всегда.
   - Гейт типов: `npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK` (jest типы не проверяет).
   - На ноде не трогать `~/spirits_back`, `~/spirits_front`, `~/dev` — только `~/ci/`.
3. **TDD.** Красный тест — отдельным коммитом `test(<область>): … — красный`, запушен и проверен красным на ноде. Затем реализация отдельным коммитом. Без amend, force, rebase.
4. **Коммиты.** Явные пути в `git add` (никаких `-A` и `.`). Пушить только `feat/partial-turn-billing`. Каждое сообщение коммита, включая merge, заканчивается строкой:
   ```
   Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
   ```
5. **Никаких выкатов** в ходе задач. `deploy.sh` — только после ревью, мержа и явного OK владельца, и только после выката релея с новыми репликами.
6. **Репозиторий публичный:** ни секретов, ни телефонов, ни имён и цитат пользователей. В тестах — `u1`.
7. **Кириллицу писать буквально.** Инструмент Write портит `\uXXXX`.
8. **Номера строк — подсказки.** Искать по тексту-якорю: файлы меняются параллельными сессиями.
9. **Чужие ожидания в тестах не переписывать вслепую** — только перечисленные в таблице «Тесты старого правила» ниже.
10. Комментарии в коде — по-русски, в духе соседнего кода. В текстах для людей — «ассистент», не «агент».
11. **zsh:** глобы в кавычках, разделители — `echo '---'`.
12. **Перед Task 2 и Task 3:** `cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git fetch -q origin && git log --oneline HEAD..origin/fix/insights-backlog-1116 -- src/chat/chat.service.ts src/chat/chat.controller.ts`. Если базовая ветка что-то туда принесла — `git merge --no-ff origin/fix/insights-backlog-1116` с сообщением и строкой из правила 4 (не rebase). Затем прогнать затронутые спеки (список — в Step 4 задачи) и только потом начинать.

## Карта файлов

| Файл | Что | Задача |
|---|---|---|
| `src/chat/partial-billing.ts`, `partial-billing.spec.ts` (новые) | `PARTIAL_BILLED_REASONS`, `TurnDelivery`, `BillingDecision`, `billingDecision` | 1 |
| `src/chat/chat.service.ts` | `ChargeFacts.partial`, `turnBilling`; веб-ход: `modelText`, `decideBilling`, индикатор, `persistResponse`, комментарии | 2 |
| `src/chat/chat.service.ts` | `persistUploadTurn`: `modelText`, `files`, решение, журнал, метаданные | 3 |
| `src/chat/chat.partial-billing.spec.ts` (новый) | Проводка: веб-ход (P1–P6), ход с файлом (U1–U4) | 2, 3 |
| `src/chat/chat.service.failed-turn.spec.ts` | «за оборванный ход токены не списываются» → два теста, шапка | 2 |
| `src/chat/chat.cost-growth.spec.ts` | «оборванный ход не выставлен…» → `cli_fatal` + новый тест, шапка | 2 |
| `src/chat/chat.controller.ts` | `uploadAndChat`: `modelText`, `shown`, вызов `persistUploadTurn` | 3 |
| `src/chat/chat.upload-billing.spec.ts` | Название и комментарий теста с `interrupted` | 3 |
| `src/platform-kb/articles/chat.ts`, `tokens.ts`, `src/platform-kb/interrupted-turn-billing.spec.ts` (новый) | Справка без обещания «оборванный ход бесплатен» | 4 |

**Порядок задач:** 0 → 1 → 2 → 3 → 4 → 5. Task 4 от 1–3 не зависит, но коммиты — последовательно в одну ветку. Task 3 — только после Task 2: она использует `turnBilling` и `ChargeFacts.partial` оттуда.

## Тесты старого правила

Тесты, закрепляющие «оборванный ход не списывается». Решать по каждому по причине обрыва: она в списке или вне его.

| Спек → тест | Причина | В списке? | Что делаем |
|---|---|---|---|
| `chat.service.failed-turn.spec.ts` → «за оборванный ход токены не списываются» | `transient_after_partial` + текст | да | Task 2: заменить на «оборванный ход с текстом модели списывается за пришедшее» (строка списания есть, `partial`, в истории — та же цена). Прежние ожидания переезжают в новый тест с `cli_fatal` |
| `chat.service.failed-turn.spec.ts` → «пояснение платформы доходит до пользователя…» | `preempted` + текст | да | без правки: проверяет только текст ответа |
| `chat.service.failed-turn.spec.ts` → «оборванный ход не проходит в телеметрии как удачный» | `max_turns` + текст | да | без правки: `ok: false`, `failed: true`, `fail_reason` остаются |
| `chat.service.failed-turn.spec.ts` → «отказ CLI не показывается дословно и не тарифицируется» | `cli_fatal_text`, `done.failed: false` | нет | без правки (индикатор теперь тоже 0 — тест его не смотрит) |
| `chat.cost-growth.spec.ts` → «оборванный ход не выставлен — и в сторож не попадает» | `transient_after_partial` + текст | да | Task 2: причина → `cli_fatal`, ожидания прежние; рядом новый тест — оборванный ход списан и виден сторожу |
| `chat.cost-growth.spec.ts` → (загрузка) «прерванный ход не выставлен — и в сторож не попадает» | `interrupted` | нет | без правки |
| `chat.service.turn-cost-billing.spec.ts` → «прерванный ход не выставлен — и алерта о его списании нет» | `interrupted` | нет | без правки |
| `chat.upload-billing.spec.ts` → «прерванный ход не тарифицируется — обещание в тексте держится» | `interrupted` | нет | Task 3: ожидания без правки. Меняются название и комментарий: обещания релея больше нет |
| `chat.upload-billing.spec.ts` → «отказ CLI, долетевший текстом ответа, бесплатен» | `cli_fatal_text` | нет | без правки |
| `chat.relay-drain.spec.ts` → W2, W2b, W2c, W5, W7, W7b, U-W1 | `relay_draining` | нет | без правки |
| `chat.relay-drain.spec.ts` → W3, U-W2, U-W2b | `relay_superseded` | нет | без правки |
| `chat.service.upstream-error-billing.spec.ts` (все) | `done.failed` нет | — | без правки: путь успеха и страж запасного пути по длине |
| `chat.service.agent-version-test.spec.ts`, `chat.service.routine-turns.spec.ts`, `routine-push/*` (`failed: true`) | голос и фоновые ходы | — | путь не трогаем |

---

### Task 0: Базовая ветка, воркдерево на ноде и базовая линия

**Files:** изменений в коде нет; возможен merge-коммит.

- [ ] **Step 1: Подтянуть базовую ветку**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git fetch -q origin && git log --oneline HEAD..origin/fix/insights-backlog-1116
```
На 17.11 вывод — `1103de42 fix(relay): реплики обрыва без обещания «не списаны»` и `e6a23a24 test(relay): …`. Если вывод не пуст:
```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git merge -q --no-ff origin/fix/insights-backlog-1116 -m "merge fix/insights-backlog-1116 в feat/partial-turn-billing — реплики релея без обещания

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q -u origin feat/partial-turn-billing && git log --oneline -3
```
Expected: merge-коммит сверху. Конфликтов быть не должно: на ветке пока только спек и этот план.

- [ ] **Step 2: Создать CI-воркдерево на ноде**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && (test -d ~/ci/wt/pb1117-back || git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/pb1117-back ${SHA}) && cd ~/ci/wt/pb1117-back && git checkout -q --detach ${SHA} && git log --oneline -1"
```
Expected: строка с sha ветки.

- [ ] **Step 3: Установить зависимости**

```bash
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund >/dev/null 2>&1 && echo ROOT_OK"
```
Expected: `ROOT_OK`. Бэк ставится `npm ci`, не pnpm.

- [ ] **Step 4: Базовая линия — tsc, сборка и обе половины jest, как в smoke**

```bash
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && source ~/.nvm/nvm.sh && (npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK) > ~/ci/wt/pb1117-baseline.txt 2>&1; (npm run build >/dev/null 2>&1 && echo BUILD_OK) >> ~/ci/wt/pb1117-baseline.txt; (cd tests && npx jest unit/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)') >> ~/ci/wt/pb1117-baseline.txt; npx jest src/ tests/scripts/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)' >> ~/ci/wt/pb1117-baseline.txt; cat ~/ci/wt/pb1117-baseline.txt"
```
Expected: `TSC_OK`, `BUILD_OK` и итоговые строки двух прогонов. Это две половины smoke (`tests/smoke/run.sh`). `tests/unit` грузит собранный `dist/`, поэтому сборка идёт до него, иначе проверяется старый код. Путь `src/` указан явно: без него jest подхватывает чужие `.worktrees/`. Полный jest бэка красный «by design»: список `FAIL` запоминаем как базу, в Task 5 сравниваем дельтой.

---

### Task 1: Правило — в одном модуле

Спек §1.

**Files:**
- Create: `src/chat/partial-billing.ts`
- Create: `src/chat/partial-billing.spec.ts`

- [ ] **Step 1: Красный тест**

Create `src/chat/partial-billing.spec.ts`:

```ts
import { billingDecision, PARTIAL_BILLED_REASONS, TurnDelivery } from './partial-billing';

/**
 * Списание за оборванный ход (решение владельца 16–17.11.2026, спек
 * docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md, §1).
 * Таблица: успех; четыре причины из списка — с текстом модели, с файлом, без
 * того и другого; причины вне списка — даже с текстом и файлами.
 */

const LISTED = ['transient_after_partial', 'max_turns', 'preempted', 'transient_after_write'];
// cli_fatal и transient — сбой до ответа на релее; cli_fatal_text — отказ CLI,
// долетевший текстом; relay_draining и relay_superseded — шлагбаум выката;
// unknown — done.failed без причины (релей старой сборки).
const NOT_LISTED = ['cli_fatal', 'transient', 'cli_fatal_text', 'relay_draining', 'relay_superseded', 'unknown'];

const failed = (failReason: string, o: Partial<TurnDelivery> = {}): TurnDelivery =>
  ({ failed: true, failReason, modelChars: 0, files: 0, ...o });

describe('billingDecision', () => {
  it('успешный ход списывается как раньше — с текстом и без', () => {
    expect(billingDecision({ failed: false, failReason: '', modelChars: 120, files: 0 })).toEqual({ billable: true });
    expect(billingDecision({ failed: false, failReason: '', modelChars: 0, files: 0 })).toEqual({ billable: true });
  });

  it('в списке ровно четыре причины решения владельца', () => {
    expect([...PARTIAL_BILLED_REASONS].sort()).toEqual([...LISTED].sort());
  });

  it.each(LISTED)('%s с текстом модели — списание с пометкой причины', (reason) => {
    expect(billingDecision(failed(reason, { modelChars: 15 }))).toEqual({ billable: true, partial: reason });
  });

  it.each(LISTED)('%s с файлом без текста — тоже списание', (reason) => {
    expect(billingDecision(failed(reason, { files: 1 }))).toEqual({ billable: true, partial: reason });
  });

  it.each(LISTED)('%s без текста и файлов (одна служебная реплика) — не списывается', (reason) => {
    expect(billingDecision(failed(reason))).toEqual({ billable: false });
  });

  it.each(NOT_LISTED)('%s вне списка — не списывается и с текстом, и с файлами', (reason) => {
    expect(billingDecision(failed(reason, { modelChars: 500, files: 2 }))).toEqual({ billable: false });
  });
});
```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/chat/partial-billing.spec.ts && git commit -q -m "test(chat): правило списания оборванного хода — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/partial-billing.spec.ts 2>&1 | tail -20"
```
Expected: FAIL — `Cannot find module './partial-billing'`.

- [ ] **Step 3: Реализация**

Create `src/chat/partial-billing.ts`:

```ts
/**
 * Списание за оборванный ход — за то, что успело прийти (решение владельца
 * 16–17.11.2026, спек docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md).
 *
 * До 17.11 ход без финального ответа (`done.failed` от релея) не
 * тарифицировался вовсе, а релей писал человеку «Токены за этот ход не
 * списаны». Теперь частичный ответ, оборванный сбоем, списывается по
 * фактическому расходу хода — той же формулой, что у обычного
 * (ChatService.computeSdkCharge).
 *
 * Правило одно на индикатор «N токенов» в `end` и на точку списания — у
 * веб-хода (streamUniversalAgent) и у хода с файлом (uploadAndChat →
 * persistUploadTurn). Разойдись они, человек увидел бы одно, а списалось бы
 * другое. Отказ CLI, долетевший текстом, добавляет ChatService.turnBilling.
 */

/**
 * Обрывы, после которых человек мог что-то получить (решение владельца 17.11.2026):
 * - transient_after_partial — связь с моделью оборвалась посреди ответа;
 * - max_turns — задача не уложилась в три захода, большая часть работы сделана;
 * - preempted — человек сам отправил новое сообщение, ответ прерван;
 * - transient_after_write — связь оборвалась после действия (картинка, запись в календарь).
 *
 * Не входят — сбой до ответа: cli_fatal и transient (релей), cli_fatal_text
 * (отказ CLI, долетевший текстом), relay_draining и relay_superseded
 * (шлагбаум выката).
 */
export const PARTIAL_BILLED_REASONS: ReadonlySet<string> = new Set([
  'transient_after_partial',
  'max_turns',
  'preempted',
  'transient_after_write',
]);

export interface TurnDelivery {
  /** done.failed от релея — или сбой, выставленный бэком (шлагбаум, отказ CLI текстом). */
  failed: boolean;
  failReason: string;
  /** Символы текста МОДЕЛИ, ушедшие человеку (delta/text/result), — без служебных реплик релея. */
  modelChars: number;
  /** Файлы хода, ушедшие человеку (outputFiles релея). */
  files: number;
}

export interface BillingDecision {
  billable: boolean;
  /** Списано за оборванный ход — причина обрыва, иначе undefined. */
  partial?: string;
}

/**
 * Служебная реплика релея («ответ оборван…») «пришедшим» не считается: она
 * приходит и тогда, когда модель не успела сказать ни слова. Поэтому
 * modelChars считается без неё.
 */
export function billingDecision(d: TurnDelivery): BillingDecision {
  if (!d.failed) return { billable: true };
  if (PARTIAL_BILLED_REASONS.has(d.failReason) && (d.modelChars > 0 || d.files > 0)) {
    return { billable: true, partial: d.failReason };
  }
  return { billable: false };
}
```

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/chat/partial-billing.ts && git commit -q -m "feat(chat): правило списания оборванного хода — partial-billing.ts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/partial-billing.spec.ts 2>&1 | tail -15 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS (20 тестов), `TSC_OK`.

---

### Task 2: Веб-ход — одно решение на индикатор и списание

Спек §2. Перед началом — правило 12.

**Files:**
- Modify: `src/chat/chat.service.ts` (импорты ~37; `ChargeFacts` ~118; `chunks` ~2247; комментарий у `let turnFailed` ~2323; `let relayRefusal` ~2350; `persistResponse` ~2355–2513; обработчик потока в `callUpstreamOnce` ~2663–2691; индикатор ~3009; доки `alertExpensiveTurn` ~3813; перед `computeUploadCharge` ~3878)
- Create: `src/chat/chat.partial-billing.spec.ts`
- Modify: `src/chat/chat.service.failed-turn.spec.ts`
- Modify: `src/chat/chat.cost-growth.spec.ts`

Что меняется для человека. Оборванный ход, после которого пришёл текст модели или файл, списывается по расходу хода. Индикатор под ответом показывает ровно списанное. Сбой без ответа — как раньше: ни списания, ни числа (раньше индикатор показывал расход и у несписанного хода).

- [ ] **Step 1: Красные тесты**

Create `src/chat/chat.partial-billing.spec.ts`:

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Списание за оборванный ход — за то, что успело прийти (решение владельца
 * 16–17.11.2026, бэклог 85841119; спек
 * docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md).
 *
 * Правило — partial-billing.ts (своя таблица в partial-billing.spec.ts). Здесь —
 * проводка: одно решение на индикатор «N токенов» в `end` и на точку списания
 * (token_consumption_tasks), у веб-хода и у хода с файлом. Обвязка — как в
 * chat.relay-drain.spec.ts.
 */

const forUsd = (usd: number) => Math.max(1, Math.ceil(usd * SEAT_TOKENS_PER_USD));

/** Текст модели и служебная реплика релея разной длины — запасной путь по длине их различает. */
const MODEL = 'Нашёл три подходящих варианта, начинаю сравнивать цены';
const NOTICE = '\n\n_(связь с моделью прервалась, ответ оборван — повторите вопрос.)_';
const PREEMPTED = '\n\n_(ответ прерван: вы отправили новое сообщение, и ассистент переключился на него.)_';

const delta = (text: string) => ({ type: 'delta', text });
const notice = (text: string) => ({ type: 'notice', text });
/** done с расходом хода $0.50 по счёту CLI; usage нет — списание идёт source=cost. */
const done = (extra: Record<string, unknown> = {}) => ({ type: 'done', costUsd: 0.5, turnCostUsd: 0.5, ...extra });

function sse(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeService() {
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
  const track = jest.fn();
  (svc as any).events = { track };
  const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
  const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => {});
  return { svc, calls, track, warn, log };
}

const queue: Readable[] = [];
const post = jest.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('апстрим для этого вызова не подготовлен тестом');
  return { data: next };
});

beforeEach(() => {
  queue.length = 0;
  post.mockClear();
  (axios as any).default = { post };
  (axios as any).post = post;
});

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function newRes(): any {
  return {
    status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
    end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
  };
}

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
/** Индикатор «N токенов» — usage.total единственного `end`. */
function shownTokens(res: any): number {
  const ends = writes(res).filter((w) => w.type === 'end');
  expect(ends).toHaveLength(1);
  return ends[0].usage.total;
}

type Calls = { sql: string; params: any[] }[];
const tokenRows = (calls: Calls) => calls.filter((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
/** Списанное: input + output строки token_consumption_tasks; undefined — строки нет. */
function charged(calls: Calls): number | undefined {
  const rows = tokenRows(calls);
  if (rows.length === 0) return undefined;
  expect(rows).toHaveLength(1);
  return Number(rows[0].params[3]) + Number(rows[0].params[4]);
}
/** Метаданные списания (ChargeFacts). */
const chargeMeta = (calls: Calls) => JSON.parse(String(tokenRows(calls)[0].params[5]));
/** tokens_used строки ответа ассистента в истории. */
function historyTokens(calls: Calls): number | undefined {
  const rows = calls.filter((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /tokens_used/.test(c.sql));
  return rows.length ? Number(rows[rows.length - 1].params[3]) : undefined;
}
/** props итоговой записи chat_quality хода (у неё, в отличие от self-heal, есть ok). */
function quality(track: jest.Mock): any {
  const q = track.mock.calls.filter(([n, p]: any[]) => n === 'chat_quality' && p?.props && 'ok' in p.props);
  expect(q).toHaveLength(1);
  return q[0][1].props;
}
const lines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

async function webTurn(svc: ChatService, events: any[]) {
  queue.push(sse(events));
  const res = newRes();
  await (svc as any).streamUniversalAgent(
    'u1', 'сравни варианты', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  await settle();
  return res;
}

describe('веб-ход: оборванный ход списывается за пришедшее', () => {
  it('P1: transient_after_partial с текстом — списание с пометкой, индикатор = списанному, partial_billed', async () => {
    const { svc, calls, track, warn } = makeService();
    const res = await webTurn(svc, [
      delta(MODEL), notice(NOTICE), done({ failed: true, failReason: 'transient_after_partial' }),
    ]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls)).toMatchObject({ partial: 'transient_after_partial', source: 'cost', turnCostUsd: 0.5 });
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(historyTokens(calls)).toBe(forUsd(0.5));
    // Для мониторинга ход по-прежнему неудачный — и видно, что он списан.
    expect(quality(track)).toMatchObject({
      ok: false, failed: true, fail_reason: 'transient_after_partial', partial_billed: true,
    });
    expect(lines(warn)).toContainEqual(
      expect.stringContaining(`billing[partial:transient_after_partial:cost]: tokens=${forUsd(0.5)} `),
    );
  });

  it('P2: preempted до первого слова (одна служебная реплика) — без списания, индикатор 0', async () => {
    const { svc, calls, track, warn } = makeService();
    const res = await webTurn(svc, [notice(PREEMPTED), done({ failed: true, failReason: 'preempted' })]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(historyTokens(calls)).toBe(0);
    expect(quality(track).partial_billed).toBeUndefined();
    expect(lines(warn)).toContainEqual(expect.stringContaining('billing[skipped:preempted]'));
  });

  it('P3: сбой до ответа (cli_fatal) — без списания, даже если обрывок текста успел уйти', async () => {
    const { svc, calls, track } = makeService();
    const res = await webTurn(svc, [
      delta(MODEL), notice('\n\n_(модель недоступна)_'), done({ failed: true, failReason: 'cli_fatal' }),
    ]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(quality(track)).toMatchObject({ failed: true, fail_reason: 'cli_fatal' });
    expect(quality(track).partial_billed).toBeUndefined();
  });

  it('P4: max_turns без usage и стоимости — по длине текста модели, служебная реплика не в счёт', async () => {
    const { svc, calls, warn } = makeService();
    const res = await webTurn(svc, [
      delta(MODEL), notice(NOTICE), { type: 'done', failed: true, failReason: 'max_turns' },
    ]);

    // Множитель запасного пути — 2 (SDK_TEXT_MULTIPLIER). С репликой длина была бы больше.
    expect(charged(calls)).toBe(MODEL.length * 2);
    expect(shownTokens(res)).toBe(MODEL.length * 2);
    expect(chargeMeta(calls)).toMatchObject({ partial: 'max_turns', source: 'length' });
    expect(lines(warn)).toContainEqual(
      expect.stringContaining(`billing[partial:max_turns:length]: tokens=${MODEL.length * 2} `),
    );
  });

  it('P5: transient_after_write без текста, но с файлом — списание за файл', async () => {
    const { svc, calls, track } = makeService();
    const res = await webTurn(svc, [
      notice('_(связь с моделью прервалась после действия — проверьте результат, возможно всё прошло; при необходимости повторите)_'),
      done({
        failed: true, failReason: 'transient_after_write',
        outputFiles: [{ name: 'plan.pdf', url: '/files/u1_7_ru/plan.pdf' }],
      }),
    ]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls)).toMatchObject({ partial: 'transient_after_write' });
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(quality(track).partial_billed).toBe(true);
  });

  it('P6: обычный ход — как раньше: списание без пометки, журнал billing[cost]', async () => {
    const { svc, calls, track, log } = makeService();
    const res = await webTurn(svc, [delta(MODEL), done()]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls).partial).toBeUndefined();
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(quality(track)).toMatchObject({ ok: true, failed: false });
    expect(quality(track).partial_billed).toBeUndefined();
    expect(lines(log)).toContainEqual(expect.stringContaining(`billing[cost]: tokens=${forUsd(0.5)} `));
  });
});
```

Правка `src/chat/chat.service.failed-turn.spec.ts`.

1. В шапке файла строки
   ```ts
    *   2. оборванный ход тарифицировался как обычный (17 717 токенов за 209
    *      символов) и уезжал в телеметрию как {ok:true}.
    */
   ```
   заменить на
   ```ts
    *   2. оборванный ход тарифицировался как обычный (17 717 токенов за 209
    *      символов) и уезжал в телеметрию как {ok:true}.
    *
    * С 17.11.2026 (решение владельца, partial-billing.ts) оборванный ход, после
    * которого человек что-то получил, снова списывается — по фактическому
    * расходу хода. В телеметрии он по-прежнему не ok.
    */
   ```

2. Тест целиком
   ```ts
     it('за оборванный ход токены не списываются', async () => {
       const { svc, calls } = makeService();
       const t = startTurn(svc, 'u1');

       t.upstream.push(delta('частичный текст'));
       t.upstream.push(notice('_(связь с моделью прервалась)_'));
       t.upstream.push(done({ failed: true, failReason: 'transient_after_partial' }));
       t.upstream.push(null);
       await t.finished;
       await settle();

       // Ни строки учёта, ни ненулевой цены в истории.
       expect(billingRow(calls)).toBeUndefined();
       expect(savedAnswer(calls)!.tokens).toBe(0);
     });
   ```
   заменить на
   ```ts
     it('оборванный ход с текстом модели списывается за пришедшее (решение владельца 17.11.2026)', async () => {
       // До 17.11 такой ход не тарифицировался вовсе. Теперь — по фактическому
       // расходу хода (partial-billing.ts); в истории — та же цена.
       const { svc, calls } = makeService();
       const t = startTurn(svc, 'u1');

       t.upstream.push(delta('частичный текст'));
       t.upstream.push(notice('_(связь с моделью прервалась)_'));
       t.upstream.push(done({ failed: true, failReason: 'transient_after_partial' }));
       t.upstream.push(null);
       await t.finished;
       await settle();

       const row = billingRow(calls);
       expect(row).toBeDefined();
       expect(Number(row!.params[4])).toBeGreaterThan(0);
       expect(savedAnswer(calls)!.tokens).toBe(Number(row!.params[4]));
       expect(JSON.parse(String(row!.params[5]))).toMatchObject({ partial: 'transient_after_partial' });
     });

     it('сбой до ответа (cli_fatal) не списывается, даже если обрывок текста успел уйти', async () => {
       const { svc, calls } = makeService();
       const t = startTurn(svc, 'u1');

       t.upstream.push(delta('частичный текст'));
       t.upstream.push(notice('_(модель недоступна)_'));
       t.upstream.push(done({ failed: true, failReason: 'cli_fatal' }));
       t.upstream.push(null);
       await t.finished;
       await settle();

       // Ни строки учёта, ни ненулевой цены в истории.
       expect(billingRow(calls)).toBeUndefined();
       expect(savedAnswer(calls)!.tokens).toBe(0);
     });
   ```

Правка `src/chat/chat.cost-growth.spec.ts`.

1. В шапке строки
   ```ts
    * только когда списание действительно записано: пустой ответ, оборванный ход
    * и сбой записи истории до строки списания не доходят — значит, и до сторожа.
   ```
   заменить на
   ```ts
    * только когда списание действительно записано: пустой ответ, несписанный
    * сбой и сбой записи истории до строки списания не доходят — значит, и до
    * сторожа. Оборванный ход, списанный за пришедшее (partial-billing.ts), —
    * обычное списание: сторож его видит.
   ```

2. Тест целиком
   ```ts
     it('оборванный ход не выставлен — и в сторож не попадает', async () => {
       const costGrowth = { recordTurn: jest.fn(async () => {}) };
       const { svc, calls } = makeService(costGrowth);

       await runTurn(svc, [
         { type: 'delta', text: 'частичный текст' },
         { type: 'notice', text: '_(связь с моделью прервалась)_' },
         { type: 'done', costUsd: 0.5, failed: true, failReason: 'transient_after_partial' },
       ]);

       expect(billingRow(calls)).toBeUndefined();
       expect(costGrowth.recordTurn).not.toHaveBeenCalled();
     });
   ```
   заменить на
   ```ts
     it('сбой без ответа не выставлен — и в сторож не попадает', async () => {
       const costGrowth = { recordTurn: jest.fn(async () => {}) };
       const { svc, calls } = makeService(costGrowth);

       await runTurn(svc, [
         { type: 'delta', text: 'частичный текст' },
         { type: 'notice', text: '_(модель недоступна)_' },
         { type: 'done', costUsd: 0.5, failed: true, failReason: 'cli_fatal' },
       ]);

       expect(billingRow(calls)).toBeUndefined();
       expect(costGrowth.recordTurn).not.toHaveBeenCalled();
     });

     it('оборванный ход с текстом списан за пришедшее — сторож видит списанное', async () => {
       const costGrowth = { recordTurn: jest.fn(async () => {}) };
       const { svc, calls } = makeService(costGrowth);

       await runTurn(svc, [
         { type: 'delta', text: 'частичный текст' },
         { type: 'notice', text: '_(связь с моделью прервалась)_' },
         { type: 'done', costUsd: 0.5, failed: true, failReason: 'transient_after_partial' },
       ]);

       expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
       const [, turn] = costGrowth.recordTurn.mock.calls[0] as any[];
       expect(turn.tokens).toBe(forUsd(0.5));
       const [, , , inputTokens, outputTokens] = billingRow(calls)!.params;
       expect(turn.tokens).toBe(Number(inputTokens) + Number(outputTokens));
     });
   ```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/chat/chat.partial-billing.spec.ts src/chat/chat.service.failed-turn.spec.ts src/chat/chat.cost-growth.spec.ts && git commit -q -m "test(chat): веб-ход — списание за оборванный ход и индикатор по тому же решению — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.partial-billing.spec.ts src/chat/chat.service.failed-turn.spec.ts src/chat/chat.cost-growth.spec.ts 2>&1 | tail -40"
```
Expected: FAIL.
- P1, P4, P5 — строки списания нет (`charged` → `undefined`).
- P2, P3 — индикатор `forUsd(0.5)` вместо 0.
- `failed-turn` «оборванный ход с текстом модели списывается…» и `cost-growth` «оборванный ход с текстом списан…» — строки списания нет.
- P6 и тесты с `cli_fatal` — зелёные (страж «как раньше»).

- [ ] **Step 3: Реализация**

Всё в `src/chat/chat.service.ts`.

1. Импорт. После строки `import { chatFailureText } from './chat-failure-texts';` добавить:
   ```ts
   import { BillingDecision, TurnDelivery, billingDecision } from './partial-billing';
   ```

2. `ChargeFacts` (~118). Строку
   ```ts
     replyChars: number;
   }
   ```
   (последнее поле интерфейса `ChargeFacts`, перед `/** turn — счёт CLI за ход…`) заменить на
   ```ts
     replyChars: number;
     /**
      * Списано за оборванный ход — причина обрыва из done.failReason
      * (partial-billing.ts, решение владельца 17.11.2026). Нет поля — обычный ход.
      */
     partial?: string;
   }
   ```

3. Текст модели (~2247). Строку
   ```ts
       const chunks: string[] = []; // hoisted so catch block can access partial response
   ```
   заменить на
   ```ts
       const chunks: string[] = []; // hoisted so catch block can access partial response
       // Текст МОДЕЛИ, ушедший человеку (delta/text/result), — без служебных
       // реплик релея (notice), ссылок на файлы и дописок бэка (маркеры,
       // карточки). По нему решается, было ли что списывать за оборванный ход, и
       // считается длина для запасного пути списания (partial-billing.ts).
       let modelText = '';
   ```

4. Комментарий у `turnFailed` (~2323). Блок
   ```ts
       // Релей сообщил, что ход закончился БЕЗ финального ответа: упёрлись в потолок
       // шагов, ход прерван новым сообщением пользователя, отказ CLI или сбой связи.
       // Такой ход не тарифицируется — платить за пустоту пользователь не должен.
       // Расход перед Anthropic при этом реален, поэтому частота таких ходов уезжает
       // в chat_quality: рост — это счёт, который мы оплачиваем в одиночку.
       let turnFailed = false;
   ```
   заменить на
   ```ts
       // Релей сообщил, что ход закончился БЕЗ финального ответа: упёрлись в потолок
       // шагов, ход прерван новым сообщением пользователя, отказ CLI или сбой связи.
       // С 17.11.2026 (решение владельца) такой ход списывается по фактическому
       // расходу, если человек успел что-то получить — текст модели или файл, — и
       // причина из PARTIAL_BILLED_REASONS (partial-billing.ts). Сбой, после
       // которого не пришло ничего, не тарифицируется. Для мониторинга ход в любом
       // случае неудачный: частота таких ходов уезжает в chat_quality (failed,
       // fail_reason, partial_billed) — несписанный расход мы оплачиваем в одиночку.
       let turnFailed = false;
   ```

5. Решение о списании (~2350). Строку
   ```ts
       let relayRefusal: string | undefined;
   ```
   заменить на
   ```ts
       let relayRefusal: string | undefined;

       // Решение о списании — одно на ход (partial-billing.ts): его читают и
       // индикатор «N токенов» в `end`, и persistResponse; разойдись они — человек
       // увидел бы одно, а списалось бы другое. Зовётся по итогам потока, когда
       // turnFailed, текст модели и файлы хода уже известны. Текст — из chunks, а
       // не fullText persistResponse: тот подменяет отказ CLI заглушкой, а
       // turnBilling узнаёт отказ именно по исходному тексту.
       const decideBilling = (): BillingDecision => this.turnBilling(
         this.stripLeakedToolSyntax(chunks.join('').trim()),
         { failed: turnFailed, failReason, modelChars: modelText.length, files: pendingFiles.length },
       );
   ```

6. `persistResponse`, после проверки отказа CLI (~2376). Строки
   ```ts
           fullText = chatFailureText('cliFatal', userLanguage, { storeBuild });
         }
         if (final) {
   ```
   заменить на
   ```ts
           fullText = chatFailureText('cliFatal', userLanguage, { storeBuild });
         }
         // Решение о списании — то же, что ушло в индикатор `end` (decideBilling
         // выше): отказ CLI оно узнаёт само, по исходному тексту из chunks.
         const billing = decideBilling();
         if (final) {
   ```

7. `chat_quality` (~2396). Строки
   ```ts
               fail_reason: failReason || undefined,
               relay_refusal: relayRefusal,
   ```
   заменить на
   ```ts
               fail_reason: failReason || undefined,
               // Оборванный ход, списанный за пришедшее (partial-billing.ts): для
               // мониторинга он по-прежнему failed, а списание видно здесь.
               partial_billed: billing.partial ? true : undefined,
               relay_refusal: relayRefusal,
   ```

8. Сумма и журнал (~2421). Блок
   ```ts
         const charge = this.computeSdkCharge(agentUsage, agentCostUsd, fullText, agentTurnCost.usd);
         // Ход без финального ответа пользователю не выставляется — решение владельца.
         // Расход перед Anthropic всё равно понесён, поэтому пишем его в лог явно:
         // иначе «бесплатные» ходы станут невидимой статьёй затрат.
         const textCost = turnFailed ? 0 : charge.tokens;
         const logLine = turnFailed
           ? `billing[skipped:${failReason}]: ход без финального ответа — не тарифицирован, ` +
             `иначе списали бы ${charge.tokens} (${charge.note})`
           : `billing[${charge.source}]: tokens=${textCost} ${charge.note}`;
   ```
   заменить на
   ```ts
         // У оборванного хода длина для запасного пути — текст модели, без
         // служебной реплики релея и дописок бэка (partial-billing.ts).
         const charge = this.computeSdkCharge(
           agentUsage, agentCostUsd, billing.partial ? modelText : fullText, agentTurnCost.usd,
         );
         // Решение владельца 17.11.2026: оборванный ход, после которого человек
         // что-то получил, списывается по фактическому расходу — billing[partial:…].
         // Сбой без ответа не выставляется. Расход перед Anthropic всё равно
         // понесён, поэтому пишем его в лог явно: иначе «бесплатные» ходы станут
         // невидимой статьёй затрат.
         const textCost = billing.billable ? charge.tokens : 0;
         const logLine = !billing.billable
           ? `billing[skipped:${failReason}]: ход без финального ответа — не тарифицирован, ` +
             `иначе списали бы ${charge.tokens} (${charge.note})`
           : billing.partial
             ? `billing[partial:${billing.partial}:${charge.source}]: tokens=${textCost} ${charge.note}`
             : `billing[${charge.source}]: tokens=${textCost} ${charge.note}`;
   ```
   Следующие строки `if (turnFailed || charge.source === 'length') this.logger.warn(logLine);` / `else this.logger.log(logLine);` не трогать: оборванный ход — `turnFailed`, его строка уходит warn. `!billing.billable` здесь всегда означает `turnFailed`: отказ CLI текстом выставил `turnFailed` выше.

9. Комментарий у `alertExpensiveTurn` (~2440). Строки
   ```ts
         // Сравниваем charge.tokens, а не textCost: у оборванного хода textCost=0,
         // и дорогой сбой иначе прошёл бы молча — а он-то как раз и интересен.
   ```
   заменить на
   ```ts
         // Сравниваем charge.tokens, а не textCost: у несписанного сбоя textCost=0,
         // и дорогой сбой иначе прошёл бы молча — а он-то как раз и интересен.
   ```

10. Строка списания и сторожа (~2468). Блок
    ```ts
            if (fullText.length > 0) {
              // Списание — только за ход, доведённый до финального ответа. Обучение
              // профиля и разбор задач идут в любом случае: оборванный ход всё равно
              // был настоящим разговором, и терять из него контекст незачем.
              if (!turnFailed) {
                const turnCostUsd = agentTurnCost.usd;
                await this.addTokenTask(userId, 0, textCost, agentId, {
                  costUsd: Number(agentCostUsd.toFixed(4)),
                  turnCostUsd: turnCostUsd === null ? null : Number(turnCostUsd.toFixed(4)),
                  source: charge.source,
                  taken: charge.taken,
                  durationMs: Date.now() - streamStartTime,
                  replyChars: fullText.length,
                });
                // Страховка сработала на ЗАПИСАННОМ списании — релей, похоже, ошибся.
                this.alertTurnCostFloor(userId, assistantId, charge, textCost);
                // Сторож роста стоимости: ход за ходом дороже — алерт. Только здесь,
                // за записанным списанием: пустой ответ, оборванный ход и сбой
                // записи истории до списания не доходят — значит, и до сторожа.
    ```
    заменить на
    ```ts
            if (fullText.length > 0) {
              // Списание — за ход с ответом, в том числе оборванный, если человек
              // успел что-то получить (billing.billable, partial-billing.ts).
              // Обучение профиля и разбор задач идут в любом случае: оборванный ход
              // всё равно был настоящим разговором, и терять из него контекст незачем.
              if (billing.billable) {
                const turnCostUsd = agentTurnCost.usd;
                await this.addTokenTask(userId, 0, textCost, agentId, {
                  costUsd: Number(agentCostUsd.toFixed(4)),
                  turnCostUsd: turnCostUsd === null ? null : Number(turnCostUsd.toFixed(4)),
                  source: charge.source,
                  taken: charge.taken,
                  durationMs: Date.now() - streamStartTime,
                  replyChars: fullText.length,
                  ...(billing.partial ? { partial: billing.partial } : {}),
                });
                // Страховка сработала на ЗАПИСАННОМ списании — релей, похоже, ошибся.
                this.alertTurnCostFloor(userId, assistantId, charge, textCost);
                // Сторож роста стоимости: ход за ходом дороже — алерт. Только здесь,
                // за записанным списанием: пустой ответ, несписанный сбой и сбой
                // записи истории до списания не доходят — значит, и до сторожа.
    ```
    Строки ниже (`// Не ждём: ход от него не зависит.`, `void this.costGrowth?.recordTurn(…)`, закрывающая `}`) не трогать.

11. Обработчик потока в `callUpstreamOnce` (~2663). Блок
    ```ts
                      if (ev.type === 'delta' || ev.type === 'text') {
                        const text = joiner.text(ev.text);
                        chunks.push(text);
                        safeWrite({ type: 'item', content: text });
                      } else if (ev.type === 'notice' && ev.text) {
    ```
    заменить на
    ```ts
                      if (ev.type === 'delta' || ev.type === 'text') {
                        const text = joiner.text(ev.text);
                        chunks.push(text);
                        // Текст модели — отдельно от служебных реплик (partial-billing.ts).
                        if (typeof text === 'string') modelText += text;
                        safeWrite({ type: 'item', content: text });
                      } else if (ev.type === 'notice' && ev.text) {
    ```
    и блок
    ```ts
                      } else if (ev.type === 'result' && ev.text) {
                        if (chunks.length === 0) {
                          chunks.push(ev.text);
                          safeWrite({ type: 'item', content: ev.text });
                        }
    ```
    заменить на
    ```ts
                      } else if (ev.type === 'result' && ev.text) {
                        if (chunks.length === 0) {
                          chunks.push(ev.text);
                          modelText += String(ev.text);
                          safeWrite({ type: 'item', content: ev.text });
                        }
    ```
    Ветку `notice` не трогать: служебная реплика в `modelText` не идёт.

12. Индикатор (~3009). Строки
    ```ts
          // Число для индикатора «X токенов». Считается тем же методом, что и реальное
          // списание в persistResponse, — иначе юзер увидит одно, а спишется другое.
          const tokensUsed = this.computeSdkCharge(agentUsage, agentCostUsd, fullText, agentTurnCost.usd).tokens;
    ```
    заменить на
    ```ts
          // Число для индикатора «X токенов». Считается тем же методом и по тому же
          // решению о списании (decideBilling), что и реальное списание в
          // persistResponse, — иначе юзер увидит одно, а спишется другое. Сбой, за
          // который не списали, — 0; оборванный ход — по тексту модели.
          const billing = decideBilling();
          const tokensUsed = billing.billable
            ? this.computeSdkCharge(agentUsage, agentCostUsd, billing.partial ? modelText : fullText, agentTurnCost.usd).tokens
            : 0;
    ```

13. Доки `alertExpensiveTurn` (~3813). Строки
    ```ts
       * Смотрим на `charge.tokens`, а не на списанное: у оборванного хода списано 0,
       * и дорогой сбой иначе прошёл бы молча — а он-то как раз и интересен.
    ```
    заменить на
    ```ts
       * Смотрим на `charge.tokens`, а не на списанное: у сбоя, за который не
       * списали (partial-billing.ts), списано 0, и дорогой сбой иначе прошёл бы
       * молча — а он-то как раз и интересен.
    ```

14. `turnBilling` (~3878). Перед блоком
    ```ts
      /**
       * Стоимость хода с вложениями — тем же методом, что и обычный ход чата.
    ```
    вставить:
    ```ts
      /**
       * Решение о списании за ход кабинета (partial-billing.ts) — одно на
       * индикатор «N токенов» в `end` и на точку списания: веб-ход
       * (streamUniversalAgent) и ход с файлом (индикатор — контроллер, списание —
       * persistUploadTurn).
       *
       * text — весь текст хода, ушедший человеку. Служебный отказ CLI, долетевший
       * им целиком (looksCliFailure), — не ответ модели: решение идёт как
       * cli_fatal_text, которого нет в списке частичного списания, какую бы
       * причину ни прислал релей.
       */
      turnBilling(text: string, d: TurnDelivery): BillingDecision {
        if (this.looksCliFailure(text)) return billingDecision({ ...d, failed: true, failReason: 'cli_fatal_text' });
        return billingDecision(d);
      }

    ```

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/chat/chat.service.ts && git commit -q -m "feat(chat): веб-ход — оборванный ход списывается за пришедшее, индикатор по тому же решению

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/partial-billing.spec.ts src/chat/chat.partial-billing.spec.ts src/chat/chat.service.failed-turn.spec.ts src/chat/chat.cost-growth.spec.ts src/chat/chat.service.upstream-error-billing.spec.ts src/chat/chat.service.turn-cost-billing.spec.ts src/chat/chat.service.usage-billing.spec.ts src/chat/chat.relay-drain.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.service.turn-marks.spec.ts 2>&1 | tail -20 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 3: Ход с файлом — то же решение в контроллере и `persistUploadTurn`

Спек §3. Перед началом — правило 12.

**Files:**
- Modify: `src/chat/chat.controller.ts` (`let failReason` ~498; обработчик потока ~585–606; `shown` ~690; вызов `persistUploadTurn` ~742)
- Modify: `src/chat/chat.service.ts` (`persistUploadTurn` ~3889–3982)
- Modify: `src/chat/chat.partial-billing.spec.ts`
- Modify: `src/chat/chat.upload-billing.spec.ts`

- [ ] **Step 1: Красные тесты**

В `src/chat/chat.partial-billing.spec.ts` строку
```ts
import { ChatService } from './chat.service';
```
заменить на
```ts
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
```
и дописать в конец файла:

```ts

async function uploadTurn(svc: ChatService, events: any[]) {
  queue.push(sse(events));
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
  return res;
}

describe('ход с файлом: оборванный ход списывается за пришедшее', () => {
  it('U1: transient_after_partial с текстом — списание с пометкой, shown = списанному', async () => {
    const { svc, calls, warn } = makeService();
    const res = await uploadTurn(svc, [
      delta(MODEL), notice(NOTICE), done({ failed: true, failReason: 'transient_after_partial' }),
    ]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls)).toMatchObject({ partial: 'transient_after_partial', source: 'cost' });
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(historyTokens(calls)).toBe(forUsd(0.5));
    expect(lines(warn)).toContainEqual(
      expect.stringContaining(`billing[upload:partial:transient_after_partial:cost]: tokens=${forUsd(0.5)} `),
    );
  });

  it('U2: preempted без текста модели — без списания, shown 0', async () => {
    const { svc, calls, warn } = makeService();
    const res = await uploadTurn(svc, [notice(PREEMPTED), done({ failed: true, failReason: 'preempted' })]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(historyTokens(calls)).toBe(0);
    expect(lines(warn)).toContainEqual(expect.stringContaining('billing[upload:skipped:preempted]'));
  });

  it('U3: max_turns без расхода — по длине текста модели, служебная реплика не в счёт', async () => {
    const { svc, calls } = makeService();
    const res = await uploadTurn(svc, [
      delta(MODEL), notice(NOTICE), { type: 'done', failed: true, failReason: 'max_turns' },
    ]);

    expect(charged(calls)).toBe(MODEL.length * 2);
    expect(shownTokens(res)).toBe(MODEL.length * 2);
    expect(chargeMeta(calls)).toMatchObject({ partial: 'max_turns', source: 'length' });
  });

  it('U4: сбой до ответа (cli_fatal) с обрывком текста — без списания, shown 0', async () => {
    const { svc, calls } = makeService();
    const res = await uploadTurn(svc, [
      delta(MODEL), notice('\n\n_(модель недоступна)_'), done({ failed: true, failReason: 'cli_fatal' }),
    ]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
  });
});
```

В `src/chat/chat.upload-billing.spec.ts` строки
```ts
  it('прерванный ход не тарифицируется — обещание в тексте держится', async () => {
    // Релей дописывает «Токены за прерванный ход не списаны» и шлёт failed:true.
```
заменить на
```ts
  it('сбой вне списка частичного списания не тарифицируется', async () => {
    // 'interrupted' нет в PARTIAL_BILLED_REASONS (partial-billing.ts), текста
    // модели вызов не передал — ход бесплатен, как и до 17.11.2026. Оборванный
    // ход с пришедшим текстом — в chat.partial-billing.spec.ts (U1).
```
Тело теста и его ожидания не трогать.

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/chat/chat.partial-billing.spec.ts src/chat/chat.upload-billing.spec.ts && git commit -q -m "test(chat): ход с файлом — списание за оборванный ход — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat.partial-billing.spec.ts src/chat/chat.upload-billing.spec.ts 2>&1 | tail -30"
```
Expected: FAIL — U1 и U3, строки списания нет. U2, U4, P1–P6 и весь `chat.upload-billing.spec.ts` — зелёные.

- [ ] **Step 3: Реализация**

**`src/chat/chat.service.ts`, `persistUploadTurn`.**

1. В докблоке метода строки
   ```ts
      * Стоимость считается заново из `usage`/`costUsd`, а не принимается готовой:
      * метод должен уметь обнулить её сам (оборванный ход, отказ CLI), и решение
      * об этом не может жить в контроллере.
   ```
   заменить на
   ```ts
      * Стоимость считается заново из `usage`/`costUsd`, а не принимается готовой:
      * метод должен уметь обнулить её сам (сбой без ответа, отказ CLI). Решение —
      * turnBilling, то же, по которому контроллер показал индикатор в `end`.
   ```

2. В параметрах строки
   ```ts
       turnFailed?: boolean;
       failReason?: string;
       // «Чистый лист»: ход с файлом обязан лечь в ту же историю, что и текстовый,
   ```
   заменить на
   ```ts
       turnFailed?: boolean;
       failReason?: string;
       /**
        * Текст МОДЕЛИ, ушедший человеку (delta/text/result), — без служебных
        * реплик релея, ссылок на файлы и заглушек (partial-billing.ts). Решает,
        * списывать ли оборванный ход, и идёт в запасной путь по длине. Не передан
        * — оборванный ход без файлов не списывается, как до 17.11.2026.
        */
       modelText?: string;
       /** Файлы хода, ушедшие человеку (outputFiles релея). */
       files?: number;
       // «Чистый лист»: ход с файлом обязан лечь в ту же историю, что и текстовый,
   ```

3. Тело от строки `let text = p.assistantMsg;` до конца метода (`return textCost;` и закрывающая `}`) заменить целиком на:
   ```ts
       let text = p.assistantMsg;
       let turnFailed = p.turnFailed === true;
       let failReason = p.failReason || '';
       const modelText = p.modelText ?? '';
       // Решение о списании — то же, что контроллер показал в индикаторе `end`
       // (turnBilling, partial-billing.ts). Считается по тексту ДО подмены отказа
       // CLI заглушкой ниже: по этому тексту turnBilling отказ и узнаёт.
       const billing = this.turnBilling(text, {
         failed: turnFailed, failReason, modelChars: modelText.length, files: p.files ?? 0,
       });

       // Защита в глубину, та же что в основном пути: служебный отказ CLI, долетевший
       // до нас целым ответом, пользователь не должен увидеть дословно и тем более
       // за него заплатить.
       if (this.looksCliFailure(text)) {
         this.logger.error(`CLI-отказ долетел как ответ на загрузку (${p.userId}_${p.assistantId}): ${text.slice(0, 120)}`);
         turnFailed = true;
         failReason = failReason || 'cli_fatal_text';
         text = chatFailureText('cliFatal', p.userLanguage, { storeBuild: p.storeBuild });
       }

       // У оборванного хода длина для запасного пути — текст модели, без
       // служебной реплики релея и ссылок на файлы.
       const charge = this.computeSdkCharge(p.usage, p.costUsd, billing.partial ? modelText : text, p.turnCostUsd ?? null);
       // Решение владельца 17.11.2026 — то же, что в основном пути: оборванный
       // ход, после которого человек что-то получил, списывается по фактическому
       // расходу (billing[upload:partial:…]); сбой без ответа не выставляется.
       const textCost = billing.billable ? charge.tokens : 0;
       const logLine = !billing.billable
         ? `billing[upload:skipped:${failReason}]: ход без финального ответа — не тарифицирован, ` +
           `иначе списали бы ${charge.tokens} (${charge.note})`
         : billing.partial
           ? `billing[upload:partial:${billing.partial}:${charge.source}]: tokens=${textCost} ${charge.note}`
           : `billing[upload:${charge.source}]: tokens=${textCost} ${charge.note}`;
       if (turnFailed || charge.source === 'length') this.logger.warn(logLine);
       else this.logger.log(logLine);

       await this.alertExpensiveTurn(p.userId, p.assistantId, charge, textCost);

       await this.saveChatHistory(p.userId, p.assistantId, p.userMsg, text, textCost, p.sessionIdOverride);
       if (billing.billable) {
         await this.addTokenTask(p.userId, 0, textCost, p.assistantId, {
           costUsd: Number(p.costUsd.toFixed(4)),
           turnCostUsd: typeof p.turnCostUsd === 'number' ? Number(p.turnCostUsd.toFixed(4)) : null,
           source: charge.source,
           taken: charge.taken,
           durationMs: p.durationMs,
           replyChars: text.length,
           ...(billing.partial ? { partial: billing.partial } : {}),
         });
         this.alertTurnCostFloor(p.userId, p.assistantId, charge, textCost);
         // Сторож роста стоимости — как в обычном ходе: только за записанным
         // списанием и без ожидания.
         void this.costGrowth?.recordTurn(
           { kind: 'chat', userId: p.userId, assistantId: p.assistantId },
           { tokens: textCost, usd: charge.usd, note: charge.note },
           { balance: () => this.getTokenBalance(p.userId) },
         );
       }
       return textCost;
     }
   ```
   Блок `if (p.userOnly) { … }` в начале метода не трогать.

**`src/chat/chat.controller.ts`, `uploadAndChat`.**

4. Строки (~497)
   ```ts
       let turnFailed = false;
       let failReason = '';
   ```
   заменить на
   ```ts
       let turnFailed = false;
       let failReason = '';
       // Текст МОДЕЛИ, ушедший человеку (delta/text/result), — без служебных
       // реплик релея, ссылок на файлы и заглушки шлагбаума. По нему решается,
       // было ли что списывать за оборванный ход, и считается длина для запасного
       // пути списания (partial-billing.ts).
       let modelText = '';
   ```

5. Обработчик потока (~585). Блок
   ```ts
                 if (ev.type === 'delta' || ev.type === 'text') {
                   const text = joiner.text(ev.text);
                   chunks.push(text);
                   safeWrite({ type: 'item', content: text });
                 } else if (ev.type === 'notice' && ev.text) {
   ```
   заменить на
   ```ts
                 if (ev.type === 'delta' || ev.type === 'text') {
                   const text = joiner.text(ev.text);
                   chunks.push(text);
                   // Текст модели — отдельно от служебных реплик (partial-billing.ts).
                   if (typeof text === 'string') modelText += text;
                   safeWrite({ type: 'item', content: text });
                 } else if (ev.type === 'notice' && ev.text) {
   ```
   и блок
   ```ts
                 } else if (ev.type === 'result' && ev.text && chunks.length === 0) {
                   chunks.push(ev.text);
                   safeWrite({ type: 'item', content: ev.text });
   ```
   заменить на
   ```ts
                 } else if (ev.type === 'result' && ev.text && chunks.length === 0) {
                   chunks.push(ev.text);
                   modelText += String(ev.text);
                   safeWrite({ type: 'item', content: ev.text });
   ```

6. Индикатор (~690). Строки
   ```ts
           // Индикатор считается тем же методом, что и списание в persistUploadTurn.
           // Раньше здесь стояла длина ответа в символах: пользователь видел «2073
           // токена» за ход, за который не списали ничего.
           const shown = turnFailed
             ? 0
             : this.chatService.computeUploadCharge(agentUsage, agentCostUsd, fullText, agentTurnCost.usd).tokens;
   ```
   заменить на
   ```ts
           // Индикатор считается тем же методом и по тому же решению о списании
           // (ChatService.turnBilling, partial-billing.ts), что и списание в
           // persistUploadTurn. Раньше здесь стояла длина ответа в символах:
           // пользователь видел «2073 токена» за ход, за который не списали ничего.
           const billing = this.chatService.turnBilling(fullText, {
             failed: turnFailed, failReason, modelChars: modelText.length, files: pendingFiles.length,
           });
           const shown = billing.billable
             ? this.chatService.computeUploadCharge(
               agentUsage, agentCostUsd, billing.partial ? modelText : fullText, agentTurnCost.usd,
             ).tokens
             : 0;
   ```

7. Вызов `persistUploadTurn` (~742). Строки
   ```ts
                 turnFailed,
                 failReason,
                 sessionIdOverride: freshSessionId,
   ```
   заменить на
   ```ts
                 turnFailed,
                 failReason,
                 modelText,
                 files: pendingFiles.length,
                 sessionIdOverride: freshSessionId,
   ```

- [ ] **Step 4: Зелёный прогон**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/chat/chat.service.ts src/chat/chat.controller.ts && git commit -q -m "feat(chat): ход с файлом — оборванный ход списывается за пришедшее, shown по тому же решению

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/partial-billing.spec.ts src/chat/chat.partial-billing.spec.ts src/chat/chat.upload-billing.spec.ts src/chat/chat.upload-chat-files.spec.ts src/chat/chat.cost-growth.spec.ts src/chat/chat.service.turn-cost-billing.spec.ts src/chat/chat.relay-drain.spec.ts src/chat/chat.relay-running.spec.ts src/chat/chat.service.failed-turn.spec.ts 2>&1 | tail -20 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`.

---

### Task 4: Справка ассистентов — без обещания «оборванный ход бесплатен»

Спек этого не называет, но иначе ассистенты и ИИ-поддержка продолжат говорить людям неправду. Концепция §2.5: «без ложных обещаний». Подпись кнопок не меняется — `sync-kb-labels` не нужен.

**Files:**
- Create: `src/platform-kb/interrupted-turn-billing.spec.ts`
- Modify: `src/platform-kb/articles/chat.ts` (источники ~12, «Если не получается» ~42)
- Modify: `src/platform-kb/articles/tokens.ts` (источники ~6, «Как устроено» ~42)

- [ ] **Step 1: Красный тест**

Create `src/platform-kb/interrupted-turn-billing.spec.ts`:

```ts
import { KB_ARTICLES } from './articles';
import { KB_CLIENTS } from './kb.types';
import { renderArticle } from './render';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * С 17.11.2026 оборванный ход списывается за то, что успело прийти
 * (src/chat/partial-billing.ts, решение владельца). По справке отвечают
 * ассистенты и ИИ-поддержка — обещать «оборванный ход бесплатен» она больше
 * не должна.
 */
const OLD_PROMISE = /оборванный ход не списывается|новым сообщением, не оплачивается/i;

describe('справка: оборванный ход', () => {
  it('ни в одном варианте статей нет обещания «оборванный ход бесплатен»', () => {
    const bad: string[] = [];
    for (const a of KB_ARTICLES) {
      for (const lang of SUPPORTED_LANGUAGES) {
        for (const client of KB_CLIENTS) {
          if (client === 'store' && a.paidOnly) continue;
          if (OLD_PROMISE.test(renderArticle(a, lang, client))) bad.push(`${a.id}/${lang}/${client}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('tokens и chat говорят, что за обрыв списывается сделанное', () => {
    const byId = (id: string) => KB_ARTICLES.find((a) => a.id === id)!;
    expect(renderArticle(byId('tokens'), 'ru', 'web')).toContain('оплачивается по сделанной работе');
    expect(renderArticle(byId('chat'), 'ru', 'web')).toContain('за обрыв списывается только сделанное');
  });
});
```

- [ ] **Step 2: Запушить, убедиться, что красное**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/platform-kb/interrupted-turn-billing.spec.ts && git commit -q -m "test(platform-kb): справка не обещает бесплатный оборванный ход — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/platform-kb/interrupted-turn-billing.spec.ts 2>&1 | tail -20"
```
Expected: FAIL. В первом тесте — список вида `chat/ru/web`, `tokens/ru/web`…, во втором — нет новых фраз.

- [ ] **Step 3: Реализация**

`src/platform-kb/articles/chat.ts`:

1. Строку
   ```ts
   // источник: оборванный ответ — spirits_front src/components/chat/streamFailure.ts, remoteTurn.ts:66; relay-agent/server.mjs (тексты сбоя)
   ```
   заменить на
   ```ts
   // источник: оборванный ответ — spirits_front src/components/chat/streamFailure.ts, remoteTurn.ts:66; relay-agent/server.mjs (тексты сбоя); списание оборванного хода — src/chat/partial-billing.ts
   ```
2. Строку
   ```ts
   - Ответ оборвался или пришло сообщение о временном сбое — написать «продолжай»${paid('; оборванный ход не списывается')}.
   ```
   заменить на
   ```ts
   - Ответ оборвался или пришло сообщение о временном сбое — написать «продолжай»${paid('; за обрыв списывается только сделанное')}.
   ```
   Фраза почти той же длины: статья `chat` ближе всех к пределу 5 КБ из `kb.spec.ts`.

`src/platform-kb/articles/tokens.ts`:

3. Строку
   ```ts
   // источник: цена ответа — src/chat/chat.service.ts:2530-2637 (по стоимости хода); категории — src/tokens/spend-category.ts:22-63
   ```
   заменить на
   ```ts
   // источник: цена ответа — src/chat/chat.service.ts:2530-2637 (по стоимости хода); оборванный ход — src/chat/partial-billing.ts; категории — src/tokens/spend-category.ts:22-63
   ```
4. Строку
   ```ts
   Цена ответа — стоимость работы модели над ним. Ход, оборванный сбоем или новым сообщением, не оплачивается; закрытая вкладка ход не обрывает — он доводится до конца и оплачивается.
   ```
   заменить на
   ```ts
   Цена ответа — стоимость работы модели над ним. Ход, оборванный сбоем или новым сообщением, оплачивается по сделанной работе, если часть ответа или файл успели прийти; если не пришло ничего — не оплачивается. Закрытая вкладка ход не обрывает — он доводится до конца и оплачивается.
   ```

- [ ] **Step 4: Зелёный прогон — со всеми стражами справки**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git add src/platform-kb/articles/chat.ts src/platform-kb/articles/tokens.ts && git commit -q -m "fix(platform-kb): оборванный ход оплачивается по сделанной работе

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && git push -q && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/platform-kb/ 2>&1 | tail -20 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```
Expected: PASS, `TSC_OK`. Может покраснеть «не больше 5120 байт» на `tokens/*`. Тогда сократить фразу из п. 4 до «…оплачивается по сделанной работе, если что-то успело прийти; закрытая вкладка ход не обрывает — он доводится до конца и оплачивается.», закоммитить так же отдельным коммитом и перепрогнать. Второй тест держится и на этой формулировке.

---

### Task 5: Итоговая проверка ветки

**Files:** изменений нет, кроме возможного merge.

- [ ] **Step 1: Свежая база и main в ветку**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git fetch -q origin && echo '--- база:' && git log --oneline HEAD..origin/fix/insights-backlog-1116 | head -20 && echo '--- main:' && git log --oneline HEAD..origin/main | head -20
```
Если вывод не пуст — сначала `origin/fix/insights-backlog-1116`, потом `origin/main`. Каждый раз `git merge --no-ff <ref>` с сообщением и строкой из правила 4 (не rebase). Конфликты разрешать по смыслу обеих сторон, не выбрасывая чужое. Затем `git push -q`. Если merge принёс правки в `src/chat/chat.controller.ts`, `src/chat/chat.service.ts` или `src/platform-kb/` — перед Step 2 прогнать спеки из Step 4 задач 2–4.

- [ ] **Step 2: tsc, сборка и обе половины jest — как в smoke**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && SHA=$(git rev-parse HEAD) && \
ssh -n dv@85.192.61.231 "cd ~/ci/wt/pb1117-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund >/dev/null 2>&1 && echo DEPS_OK; (npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK) > ~/ci/wt/pb1117-final.txt 2>&1; (npm run build >/dev/null 2>&1 && echo BUILD_OK) >> ~/ci/wt/pb1117-final.txt; (cd tests && npx jest unit/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)') >> ~/ci/wt/pb1117-final.txt; npx jest src/ tests/scripts/ --silent --maxWorkers=2 2>&1 | grep -E '^(FAIL|Tests:|Test Suites:)' >> ~/ci/wt/pb1117-final.txt; cat ~/ci/wt/pb1117-final.txt; echo '--- новые FAIL относительно базы:'; diff <(grep '^FAIL' ~/ci/wt/pb1117-baseline.txt | sort) <(grep '^FAIL' ~/ci/wt/pb1117-final.txt | sort) | grep '^>' || echo нет"
```
Expected: `DEPS_OK`, `TSC_OK`, `BUILD_OK`; после «новые FAIL относительно базы» — `нет`. `tests/unit` грузит `dist/`, поэтому сборка идёт до него. Одиночный красный `src/insights/deidentify.spec.ts` — известный флак по времени: перепрогнать его отдельно. Любой другой новый `FAIL` — разобраться до мержа.

- [ ] **Step 3: Карта коммитов и старые формулировки**

```bash
cd /Users/dmitry/Downloads/spirits_back/.worktrees/partial-billing && git log --oneline 407a3105..HEAD && echo '---' && git grep -n "turnBilling(" -- src/chat && echo '---' && (git grep -n "должна оставаться правдой\|доведённый до финального ответа\|платить за пустоту пользователь не должен\|оборванный ход не списывается" -- src/ || echo 'старых формулировок нет')
```
Expected:
- пары «красный → реализация» по задачам 1–4;
- `turnBilling(` — определение и `decideBilling` в `chat.service.ts`, вызов в `persistUploadTurn`, вызов в `chat.controller.ts`;
- `старых формулировок нет`.

---

## После плана — только с OK владельца

Исполнитель плана на этом останавливается. Дальше — отдельными шагами, каждый с явным OK.

1. **Предусловие: релей с новыми репликами уже работает.** Сначала по плану insights (`2026-11-16-insights-backlog-fixes.md`, «После плана») уезжает бэк insights, потом релей `deploy-relay.sh` с коммитом `1103de42`. Проверить живой релей (только чтение):
   ```bash
   ssh -n dv@5.101.115.184 "grep -c 'Токены за прерванный ход не списаны\|Токены за незавершённый ход не списаны\|ответ оборван. Токены за этот ход' ~/file-agent/server.mjs"
   ```
   Expected: `0`. Не ноль — релей ещё старый, бэк этого плана **не катить**: человек прочтёт «не списаны», а списание будет. Обещание у `cli_fatal`/`transient` остаётся и верно — его не искать.
2. **Мерж.** `fix/insights-backlog-1116` уже должен быть в `main`, иначе этот мерж протащит ветку insights целиком. Ревью ветки (superpowers:requesting-code-review) → `git merge --no-ff` в `main` из свежего клона → пуш `main`. Сверить merge-base и не пушить detached HEAD.
3. **Выкат.** `bash ~/Downloads/spirits_back/scripts/deploy.sh` — без флагов, из `main`. Не в 18:00–18:40 МСК (съёмка роликов). Перед этим проверить, что параллельно никто не катит. Сверить, что на проде нужный sha. Фронт и мобилки не меняются: старые клиенты просто увидят число под оборванным ответом.
4. **Что смотреть после.** До выката снять базу той же командой: сколько вчера было `skipped` с причинами из списка. Примерно столько же должно стать `partial`:
   ```bash
   ssh -n dvolkov@212.113.106.202 'L="$HOME/.pm2/logs/linkeon-api-out.log $HOME/.pm2/logs/linkeon-api-error.log"; echo "partial: $(cat $L 2>/dev/null | grep -cE "billing\[(upload:)?partial:")"; cat $L 2>/dev/null | grep -oE "billing\[(upload:)?partial:[a-z_]+" | sort | uniq -c; echo "skipped: $(cat $L 2>/dev/null | grep -cE "billing\[(upload:)?skipped:")"; cat $L 2>/dev/null | grep -oE "billing\[(upload:)?skipped:[a-z_]+" | sort | uniq -c'
   ```
   Если логов по этому пути нет — путь из `pm2 describe linkeon-api` (в неинтерактивном ssh `pm2` может не быть в PATH — брать абсолютный путь).
   - После выката `billing[skipped:` остаются только у `cli_fatal`, `transient`, `cli_fatal_text`, `relay_draining`, `relay_superseded`, `unknown`, а также у причин из списка без текста и файлов.
   - Жалобы «списали за оборванный ответ» — ИИ-поддержка, «Поддержка linkeon», бот алертов; ближайшие «Затыки недели».
   - Алерты сторожа роста стоимости и «Дорогой ход»: оборванные ходы теперь в стороже, небольшой рост числа алертов ожидаем.
   - Телеметрия: `chat_quality.partial_billed`.
5. **Откат.** `git revert -m 1 <merge-коммит>` в `main` → `deploy.sh` с OK. Релей не трогать: реплики без обещания честны и при старом бэке.
6. Комментарий в бэклоге 85841119 и перевод в done. Перевод в done создаёт тему поста автоблога — отклонять темы заранее только с OK. CI-воркдерево на ноде убрать: `ssh -n dv@85.192.61.231 "git -C ~/ci/spirits_back worktree remove --force ~/ci/wt/pb1117-back && rm -f ~/ci/wt/pb1117-*.txt"`.

## Самопроверка плана

- **Покрытие спека:**
  - §1 — Task 1;
  - §2 — Task 2:
    - текст модели отдельно от `notice` — п. 3, 11;
    - файлы — `pendingFiles.length` в `decideBilling`;
    - одно решение — `decideBilling`;
    - индикатор — п. 12;
    - `textCost`, `addTokenTask`, `alertTurnCostFloor` и сторож под `billable` — п. 8, 10;
    - длина по тексту модели — п. 8, 12;
    - `partial` в метаданных — п. 2, 10;
    - журнал `billing[partial:…]` warn и `billing[skipped:…]` — п. 8;
    - `chat_quality.partial_billed` — п. 7;
    - обучение, история и приписка пробы не тронуты;
  - §3 — Task 3:
    - контроллер считает текст модели и файлы — п. 4, 5, 7;
    - `shown` — п. 6;
    - `persistUploadTurn`, журнал `billing[upload:partial:…]` — п. 3;
    - `cli_fatal_text` / `relay_*` не в списке — `turnBilling` и `PARTIAL_BILLED_REASONS`, тесты U4 и W-тесты `chat.relay-drain.spec.ts`;
  - §4 — вне плана (ветка insights, `e6a23a24`/`1103de42`); комментарии бэка — Task 2 п. 4, 8–10, 13 и Task 3 п. 1;
  - «Выкат» — «После плана», п. 1–5;
  - «Тесты» — Task 1–3; тест реплик релея — `relay-agent/notice-texts.test.mjs` в базовой ветке.
- **Сверх спека:** справка ассистентов (Task 4). Индикатор у отказа CLI, долетевшего текстом, тоже становится 0 — тем же решением.
- **Имена:**
  - `PARTIAL_BILLED_REASONS`, `TurnDelivery`, `BillingDecision`, `billingDecision` — Task 1;
  - `ChatService.turnBilling(text, d)` — Task 2 п. 14, используется в Task 2 п. 5 и Task 3 п. 3, 6;
  - `decideBilling` — только веб-ход;
  - `modelText` — в веб-ходе и контроллере, параметр `persistUploadTurn`;
  - `files` — параметр `persistUploadTurn`;
  - `ChargeFacts.partial` — Task 2 п. 2.
