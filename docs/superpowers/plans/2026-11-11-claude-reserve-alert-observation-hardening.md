# Claude Reserve Alert Observation Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить побочные эффекты активной пробы и гонку рубильника, не меняя подтверждённую владельцем политику подавления.

**Architecture:** Каждая проба создаёт отдельный `ClaudeCliService` без PG и без shared `FallbackState`; `isolatedCwd` и `noSessionPersistence` изолируют файлы CLI. После await рубильник и breaker перечитываются. Для мониторингового сбоя добавляется `probeFailed`, отличный от реального breaker `down`, поэтому сообщения не выдумывают fallback.

**Tech Stack:** NestJS 10, TypeScript 5, Jest 29, ts-jest.

**Worktree:** `/Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert`
**Branch:** `fix/claude-reserve-alert`
**Base:** `04cd752d`
**Spec:** `docs/superpowers/specs/2026-11-11-claude-reserve-alert-design.md`.

---

### Task 1: Красные тесты observation-only и race conditions

**Files:**
- Modify: `src/monitoring/claude-health.outage-alert.spec.ts`
- Modify: `src/common/global-llm-messages.spec.ts`

- [ ] **Step 1: Подменять фабрику пробы в test harness**

В `make` заменить возврат сервиса на:

```typescript
const svc = new ClaudeHealthService(pg as any, claudeCli as any, global as any);
svc.newSwitchProbeCli = jest.fn(() => claudeCli);
return svc;
```

- [ ] **Step 2: Усилить assertions существующей успешной пробы**

В `it.each(['kimi', 'qwen'] as const)` расширить `objectContaining`:

```typescript
expect(svc.claudeCli.text).toHaveBeenCalledWith(
  'Reply with exactly: ok',
  expect.objectContaining({
    provider: sw,
    providerChoice: 'global',
    noFallback: true,
    model: 'claude-haiku-4-5',
    timeoutMs: 30_000,
    isolatedCwd: true,
    noSessionPersistence: true,
  }),
);
expect(svc.newSwitchProbeCli).toHaveBeenCalled();
```

В трёх тестах сбоя пробы и тесте повторного алерта после её сбоя заменить ожидаемую подстроку на:

```typescript
expect(sent()[0]).toContain('контрольная проба Kimi не удалась');
expect(sent()[0]).not.toContain('поэтому они идут обычным путём');
```

- [ ] **Step 3: Добавить новые сценарии**

```typescript
it('проба использует новый CLI без PG и без shared состояния', () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  delete svc.newSwitchProbeCli;
  const first = svc.newSwitchProbeCli();
  const second = svc.newSwitchProbeCli();
  expect(first).not.toBe(svc.claudeCli);
  expect(first).not.toBe(second);
  expect(first.pg).toBeUndefined();
  expect(second.pg).toBeUndefined();
});

it('переключение рубильника во время пробы — fail-open без подавления', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  let resolveProbe!: (text: string) => void;
  svc.claudeCli.text.mockReturnValue(new Promise<string>((resolve) => { resolveProbe = resolve; }));
  setDown(svc);
  const pending = svc.maybeAlertOutage();
  await new Promise<void>((resolve) => setImmediate(resolve));
  svc.globalProvider.get.mockResolvedValue('claude');
  resolveProbe('ok');
  await pending;
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('проба без входа');
  expect(svc.claudeCli.text).toHaveBeenCalledTimes(1);
});

it('сбой активной пробы при новом инциденте — красный алерт и alerted=true', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(svc.pg.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO monitor_alert_state'),
    ['claude_cli', true],
  );
});

it('сбой активной пробы при recovery — правдивый отбой без выдуманного fallback', async () => {
  const svc = make('kimi', healthyOnly('kimi'), true, false);
  svc.cache.llmStatus = 'ok';
  svc.cache.llmCheckedAt = '2026-11-11T07:15:00.000Z';
  svc.cache.llmLatencyMs = 812;
  svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('Claude снова отвечает');
  expect(sent()[0]).toContain('контрольная проба Kimi не удалась');
  expect(sent()[0]).not.toContain('Маша/VPM/маркетолог снова работают');
});
```

- [ ] **Step 4: Добавить unit-тесты сообщения probeFailed**

В `global-llm-messages.spec.ts` добавить:

```typescript
it('probeFailed — не утверждает реальный breaker или fallback', () => {
  const text = cliOutageAffectedText({ switchProvider: 'kimi', enabled: true, down: false, probeFailed: true });
  expect(text).toContain('контрольная проба Kimi не удалась');
  expect(text).not.toContain('поэтому они идут обычным путём');
});

it('probeFailed при recovery — Claude восстановлен, проба Kimi не удалась', () => {
  const text = cliRecoveredText({
    switchProvider: 'kimi', enabled: true, down: false, probeFailed: true,
    checkedAt: '2026-11-11T07:15:00.000Z', latencyMs: 812,
  });
  expect(text).toContain('Claude снова отвечает');
  expect(text).toContain('контрольная проба Kimi не удалась');
  expect(text).not.toContain('Маша/VPM/маркетолог снова работают');
});
```

- [ ] **Step 5: Закоммитить, запушить и проверить красный на ноде**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert add -- src/monitoring/claude-health.outage-alert.spec.ts src/common/global-llm-messages.spec.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert commit -m "test(monitoring): изоляция пробы и гонка рубильника (красный)" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert push origin fix/claude-reserve-alert
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/monitoring/claude-health.outage-alert.spec.ts src/common/global-llm-messages.spec.ts --runInBand"
```

Expected: FAIL в isolation options/factory, probeFailed-текстах, deferred switch и новых failure/recovery сценариях.

### Task 2: Observation-only CLI и повторная валидация рубильника

**Files:**
- Modify: `src/monitoring/claude-health.service.ts`
- Modify: `src/common/global-llm-messages.ts`

- [ ] **Step 1: Создать отдельный CLI для каждой пробы**

Перед `probeSwitchProvider()` добавить:

```typescript
/** Отдельный instance без PG: markUp и события пробы не меняют рабочий breaker/статистику. */
private newSwitchProbeCli(): ClaudeCliService {
  return new ClaudeCliService();
}
```

В `probeSwitchProvider()` вызывать `this.newSwitchProbeCli().text(...)` с полным набором опций:

```typescript
const text = await this.newSwitchProbeCli().text('Reply with exactly: ok', {
  provider,
  providerChoice: 'global',
  noFallback: true,
  model: 'claude-haiku-4-5',
  timeoutMs: 30_000,
  isolatedCwd: true,
  noSessionPersistence: true,
});
```

Остальная классификация ответа и безопасное логирование остаются без изменений.

- [ ] **Step 2: Добавить probeFailed в модель сообщения**

В `CliSwitchState` добавить опциональное поле:

```typescript
/** Контрольная проба не удалась; реальный breaker и routing не менялись. */
probeFailed?: boolean;
```

В `cliOutageAffectedText` перед `switchCarriesCliPath(s)` добавить:

```typescript
if (s.probeFailed && s.switchProvider !== 'claude') {
  return `Затронуто: <b>${CLI_PATH_USERS}</b> (CLI-путь на OAuth-подписке) — контрольная проба ${label} не удалась; breaker и маршрутизация рабочих вызовов не изменялись.`;
}
```

В `cliRecoveredText` перед `switchCarriesCliPath(a)` добавить:

```typescript
if (a.probeFailed && a.switchProvider !== 'claude') {
  const label = PROVIDER_LABELS[a.switchProvider];
  return `${head}Claude снова отвечает (${check}), но контрольная проба ${label} не удалась; breaker и маршрутизация рабочих вызовов не изменялись.`;
}
```

- [ ] **Step 3: Перечитывать рубильник после пробы**

В `maybeAlertOutage()` заменить блок от `let effectiveSw = sw;` до конца `if (sw.switchProvider !== 'claude' && ...)` на:

```typescript
let effectiveSw: CliSwitchState = sw;
let globalAlive = false;
if (sw.switchProvider !== 'claude' && switchCarriesCliPath(sw)) {
  const probedProvider = sw.switchProvider;
  const probeOk = await this.probeSwitchProvider(probedProvider);
  const afterNow = Date.now();
  const afterSw = await this.switchState(this.claudeCli.fallbackStats(afterNow), afterNow);
  effectiveSw = afterSw;
  globalAlive = probeOk && afterSw.switchProvider === probedProvider && switchCarriesCliPath(afterSw);
  if (!globalAlive && afterSw.switchProvider === probedProvider && !afterSw.down && !probeOk) {
    effectiveSw = { ...afterSw, probeFailed: true };
  }
}
```

`globalAlive && !(await this.hasPersonalClaude())` и остальной метод оставить без изменений. Теперь suppression требует свежего успеха, совпадения провайдера и актуального preliminary gate. При смене рубильника `globalAlive=false`; второй пробы нет. Реальный `afterSw.down` имеет приоритет над `probeFailed`.

- [ ] **Step 4: Закоммитить, запушить и проверить зелёный**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert add -- src/monitoring/claude-health.service.ts src/common/global-llm-messages.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert commit -m "fix(monitoring): изолировать активную пробу от рабочего пути" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert push origin fix/claude-reserve-alert
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/monitoring/claude-health.outage-alert.spec.ts src/common/global-llm-messages.spec.ts --runInBand"
```

Expected: оба suites полностью зелёные.

### Task 2A: Финальная валидация после SQL и providerUnverified

**Files:**
- Modify: `src/monitoring/claude-health.outage-alert.spec.ts`
- Modify: `src/common/global-llm-messages.spec.ts`
- Modify: `src/monitoring/claude-health.service.ts`
- Modify: `src/common/global-llm-messages.ts`

- [ ] **Step 1: Добавить красные тесты гонки SQL, смены non-Claude провайдера и свежей статистики**

```typescript
it('переключение рубильника во время SQL личного Claude — fail-open', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  let resolvePersonal!: () => void;
  const originalQuery = svc.pg.query;
  svc.pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/ai_profiles_consolidated/.test(sql)) {
      return new Promise((resolve) => {
        resolvePersonal = () => resolve({ rows: [{ present: false }] });
      });
    }
    return originalQuery(sql, params);
  });
  setDown(svc);
  const pending = svc.maybeAlertOutage();
  for (let i = 0; i < 5 && !resolvePersonal; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(resolvePersonal).toBeDefined();
  svc.globalProvider.get.mockResolvedValue('claude');
  resolvePersonal();
  await pending;
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('проба без входа');
});

it.each(['down', 'ok'] as const)('Kimi → Qwen во время пробы при %s — providerUnverified вместо healthy-текста', async (status) => {
  const svc = make('kimi', { qwen: up, kimi: up }, status === 'ok', false);
  if (status === 'down') setDown(svc);
  else {
    svc.cache.llmStatus = 'ok';
    svc.cache.llmCheckedAt = '2026-11-11T07:15:00.000Z';
    svc.cache.llmLatencyMs = 812;
  }
  let resolveProbe!: (text: string) => void;
  svc.claudeCli.text.mockReturnValue(new Promise<string>((resolve) => { resolveProbe = resolve; }));
  const pending = svc.maybeAlertOutage();
  await new Promise<void>((resolve) => setImmediate(resolve));
  svc.globalProvider.get.mockResolvedValue('qwen');
  resolveProbe('ok');
  await pending;
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('активная проба Qwen в этом тике не выполнялась');
  expect(sent()[0]).not.toContain('отвечают через эту модель');
  expect(sent()[0]).not.toContain('Маша/VPM/маркетолог снова работают');
  expect(svc.claudeCli.text).toHaveBeenCalledTimes(1);
});

it('fallbackAlertLine использует снимок после ожидания пробы', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  const initial = { windowMs: 900_000, providers: { qwen: noKey, kimi: up } };
  const fresh = {
    windowMs: 900_000,
    providers: { qwen: noKey, kimi: { enabled: true, ok: 2, failed: 1, downUntil: 0 } },
  };
  svc.claudeCli.fallbackStats.mockReturnValueOnce(initial).mockReturnValueOnce(fresh);
  svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()[0]).toContain('Kimi — ответов 2, ошибок 1');
});
```

В `global-llm-messages.spec.ts` добавить outage и recovery тесты `providerUnverified`:

```typescript
it('providerUnverified — новый провайдер не объявляется проверенным', () => {
  const text = cliOutageAffectedText({ switchProvider: 'qwen', enabled: true, down: false, providerUnverified: true });
  expect(text).toContain('активная проба Qwen в этом тике не выполнялась');
  expect(text).not.toContain('отвечают через эту модель');
});

it('providerUnverified при recovery — без healthy-текста нового провайдера', () => {
  const text = cliRecoveredText({
    switchProvider: 'qwen', enabled: true, down: false, providerUnverified: true,
    checkedAt: '2026-11-11T07:15:00.000Z', latencyMs: 812,
  });
  expect(text).toContain('Claude снова отвечает');
  expect(text).toContain('активная проба Qwen в этом тике не выполнялась');
  expect(text).not.toContain('Маша/VPM/маркетолог снова работают');
});
```

Закоммитировать тесты как `test(monitoring): финальная гонка SQL и смена провайдера (красный)` с attribution, запушить ветку и прогнать оба suites на ноде. Ожидаются падения новых сценариев и `providerUnverified`-компиляции до добавления поля.

- [ ] **Step 2: Добавить providerUnverified и уточнить probeFailed**

В `CliSwitchState` добавить:

```typescript
/** Рубильник сменился во время проверки; новый провайдер не пробовался. */
providerUnverified?: boolean;
```

В `cliOutageAffectedText` перед `probeFailed` добавить:

```typescript
if (s.providerUnverified && s.switchProvider !== 'claude') {
  return `Затронуто: пробы мониторинга, личный выбор Claude и запасной путь — во время проверки рубильник переключён на <b>${label}</b>; его активная проба в этом тике не выполнялась.`;
}
```

Существующий `probeFailed`-текст заменить на:

```typescript
return `Затронуто: пробы мониторинга, личный выбор Claude и запасной путь — контрольная проба ${label} не удалась; доступность рабочего пути через ${label} не подтверждена, breaker и маршрутизация не изменялись.`;
```

В `cliRecoveredText` перед `probeFailed` добавить:

```typescript
if (a.providerUnverified && a.switchProvider !== 'claude') {
  const label = PROVIDER_LABELS[a.switchProvider];
  return `${head}Claude снова отвечает (${check}); во время проверки рубильник переключён на ${label}, его активная проба в этом тике не выполнялась.`;
}
```

`probeFailed` recovery заменить на:

```typescript
return `${head}Claude снова отвечает (${check}), но контрольная проба ${label} не удалась; доступность рабочего пути через ${label} не подтверждена, breaker и маршрутизация не изменялись.`;
```

- [ ] **Step 3: Сделать финальное чтение последним await**

В `maybeAlertOutage()` заменить блок от `const stats = ...` до `if (belowThreshold) return;` на:

```typescript
const stats = this.claudeCli.fallbackStats(now.getTime());
const sw = await this.switchState(stats, now.getTime());
let effectiveStats = stats;
let effectiveSw: CliSwitchState = sw;
let globalAlive = false;
if (sw.switchProvider !== 'claude' && switchCarriesCliPath(sw)) {
  const probedProvider = sw.switchProvider;
  const probeOk = await this.probeSwitchProvider(probedProvider);
  const personalClaude = probeOk ? await this.hasPersonalClaude() : true;
  const afterNow = Date.now();
  const afterStats = this.claudeCli.fallbackStats(afterNow);
  const afterSw = await this.switchState(afterStats, afterNow);
  effectiveStats = afterStats;
  effectiveSw = afterSw;
  const sameProvider = afterSw.switchProvider === probedProvider;
  globalAlive = probeOk && sameProvider && switchCarriesCliPath(afterSw) && !personalClaude;
  if (!sameProvider && switchCarriesCliPath(afterSw)) {
    effectiveSw = { ...afterSw, providerUnverified: true };
  } else if (sameProvider && afterSw.enabled && !afterSw.down && !probeOk) {
    effectiveSw = { ...afterSw, probeFailed: true };
  }
}
if (globalAlive) {
  // Последний await был до этого решения: suppression не использует устаревший рубильник.
  if (alreadyAlerted) {
    this.lastOutageAlertAt = null;
    await this.setAlerted(COMPONENT, false);
    this.log.warn(`Claude CLI alert cleared without Telegram: ${sw.switchProvider} answered probe`);
  }
  return;
}
if (belowThreshold) return;
```

В оставшемся методе заменить `fallbackAlertLine(stats)` на `fallbackAlertLine(effectiveStats)`. Теперь SQL выполняется только после успешной пробы, а финальное чтение рубильника — после SQL и непосредственно перед синхронным решением.

- [ ] **Step 4: Закоммитить и проверить зелёный**

Production коммит: `fix(monitoring): валидировать рубильник непосредственно перед подавлением`, с attribution. Запушить и прогнать оба suites на ноде. Ожидаются полностью зелёные suites.

### Task 3: Повторные ревью и итоговые проверки

- [ ] **Step 1:** Spec compliance review подтверждает, что подавление по-прежнему соответствует решениям владельца, а новые изменения ограничены observation-only, race guard и truthful messages.
- [ ] **Step 2:** Code quality review проверяет отсутствие shared breaker/PG state, isolated cwd/session, повторную валидацию и новые тесты. Любые Critical/Important исправить до перехода дальше.
- [ ] **Step 3:** Выполнить финальные monitoring, global messages, safe errors, CLI global-switch, все AlertBot suites и production build на тестовой ноде. Затем финальное ревью всей ветки. Deploy не запускать без отдельного решения владельца и завершения чужого выката.
