# Claude Subscription Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать весь pay-per-use Claude API спенд (`ANTHROPIC_API_KEY` + OpenRouter `anthropic/*` роуты) — перевести шесть консьюмеров (Маша, support, tasks-extractor, dozvon, scan-document, misc.streamLLM) на тот же OAuth-канал через Claude Agent SDK, что и Юля (SMM-Producer), плюс убрать OpenRouter-Anthropic fallback'и в neo4j и profile-compaction.

**Architecture:** Каждый прямой `@anthropic-ai/sdk` вызов заменяется на `query()` из `@anthropic-ai/claude-agent-sdk` (OAuth через `~/.claude/.credentials.json` на сервере). Для streaming-консьюмеров переиспользуется существующий `SdkEventTranslator` из `src/chat/claude-agent.event-translator.ts`. Для tool-loop консьюмеров (support, Маша) tools заворачиваются в локальный MCP-сервер через `createSdkMcpServer`. Phased rollout: сначала cost-cut quick-wins (downgrade Opus→Haiku, prefilter tasks-extractor), потом миграция кода по консьюмерам, потом удаление ключа и OpenRouter-фолбеков.

**Tech Stack:** NestJS 10, `@anthropic-ai/claude-agent-sdk` (уже установлен — Юля бежит на нём), Zod для tool schemas, `SdkEventTranslator` для frontend wire format, node-native тесты в `tests/`.

---

## Decisions needed before execution

Не стартовать тасков пока не подтверждены:

1. **Subscription tier и concurrency.** У Claude Max 5h rate-limit window. Сейчас Юля + `r.linkeon.io` (другие агенты) уже едят OAuth-квоту. Добавляем горячую Машу + support + tasks-extractor (срабатывает на каждом обороте) + dozvon + misc. **Какой план Max (5x / 20x), и план B при достижении лимита** — graceful degrade в "временно недоступен" или fallback на сохранённый `ANTHROPIC_API_KEY` через feature-flag?

2. **r.linkeon.io vs локальный Agent SDK как target.** Сейчас две OAuth-инфраструктуры: локальный SDK на сервере (Юля) и удалённый `r.linkeon.io` (Роман и др.). **План по умолчанию в этом документе: всё мигрируем на локальный SDK** — быстрее, без сетевого hop'а, без зависимости от внешнего сервиса. r.linkeon.io оставляем только для агентов где он уже работает. Исключение: Маша (Task C3) — там есть compelling причина пустить её именно через universal-agent роут, см. опции в Task C3.

3. **tasks-extractor стратегия.** Сейчас зовёт LLM на КАЖДОМ обороте любого чата. Варианты:
   - (a) удалить совсем — если ценность task-tracking не подтверждена
   - (b) sampling: 1 из N оборотов
   - (c) **локальный prefilter** (regex/keyword) — отсекает ~70-80% бытовых оборотов до LLM, остаток мигрируем на OAuth
   - (d) мигрировать как есть, без throttle
   **План по умолчанию: (c)** — реализовано в Task B2, миграция в Task D2.

4. **dozvon `web_search_20250305` замена.** Это нативный Anthropic API tool, через Agent SDK так не сделать. Варианты:
   - (a) Agent SDK `WebSearch` встроенный tool
   - (b) Brave/Tavily/Perplexity API
   - (c) убрать web-search функциональность из планировщика
   **План по умолчанию: (a)** — см. Task E1 (есть верификация что встроенный WebSearch выдаёт качественные результаты для русскоязычных запросов планировщика).

5. **PDF в scan-document.** Agent SDK поддерживает PDF через файловую систему (запись в `cwd` + tool `Read`). Варианты:
   - (a) **записать PDF в tmp cwd, разрешить Read tool, SDK сам прочитает** — нативная vision
   - (b) pre-extract PDF→text локально (pdf-parse), потом text prompt
   **План по умолчанию: (a)** — Task C2.

6. **OpenRouter Anthropic fallbacks.** В коде есть `anthropic/claude-haiku-4.5` через OpenRouter: `chat.service.ts:361, :966`, `neo4j.service.ts:521`, `profile-compaction.service.ts:244, :310`. После миграции Маши OpenRouter-fallback Маши становится dead code (Task F1). neo4j (Task F2) и profile-compaction (Task F3) — отдельные миграции. **План: убрать все Anthropic-роуты в OpenRouter, заменить на тот же Agent SDK.** OpenRouter ключ остаётся только если используется для не-Anthropic моделей (DeepSeek и т.д., см. `chat.service.ts:211` — DeepSeek сейчас отдельным каналом, его не трогаем).

---

## Migration target — reference pattern

Все миграции идут по одному паттерну, уже работающему в проде в `src/chat/claude-agent.service.ts:39-214` (Юля/SMM-Producer):

```typescript
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { SdkEventTranslator } from '../chat/claude-agent.event-translator';
import { z } from 'zod';

const translator = new SdkEventTranslator();
let totalCostUsd = 0;
let newSessionId: string | undefined;

for await (const event of query({
  prompt: userMessage,
  options: {
    model: 'claude-haiku-4-5',
    systemPrompt,
    mcpServers: { 'consumer-tools': mcpServer },   // если есть custom tools
    cwd,                                            // per-consumer working dir (для Read/PDF)
    resume: previousSessionId,                      // если нужен resume multi-turn
    permissionMode: 'bypassPermissions',
    settingSources: [],
    includePartialMessages: true,
  } as any,
})) {
  if (event.type === 'system' && (event as any).subtype === 'init') {
    newSessionId = (event as any).session_id;
  }
  if (event.type === 'result') {
    totalCostUsd = (event as any).total_cost_usd ?? 0;
  }
  for (const e of translator.translate(event)) {
    res.write(JSON.stringify(e) + '\n');
  }
}

// биллинг: totalCostUsd → Linkeon-tokens (rate: $1 = 100_000 tokens, см. claude-agent.service.ts:179)
```

Инварианты, которые не должны нарушаться ни в одной миграции:
- **Никаких `process.env.ANTHROPIC_API_KEY`** — только OAuth credentials на сервере
- **Сохраняем legacy frontend wire format** через `SdkEventTranslator` (фронт не трогаем)
- **Биллинг по `total_cost_usd`** из `result`-евента, а не по input/output tokens (см. `claude-agent.service.ts:176-211` как образец)
- **`permissionMode: 'bypassPermissions'`** — обязательно для server-side runs (иначе SDK ждёт интерактивный confirm)
- **`settingSources: []`** — не наследует `~/.claude/settings.json`, иначе подцепит случайный конфиг владельца сервера

---

## Phase A — Pre-flight verification

Цель: убедиться что OAuth уже здоровый, и мы готовы добавить туда нагрузку.

### Task A1: Verify Юля OAuth работает на проде

**Files:** (verification only)

- [ ] **Step 1: Проверить credentials.json на проде**

```bash
ssh dvolkov@212.113.106.202 'ls -la /home/dvolkov/.claude/.credentials.json && jq ".accessToken | length" /home/dvolkov/.claude/.credentials.json'
```
Expected: файл существует, accessToken длиной > 100.

- [ ] **Step 2: Прогнать запрос к Юле и убедиться что OAuth-путь живой**

```bash
TOKEN=$(curl -s "https://my.linkeon.io/webhook/debug/sms-code/79030169187" | jq -r .code)  # admin
# get JWT via SMS verify flow, then:
curl -X POST https://my.linkeon.io/webhook/soulmate/chat \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"assistantId":"smm_producer","message":"test","sessionId":"verify-oauth"}' --no-buffer
```
Expected: streaming NDJSON, начинается с `{"type":"begin"}` — OAuth-путь жив.

- [ ] **Step 3: Записать baseline OAuth credentials refresh time**

```bash
ssh dvolkov@212.113.106.202 'stat -c "%y" /home/dvolkov/.claude/.credentials.json'
```
Записать timestamp. После каждой фазы сравнивать — если refresh стал чаще раза в час, это признак давления на квоту.

### Task A2: Добавить OAuth quota probe в /admin/health

**Files:**
- Create: `src/support/oauth-quota-probe.ts`
- Modify: `src/support/health-probe.service.ts:39, 118-152`

- [ ] **Step 1: Написать probe**

```typescript
// src/support/oauth-quota-probe.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export async function probeOAuth(): Promise<{ service: 'oauth'; status: 'ok' | 'down'; latencyMs: number | null; lastCostUsd: number | null; lastError?: string }> {
  const start = Date.now();
  let cost = 0;
  try {
    for await (const event of query({
      prompt: 'OK',
      options: { model: 'claude-haiku-4-5', permissionMode: 'bypassPermissions', settingSources: [] } as any,
    })) {
      if (event.type === 'result') cost = (event as any).total_cost_usd ?? 0;
    }
    return { service: 'oauth', status: 'ok', latencyMs: Date.now() - start, lastCostUsd: cost };
  } catch (e: any) {
    return { service: 'oauth', status: 'down', latencyMs: null, lastCostUsd: null, lastError: e.message };
  }
}
```

- [ ] **Step 2: Подключить в health-probe.service.ts:39**

```typescript
// src/support/health-probe.service.ts
import { probeOAuth } from './oauth-quota-probe';

// in the parallel probes block (around line 39):
const results = await Promise.all([
  this.probeAnthropic(),
  this.probeOpenRouter?.(),
  probeOAuth(),  // ← new
].filter(Boolean));
```

- [ ] **Step 3: Smoke-check endpoint**

```bash
pnpm build && pm2 restart linkeon-api
curl http://localhost:3001/webhook/admin/health | jq '.services'
```
Expected: в массиве services появилась запись `oauth` со статусом `ok`.

- [ ] **Step 4: Commit**

```bash
git add src/support/oauth-quota-probe.ts src/support/health-probe.service.ts
git commit -m "chore(support): добавить OAuth quota probe в /admin/health"
```

---

## Phase B — Quick wins (cost cut до миграции)

Цель: убрать самые жирные источники спенда без рефакторинга — снизить нагрузку перед миграцией.

### Task B1: Downgrade support model Opus → Haiku

Support бот сейчас крутит `claude-opus-4-7` (см. `support.service.ts:362`) — Opus в ~10-15x дороже Haiku.

**Files:**
- Modify: `src/support/support.service.ts:362`

- [ ] **Step 1: Заменить модель**

```typescript
// src/support/support.service.ts, в generateAiResponse (~line 361)
resp = await this.anthropic.messages.create({
  model: 'claude-haiku-4-5-20251001',   // было: 'claude-opus-4-7'
  max_tokens: 1500,
  system: systemPrompt,
  tools: SUPPORT_TOOLS as any,
  messages: conversation,
});
```

- [ ] **Step 2: Smoke test support flow**

На `test.linkeon.io` (admin login) открыть support widget → задать вопросы трёх типов:
1. **Простой:** "у меня не списались токены" — должен ответить осмысленно
2. **Tool-use:** "сколько у меня токенов?" — должен вызвать `get_user_balance`
3. **Escalation:** "хочу вернуть деньги за подписку" — должен вызвать `escalate`

Записать ответы. Если accuracy упала катастрофически — пересмотреть (вернуть Sonnet 4-5 как компромисс между ценой и качеством).

- [ ] **Step 3: Deploy на test и observe 24h**

```bash
bash scripts/deploy.sh TEST_ONLY=1
```
Через 24h смотрим support_tickets в БД — если accuracy ok, идём дальше; если деградация — rollback.

- [ ] **Step 4: Commit**

```bash
git add src/support/support.service.ts
git commit -m "perf(support): downgrade opus-4-7 → haiku-4-5 (10x cost cut)"
```

### Task B2: Pre-filter tasks-extractor

`extractFromTurn` (`tasks.service.ts:81`) сейчас зовёт LLM на КАЖДОМ обороте любого чата. ~$0.001/turn × миллионы оборотов = заметная статья. Добавляем локальный regex-фильтр перед LLM — отсекает приветствия / короткие реплики без проектных сигналов.

**Files:**
- Create: `src/tasks/extract-prefilter.ts`
- Create: `tests/tasks/extract-prefilter.test.js`
- Modify: `src/tasks/tasks.service.ts:81-90`

- [ ] **Step 1: Написать failing-тест**

```javascript
// tests/tasks/extract-prefilter.test.js
const test = require('node:test');
const assert = require('node:assert');
const { shouldSkipTaskExtraction } = require('../../dist/tasks/extract-prefilter');

test('skip: greetings & pleasantries', () => {
  assert.equal(shouldSkipTaskExtraction('привет'), true);
  assert.equal(shouldSkipTaskExtraction('спасибо!'), true);
  assert.equal(shouldSkipTaskExtraction('как дела'), true);
  assert.equal(shouldSkipTaskExtraction('ок'), true);
  assert.equal(shouldSkipTaskExtraction('да'), true);
});

test('skip: empty and whitespace', () => {
  assert.equal(shouldSkipTaskExtraction(''), true);
  assert.equal(shouldSkipTaskExtraction('   '), true);
});

test('keep: messages with project signals', () => {
  assert.equal(shouldSkipTaskExtraction('запусти кампанию на следующей неделе'), false);
  assert.equal(shouldSkipTaskExtraction('нужно сделать пост к понедельнику'), false);
  assert.equal(shouldSkipTaskExtraction('помоги настроить рекламу для нового клиента'), false);
  assert.equal(shouldSkipTaskExtraction('у нас дедлайн в пятницу по отчёту'), false);
});

test('keep: длинные сообщения без явных ключей (на всякий случай не отсеиваем)', () => {
  const longMsg = 'ну вот думаю как лучше подойти к ситуации с командой, потому что они все разные и каждый со своим характером, надо как-то синхронизировать процессы';
  assert.equal(shouldSkipTaskExtraction(longMsg), false);
});
```

- [ ] **Step 2: Прогнать тест → FAIL**

```bash
cd ~/Downloads/spirits_back && pnpm build && node --test tests/tasks/extract-prefilter.test.js
```
Expected: FAIL, `shouldSkipTaskExtraction` не существует.

- [ ] **Step 3: Реализовать prefilter**

```typescript
// src/tasks/extract-prefilter.ts
const PROJECT_KEYWORDS = /\b(задач|план|сделат|запуст|настро|помоги|нужно|надо|кампани|пост|ролик|видео|реклам|подгот|клиент|проект|дедлайн|deadline|сроки|встреч|созвон|отчёт|отчет|отправ|написат|обсуди|договор|оплат|подпис|релиз)\b/i;
const PLEASANTRY = /^\s*(привет|здравств|спасибо|спасиб|пожалуйста|ок|окей|ага|да|нет|good|hi|hello|thanks|спс|ясно|понятно|круто|супер|👍|❤️)[!.\s]*$/i;
const SHORT_THRESHOLD = 25;

export function shouldSkipTaskExtraction(message: string): boolean {
  const trimmed = (message || '').trim();
  if (!trimmed) return true;
  if (PLEASANTRY.test(trimmed)) return true;
  if (trimmed.length < SHORT_THRESHOLD && !PROJECT_KEYWORDS.test(trimmed)) return true;
  return false;
}
```

- [ ] **Step 4: Подключить prefilter в extractFromTurn**

В `src/tasks/tasks.service.ts:81-90`:
```typescript
import { shouldSkipTaskExtraction } from './extract-prefilter';  // ← добавить в импорты

async extractFromTurn(userId, agentId, userMessage, assistantMessage): Promise<void> {
  if (!this.pg) return;
  if (shouldSkipTaskExtraction(userMessage)) return;   // ← новая строка
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return;
  // ... остальное не трогать
}
```

- [ ] **Step 5: Тесты PASS**

```bash
pnpm build && node --test tests/tasks/extract-prefilter.test.js
```
Expected: все 4 теста PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tasks/extract-prefilter.ts src/tasks/tasks.service.ts tests/tasks/extract-prefilter.test.js
git commit -m "perf(tasks): prefilter chat turns regex'ом до LLM-вызова (~70% спенда срезано)"
```

---

## Phase C — Миграция простых консьюмеров на Agent SDK (OAuth)

### Task C1: Migrate misc.streamLLM (search/compat ответы)

Простейший консьюмер — текст-only completion без tools. Хороший первый кандидат на боевую миграцию.

**Files:**
- Modify: `src/misc/misc.service.ts:772-806`

- [ ] **Step 1: Переписать streamLLM**

Заменить целиком `src/misc/misc.service.ts:772-806`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SdkEventTranslator } from '../chat/claude-agent.event-translator';

private async streamLLM(systemPrompt: string, userMessage: string, res: Response): Promise<void> {
  try {
    const translator = new SdkEventTranslator();
    const chunks: string[] = [];
    for await (const event of query({
      prompt: userMessage,
      options: {
        model: 'claude-haiku-4-5',
        systemPrompt,
        permissionMode: 'bypassPermissions',
        settingSources: [],
        includePartialMessages: true,
      } as any,
    })) {
      for (const e of translator.translate(event)) {
        if (e.type === 'item' && typeof (e as any).content === 'string') {
          chunks.push((e as any).content);
        }
        res.write(JSON.stringify(e) + '\n');
      }
    }
    // Post-process: убрать code-блоки из search_result JSON (это поведение было в старом коде)
    const full = chunks.join('');
    if (full.includes('search_result:') && full.includes('```')) {
      let cleaned = full.replace(/search_result:\s*```(?:json)?\s*\n?/g, 'search_result:');
      cleaned = cleaned.replace(/\n?```\s*$/g, '');
      res.write(JSON.stringify({ type: 'replace', content: cleaned }) + '\n');
    }
  } catch (e: any) {
    this.logger.error(`LLM error: ${e.message}`);
    res.write(JSON.stringify({ type: 'item', content: 'Ошибка при обработке запроса.' }) + '\n');
  }
  res.end();
}
```

- [ ] **Step 2: Прогнать существующие API-тесты по search/compat**

```bash
pnpm build && pm2 restart linkeon-api
node tests/runner.js --suite api --filter "search\|compat"
```
Expected: тесты search и compatibility PASS (ответы могут отличаться по содержанию, но wire format и статус ответа — те же).

- [ ] **Step 3: Manual smoke на test**

На `test.linkeon.io`:
1. Открыть Networking → search "нужен дизайнер" → бот отвечает осмысленно
2. Compatibility check между двумя профилями → возвращает оценку

- [ ] **Step 4: Commit**

```bash
git add src/misc/misc.service.ts
git commit -m "feat(misc): migrate streamLLM на Agent SDK (OAuth)"
```

### Task C2: Migrate scan-document (PDF parsing)

Single-shot, не streaming. PDF → JSON profile.

**Files:**
- Modify: `src/chat/chat.controller.ts:232-288`
- Create: `tests/chat/fixtures/sample-cv.pdf` (мелкий тестовый PDF с CV-like контентом)
- Create: `tests/chat/scan-document-oauth.test.js`

- [ ] **Step 1: Заготовить fixture PDF**

```bash
mkdir -p ~/Downloads/spirits_back/tests/chat/fixtures
# Создать 1-страничный PDF с текстом "Имя: Тест Тестов. Навыки: Python, NestJS." любым инструментом:
# - через pandoc: echo "# CV\n\nИмя: Тест Тестов\nНавыки: Python, NestJS" | pandoc -o tests/chat/fixtures/sample-cv.pdf
# - или взять любой существующий короткий PDF из docs/
```

- [ ] **Step 2: Написать E2E-тест**

```javascript
// tests/chat/scan-document-oauth.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

test('scan-document возвращает profile JSON через OAuth path', async () => {
  if (!process.env.TEST_JWT) {
    console.log('SKIP: no TEST_JWT');
    return;
  }
  const fd = new FormData();
  fd.append('file', fs.createReadStream(path.join(__dirname, 'fixtures/sample-cv.pdf')), 'cv.pdf');
  const r = await fetch('http://localhost:3001/webhook/scan-document', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TEST_JWT}`, ...fd.getHeaders() },
    body: fd,
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.output, 'should return output object');
  assert.ok(Array.isArray(j.output.profile) || Array.isArray(j.output.skills));
});
```

- [ ] **Step 3: Прогнать → FAIL (текущий путь через ANTHROPIC_API_KEY вернёт ответ, но мы хотим OAuth-путь)**

Для честного TDD временно убрать `ANTHROPIC_API_KEY` из локального `.env`:
```bash
ANTHROPIC_API_KEY= pnpm dev &
node --test tests/chat/scan-document-oauth.test.js
```
Expected: тест FAIL (500 "LLM not configured") — потому что код пока требует API key.

- [ ] **Step 4: Переписать scanDocument на Agent SDK**

Заменить `src/chat/chat.controller.ts:232-288`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import * as path from 'path';

@Post('scan-document')
@UseGuards(JwtGuard)
async scanDocument(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
  let cwd: string | null = null;
  try {
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
    await new Promise<void>((resolve, reject) => {
      upload.single('file')(req as any, res as any, (err: any) => err ? reject(err) : resolve());
    });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    cwd = path.join(os.tmpdir(), `scan-${crypto.randomUUID()}`);
    await fs.mkdir(cwd, { recursive: true });
    const safeName = (file.originalname || 'document.pdf').replace(/[^\w.\-]/g, '_');
    const pdfPath = path.join(cwd, safeName);
    await fs.writeFile(pdfPath, file.buffer);

    let collected = '';
    for await (const event of query({
      prompt: `Прочитай файл ${safeName} (он в текущей директории) и извлеки профиль пользователя. Верни ТОЛЬКО JSON без markdown-обёрток:\n{"name":"Имя","family_name":"Фамилия","profile":["факты"],"values":["ценности"],"skills":["навыки"],"beliefs":["убеждения"],"desires":["желания"],"interests":["интересы"],"search":["что ищет"]}`,
      options: {
        model: 'claude-haiku-4-5',
        cwd,
        allowedTools: ['Read'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
      } as any,
    })) {
      if (event.type === 'assistant') {
        for (const block of ((event as any).message?.content || []) as any[]) {
          if (block.type === 'text') collected += block.text;
        }
      }
    }

    let text = collected.trim();
    if (text.includes('```')) {
      text = text.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(200).json({ output: { profile: [collected] } });
    const parsed = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ output: parsed });
  } catch (e: any) {
    console.error('scan-document error:', e);
    return res.status(500).json({ error: e.message || 'Document parsing failed' });
  } finally {
    if (cwd) {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}
```

- [ ] **Step 5: Тест PASS**

```bash
pnpm build && pm2 restart linkeon-api
node --test tests/chat/scan-document-oauth.test.js
```
Expected: PASS — возвращён JSON с полями profile/skills/values.

- [ ] **Step 6: Commit**

```bash
git add src/chat/chat.controller.ts tests/chat/scan-document-oauth.test.js tests/chat/fixtures/sample-cv.pdf
git commit -m "feat(chat): migrate scan-document на Agent SDK (Read tool + OAuth)"
```

### Task C3: Migrate Машу — выбор пути

Маша (`agent.id === 3`) — единственный агент, исключённый из universal-роута (`chat.service.ts:137`). Использует Anthropic SDK напрямую с локальным CHAT_TOOLS для метафорических карт. Есть **два варианта** миграции — выбрать один до старта.

**Вариант A:** Пустить Машу через `streamUniversalAgent` (как Романа и прочих), карты реализовать как MCP-tool на стороне r.linkeon.io.

**Вариант B:** Мигрировать Машу на локальный Agent SDK с CHAT_TOOLS → MCP-сервером (как Юля). Машу не пускаем в universal — она остаётся «местной» с собственным MCP. Этот путь предпочтительнее если: (a) карты Маши сильно завязаны на локальную БД, (b) не хочется добавлять зависимости в r.linkeon.io.

**Default: Вариант B** (локальный SDK, не трогаем r.linkeon.io).

**Files (Вариант B):**
- Create: `src/chat/masha-tools.mcp.ts`
- Modify: `src/chat/chat.service.ts:9, 23, 34-38, 133-455` (удалить anthropic field, удалить Маша-only branch, добавить вызов нового `streamMashaViaSdk`)
- Create: `src/chat/masha-agent.service.ts` (по образцу `claude-agent.service.ts`)

- [ ] **Step 1: Прочитать CHAT_TOOLS — что портировать**

```bash
grep -n "CHAT_TOOLS\|name:\|input_schema" src/chat/chat-tools.ts 2>/dev/null || \
  grep -rn "CHAT_TOOLS\s*=" src/chat/ | head -5
```
Записать список tool'ов (`draw_card`, `interpret_card`, и т.д.) и их схемы.

- [ ] **Step 2: Создать MCP-сервер для Маши**

```typescript
// src/chat/masha-tools.mcp.ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ChatToolsService } from './chat-tools.service';  // существующий сервис handler'ов

export function buildMashaMcp(tools: ChatToolsService, ctx: { userId: string }) {
  const handle = async (name: string, args: any) => {
    const r = await tools.invoke(name, args, ctx);
    return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
  };
  return createSdkMcpServer({
    name: 'masha-tools',
    tools: [
      // ВАЖНО: 1:1 портируем каждый tool из текущего CHAT_TOOLS (src/chat/chat-tools.ts).
      // Описания и схемы из source, не сокращать — Маша их использует семантически.
      tool('draw_card', '...', { /* schema из chat-tools.ts */ }, async (a) => handle('draw_card', a)),
      // ... остальные tools 1:1
    ],
  });
}
```

- [ ] **Step 3: Создать masha-agent.service.ts (копия claude-agent.service.ts с правками)**

Скопировать `src/chat/claude-agent.service.ts` в `src/chat/masha-agent.service.ts` целиком, переименовать класс в `MashaAgentService` и метод в `streamMasha(ctx, message, chatSessionId, agentId, res)`. Заменить:
- `SMM_PRODUCER_SYSTEM_PROMPT` → `stableSystemPrompt + volatileSystemPrompt` из chat.service.ts:171-180
- `buildMcpServer` → вызов нашего `buildMashaMcp`
- `mcpServers: { 'smm-tools': ... }` → `mcpServers: { 'masha-tools': ... }`
- Удалить SMM-специфичные buffering / smm_scenario маркеры (lines 105-138)

Зарегистрировать сервис в `ChatModule.providers`.

- [ ] **Step 4: Удалить Маша-only ветку из chat.service.ts**

В `chat.service.ts:133-455` удалить:
- весь блок `if (agent.id !== 3) { return streamUniversalAgent(...); }` оставить **в той форме что есть** — он уже рутит всех кроме Маши через universal. Только заменить условие.

Конкретно, после Task SMM (Юля, line 98-131), сразу:
```typescript
// Маша → локальный Agent SDK с собственным MCP (карты).
if (agent.id === 3) {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');

  await this.pg.query(
    `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type) VALUES ($1, 'human', $2, $3, 'text')`,
    [chatSessionId, agent.id, message],
  );
  try {
    await this.mashaAgent.streamMasha({ userId, profileText }, message, chatSessionId, agent.id, res);
  } catch (err: any) {
    this.logger.error(`Masha streaming failed: ${err.message}`);
    try { res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n'); res.end(); } catch {}
  }
  return;
}

// Все остальные агенты — universal-роут как раньше
return this.streamUniversalAgent(/* ... те же аргументы как сейчас в 138-143 */);
```

Удалить весь Маша-only Anthropic-стрим: lines 146-455 (старый код с `this.anthropic.messages.stream`, retry на OpenRouter, и DeepSeek greeting). DeepSeek greeting перенести в `MashaAgentService` если нужен — но проще удалить и пустить greeting тоже через Agent SDK.

- [ ] **Step 5: Удалить anthropic field + import**

`chat.service.ts:9, 23, 34-38`:
```typescript
// удалить:
import Anthropic from '@anthropic-ai/sdk';
private anthropic: Anthropic | null = null;
// и в конструкторе:
if (process.env.ANTHROPIC_API_KEY) { this.anthropic = new Anthropic({ ... }); }
```

- [ ] **Step 6: Inject MashaAgentService**

В конструкторе `ChatService` добавить параметр `private readonly mashaAgent: MashaAgentService` и зарегистрировать сервис в `chat.module.ts`.

- [ ] **Step 7: Smoke test Маши**

На `test.linkeon.io` (любой юзер):
1. Открыть Маша в чате → сказать "привет" → должен ответить (greeting через OAuth path)
2. "вытяни карту" → должен вызвать `draw_card` MCP tool, вернуть карту с интерпретацией
3. Прогнать сессию из 5 ходов с темой `у меня сложная ситуация на работе` → Маша помнит контекст (resume sessionId)

- [ ] **Step 8: Commit**

```bash
git add src/chat/masha-tools.mcp.ts src/chat/masha-agent.service.ts src/chat/chat.service.ts src/chat/chat.module.ts
git commit -m "feat(chat): мигрировать Машу на локальный Agent SDK + MCP карт (OAuth)"
```

---

## Phase D — Миграция tool-loop консьюмеров

### Task D1: Migrate support на Agent SDK + MCP

Support — самый сложный из мигрируемых: tool-loop с custom tools (`escalate`, `get_user_balance`, `get_payment_history`, и т.д. — см. `SUPPORT_TOOLS` в `support.service.ts:30-97`). Целевой образец — Юля.

**Files:**
- Create: `src/support/support-tools.mcp.ts`
- Modify: `src/support/support.service.ts:6, 99-112, 328-405`

- [ ] **Step 1: Прочитать SUPPORT_TOOLS для портирования**

```bash
grep -nA 15 "SUPPORT_TOOLS\s*=" src/support/support.service.ts | head -100
```
Записать список tool'ов и их `input_schema` для каждого.

- [ ] **Step 2: Создать MCP-сервер**

```typescript
// src/support/support-tools.mcp.ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface SupportToolCtx { userId: string; ticketId: string }
export interface SupportToolHandler {
  invoke(name: string, args: any, ctx: SupportToolCtx): Promise<any>;
}

export function buildSupportMcp(handler: SupportToolHandler, ctx: SupportToolCtx) {
  const handle = async (name: string, args: any) => {
    const r = await handler.invoke(name, args, ctx);
    return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
  };
  return createSdkMcpServer({
    name: 'support-tools',
    tools: [
      // Каждый tool — 1:1 копия из SUPPORT_TOOLS (support.service.ts:30-97).
      // Описание и схема — точно как в source, чтобы не сломать поведение модели.
      tool(
        'escalate',
        'Передать тикет владельцу. Используй когда: критичный bug, requests for refund, спорная ситуация требующая человека.',
        { severity: z.enum(['low', 'normal', 'high', 'critical']), reason: z.string() },
        async (a) => handle('escalate', a),
      ),
      tool(
        'get_user_balance',
        'Получить текущий Linkeon-tokens баланс пользователя.',
        {},
        async (a) => handle('get_user_balance', a),
      ),
      tool(
        'get_payment_history',
        'Последние платежи пользователя (успешные и failed).',
        { limit: z.number().int().min(1).max(20).default(5) },
        async (a) => handle('get_payment_history', a),
      ),
      // ... продолжить для всех оставшихся tools из SUPPORT_TOOLS
    ],
  });
}
```

Извлечь существующие tool-handler'ы из приватных методов `SupportService` в отдельный класс `SupportToolHandler` (тот же файл support.service.ts или новый support-tools.service.ts), чтобы MCP-сервер мог их звать.

- [ ] **Step 3: Переписать generateAiResponse**

Заменить `src/support/support.service.ts:328-405`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildSupportMcp } from './support-tools.mcp';

private async generateAiResponse(ticketId: string, userId: string): Promise<void> {
  const history = await this.listMessages(userId, ticketId, true);
  const profile = await this.getUserContextData(userId);
  const health = await this.getServiceHealth();
  const systemPrompt = this.buildSystemPrompt(profile, health);

  const conversation = history
    .filter(m => ['user', 'ai', 'owner'].includes(m.sender_type))
    .map(m => ({ role: m.sender_type === 'user' ? 'user' : 'assistant', content: m.content }));

  if (!conversation.length || conversation[conversation.length - 1].role !== 'user') return;

  const lastUser = conversation[conversation.length - 1].content;
  const priorTurns = conversation.slice(0, -1)
    .map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
  const prompt = priorTurns ? `${priorTurns}\n\nUSER: ${lastUser}` : lastUser;

  const mcp = buildSupportMcp(this /* implements SupportToolHandler */, { userId, ticketId });
  let finalText = '';
  let escalated = false;
  const toolInvocations: any[] = [];

  try {
    for await (const event of query({
      prompt,
      options: {
        model: 'claude-haiku-4-5',
        systemPrompt,
        mcpServers: { 'support-tools': mcp },
        permissionMode: 'bypassPermissions',
        settingSources: [],
      } as any,
    })) {
      if (event.type === 'assistant') {
        for (const block of ((event as any).message?.content || []) as any[]) {
          if (block.type === 'text') finalText += block.text;
          if (block.type === 'tool_use') {
            toolInvocations.push({ name: block.name, input: block.input });
            if (block.name === 'escalate') escalated = true;
          }
        }
      }
    }
  } catch (e: any) {
    this.logger.error(`support OAuth error: ${e.message}`);
    await this.insertMessage(ticketId, 'ai', null,
      'Извините, у меня сейчас временные проблемы со связью. Попробуйте ещё раз через минуту.',
      { error: e.message });
    return;
  }

  await this.insertMessage(ticketId, 'ai', null, finalText, { escalated, tools: toolInvocations });
  if (escalated) {
    // существующая логика эскалации — оставить как было
    await this.escalate(ticketId, userId, /* reason */ 'AI-decided escalation', /* severity */ 'normal', finalText);
  }
}
```

- [ ] **Step 4: Удалить anthropic field**

`support.service.ts:6, 102, 109-111`:
```typescript
// удалить:
import Anthropic from '@anthropic-ai/sdk';
private anthropic: Anthropic | null = null;
// и инициализацию в конструкторе
```

Удалить guard `if (!this.anthropic)` в начале generateAiResponse (lines 329-335) — теперь OAuth всегда есть.

- [ ] **Step 5: Manual smoke test (тот же что в B1)**

На `test.linkeon.io` прогнать три типа запросов (простой / tool-use / эскалация). Сравнить с baseline'ом после B1.

- [ ] **Step 6: Commit**

```bash
git add src/support/support-tools.mcp.ts src/support/support.service.ts
git commit -m "feat(support): migrate AI tool-loop на Agent SDK + MCP (OAuth)"
```

### Task D2: Migrate tasks-extractor на Agent SDK

После Task B2 в LLM попадают только ~20% оборотов. Мигрируем их.

**Files:**
- Modify: `src/tasks/tasks.service.ts:88-89, 372-446`

- [ ] **Step 1: Переписать askLLMForDecision**

В `src/tasks/tasks.service.ts:372`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

private async askLLMForDecision(userId, agentId, userMessage, assistantMessage, activeTasks): Promise<any | null> {
  const activeBlock = activeTasks.length === 0
    ? '(нет активных задач)'
    : activeTasks
        .map((t, i) => `${i + 1}. id=${t.id}\n   title: ${t.title}\n   summary: ${t.summary || '(пусто)'}`)
        .join('\n\n');

  // ВАЖНО: prompt body — точная копия из текущего src/tasks/tasks.service.ts:388-420
  // (большой Russian prompt про определение задач). Не сокращать, не править.
  const prompt = `Ты — помощник, который ведёт операционную память пользователя на платформе my.linkeon.io.

После каждого диалога с любым ассистентом ты анализируешь реплики и решаешь — относится ли разговор к одной из текущих задач пользователя, или зарождается новая.

ТЕКУЩИЕ АКТИВНЫЕ ЗАДАЧИ пользователя:
${activeBlock}

ПОСЛЕДНЯЯ РЕПЛИКА ПОЛЬЗОВАТЕЛЯ (агент id=${agentId}):
"""
${userMessage.slice(0, 3000)}
"""

ОТВЕТ АССИСТЕНТА:
"""
${assistantMessage.slice(0, 3000)}
"""

Реши одно из:
- **none** — реплика бытовая, не про какую-либо задачу.
- **append** — это про существующую задачу. Укажи taskId, опиши что произошло (eventContent), обнови summary.
- **create** — это начало новой задачи. Дай title, summary, claudemd, firstEventContent.

Верни ТОЛЬКО JSON:
{"decision":"none|append|create","taskId":"...","title":"...","summary":"...","claudemd":"...","eventContent":"...","firstEventContent":"..."}`;
  // ↑ ПРИМЕЧАНИЕ: текущий промпт в коде длиннее. Скопировать полностью из tasks.service.ts:388-420.

  let collected = '';
  try {
    for await (const event of query({
      prompt,
      options: {
        model: 'claude-haiku-4-5',
        permissionMode: 'bypassPermissions',
        settingSources: [],
      } as any,
    })) {
      if (event.type === 'assistant') {
        for (const b of ((event as any).message?.content || []) as any[]) {
          if (b.type === 'text') collected += b.text;
        }
      }
    }
  } catch (e: any) {
    this.logger.warn(`tasks LLM error: ${e.message}`);
    return null;
  }

  const m = collected.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
```

- [ ] **Step 2: Убрать ANTHROPIC_API_KEY guard в extractFromTurn**

`src/tasks/tasks.service.ts:88-89` — удалить:
```typescript
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) return;
```

- [ ] **Step 3: Smoke test**

На `test.linkeon.io` админом отправить осмысленное сообщение в любой чат:
```
"Запусти кампанию по найму джунов с дедлайном через 2 недели"
```
Проверить:
```bash
ssh dv@85.192.61.231 'psql -d spirits -c "SELECT id, title, summary, created_at FROM tasks WHERE user_id = '\''79030169187'\'' ORDER BY created_at DESC LIMIT 3;"'
```
Expected: задача с подходящим title создана.

- [ ] **Step 4: Commit**

```bash
git add src/tasks/tasks.service.ts
git commit -m "feat(tasks): мигрировать extractor на Agent SDK (OAuth, после prefilter)"
```

---

## Phase E — dozvon: замена web_search

### Task E1: Migrate dozvon-chat на Agent SDK с WebSearch

**Files:**
- Modify: `src/dozvon/dozvon-chat.service.ts:1-150`

- [ ] **Step 1: Verify Agent SDK WebSearch работает**

Прогнать на проде однострочник:
```bash
ssh dvolkov@212.113.106.202 'cd /home/dvolkov/spirits && node -e "
const { query } = require(\"@anthropic-ai/claude-agent-sdk\");
(async () => {
  let text = \"\";
  for await (const e of query({
    prompt: \"Найди график работы магазина Магнит на 1-й Тверской-Ямской в Москве\",
    options: { model: \"claude-sonnet-4-5\", allowedTools: [\"WebSearch\"], permissionMode: \"bypassPermissions\", settingSources: [] }
  })) {
    if (e.type === \"assistant\") for (const b of (e.message?.content || [])) if (b.type === \"text\") text += b.text;
    if (e.type === \"result\") console.error(\"cost\", e.total_cost_usd);
  }
  console.log(text);
})();
"'
```
Expected: реальный ответ с актуальной информацией о магазине. Если ответ generic "не могу искать" — WebSearch tool не работает в этом env, Task E1 blocked, нужен Brave/Tavily.

- [ ] **Step 2: Переписать streamChat**

Заменить `src/dozvon/dozvon-chat.service.ts:91-150`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

async streamChat(campaignId: number, userMessage: string, res: Response): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  await this.addMessage(campaignId, 'user', userMessage);
  const history = await this.getHistory(campaignId);

  const campRes = await this.pg.query(
    `SELECT title, status, call_plan FROM dozvon_campaigns WHERE id = $1`,
    [campaignId],
  );
  const camp = campRes.rows[0];
  const contextNote = camp
    ? `\n\nТекущий статус задачи: ${camp.status}. Текущий title: "${camp.title || 'Новая задача'}".${
        camp.call_plan ? ` Текущий план:\n${JSON.stringify(camp.call_plan)}` : ''}`
    : '';

  const priorTurns = history.slice(-MAX_HISTORY)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

  let assistantText = '';
  try {
    for await (const event of query({
      prompt: priorTurns,
      options: {
        model: 'claude-sonnet-4-5',
        systemPrompt: SYSTEM_PROMPT + contextNote,
        allowedTools: ['WebSearch'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
        includePartialMessages: true,
      } as any,
    })) {
      // partial text deltas → frontend
      if (event.type === 'stream_event') {
        const ev = (event as any).event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          assistantText += ev.delta.text;
          res.write(JSON.stringify({ type: 'delta', text: ev.delta.text }) + '\n');
        }
      }
      // websearch tool call → notify frontend (для UI индикатора "ищу в сети")
      if (event.type === 'assistant') {
        for (const block of ((event as any).message?.content || []) as any[]) {
          if (block.type === 'tool_use' && block.name === 'WebSearch') {
            res.write(JSON.stringify({ type: 'tool', name: 'web_search', query: block.input?.query || '' }) + '\n');
          }
        }
      }
    }
  } catch (e: any) {
    this.logger.error(`streamChat OAuth error: ${e.message}`);
    res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n');
  }

  if (assistantText.trim()) {
    await this.addMessage(campaignId, 'assistant', assistantText);
  }
  res.end();
}
```

- [ ] **Step 3: Удалить anthropic field**

`src/dozvon/dozvon-chat.service.ts:4, 58`:
```typescript
// удалить:
import Anthropic from '@anthropic-ai/sdk';
private readonly anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

- [ ] **Step 4: Smoke test**

На `test.linkeon.io` (dozvon-кабинет):
1. Создать кампанию → в чате запросить план обзвона
2. Спросить "найди график работы магазина X на улице Y" → проверить что WebSearch вызывается, ответ содержит факты

- [ ] **Step 5: Commit**

```bash
git add src/dozvon/dozvon-chat.service.ts
git commit -m "feat(dozvon): заменить web_search_20250305 на Agent SDK WebSearch (OAuth)"
```

---

## Phase F — Убрать OpenRouter Anthropic fallback'и

### Task F1: Drop OpenRouter Anthropic из chat.service

После Task C3 Маша на OAuth — OpenRouter-fallback больше не нужен.

**Files:**
- Modify: `src/chat/chat.service.ts:341-380, 940-1000`

- [ ] **Step 1: Удалить streamChatViaOpenRouter и все его callsite**

В `chat.service.ts:940-1000` (метод `streamChatViaOpenRouter`) — удалить полностью.
Найти все callsites: `grep -n "streamChatViaOpenRouter" src/`. Удалить вызовы (после миграции C3 должны быть мертвы).

- [ ] **Step 2: Удалить 403→OpenRouter retry**

В `chat.service.ts:341-380` (блок `if (isForbidden && process.env.OPENROUTER_API_KEY)`) — этот код был частью Маша-Anthropic ветки. После C3 ветка целиком удалена, блок уже не существует. Verify:
```bash
grep -n "OPENROUTER_API_KEY\|openrouter.ai" src/chat/chat.service.ts
```
Expected: пусто.

- [ ] **Step 3: Commit**

```bash
git add src/chat/chat.service.ts
git commit -m "refactor(chat): убрать dead OpenRouter fallback (Маша уже на OAuth)"
```

### Task F2: Migrate neo4j fact extraction (OpenRouter → OAuth)

**Files:**
- Modify: `src/neo4j/neo4j.service.ts:455-560`

- [ ] **Step 1: Заменить axios.post(openrouter) на query()**

Найти метод (вероятно `extractFacts` или похожий) в `src/neo4j/neo4j.service.ts` около строк 459-521. Заменить тело:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// (внутри метода)
let collected = '';
try {
  for await (const event of query({
    prompt: extractionPrompt,
    options: {
      model: 'claude-haiku-4-5',
      systemPrompt: 'Ты извлекаешь факты из текста для построения knowledge graph. Возвращай только JSON-массив без markdown.',
      permissionMode: 'bypassPermissions',
      settingSources: [],
    } as any,
  })) {
    if (event.type === 'assistant') {
      for (const b of ((event as any).message?.content || []) as any[]) {
        if (b.type === 'text') collected += b.text;
      }
    }
  }
} catch (e: any) {
  this.logger.warn(`neo4j fact extraction OAuth error: ${e.message}`);
  return [];
}
// Дальше парсинг collected — точно как был у axios-варианта
```

- [ ] **Step 2: Удалить guard OPENROUTER_API_KEY и сам axios-блок**

В `src/neo4j/neo4j.service.ts:459` удалить:
```typescript
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) return [];
```

- [ ] **Step 3: Smoke test fact extraction**

```bash
# В test-чате отправить сообщение с богатым профильным контентом:
# "Я работаю CTO в стартапе, увлекаюсь скалолазанием, живу в Москве"
# Через 30 сек:
cypher-shell "MATCH (u:User {id: '79030169187'})-[:HAS]->(f:Fact) RETURN f.text ORDER BY f.createdAt DESC LIMIT 5;"
```
Expected: новые facts появились.

- [ ] **Step 4: Commit**

```bash
git add src/neo4j/neo4j.service.ts
git commit -m "feat(neo4j): migrate fact extraction OpenRouter → Agent SDK (OAuth)"
```

### Task F3: Migrate profile-compaction (OpenRouter → OAuth)

**Files:**
- Modify: `src/scheduler/profile-compaction.service.ts:205-320`

- [ ] **Step 1: Заменить оба axios-вызова (lines 244, 310) на query()**

В каждом из двух callsite'ов:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

let collected = '';
for await (const event of query({
  prompt: compactionPrompt,
  options: { model: 'claude-haiku-4-5', permissionMode: 'bypassPermissions', settingSources: [] } as any,
})) {
  if (event.type === 'assistant') {
    for (const b of ((event as any).message?.content || []) as any[]) {
      if (b.type === 'text') collected += b.text;
    }
  }
}
// Use `collected` дальше как раньше result.data.choices[0].message.content
```

- [ ] **Step 2: Удалить guard'ы OPENROUTER_API_KEY (lines 208, 274)**

- [ ] **Step 3: Добавить concurrency guard в cron-loop**

Profile-compaction крутится по cron'у пачкой пользователей. Чтобы не выжрать OAuth quota одним запуском, обернуть batch:
```typescript
// в основном цикле через всех users:
const BATCH_SIZE = 5;
for (let i = 0; i < users.length; i += BATCH_SIZE) {
  const batch = users.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map((u) => this.compactOne(u).catch((e) => this.logger.warn(`compact ${u.userId} failed: ${e.message}`))));
}
```

- [ ] **Step 4: Manual trigger для одного юзера**

```bash
curl -X POST https://test.linkeon.io/webhook/admin/compact-profile -d '{"userId":"79030169187"}' \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json"
```
Expected: 200 OK, в БД профиль укоротился (ai_profiles_consolidated.profile_text).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/profile-compaction.service.ts
git commit -m "feat(scheduler): migrate profile-compaction OpenRouter → Agent SDK (OAuth)"
```

---

## Phase G — Cleanup

### Task G1: Удалить ANTHROPIC_API_KEY и обновить документацию

**Files:**
- Modify: `.env.example`
- Modify: `src/support/health-probe.service.ts:39, 118-152`
- Modify: `scripts/sync-api-keys-to-test.sh:37`
- Modify: `CLAUDE.md`
- Modify: прод `/home/dvolkov/spirits/.env` (через ssh)

- [ ] **Step 1: Verify нет оставшихся ANTHROPIC_API_KEY читателей**

```bash
cd ~/Downloads/spirits_back
grep -rn "ANTHROPIC_API_KEY\|@anthropic-ai/sdk\b" src/ worker/ scripts/ 2>/dev/null | grep -v node_modules
```
Expected: единственный матч — в `scripts/sync-api-keys-to-test.sh:37` (его удалим в Step 4). Всё остальное должно быть пусто.

Если в src/ есть оставшиеся ссылки — STOP и доделать миграцию.

- [ ] **Step 2: Удалить probeAnthropic из health-probe**

`src/support/health-probe.service.ts`: удалить методы `probeAnthropic` (lines 118-152) и его вызов в Promise.all (line 39). Оставить только `probeOAuth` и `probeOpenRouter` (последний — если OpenRouter ещё нужен для DeepSeek или других не-Anthropic моделей; если нет — тоже удалить).

- [ ] **Step 3: Обновить .env.example**

В `~/Downloads/spirits_back/.env.example`:
```env
# === Claude (subscription via OAuth) ===
# Backend uses Claude через OAuth credentials в ~/.claude/.credentials.json.
# Никаких API ключей не нужно. Логин делается один раз: `claude login` на сервере.
# Лимиты: Claude Max plan, 5h rolling window.

# Удалить старую строку: ANTHROPIC_API_KEY=...
```

- [ ] **Step 4: Убрать ключ из sync скрипта**

`scripts/sync-api-keys-to-test.sh:37`: удалить `ANTHROPIC_API_KEY` из массива.

- [ ] **Step 5: Обновить CLAUDE.md**

В `~/Downloads/spirits_back/CLAUDE.md` добавить секцию:
```markdown
## Claude auth (OAuth, не API)

Бэк работает через Claude Max subscription по OAuth:
- Credentials на проде: `/home/dvolkov/.claude/.credentials.json`
- Setup: один раз — `claude login` под пользователем `dvolkov`
- Refresh: автоматический Agent SDK'ом
- Используют все консьюмеры: Юля (SMM), Маша, support, dozvon, tasks-extractor, scan-document, misc, neo4j, profile-compaction
- Бюджет: $1 ≈ 100k Linkeon-tokens (rate в `claude-agent.service.ts:179`)

`ANTHROPIC_API_KEY` больше нигде не используется. Если возникает аварийная необходимость — добавить как hotfix-feature-flag (см. rollback внизу).
```

- [ ] **Step 6: Deploy и удалить ключ из прода**

```bash
bash scripts/deploy.sh TEST_ONLY=1
# 24h soak — см. Task G2
# затем:
bash scripts/deploy.sh
ssh dvolkov@212.113.106.202 'sed -i.bak "/^ANTHROPIC_API_KEY=/d" /home/dvolkov/spirits/.env && pm2 restart linkeon-api'
```

- [ ] **Step 7: Verify ключа нет на проде**

```bash
ssh dvolkov@212.113.106.202 'grep -c "^ANTHROPIC_API_KEY" /home/dvolkov/spirits/.env || echo "0 (good)"'
curl https://my.linkeon.io/webhook/admin/health | jq '.services[] | select(.service == "oauth")'
```
Expected: 0 матчей, oauth-probe == ok.

- [ ] **Step 8: Commit**

```bash
git add .env.example src/support/health-probe.service.ts scripts/sync-api-keys-to-test.sh CLAUDE.md
git commit -m "chore: drop ANTHROPIC_API_KEY (полный переход на OAuth subscription)"
```

### Task G2: 24h soak на test перед прод-выкатом

- [ ] **Step 1: Deploy current state на test**

```bash
bash scripts/deploy.sh TEST_ONLY=1
```

- [ ] **Step 2: Monitor 24h**

Каждые 6 часов:
```bash
# Health
curl https://test.linkeon.io/webhook/admin/health | jq

# Логи на ошибки квоты
ssh dv@85.192.61.231 'pm2 logs linkeon-api --lines 1000 --nostream | grep -iE "quota|429|403|ANTHROPIC|oauth" | tail -20'

# OAuth refresh частота — должна быть не чаще раз в час
ssh dv@85.192.61.231 'stat -c "%y" /home/dv/.claude/.credentials.json'
```
Если видим `429` / `quota_exceeded` / refresh чаще 30 минут → rollback (см. ниже).

- [ ] **Step 3: При зелёном — выкатить прод**

```bash
bash scripts/deploy.sh
```
(Двухфазный скрипт сам прогонит test ещё раз, потом прод, см. CLAUDE.md.)

---

## Rollback strategy

Если на любом этапе видим деградацию:

1. **Откатить commit**: `git revert <commit-sha>` и `bash scripts/deploy.sh`. Это вернёт код к предыдущему рабочему состоянию.

2. **Если квота уже на исходе и Юля тоже падает**: временно вернуть `ANTHROPIC_API_KEY` в `.env` и добавить feature-flag `USE_API_FALLBACK=true`. В каждом мигрированном консьюмере проверять флаг и звать legacy-путь. Этот код придётся восстановить из истории Git — лежать он будет в Phase F-G коммитах.

3. **Долгосрочно**: повысить Max-тариф (5x → 20x) или подключить второй seat OAuth credentials (round-robin на стороне сервера).

---

## Verification checklist (после полного завершения)

- [ ] `grep -rn "ANTHROPIC_API_KEY" src/ worker/` — пусто
- [ ] `grep -rn "@anthropic-ai/sdk\b" src/ worker/` — пусто (только `claude-agent-sdk`)
- [ ] `grep -rn "openrouter.ai/api/v1/chat" src/` — пусто или только non-Anthropic модели (DeepSeek и т.д.)
- [ ] `grep -rn "anthropic/claude" src/` — пусто
- [ ] `https://my.linkeon.io/webhook/admin/health` → `oauth` service == ok, `anthropic` service отсутствует
- [ ] Smoke на проде: Маша / support / dozvon / scan-document / search-mate / compatibility — все работают
- [ ] Прод `.env` без `ANTHROPIC_API_KEY`
- [ ] `CLAUDE.md` обновлён (секция Claude auth)
- [ ] 24h на test без quota-ошибок
