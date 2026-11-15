# Routine Turn Followups Current Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести в актуальный `main` финальные исправления фоновых ходов: сохранять `done.failReason`, не считать любой сбой занятостью, освобождать день рутины только при `busy/preempted`, честно возвращать `delivered/busy/failed` и не писать `userId`/телефон в связанные логи.

**Architecture:** Изменения точечно накладываются на текущую реализацию `ChatService.agentReply`, а не на старую ветку целиком. `generateAgentReplyOutcome` возвращает полный исход для `RoutinePushService`; обычный `generateAgentReply` по-прежнему прячет обрывок за пустой строкой. Текущие `relayRunning`, `activeStreams`, проверка занятости вплотную к `beginRelayRun` и 15-минутный per-routine retry сохраняются; поверх них добавляются классификация исходов и восстановление прежнего `last_sent_date`.

**Tech Stack:** NestJS 10, TypeScript 5, Jest 29/ts-jest, Node 22 на тестовой ноде, PostgreSQL (`RoutineStore`).

---

## Подтверждённое состояние baseline и границы работ

Локальное воркдерево: `/Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current`, ветка `fix/followups-1111-current`, база `origin/main=e57f4f09e81021205211b68617414968d3518012`. Старые ветки и коммиты используются только как эталон поведения; `merge`, `cherry-pick` целой ветки, `rebase`, `force-push` не нужны.

Перед реализацией прочитаны текущий `main` и эталоны `a4dcf955`, `767cc5ef`, `8327f3ae`, `82ad717d`, `a81829f1`, `84ac48b0`, финальное состояние `6dbd2501` и отдельная текущая реализация `d7f4d3fb`.

Уже есть в текущем `main`, не переделывать:

- `ChatService.agentReply` увеличивает/уменьшает `activeStreams` через `beginStream()/endStream()` для всех вызовов, включая `sessionIdOverride`; регрессии уже находятся в `src/chat/chat.service.routine-turns.spec.ts`.
- Занятость проверяется синхронно непосредственно перед `beginRelayRun(relaySid)` (`mainSession = !sessionIdOverride`), без `await` между проверкой и меткой. Это закрывает ту же гонку, что `8327f3ae`; отдельную `backgroundRunning` и старую реализацию гонки не переносить.
- EOF без `done` в основной сессии сейчас даёт `RelaySessionBusyError`; это поведение сохранить. Меняется только обработка полученного `done.failed`.
- Текущий retry через 15 минут ключуется по `userId + routineId`, перечитывает рутину, пропускает удалённую/выключенную и повторно делает `claimToday`. Сохранить его и все шесть существующих сценариев в `routine-push.busy-retry.spec.ts`; не восстанавливать старые удалённые варианты busy-retry specs и не заменять файлы старыми копиями.

Что реально недостаёт:

- `turnFailed` сохраняется, но `ev.failReason` теряется, а `mainSession && turnFailed` превращается в `RelaySessionBusyError` независимо от причины.
- Рутина получает только строку и число, поэтому не может отличить `busy`, `preempted`, другой `done.failed`, пустой ответ и доставку на ноль устройств.
- День освобождается только при исключении busy; `preempted` не отличается от `transient_after_write`, `max_turns`, `cli_fatal`.
- `releaseToday` всегда ставит `NULL`, а не прежнее `last_sent_date`; `fireNow` не сообщает `busy/failed`; TG-сводка считает попытки, а не фактические доставки.
- Busy/deliver/runDue/retry логи содержат `userId`, `user_id`, объединённый ключ или заголовок рутины; у «Пути» нет отдельной busy-ветки.

**Не входит:** деплой, merge в `main`, фронтенд, изменение модели/профилирования/провайдера, отдельная relay-сессия для рутин, переделка `activeStreams`, новая очередь фоновых ходов.

**Соответствие концепции:** новых пользовательских данных и внешних потоков нет. Человек остаётся приоритетнее фонового хода, обрывок не отправляется пушем, а журнал становится менее персональным.

## Файлы и ответственность

- `src/chat/chat.service.ts` — типы исхода `AgentReplyOutcome`/`ChargedAgentReply`, публичный `generateAgentReplyOutcome`, сохранение `done.failReason`, busy только для реально занятой сессии или EOF без `done`.
- `src/chat/chat.service.routine-turns.spec.ts` — регрессии полного исхода, скрытия обрывка и обезличенного busy-лога; существующие `activeStreams` и race-by-mark проверки остаются.
- `src/chat/chat.service.agent-version-test.spec.ts` — точечно обновить один сценарий `done.failed` в основной сессии; строгий `testMode` не менять.
- `src/routine-push/routine-push.service.ts` — `DeliverResult`, классификация `busy/preempted/failed`, фактическое число доставок, безопасные логи и сохранённый 15-минутный retry.
- `src/routine-push/routine-store.service.ts` — `releaseToday(id, today, prev)` с восстановлением прежней даты только при ещё совпадающем claim.
- `src/routine-push/routine-push.controller.ts` — проброс `busy/failed` из `fireNow` в `action:test`.
- `src/routine-push/routine-push.busy.spec.ts` — новые focused регрессии store/runDue/fireNow/controller; переносятся поведения эталона, не файл оптом.
- `src/routine-push/routine-push.busy-retry.spec.ts` — сохранить текущие retry-сценарии, адаптировать mock к `generateAgentReplyOutcome` и объекту `DeliverResult`.
- `src/routine-push/routine-push.linkeon-tools.spec.ts` — проверить, что `linkeonTools:true` передаётся новому outcome-методу.
- `src/trip/trip.service.ts`, `src/trip/trip.service.spec.ts` — штатное «отложено: сессия занята» без warn/userId и без общей ошибки.

## Общий порядок TDD и прогонов на ноде

Все Jest/tsc/build — только на `dv@85.192.61.231` в `/home/dv/ci/wt/followups-1111-back`. На маке разрешены git, чтение и текстовые проверки diff. Не трогать `/home/dv/spirits_back`, `/home/dv/dev` и чужие `/home/dv/ci/wt/*`.

- [ ] **Один раз подготовить CI worktree и зависимости:**

```bash
ssh dv@85.192.61.231 'set -e; if [ ! -e /home/dv/ci/wt/followups-1111-back/.git ]; then git -C /home/dv/ci/spirits_back worktree add --detach /home/dv/ci/wt/followups-1111-back HEAD; fi; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npm ci --no-audit --no-fund'
```

Expected: worktree существует отдельно от живого стенда, `npm ci` завершается кодом 0. `package-lock.json` в задаче не меняется; повторный `npm ci` не нужен.

Каждая функциональная задача ниже имеет отдельный красный коммит с пушем, прогон конкретного SHA на ноде, затем зелёный коммит с пушем и повторный прогон конкретного SHA. Все коммиты заканчивать trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: ChatService возвращает полный исход agentReply и не называет любой failure busy

**Files:**
- Modify: `src/chat/chat.service.ts` (`AgentReplyOutcome`, `ChargedAgentReply`, wrappers около текущих строк 291-320 и 2932-2960, `agentReply` около 3121-3227)
- Test: `src/chat/chat.service.routine-turns.spec.ts`
- Test: `src/chat/chat.service.agent-version-test.spec.ts`

- [ ] **Step 1: Добавить SSE-хелпер и красные регрессии полного исхода**

В `src/chat/chat.service.routine-turns.spec.ts` после существующего `sseDone()` добавить:

```ts
function sseEvents(events: object[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const event of events) s.push(`data: ${JSON.stringify(event)}\n`);
    s.push(null);
  });
  return s;
}
```

Заменить текущий тест `done с failed в основной сессии — busy на повтор` на два поведенческих теста: полученный `done.failed` возвращается как failure с причиной, а обычный текстовый wrapper не отдаёт обрывок. EOF-тест ниже не трогать.

```ts
it('done.failed в основной сессии — failed outcome с failReason, не RelaySessionBusyError', async () => {
  const svc = makeService();
  (axios.post as jest.Mock).mockImplementationOnce(async () => ({
    data: sseEvents([
      { type: 'delta', text: 'часть' },
      { type: 'done', failed: true, failReason: 'preempted' },
    ]),
  }));

  await expect(svc.generateAgentReplyOutcome('u-1', '12', 'напомни')).resolves.toEqual({
    text: 'часть', failed: true, failReason: 'preempted',
  });
});

it('done.failed — generateAgentReply прячет обрывок, charge-вариант отдаёт исход', async () => {
  const first = makeService();
  (axios.post as jest.Mock).mockImplementationOnce(async () => ({
    data: sseEvents([
      { type: 'delta', text: 'часть' },
      { type: 'done', failed: true, failReason: 'max_turns' },
    ]),
  }));
  await expect(first.generateAgentReply('u-1', '12', 'напомни')).resolves.toBe('');

  const second = makeService();
  (axios.post as jest.Mock).mockImplementationOnce(async () => ({
    data: sseEvents([
      { type: 'delta', text: 'часть' },
      { type: 'done', failed: true, failReason: 'max_turns' },
    ]),
  }));
  const charged = await second.generateAgentReplyWithCharge('u-1', '12', 'напомни');
  expect(charged).toMatchObject({ text: 'часть', failed: true, failReason: 'max_turns' });
});
```

Добавить отдельный `describe` для успешного результата и дефолта `unknown`:

```ts
describe('generateAgentReplyOutcome — границы исхода', () => {
  beforeEach(() => jest.clearAllMocks());

  it('успешный ход — failed:false, failReason не задан', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementationOnce(async () => ({
      data: sseEvents([{ type: 'delta', text: 'ок' }, { type: 'done' }]),
    }));
    await expect(svc.generateAgentReplyOutcome('u-1', '12', 'напомни')).resolves.toEqual({
      text: 'ок', failed: false, failReason: undefined,
    });
  });

  it('done.failed без строки failReason — unknown', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementationOnce(async () => ({
      data: sseEvents([{ type: 'delta', text: 'часть' }, { type: 'done', failed: true }]),
    }));
    await expect(svc.generateAgentReplyOutcome('u-1', '12', 'напомни')).resolves.toEqual({
      text: 'часть', failed: true, failReason: 'unknown',
    });
  });
});
```

Заменить существующий тест `занятая сессия — RelaySessionBusyError без вызова релея` на тот же сценарий с дополнительными проверками безопасного лога:

```ts
it('занятая сессия — RelaySessionBusyError без вызова релея (не пре-эмптим)', async () => {
  const svc = makeService();
  const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
  (axios.post as jest.Mock).mockImplementation(async () => ({ data: sseDone() }));
  const humanMark = svc.beginRelayRun('u-1_12_ru');

  await expect(svc.generateAgentReply('u-1', '12', 'напомни')).rejects.toBeInstanceOf(RelaySessionBusyError);
  expect(axios.post).not.toHaveBeenCalled();
  expect((svc as any).relayRunning.get('u-1_12_ru')).toBe(humanMark);
  expect(svc.getActiveStreamCount()).toBe(0);
  const busyLines = logSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('agentReply:'));
  expect(busyLines).toHaveLength(1);
  expect(busyLines[0]).toContain('сессия занята');
  expect(busyLines[0]).not.toContain('u-1');
  expect(busyLines[0]).not.toContain('u-1_12_ru');

  svc.endRelayRun('u-1_12_ru', humanMark);
  await expect(svc.generateAgentReply('u-1', '12', 'напомни')).resolves.toBe('ок');
  expect(axios.post).toHaveBeenCalledTimes(1);
});
```

В `src/chat/chat.service.agent-version-test.spec.ts` заменить только тест `прерванный ответ (done.failed) в основной сессии — busy, обрезанный текст не пишется`; соседний strict `testMode` остаётся rejecting:

```ts
it('прерванный ответ (done.failed) в основной сессии — failed/failReason, не busy', async () => {
  const h = replyHarness([
    { type: 'delta', text: 'legacy partial' },
    { type: 'done', failed: true, costUsd: 0.01, turnCostUsd: 0.01 },
  ]);

  const result = await h.service.generateAgentReplyWithCharge('user', '12', 'inspect @/etc/passwd');
  expect(result).toMatchObject({
    text: 'legacy partial', failed: true, failReason: 'unknown',
  });
});
```

- [ ] **Step 2: Закоммитить и запушить красные тесты**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current add src/chat/chat.service.routine-turns.spec.ts src/chat/chat.service.agent-version-test.spec.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current commit -m "test(chat): agentReply сохраняет failReason и не путает failure с busy (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push -u origin fix/followups-1111-current
```

Expected: один test-only commit ветки; production-файлы в коммите отсутствуют.

- [ ] **Step 3: Прогнать focused suites на ноде и подтвердить красный результат**

```bash
TEST_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $TEST_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/chat/chat.service.routine-turns.spec.ts src/chat/chat.service.agent-version-test.spec.ts"
```

Expected: FAIL. До реализации `generateAgentReplyOutcome` отсутствует; старый `agentReply` бросает `RelaySessionBusyError` на `done.failed`, а busy-лог содержит `u-1`. Это красный по новым требованиям, не инфраструктурный сбой.

- [ ] **Step 4: Добавить типы и публичный outcome-wrapper**

В `src/chat/chat.service.ts` заменить текущий `ChargedAgentReply` на два связанных типа:

```ts
export interface AgentReplyOutcome {
  /** Обрывок сохраняется здесь для вызывающего, который различает failure. */
  text: string;
  /** done.failed от релея: ответ не завершён, даже если text непустой. */
  failed: boolean;
  /** done.failReason; failed без строки нормализуется в "unknown". */
  failReason?: string;
}

export interface ChargedAgentReply extends AgentReplyOutcome {
  tokens: number;
  costUsd: number;
  charge: SdkCharge;
  durationMs: number;
}
```

Заменить `generateAgentReply` целиком и сразу после него добавить `generateAgentReplyOutcome`:

```ts
async generateAgentReply(
  userId: string, assistantId: string, message: string, sessionIdOverride?: string, opts: AgentReplyOpts = {},
): Promise<string> {
  const { text, failed } = await this.agentReply(userId, assistantId, message, sessionIdOverride, false, opts);
  // Для существующих вызывающих контракт не меняется: обрывок наружу не уходит.
  return failed ? '' : text;
}

/**
 * Нетарифицируемый полный исход для RoutinePushService: preempted отличается
 * от прочих failure, а текст обрывка не теряется до классификации.
 */
async generateAgentReplyOutcome(
  userId: string, assistantId: string, message: string, sessionIdOverride?: string, opts: AgentReplyOpts = {},
): Promise<AgentReplyOutcome> {
  const { text, failed, failReason } = await this.agentReply(
    userId, assistantId, message, sessionIdOverride, false, opts,
  );
  return { text, failed, failReason };
}
```

`generateAgentReplyWithCharge` оставить существующим: он возвращает `this.agentReply(..., true, opts)` и теперь автоматически несёт обязательные `failed/failReason`.

- [ ] **Step 5: Сохранить failReason в потоке и убрать превращение done.failed в busy**

Рядом с `let turnFailed = false;` добавить:

```ts
let turnFailReason: string | undefined;
```

В обработчике `ev.type === 'done'` заменить однострочную установку failure:

```ts
if (ev.failed === true) {
  turnFailed = true;
  turnFailReason = typeof ev.failReason === 'string' ? ev.failReason : 'unknown';
}
```

После `finally { this.endStream(); this.endRelayRun(...); }` оставить busy только для EOF без `done`:

```ts
if (mainSession && !gotDone) {
  // EOF без терминального события в общей сессии: обрезанный текст не успех.
  throw new RelaySessionBusyError(relaySid);
}
```

Удалить старое условие `mainSession && (!gotDone || turnFailed)`: при полученном `done.failed` поток уже имеет честный исход, а причину классифицирует вызывающий. В финальный return `agentReply` добавить оба поля:

```ts
return {
  text,
  tokens: charge.tokens,
  costUsd,
  charge,
  durationMs: Date.now() - startedAt,
  failed: turnFailed,
  failReason: turnFailReason,
};
```

Строгий блок `if (opts.testMode === true)` не менять: `turnFailed` по-прежнему вызывает `Agent version test failed: relay reported failure`.

- [ ] **Step 6: Убрать userId/relaySid из busy-лога, сохранив текущую атомарную проверку**

Заменить только `logger.log` в существующей проверке `if (mainSession && this.relayRunning.has(relaySid))`; проверку и `beginRelayRun` не двигать:

```ts
if (mainSession && this.relayRunning.has(relaySid)) {
  this.logger.log(`agentReply: фоновый ответ отложен — сессия занята (assistant ${assistantId})`);
  throw new RelaySessionBusyError(relaySid);
}
const relayMark = this.beginRelayRun(relaySid);
```

Не добавлять `backgroundRunning`, раннюю проверку или новые ожидания: текущая синхронная связка уже закрывает RACE1/RACE2, а `beginStream/endStream` остаются на своих местах.

- [ ] **Step 7: Прогнать focused suites локально через ноду после зелёного коммита**

Сначала закоммитить реализацию:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current add src/chat/chat.service.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current commit -m "fix(chat): agentReply возвращает failed/failReason без ложного busy" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push origin fix/followups-1111-current
FIX_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $FIX_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/chat/chat.service.routine-turns.spec.ts src/chat/chat.service.agent-version-test.spec.ts"
```

Expected: оба suite PASS, 0 failed. Существующие проверки `activeStreams`, busy до релея, двух фоновых вызовов, override-сессии и EOF без `done` проходят без изменения их смысла.

---

### Task 2: RoutinePush классифицирует исходы, восстанавливает день и сообщает фактическую доставку

**Files:**
- Modify: `src/routine-push/routine-push.service.ts` (блок retry/deliver/fireNow/runDue)
- Modify: `src/routine-push/routine-store.service.ts` (`releaseToday`)
- Modify: `src/routine-push/routine-push.controller.ts` (`action:test`)
- Modify: `src/routine-push/routine-push.busy-retry.spec.ts` (адаптация существующих retry-тестов, без удаления сценариев)
- Modify: `src/routine-push/routine-push.linkeon-tools.spec.ts`
- Create: `src/routine-push/routine-push.busy.spec.ts`

- [ ] **Step 1: Адаптировать существующие retry-тесты к новому контракту, не удаляя их**

В `routine-push.busy-retry.spec.ts` оставить все шесть текущих сценариев. В `makeService` использовать успешную доставку одному устройству, `lastSentDate` и outcome-mock:

```ts
function makeService(chatImpl: jest.Mock, storeOverrides: any = {}) {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const push = { sendPush: jest.fn(async () => 1) };
  const store = {
    getById: jest.fn(async () => ({
      id: 'r-1', userId: 'u-1', assistantId: '12', prompt: 'напомни', title: 't',
      enabled: true, tz: 'Europe/Moscow', lastSentDate: null,
    })),
    localDate: jest.fn(() => '2026-11-05'),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => true),
    ...storeOverrides,
  };
  const svc = new RoutinePushService(
    pg as any, push as any, { generateAgentReplyOutcome: chatImpl } as any, store as any,
  );
  return { svc, store };
}
```

Переименовать первый тест в `busy — откладывает на 15 минут, не пишет в историю и не откатывает чужой claim` и заменить его центральные проверки; откат выполняет владелец claim (`runDue` или retry callback) через `releaseDeferred`:

```ts
await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
  .resolves.toEqual({ delivered: 0, busy: true });
expect(store.releaseToday).not.toHaveBeenCalled();
expect((svc as any).retryTimers.size).toBe(1);
```

Во втором тесте успешный mock заменить на объект:

```ts
.mockImplementationOnce(async () => ({ text: 'Доброе утро!', failed: false, failReason: undefined }));
```

Остальные busy-моки продолжают бросать `new RelaySessionBusyError('u-1_12_ru')`. Добавить седьмой сценарий, который запрещает автоматический retry для не-preempted failure:

```ts
it('max_turns — failed без retry и без release', async () => {
  const chat = jest.fn(async () => ({ text: '', failed: true, failReason: 'max_turns' }));
  const { svc, store } = makeService(chat);

  await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
    .resolves.toEqual({ delivered: 0, failed: true, failReason: 'max_turns' });
  expect((svc as any).retryTimers.size).toBe(0);
  expect(store.releaseToday).not.toHaveBeenCalled();
});
```

Добавить восьмой сценарий для второго busy уже внутри timer callback: новый claim должен быть возвращён к `prev`, а следующий retry остаётся одним.

```ts
it('повтор снова busy — освобождает новый claim с prev и оставляет один retry', async () => {
  const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
  const { svc, store } = makeService(chat);
  await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');

  await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

  expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05');
  expect(store.releaseToday).toHaveBeenCalledWith('r-1', '2026-11-05', null);
  expect((svc as any).retryTimers.size).toBe(1);
});
```

В `routine-push.linkeon-tools.spec.ts` заменить mock и ожидание, сохранив сам сценарий:

```ts
it('fireNow зовёт generateAgentReplyOutcome с { linkeonTools: true }', async () => {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const push = { sendPush: jest.fn(async () => 1) };
  const chat = {
    generateAgentReplyOutcome: jest.fn(async () => ({
      text: 'Доброе утро!', failed: false, failReason: undefined,
    })),
  };
  const store = {
    getById: jest.fn(async () => ({
      id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
      prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
      enabled: true, lastSentDate: null,
    })),
  };
  const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
  await svc.fireNow('u1', 'r1');
  expect(chat.generateAgentReplyOutcome).toHaveBeenCalledWith(
    'u1', '14', 'энергия дня', undefined, { linkeonTools: true },
  );
});
```

- [ ] **Step 2: Создать focused busy.spec с регрессиями store/runDue/fireNow/controller**

Создать `src/routine-push/routine-push.busy.spec.ts` со следующим содержимым. Это выбранные поведенческие регрессии эталона плюс текущий retry, а не копия старого файла.

```ts
import { RoutinePushService } from './routine-push.service';
import { RoutinePushController } from './routine-push.controller';
import { RoutineStore } from './routine-store.service';
import { RelaySessionBusyError } from '../chat/chat.service';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
import { sendTelegramAlert } from '../common/telegram-alert';

const ok = (text: string) => ({ text, failed: false, failReason: undefined });
const failed = (failReason?: string, text = '') => ({ text, failed: true, failReason });
const row = (overrides: Record<string, any> = {}) => ({
  id: 'r1', user_id: 'u1', title: 'Энергия дня', assistant_id: '14',
  prompt: 'энергия дня', send_hour: 8, tz: 'Europe/Moscow', days: null,
  last_sent_date: null,
  ...overrides,
});

function makeStore(overrides: Record<string, jest.Mock> = {}) {
  return {
    listEnabled: jest.fn(async () => []),
    getById: jest.fn(async () => ({
      id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
      prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
      enabled: true, lastSentDate: null,
    })),
    scheduledToday: jest.fn(() => true),
    localHour: jest.fn(() => 9),
    localDate: jest.fn(() => '2026-11-03'),
    toISO: jest.fn((d: any) => String(d).slice(0, 10)),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => true),
    ...overrides,
  };
}

function makeService(
  chatImpl: jest.Mock,
  rows: any[] = [row()],
  storeOverrides: Record<string, jest.Mock> = {},
) {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const push = { sendPush: jest.fn(async () => 1) };
  const store = makeStore({
    listEnabled: jest.fn(async () => rows),
    ...storeOverrides,
  });
  const chat = { generateAgentReplyOutcome: chatImpl };
  const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
  return { svc, store, push, chat, pg };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('RoutineStore.releaseToday — восстановление прежнего дня', () => {
  it('возвращает prev только при ещё совпадающем today', async () => {
    const pg = {
      query: jest.fn(async (_sql: string, _params: any[] = []) => ({ rows: [{ id: 'r1' }], rowCount: 1 })),
    };
    const store = new RoutineStore(pg as any);

    await expect(store.releaseToday('r1', '2026-11-03', '2026-11-02')).resolves.toBe(true);
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE routine_pushes SET last_sent_date = \$3/),
      ['r1', '2026-11-03', '2026-11-02'],
    );
    expect(pg.query.mock.calls[0][0]).toMatch(/WHERE id = \$1 AND last_sent_date = \$2 RETURNING id/);
  });

  it('stale claim не трогает и сообщает false', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const store = new RoutineStore(pg as any);
    await expect(store.releaseToday('r1', '2026-11-03', null)).resolves.toBe(false);
  });
});

describe('runDue — день освобождается только при busy/preempted', () => {
  it('busy — release с prev, пуша нет, следующая рутина продолжается', async () => {
    const chat = jest.fn()
      .mockRejectedValueOnce(new RelaySessionBusyError('u1_14_ru'))
      .mockResolvedValueOnce(ok('Доброе утро!'));
    const rows = [row({ id: 'r1' }), row({ id: 'r2', user_id: 'u2' })];
    const { svc, store, push } = makeService(chat, rows);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', null);
    expect(store.releaseToday).toHaveBeenCalledTimes(1);
    expect(push.sendPush).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('preempted — release с прежним last_sent_date, пуша нет, текущий retry сохранён', async () => {
    const chat = jest.fn(async () => failed('preempted', 'обрывок'));
    const { svc, store, push } = makeService(chat, [row({ last_sent_date: '2026-11-02' })]);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', '2026-11-02');
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(1);
  });

  it.each([
    ['transient_after_write', failed('transient_after_write')],
    ['max_turns', failed('max_turns')],
    ['cli_fatal', failed('cli_fatal')],
    ['cli_failure_text', ok('Failed to authenticate: OAuth session expired')],
    ['empty', ok('')],
  ])('%s — без release, пуша и автоматического retry', async (_name, outcome) => {
    const chat = jest.fn(async () => outcome);
    const { svc, store, push } = makeService(chat);

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('исключение потока — день не освобождается, retry и TG не запускаются', async () => {
    const chat = jest.fn(async () => { throw new Error('relay down'); });
    const { svc, store, push } = makeService(chat);

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('TG-сводка считает только delivered>0, не попытки и не запись в историю', async () => {
    const chat = jest.fn()
      .mockResolvedValueOnce(ok('Failed to authenticate: OAuth session expired'))
      .mockResolvedValueOnce(ok('Первый ответ'))
      .mockResolvedValueOnce(ok('Второй ответ'));
    const rows = [row({ id: 'r1' }), row({ id: 'r2', user_id: 'u2' }), row({ id: 'r3', user_id: 'u3' })];
    const { svc, push } = makeService(chat, rows);
    push.sendPush.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await svc.runDue();

    expect(push.sendPush).toHaveBeenCalledTimes(2);
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlert).toHaveBeenCalledWith('🔔 Рутинные пуши разосланы: 1');
  });

  it.each([
    ['preempted', 'log'],
    ['max_turns', 'warn'],
  ])('deliver логирует %s через %s без userId', async (reason, level) => {
    const chat = jest.fn(async () => failed(reason, 'обрывок'));
    const { svc } = makeService(chat);
    const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.runDue();

    const deliverLines = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((c) => String(c[0])).filter((s) => s.startsWith('routine deliver:'));
    expect(deliverLines).toHaveLength(1);
    expect(deliverLines[0]).toContain(reason);
    expect(deliverLines[0]).not.toContain('u1');
    const expectedSpy = level === 'log' ? logSpy : warnSpy;
    const otherSpy = level === 'log' ? warnSpy : logSpy;
    expect(expectedSpy.mock.calls.some((c) => String(c[0]).startsWith('routine deliver:'))).toBe(true);
    expect(otherSpy.mock.calls.some((c) => String(c[0]).startsWith('routine deliver:'))).toBe(false);
  });

  it('пустой ответ — warn «пустой ответ», без userId и ложного failReason', async () => {
    const chat = jest.fn(async () => ok(''));
    const { svc } = makeService(chat);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.runDue();

    const deliverLines = warnSpy.mock.calls.map((c) => String(c[0]))
      .filter((s) => s.startsWith('routine deliver:'));
    expect(deliverLines).toHaveLength(1);
    expect(deliverLines[0]).toContain('пустой ответ');
    expect(deliverLines[0]).not.toContain('ход не завершён');
    expect(deliverLines[0]).not.toContain('u1');
  });

  it('busy/preempted deferred-логи не содержат userId и пользовательский заголовок', async () => {
    const chat = jest.fn()
      .mockRejectedValueOnce(new RelaySessionBusyError('u1_14_ru'))
      .mockResolvedValueOnce(failed('preempted', 'обрывок'));
    const rows = [
      row({ id: 'routine-uuid-1', title: 'Моя рутина' }),
      row({ id: 'routine-uuid-2', title: 'Другая рутина', last_sent_date: '2026-11-02' }),
    ];
    const { svc } = makeService(chat, rows);
    const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

    await svc.runDue();

    const deferred = logSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('отложена'));
    expect(deferred).toHaveLength(2);
    expect(deferred[0]).toContain('routine-uuid-1');
    expect(deferred[1]).toContain('routine-uuid-2');
    for (const line of deferred) {
      expect(line).not.toContain('u1');
      expect(line).not.toContain('Моя рутина');
      expect(line).not.toContain('Другая рутина');
    }
  });
});

describe('fireNow и action:test — честные delivered/busy/failed', () => {
  it('busy — { delivered:0, busy:true }, пуша нет и чужой claim не откатывается', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u1_14_ru'); });
    const { svc, store, push } = makeService(chat);

    await expect(svc.fireNow('u1', 'r1')).resolves.toEqual({ delivered: 0, busy: true });
    expect(push.sendPush).not.toHaveBeenCalled();
    expect(store.releaseToday).not.toHaveBeenCalled();
  });

  it('max_turns — { delivered:0, failed:true, failReason }, busy отсутствует', async () => {
    const chat = jest.fn(async () => failed('max_turns'));
    const { svc, push } = makeService(chat);

    const result = await svc.fireNow('u1', 'r1');
    expect(result).toEqual({ delivered: 0, failed: true, failReason: 'max_turns' });
    expect(result!.busy).toBeUndefined();
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('CLI failure текстом — failed:true с безопасной локальной причиной', async () => {
    const chat = jest.fn(async () => ok('Failed to authenticate: OAuth session expired'));
    const { svc, push } = makeService(chat);

    await expect(svc.fireNow('u1', 'r1')).resolves.toEqual({
      delivered: 0, failed: true, failReason: 'cli_failure_text',
    });
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it.each([
    [{ delivered: 0, busy: true }, { ok: true, delivered: 0, busy: true }],
    [{ delivered: 0, failed: true }, { ok: true, delivered: 0, failed: true }],
    [{ delivered: 1 }, { ok: true, delivered: 1 }],
  ])('контроллер пробрасывает %j как %j', async (serviceResult, expected) => {
    const routines = { fireNow: jest.fn(async () => serviceResult) };
    const ctrl = new RoutinePushController(routines as any, {} as any);
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    await ctrl.mutate({ userId: 'u1' } as any, { action: 'test', id: 'r1' }, res);
    expect(res.json).toHaveBeenCalledWith(expected);
  });
});
```

- [ ] **Step 3: Закоммитить красные routine-тесты и прогнать их на ноде**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current add src/routine-push/routine-push.busy.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/routine-push/routine-push.linkeon-tools.spec.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current commit -m "test(routine-push): исходы busy/preempted/failed и фактическая доставка (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push origin fix/followups-1111-current
TEST_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $TEST_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/routine-push/routine-push.busy.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/routine-push/routine-push.linkeon-tools.spec.ts src/routine-push/routine-failure.spec.ts"
```

Expected: FAIL по новым контрактам: `releaseToday` ещё принимает два аргумента, `deliver` возвращает число и зовёт старый wrapper, runDue считает попытки, fireNow/controller не возвращают флаги. Существующие шесть retry-сценариев присутствуют в прогоне.

- [ ] **Step 4: Реализовать восстановление прежнего last_sent_date**

В `src/routine-push/routine-store.service.ts` заменить `releaseToday` целиком:

```ts
/**
 * Откатывает только наш сегодняшний claim и возвращает прежнюю дату.
 * Если другой владелец уже изменил last_sent_date, строка не трогается.
 */
async releaseToday(id: string, todayLocal: string, prev: string | null): Promise<boolean> {
  const r = await this.pg.query(
    `UPDATE routine_pushes SET last_sent_date = $3, updated_at = now()
       WHERE id = $1 AND last_sent_date = $2 RETURNING id`,
    [id, todayLocal, prev],
  );
  return (r.rowCount || 0) > 0;
}
```

- [ ] **Step 5: Ввести DeliverResult и единый releaseDeferred для владельцев claim**

В `src/routine-push/routine-push.service.ts` после импорта `sendTelegramAlert` добавить:

```ts
export interface DeliverResult {
  delivered: number;
  /** Relay-сессия занята: можно повторить после освобождения. */
  busy?: boolean;
  /** Генерация не завершилась успешно: пуш и обрывок не отправляются. */
  failed?: boolean;
  /** done.failReason или безопасная локальная причина cli_failure_text. */
  failReason?: string;
}
```

Добавить private helper после `scheduleRetry` (его вызывают только `runDue` и retry callback после `claimToday`, не `fireNow`):

```ts
/** Возвращает true, если день освобождён для позднейшей попытки. */
private async releaseDeferred(
  routineId: string,
  today: string,
  prev: string | null,
  result: DeliverResult,
): Promise<boolean> {
  const deferred = result.busy === true
    || (result.failed === true && result.failReason === 'preempted');
  if (!deferred) return false;
  await this.store.releaseToday(routineId, today, prev);
  this.logger.log(
    `routine ${routineId} отложена: ${result.busy ? 'занята сессия' : 'ход перебит (preempted)'}`,
  );
  return true;
}
```

- [ ] **Step 6: Сохранить текущий 15-минутный retry, но учитывать исход каждой попытки**

Заменить весь блок от комментария `Отложенная доставка` до конца `scheduleRetry`. Карта по-прежнему содержит внутренний составной ключ, но в лог уходит только UUID рутины; после каждой новой claim прежняя дата сохраняется и при `busy/preempted` восстанавливается.

```ts
/**
 * Повтор только для busy/preempted, один на пользователя+рутину. Таймер не
 * переживает рестарт: releaseDeferred оставляет часовой cron страховкой.
 */
private readonly retryTimers = new Map<string, NodeJS.Timeout>();

private scheduleRetry(userId: string, routineId: string): void {
  const key = `${userId}:${routineId}`;
  if (this.retryTimers.has(key)) return;
  this.logger.log(`routine ${routineId} retry через 15 минут`);
  const timer = setTimeout(() => {
    this.retryTimers.delete(key);
    void (async () => {
      const r = await this.store.getById(userId, routineId);
      if (!r || !r.enabled) return;
      const today = this.store.localDate(r.tz, new Date());
      const prev = r.lastSentDate;
      if (!(await this.store.claimToday(routineId, today))) return;
      const result = await this.deliver(
        userId, r.assistantId, r.prompt, r.title, routineId,
      );
      await this.releaseDeferred(routineId, today, prev, result);
    })().catch((e: any) => {
      // Другая ошибка не даёт автоматического retry; claim остаётся на сегодня.
      this.logger.warn(`routine ${routineId} retry failed: ${e?.name || 'Error'}`);
    });
  }, 15 * 60 * 1000);
  timer.unref?.();
  this.retryTimers.set(key, timer);
}
```

Не восстанавливать старую почасовую реализацию вместо этого блока: release остаётся персистентной страховкой на рестарт, а текущий 15-минутный таймер — дополнительным повтором только для `busy/preempted`.

- [ ] **Step 7: Перевести deliver на generateAgentReplyOutcome и классифицировать все исходы**

Заменить текущий `deliver` целиком. Сигнатура с `routineId?` сохраняется для текущего retry; `fireNow` может планировать retry, но не откатывает claim, которым не владеет.

```ts
private async deliver(
  userId: string,
  assistantId: string,
  prompt: string,
  title: string | undefined,
  routineId?: string,
): Promise<DeliverResult> {
  let outcome: { text: string; failed: boolean; failReason?: string };
  try {
    outcome = await this.chat.generateAgentReplyOutcome(
      userId, assistantId, prompt, undefined, { linkeonTools: true },
    );
  } catch (e: any) {
    if (e instanceof RelaySessionBusyError) {
      if (routineId) this.scheduleRetry(userId, routineId);
      return { delivered: 0, busy: true };
    }
    // Исключение потока — не busy: release/retry автоматически не делаем.
    throw e;
  }

  const { text, failed, failReason } = outcome;
  if (failed || !text || !text.trim()) {
    const deferred = failReason === 'preempted';
    const reason = failed
      ? `ход не завершён (${failReason || 'unknown'})`
      : 'пустой ответ';
    const message = `routine deliver: ${reason} (assistant ${assistantId})`;
    if (deferred) this.logger.log(message);
    else this.logger.warn(message);
    if (deferred && routineId) this.scheduleRetry(userId, routineId);
    return { delivered: 0, failed: true, failReason };
  }

  if (looksLikeFailure(text)) {
    // Не печатаем userId и сам ответ: достаточно стабильной безопасной причины.
    this.logger.error(
      `routine deliver: ошибка генерации текстом (assistant ${assistantId}, reason=cli_failure_text)`,
    );
    return { delivered: 0, failed: true, failReason: 'cli_failure_text' };
  }

  const agentNum = /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
  await this.pg.query(
    `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
     VALUES ($1, 'ai', $2, $3, 'text')`,
    [`${userId}_${assistantId}`, agentNum, text],
  );
  const name = await this.assistantName(assistantId);
  const body = text.replace(/[#*_`>\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130);
  const isEnergy = assistantId === RAYA_ID && (title === 'Энергия дня' || !title);
  const delivered = await this.push.sendPush(userId, {
    title: isEnergy ? 'Энергия дня от Райи 🌅' : `${title || 'Напоминание'} · ${name} ✨`,
    body,
    url: `/chat?assistant=${assistantId}`,
    tag: `routine_${assistantId}`,
  });
  // delivered=0 здесь означает «подписок/успешных отправок нет», не failure генерации.
  return { delivered };
}
```

- [ ] **Step 8: Вернуть DeliverResult из fireNow и честно учесть исходы в runDue**

Заменить `fireNow` и `runDue` целиком:

```ts
async fireNow(userId: string, routineId: string): Promise<DeliverResult | null> {
  const r = await this.store.getById(userId, routineId);
  if (!r) return null;
  return this.deliver(userId, r.assistantId, r.prompt, r.title, routineId);
}

@Cron('0 0 * * * *')
async runDue() {
  if (process.env.ROUTINE_PUSH_DISABLED === 'true') return;
  let rows: Awaited<ReturnType<RoutineStore['listEnabled']>>;
  try { rows = await this.store.listEnabled(); }
  catch (e: any) { this.logger.error(`runDue query failed: ${e?.name || 'Error'}`); return; }

  const now = new Date();
  let fired = 0;
  for (const r of rows) {
    try {
      if (!this.store.scheduledToday(r.days, r.tz, now)) continue;
      if (this.store.localHour(r.tz, now) < r.send_hour) continue;
      const today = this.store.localDate(r.tz, now);
      if (r.last_sent_date && this.store.toISO(r.last_sent_date) === today) continue;
      const prev = r.last_sent_date ? this.store.toISO(r.last_sent_date) : null;
      if (!(await this.store.claimToday(r.id, today))) continue;

      const result = await this.deliver(
        r.user_id, r.assistant_id, r.prompt, r.title, r.id,
      );
      if (await this.releaseDeferred(r.id, today, prev, result)) continue;
      if (result.failed) {
        // День остаётся застолбленным: не-preempted failure не повторяем автоматически.
        this.logger.log(
          `routine ${r.id} сбой генерации, без повтора (reason=${result.failReason || 'unknown'})`,
        );
        continue;
      }
      if (result.delivered > 0) fired++;
      this.logger.log(
        `routine ${r.id} доставка завершена (assistant ${r.assistant_id}, delivered=${result.delivered})`,
      );
    } catch (e: any) {
      // Без userId и сырого текста ошибки, который может содержать ключ сессии.
      this.logger.error(`runDue deliver failed for routine ${r?.id || 'unknown'}: ${e?.name || 'Error'}`);
    }
  }
  if (fired > 0) {
    try { await sendTelegramAlert(`🔔 Рутинные пуши разосланы: ${fired}`); } catch {}
  }
}
```

Это сохраняет текущий cron и retry, но меняет учёт: `delivered=0` после `sendPush` не увеличивает TG-счётчик; `failed` без `preempted` не освобождает день; исключение потока также не освобождает его.

- [ ] **Step 9: Пробросить busy/failed через action:test**

В `src/routine-push/routine-push.controller.ts` заменить return в `case 'test'`:

```ts
return res.json({
  ok: true,
  delivered: r.delivered,
  ...(r.busy ? { busy: true } : {}),
  ...(r.failed ? { failed: true } : {}),
});
```

`failReason` остаётся серверной диагностикой и в API не нужен; фронту достаточно двух флагов. Ответ `delivered:0` без `failed` сохраняется для случая «ответ записан, но нет успешных push-подписок».

- [ ] **Step 10: Закоммитить реализацию, запушить и прогнать все routine suites на ноде**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current add src/routine-push/routine-push.service.ts src/routine-push/routine-store.service.ts src/routine-push/routine-push.controller.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current commit -m "fix(routine-push): повтор только busy/preempted и честный результат доставки" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push origin fix/followups-1111-current
FIX_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $FIX_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/routine-push/routine-push.busy.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/routine-push/routine-push.linkeon-tools.spec.ts src/routine-push/routine-failure.spec.ts"
```

Expected: все четыре suite PASS, 0 failed. Проверить явно: busy и preempted вызывают `releaseToday(id,today,prev)`; `transient_after_write/max_turns/cli_fatal/cli_failure_text/empty` — нет; TG получает `1` только за реальную доставку; retry specs не удалены и зелёные.

---

### Task 3: «Путь» обрабатывает busy как штатное откладывание без userId

**Files:**
- Modify: `src/trip/trip.service.ts` (import и `generateFramingAsync` catch около текущих строк 377-401)
- Test: `src/trip/trip.service.spec.ts`

- [ ] **Step 1: Добавить красный regression рядом с существующим best-effort тестом**

В начало `src/trip/trip.service.spec.ts` добавить busy-класс к текущему импорту из `chat.service` (отдельный старый модуль `relay-session-busy` не создавать):

```ts
import { RelaySessionBusyError } from '../chat/chat.service';
```

В `describe` для `generateFramingAsync`, сразу после теста `best-effort: ошибка LLM не throw-ится наружу`, добавить:

```ts
it('RelaySessionBusyError — штатно отложен без warn, общей ошибки и userId', async () => {
  const store = { get: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
  const chat = {
    generateAgentReply: jest.fn().mockRejectedValue(new RelaySessionBusyError('u1_14_ru')),
  };
  const svc = makeTripService({ dayFramingStore: store, chat });
  const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

  await expect(
    svc.generateFramingAsync('u1', 'morning', [], [], new Date('2026-08-06T02:30:00Z')),
  ).resolves.toBeUndefined();

  expect(store.upsert).not.toHaveBeenCalled();
  expect(warnSpy).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledWith('day-framing отложен: сессия занята (morning)');
  expect(logSpy.mock.calls[0][0]).not.toContain('u1');
  expect(logSpy.mock.calls[0][0]).not.toContain('failed');
});
```

Заменить существующий тест общей ошибки целиком, чтобы проверить отсутствие `userId` и вне busy-ветки:

```ts
it('best-effort: ошибка LLM не throw-ится наружу и не пишет userId', async () => {
  const store = { get: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
  const chat = { generateAgentReply: jest.fn().mockRejectedValue(new Error('r.linkeon.io down')) };
  const svc = makeTripService({ dayFramingStore: store, chat });
  const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

  await expect(
    svc.generateFramingAsync('u1', 'morning', [], [], new Date('2026-08-06T02:30:00Z')),
  ).resolves.toBeUndefined();

  expect(store.upsert).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalledWith('day-framing gen failed (morning): r.linkeon.io down');
  expect(warnSpy.mock.calls[0][0]).not.toContain('u1');
});
```

- [ ] **Step 2: Закоммитить красный trip-тест и прогнать его на ноде**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current add src/trip/trip.service.spec.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current commit -m "test(trip): занятая relay-сессия — отложено без ошибки и userId (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push origin fix/followups-1111-current
TEST_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $TEST_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/trip/trip.service.spec.ts"
```

Expected: FAIL: busy попадает в общий `logger.warn`, строка содержит `day-framing gen failed` и `u1`; специального info-лога нет.

- [ ] **Step 3: Добавить отдельную busy-ветку и обезличить общий warn**

В `src/trip/trip.service.ts` изменить импорт:

```ts
import { ChatService, RelaySessionBusyError } from '../chat/chat.service';
```

В `generateFramingAsync` заменить текущий общий `catch` на следующий. Порядок важен: busy возвращается до общего warn; `dayFramingStore.upsert` не вызывается, поэтому следующий `getState` повторит генерацию по несовпавшему hash.

```ts
} catch (e: any) {
  if (e instanceof RelaySessionBusyError) {
    // Человек в приоритете: это ожидаемое откладывание, а не сбой генерации.
    this.logger.log(`day-framing отложен: сессия занята (${window})`);
    return;
  }
  this.logger.warn(`day-framing gen failed (${window}): ${e?.message}`);
}
```

Никаких retry-таймеров в «Путь» не добавлять: существующий lazy `getState` уже является повторной попыткой. Успешная генерация, пустой текст и общий best-effort catch сохраняют прежнее поведение.

- [ ] **Step 4: Закоммитить реализацию и прогнать trip suite на ноде**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current add src/trip/trip.service.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current commit -m "fix(trip): занятая relay-сессия откладывает фрейминг без ошибки" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push origin fix/followups-1111-current
FIX_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $FIX_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/trip/trip.service.spec.ts"
```

Expected: PASS, 0 failed. Busy не проходит через общий warn, не пишет `u1`/relaySid и не делает `upsert`; обычная ошибка по-прежнему не пробрасывается наружу.

---

### Task 4: Связанные регрессии, typecheck, build и diff-гейт

**Files:**
- Verify only: все файлы Tasks 1-3 и `docs/superpowers/plans/2026-11-11-routine-turn-followups-current.md`
- Не добавлять deploy-команд и не менять инфраструктуру.

- [ ] **Step 1: Проверить чистоту и состав ветки до финальных прогонов**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current status --short --branch
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current diff --check origin/main...HEAD
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current diff --name-status origin/main...HEAD
```

Expected: рабочее дерево чистое; `diff --check` без вывода; нет удалённых spec-файлов. Изменены только план и перечисленные chat/routine-push/trip файлы; нет старых `relay-session-busy.ts`, `chat.service.background-turns.spec.ts` и wholesale-копий из `6dbd2501`.

- [ ] **Step 2: Прогнать связанные Jest suites на конечном SHA**

```bash
FINAL_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current rev-parse HEAD)
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current push origin fix/followups-1111-current
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back fetch -q origin; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $FINAL_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx jest --runInBand --forceExit --runTestsByPath src/chat/chat.service.routine-turns.spec.ts src/chat/chat.service.agent-version-test.spec.ts src/chat/chat.service.active-streams.spec.ts src/chat/chat.service.agent-reply-provider.spec.ts src/chat/chat.service.turn-cost-billing.spec.ts src/chat/chat.service.usage-billing.spec.ts src/chat/chat.service.linkeon-fields.spec.ts src/routine-push/routine-push.busy.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/routine-push/routine-push.linkeon-tools.spec.ts src/routine-push/routine-failure.spec.ts src/trip/trip.service.spec.ts src/agents/agent-versions.service.spec.ts src/voice-call/specialist-job.service.spec.ts src/voice-call/voice-document.service.spec.ts"
```

Expected: 15 suites PASS, 0 failed. Не принимать skipped вместо новых `routine-push.busy.spec.ts`, `routine-turns.spec.ts` и `trip.service.spec.ts`. Если падает suite вне изменённого поведения, зафиксировать точную ошибку и сравнить тем же SHA `e57f4f09` в отдельном CI worktree; не маскировать новую регрессию фразой «baseline красный».

- [ ] **Step 3: Прогнать TypeScript gate на ноде**

```bash
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $FINAL_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npx tsc -p tsconfig.build.json --noEmit"
```

Expected: exit 0, ошибок нет. В частности, `ChargedAgentReply extends AgentReplyOutcome` имеет обязательный `failed`, `generateAgentReplyOutcome` возвращает `Promise<AgentReplyOutcome>`, `DeliverResult.failReason?: string`, `releaseToday` везде вызывается с тремя аргументами и `prev` имеет тип `string | null`.

- [ ] **Step 4: Прогнать production build на ноде**

```bash
ssh dv@85.192.61.231 "set -e; git -C /home/dv/ci/wt/followups-1111-back checkout -q --detach $FINAL_SHA; source /home/dv/.nvm/nvm.sh; cd /home/dv/ci/wt/followups-1111-back; npm run build"
```

Expected: Nest build завершается exit 0; ошибок типов и отсутствующих экспортов нет. Build не является деплоем и не запускается на проде.

- [ ] **Step 5: Проверить публичность diff и отсутствие идентификаторов в новых логах**

```bash
if git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current diff origin/main...HEAD | grep -nE '7[0-9]{10}|sk-|BEGIN'; then exit 1; fi
if git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current diff origin/main...HEAD -- src/chat/chat.service.ts src/routine-push src/trip | grep -nE '^\+.*logger\.(log|warn|error).*(userId|user_id|\$\{key\}|relaySid)'; then exit 1; fi
if git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current diff --name-status origin/main...HEAD | grep -E '^D'; then exit 1; fi
```

Expected: все три проверки молчат и не находят запрещённого; отсутствие совпадений не считается ошибкой. В тестах используются `u1/u-1`, не телефоны; production-логи содержат только `routineId`, `assistantId`, `window`, `delivered`, `busy` или безопасный `failReason/reason`.

- [ ] **Step 6: Сверить поведенческий diff по чек-листу и остановиться без деплоя**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/followups-1111-current diff origin/main...HEAD -- src/chat/chat.service.ts src/routine-push/routine-push.service.ts src/routine-push/routine-store.service.ts src/routine-push/routine-push.controller.ts src/trip/trip.service.ts
```

Expected, по фактическому diff:

- `beginStream/endStream`, `beginRelayRun/endRelayRun` и синхронная проверка занятости не переписаны; `sessionIdOverride` и EOF без `done` сохраняют текущее поведение.
- `done.failed` больше не превращается wholesale в `RelaySessionBusyError`; `preempted`, `transient_after_write`, `max_turns`, `cli_fatal` доходят до рутины с `failReason`.
- Пуш и запись в историю не выполняются для любого `failed`, включая `preempted`; обычный `generateAgentReply` возвращает пустую строку на обрывке.
- `releaseToday` вызывается только для busy/preempted владельцем claim и восстанавливает `prev`; другие failure и исключения потока автоматически не повторяются.
- Текущие 15-минутные retry specs сохранены; `delivered=0` не увеличивает TG-сводку; fireNow/controller различают busy/failed.
- Busy/deliver/runDue/retry/trip логи не содержат userId/phone/заголовок рутины; «Путь» пишет только штатное откладывание.
- Ветка запушена, рабочее дерево чистое. Деплой не выполнять: он требует отдельного явного OK владельца.
