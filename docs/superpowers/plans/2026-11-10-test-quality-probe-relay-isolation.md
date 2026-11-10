# Test Quality Probe Relay Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Не позволять test.linkeon.io запускать активную quality-пробу в общий боевой релей и менять его аварийную статистику.

**Architecture:** Используем уже существующий на test признак `RELAY_QWEN_MONITOR=off`: среда не имеет собственного релея и не должна ни пассивно мониторить боевой, ни активно отправлять в него служебные ходы. Меняем только входной guard `QualityMonitorService.qualityProbe()`; маршрутизацию пользователей и остальные проверки не трогаем.

**Tech Stack:** NestJS 10, TypeScript, Jest, PostgreSQL-backed synthetic results (в этом тесте мокируется), CI на `dv@85.192.61.231`.

---

### Task 1: Запрет quality-пробы при выключенном мониторинге общего релея

**Files:**
- Modify: `src/monitoring/quality-monitor.probe-tools.spec.ts`
- Modify: `src/monitoring/quality-monitor.service.ts:93-96`
- Spec: `docs/superpowers/specs/2026-11-10-test-quality-probe-relay-isolation-design.md`

- [ ] **Step 1: Write the failing test**

В `quality-monitor.probe-tools.spec.ts` сохранить и очистить `RELAY_QWEN_MONITOR` вместе с существующими переменными, затем добавить:

```typescript
it('RELAY_QWEN_MONITOR=off — не отправляет qprobe в общий боевой релей', async () => {
  process.env.RELAY_QWEN_MONITOR = 'oFf';
  const chat = { generateAgentReply: jest.fn(async (..._a: any[]) => 'Желаю вам хорошего дня!') };
  const synthetic = { record: jest.fn(async () => {}) };
  const svc = new QualityMonitorService({ query: jest.fn(async () => ({ rows: [] })) } as any, chat as any, synthetic as any);

  await svc.qualityProbe();

  expect(chat.generateAgentReply).not.toHaveBeenCalled();
  expect(synthetic.record).not.toHaveBeenCalled();
});
```

Существующий первый тест остаётся контрольным: перед запусками переменная удаляется, поэтому без `RELAY_QWEN_MONITOR=off` проба должна вызывать `generateAgentReply` как раньше.

- [ ] **Step 2: Commit and push the red test**

```bash
git add src/monitoring/quality-monitor.probe-tools.spec.ts docs/superpowers/plans/2026-11-10-test-quality-probe-relay-isolation.md
git commit -m "test(monitoring): qprobe не ходит в боевой релей с test (красный)"
git push origin main
```

Expected: коммит создан, `origin/main` указывает на новый SHA. Если push отклонён из-за параллельной работы — остановиться, сверить чужие коммиты и не перезаписывать их.

- [ ] **Step 3: Run test on CI to verify it fails**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q <RED_SHA> && source ~/.nvm/nvm.sh && npm ci && npx jest src/monitoring/quality-monitor.probe-tools.spec.ts --maxWorkers=2'
```

Expected: новый тест FAIL, потому что `generateAgentReply` был вызван один раз; существующий тест PASS. Это воспроизводит исходный вызов боевого релея с test.

- [ ] **Step 4: Write minimal implementation**

В начале `qualityProbe()` заменить текущий guard на:

```typescript
// test.linkeon.io использует общий боевой релей: RELAY_QWEN_MONITOR=off
// отключает не только чтение /health, но и активную пробу — иначе qprobe
// открывает окно Claude и пополняет статистику запасных на проде.
if (
  process.env.QUALITY_PROBE_DISABLED === 'true' ||
  (process.env.RELAY_QWEN_MONITOR || '').toLowerCase() === 'off' ||
  !this.chat
) return;
```

Никаких других изменений в сервисе или конфигурации серверов.

- [ ] **Step 5: Commit and push the implementation**

```bash
git add src/monitoring/quality-monitor.service.ts
git commit -m "fix(monitoring): не запускать qprobe с test в боевой релей"
git push origin main
```

Expected: `origin/main` указывает на новый `<FIX_SHA>`. Если push отклонён из-за параллельной работы — остановиться, сверить чужие коммиты и не перезаписывать их.

- [ ] **Step 6: Run the focused tests to verify they pass**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && git fetch -q origin && git checkout -q <FIX_SHA> && source ~/.nvm/nvm.sh && npm ci && npx jest src/monitoring/quality-monitor.probe-tools.spec.ts src/monitoring/relay-qwen-monitor.service.spec.ts --maxWorkers=2'
```

Expected: оба файла PASS; новый тест подтверждает отсутствие вызовов `chat` и `synthetic`, существующие тесты подтверждают прежнее поведение без флага и мониторинга `/health`.

- [ ] **Step 7: Verify the TypeScript build on CI**

```bash
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npm run build'
```

Expected: Nest build завершается с exit code 0. Если проверка красная, никаких дополнительных исправлений без новой диагностики.

- [ ] **Step 8: Report without deploying**

Сообщить SHA красного и зелёного коммитов, результаты Jest и build. `deploy.sh` не запускать: двухфазный выкат test → prod выполняется только по отдельной явной команде пользователя.
