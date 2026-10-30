# Запасной путь ClaudeCliService на Qwen — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** когда локальный `claude` на проде падает по входу/лимиту/перегрузке, тот же вызов автоматически повторяется тем же бинарём на модели Qwen (Alibaba Token Plan), и люди получают ответ.

**Architecture:** чистые функции запасного пути (конфиг из env, решение, модели, окружение процесса) — в новом `src/common/services/qwen-fallback.ts`; состояние (предохранитель на 5 мин, счётчики исходов) и сама оркестрация «Claude → Qwen» — в `ClaudeCliService.runRaw`. `classifyLlmError` переезжает в `src/common/llm-error.ts`, чтобы `common` не зависел от `monitoring`. Проверки живости ставят `noFallback: true`.

**Tech Stack:** NestJS 10, TypeScript, jest + ts-jest (мок `child_process.spawn`), Claude Code CLI 2.1.280.

**Spec:** `docs/superpowers/specs/2026-10-29-qwen-fallback-design.md` — читать первым.

**Рабочее место:** воркдерево `~/Downloads/spirits_back/.worktrees/qwen-fallback`, ветка `feat/qwen-fallback`. Все пути ниже — от его корня.

**Где гонять тесты.** На маке тяжёлое не гонять (CLAUDE.md). К тому же jest в `package.json` игнорирует `/.worktrees/` — в этом воркдереве `npx jest` найдёт 0 тестов. Поэтому каждый «Run» в задачах — на ноде, в своём воркдереве CI-клона (Задача 0 его заводит):

```bash
# с мака, после git push ветки
SHA=$(git -C ~/Downloads/spirits_back/.worktrees/qwen-fallback rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && git log -1 --oneline && source ~/.nvm/nvm.sh && npx jest <файлы>"
```

Коммит → `git push origin feat/qwen-fallback` → прогон на ноде. Красный тест «до реализации» ловится так же: закоммитить тест, запушить, прогнать.

---

## Карта файлов

| Файл | Что делает |
|---|---|
| Create `src/common/llm-error.ts` | `LlmOutageKind`, `classifyLlmError` — перенесены без изменений |
| Modify `src/monitoring/claude-health.service.ts` | импорт и реэкспорт классификатора; `noFallback` у пробы; `qwenFallbackAlertLine` и строка в алерте |
| Create `src/common/services/qwen-fallback.ts` | конфиг из env, сопоставление моделей, «стоит ли переключаться», окружение процесса |
| Create `src/common/services/qwen-fallback.spec.ts` | тесты чистых функций |
| Modify `src/common/services/claude-cli.service.ts` | `noFallback`, `ClaudeCliCallError`, `runRaw` → Claude/Qwen, предохранитель, `fallbackStats()`, `provider` в событии |
| Create `src/common/services/claude-cli.fallback.spec.ts` | тесты оркестрации на моке `spawn` |
| Modify `src/chat/chat.service.ts` | `noFallback: probe` у вызова Маши |
| Create `src/monitoring/claude-health.alert-line.spec.ts` | тест строки алерта |
| Create `scripts/qwen-fallback-check.js` | живая проверка на настоящем claude + Alibaba без выката |

---

### Task 0: CI-воркдерево на ноде

**Files:** нет (инфраструктура).

- [ ] **Step 1: Запушить ветку**

```bash
git -C ~/Downloads/spirits_back/.worktrees/qwen-fallback push -u origin feat/qwen-fallback
```

- [ ] **Step 2: Завести своё воркдерево на ноде и поставить зависимости**

```bash
SHA=$(git -C ~/Downloads/spirits_back/.worktrees/qwen-fallback rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add --detach ~/ci/wt/qwen-fallback $SHA && cd ~/ci/wt/qwen-fallback && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund 2>&1 | tail -2"
```

Expected: `added N packages`. Бэк ставится `npm ci`, не pnpm.

- [ ] **Step 3: Базовая линия — тесты затрагиваемых мест зелёные до правок**

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/qwen-fallback && source ~/.nvm/nvm.sh && npx jest src/common src/monitoring src/insights src/tg-bot 2>&1 | tail -6; npx tsc -p tsconfig.build.json --noEmit 2>&1 | tail -3; echo tsc=$?'
```

Expected: `Tests: … passed`, tsc без ошибок. Если что-то красное уже здесь — записать как базу и дальше мерить дельтой (в `npm test` бэка есть красное by design).

---

### Task 1: `classifyLlmError` → `src/common/llm-error.ts`

**Files:**
- Create: `src/common/llm-error.ts`
- Modify: `src/monitoring/claude-health.service.ts:11-30`

Чистый перенос, поведение не меняется; тесты — tsc и существующие спеки `insights`.

- [ ] **Step 1: Создать `src/common/llm-error.ts`**

```ts
// Классификация ошибки LLM → тип сбоя + человекочитаемая причина.
// Живёт в common/, потому что её зовут и мониторинг (claude-health), и сам
// ClaudeCliService (решение о запасном пути на Qwen): common не должен
// зависеть от monitoring. Чистая функция, без side-effects.
//
// Главный кейс, который раньше был невидим мониторингу: «недельный лимит»
// Claude-подписки — весь AI платформы (ассистенты через r.linkeon.io + Юля +
// Маша + VPM/VMM) сидит на ней, поэтому её исчерпание = полная деградация продукта.
export type LlmOutageKind = 'weekly_limit' | 'rate_limit' | 'auth' | 'overloaded' | 'timeout' | 'other';
export function classifyLlmError(msg: string): { kind: LlmOutageKind; human: string } {
  const m = String(msg || '').toLowerCase();
  if (/weekly limit|hit your .*limit|usage limit|limit .*reset|limit reached|исчерпан.*лимит|недельн/.test(m))
    return { kind: 'weekly_limit', human: 'Исчерпан лимит Claude-подписки (недельный/использования)' };
  if (/rate limit|too many requests|\b429\b/.test(m))
    return { kind: 'rate_limit', human: 'Rate limit Claude (слишком много запросов)' };
  if (/unauthorized|\b401\b|invalid api key|authentication|oauth|credential|not logged in|please run .*login/.test(m))
    return { kind: 'auth', human: 'Сбой авторизации Claude (OAuth/API-ключ)' };
  if (/overloaded|\b529\b|\b503\b|internal server|try again|temporarily/.test(m))
    return { kind: 'overloaded', human: 'Claude перегружен/временно недоступен' };
  if (/timeout|timed out|deadline/.test(m))
    return { kind: 'timeout', human: 'Таймаут вызова Claude' };
  return { kind: 'other', human: msg ? String(msg).slice(0, 160) : 'Неизвестная ошибка LLM' };
}
```

Перед сохранением сверить тело функции с `git show origin/main:src/monitoring/claude-health.service.ts | sed -n 11,30p` — регулярки должны совпасть символ в символ.

- [ ] **Step 2: В `claude-health.service.ts` заменить строки 11–30 (комментарий, тип и функцию) на импорт с реэкспортом**

```ts
// classifyLlmError переехал в common/llm-error.ts — его зовёт и ClaudeCliService
// (запасной путь на Qwen). Реэкспорт — для прежних импортов (insights.service).
import { classifyLlmError, LlmOutageKind } from '../common/llm-error';
export { classifyLlmError };
export type { LlmOutageKind };
```

Импорт поставить к остальным импортам вверху файла, реэкспорт — сразу под ними.

- [ ] **Step 3: Проверить, что ссылки целы**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback && grep -rn "classifyLlmError\|LlmOutageKind" src --include='*.ts'
```

Expected: определения только в `src/common/llm-error.ts`; `insights.service.ts` по-прежнему импортирует из `../monitoring/claude-health.service` — это работает через реэкспорт.

- [ ] **Step 4: Commit, push, tsc + insights на ноде**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/common/llm-error.ts src/monitoring/claude-health.service.ts
git commit -m "refactor: classifyLlmError — в common/llm-error (его будет звать ClaudeCliService)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK; npx jest src/insights 2>&1 | tail -4"
```

Expected: `TSC_OK`, insights зелёные.

---

### Task 2: чистые функции запасного пути

**Files:**
- Create: `src/common/services/qwen-fallback.ts`
- Test: `src/common/services/qwen-fallback.spec.ts`

- [ ] **Step 1: Написать падающий тест `src/common/services/qwen-fallback.spec.ts`**

```ts
import {
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_BREAKER_MS,
  isFallbackWorthy,
  qwenModelFor,
  qwenSpawnEnv,
  readQwenFallbackConfig,
} from './qwen-fallback';

const MODELS = { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash' };

describe('readQwenFallbackConfig', () => {
  it('без ключа — null (запасного пути нет)', () => {
    expect(readQwenFallbackConfig({})).toBeNull();
    expect(readQwenFallbackConfig({ QWEN_FALLBACK_API_KEY: '   ' })).toBeNull();
  });

  it('с ключом — значения по умолчанию, ключ без пробелов', () => {
    expect(readQwenFallbackConfig({ QWEN_FALLBACK_API_KEY: ' sk-sp-x ' })).toEqual({
      apiKey: 'sk-sp-x',
      baseUrl: QWEN_DEFAULT_BASE_URL,
      models: MODELS,
      breakerMs: QWEN_DEFAULT_BREAKER_MS,
    });
  });

  it('переопределения из env', () => {
    expect(readQwenFallbackConfig({
      QWEN_FALLBACK_API_KEY: 'k',
      QWEN_FALLBACK_BASE_URL: 'https://x.example/apps/anthropic',
      QWEN_FALLBACK_MODEL_OPUS: 'm-opus',
      QWEN_FALLBACK_MODEL_SONNET: 'm-sonnet',
      QWEN_FALLBACK_MODEL_HAIKU: 'm-haiku',
      QWEN_FALLBACK_BREAKER_MS: '60000',
    })).toEqual({
      apiKey: 'k',
      baseUrl: 'https://x.example/apps/anthropic',
      models: { opus: 'm-opus', sonnet: 'm-sonnet', haiku: 'm-haiku' },
      breakerMs: 60000,
    });
  });

  it('кривое окно предохранителя — по умолчанию; 0 — допустимо', () => {
    const base = { QWEN_FALLBACK_API_KEY: 'k' };
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: 'abc' })!.breakerMs).toBe(QWEN_DEFAULT_BREAKER_MS);
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: '-5' })!.breakerMs).toBe(QWEN_DEFAULT_BREAKER_MS);
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: '' })!.breakerMs).toBe(QWEN_DEFAULT_BREAKER_MS);
    expect(readQwenFallbackConfig({ ...base, QWEN_FALLBACK_BREAKER_MS: '0' })!.breakerMs).toBe(0);
  });
});

describe('qwenModelFor', () => {
  it.each([
    ['claude-opus-5-5', 'qwen3.8-max'],
    ['opus', 'qwen3.8-max'],
    ['default', 'qwen3.8-max'],
    ['что-то незнакомое', 'qwen3.8-max'],
    ['sonnet', 'qwen3.8-flash'],
    ['claude-sonnet-5', 'qwen3.8-flash'],
    ['haiku', 'qwen3.6-flash'],
    ['claude-haiku-4-5', 'qwen3.6-flash'],
    ['Claude-Haiku-4-5-20251001', 'qwen3.6-flash'],
  ])('%s → %s', (requested, expected) => {
    expect(qwenModelFor(requested, MODELS)).toBe(expected);
  });
});

describe('isFallbackWorthy', () => {
  it.each([
    'claude CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    'claude CLI exited with code 1: Not logged in · Please run /login',
    "claude CLI error: You've hit your weekly limit · resets Nov 3",
    'claude CLI error: API Error: 429 rate limit',
    'claude CLI error: API Error: 529 Overloaded',
  ])('переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(true);
  });

  it.each([
    'claude CLI timeout after 60000ms',
    'claude CLI returned invalid JSON: Unexpected token n in JSON at position 0',
    'claude CLI spawn error: ENOENT',
  ])('не переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(false);
  });
});

describe('qwenSpawnEnv', () => {
  const cfg = readQwenFallbackConfig({ QWEN_FALLBACK_API_KEY: 'sk-sp-x' })!;

  it('снимает чужие ANTHROPIC_* и OAuth-токен, ставит адрес, ключ, модели, один повтор', () => {
    const env = qwenSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'old',
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    }, cfg);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: QWEN_DEFAULT_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'sk-sp-x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.8-max',
      CLAUDE_CODE_MAX_RETRIES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('не меняет переданный объект', () => {
    const base = { ANTHROPIC_API_KEY: 'old' };
    qwenSpawnEnv(base, cfg);
    expect(base).toEqual({ ANTHROPIC_API_KEY: 'old' });
  });
});
```

- [ ] **Step 2: Commit, push, убедиться, что падает**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/common/services/qwen-fallback.spec.ts
git commit -m "test: qwen-fallback — чистые функции (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest src/common/services/qwen-fallback 2>&1 | tail -8"
```

Expected: FAIL — `Cannot find module './qwen-fallback'`.

- [ ] **Step 3: Написать `src/common/services/qwen-fallback.ts`**

```ts
import { classifyLlmError, LlmOutageKind } from '../llm-error';

/**
 * Запасной путь ClaudeCliService на Qwen (Alibaba Model Studio, Anthropic-
 * совместимый адрес). Тот же бинарь claude и те же флаги — меняются только
 * модель и окружение процесса. Спецификация:
 * docs/superpowers/specs/2026-10-29-qwen-fallback-design.md
 *
 * Здесь — только чистые функции: конфиг из env, решение «переключаться ли»,
 * сопоставление моделей, окружение процесса. Состояние (предохранитель,
 * счётчики исходов) живёт в ClaudeCliService.
 */

export interface QwenModels {
  opus: string;
  sonnet: string;
  haiku: string;
}

export interface QwenFallbackConfig {
  apiKey: string;
  baseUrl: string;
  models: QwenModels;
  /** Сколько после сбоя Claude вызовы идут сразу на Qwen, мс. */
  breakerMs: number;
}

/** Адрес Token Plan (личный и Team) — из инструкции Alibaba для Claude Code. */
export const QWEN_DEFAULT_BASE_URL = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic';
export const QWEN_DEFAULT_MODELS: QwenModels = {
  opus: 'qwen3.8-max',
  sonnet: 'qwen3.8-flash',
  haiku: 'qwen3.6-flash',
};
export const QWEN_DEFAULT_BREAKER_MS = 5 * 60_000;

const trimmed = (v: string | undefined): string => (v ?? '').trim();

/** null — ключа нет, запасного пути нет (test, локально, тесты). */
export function readQwenFallbackConfig(env: NodeJS.ProcessEnv = process.env): QwenFallbackConfig | null {
  const apiKey = trimmed(env.QWEN_FALLBACK_API_KEY);
  if (!apiKey) return null;
  const breakerRaw = trimmed(env.QWEN_FALLBACK_BREAKER_MS);
  const breaker = Number(breakerRaw);
  return {
    apiKey,
    baseUrl: trimmed(env.QWEN_FALLBACK_BASE_URL) || QWEN_DEFAULT_BASE_URL,
    models: {
      opus: trimmed(env.QWEN_FALLBACK_MODEL_OPUS) || QWEN_DEFAULT_MODELS.opus,
      sonnet: trimmed(env.QWEN_FALLBACK_MODEL_SONNET) || QWEN_DEFAULT_MODELS.sonnet,
      haiku: trimmed(env.QWEN_FALLBACK_MODEL_HAIKU) || QWEN_DEFAULT_MODELS.haiku,
    },
    breakerMs: breakerRaw !== '' && Number.isFinite(breaker) && breaker >= 0 ? breaker : QWEN_DEFAULT_BREAKER_MS,
  };
}

/**
 * Что уходит в --model вместо модели Claude. Полный id Claude Alibaba не знает,
 * поэтому сопоставляем по классу. Всё незнакомое (default, opus, id Opus) —
 * главная модель: лучше переплатить кредитами, чем ответить слабее.
 */
export function qwenModelFor(requested: string, models: QwenModels): string {
  const m = requested.trim().toLowerCase();
  if (m === 'haiku' || m.startsWith('claude-haiku')) return models.haiku;
  if (m === 'sonnet' || m.startsWith('claude-sonnet')) return models.sonnet;
  return models.opus;
}

/**
 * Сбои доступа к Claude — повтор на Qwen имеет смысл. timeout и other — нет:
 * повтор удвоил бы время хода или повторил бы ошибку самого запроса.
 */
const FALLBACK_KINDS: ReadonlySet<LlmOutageKind> = new Set<LlmOutageKind>([
  'auth',
  'weekly_limit',
  'rate_limit',
  'overloaded',
]);

export function isFallbackWorthy(errorMessage: string): boolean {
  return FALLBACK_KINDS.has(classifyLlmError(errorMessage).kind);
}

/**
 * Окружение запасного процесса: копия base без ANTHROPIC_* и без
 * CLAUDE_CODE_OAUTH_TOKEN, плюс адрес и ключ Alibaba.
 *
 * Ключ — в ANTHROPIC_AUTH_TOKEN, не в ANTHROPIC_API_KEY: при живом входе по
 * OAuth API_KEY в -p игнорируется, и CLI шлёт в Alibaba OAuth-токен → 401
 * (проба 29.10, CLI 2.1.280). AUTH_TOKEN вход перебивает.
 *
 * CLAUDE_CODE_MAX_RETRIES=1: без него на 401 CLI делает 11 попыток с
 * нарастающей паузой — минуты висения вместо ~3 с.
 *
 * ANTHROPIC_DEFAULT_*_MODEL — для внутренних вызовов самого CLI (например,
 * WebFetch пересказывает страницу «быстрой» моделью): иначе он попросит у
 * Alibaba claude-haiku и упадёт.
 */
export function qwenSpawnEnv(base: NodeJS.ProcessEnv, cfg: QwenFallbackConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') continue;
    env[k] = v;
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.models.haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: cfg.models.opus,
    CLAUDE_CODE_MAX_RETRIES: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}
```

- [ ] **Step 4: Commit, push, прогнать — зелёный**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/common/services/qwen-fallback.ts
git commit -m "feat: qwen-fallback — конфиг из env, модели, решение, окружение процесса

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest src/common/services/qwen-fallback 2>&1 | tail -6"
```

Expected: PASS, все тесты файла.

---

### Task 3: оркестрация в `ClaudeCliService`

**Files:**
- Modify: `src/common/services/claude-cli.service.ts`
- Test: `src/common/services/claude-cli.fallback.spec.ts`

- [ ] **Step 1: Написать падающий тест `src/common/services/claude-cli.fallback.spec.ts`**

```ts
// Мокаем spawn ДО импорта сервиса: сервис берёт spawn из 'child_process' на
// уровне модуля.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Запасной путь на Qwen (spec 2026-10-29-qwen-fallback-design.md): когда вызов
 * Claude падает по входу/лимиту/перегрузке и модель ещё ничего не сделала
 * инструментами, тот же вызов повторяется тем же бинарём с моделью Qwen и
 * окружением Alibaba. Проверки живости (noFallback) — только Claude.
 */

const spawnMock = spawn as unknown as jest.Mock;

/** Фейковый процесс: на следующем тике отдаёт stdout и закрывается с кодом code. */
function fakeProc(stdout: string, code = 0) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    outH.forEach((cb) => cb(Buffer.from(stdout)));
    on['close']?.(code);
  });
  return proc;
}

/** Процесс, который не отвечает никогда (для таймаута). */
function hangingProc() {
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  } as any;
}

const OK = (result: string, cost = 0.01) =>
  JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
// Так CLI 2.1.280 отвечает при протухшем OAuth: код 1, JSON с is_error в stdout.
const AUTH_FAIL = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
const LIMIT_FAIL = JSON.stringify({ is_error: true, result: "You've hit your weekly limit · resets Nov 3" });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** env и --model i-го вызова spawn. */
const spawnEnv = (i: number) => spawnMock.mock.calls[i][2]?.env as NodeJS.ProcessEnv | undefined;
const spawnModel = (i: number) => {
  const a: string[] = spawnMock.mock.calls[i][1];
  return a[a.indexOf('--model') + 1];
};
const withoutModel = (a: string[]) => {
  const c = [...a];
  c.splice(c.indexOf('--model'), 2);
  return c;
};

const VARS = [
  'QWEN_FALLBACK_API_KEY', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_BREAKER_MS',
  'QWEN_FALLBACK_MODEL_OPUS', 'QWEN_FALLBACK_MODEL_SONNET', 'QWEN_FALLBACK_MODEL_HAIKU',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

describe('ClaudeCliService — запасной путь на Qwen', () => {
  it('сбой входа Claude → тот же вызов на Qwen: модель и окружение Alibaba, ответ и цена — от Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('ок от qwen', 0.02)));
    const svc = new ClaudeCliService();

    const r = await svc.textWithCost('привет', { model: 'claude-opus-5-5' });

    expect(r).toEqual({ text: 'ок от qwen', costUsd: 0.02 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnModel(0)).toBe('claude-opus-5-5');
    expect(spawnEnv(0)).toBeUndefined();
    expect(spawnModel(1)).toBe('qwen3.8-max');
    expect(spawnEnv(1)).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'sk-sp-test', CLAUDE_CODE_MAX_RETRIES: '1' });
    // Кроме модели — те же argv: промпт, --tools, --allowedTools, формат вывода.
    expect(withoutModel(spawnMock.mock.calls[1][1])).toEqual(withoutModel(spawnMock.mock.calls[0][1]));
  });

  it('недельный лимит (is_error при коде 0) — тоже переключает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(LIMIT_FAIL, 0))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('модель по умолчанию (haiku) → qwen3.6-flash; переопределение из env', async () => {
    process.env.QWEN_FALLBACK_MODEL_HAIKU = 'my-flash';
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await new ClaudeCliService().text('x');
    expect(spawnModel(1)).toBe('my-flash');
  });

  it('без ключа — запасного пути нет, ошибка исходная', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    spawnMock.mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1));
    await expect(new ClaudeCliService().text('x')).rejects.toThrow('Failed to authenticate: OAuth');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('таймаут Claude — не переключает', async () => {
    spawnMock.mockImplementationOnce(() => hangingProc());
    await expect(new ClaudeCliService().text('x', { timeoutMs: 5 })).rejects.toThrow('timeout');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('прочая ошибка (кривой JSON) — не переключает', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc('not json', 0));
    await expect(new ClaudeCliService().text('x')).rejects.toThrow('invalid JSON');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('noFallback — только Claude; его сбой предохранитель не открывает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('claude')));
    const svc = new ClaudeCliService();
    await expect(svc.text('probe', { noFallback: true })).rejects.toThrow('Failed to authenticate');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // следующий обычный вызов пробует Claude, а не идёт сразу на Qwen
    await expect(svc.text('y')).resolves.toBe('claude');
    expect(spawnEnv(1)).toBeUndefined();
  });

  it('модель успела вызвать инструмент до сбоя — не переключает (инструмент сработал бы дважды)', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: 'API Error: 529 Overloaded' },
    ), 1));
    await expect(new ClaudeCliService().textWithCost('x', { onProgress: () => {} })).rejects.toThrow('529');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('вызов с MCP без stream-json — не переключает (вызов инструмента не виден)', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1));
    await expect(new ClaudeCliService().text('x', {
      mcpServers: { products: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    })).rejects.toThrow('Failed to authenticate');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('stream-json: сбой входа до инструментов → Qwen, onProgress видит его инструменты', async () => {
    const seen: string[] = [];
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1))
      .mockImplementationOnce(() => fakeProc(lines(
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'result', is_error: false, result: 'готово', total_cost_usd: 0.03, duration_ms: 7 },
      )));
    const r = await new ClaudeCliService().textWithCost('x', { onProgress: (e) => seen.push(e.name) });
    expect(r).toEqual({ text: 'готово', costUsd: 0.03 });
    expect(seen).toEqual(['Read']);
    expect(spawnEnv(1)).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'sk-sp-test' });
  });

  it('упали оба — в ошибке обе причины, Claude первой', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const err = await new ClaudeCliService().text('x').catch((e) => e);
    expect(err.message).toMatch(
      /^claude CLI exited with code 1: Failed to authenticate: OAuth.* \| qwen fallback: claude CLI exited with code 1: Failed to authenticate\. API Error: 401/,
    );
  });

  it('событие claude_cli_call помечено provider и fallback', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService(pg as any);
    await svc.text('x', { model: 'claude-opus-5-5' });
    expect(JSON.parse(pg.query.mock.calls[0][1][0])).toMatchObject({
      model: 'qwen3.8-max', provider: 'qwen', fallback: true, ok: true,
    });
    await svc.text('probe', { noFallback: true }); // успех Claude
    expect(JSON.parse(pg.query.mock.calls[1][1][0])).toMatchObject({
      model: 'claude-haiku-4-5', provider: 'claude', fallback: false,
    });
  });
});

describe('ClaudeCliService — предохранитель', () => {
  it('после переключения — сразу Qwen; по истечении окна — снова Claude', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.QWEN_FALLBACK_BREAKER_MS = '60000';
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов 1: Claude падает
      .mockImplementationOnce(() => fakeProc(OK('q1')))     // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(OK('q2')))     // вызов 2: окно открыто — сразу Qwen
      .mockImplementationOnce(() => fakeProc(OK('c3')));    // вызов 3: окно истекло — Claude
    const svc = new ClaudeCliService();

    expect(await svc.text('1')).toBe('q1');
    now += 30_000;
    expect(await svc.text('2')).toBe('q2');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnEnv(2)).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'sk-sp-test' });
    now += 31_000;
    expect(await svc.text('3')).toBe('c3');
    expect(spawnEnv(3)).toBeUndefined();
  });

  it('успешная проба живости (noFallback) окно закрывает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q1')))
      .mockImplementationOnce(() => fakeProc(OK('probe ok')))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();

    await svc.text('1');
    expect(await svc.text('probe', { noFallback: true })).toBe('probe ok');
    expect(spawnEnv(2)).toBeUndefined(); // проба — на Claude, несмотря на окно
    expect(await svc.text('2')).toBe('c');
    expect(spawnEnv(3)).toBeUndefined(); // окно закрыто — снова Claude
  });

  it('ошибка при открытом окне — сообщение с пометкой про окно и причиной Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q1')))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const svc = new ClaudeCliService();
    await svc.text('1');
    const err = await svc.text('2').catch((e) => e);
    expect(err.message).toMatch(/^claude CLI пропущен \(окно запасного пути\) \| qwen fallback: .*401/);
  });
});

describe('ClaudeCliService.fallbackStats', () => {
  it('ключа нет — enabled: false', () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    expect(new ClaudeCliService().fallbackStats()).toMatchObject({ enabled: false, ok: 0, failed: 0 });
  });

  it('считает исходы за 15 минут', async () => {
    let now = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.QWEN_FALLBACK_BREAKER_MS = '0'; // без окна: каждый вызов сначала Claude
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')))
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const svc = new ClaudeCliService();
    await svc.text('1');
    await svc.text('2').catch(() => {});
    expect(svc.fallbackStats()).toMatchObject({ enabled: true, ok: 1, failed: 1 });
    now += 16 * 60_000;
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Commit, push, убедиться, что падает**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/common/services/claude-cli.fallback.spec.ts
git commit -m "test: ClaudeCliService — запасной путь на Qwen (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest src/common/services/claude-cli.fallback 2>&1 | tail -15"
```

Expected: FAIL — ts-jest не знает `noFallback` и `fallbackStats` (ошибка типов), либо тесты на переключение падают на одном `spawn`.

- [ ] **Step 3: Импорты в `claude-cli.service.ts`**

После `import { neutralizeAtMentions, stripWordJoiner } from '../agent-guards';` добавить:

```ts
import { classifyLlmError } from '../llm-error';
import {
  QwenFallbackConfig,
  isFallbackWorthy,
  qwenModelFor,
  qwenSpawnEnv,
  readQwenFallbackConfig,
} from './qwen-fallback';
```

- [ ] **Step 4: Класс ошибки и окно статистики — после `const MCP_CONFIG_STALE_MS = …;`**

```ts
/** За какое окно fallbackStats() считает исходы запасного пути (для алерта). */
const FALLBACK_STATS_WINDOW_MS = 15 * 60_000;

/**
 * Ошибка вызова CLI. toolUsed — модель успела вызвать инструмент до сбоя
 * (виден только в stream-json). Такой вызов на Qwen не повторяется:
 * инструмент с последствиями (правка продукта, жалоба в поддержку) сработал бы
 * дважды.
 */
export class ClaudeCliCallError extends Error {
  constructor(message: string, readonly toolUsed: boolean) {
    super(message);
    this.name = 'ClaudeCliCallError';
  }
}
```

- [ ] **Step 5: Поле `noFallback` — последним в `ClaudeCliOptions`, после `mcpServers?: …;`**

```ts
  /** Только Claude, без запасного пути на Qwen. Для проверок живости Claude:
   *  с запасным путём они показывали бы «зелёный», когда Claude лежит. Сбой
   *  такого вызова предохранитель не открывает, успех — закрывает. */
  noFallback?: boolean;
```

- [ ] **Step 6: Состояние — в класс, после `private readonly claudeBin = …;`**

```ts
  /** До какого момента (Date.now()) вызовы идут сразу на Qwen, не пробуя
   *  Claude: на 429/529 CLI сам долго повторяет запрос, и без окна каждый ход
   *  ждал бы этого заново. 0 — окно закрыто. */
  private breakerOpenUntil = 0;
  /** Исходы запасных вызовов за последние FALLBACK_STATS_WINDOW_MS. */
  private fallbackOutcomes: Array<{ at: number; ok: boolean }> = [];
```

- [ ] **Step 7: `trackCallEvent` — добавить `provider`**

Заменить метод целиком:

```ts
  private trackCallEvent(opts: { costUsd: number; model: string; durationMs: number; ok: boolean; provider: 'claude' | 'qwen' }) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('claude_cli_call', $1::jsonb)`,
      [JSON.stringify({
        cost_usd: opts.costUsd,
        model: opts.model,
        duration_ms: opts.durationMs,
        ok: opts.ok,
        provider: opts.provider,
        fallback: opts.provider === 'qwen',
      })],
    ).catch((e: any) => this.logger.warn(`claude_cli_call event insert failed: ${e.message}`));
  }
```

- [ ] **Step 8: `fallbackStats()` — публичный метод, сразу после `trackCallEvent`**

```ts
  /** Состояние запасного пути — для алерта мониторинга. */
  fallbackStats(now: number = Date.now()): { enabled: boolean; ok: number; failed: number; breakerOpenUntil: number } {
    this.pruneFallbackOutcomes(now);
    const ok = this.fallbackOutcomes.filter((o) => o.ok).length;
    return {
      enabled: !!readQwenFallbackConfig(),
      ok,
      failed: this.fallbackOutcomes.length - ok,
      breakerOpenUntil: this.breakerOpenUntil,
    };
  }

  private noteFallbackOutcome(ok: boolean): void {
    const now = Date.now();
    this.fallbackOutcomes.push({ at: now, ok });
    this.pruneFallbackOutcomes(now);
  }

  private pruneFallbackOutcomes(now: number): void {
    const from = now - FALLBACK_STATS_WINDOW_MS;
    this.fallbackOutcomes = this.fallbackOutcomes.filter((o) => o.at >= from);
  }
```

- [ ] **Step 9: `runRaw` → оркестрация; прежнее тело — в `runOnce`**

Заменить метод `runRaw` целиком на четыре метода:

```ts
  /**
   * Claude, при сбое доступа — тот же вызов на Qwen (spec
   * 2026-10-29-qwen-fallback-design.md). Без ключа QWEN_FALLBACK_API_KEY и с
   * noFallback — ровно прежнее поведение.
   */
  private async runRaw(prompt: string, opts: ClaudeCliOptions): Promise<{ text: string; costUsd: number }> {
    const qwen = opts.noFallback ? null : readQwenFallbackConfig();
    if (qwen && Date.now() < this.breakerOpenUntil) {
      return this.runOnQwen(prompt, opts, qwen, null);
    }
    let res: { text: string; costUsd: number };
    try {
      res = await this.runOnce(prompt, opts, null);
    } catch (e: any) {
      if (!qwen || !this.mayRetryOnQwen(e, opts)) throw e;
      const msg = String(e?.message ?? e);
      this.breakerOpenUntil = Date.now() + qwen.breakerMs;
      this.logger.warn(`claude CLI → запасной Qwen (${classifyLlmError(msg).kind}): ${msg.slice(0, 200)}`);
      return this.runOnQwen(prompt, opts, qwen, e);
    }
    // Claude ответил (в том числе проба с noFallback) — окно закрыто.
    this.breakerOpenUntil = 0;
    return res;
  }

  /** Повтор на Qwen — только для сбоев доступа к Claude (вход, лимит,
   *  перегрузка) и только если модель ещё ничего не сделала инструментами. */
  private mayRetryOnQwen(e: unknown, opts: ClaudeCliOptions): boolean {
    if (!isFallbackWorthy(String((e as any)?.message ?? e))) return false;
    if (e instanceof ClaudeCliCallError && e.toolUsed) return false;
    // Без stream-json вызов инструмента не виден, а инструменты с
    // последствиями — только MCP: такой вызов не повторяем вслепую.
    const hasMcp = !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;
    if (hasMcp && !opts.onProgress) return false;
    return true;
  }

  private async runOnQwen(
    prompt: string,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig,
    claudeError: unknown | null,
  ): Promise<{ text: string; costUsd: number }> {
    try {
      const res = await this.runOnce(prompt, opts, qwen);
      this.noteFallbackOutcome(true);
      return res;
    } catch (qe: any) {
      this.noteFallbackOutcome(false);
      const qmsg = String(qe?.message ?? qe);
      this.logger.error(`запасной Qwen тоже упал: ${qmsg.slice(0, 200)}`);
      // Причина Claude — первой: по ней classifyLlmError и тексты пользователю
      // у вызывающих работают как раньше.
      const head = claudeError
        ? String((claudeError as any)?.message ?? claudeError)
        : 'claude CLI пропущен (окно запасного пути)';
      throw new Error(`${head} | qwen fallback: ${qmsg}`);
    }
  }

  /** Один запуск CLI: qwen = null — Claude, иначе — модель и окружение Alibaba. */
  private async runOnce(
    prompt: string,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig | null,
  ): Promise<{ text: string; costUsd: number }> {
    // Одноразовые каталоги вызова (создаются только когда нужны — см. ниже):
    // копии вложений и конфиг MCP с токенами. Снимаются в finally — и на успехе,
    // и на падении, и по таймауту, — чтобы не копить в tmp ни чужих файлов, ни
    // живых токенов. У запасного запуска — свои: каталоги упавшей попытки
    // к этому моменту уже сняты.
    const perCallTmpDirs: string[] = [];
    try {
      return await this.spawnClaude(prompt, opts, (dir) => { perCallTmpDirs.push(dir); }, qwen);
    } finally {
      for (const dir of perCallTmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e: any) { this.logger.warn(`per-call tmp cleanup failed (${dir}): ${e.message}`); }
      }
    }
  }
```

- [ ] **Step 10: `spawnClaude` — параметр `qwen`, модель, окружение, `toolUsed`, `provider`**

Шесть точечных правок внутри `spawnClaude`:

(a) Сигнатура — добавить четвёртый параметр:

```ts
  private spawnClaude(
    prompt: string,
    opts: ClaudeCliOptions,
    registerTmpDir: (dir: string) => void,
    qwen: QwenFallbackConfig | null,
  ): Promise<{ text: string; costUsd: number }> {
```

(b) Строку `const model = opts.model ?? 'claude-haiku-4-5';` заменить на:

```ts
    const requestedModel = opts.model ?? 'claude-haiku-4-5';
    // На запасном пути в --model уходит модель Qwen: полный id Claude Alibaba не знает.
    const model = qwen ? qwenModelFor(requestedModel, qwen.models) : requestedModel;
    const provider: 'claude' | 'qwen' = qwen ? 'qwen' : 'claude';
```

(c) Строку `const proc = spawn(this.claudeBin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: spawnCwd });` заменить на:

```ts
      // Обычный запуск наследует process.env как есть; запасной получает своё
      // окружение (адрес и ключ Alibaba) — и только он.
      const proc = spawn(this.claudeBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: spawnCwd,
        ...(qwen ? { env: qwenSpawnEnv(process.env, qwen) } : {}),
      });
```

(d) Сразу под объявлениями `let stdout = ''; let stderr = '';` добавить:

```ts
      // Вызвала ли модель инструмент до сбоя — решает, можно ли повторить на Qwen.
      let sawToolUse = false;
      const fail = (message: string) => reject(new ClaudeCliCallError(message, sawToolUse));
```

(e) Цикл по `ev.message.content` в обработчике stdout заменить на:

```ts
            for (const c of ev.message.content) {
              if (c?.type === 'tool_use' && typeof c.name === 'string') {
                sawToolUse = true;
                if (opts.onProgress) {
                  try { opts.onProgress({ kind: 'tool_use', name: c.name }); } catch { /* user callback safety */ }
                }
              }
            }
```

(f) Все семь `reject(new Error(X))` внутри промиса заменить на `fail(X)` — сообщения те же, символ в символ:
- таймаут: `fail(\`claude CLI timeout after ${timeoutMs}ms\`);`
- stream, код ≠ 0: `fail(\`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}\`);`
- stream, is_error: `fail(\`claude CLI error: ${streamErrorDetail}\`);`
- json, код ≠ 0: `fail(\`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}\`);`
- json, is_error: `fail(\`claude CLI error: ${json.result ?? 'unknown'}\`);`
- кривой JSON: `fail(\`claude CLI returned invalid JSON: ${e.message}\`);`
- spawn error: `fail(\`claude CLI spawn error: ${err.message}\`);`

Проверка: `grep -n "new Error(" src/common/services/claude-cli.service.ts` — должно остаться только одно место: `throw new Error(\`${head} | qwen fallback: …\`)` в `runOnQwen`.

(g) Оба вызова `this.trackCallEvent({ … ok: true, })` — добавить `provider,` после `ok: true,`. И оба отладочных лога стоимости:

```ts
            this.logger.debug(`claude CLI cost${qwen ? ' (qwen)' : ''}: $${streamCostUsd.toFixed(4)}, ${streamDurationMs}ms (stream)`);
```
```ts
            this.logger.debug(`claude CLI cost${qwen ? ' (qwen)' : ''}: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);
```

- [ ] **Step 11: Commit, push, прогнать новые и прежние спеки CLI**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/common/services/claude-cli.service.ts
git commit -m "feat: ClaudeCliService — запасной путь на Qwen при сбое входа/лимита Claude

Тот же бинарь claude, модель и окружение Alibaba (ANTHROPIC_AUTH_TOKEN,
MAX_RETRIES=1). Не переключается: timeout/other, после вызова инструмента,
MCP без stream-json, noFallback. Предохранитель 5 мин, fallbackStats(),
provider/fallback в событии claude_cli_call.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest src/common/services 2>&1 | tail -8 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```

Expected: все спеки `src/common/services` PASS (включая `claude-cli.argv` и `claude-cli.mcp-sweep`), `TSC_OK`.

---

### Task 4: проверки живости — `noFallback`; строка в алерте

**Files:**
- Modify: `src/monitoring/claude-health.service.ts` (проба ~строка 160 после Task 1; алерт ~строка 350)
- Modify: `src/chat/chat.service.ts:1231`
- Test: `src/monitoring/claude-health.alert-line.spec.ts`

- [ ] **Step 1: Падающий тест `src/monitoring/claude-health.alert-line.spec.ts`**

```ts
import { qwenFallbackAlertLine } from './claude-health.service';

describe('qwenFallbackAlertLine — строка про запасной Qwen в алерте «Claude CLI недоступен»', () => {
  it('ключа нет', () => {
    expect(qwenFallbackAlertLine({ enabled: false, ok: 0, failed: 0 })).toBe('Запасной Qwen: не настроен');
  });

  it('ключ есть — исходы за 15 минут', () => {
    expect(qwenFallbackAlertLine({ enabled: true, ok: 12, failed: 1 })).toBe('Запасной Qwen: ответов 12, ошибок 1 за 15 мин');
  });
});
```

- [ ] **Step 2: Commit, push, убедиться, что падает**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/monitoring/claude-health.alert-line.spec.ts
git commit -m "test: строка запасного Qwen в алерте CLI (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest src/monitoring/claude-health.alert-line 2>&1 | tail -8"
```

Expected: FAIL — `qwenFallbackAlertLine` не экспортирован.

- [ ] **Step 3: `qwenFallbackAlertLine` в `claude-health.service.ts` — сразу под реэкспортом из Task 1**

```ts
/** Строка про запасной Qwen в алерте «Локальный Claude CLI недоступен»: видно,
 *  обслуживаются ли люди, пока вход не починен. Без склонений — счётчики
 *  после двоеточия. */
export function qwenFallbackAlertLine(s: { enabled: boolean; ok: number; failed: number }): string {
  if (!s.enabled) return 'Запасной Qwen: не настроен';
  return `Запасной Qwen: ответов ${s.ok}, ошибок ${s.failed} за 15 мин`;
}
```

- [ ] **Step 4: Строка в алерте**

В тексте алерта `🔴 Локальный Claude CLI недоступен` после строки

```ts
          `Провалов подряд: ${this.cliConsecutiveDown}. Проверка: ${this.cache.llmCheckedAt || '—'}\n` +
```

вставить:

```ts
          `${qwenFallbackAlertLine(this.claudeCli.fallbackStats())}\n` +
```

- [ ] **Step 5: `noFallback` у пробы живости**

В `probeLiveness` вызов

```ts
      const text = await this.claudeCli.text('Reply with exactly: ok', {
        model: 'claude-haiku-4-5',
        timeoutMs: 30_000,
      });
```

заменить на

```ts
      const text = await this.claudeCli.text('Reply with exactly: ok', {
        model: 'claude-haiku-4-5',
        timeoutMs: 30_000,
        // Проба меряет сам Claude: с запасным путём она была бы «зелёной», пока
        // Claude лежит, и никто не узнал бы, что пора перелогиниться.
        noFallback: true,
      });
```

- [ ] **Step 6: `noFallback` у синтетического пинга Маши — `src/chat/chat.service.ts`**

Строку

```ts
          model: probe ? PROBE_MODEL : CHAT_MODEL,
```

(та, за которой идёт комментарий `// Бюджет хода — общий с релеем.`; вторая похожая строка — `fd.append('model', …)` — не та) дополнить следующей строкой:

```ts
          model: probe ? PROBE_MODEL : CHAT_MODEL,
          // Пинг мониторинга меряет путь Claude — без запасного Qwen.
          noFallback: probe,
```

- [ ] **Step 7: Commit, push, прогнать мониторинг, чат, CLI, tsc**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add src/monitoring/claude-health.service.ts src/chat/chat.service.ts
git commit -m "feat: проверки живости Claude — без запасного Qwen; строка Qwen в алерте CLI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx jest src/common src/monitoring src/insights src/chat src/tg-bot 2>&1 | tail -6; npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```

Expected: PASS (красное только из базы Task 0, если было), `TSC_OK`.

---

### Task 5: живая проверка без выката (нода, настоящий claude + Alibaba)

**Files:**
- Create: `scripts/qwen-fallback-check.js`

Claude «ломается» пустым `CLAUDE_CONFIG_DIR`: CLI не находит вход → `Not logged in · Please run /login` → вид `auth` → запасной путь. Боевые креды ноды не трогаются.

- [ ] **Step 1: Написать `scripts/qwen-fallback-check.js`**

```js
#!/usr/bin/env node
// Живая проверка запасного пути ClaudeCliService на Qwen: настоящий claude,
// настоящий Alibaba, без выката. Запуск — из корня собранного клона (npm run build):
//   read -r QWEN_FALLBACK_API_KEY; export QWEN_FALLBACK_API_KEY; node scripts/qwen-fallback-check.js
// Ключ — только из env, скрипт его не печатает. Claude «ломается» пустым
// CLAUDE_CONFIG_DIR (вход не найден → auth → Qwen); боевые креды не трогаются.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.QWEN_FALLBACK_API_KEY) {
  console.error('нет QWEN_FALLBACK_API_KEY');
  process.exit(2);
}
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-check-cfg-'));
process.env.CLAUDE_CONFIG_DIR = cfgDir;

const distCandidates = [
  path.join(__dirname, '..', 'dist', 'common', 'services', 'claude-cli.service.js'),
  path.join(__dirname, '..', 'dist', 'src', 'common', 'services', 'claude-cli.service.js'),
];
const distPath = distCandidates.find((p) => fs.existsSync(p));
if (!distPath) {
  console.error('нет собранного сервиса — сначала npm run build');
  process.exit(2);
}
const { ClaudeCliService } = require(distPath);

async function main() {
  const svc = new ClaudeCliService();
  const results = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e && e.message || e).slice(0, 300) });
    }
  };

  await check('json, haiku-класс → Qwen', async () => {
    const r = await svc.textWithCost('Ответь одним словом: ок', { model: 'claude-haiku-4-5', timeoutMs: 120000 });
    return `«${r.text}», $${r.costUsd}`;
  });

  await check('stream-json + Read в своём cwd → Qwen, onProgress видит Read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-check-cwd-'));
    fs.writeFileSync(path.join(dir, 'note.txt'), 'Кодовое слово: черёмуха-47\n');
    const tools = [];
    const r = await svc.textWithCost('Прочитай файл note.txt инструментом Read и назови кодовое слово. Ответь только словом.', {
      model: 'claude-opus-5-5', cwd: dir, tools: 'Read', timeoutMs: 180000,
      onProgress: (e) => tools.push(e.name),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    if (!/черёмуха-47/.test(r.text)) throw new Error(`не то слово: ${r.text}`);
    return `«${r.text}», инструменты: ${tools.join(',') || '—'}`;
  });

  await check('WebFetch (как у TG-бота) → Qwen', async () => {
    const r = await svc.textWithCost('Открой https://example.com инструментом WebFetch и назови заголовок страницы. Только заголовок.', {
      model: 'claude-opus-5-5', tools: 'WebFetch', allowedTools: 'WebFetch', timeoutMs: 180000,
      onProgress: () => {},
    });
    return `«${r.text.slice(0, 80)}»`;
  });

  await check('WebSearch (как у TG-бота) → Qwen', async () => {
    const r = await svc.textWithCost('Найди инструментом WebSearch, в каком году основан Alibaba Group. Ответь годом.', {
      model: 'claude-opus-5-5', tools: 'WebSearch', allowedTools: 'WebSearch', timeoutMs: 180000,
      onProgress: () => {},
    });
    return `«${r.text.slice(0, 80)}»`;
  });

  await check('noFallback (проба живости) обязана упасть на Claude', async () => {
    try {
      await svc.text('Reply with exactly: ok', { model: 'claude-haiku-4-5', timeoutMs: 60000, noFallback: true });
    } catch (e) {
      return `упала, как и должна: ${String(e.message).slice(0, 100)}`;
    }
    throw new Error('проба прошла — значит, пошла мимо Claude');
  });

  fs.rmSync(cfgDir, { recursive: true, force: true });
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} (${r.ms} мс): ${r.detail}`);
  console.log('fallbackStats:', JSON.stringify(svc.fallbackStats()));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main();
```

- [ ] **Step 2: Commit, push, собрать на ноде**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git add scripts/qwen-fallback-check.js
git commit -m "scripts: живая проверка запасного пути на Qwen (настоящий claude + Alibaba, без выката)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
SHA=$(git rev-parse HEAD); ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npm run build 2>&1 | tail -3 && ls dist | head"
```

Expected: сборка без ошибок, в `dist` есть `common/` (или `src/common/`).

- [ ] **Step 3: Прогнать с ключом (ключ — через stdin, не в argv и не на диск)**

```bash
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.qwen/settings.json")))["security"]["auth"]["apiKey"])' \
 | ssh dv@85.192.61.231 'cd ~/ci/wt/qwen-fallback && source ~/.nvm/nvm.sh && read -r QWEN_FALLBACK_API_KEY && export QWEN_FALLBACK_API_KEY && node scripts/qwen-fallback-check.js'
```

Expected: `OK` у json, stream+Read, WebFetch и noFallback; `fallbackStats` с `ok ≥ 3`.

- [ ] **Step 4: Разбор WebSearch / WebFetch**

Если `WebSearch` = FAIL (серверный инструмент Anthropic, Alibaba может его не знать), а остальное OK — сообщить владельцу и предложить отдельной задачей снимать `WebSearch` из `--tools`/`--allowedTools` на запасном запуске. В этот план правку не добавлять без его слова. Если `WebFetch` = FAIL — то же. Если упал json или stream+Read — стоп, разбирать (это ядро пути).

---

### Task 6: ревью и слияние

- [ ] **Step 1: Ревью кода** — `superpowers:requesting-code-review` по диффу `origin/main...feat/qwen-fallback`.

- [ ] **Step 2: Полный гейт на ноде на финальном sha**

```bash
SHA=$(git -C ~/Downloads/spirits_back/.worktrees/qwen-fallback rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/qwen-fallback && git fetch -q origin && git checkout -q --detach $SHA && source ~/.nvm/nvm.sh && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK; npx jest 2>&1 | tail -6"
```

Expected: `TSC_OK`; полный jest — не хуже базы `origin/main` (сравнивать дельтой: красное by design есть и на main).

- [ ] **Step 3: Влить в `origin/main` из воркдерева (общий чекаут не трогать)**

```bash
cd ~/Downloads/spirits_back/.worktrees/qwen-fallback
git fetch -q origin
git checkout -q --detach origin/main
git merge --no-ff feat/qwen-fallback -m "Merge feat/qwen-fallback: запасной путь ClaudeCliService на Qwen при сбое входа/лимита Claude

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push origin HEAD:refs/heads/main
git fetch -q origin && git merge-base --is-ancestor feat/qwen-fallback origin/main && echo MERGED
```

Expected: `MERGED`.

---

### Task 7: ключ в `.env` и выкат — ТОЛЬКО С OK ВЛАДЕЛЬЦА

Правка конфигурации серверов и выкат — внешние действия: перед каждым шагом спросить владельца.

- [ ] **Step 1: Ключ в `.env` test и прода (с OK)**

Ключ — через stdin; строка дописывается, только если её ещё нет; перед правкой — копия `.env` с правами 600.

```bash
add_key() {  # $1 = ssh-цель, $2 = путь к .env
  python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.qwen/settings.json")))["security"]["auth"]["apiKey"])' \
  | ssh "$1" "f=$2; if grep -q '^QWEN_FALLBACK_API_KEY=' \$f; then echo 'уже есть'; else install -m 600 \$f \$f.bak-qwen-20261029 && read -r K && { [ -n \"\$(tail -c1 \$f)\" ] && echo >> \$f; printf 'QWEN_FALLBACK_API_KEY=%s\n' \"\$K\" >> \$f; echo добавлен; }; fi; grep -c '^QWEN_FALLBACK_API_KEY=' \$f"
}
add_key dv@85.192.61.231 /home/dv/spirits_back/.env
add_key dvolkov@212.113.106.202 /home/dvolkov/spirits_back/.env
```

Expected: `добавлен` (или `уже есть`) и `1` на каждом. Ключ не печатается. Подхватится рестартом pm2 в `deploy.sh`.

- [ ] **Step 2: Выкат `deploy.sh` (с OK) — с ноды, из свежих клонов main**

Порядок и ловушки — память «Выкат: правила» и «deploy.sh: ловушки». Кратко:

```bash
ssh dv@85.192.61.231 'pgrep -f "^bash scripts/deploy.sh" && echo "ИДЁТ ЧУЖОЙ ВЫКАТ — ждать" || echo свободно'
ssh dv@85.192.61.231 'set -e; D=~/deploy-clones/qwen-1029; rm -rf $D; mkdir -p $D ~/deploy-logs; cd $D
  git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git spirits_back
  git clone -q --branch main git@github.com:dvvolkovv/spirits.git spirits_front
  install -m 600 ~/dev/spirits_back/scripts/test-server.env.local spirits_back/scripts/
  ln -s ~/dev/spirits_back/tests/node_modules spirits_back/tests/node_modules
  git -C spirits_back log -1 --oneline'
ssh dv@85.192.61.231 'cd ~/deploy-clones/qwen-1029/spirits_back && source ~/.nvm/nvm.sh && SKIP_BOTS=1 SKIP_PRODUCTS_HOST=1 LOCAL_BACK_DIR=$PWD LOCAL_FRONT_DIR=$PWD/../spirits_front setsid -f bash -c "echo \$\$ > ~/deploy-logs/qwen-1029.pid; exec bash scripts/deploy.sh" > ~/deploy-logs/qwen-1029.log 2>&1 < /dev/null'
```

Ждать отвязанно (`Monitor` по `kill -0 $(cat ~/deploy-logs/qwen-1029.pid)`), без `tail` в фоне. `SKIP_BOTS=1 SKIP_PRODUCTS_HOST=1` — как на прошлых выкатах (у ноды нет ключа к машине ботов). Перед этим `git log -1` клона сверить с sha слияния.

- [ ] **Step 3: Проверка после выката**

1. В логе выката обе фазы зелёные, отката нет.
2. Прод: `/usr/bin/claude` жив → путь Claude, в логе нет `запасной Qwen`:
   `ssh dvolkov@212.113.106.202 'grep -c "запасной Qwen" ~/.pm2/logs/linkeon-api-out-0.log'` — число не растёт.
3. Test (CLI мёртв с июля): спросить Машу через API test тестовым аккаунтом (OTP — debug-ручка с секретом test) и убедиться, что она ответила, а в логе test — `claude CLI → запасной Qwen (auth)`; в `events` — `provider: 'qwen'`:
   `ssh dv@85.192.61.231 'grep "запасной Qwen" ~/.pm2/logs/linkeon-api-out*.log | tail -3'`.
4. Проба живости на test по-прежнему `DOWN (auth)` — `noFallback` работает.

- [ ] **Step 4: Память и бэклог**

Обновить `project_qwen_fallback_for_claude.md` (что на проде, sha, как проверять), снять воркдерево `~/ci/wt/qwen-fallback` (`git -C ~/ci/spirits_back worktree remove ~/ci/wt/qwen-fallback`) и локальное (`git -C ~/Downloads/spirits_back worktree remove .worktrees/qwen-fallback`) после слияния.
