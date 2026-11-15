# Claude Reserve Alert Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить найденные ревью пробелы: перевести AlertBot на общий рубильник и подавлять Claude-алерт только после свежей успешной пробы Kimi/Qwen с учётом личного Claude лишь у активных аккаунтов.

**Architecture:** Существующий gate из `b6a46635` сохраняется, но наличие ключа/breaker больше не считается доказательством живости. При потенциальном уведомлении выполняется короткая активная проба выбранного провайдера с `noFallback`; только её успех разрешает SQL личных настроек и подавление. AlertBot удаляет Claude-only флаг и использует обычную маршрутизацию `ClaudeCliService`.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL, Jest 29, ts-jest.

**Worktree:** `/Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert`
**Branch:** `fix/claude-reserve-alert`
**Base:** `0482ab0a`
**Approved spec:** `docs/superpowers/specs/2026-11-11-claude-reserve-alert-design.md` (revision 2, подтверждена владельцем).

---

### Task 1: AlertBot следует общему рубильнику

**Files:**
- Modify: `src/alert-bot/alert-bot.ai.spec.ts:55-76`
- Modify: `src/alert-bot/alert-bot.ai.ts:47-53`

- [ ] **Step 1: Написать красный тест на отсутствие Claude-only флага**

В первом тесте заменить название на `CLI использует общий рубильник, без встроенных инструментов, и пять разрешённых ops`, а строку `expect(opts.noFallback).toBe(true);` — на:

```typescript
expect(opts).not.toHaveProperty('noFallback');
```

Все остальные assertions оставить без изменений.

- [ ] **Step 2: Закоммитить, запушить и проверить красный на ноде**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert add -- src/alert-bot/alert-bot.ai.spec.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert commit -m "test(alert-bot): общий рубильник вместо Claude-only (красный)" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert push origin fix/claude-reserve-alert
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/alert-bot/alert-bot.ai.spec.ts --runInBand"
```

Expected: FAIL, потому что `noFallback` всё ещё присутствует и равен `true`.

- [ ] **Step 3: Удалить только Claude-only флаг**

В `alert-bot.ai.ts` удалить строку:

```typescript
noFallback: true,
```

Больше ничего в файле не менять: ops tools, маскирование, модель и таймауты остаются прежними.

- [ ] **Step 4: Закоммитить, запушить и проверить зелёный**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert add -- src/alert-bot/alert-bot.ai.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert commit -m "fix(alert-bot): следовать общему рубильнику модели" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert push origin fix/claude-reserve-alert
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/alert-bot/alert-bot.ai.spec.ts src/common/services/claude-cli.global-switch.spec.ts --runInBand"
```

Expected: `Test Suites: 2 passed, 2 total`.

### Task 2: Активная проба общего провайдера и active-account SQL

**Files:**
- Modify: `src/monitoring/claude-health.outage-alert.spec.ts`
- Modify: `src/monitoring/claude-health.service.ts`

- [ ] **Step 1: Вернуть успешный ответ по умолчанию в mock**

В фабрике `make` заменить создание `claudeCli` на:

```typescript
const claudeCli = {
  text: jest.fn().mockResolvedValue('ok'),
  fallbackStats: jest.fn(() => ({ windowMs: 900_000, providers })),
};
```

- [ ] **Step 2: Проверить параметры активной пробы в двух существующих сценариях**

В конец теста `it.each(['kimi', 'qwen'] as const)(...)` после проверки отсутствия записи состояния добавить:

```typescript
expect(svc.claudeCli.text).toHaveBeenCalledWith(
  'Reply with exactly: ok',
  expect.objectContaining({
    provider: sw,
    providerChoice: 'global',
    noFallback: true,
    model: 'claude-haiku-4-5',
    timeoutMs: 30_000,
  }),
);
```

- [ ] **Step 3: Добавить красные тесты активной пробы и active-account SQL**

Добавить в первый `describe` после теста про обычный отбой:

```typescript
it.each(['error', 'empty', 'refusal'] as const)('активная Kimi-проба: %s — красный алерт и Kimi «не отвечает»', async (mode) => {
  const svc = make('kimi', healthyOnly('kimi'), true, false);
  if (mode === 'error') svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
  else svc.claudeCli.text.mockResolvedValue(mode === 'empty' ? '' : 'Not logged in · Please run /login');
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('но Kimi сейчас «не отвечает»');
  expect(svc.pg.query).not.toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO monitor_alert_state'),
    ['claude_cli', false],
  );
});

it('новый outage ниже порога без открытого инцидента — активной пробы нет', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  setDown(svc);
  svc.cliConsecutiveDown = 1;
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([]);
  expect(svc.claudeCli.text).not.toHaveBeenCalled();
});

it('SQL личного Claude учитывает только активные аккаунты', async () => {
  const svc = make('kimi', healthyOnly('kimi'), false, false);
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(svc.pg.query).toHaveBeenCalledWith(expect.stringMatching(
    /ai_profiles_consolidated p[\s\S]*JOIN user_id u ON u.internal_id = p.user_id[\s\S]*u\.state = 'active'/,
  ));
});

it('после молчаливой очистки сбой активной пробы даёт новый алерт', async () => {
  const svc = make('kimi', healthyOnly('kimi'), true, false);
  setDown(svc);
  await svc.maybeAlertOutage();
  expect(sent()).toEqual([]);
  (sendTelegramPayload as jest.Mock).mockClear();
  svc.claudeCli.text.mockRejectedValue(new Error('kimi unavailable'));
  await svc.maybeAlertOutage();
  expect(sent()).toHaveLength(1);
  expect(sent()[0]).toContain('но Kimi сейчас «не отвечает»');
});
```

В существующий тест очистки на первом тикe после рестарта добавить перед проверкой `lastOutageAlertAt`:

```typescript
expect(svc.claudeCli.text).toHaveBeenCalled();
```

Существующие тесты без ключа/down уже подтверждают отсутствие SQL личных настроек; добавить в них также:

```typescript
expect(svc.claudeCli.text).not.toHaveBeenCalled();
```

- [ ] **Step 4: Закоммитить, запушить и проверить красный**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert add -- src/monitoring/claude-health.outage-alert.spec.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert commit -m "test(monitoring): активная проба перед подавлением Claude-алерта (красный)" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert push origin fix/claude-reserve-alert
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/monitoring/claude-health.outage-alert.spec.ts --runInBand"
```

Expected: FAIL в параметрах активной пробы, трёх режимах её сбоя, active-account SQL и повторном алерте после её сбоя. Старые guard-тесты могут проходить.

- [ ] **Step 5: Добавить безопасную активную пробу**

В `claude-health.service.ts` добавить type import:

```typescript
import type { FallbackProvider } from '../common/services/llm-fallback';
```

Непосредственно перед `hasPersonalClaude()` добавить:

```typescript
/** Свежая проверка выбранного рубильником провайдера; сырой текст CLI не логируем. */
private async probeSwitchProvider(provider: FallbackProvider): Promise<boolean> {
  try {
    const text = await this.claudeCli.text('Reply with exactly: ok', {
      provider,
      providerChoice: 'global',
      noFallback: true,
      model: 'claude-haiku-4-5',
      timeoutMs: 30_000,
    });
    if (typeof text === 'string' && text.trim().length > 0 && !looksLikeCliRefusal(text)) return true;
    const kind = classifyLlmError(typeof text === 'string' ? text : '').kind;
    this.log.warn(`${provider} liveness probe DOWN (${kind})`);
    return false;
  } catch (e: any) {
    const message = String(e?.message || e);
    const kind = e instanceof ClaudeCliCallError && e.kind ? e.kind : classifyLlmError(message).kind;
    this.log.warn(`${provider} liveness probe DOWN (${kind})`);
    return false;
  }
}
```

- [ ] **Step 6: Ограничить личный Claude активными аккаунтами**

Заменить SQL в `hasPersonalClaude()` на:

```sql
SELECT EXISTS (
  SELECT 1
  FROM ai_profiles_consolidated p
  JOIN user_id u ON u.internal_id = p.user_id
  WHERE p.llm_provider = 'claude'
    AND u.state = 'active'
) AS present
```

Fail-open `catch` оставить без изменений.

- [ ] **Step 7: Требовать успешную пробу для подавления**

В `maybeAlertOutage()` заменить блок от `const stats = ...` до конца метода на:

```typescript
const stats = this.claudeCli.fallbackStats(now.getTime());
const sw = await this.switchState(stats, now.getTime());
let effectiveSw = sw;
let globalAlive = false;
if (sw.switchProvider !== 'claude' && switchCarriesCliPath(sw)) {
  globalAlive = await this.probeSwitchProvider(sw.switchProvider);
  if (!globalAlive) effectiveSw = { ...sw, down: true };
}
if (globalAlive && !(await this.hasPersonalClaude())) {
  // Подавляем только после свежего успешного ответа общего провайдера.
  if (alreadyAlerted) {
    this.lastOutageAlertAt = null;
    await this.setAlerted(COMPONENT, false);
    this.log.warn(`Claude CLI alert cleared without Telegram: ${sw.switchProvider} answered probe`);
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
      `${cliOutageAffectedText(effectiveSw)} ` +
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
  await send(cliRecoveredText({ ...effectiveSw, checkedAt: this.cache.llmCheckedAt, latencyMs: this.cache.llmLatencyMs }));
  this.lastOutageAlertAt = null;
  await this.setAlerted(COMPONENT, false);
  this.log.warn('Claude CLI recovery alert sent');
}
```

- [ ] **Step 8: Закоммитить, запушить и проверить зелёный**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert add -- src/monitoring/claude-health.service.ts
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert commit -m "fix(monitoring): подтверждать живой рубильник активной пробой" -m "Co-Authored-By: Kimi Code <noreply@moonshot.ai>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert push origin fix/claude-reserve-alert
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/monitoring/claude-health.outage-alert.spec.ts --runInBand"
```

Expected: весь suite зелёный, включая прежние 19 и новые сценарии.

### Task 3: Финальная проверка на тестовой ноде

**Files:**
- Verify: `src/monitoring/claude-health.outage-alert.spec.ts`
- Verify: `src/common/global-llm-messages.spec.ts`
- Verify: `src/monitoring/claude-health.safe-reason.spec.ts`
- Verify: `src/alert-bot/`
- Verify: `src/common/services/claude-cli.global-switch.spec.ts`
- Verify: production build

- [ ] **Step 1: Запустить все связанные suites на итоговом SHA**

```bash
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert rev-parse HEAD)
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $SHA && cd ~/ci/spirits_back && npx jest src/monitoring/claude-health.outage-alert.spec.ts src/common/global-llm-messages.spec.ts src/monitoring/claude-health.safe-reason.spec.ts src/common/services/claude-cli.global-switch.spec.ts src/alert-bot --runInBand"
```

Expected: все выбранные suites и тесты passed, без новых красных.

- [ ] **Step 2: Собрать production**

```bash
ssh dv@85.192.61.231 "source ~/.nvm/nvm.sh && cd ~/ci/spirits_back && npm run build"
```

Expected: exit code 0, ошибок TypeScript нет.

- [ ] **Step 3: Проверить чистоту worktree и отсутствие выката**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/claude-reserve-alert status --short --branch
```

Expected: чистое дерево на `fix/claude-reserve-alert`. Не запускать `deploy.sh`: выкат только отдельным решением владельца после финального code review.
