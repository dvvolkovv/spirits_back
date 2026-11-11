# Claude Reserve Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Не отправлять Telegram-алерт и отбой о локальном Claude, когда общий Kimi/Qwen исправен и ни у одного профиля нет личного Claude.

**Architecture:** Проба Claude остаётся неизменной. В `ClaudeHealthService.maybeAlertOutage()` перед доставкой проверяем существующее состояние `switchCarriesCliPath` и наличие `llm_provider = 'claude'` через текущий `PgService`; при подавлении молча очищаем ранее открытый инцидент. Ошибка SQL трактуется fail-open — алерт сохраняется.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL, Jest 29, ts-jest.

Спецификация: `docs/superpowers/specs/2026-11-11-claude-reserve-alert-design.md`.

---

## Карта файлов

- `src/monitoring/claude-health.outage-alert.spec.ts` — stateful mock `PgService`, сценарии подавления, fail-open, очистки и повторного алерта.
- `src/monitoring/claude-health.service.ts` — gate доставки и SQL-проверка личного Claude.
- `src/common/global-llm-messages.ts` — экспорт существующего `switchCarriesCliPath` без изменения условия.

### Task 1: Красные тесты политики доставки

**Files:**
- Modify: `src/monitoring/claude-health.outage-alert.spec.ts:42-91`

- [ ] **Step 1: Сделать mock состояния инцидента и личного Claude stateful**

Заменить блок от `const downNow` через `const sent` на:

```typescript
const downNow = (): Prov => ({ enabled: true, downUntil: Date.now() + 60_000 });
const healthyOnly = (provider: FallbackProvider): Provs => ({
  qwen: provider === 'qwen' ? up : noKey,
  kimi: provider === 'kimi' ? up : noKey,
});

/** Сервис с рубильником switchTo; alerted — инцидент уже открыт, personalClaude — результат SQL или его сбой. */
const make = (
  switchTo: AnswerProvider,
  providers: Provs,
  alerted = false,
  personalClaude: boolean | Error = true,
): any => {
  let alertedState = alerted;
  const pg = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/SELECT alerted/.test(sql)) return { rows: [{ alerted: alertedState }] };
      if (/INSERT INTO monitor_alert_state/.test(sql)) {
        alertedState = params?.[1] === true;
        return { rows: [] };
      }
      if (/ai_profiles_consolidated/.test(sql)) {
        if (personalClaude instanceof Error) throw personalClaude;
        return { rows: [{ present: personalClaude }] };
      }
      return { rows: [] };
    }),
  };
  const claudeCli = { text: jest.fn(), fallbackStats: jest.fn(() => ({ windowMs: 900_000, providers })) };
  const global = { get: jest.fn(async () => switchTo) };
  return new ClaudeHealthService(pg as any, claudeCli as any, global as any);
};
const sent = (): string[] => (sendTelegramPayload as jest.Mock).mock.calls.map((c) => c[0].text);
const setDown = (svc: any): void => {
  svc.cache.llmStatus = 'down';
  svc.cache.llmOutageKind = 'weekly_limit';
  svc.cache.llmError = 'лимит';
  svc.cliConsecutiveDown = 99;
};
```

- [ ] **Step 2: Добавить тесты подавления и сохранения алертов**

Добавить внутрь первого `describe` после существующего теста `it.each(RECOVERY)`:

```typescript
it.each(['kimi', 'qwen'] as const)('живой глобальный %s без личного Claude — алерт и запись состояния подавлены', async (sw) => {
  const svc = make(sw, healthyOnly(sw), false, false);
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([]);
  expect(svc.pg.query).not.toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO monitor_alert_state'),
    expect.anything(),
  );
});

it('живой глобальный Kimi и личный Claude — красный алерт сохраняется', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, true);
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('<b>🔴 Локальный Claude CLI недоступен</b>');
});

it.each([
  ['без ключа', noKey],
  ['«не отвечает»', downNow()],
] as Array<[string, Prov]>)('глобальный Kimi %s — алерт сохраняется без SQL личных настроек', async (_name, kimi) => {
  const svc = make('kimi', { qwen: noKey, kimi }, false, false);
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(svc.pg.query.mock.calls.some(([sql]) => /ai_profiles_consolidated/.test(sql))).toBe(false);
});

it('сбой SQL личного Claude — fail-open, алерт сохраняется', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, new Error('db unavailable'));
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
});

it('открытый инцидент при наступившем подавлении — очищается молча на первом тикe после рестарта', async () => {
  const svc = make('kimi', healthyOnly('kimi'), true, false);
  setDown(svc);
  svc.cliConsecutiveDown = 1;
  svc.lastOutageAlertAt = new Date();
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([]);
  expect(svc.lastOutageAlertAt).toBeNull();
  expect(svc.pg.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO monitor_alert_state'),
    ['claude_cli', false],
  );
});

it('открытый инцидент при наступившем подавлении — отбой не отправляется, состояние очищается', async () => {
  const svc = make('kimi', healthyOnly('kimi'), true, false);
  svc.cache.llmStatus = 'ok';
  svc.lastOutageAlertAt = new Date();
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([]);
  expect(svc.lastOutageAlertAt).toBeNull();
  expect(svc.pg.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO monitor_alert_state'),
    ['claude_cli', false],
  );
});

it('после молчаливой очистки возврат рубильника на Claude во время простоя даёт новый алерт', async () => {
  const svc = make('kimi', healthyOnly('kimi'), true, false);
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([]);
  (sendTelegramPayload as jest.Mock).mockClear();
  svc.globalProvider.get.mockResolvedValue('claude');
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('<b>🔴 Локальный Claude CLI недоступен</b>');
});

it('личный Claude при восстановлении — обычный отбой сохраняется', async () => {
  const svc = make('kimi', healthyOnly('kimi'), true, true);
  svc.cache.llmStatus = 'ok';
  svc.cache.llmCheckedAt = '2026-11-11T07:15:00.000Z';
  svc.cache.llmLatencyMs = 812;
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([
    cliRecoveredText({
      switchProvider: 'kimi', enabled: true, down: false,
      checkedAt: '2026-11-11T07:15:00.000Z', latencyMs: 812,
    }),
  ]);
});
```

- [ ] **Step 3: Закоммитить и запушить красные тесты**

```bash
git -C /Users/dmitry/Downloads/spirits_back add -- src/monitoring/claude-health.outage-alert.spec.ts
git -C /Users/dmitry/Downloads/spirits_back commit -m "test(monitoring): подавление Claude-алерта при живом рубильнике (красный)" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back push origin main
```

Expected: коммит создан, `origin/main` указывает на него.

- [ ] **Step 4: Запустить focused jest на тестовой ноде и убедиться в красном**

```bash
SHA=$(git -C /Users/dmitry/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npm ci && npx jest src/monitoring/claude-health.outage-alert.spec.ts --runInBand"
```

Expected: FAIL как минимум в двух сценариях `живой глобальный ... без личного Claude`: текущий код отправляет одно сообщение вместо `[]`. Сценарии сохранения старого поведения могут проходить уже на красном коммите.

### Task 2: Минимальная реализация gate

**Files:**
- Modify: `src/common/global-llm-messages.ts:69-70`
- Modify: `src/monitoring/claude-health.service.ts:1-25,379-431`
- Test: `src/monitoring/claude-health.outage-alert.spec.ts`

- [ ] **Step 1: Экспортировать существующее условие reserve-only**

В `global-llm-messages.ts` изменить только объявление:

```typescript
export const switchCarriesCliPath = (s: CliSwitchState): boolean =>
  s.switchProvider !== 'claude' && s.enabled && !s.down;
```

- [ ] **Step 2: Добавить fail-open проверку личного Claude**

В импорте `claude-health.service.ts` добавить `switchCarriesCliPath`:

```typescript
import { CliSwitchState, cliOutageAffectedText, cliRecoveredText, switchCarriesCliPath } from '../common/global-llm-messages';
```

Непосредственно перед `maybeAlertOutage()` добавить:

```typescript
/** Личный Claude остаётся затронут даже при живом общем Kimi/Qwen. Сбой SQL — fail-open. */
private async hasPersonalClaude(): Promise<boolean> {
  try {
    const r = await this.pg.query(
      `SELECT EXISTS (
         SELECT 1 FROM ai_profiles_consolidated WHERE llm_provider = 'claude'
       ) AS present`,
    );
    return r.rows[0]?.present === true;
  } catch (e: any) {
    this.log.warn(`llm_provider: не удалось проверить личный Claude для CLI-алерта: ${e?.message || 'unknown'}`);
    return true;
  }
}
```

- [ ] **Step 3: Применить подавление до доставки и очистить открытый инцидент**

В `maybeAlertOutage()` заменить весь блок от `const alreadyAlerted = ...` до конца метода на:

```typescript
const alreadyAlerted = await this.getAlerted(COMPONENT);
const recoveryDue = status === 'ok' && alreadyAlerted;
if (status !== 'down' && !recoveryDue) return;
const belowThreshold = status === 'down' && this.cliConsecutiveDown < OUTAGE_ALERT_AFTER_FAILS;
if (belowThreshold && !alreadyAlerted) return;

const stats = this.claudeCli.fallbackStats(now.getTime());
const sw = await this.switchState(stats, now.getTime());
if (switchCarriesCliPath(sw) && !(await this.hasPersonalClaude())) {
  // Общий провайдер несёт рабочий путь, личного Claude нет: проба остаётся в
  // админке, но Telegram не шумит. Старый инцидент закрываем без ложного отбоя
  // даже на первом тикe после рестарта, когда счётчик ещё ниже порога.
  if (alreadyAlerted) {
    this.lastOutageAlertAt = null;
    await this.setAlerted(COMPONENT, false);
    this.log.warn(`Claude CLI alert cleared without Telegram: ${sw.switchProvider} carries CLI path`);
  }
  return;
}
if (belowThreshold) return;

if (status === 'down') {
  const cooled = !this.lastOutageAlertAt ||
    (now.getTime() - this.lastOutageAlertAt.getTime()) >= OUTAGE_REALERT_HOURS * 3600_000;
  if (!alreadyAlerted || cooled) {
    await send(
      `<b>🔴 Локальный Claude CLI недоступен</b>\n` +
      `Причина: <b>${this.cache.llmError || 'неизвестно'}</b> (${this.cache.llmOutageKind})\n` +
      `${cliOutageAffectedText(sw)} ` +
      `Чат-ассистенты (r.linkeon.io) — отдельный путь, см. synthetic chat_streaming.\n` +
      `Провалов подряд: ${this.cliConsecutiveDown}. Проверка: ${this.cache.llmCheckedAt || '—'}\n` +
      `${fallbackAlertLine(stats)}\n` +
      `Починка: на проде \`claude\` → /login (обновить OAuth).`,
    );
    this.lastOutageAlertAt = now;
    await this.setAlerted(COMPONENT, true);
    this.log.error(`Claude CLI outage alert sent (${this.cache.llmOutageKind}, ${this.cliConsecutiveDown} fails)`);
  }
} else {
  await send(cliRecoveredText({ ...sw, checkedAt: this.cache.llmCheckedAt, latencyMs: this.cache.llmLatencyMs }));
  this.lastOutageAlertAt = null;
  await this.setAlerted(COMPONENT, false);
  this.log.warn('Claude CLI recovery alert sent');
}
```

- [ ] **Step 4: Закоммитить и запушить реализацию**

```bash
git -C /Users/dmitry/Downloads/spirits_back add -- src/common/global-llm-messages.ts src/monitoring/claude-health.service.ts
git -C /Users/dmitry/Downloads/spirits_back commit -m "fix(monitoring): не алертить о резервном Claude при живом рубильнике" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back push origin main
```

Expected: коммит содержит только два production-файла.

### Task 3: Зелёные проверки на тестовой ноде

**Files:**
- Verify: `src/monitoring/claude-health.outage-alert.spec.ts`
- Verify: `src/common/global-llm-messages.spec.ts`
- Verify: `src/monitoring/claude-health.safe-reason.spec.ts`
- Verify: `tsconfig.build.json`

- [ ] **Step 1: Прогнать связанные jest-наборы на коммите реализации**

```bash
SHA=$(git -C /Users/dmitry/Downloads/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/monitoring/claude-health.outage-alert.spec.ts src/common/global-llm-messages.spec.ts src/monitoring/claude-health.safe-reason.spec.ts --runInBand"
```

Expected: `Test Suites: 3 passed, 3 total`; все новые сценарии и прежняя матрица рубильника зелёные.

- [ ] **Step 2: Проверить production-сборку**

```bash
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && cd ~/ci/spirits_back && npm run build"
```

Expected: Nest build завершается с exit code 0 без ошибок TypeScript.

- [ ] **Step 3: Проверить состав изменений и отсутствие выката**

```bash
git -C /Users/dmitry/Downloads/spirits_back status --short --branch
git -C /Users/dmitry/Downloads/spirits_back log -4 --oneline
```

Expected: рабочее дерево чистое; в истории — спецификация, красный тест и исправление. Никакой `deploy.sh` на этом плане не запускается: прод-выкат требует отдельного подтверждения владельца.
