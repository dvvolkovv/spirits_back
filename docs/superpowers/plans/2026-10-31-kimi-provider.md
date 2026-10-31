# Kimi — третий провайдер ответов: выбор в карточке и второе звено запасного пути — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** админ выбирает для аккаунта Claude, Qwen или Kimi; при сбое доступа к Claude ответ даёт цепочка Qwen → Kimi — в `ClaudeCliService` бэкенда и на релее r.linkeon.io.

**Architecture:** код Qwen обобщается до реестра запасных провайдеров — `src/common/services/llm-fallback.ts` (бэкенд) и `relay-agent/llm-fallback.mjs` (релей): конфиги из env/файлов, модели, окружение процесса, окна (окно Claude и «не отвечает» у каждого запасного) и чистая функция плана попыток. `ClaudeCliService.runRaw` и врезка релея проходят план по одним правилам. Выбор хранится в прежней колонке `llm_provider` (`'kimi'` — новое значение); админ-ручка и блок в карточке получают третий вариант; мониторинг читает счётчики по каждому запасному.

**Tech Stack:** NestJS 10 + jest/ts-jest (бэк), Node 22 ESM + `node:test` (релей), React 18 + vitest (фронт), Claude Code CLI 2.1.280 (прод, релей) / 2.1.312 (нода).

**Spec:** `docs/superpowers/specs/2026-10-31-kimi-provider-design.md` — читать первым. Предыдущие: `2026-10-29-qwen-fallback-design.md`, `2026-10-30-llm-provider-switch-design.md` (там же — как устроены запасной Qwen и врезка релея).

---

## Где что делается (обязательно)

- **spirits_back:** воркдерево `~/Downloads/spirits_back/.worktrees/kimi-provider`, ветка `feat/kimi-provider` (spec уже там). Общий чекаут `~/Downloads/spirits_back` (main) не трогать.
- **spirits_front:** воркдерево `~/Downloads/spirits_front/.worktrees/kimi-provider`, ветка `feat/kimi-provider` (создаётся в Task 0). Общий чекаут не трогать.
- **Тесты, tsc, сборки — только на ноде** `dv@85.192.61.231`, в своих воркдеревьях `~/ci/wt/kimi-back` и `~/ci/wt/kimi-front` (Task 0). Мак не тянет, а jest бэка к тому же игнорирует `/.worktrees/`. В каждой ssh-команде — `source ~/.nvm/nvm.sh`. Порядок: коммит → `git push` ветки → на ноде `git fetch -q origin && git checkout -q --detach <sha>` → прогон.
- **На ноде не трогать** `~/spirits_back`, `~/spirits_front` (живой test-стенд), `~/dev`, сами `~/ci/spirits_back` и `~/ci/spirits_front` (только `git -C … fetch` и `worktree add/remove`).
- **Живой релей** `dv@5.101.115.184:~/file-agent` (git без remote, HEAD `e5c2737`) — до Task 13 только читать. На релее нет nvm: `node`/`pm2` системные.
- Пушить только ветки `feat/kimi-provider` (и временную `tmp/kimi-squash` в Task 12). В main — только в Task 12.
- ssh рвётся («Connection closed») — подождать 20–30 с и повторить (лимит подключений ноды).
- **Ключи:** Kimi — `~/.linkeon/kimi.key` на маке; Qwen — `~/.qwen/settings.json` (`security.auth.apiKey`). Только через stdin; никогда не печатать, не класть в argv, файлы репозиториев и отчёты.
- **Репозитории публичные:** в коде и тестах — ни телефонов, ни ключей. Идентификаторы пользователей в новых тестах — вида `u-1`.
- Комментарии в коде — по-русски. Подпись коммитов: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (или своя модель — по системной инструкции агента).
- **zsh на маке:** `$VAR:r`, `$t:s…` — модификаторы (писать `${VAR}:…`); `=` в начале слова — раскрытие (`echo '===='` в кавычках); `--include=*.ts` — в кавычках; `for f in $list` строку на слова не делит. Сложное — через `bash -s <<'EOF'`.

Шаблон прогона бэка на ноде (дальше — «прогон бэка: <файлы>»):

```bash
cd ~/Downloads/spirits_back/.worktrees/kimi-provider && git push -q && SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/kimi-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest <файлы> 2>&1 | tail -20"
```

- «tsc бэка» — тот же ssh, команда `npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK`.
- «прогон релея» — тот же ssh, команда `cd relay-agent && node --test --test-reporter=tap *.test.mjs 2>&1 | grep -aE '^# (pass|fail)'`.
- «прогон фронта: <файлы>»:

```bash
cd ~/Downloads/spirits_front/.worktrees/kimi-provider && git push -q && FSHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/kimi-front && git fetch -q origin && git checkout -q --detach ${FSHA} && source ~/.nvm/nvm.sh && ./node_modules/.bin/vitest run <файлы> 2>&1 | tail -20"
```

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| Create `src/common/services/llm-fallback.ts` (+ `llm-fallback.spec.ts`) | реестр запасных: конфиги, модели, окружение, «переключаться ли», окна (`FallbackState`), план попыток |
| Delete `src/common/services/qwen-fallback.ts` (+ `.spec.ts`) | заменён `llm-fallback.ts` (Task 4) |
| Modify `src/common/services/claude-cli.service.ts` | план попыток в `runRaw`, `provider: 'qwen' \| 'kimi'`, MCP → stream-json, `selected` в событии, `fallbackStats().providers` |
| Create `src/common/services/claude-cli.chain.spec.ts` | цепочка Claude → Qwen → Kimi, выбор Kimi, MCP в stream-json |
| Modify `src/common/services/claude-cli.{fallback,forced-qwen,argv,text-delta}.spec.ts` | новые переменные окружения и поменявшееся поведение |
| Modify `src/common/services/user-llm-provider.service.ts` (+ spec) | значение `'kimi'` |
| Modify `src/admin/admin-llm-provider.controller.ts` (+ spec) | `kimi`, `configured: { qwen, kimi }` |
| Modify `src/chat/answer-provider.ts` (+ spec) | `kimi` к релею и из `done`, `cliProviderOption` |
| Modify `src/chat/chat.service.ts`, `src/chat/chat.controller.ts`, `src/tg-bot/tg-router.service.ts` (+ их llm-provider-спеки) | выбор Kimi у Маши, релея, TG; `selected` в `chat_quality` |
| Modify `src/monitoring/claude-health.service.ts` (+ `claude-health.alert-line.spec.ts`) | строка алерта по каждому запасному |
| Modify `src/monitoring/relay-qwen-monitor.service.ts` (+ spec) | `/health.fallback` релея, прежнее `qwen` — как запасной вариант; тексты |
| Create `scripts/llm-fallback-check.js`, Delete `scripts/qwen-fallback-check.js` | живая проверка на Linux |
| Create `relay-agent/llm-fallback.mjs` (+ `llm-fallback.test.mjs`) | релей: то же, что `llm-fallback.ts` |
| Create `relay-agent/llm-fallback-patch.py` | врезка поверх врезки Qwen — одна для копии в main и живого релея |
| Modify `relay-agent/server.mjs`; Delete `relay-agent/qwen-provider.mjs` (+ test) | результат врезки |
| Front: Modify `src/components/admin/UserLlmProviderControl.tsx` (+ `.test.tsx`) | три варианта, пометки «нет ключа» |
| Front: Modify `src/i18n/locales/{ru,en,pt}.json` | строки блока |

---

### Task 0: воркдеревья на ноде и фронта, база

- [ ] **Step 1: Место на ноде и ветка бэка на GitHub**

```bash
ssh dv@85.192.61.231 'df -h ~ | tail -1'
```

Expected: занято меньше 85 %. Больше — стоп и доклад (память «Диск тест-ноды»).

```bash
git -C ~/Downloads/spirits_back/.worktrees/kimi-provider push -q -u origin feat/kimi-provider
SHA=$(git -C ~/Downloads/spirits_back/.worktrees/kimi-provider rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/kimi-back ${SHA} && cd ~/ci/wt/kimi-back && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund 2>&1 | tail -1"
```

Expected: `added N packages`.

- [ ] **Step 2: Воркдерево фронта на маке и на ноде**

```bash
cd ~/Downloads/spirits_front && git fetch -q origin && git worktree add -q -b feat/kimi-provider .worktrees/kimi-provider origin/main
git -C .worktrees/kimi-provider push -q -u origin feat/kimi-provider
FSHA=$(git -C .worktrees/kimi-provider rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/kimi-front ${FSHA} && cd ~/ci/wt/kimi-front && source ~/.nvm/nvm.sh && pnpm install --frozen-lockfile 2>&1 | tail -2"
```

- [ ] **Step 3: База (до правок)**

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/kimi-back && source ~/.nvm/nvm.sh && npx jest src/common src/admin src/chat src/tg-bot src/monitoring src/guest-trial --silent 2>&1 | grep -aE "^(Tests:|Test Suites:)"; npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK; cd relay-agent && node --test --test-reporter=tap *.test.mjs 2>&1 | grep -aE "^# (pass|fail)"'
ssh dv@85.192.61.231 'cd ~/ci/wt/kimi-front && source ~/.nvm/nvm.sh && ./node_modules/.bin/vitest run src/components/admin 2>&1 | grep -aE "Test Files|Tests "; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c "error TS"'
```

Записать числа в отчёт: дальше мерить дельтой (у фронта tsc на main не нулевой — память: база около 45 ошибок).

---

### Task 1: `llm-fallback.ts` — реестр, конфиги, модели, окружение

**Files:**
- Create: `src/common/services/llm-fallback.ts`
- Test: `src/common/services/llm-fallback.spec.ts`

`qwen-fallback.ts` пока остаётся (его ещё читают `claude-cli.service.ts` и админ-ручка) — удаляется в Task 4.

- [ ] **Step 1: Падающий тест** — `src/common/services/llm-fallback.spec.ts`:

```ts
import {
  DEFAULT_BREAKER_MS,
  FALLBACK_ORDER,
  PROVIDER_DEFAULTS,
  fallbackModelFor,
  fallbackSpawnEnv,
  fallbackTimeoutMs,
  isAnswerProvider,
  isFallbackWorthy,
  readBreakerMs,
  readFallbackConfig,
  readFallbackConfigs,
} from './llm-fallback';

const QWEN_MODELS = { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash' };
const KIMI_MODELS = { opus: 'k3.1-pro', sonnet: 'k3.1-pro', haiku: 'k3.1-pro' };

describe('readFallbackConfig', () => {
  it('без ключа — null (провайдер выключен)', () => {
    expect(readFallbackConfig('qwen', {})).toBeNull();
    expect(readFallbackConfig('kimi', { KIMI_FALLBACK_API_KEY: '   ' })).toBeNull();
  });

  it('Qwen с ключом — значения по умолчанию, ключ без пробелов', () => {
    expect(readFallbackConfig('qwen', { QWEN_FALLBACK_API_KEY: ' sk-sp-x ' })).toEqual({
      name: 'qwen', apiKey: 'sk-sp-x', baseUrl: PROVIDER_DEFAULTS.qwen.baseUrl, models: QWEN_MODELS,
    });
  });

  it('Kimi с ключом — адрес Kimi Code и k3.1-pro для всех классов', () => {
    expect(readFallbackConfig('kimi', { KIMI_FALLBACK_API_KEY: 'sk-kimi-x' })).toEqual({
      name: 'kimi', apiKey: 'sk-kimi-x', baseUrl: 'https://api.kimi.ai/coding', models: KIMI_MODELS,
    });
  });

  it('переопределения из env — у каждого провайдера свои', () => {
    const env = {
      QWEN_FALLBACK_API_KEY: 'q',
      KIMI_FALLBACK_API_KEY: 'k',
      KIMI_FALLBACK_BASE_URL: 'https://x.example/coding',
      KIMI_FALLBACK_MODEL_OPUS: 'k3',
      KIMI_FALLBACK_MODEL_SONNET: 'k3-256k',
      KIMI_FALLBACK_MODEL_HAIKU: 'k3.1-pro-highspeed',
    };
    expect(readFallbackConfig('kimi', env)).toEqual({
      name: 'kimi', apiKey: 'k', baseUrl: 'https://x.example/coding',
      models: { opus: 'k3', sonnet: 'k3-256k', haiku: 'k3.1-pro-highspeed' },
    });
    // Переменные Kimi Qwen не задевают.
    expect(readFallbackConfig('qwen', env)!.models).toEqual(QWEN_MODELS);
  });

  it('readFallbackConfigs — по всем запасным, порядок цепочки Qwen → Kimi', () => {
    expect(FALLBACK_ORDER).toEqual(['qwen', 'kimi']);
    const all = readFallbackConfigs({ KIMI_FALLBACK_API_KEY: 'k' });
    expect(all.qwen).toBeNull();
    expect(all.kimi?.name).toBe('kimi');
  });
});

describe('readBreakerMs', () => {
  it('по умолчанию — 5 минут', () => expect(readBreakerMs({})).toBe(DEFAULT_BREAKER_MS));
  it('новое имя', () => expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '60000' })).toBe(60000));
  it('прежнее имя — если нового нет', () => expect(readBreakerMs({ QWEN_FALLBACK_BREAKER_MS: '30000' })).toBe(30000));
  it('новое побеждает прежнее', () => {
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '1000', QWEN_FALLBACK_BREAKER_MS: '2000' })).toBe(1000);
  });
  it('кривое — по умолчанию; 0 — допустимо', () => {
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: 'abc' })).toBe(DEFAULT_BREAKER_MS);
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '-5' })).toBe(DEFAULT_BREAKER_MS);
    expect(readBreakerMs({ LLM_FALLBACK_BREAKER_MS: '0' })).toBe(0);
  });
});

describe('fallbackModelFor', () => {
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
  ])('Qwen: %s → %s', (requested, expected) => {
    expect(fallbackModelFor(requested, QWEN_MODELS)).toBe(expected);
  });

  it('Kimi: любой класс — k3.1-pro', () => {
    for (const m of ['claude-opus-5-5', 'sonnet', 'claude-haiku-4-5', 'default']) {
      expect(fallbackModelFor(m, KIMI_MODELS)).toBe('k3.1-pro');
    }
  });
});

describe('isFallbackWorthy', () => {
  it.each([
    'claude CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    'claude CLI exited with code 1: Not logged in · Please run /login',
    "claude CLI error: You've hit your weekly limit · resets Nov 3",
    'claude CLI error: API Error: 429 rate limit',
    'claude CLI error: API Error: 529 Overloaded',
    'claude CLI exited with code 1: Failed to authenticate. API Error: 401 Invalid Authentication',
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

  it.each([
    'claude CLI error: Context limit reached · /compact or /clear to continue',
    'claude CLI error: Prompt is too long: 250000 tokens',
    'claude CLI error: max_tokens exceeded',
    'claude CLI error: response exceeded the 32000 output token maximum',
  ])('длина контекста — не переключаемся: %s', (msg) => {
    expect(isFallbackWorthy(msg)).toBe(false);
  });
});

describe('fallbackSpawnEnv', () => {
  const kimi = readFallbackConfig('kimi', { KIMI_FALLBACK_API_KEY: 'sk-kimi-x' })!;
  const qwen = readFallbackConfig('qwen', { QWEN_FALLBACK_API_KEY: 'sk-sp-x' })!;

  it('снимает чужие ANTHROPIC_* и OAuth-токен, ставит адрес, ключ и модели провайдера, один повтор', () => {
    const env = fallbackSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'old',
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    }, kimi);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding',
      ANTHROPIC_AUTH_TOKEN: 'sk-kimi-x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3.1-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'k3.1-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'k3.1-pro',
      CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro',
      CLAUDE_CODE_MAX_RETRIES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('у Qwen — его адрес и модели', () => {
    const env = fallbackSpawnEnv({}, qwen);
    expect(env.ANTHROPIC_BASE_URL).toBe(PROVIDER_DEFAULTS.qwen.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-x');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3.6-flash');
  });

  it('таймаут одного запроса к API — 300 с, в том числе поверх своего в base', () => {
    expect(fallbackSpawnEnv({}, kimi).API_TIMEOUT_MS).toBe('300000');
    expect(fallbackSpawnEnv({ API_TIMEOUT_MS: '3000000' }, kimi).API_TIMEOUT_MS).toBe('300000');
  });

  it('не меняет переданный объект', () => {
    const base = { ANTHROPIC_API_KEY: 'old' };
    fallbackSpawnEnv(base, kimi);
    expect(base).toEqual({ ANTHROPIC_API_KEY: 'old' });
  });

  // SCRUB=1 на Linux требует bubblewrap: без него CLI падает сразу (30.10 —
  // прод и релей без bwrap). Явный '0' — поверх унаследованного '1'.
  it('вычистка окружения подпроцессов выключена явно', () => {
    expect(fallbackSpawnEnv({}, kimi).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(fallbackSpawnEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, kimi).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
  });
});

describe('fallbackTimeoutMs', () => {
  it('остаток бюджета после упавших попыток, если он больше минуты', () => {
    expect(fallbackTimeoutMs(100_000, 30_000)).toBe(70_000);
  });
  it('не меньше минуты — даже когда прежние попытки съели весь бюджет', () => {
    expect(fallbackTimeoutMs(100_000, 99_000)).toBe(60_000);
    expect(fallbackTimeoutMs(100_000, 150_000)).toBe(60_000);
  });
  it('бюджет меньше минуты — весь бюджет', () => {
    expect(fallbackTimeoutMs(30_000, 29_000)).toBe(30_000);
  });
  it('0 — без таймаута, и у следующей попытки тоже', () => {
    expect(fallbackTimeoutMs(0, 12_345)).toBe(0);
  });
});

describe('isAnswerProvider', () => {
  it.each(['claude', 'qwen', 'kimi'])('%s — да', (v) => expect(isAnswerProvider(v)).toBe(true));
  it.each(['gpt', '', 'Qwen', null, undefined, 1])('%p — нет', (v) => expect(isAnswerProvider(v)).toBe(false));
});
```

- [ ] **Step 2: Прогон — падает** — «прогон бэка: src/common/services/llm-fallback.spec.ts». Expected: FAIL, `Cannot find module './llm-fallback'`.

- [ ] **Step 3: Реализация** — `src/common/services/llm-fallback.ts`:

```ts
import { classifyLlmError, LlmOutageKind } from '../llm-error';

/**
 * Запасные провайдеры ClaudeCliService — Qwen и Kimi. Тот же бинарь claude и
 * те же флаги — меняются модель и окружение процесса (адрес и ключ
 * провайдера). Спецификации: docs/superpowers/specs/2026-10-29-qwen-fallback-design.md,
 * 2026-10-31-kimi-provider-design.md. Те же правила — в relay-agent/llm-fallback.mjs:
 * меняешь здесь — сверь там.
 *
 * Здесь — чистые функции (конфиг из env, модели, окружение, «переключаться
 * ли»), окна (FallbackState) и план попыток. Запуск CLI — в ClaudeCliService.
 */

export type FallbackProvider = 'qwen' | 'kimi';
export type AnswerProvider = 'claude' | FallbackProvider;

/** Порядок аварийной цепочки после Claude. */
export const FALLBACK_ORDER: readonly FallbackProvider[] = ['qwen', 'kimi'];
export const ANSWER_PROVIDERS: readonly AnswerProvider[] = ['claude', ...FALLBACK_ORDER];
export const PROVIDER_LABELS: Readonly<Record<AnswerProvider, string>> = { claude: 'Claude', qwen: 'Qwen', kimi: 'Kimi' };

export interface FallbackModels {
  opus: string;
  sonnet: string;
  haiku: string;
}

export interface FallbackConfig {
  name: FallbackProvider;
  apiKey: string;
  baseUrl: string;
  models: FallbackModels;
}

export type FallbackConfigs = Record<FallbackProvider, FallbackConfig | null>;

interface ProviderDefaults {
  /** Префикс переменных: <PREFIX>_FALLBACK_API_KEY, _BASE_URL, _MODEL_OPUS|SONNET|HAIKU. */
  envPrefix: string;
  baseUrl: string;
  models: FallbackModels;
}

export const PROVIDER_DEFAULTS: Readonly<Record<FallbackProvider, ProviderDefaults>> = {
  // Token Plan (личный и Team) — из инструкции Alibaba для Claude Code.
  qwen: {
    envPrefix: 'QWEN',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    models: { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash' },
  },
  // Kimi Code: Anthropic Messages на /coding/v1/messages. k3.1-pro для всех
  // классов — быстрее k3 (≈6 с против ≈17, проба 30.10).
  kimi: {
    envPrefix: 'KIMI',
    baseUrl: 'https://api.kimi.ai/coding',
    models: { opus: 'k3.1-pro', sonnet: 'k3.1-pro', haiku: 'k3.1-pro' },
  },
};

/** Ни одного запасного — для вызовов с noFallback. */
export const NO_FALLBACK_CONFIGS: Readonly<FallbackConfigs> = Object.freeze({ qwen: null, kimi: null });

/** Длина окон (окно Claude и «не отвечает»), мс. */
export const DEFAULT_BREAKER_MS = 5 * 60_000;
/** Нижняя граница таймаута следующей попытки: запасному нужно время ответить,
 *  даже когда прежние попытки съели почти весь бюджет. */
export const MIN_FALLBACK_TIMEOUT_MS = 60_000;

const trimmed = (v: string | undefined): string => (v ?? '').trim();

export function isAnswerProvider(v: unknown): v is AnswerProvider {
  return typeof v === 'string' && (ANSWER_PROVIDERS as readonly string[]).includes(v);
}

/** null — ключа нет, провайдер выключен (test, локально, тесты). */
export function readFallbackConfig(name: FallbackProvider, env: NodeJS.ProcessEnv = process.env): FallbackConfig | null {
  const d = PROVIDER_DEFAULTS[name];
  const p = d.envPrefix;
  const apiKey = trimmed(env[`${p}_FALLBACK_API_KEY`]);
  if (!apiKey) return null;
  return {
    name,
    apiKey,
    baseUrl: trimmed(env[`${p}_FALLBACK_BASE_URL`]) || d.baseUrl,
    models: {
      opus: trimmed(env[`${p}_FALLBACK_MODEL_OPUS`]) || d.models.opus,
      sonnet: trimmed(env[`${p}_FALLBACK_MODEL_SONNET`]) || d.models.sonnet,
      haiku: trimmed(env[`${p}_FALLBACK_MODEL_HAIKU`]) || d.models.haiku,
    },
  };
}

export function readFallbackConfigs(env: NodeJS.ProcessEnv = process.env): FallbackConfigs {
  return { qwen: readFallbackConfig('qwen', env), kimi: readFallbackConfig('kimi', env) };
}

/** Длина окон: LLM_FALLBACK_BREAKER_MS; прежнее QWEN_FALLBACK_BREAKER_MS — если
 *  нового нет. Кривое значение — по умолчанию, 0 — допустимо (без окон). */
export function readBreakerMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = trimmed(env.LLM_FALLBACK_BREAKER_MS) || trimmed(env.QWEN_FALLBACK_BREAKER_MS);
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_BREAKER_MS;
}

/**
 * Что уходит в --model вместо модели Claude. Полный id Claude чужой провайдер
 * не знает, поэтому сопоставляем по классу. Всё незнакомое (default, opus, id
 * Opus) — главная модель: лучше переплатить, чем ответить слабее.
 */
export function fallbackModelFor(requested: string, models: FallbackModels): string {
  const m = requested.trim().toLowerCase();
  if (m === 'haiku' || m.startsWith('claude-haiku')) return models.haiku;
  if (m === 'sonnet' || m.startsWith('claude-sonnet')) return models.sonnet;
  return models.opus;
}

/**
 * Сбои доступа (вход, лимит, перегрузка) — переход к следующему провайдеру
 * имеет смысл. timeout и other — нет: повтор удвоил бы время хода или повторил
 * бы ошибку самого запроса.
 */
const FALLBACK_KINDS: ReadonlySet<LlmOutageKind> = new Set<LlmOutageKind>([
  'auth',
  'weekly_limit',
  'rate_limit',
  'overloaded',
]);

/** Ошибки длины контекста — свойство самого запроса, а не доступа: другой
 *  провайдер их не исправит, а «limit reached» / «try again» в них
 *  классификатор принял бы за лимит или перегрузку и открыл бы окно для всех. */
const CONTEXT_LENGTH_RE = /context (window|length|limit)|prompt is too long|output token|max_tokens/i;

export function isFallbackWorthy(errorMessage: string): boolean {
  if (CONTEXT_LENGTH_RE.test(errorMessage)) return false;
  return FALLBACK_KINDS.has(classifyLlmError(errorMessage).kind);
}

/**
 * Таймаут следующей попытки: остаток бюджета вызова после упавших (на 429/529
 * CLI сам повторяет запрос, и попытка бывает долгой — ход не должен
 * растягиваться вдвое), но не меньше минуты, а при бюджете меньше минуты —
 * весь бюджет. 0 (и меньше) — без таймаута, как в spawnClaude.
 */
export function fallbackTimeoutMs(timeoutMs: number, elapsedMs: number): number {
  if (!(timeoutMs > 0)) return 0;
  return Math.max(timeoutMs - elapsedMs, Math.min(timeoutMs, MIN_FALLBACK_TIMEOUT_MS));
}

/**
 * Окружение процесса запасного: копия base без ANTHROPIC_* и без
 * CLAUDE_CODE_OAUTH_TOKEN, плюс адрес и ключ провайдера.
 *
 * Ключ — в ANTHROPIC_AUTH_TOKEN, не в ANTHROPIC_API_KEY: при живом входе по
 * OAuth API_KEY в -p игнорируется, и CLI шлёт провайдеру OAuth-токен → 401
 * (проба 29.10, CLI 2.1.280). AUTH_TOKEN вход перебивает.
 *
 * CLAUDE_CODE_MAX_RETRIES=1: без него на 401 CLI делает 11 попыток с
 * нарастающей паузой — минуты висения вместо ~3 с.
 *
 * ANTHROPIC_DEFAULT_*_MODEL — для внутренних вызовов самого CLI (например,
 * WebFetch пересказывает страницу «быстрой» моделью): иначе он попросит у
 * провайдера claude-haiku и упадёт.
 */
export function fallbackSpawnEnv(base: NodeJS.ProcessEnv, cfg: FallbackConfig): NodeJS.ProcessEnv {
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
    // Таймаут одного запроса к API: без него ход без таймаута (TG, timeoutMs: 0)
    // на зависшем провайдере висел бы до 2×600 с.
    API_TIMEOUT_MS: '300000',
    // Вычистка ключа из окружения подпроцессов инструментов — ВЫКЛЮЧЕНА явно.
    // На Linux SCRUB=1 требует bubblewrap (bwrap); без него CLI 2.1.280 сразу
    // падает (exit 1, ни одного события) — так 30.10 на проде (bwrap нет)
    // перестал работать весь путь на Qwen. Здесь Bash нет ни у одного вызова
    // (Маша — только MCP, TG — Read/WebSearch/WebFetch), так что ключу через
    // env утекать некуда. '0' — поверх унаследованного значения.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
  };
}
```

- [ ] **Step 4: Прогон — зелёный** — «прогон бэка: src/common/services/llm-fallback.spec.ts». Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_back/.worktrees/kimi-provider
git add src/common/services/llm-fallback.ts src/common/services/llm-fallback.spec.ts
git commit -q -m "feat(llm-fallback): реестр запасных провайдеров — Qwen и Kimi: конфиги, модели, окружение

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `llm-fallback.ts` — окна (`FallbackState`) и план попыток

**Files:**
- Modify: `src/common/services/llm-fallback.ts` (дописать в конец)
- Test: `src/common/services/llm-fallback.spec.ts` (дописать)

- [ ] **Step 1: Падающий тест** — в начало спеки добавить к импорту `FallbackConfig`, `FallbackState`, `STATS_WINDOW_MS`, `planProviders`; в конец файла:

```ts
describe('FallbackState', () => {
  it('окно Claude: открытие, истечение, закрытие успехом, начатым после открытия', () => {
    const s = new FallbackState();
    expect(s.claudeWindowOpen(1000)).toBe(false);
    s.openClaudeWindow(60_000, 1000);
    expect(s.claudeWindowOpen(2000)).toBe(true);
    expect(s.claudeWindowUntil(2000)).toBe(61_000);
    s.claudeSucceeded(500); // начат до открытия — окно не закрывает
    expect(s.claudeWindowOpen(2000)).toBe(true);
    s.claudeSucceeded(1500); // начат после — закрывает
    expect(s.claudeWindowOpen(2000)).toBe(false);
    expect(s.claudeWindowUntil(2000)).toBe(0);
    s.openClaudeWindow(60_000, 3000);
    expect(s.claudeWindowUntil(70_000)).toBe(0); // истекло — 0, а не момент в прошлом
    s.openClaudeWindow(60_000, 80_000);
    s.closeClaudeWindow();
    expect(s.claudeWindowOpen(80_001)).toBe(false);
  });

  it('«не отвечает» — своё у каждого запасного', () => {
    const s = new FallbackState();
    s.markDown('qwen', 60_000, 1000);
    expect(s.isDown('qwen', 2000)).toBe(true);
    expect(s.isDown('kimi', 2000)).toBe(false);
    expect(s.downUntilOf('qwen', 2000)).toBe(61_000);
    expect(s.downUntilOf('qwen', 61_000)).toBe(0);
    s.markUp('qwen');
    expect(s.isDown('qwen', 2000)).toBe(false);
  });

  it('исходы — по провайдеру, за 15 минут', () => {
    const s = new FallbackState();
    s.recordOutcome('qwen', true, 1000);
    s.recordOutcome('qwen', false, 2000);
    s.recordOutcome('kimi', true, 3000);
    expect(s.counts('qwen', 4000)).toEqual({ ok: 1, failed: 1 });
    expect(s.counts('kimi', 4000)).toEqual({ ok: 1, failed: 0 });
    expect(s.counts('qwen', 2000 + STATS_WINDOW_MS + 1)).toEqual({ ok: 0, failed: 0 });
  });
});

describe('planProviders', () => {
  const cfg = (name: 'qwen' | 'kimi'): FallbackConfig => ({ name, apiKey: 'k', baseUrl: 'u', models: { opus: 'o', sonnet: 's', haiku: 'h' } });
  const both = { qwen: cfg('qwen'), kimi: cfg('kimi') };
  const T = 10_000;

  it('noFallback — только Claude, выбор не действует', () => {
    expect(planProviders({ selected: 'kimi', configs: both, state: new FallbackState(), noFallback: true, now: T })).toEqual(['claude']);
  });
  it('окно Claude закрыто — Claude, Qwen, Kimi', () => {
    expect(planProviders({ configs: both, state: new FallbackState(), now: T })).toEqual(['claude', 'qwen', 'kimi']);
  });
  it('без ключа Qwen — Claude, Kimi', () => {
    expect(planProviders({ configs: { qwen: null, kimi: cfg('kimi') }, state: new FallbackState(), now: T })).toEqual(['claude', 'kimi']);
  });
  it('без ключей — только Claude', () => {
    expect(planProviders({ configs: { qwen: null, kimi: null }, state: new FallbackState(), now: T })).toEqual(['claude']);
  });
  it('окно Claude открыто — только запасные', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    expect(planProviders({ configs: both, state: s, now: T + 1 })).toEqual(['qwen', 'kimi']);
  });
  it('запасной «не отвечает» — пропускается', () => {
    const s = new FallbackState();
    s.markDown('qwen', 60_000, T);
    expect(planProviders({ configs: both, state: s, now: T + 1 })).toEqual(['claude', 'kimi']);
  });
  it('окно открыто, а все запасные «не отвечают» — Claude', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    s.markDown('qwen', 60_000, T);
    s.markDown('kimi', 60_000, T);
    expect(planProviders({ configs: both, state: s, now: T + 1 })).toEqual(['claude']);
  });
  it('выбран Kimi — сначала он, затем обычный путь без него', () => {
    expect(planProviders({ selected: 'kimi', configs: both, state: new FallbackState(), now: T })).toEqual(['kimi', 'claude', 'qwen']);
  });
  it('выбран Kimi при открытом окне — Kimi, затем Qwen', () => {
    const s = new FallbackState();
    s.openClaudeWindow(60_000, T);
    expect(planProviders({ selected: 'kimi', configs: both, state: s, now: T + 1 })).toEqual(['kimi', 'qwen']);
  });
  it('выбранный пробуется первым, даже когда он «не отвечает»', () => {
    const s = new FallbackState();
    s.markDown('kimi', 60_000, T);
    expect(planProviders({ selected: 'kimi', configs: both, state: s, now: T + 1 })).toEqual(['kimi', 'claude', 'qwen']);
  });
  it('выбран без ключа — обычный путь', () => {
    expect(planProviders({ selected: 'kimi', configs: { qwen: cfg('qwen'), kimi: null }, state: new FallbackState(), now: T })).toEqual(['claude', 'qwen']);
  });
});
```

- [ ] **Step 2: Прогон — падает** — «прогон бэка: src/common/services/llm-fallback.spec.ts». Expected: FAIL — `FallbackState`/`planProviders` не экспортируются.

- [ ] **Step 3: Реализация** — дописать в конец `src/common/services/llm-fallback.ts`:

```ts
/** За какое окно считаются исходы аварийных вызовов (для алерта). */
export const STATS_WINDOW_MS = 15 * 60_000;

/**
 * Окна запасного пути — на процесс (spec 2026-10-31, раздел 2).
 * Окно Claude: после сбоя доступа к Claude вызовы идут сразу к запасным.
 * Окно «не отвечает» у каждого запасного: после его сбоя доступа аварийная
 * цепочка его пропускает. Исходы аварийных вызовов — по провайдеру, за 15 мин.
 */
export class FallbackState {
  private claudeOpenUntil = 0;
  /** Когда окно Claude открыли в последний раз: успех Claude, начатый раньше,
   *  окно не закрывает — о Claude после того сбоя он ничего не говорит. */
  private claudeOpenedAt = 0;
  private readonly downUntil: Partial<Record<FallbackProvider, number>> = {};
  private outcomes: Array<{ at: number; name: FallbackProvider; ok: boolean }> = [];

  claudeWindowOpen(now: number = Date.now()): boolean {
    return now < this.claudeOpenUntil;
  }

  /** Момент закрытия окна Claude; 0 — закрыто (в том числе истекло). */
  claudeWindowUntil(now: number = Date.now()): number {
    return this.claudeOpenUntil > now ? this.claudeOpenUntil : 0;
  }

  openClaudeWindow(ms: number, now: number = Date.now()): void {
    this.claudeOpenedAt = now;
    this.claudeOpenUntil = now + ms;
  }

  closeClaudeWindow(): void {
    this.claudeOpenUntil = 0;
  }

  claudeSucceeded(startedAt: number): void {
    if (startedAt >= this.claudeOpenedAt) this.claudeOpenUntil = 0;
  }

  isDown(name: FallbackProvider, now: number = Date.now()): boolean {
    return now < (this.downUntil[name] ?? 0);
  }

  /** Момент снятия «не отвечает»; 0 — отвечает. */
  downUntilOf(name: FallbackProvider, now: number = Date.now()): number {
    const t = this.downUntil[name] ?? 0;
    return t > now ? t : 0;
  }

  markDown(name: FallbackProvider, ms: number, now: number = Date.now()): void {
    this.downUntil[name] = now + ms;
  }

  markUp(name: FallbackProvider): void {
    this.downUntil[name] = 0;
  }

  recordOutcome(name: FallbackProvider, ok: boolean, now: number = Date.now()): void {
    this.outcomes.push({ at: now, name, ok });
    this.prune(now);
  }

  counts(name: FallbackProvider, now: number = Date.now()): { ok: number; failed: number } {
    this.prune(now);
    const mine = this.outcomes.filter((o) => o.name === name);
    const ok = mine.filter((o) => o.ok).length;
    return { ok, failed: mine.length - ok };
  }

  private prune(now: number): void {
    const from = now - STATS_WINDOW_MS;
    this.outcomes = this.outcomes.filter((o) => o.at >= from);
  }
}

/**
 * План вызова — кого пробовать по порядку (spec 2026-10-31, раздел 3).
 * noFallback — только Claude. Обычный путь: окно Claude закрыто — Claude, затем
 * включённые и отвечающие запасные; открыто — только они (если таких нет — как
 * при закрытом). Выбранный пользователем (с ключом) — первым, даже если он
 * «не отвечает», затем обычный путь без него.
 */
export function planProviders(args: {
  selected?: FallbackProvider;
  configs: FallbackConfigs;
  state: FallbackState;
  noFallback?: boolean;
  now?: number;
}): AnswerProvider[] {
  if (args.noFallback) return ['claude'];
  const now = args.now ?? Date.now();
  const normal = (exclude?: FallbackProvider): AnswerProvider[] => {
    const alts = FALLBACK_ORDER.filter((n) => n !== exclude && !!args.configs[n] && !args.state.isDown(n, now));
    return args.state.claudeWindowOpen(now) && alts.length > 0 ? [...alts] : ['claude', ...alts];
  };
  // Проверка истинностью: незнакомое значение (из БД пришло не то) даёт
  // undefined и идёт обычным путём, а не первым в план.
  if (args.selected && args.configs[args.selected]) return [args.selected, ...normal(args.selected)];
  return normal();
}
```

- [ ] **Step 4: Прогон — зелёный** — «прогон бэка: src/common/services/llm-fallback.spec.ts». Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/common/services/llm-fallback.ts src/common/services/llm-fallback.spec.ts
git commit -q -m "feat(llm-fallback): окна запасного пути и план попыток

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ClaudeCliService` — план попыток, выбор Kimi, MCP в stream-json

**Files:**
- Modify: `src/common/services/claude-cli.service.ts`
- Create: `src/common/services/claude-cli.chain.spec.ts`
- Modify: `src/common/services/claude-cli.fallback.spec.ts`, `claude-cli.forced-qwen.spec.ts`, `claude-cli.argv.spec.ts`, `claude-cli.text-delta.spec.ts`

- [ ] **Step 1: Падающий тест** — `src/common/services/claude-cli.chain.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

// Мокаем spawn ДО импорта сервиса: сервис берёт spawn из 'child_process' на
// уровне модуля.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Цепочка запасных и выбор пользователя (spec 2026-10-31-kimi-provider-design.md):
 * Claude → Qwen → Kimi по сбою доступа; выбранный — первым, при его сбое —
 * обычный путь без него. Вызовы с MCP — в stream-json.
 */

const spawnMock = spawn as unknown as jest.Mock;

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

function hangingProc() {
  return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} } as any;
}

const OK = (result: string, cost = 0.01) =>
  JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
const AUTH_FAIL = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
const KIMI_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid Authentication' });
const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const streamOk = (result: string) => lines({ type: 'result', is_error: false, result, total_cost_usd: 0.01, duration_ms: 1 });

/** Ключ i-го запуска; undefined — запуск Claude (своего окружения нет). */
const tokenOf = (i: number) => spawnMock.mock.calls[i][2]?.env?.ANTHROPIC_AUTH_TOKEN as string | undefined;
const modelOf = (i: number) => {
  const a: string[] = spawnMock.mock.calls[i][1];
  return a[a.indexOf('--model') + 1];
};
const MCP = { products: { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' } };

/** Сервис со своим корнем временных каталогов (см. claude-cli.argv.spec.ts). */
let roots: string[] = [];
function svcIn(pg?: any): ClaudeCliService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-spec-root-'));
  roots.push(root);
  const svc = new ClaudeCliService(pg);
  (svc as any).tmpRoot = () => root;
  return svc;
}

const VARS = [
  'QWEN_FALLBACK_API_KEY', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_BREAKER_MS',
  'QWEN_FALLBACK_MODEL_OPUS', 'QWEN_FALLBACK_MODEL_SONNET', 'QWEN_FALLBACK_MODEL_HAIKU',
  'KIMI_FALLBACK_API_KEY', 'KIMI_FALLBACK_BASE_URL',
  'KIMI_FALLBACK_MODEL_OPUS', 'KIMI_FALLBACK_MODEL_SONNET', 'KIMI_FALLBACK_MODEL_HAIKU',
  'LLM_FALLBACK_BREAKER_MS',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
  process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
  jest.restoreAllMocks();
});

describe('ClaudeCliService — аварийная цепочка Claude → Qwen → Kimi', () => {
  it('Claude и Qwen упали по доступу — отвечает Kimi: его модель, адрес и ключ', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('ок от kimi', 0.02)));
    const svc = new ClaudeCliService();
    const r = await svc.textWithCost('привет', { model: 'claude-opus-5-5' });
    expect(r).toEqual({ text: 'ок от kimi', costUsd: 0.02 });
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(tokenOf(0)).toBeUndefined();
    expect(tokenOf(1)).toBe('sk-sp-test');
    expect(tokenOf(2)).toBe('sk-kimi-test');
    expect(modelOf(2)).toBe('k3.1-pro');
    expect(spawnMock.mock.calls[2][2].env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.ai/coding');
    expect(svc.fallbackStats().providers).toMatchObject({ qwen: { ok: 0, failed: 1 }, kimi: { ok: 1, failed: 0 } });
  });

  it('без ключа Qwen — сразу Kimi', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('k')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('k');
    expect(tokenOf(1)).toBe('sk-kimi-test');
  });

  it('Qwen упал не по доступу (таймаут) — Kimi не пробуется, окно Claude закрыто, Qwen не «не отвечает»', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => hangingProc())
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    // 200 мс: подставной ответ Claude приходит на следующем тике, задолго до
    // таймаута; висящий Qwen получает остаток бюджета и упирается в него.
    const err = await svc.text('x', { timeoutMs: 200 }).catch((e) => e);
    expect(err.message).toMatch(/^claude CLI exited with code 1: Failed to authenticate.* \| qwen fallback: claude CLI timeout/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(svc.fallbackStats().breakerOpenUntil).toBe(0);
    expect(svc.fallbackStats().providers.qwen.downUntil).toBe(0);
    await expect(svc.text('y')).resolves.toBe('c');
    expect(tokenOf(2)).toBeUndefined();
  });

  it('упали все — причины по порядку; окно Claude закрыто; Qwen и Kimi «не отвечают»', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    const err = await svc.text('x').catch((e) => e);
    expect(err.message).toMatch(/^claude CLI exited with code 1: Failed to authenticate.* \| qwen fallback: .*401.* \| kimi fallback: .*401/);
    const st = svc.fallbackStats();
    expect(st).toMatchObject({ ok: 0, failed: 2, breakerOpenUntil: 0 });
    expect(st.providers.qwen.downUntil).toBeGreaterThan(0);
    expect(st.providers.kimi.downUntil).toBeGreaterThan(0);
    // Следующий вызов: оба запасных «не отвечают» — только Claude.
    await expect(svc.text('y')).resolves.toBe('c');
    expect(tokenOf(3)).toBeUndefined();
  });

  it('окно Claude открыто: Qwen упал — Kimi в том же вызове; окно остаётся открытым', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов 1: Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('q1')))     // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1)) // вызов 2: окно — Qwen падает
      .mockImplementationOnce(() => fakeProc(OK('k2')))     // вызов 2: Kimi
      .mockImplementationOnce(() => fakeProc(OK('k3')));    // вызов 3: Qwen «не отвечает» — сразу Kimi
    const svc = new ClaudeCliService();
    expect(await svc.text('1')).toBe('q1');
    expect(await svc.text('2')).toBe('k2');
    expect(await svc.text('3')).toBe('k3');
    expect(tokenOf(4)).toBe('sk-kimi-test');
    expect(svc.fallbackStats().breakerOpenUntil).toBeGreaterThan(0);
  });
});

describe('ClaudeCliService — выбор пользователя Kimi', () => {
  const pgMock = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) });
  const event = (pg: any, i = 0) => JSON.parse(pg.query.mock.calls[i][1][0]);

  it('сразу Kimi: один запуск; событие provider kimi, selected kimi, fallback false', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('ответ kimi', 0.03)));
    const r = await new ClaudeCliService(pg as any).textWithCost('x', { model: 'claude-opus-5-5', provider: 'kimi' });
    expect(r).toEqual({ text: 'ответ kimi', costUsd: 0.03 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(event(pg)).toMatchObject({ provider: 'kimi', fallback: false, selected: 'kimi', model: 'k3.1-pro' });
  });

  it('выбранный упал (401) — ответ через Claude; окно Claude не открыто, аварийные счётчики не растут, Kimi «не отвечает»', async () => {
    const pg = pgMock();
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService(pg as any);
    expect(await svc.text('x', { provider: 'kimi' })).toBe('c');
    expect(tokenOf(1)).toBeUndefined();
    const st = svc.fallbackStats();
    expect(st).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
    expect(st.providers.kimi.downUntil).toBeGreaterThan(0);
    expect(event(pg)).toMatchObject({ provider: 'claude', fallback: false, selected: 'kimi' });
  });

  it('выбранный упал не по доступу (кривой JSON) — тоже Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc('not json', 0))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x', { provider: 'kimi' })).toBe('c');
    expect(svc.fallbackStats().providers.kimi.downUntil).toBe(0);
  });

  it('выбранный и Claude упали — Qwen (аварийно): событие fallback true, selected kimi', async () => {
    const pg = pgMock();
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await new ClaudeCliService(pg as any).text('x', { provider: 'kimi' })).toBe('q');
    expect(tokenOf(2)).toBe('sk-sp-test');
    expect(event(pg)).toMatchObject({ provider: 'qwen', fallback: true, selected: 'kimi' });
  });

  it('упали все — ошибка начинается с выбранного', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const err = await new ClaudeCliService().text('x', { provider: 'kimi' }).catch((e) => e);
    expect(err.message).toMatch(/^kimi \(выбран\): .*401.* \| claude fallback: .*Failed to authenticate.* \| qwen fallback: .*401/);
  });

  it('выбранный при открытом окне Claude: его сбой — сразу Qwen, без попытки Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов 1 (без выбора): Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('q1')))     // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1)) // вызов 2 (выбран Kimi): падает
      .mockImplementationOnce(() => fakeProc(OK('q2')));    // вызов 2: Qwen
    const svc = new ClaudeCliService();
    await svc.text('1');
    expect(await svc.text('2', { provider: 'kimi' })).toBe('q2');
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(tokenOf(3)).toBe('sk-sp-test');
  });

  it('выбранный «не отвечает» — всё равно первый; его успех снимает «не отвечает»', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c1')))
      .mockImplementationOnce(() => fakeProc(OK('k2')));
    const svc = new ClaudeCliService();
    await svc.text('1', { provider: 'kimi' });
    expect(await svc.text('2', { provider: 'kimi' })).toBe('k2');
    expect(tokenOf(2)).toBe('sk-kimi-test');
    expect(svc.fallbackStats().providers.kimi.downUntil).toBe(0);
  });

  it('без ключа Kimi — предупреждение и обычный путь', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await new ClaudeCliService().text('x', { provider: 'kimi' })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Kimi выбран.*KIMI_FALLBACK_API_KEY/);
  });

  it('выбранный успел вызвать инструмент с последствиями — не повторяем', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: 'API Error: 500 Internal' },
    ), 1));
    const err = await new ClaudeCliService().textWithCost('x', { provider: 'kimi', onProgress: () => {} }).catch((e) => e);
    expect(err.message).toMatch(/^kimi \(выбран\): /);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCliService — вызовы с MCP идут в stream-json', () => {
  it('без onProgress — stream-json и --verbose, ответ из result', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(streamOk('ок')));
    expect(await svcIn().text('x', { mcpServers: MCP })).toBe('ок');
    const a: string[] = spawnMock.mock.calls[0][1];
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(a).not.toContain('--include-partial-messages');
  });

  it('как у Маши: сбой входа до инструментов — Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1))
      .mockImplementationOnce(() => fakeProc(streamOk('q')));
    expect(await svcIn().text('x', { mcpServers: MCP })).toBe('q');
    expect(tokenOf(1)).toBe('sk-sp-test');
  });

  it('как у Маши: выбран Kimi, упал до инструментов — Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401' }), 1))
      .mockImplementationOnce(() => fakeProc(streamOk('c')));
    expect(await svcIn().text('x', { mcpServers: MCP, provider: 'kimi' })).toBe('c');
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(tokenOf(1)).toBeUndefined();
  });

  it('инструмент MCP с последствиями до сбоя — не повторяем', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: 'API Error: 529 Overloaded' },
    ), 1));
    await expect(svcIn().text('x', { mcpServers: MCP })).rejects.toThrow('529');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCliService.fallbackStats — по провайдерам', () => {
  it('enabled у каждого по своему ключу; общий enabled — хоть один', () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const st = new ClaudeCliService().fallbackStats();
    expect(st).toMatchObject({ enabled: true, ok: 0, failed: 0, breakerOpenUntil: 0, windowMs: 15 * 60_000 });
    expect(st.providers).toEqual({
      qwen: { enabled: false, ok: 0, failed: 0, downUntil: 0 },
      kimi: { enabled: true, ok: 0, failed: 0, downUntil: 0 },
    });
    delete process.env.KIMI_FALLBACK_API_KEY;
    expect(new ClaudeCliService().fallbackStats().enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Прогон — падает** — «прогон бэка: src/common/services/claude-cli.chain.spec.ts». Expected: FAIL (Kimi не пробуется, `providers` нет, `provider: 'kimi'` не проходит tsc в ts-jest — допустимо, если упадёт на типах).

- [ ] **Step 3: Поправить прежние спеки под новое поведение и переменные**

`src/common/services/claude-cli.fallback.spec.ts`:

1. Массив `VARS` (около строки 108) заменить на:

```ts
// Ключ Kimi из окружения CI добавил бы в этих тестах третью попытку — снимаем
// и его (цепочка с Kimi — claude-cli.chain.spec.ts).
const VARS = [
  'QWEN_FALLBACK_API_KEY', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_BREAKER_MS',
  'QWEN_FALLBACK_MODEL_OPUS', 'QWEN_FALLBACK_MODEL_SONNET', 'QWEN_FALLBACK_MODEL_HAIKU',
  'KIMI_FALLBACK_API_KEY', 'LLM_FALLBACK_BREAKER_MS',
];
```

2. Тест `'вызов с MCP без stream-json — не переключает (вызов инструмента не виден)'` заменить целиком на:

```ts
  it('вызов с MCP идёт в stream-json: сбой входа до инструментов → Qwen (spec 2026-10-31)', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1))
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: false, result: 'q', total_cost_usd: 0.01, duration_ms: 1 })));
    await expect(svcIn().svc.text('x', { mcpServers: MCP })).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });
```

3. В тесте `'через открытое окно вызов с MCP в json-режиме идёт на Qwen (попытки Claude нет — двойного срабатывания нет)'`: название — `'через открытое окно вызов с MCP идёт на Qwen (попытки Claude нет — двойного срабатывания нет)'`; третий мок `fakeProc(OK('q2'))` → `fakeProc(lines({ type: 'result', is_error: false, result: 'q2', total_cost_usd: 0.01, duration_ms: 1 }))` (вызов с MCP теперь читает stream-json).

`src/common/services/claude-cli.forced-qwen.spec.ts`:

1. Шапку-комментарий заменить на:

```ts
/**
 * Выбор пользователя «Qwen» (админка, spec 2026-10-30-llm-provider-switch и
 * 2026-10-31-kimi-provider-design): вызов сразу на Qwen, при его сбое — обычный
 * путь (Claude, затем запасные без него). Это не авария — окно Claude и
 * аварийные счётчики не трогаются, событие помечено fallback: false, selected.
 */
```

2. Блок `const OLD …` / `beforeEach` / `afterEach` заменить на:

```ts
const OLD = process.env.QWEN_FALLBACK_API_KEY;
const OLD_KIMI = process.env.KIMI_FALLBACK_API_KEY;
beforeEach(() => {
  spawnMock.mockReset();
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
  delete process.env.KIMI_FALLBACK_API_KEY; // цепочка с Kimi — claude-cli.chain.spec.ts
});
afterEach(() => {
  if (OLD === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD;
  if (OLD_KIMI === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD_KIMI;
  jest.restoreAllMocks();
});
```

3. Тест `'сбой принудительного Qwen — понятная ошибка, окно не открыто'` заменить целиком на:

```ts
  it('сбой выбранного Qwen — ответ через Claude; окно Claude не открыто, аварийные счётчики не растут', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1)).mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x', { provider: 'qwen' })).toBe('c');
    expect(hasEnv(1)).toBe(false);
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
  });
```

4. В тесте `'событие: provider qwen, fallback false'` ожидание — `toMatchObject({ provider: 'qwen', fallback: false, selected: 'qwen', model: 'qwen3.8-max' })`.

`src/common/services/claude-cli.argv.spec.ts` (около строки 57) и `src/common/services/claude-cli.text-delta.spec.ts` (около строки 106): рядом с ключом Qwen так же сохранять, снимать и возвращать `KIMI_FALLBACK_API_KEY` — блок становится таким:

```ts
let savedQwenKey: string | undefined;
let savedKimiKey: string | undefined;
beforeEach(() => {
  spawnMock.mockReset();
  savedQwenKey = process.env.QWEN_FALLBACK_API_KEY;
  savedKimiKey = process.env.KIMI_FALLBACK_API_KEY;
  delete process.env.QWEN_FALLBACK_API_KEY;
  delete process.env.KIMI_FALLBACK_API_KEY;
});
afterEach(() => {
  if (savedQwenKey === undefined) delete process.env.QWEN_FALLBACK_API_KEY;
  else process.env.QWEN_FALLBACK_API_KEY = savedQwenKey;
  if (savedKimiKey === undefined) delete process.env.KIMI_FALLBACK_API_KEY;
  else process.env.KIMI_FALLBACK_API_KEY = savedKimiKey;
});
```

(В `claude-cli.argv.spec.ts` перед блоком остаётся прежний комментарий про ключ запасного пути из окружения CI.)

- [ ] **Step 4: Реализация в `src/common/services/claude-cli.service.ts`**

4.1. Импорт из `./qwen-fallback` (строки 10–18) заменить на:

```ts
import { classifyLlmError, looksLikeCliRefusal } from '../llm-error';
import {
  AnswerProvider,
  FALLBACK_ORDER,
  FallbackConfig,
  FallbackProvider,
  FallbackState,
  NO_FALLBACK_CONFIGS,
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  STATS_WINDOW_MS,
  fallbackModelFor,
  fallbackSpawnEnv,
  fallbackTimeoutMs,
  isFallbackWorthy,
  planProviders,
  readBreakerMs,
  readFallbackConfigs,
} from './llm-fallback';
```

4.2. Удалить константу `FALLBACK_STATS_WINDOW_MS` вместе с её комментарием (окно статистики — `STATS_WINDOW_MS` из `llm-fallback.ts`).

4.3. Комментарии про Qwen → про «другого провайдера»:
- у `SIDE_EFFECT_FREE_TOOLS`: `/** Встроенные тулы без последствий: их вызов повтор у другого провайдера не запрещает — ни в stream-json (где вызов виден), ни вслепую в json-режиме. */`;
- у `ClaudeCliCallError`: последнее предложение — `Такой вызов у другого провайдера не повторяется: инструмент с последствиями (правка продукта, жалоба в поддержку) сработал бы дважды.`;
- у `onTextDelta`: `Такой вызов у другого провайдера не повторяется: показанный человеку текст повтор не заберёт обратно.`

4.4. Опции `noFallback` и `provider` — заменить их объявления с комментариями на:

```ts
  /** Только Claude: без запасных и без выбора пользователя. Для проверок
   *  живости Claude: с запасными они показывали бы «зелёный», когда Claude
   *  лежит. Сбой такого вызова окно Claude не открывает, успех — закрывает. */
  noFallback?: boolean;
  /** Выбор пользователя в админке (UserLlmProviderService): вызов сразу у
   *  выбранного запасного, при его сбое — обычный путь (Claude, затем запасные
   *  без него; spec 2026-10-31-kimi-provider-design.md). Не авария: окно Claude
   *  и аварийные счётчики он не трогает. Без ключа и при noFallback — обычный путь. */
  provider?: FallbackProvider;
```

4.5. Поля класса `breakerOpenUntil`, `breakerOpenedAt`, `fallbackOutcomes` (с их комментариями) заменить на:

```ts
  /** Окна запасного пути (окно Claude и «не отвечает» у каждого запасного) и
   *  исходы аварийных вызовов — llm-fallback.ts. */
  private readonly fallback = new FallbackState();
```

4.6. `trackCallEvent` заменить целиком:

```ts
  private trackCallEvent(opts: {
    costUsd: number; model: string; durationMs: number; ok: boolean;
    provider: AnswerProvider; fallback: boolean; selected?: FallbackProvider;
  }) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('claude_cli_call', $1::jsonb)`,
      [JSON.stringify({
        cost_usd: opts.costUsd,
        model: opts.model,
        duration_ms: opts.durationMs,
        ok: opts.ok,
        provider: opts.provider,
        fallback: opts.fallback,
        // Выбор пользователя (не Claude); «выбранный подвёл» — selected ≠ provider.
        selected: opts.selected,
      })],
    ).catch((e: any) => this.logger.warn(`claude_cli_call event insert failed: ${e.message}`));
  }
```

4.7. `fallbackStats`, `noteFallbackOutcome`, `pruneFallbackOutcomes` заменить одним методом:

```ts
  /** Состояние запасного пути — для алертов мониторинга и пробы без входа.
   *  enabled/ok/failed — по всем запасным вместе (прежняя форма),
   *  breakerOpenUntil — окно Claude, providers — по каждому. */
  fallbackStats(now: number = Date.now()): {
    enabled: boolean; ok: number; failed: number; breakerOpenUntil: number; windowMs: number;
    providers: Record<FallbackProvider, { enabled: boolean; ok: number; failed: number; downUntil: number }>;
  } {
    const configs = readFallbackConfigs();
    const providers = {} as Record<FallbackProvider, { enabled: boolean; ok: number; failed: number; downUntil: number }>;
    let ok = 0;
    let failed = 0;
    for (const name of FALLBACK_ORDER) {
      const c = this.fallback.counts(name, now);
      providers[name] = { enabled: configs[name] !== null, ok: c.ok, failed: c.failed, downUntil: this.fallback.downUntilOf(name, now) };
      ok += c.ok;
      failed += c.failed;
    }
    return {
      enabled: FALLBACK_ORDER.some((n) => configs[n] !== null),
      ok,
      failed,
      windowMs: STATS_WINDOW_MS,
      breakerOpenUntil: this.fallback.claudeWindowUntil(now),
      providers,
    };
  }
```

4.8. В комментариях `textWithCost` и `text`: «ответ может дать запасной Qwen» → «ответ может дать запасной провайдер».

4.9. Всё от комментария `Claude, при сбое доступа — тот же вызов на Qwen (spec` над `runRaw` до конца метода `runOnQwen` включительно (`runRaw`, `planQwenRetry`, `mayRetryOnQwen`, `runForcedQwen`, `runOnQwen`) заменить на:

```ts
  /**
   * План попыток (spec 2026-10-31-kimi-provider-design.md, раздел 3): выбор
   * пользователя, Claude, запасные Qwen → Kimi в порядке цепочки. Без ключей
   * запасных и с noFallback — ровно один вызов Claude, как раньше.
   */
  private async runRaw(prompt: string, opts: ClaudeCliOptions): Promise<CliRunResult> {
    const configs = opts.noFallback ? NO_FALLBACK_CONFIGS : readFallbackConfigs();
    // Выбор пользователя (админка): сразу выбранный, при его сбое — обычный путь.
    let selected: FallbackProvider | undefined;
    if (opts.provider && !opts.noFallback) {
      // Проверка истинностью: незнакомое значение (не qwen/kimi) даёт undefined —
      // обычный путь без предупреждения; так же его отсекает planProviders.
      if (configs[opts.provider]) selected = opts.provider;
      else if (opts.provider in PROVIDER_DEFAULTS) this.logger.warn(`${PROVIDER_LABELS[opts.provider]} выбран для пользователя, но ключ ${PROVIDER_DEFAULTS[opts.provider].envPrefix}_FALLBACK_API_KEY не задан — обычный путь`);
    }
    const plan = planProviders({ selected, configs, state: this.fallback, noFallback: opts.noFallback });
    const breakerMs = readBreakerMs();
    const startedAt = Date.now();
    // Причины по попыткам — для текста ошибки, если не ответит никто.
    const parts: string[] = plan[0] !== 'claude' && plan[0] !== selected
      ? ['claude CLI пропущен (окно запасного пути)']
      : [];
    let reachedFallback = false;
    let attemptOpts = opts;
    for (let i = 0; i < plan.length; ) {
      const p = plan[i];
      const emergency = p !== 'claude' && p !== selected;
      if (emergency) reachedFallback = true;
      const attemptStartedAt = Date.now();
      let res: CliRunResult | null = null;
      let err: unknown = null;
      try {
        res = await this.runOnce(prompt, attemptOpts, p === 'claude' ? null : configs[p], { fallback: emergency, selected });
      } catch (e) {
        err = e;
      }
      // Отказ CLI, пришедший обычным ответом (без is_error), — сбой того
      // провайдера, что его дал; окно Claude такой «успех» не закрывает.
      const refusal = res !== null && looksLikeCliRefusal(res.text);
      if (res !== null && !refusal) {
        if (p === 'claude') this.fallback.claudeSucceeded(attemptStartedAt);
        else {
          this.fallback.markUp(p);
          if (emergency) this.fallback.recordOutcome(p, true);
        }
        return res;
      }
      if (refusal) err = new ClaudeCliCallError(`claude CLI error: ${res!.text.trim()}`, res!.toolUsed);
      const msg = String((err as any)?.message ?? err);
      const access = isFallbackWorthy(msg);
      const kind = classifyLlmError(msg).kind;
      // Сбой доступа — свидетельство для следующих вызовов, даже если этот
      // повторять нельзя: у Claude — окно Claude (если есть на кого
      // переключаться), у запасного — его окно «не отвечает».
      if (access) {
        if (p !== 'claude') this.fallback.markDown(p, breakerMs);
        else if (FALLBACK_ORDER.some((n) => configs[n] !== null)) this.fallback.openClaudeWindow(breakerMs);
      }
      if (emergency) this.fallback.recordOutcome(p, false);
      parts.push(parts.length === 0 ? (p === selected ? `${p} (выбран): ${msg}` : msg) : `${p} fallback: ${msg}`);
      const next = this.nextAttempt(plan, i);
      // Выбранный — при любом сбое (решение владельца), остальные — только при
      // сбое доступа; и только если повтор ничего не задвоит.
      const allowed = (p === selected || access) && this.mayRetry(err, opts);
      if (next < 0 || !allowed) {
        if (access && next >= 0) {
          this.logger.warn(`${this.attemptLabel(p, selected)}: сбой доступа (${kind}), вызов не повторяется (инструмент с последствиями или показанный текст): ${msg.slice(0, 200)}`);
        }
        if (reachedFallback) {
          // Вызов дошёл до запасных, и никто не ответил: Claude мог уже ожить —
          // следующий вызов снова попробует его.
          this.fallback.closeClaudeWindow();
          this.logger.error(`запасные тоже не ответили: ${parts.join(' | ').slice(0, 300)}`);
        }
        if (parts.length === 1) {
          // Одна попытка — как раньше: отказ текстом вызывающий получает как
          // есть, ошибку Claude — исходным объектом.
          if (refusal) return res!;
          if (p === 'claude') throw err;
        }
        throw new Error(parts.join(' | '));
      }
      const target = plan[next];
      const toLabel = target === 'claude'
        ? 'Claude'
        : `запасной ${PROVIDER_LABELS[target]} ${fallbackModelFor(opts.model ?? DEFAULT_MODEL, configs[target]!.models)}`;
      this.logger.warn(`${this.attemptLabel(p, selected)} → ${toLabel} (${kind}): ${msg.slice(0, 200)}`);
      // Следующая попытка укладывается в остаток бюджета вызова, а не в полный.
      attemptOpts = { ...opts, timeoutMs: fallbackTimeoutMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, Date.now() - startedAt) };
      i = next;
    }
    throw new Error(parts.join(' | ') || 'claude CLI: пустой план попыток');
  }

  /** Подпись попытки в логе: «claude CLI», «Kimi (выбран)», «Qwen». */
  private attemptLabel(p: AnswerProvider, selected?: FallbackProvider): string {
    if (p === 'claude') return 'claude CLI';
    return p === selected ? `${PROVIDER_LABELS[p]} (выбран)` : PROVIDER_LABELS[p];
  }

  /** Следующий в плане после i: запасной, который за время вызова стал «не
   *  отвечает» (его уронил параллельный вызов), пропускается. -1 — некуда. */
  private nextAttempt(plan: AnswerProvider[], i: number): number {
    for (let j = i + 1; j < plan.length; j++) {
      const p = plan[j];
      if (p !== 'claude' && this.fallback.isDown(p)) continue;
      return j;
    }
    return -1;
  }

  private static hasMcp(opts: ClaudeCliOptions): boolean {
    return !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;
  }

  /** Можно ли повторить вызов у следующего провайдера: только если модель ещё
   *  ничего не сделала инструментами с последствиями и человек не видел текста. */
  private mayRetry(e: unknown, opts: ClaudeCliOptions): boolean {
    if (e instanceof ClaudeCliCallError && e.toolUsed) return false;
    // Человек уже видит куски ответа — второй, другой ответ поверх них хуже ошибки.
    if (opts.onTextDelta) return false;
    // Без stream-json вызов инструмента не виден: вслепую повторяем, только
    // если встроенные тулы лишь из Read/WebSearch/WebFetch (Bash, Write, Edit,
    // 'default' — нельзя). Вызовы с MCP всегда идут в stream-json (spawnClaude).
    if (!opts.onProgress && !ClaudeCliService.hasMcp(opts)) {
      const riskyTools = (opts.tools ?? '')
        .split(/[\s,]+/)
        .some((t) => t !== '' && !SIDE_EFFECT_FREE_TOOLS.has(t));
      if (riskyTools) return false;
    }
    return true;
  }
```

4.10. `runOnce` заменить целиком:

```ts
  /** Один запуск CLI: cfg = null — Claude, иначе — модель и окружение запасного. */
  private async runOnce(
    prompt: string,
    opts: ClaudeCliOptions,
    cfg: FallbackConfig | null,
    meta: { fallback: boolean; selected?: FallbackProvider },
  ): Promise<CliRunResult> {
    // Одноразовые каталоги вызова (создаются только когда нужны — см. ниже):
    // копии вложений и конфиг MCP с токенами. Снимаются в finally — и на успехе,
    // и на падении, и по таймауту, — чтобы не копить в tmp ни чужих файлов, ни
    // живых токенов. У следующей попытки — свои: каталоги упавшей к этому
    // моменту уже сняты.
    const perCallTmpDirs: string[] = [];
    try {
      return await this.spawnClaude(prompt, opts, (dir) => { perCallTmpDirs.push(dir); }, cfg, meta);
    } finally {
      for (const dir of perCallTmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e: any) { this.logger.warn(`per-call tmp cleanup failed (${dir}): ${e.message}`); }
      }
    }
  }
```

4.11. В `spawnClaude`:
- сигнатура: последние два параметра `qwen: QwenFallbackConfig | null, fallback: boolean` → `cfg: FallbackConfig | null, meta: { fallback: boolean; selected?: FallbackProvider }`;
- начало метода (от `const requestedModel` до `const hasMcp = …` включительно) заменить на:

```ts
    const requestedModel = opts.model ?? DEFAULT_MODEL;
    // У запасного в --model уходит его модель: полный id Claude он не знает.
    const model = cfg ? fallbackModelFor(requestedModel, cfg.models) : requestedModel;
    const provider: AnswerProvider = cfg ? cfg.name : 'claude';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const hasAttachments = (opts.attachments?.length ?? 0) > 0;
    const hasMcp = ClaudeCliService.hasMcp(opts);
    // stream-json — и у вызовов с MCP (Маша): там видно, вызывала ли модель
    // инструмент, а от этого зависит, можно ли повторить вызов у другого
    // провайдера (mayRetry). В json-режиме такой вызов не повторялся бы никогда.
    const streaming = !!opts.onProgress || !!opts.onTextDelta || hasMcp;
```

- остальные точечные замены в `spawnClaude` (было → стало):

```ts
// комментарий над spawn, было:
//   Обычный запуск наследует process.env как есть; запасной получает своё
//   окружение (адрес и ключ Alibaba) — и только он.
// стало:
//   Обычный запуск наследует process.env как есть; запасной получает своё
//   окружение (адрес и ключ провайдера) — и только он.

// в опциях spawn, было:
        ...(qwen ? { env: qwenSpawnEnv(process.env, qwen) } : {}),
// стало:
        ...(cfg ? { env: fallbackSpawnEnv(process.env, cfg) } : {}),

// комментарий у let sawRiskyToolUse, было: «— решает, можно ли повторить на Qwen.»
// стало: «— решает, можно ли повторить у другого провайдера.»

// stream-ветка, было:
            this.logger.debug(`claude CLI cost${qwen ? ' (qwen)' : ''}: $${streamCostUsd.toFixed(4)}, ${streamDurationMs}ms (stream)`);
// стало:
            this.logger.debug(`claude CLI cost${cfg ? ` (${cfg.name})` : ''}: $${streamCostUsd.toFixed(4)}, ${streamDurationMs}ms (stream)`);

// json-ветка, было:
            this.logger.debug(`claude CLI cost${qwen ? ' (qwen)' : ''}: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);
// стало:
            this.logger.debug(`claude CLI cost${cfg ? ` (${cfg.name})` : ''}: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);

// оба вызова this.trackCallEvent({ … }), было:
            provider,
            fallback,
// стало:
            provider,
            fallback: meta.fallback,
            selected: meta.selected,

// комментарий в json-ветке перед resolve, было:
//   осторожность — в mayRetryOnQwen по набору тулов и MCP.
// стало:
//   осторожность — в mayRetry по набору тулов.
```

4.12. Проверка, что от Qwen-имён ничего не осталось:

```bash
grep -n "qwen\|Qwen\|breakerOpen\|fallbackOutcomes" src/common/services/claude-cli.service.ts
```

Expected: ничего (кроме, допустимо, упоминаний в общих комментариях вида «Qwen → Kimi»).

- [ ] **Step 5: Прогон — зелёный** — «прогон бэка: src/common/services/claude-cli src/common/services/llm-fallback.spec.ts src/guest-trial src/monitoring/claude-health» и «tsc бэка». Expected: все PASS, `TSC_OK`. Красное — разбирать по одному, не подгонять тесты под реализацию без сверки со spec.

- [ ] **Step 6: Коммит**

```bash
git add src/common/services/claude-cli.service.ts src/common/services/claude-cli.chain.spec.ts src/common/services/claude-cli.fallback.spec.ts src/common/services/claude-cli.forced-qwen.spec.ts src/common/services/claude-cli.argv.spec.ts src/common/services/claude-cli.text-delta.spec.ts
git commit -q -m "feat(claude-cli): план попыток Claude → Qwen → Kimi, выбор Kimi, MCP в stream-json, selected в событии

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: выбор `kimi` в данных и админ-ручке; снять `qwen-fallback.ts`

**Files:**
- Modify: `src/common/services/user-llm-provider.service.ts` (+ `.spec.ts`)
- Modify: `src/admin/admin-llm-provider.controller.ts` (+ `.spec.ts`)
- Delete: `src/common/services/qwen-fallback.ts`, `src/common/services/qwen-fallback.spec.ts`

- [ ] **Step 1: Падающие тесты**

В `src/common/services/user-llm-provider.service.spec.ts` дописать в `describe`:

```ts
  it('get: kimi', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'kimi' }] }));
    expect(await svc.get('u-1')).toBe('kimi');
  });

  it('get: незнакомое значение — claude', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'gpt' }] }));
    expect(await svc.get('u-1')).toBe('claude');
  });

  it('set kimi — пишет kimi', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    expect(await svc.set('u-1', 'kimi')).toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['u-1', 'kimi']);
  });
```

`src/admin/admin-llm-provider.controller.spec.ts` — заменить целиком:

```ts
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AdminLlmProviderController } from './admin-llm-provider.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('AdminLlmProviderController', () => {
  const OLD = { qwen: process.env.QWEN_FALLBACK_API_KEY, kimi: process.env.KIMI_FALLBACK_API_KEY };
  /** Какие ключи запасных заданы на бэкенде. */
  const keys = (qwen: boolean, kimi: boolean) => {
    if (qwen) process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test'; else delete process.env.QWEN_FALLBACK_API_KEY;
    if (kimi) process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test'; else delete process.env.KIMI_FALLBACK_API_KEY;
  };
  afterEach(() => {
    if (OLD.qwen === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD.qwen;
    if (OLD.kimi === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD.kimi;
  });

  it('закрыт JwtGuard + AdminGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminLlmProviderController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });

  it('GET: выбор и ключи по каждому запасному (+ прежнее qwenConfigured)', async () => {
    keys(true, false);
    const svc = { get: jest.fn(async () => 'kimi'), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).get('u-1', res);
    expect(svc.get).toHaveBeenCalledWith('u-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'kimi', qwenConfigured: true, configured: { qwen: true, kimi: false },
    });
  });

  it('GET без ключей — всё false', async () => {
    keys(false, false);
    const svc = { get: jest.fn(async () => 'claude'), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).get('u-1', res);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'claude', qwenConfigured: false, configured: { qwen: false, kimi: false },
    });
  });

  it('POST kimi: сохраняет и отдаёт новое значение', async () => {
    keys(false, true);
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('u-1', { userId: 'admin-1' }, { provider: 'kimi' }, res);
    expect(svc.set).toHaveBeenCalledWith('u-1', 'kimi');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'kimi', qwenConfigured: false, configured: { qwen: false, kimi: true },
    });
  });

  it('POST: чужое значение — 400 со списком допустимых, ничего не пишет', async () => {
    const svc = { get: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('u-1', { userId: 'admin-1' }, { provider: 'gpt' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "provider: 'claude' | 'qwen' | 'kimi'" });
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST: нет пользователя — 404', async () => {
    const svc = { get: jest.fn(), set: jest.fn(async () => false) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('nobody', { userId: 'admin-1' }, { provider: 'claude' }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('POST: успешная смена — лог с актором, пользователем и значением', async () => {
    keys(false, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    await new AdminLlmProviderController(svc as any).set('u-1', { userId: 'admin-1' }, { provider: 'kimi' }, mkRes());
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('admin-1 → u-1 = kimi');
    log.mockRestore();
  });

  it('POST: без user (@CurrentUser не отдал) — актор unknown, лог всё равно пишется', async () => {
    keys(false, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    await new AdminLlmProviderController(svc as any).set('u-1', undefined, { provider: 'claude' }, mkRes());
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('unknown → u-1 = claude');
    log.mockRestore();
  });

  it('POST: отказ (400/404) — лог не пишется', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => false) };
    await new AdminLlmProviderController(svc as any).set('nobody', { userId: 'admin-1' }, { provider: 'claude' }, mkRes());
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Прогон — падает** — «прогон бэка: src/common/services/user-llm-provider.service.spec.ts src/admin/admin-llm-provider.controller.spec.ts». Expected: FAIL (`kimi` → `claude`, нет `configured`, текст 400 без `kimi`).

- [ ] **Step 3: Реализация**

`src/common/services/user-llm-provider.service.ts`:
- импорт и типы в начале файла (вместо `export type LlmProvider = 'claude' | 'qwen'; export const LLM_PROVIDERS …`):

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from './pg.service';
import { ANSWER_PROVIDERS, AnswerProvider, isAnswerProvider } from './llm-fallback';

/** Модель ответов человека: 'claude' (по умолчанию), 'qwen' или 'kimi'. */
export type LlmProvider = AnswerProvider;
export const LLM_PROVIDERS: readonly LlmProvider[] = ANSWER_PROVIDERS;
```

- в комментарии класса: `NULL — Claude (по умолчанию), 'qwen' или 'kimi' — ответы сразу через выбранного (spec 2026-10-30-llm-provider-switch, 2026-10-31-kimi-provider-design).`;
- в `get`: строку `return r.rows[0]?.llm_provider === 'qwen' ? 'qwen' : 'claude';` заменить на:

```ts
      const v = r.rows[0]?.llm_provider;
      // NULL и незнакомое значение — Claude.
      return isAnswerProvider(v) ? v : 'claude';
```

- в `set`: `[userId, provider === 'qwen' ? 'qwen' : null]` → `[userId, provider === 'claude' ? null : provider]`.

`src/admin/admin-llm-provider.controller.ts` — заменить целиком:

```ts
import { Body, Controller, Get, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { LLM_PROVIDERS, LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';
import { readFallbackConfigs } from '../common/services/llm-fallback';

/**
 * Модель ответов ассистентов по аккаунту (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-kimi-provider-design). :userId — тот же идентификатор, что у
 * /webhook/admin/users/:phone/activity (телефон или UUID входа по почте).
 * configured — задан ли ключ запасного на бэкенде, по каждому: без него выбор
 * молча работает как Claude. qwenConfigured — прежнее поле для фронта до выката.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminLlmProviderController {
  private readonly logger = new Logger(AdminLlmProviderController.name);

  constructor(private readonly providers: UserLlmProviderService) {}

  @Get('admin/users/:userId/llm-provider')
  async get(@Param('userId') userId: string, @Res() res: Response) {
    const provider = await this.providers.get(userId);
    return res.status(200).json(this.body(userId, provider));
  }

  @Post('admin/users/:userId/llm-provider')
  async set(
    @Param('userId') userId: string,
    @CurrentUser() user: any,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const provider = String(body?.provider ?? '') as LlmProvider;
    if (!LLM_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider: ${LLM_PROVIDERS.map((p) => `'${p}'`).join(' | ')}` });
    }
    if (!(await this.providers.set(userId, provider))) {
      return res.status(404).json({ error: 'user not found' });
    }
    // Смена модели ответов тратит квоту владельца — оставляем след: кто и
    // кого переключил.
    const actor = user?.userId ?? 'unknown';
    this.logger.log(`llm_provider: ${actor} → ${userId} = ${provider}`);
    return res.status(200).json(this.body(userId, provider));
  }

  private body(userId: string, provider: LlmProvider) {
    const configs = readFallbackConfigs();
    const configured = { qwen: configs.qwen !== null, kimi: configs.kimi !== null };
    return { userId, provider, qwenConfigured: configured.qwen, configured };
  }
}
```

Снять старый модуль:

```bash
git rm -q src/common/services/qwen-fallback.ts src/common/services/qwen-fallback.spec.ts
grep -rn "qwen-fallback'" src scripts || echo "импортов нет"
```

Expected: `импортов нет` (`scripts/qwen-fallback-check.js` грузит собранный сервис, а не модуль; меняется в Task 7).

- [ ] **Step 4: Прогон — зелёный** — «прогон бэка: src/common/services src/admin/admin-llm-provider.controller.spec.ts» и «tsc бэка». Expected: PASS, `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git add -A src/common/services/user-llm-provider.service.ts src/common/services/user-llm-provider.service.spec.ts src/admin/admin-llm-provider.controller.ts src/admin/admin-llm-provider.controller.spec.ts src/common/services/qwen-fallback.ts src/common/services/qwen-fallback.spec.ts
git commit -q -m "feat(admin): выбор Kimi в модели ответов; configured по каждому запасному; qwen-fallback.ts заменён llm-fallback.ts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: бэкенд следует выбору Kimi — Маша, релей, TG; `selected` в `chat_quality`

**Files:**
- Modify: `src/chat/answer-provider.ts` (+ `.spec.ts`)
- Modify: `src/chat/chat.service.ts`, `src/chat/chat.controller.ts`, `src/tg-bot/tg-router.service.ts`
- Modify: `src/chat/chat.service.llm-provider.spec.ts`, `src/chat/chat.upload-llm-provider.spec.ts`, `src/tg-bot/tg-router.model.spec.ts`

- [ ] **Step 1: Падающие тесты**

`src/chat/answer-provider.spec.ts`: импорт дополнить `cliProviderOption`; в `describe('relayProviderFields')` дописать:

```ts
  it('kimi — provider', () => expect(relayProviderFields(false, 'kimi')).toEqual({ provider: 'kimi' }));
  it('проба при выборе Kimi — только noFallback', () => expect(relayProviderFields(true, 'kimi')).toEqual({ noFallback: '1' }));
```

в `describe('readDoneProvider')`:

```ts
  it('kimi', () => {
    expect(readDoneProvider({ type: 'done', provider: 'kimi', fallback: false })).toEqual({ provider: 'kimi', fallback: false });
  });
```

и новый блок:

```ts
describe('cliProviderOption', () => {
  it('claude — без поля', () => expect(cliProviderOption('claude')).toEqual({}));
  it('qwen', () => expect(cliProviderOption('qwen')).toEqual({ provider: 'qwen' }));
  it('kimi', () => expect(cliProviderOption('kimi')).toEqual({ provider: 'kimi' }));
});
```

`src/chat/chat.service.llm-provider.spec.ts`: у `harness` тип выбора — `choice: 'claude' | 'qwen' | 'kimi'`; в `describe('streamUniversalAgent: модель ответов человека — запрос к релею')` дописать:

```ts
  it('выбран Kimi — provider=kimi, без noFallback', async () => {
    const h = harness('kimi');
    await h.run();
    expect(h.fields().provider).toBe('kimi');
    expect(h.fields().noFallback).toBeUndefined();
  });
```

в `describe('streamUniversalAgent: чем ответил релей — в chat_quality')` дописать:

```ts
  it('выбран Kimi и ответил он — provider и selected kimi', async () => {
    const h = harness('kimi', [{ type: 'delta', text: 'ок' }, { type: 'done', provider: 'kimi', fallback: false }]);
    await h.run();
    expect(h.quality()).toMatchObject({ provider: 'kimi', selected: 'kimi' });
    expect(h.quality().fallback).toBeUndefined();
  });

  it('выбранный подвёл — ответил Claude: selected kimi, provider claude', async () => {
    const h = harness('kimi', [{ type: 'delta', text: 'ок' }, { type: 'done', provider: 'claude', fallback: false }]);
    await h.run();
    expect(h.quality()).toMatchObject({ provider: 'claude', selected: 'kimi' });
  });

  it('выбран Claude — selected не пишется', async () => {
    const h = harness('claude', [{ type: 'delta', text: 'ок' }, { type: 'done', provider: 'claude', fallback: false }]);
    await h.run();
    expect(h.quality().selected).toBeUndefined();
  });
```

`src/chat/chat.upload-llm-provider.spec.ts`: `async function upload(choice: 'claude' | 'qwen' | 'kimi')`; в `describe` дописать:

```ts
  it('выбран Kimi — provider=kimi, без noFallback', async () => {
    const { fields } = await upload('kimi');
    expect(fields.provider).toBe('kimi');
    expect(fields.noFallback).toBeUndefined();
  });
```

`src/tg-bot/tg-router.model.spec.ts`, после теста `'без выбора — provider не задан'`:

```ts
  it('владелец выбрал Kimi — основной ход с provider: kimi', async () => {
    const { svc, claudeCli } = makeRouter();
    (svc as any).llmProvider = { get: jest.fn(async () => 'kimi') };
    await svc.generateReply({ ...cfg, owner_user_id: 'u-owner' }, 'Дмитрий');
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('kimi');
  });
```

- [ ] **Step 2: Прогон — падает** — «прогон бэка: src/chat/answer-provider.spec.ts src/chat/chat.service.llm-provider.spec.ts src/chat/chat.upload-llm-provider.spec.ts src/tg-bot/tg-router.model.spec.ts». Expected: FAIL (нет `cliProviderOption`, `kimi` не уходит, нет `selected`).

- [ ] **Step 3: Реализация**

`src/chat/answer-provider.ts` — заменить целиком:

```ts
import { isAnswerProvider } from '../common/services/llm-fallback';
import type { FallbackProvider } from '../common/services/llm-fallback';
import type { LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Через какую модель отвечать человеку (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-kimi-provider-design). Пробы мониторинга — всегда Claude: они
 * меряют его, а не настройку.
 */
export async function resolveAnswerProvider(
  probe: boolean,
  userId: string | null | undefined,
  svc?: Pick<UserLlmProviderService, 'get'>,
): Promise<LlmProvider> {
  if (probe || !svc || !userId) return 'claude';
  return svc.get(userId);
}

/** Поля формы запроса к релею: проба — только Claude, выбор Qwen/Kimi — provider. */
export function relayProviderFields(probe: boolean, provider: LlmProvider): Record<string, string> {
  if (probe) return { noFallback: '1' };
  return provider === 'claude' ? {} : { provider };
}

/** Выбор для ClaudeCliService (Маша, TG): Claude — без поля. */
export function cliProviderOption(provider: LlmProvider): { provider?: FallbackProvider } {
  return provider === 'claude' ? {} : { provider };
}

/** Чем ответил релей — из события done (старый релей полей не шлёт). */
export function readDoneProvider(ev: any): { provider?: LlmProvider; fallback: boolean } {
  return { provider: isAnswerProvider(ev?.provider) ? ev.provider : undefined, fallback: ev?.fallback === true };
}
```

`src/chat/chat.service.ts`:
- импорт: `import { UserLlmProviderService } from '../common/services/user-llm-provider.service';` → `import { LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';`; `import { readDoneProvider, relayProviderFields, resolveAnswerProvider } from './answer-provider';` → `import { cliProviderOption, readDoneProvider, relayProviderFields, resolveAnswerProvider } from './answer-provider';`;
- Маша (около строки 1230): комментарий над `mashaProvider` — `// Модель ответов человека (админка): Qwen/Kimi — сразу выбранный, при его сбое — обычный путь; проба — только Claude.`; комментарий у `noFallback: probe` — `// Пинг мониторинга меряет путь Claude — без запасных.`; строку `...(mashaProvider === 'qwen' ? { provider: 'qwen' as const } : {}),` → `...cliProviderOption(mashaProvider),`;
- релей (около строки 1788): комментарий — `// Модель ответов человека: Qwen/Kimi — релей сразу идёт к выбранному; проба — только Claude.`; `let turnProvider: 'claude' | 'qwen' | undefined;` → `let turnProvider: LlmProvider | undefined;`;
- в `chat_quality.props` после `fallback: turnFallback || undefined,`:

```ts
            // Выбор человека (не Claude): «выбранный подвёл» — selected ≠ provider.
            selected: answerProvider === 'claude' ? undefined : answerProvider,
```

`src/chat/chat.controller.ts`: комментарий `// Выбор «Qwen» — релей сразу идёт в Qwen (answer-provider.ts).` → `// Выбор Qwen/Kimi — релей сразу идёт к выбранному (answer-provider.ts).`

`src/tg-bot/tg-router.service.ts`: `import { resolveAnswerProvider } from '../chat/answer-provider';` → `import { cliProviderOption, resolveAnswerProvider } from '../chat/answer-provider';`; `...(ownerProvider === 'qwen' ? { provider: 'qwen' as const } : {}),` → `...cliProviderOption(ownerProvider),`.

Проверка:

```bash
grep -rn "=== 'qwen'" src/chat src/tg-bot | grep -v '\.spec\.ts' || echo "литералов qwen нет"
```

Expected: `литералов qwen нет`.

- [ ] **Step 4: Прогон — зелёный** — «прогон бэка: src/chat src/tg-bot» и «tsc бэка». Expected: PASS (красные наборы — только те, что были красными в базе Task 0), `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git add src/chat/answer-provider.ts src/chat/answer-provider.spec.ts src/chat/chat.service.ts src/chat/chat.controller.ts src/tg-bot/tg-router.service.ts src/chat/chat.service.llm-provider.spec.ts src/chat/chat.upload-llm-provider.spec.ts src/tg-bot/tg-router.model.spec.ts
git commit -q -m "feat(chat): выбор Kimi у Маши, релея и TG-ботов; selected в chat_quality

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: мониторинг — счётчики по каждому запасному

**Files:**
- Modify: `src/monitoring/claude-health.service.ts`, `src/monitoring/claude-health.alert-line.spec.ts`
- Modify: `src/monitoring/relay-qwen-monitor.service.ts`, `src/monitoring/relay-qwen-monitor.service.spec.ts`

- [ ] **Step 1: Падающие тесты**

`src/monitoring/claude-health.alert-line.spec.ts` — заменить целиком:

```ts
import { fallbackAlertLine } from './claude-health.service';

describe('fallbackAlertLine — строка про запасных в алерте «Claude CLI недоступен»', () => {
  const p = (enabled: boolean, ok = 0, failed = 0) => ({ enabled, ok, failed, downUntil: 0 });

  it('ключей нет', () => {
    expect(fallbackAlertLine({ windowMs: 900_000, providers: { qwen: p(false), kimi: p(false) } }))
      .toBe('Запасные за 15 мин: Qwen — не настроен; Kimi — не настроен');
  });

  it('оба настроены — исходы по каждому', () => {
    expect(fallbackAlertLine({ windowMs: 900_000, providers: { qwen: p(true, 12, 1), kimi: p(true, 3, 0) } }))
      .toBe('Запасные за 15 мин: Qwen — ответов 12, ошибок 1; Kimi — ответов 3, ошибок 0');
  });

  it('окно берётся из статистики, а не зашито в строку', () => {
    expect(fallbackAlertLine({ windowMs: 600_000, providers: { qwen: p(true, 0, 3), kimi: p(false) } }))
      .toBe('Запасные за 10 мин: Qwen — ответов 0, ошибок 3; Kimi — не настроен');
  });

  it('без разбивки по провайдерам — «не настроен», без падения', () => {
    expect(fallbackAlertLine({ windowMs: 900_000 })).toBe('Запасные за 15 мин: Qwen — не настроен; Kimi — не настроен');
  });
});
```

`src/monitoring/relay-qwen-monitor.service.spec.ts` — заменить целиком:

```ts
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({ sendTelegramPayload: jest.fn(async () => undefined) }));
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { RelayQwenMonitorService, readRelayFallback, relayFallbackAlertText, relayFallbackVerdict } from './relay-qwen-monitor.service';

const get = (axios as any).get as jest.Mock;
const send = sendTelegramPayload as unknown as jest.Mock;
const NOW = 10_000_000;
/** Релей до выката Kimi: только поле qwen. */
const q = (o: any) => ({ status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0, ...o } });
/** Новый релей: поле fallback по всем запасным (и прежнее qwen рядом). */
const fb = (o: any = {}, qwen: any = {}, kimi: any = {}) => ({
  status: 'ok',
  fallback: {
    windowMs: 900000, breakerOpenUntil: 0, lastOpenedAt: 0, lastClaudeOkAt: 0, ...o,
    providers: {
      qwen: { enabled: true, ok: 0, failed: 0, downUntil: 0, ...qwen },
      kimi: { enabled: true, ok: 0, failed: 0, downUntil: 0, ...kimi },
    },
  },
  qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0, lastOpenedAt: 0, lastClaudeOkAt: 0 },
});
const text = (h: any) => relayFallbackAlertText(readRelayFallback(h)!);

describe('readRelayFallback', () => {
  it('новое поле fallback — оба запасных', () => {
    const r = readRelayFallback(fb({ lastOpenedAt: 5 }, { ok: 2 }, { failed: 1 }))!;
    expect(r.providers.qwen).toMatchObject({ enabled: true, ok: 2, failed: 0 });
    expect(r.providers.kimi).toMatchObject({ enabled: true, ok: 0, failed: 1 });
    expect(r.lastOpenedAt).toBe(5);
  });
  it('старый релей — только qwen', () => {
    const r = readRelayFallback(q({ ok: 3 }))!;
    expect(r.providers).toEqual({ qwen: { enabled: true, ok: 3, failed: 0 } });
    expect(r.lastClaudeOkAt).toBeUndefined();
  });
  it('fallback важнее прежнего qwen', () => {
    const h = { ...fb({}, {}, { ok: 4 }), qwen: { enabled: true, ok: 99, failed: 0, windowMs: 900000, breakerOpenUntil: 0 } };
    expect(readRelayFallback(h)!.providers.kimi!.ok).toBe(4);
    expect(readRelayFallback(h)!.providers.qwen!.ok).toBe(0);
  });
  it('нет ни того, ни другого — null', () => {
    expect(readRelayFallback({ status: 'ok' })).toBeNull();
    expect(readRelayFallback(null)).toBeNull();
  });
});

describe('relayFallbackVerdict', () => {
  it('старый релей без запасного пути или нет ответа — unknown', () => {
    expect(relayFallbackVerdict({ status: 'ok' }, NOW)).toBe('unknown');
    expect(relayFallbackVerdict(null, NOW)).toBe('unknown');
  });
  it('окно открыто — active', () => expect(relayFallbackVerdict(q({ breakerOpenUntil: NOW + 1 }), NOW)).toBe('active'));
  it('были аварийные ходы за окно — active', () => expect(relayFallbackVerdict(q({ ok: 2 }), NOW)).toBe('active'));
  it('только ошибки запасных — active', () => expect(relayFallbackVerdict(q({ ok: 0, failed: 2 }), NOW)).toBe('active'));
  it('тихо — idle', () => expect(relayFallbackVerdict(q({}), NOW)).toBe('idle'));
  it('окно истекло само, Claude после сбоя ни разу не ответил — active (без ложного отбоя)', () => {
    expect(relayFallbackVerdict(q({ breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: 0 }), NOW)).toBe('active');
  });
  it('Claude ответил после последнего открытия окна — idle', () => {
    expect(relayFallbackVerdict(q({ breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: NOW - 500_000 }), NOW)).toBe('idle');
  });
  it('рестарт релея (все нули, поле lastClaudeOkAt есть) — unknown, не idle', () => {
    expect(relayFallbackVerdict(q({ lastOpenedAt: 0, lastClaudeOkAt: 0 }), NOW)).toBe('unknown');
  });
  it('старый релей без поля lastClaudeOkAt, нули — idle, как раньше', () => {
    const health = { status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0 } };
    expect(relayFallbackVerdict(health, NOW)).toBe('idle');
  });
  it('новый релей: отвечал только Kimi — active', () => expect(relayFallbackVerdict(fb({}, {}, { ok: 1 }), NOW)).toBe('active'));
  it('новый релей: рестарт (всё по нулям) — unknown', () => expect(relayFallbackVerdict(fb(), NOW)).toBe('unknown'));
  it('новый релей: Claude ответил после сбоя — idle', () => {
    expect(relayFallbackVerdict(fb({ lastOpenedAt: NOW - 600_000, lastClaudeOkAt: NOW - 500_000 }), NOW)).toBe('idle');
  });
});

describe('relayFallbackAlertText', () => {
  it('счётчики по провайдерам и минуты окна; без обратных кавычек в HTML', () => {
    const t = text(fb({ breakerOpenUntil: NOW + 1 }, { failed: 2 }, { ok: 4 }));
    expect(t).toContain('ассистенты отвечают через запасные');
    expect(t).toContain('Qwen: ответов 0, ошибок 2 · Kimi: ответов 4, ошибок 0 за 15 мин');
    expect(t).toContain('<code>claude</code>');
    expect(t).not.toContain('`');
  });
  it('без ключа Kimi — «не настроен»', () => {
    expect(text(fb({}, { ok: 1 }, { enabled: false }))).toContain('Kimi: не настроен');
  });
  it('ответов ноль, ошибки есть — запасные тоже не отвечают', () => {
    const t = text(fb({}, { failed: 1 }, { failed: 2 }));
    expect(t).toContain('Claude недоступен, запасные тоже не отвечают');
    expect(t).not.toContain('отвечают через запасные');
  });
  it('старый релей — строка Qwen', () => {
    const t = text(q({ ok: 5, failed: 1 }));
    expect(t).toContain('Qwen: ответов 5, ошибок 1');
    expect(t).toContain('за 15 мин');
  });
  it('активность только по «Claude не отвечал с момента сбоя» — отдельный текст без счётчиков', () => {
    const t = text(q({ ok: 0, failed: 0, breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: 0 }));
    expect(t).toContain('Claude не отвечал с момента сбоя');
    expect(t).toContain('запасные за 15 мин не понадобились');
    expect(t).toContain('<code>claude</code>');
    expect(t).not.toContain('ответов');
  });
});

describe('RelayQwenMonitorService.check', () => {
  const OLD = { tok: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  let alerted: boolean;
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.startsWith('SELECT alerted')) return { rows: alerted ? [{ alerted: true }] : [] };
      alerted = params?.[1] === true;
      return { rows: [] };
    }),
  };
  beforeEach(() => {
    alerted = false; get.mockReset(); send.mockClear(); pg.query.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = 't'; process.env.TELEGRAM_CHAT_ID = 'c';
  });
  afterAll(() => { process.env.TELEGRAM_BOT_TOKEN = OLD.tok; process.env.TELEGRAM_CHAT_ID = OLD.chat; });

  it('active впервые — алерт и отметка', async () => {
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('active');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toContain('Релей: Claude недоступен');
    expect(alerted).toBe(true);
  });
  it('новый релей: active через Kimi — в алерте его счётчики', async () => {
    get.mockResolvedValue({ data: fb({}, {}, { ok: 3 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('active');
    expect(send.mock.calls[0][0].text).toContain('Kimi: ответов 3, ошибок 0');
  });
  it('active повторно — без повтора алерта', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    await new RelayQwenMonitorService(pg as any).check(NOW);
    expect(send).not.toHaveBeenCalled();
  });
  it('idle после алерта — отбой', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({}) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('idle');
    expect(send.mock.calls[0][0].text).toContain('Claude снова отвечает');
    expect(send.mock.calls[0][0].text).toContain('Запасные за последние 15 мин не понадобились');
    expect(alerted).toBe(false);
  });
  it('рестарт релея при висящем алерте — unknown, без ложного отбоя', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({ lastOpenedAt: 0, lastClaudeOkAt: 0 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
    expect(alerted).toBe(true);
  });
  it('/health недоступен — ничего не шлёт', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
  });
  // test.linkeon.io: AGENT_URL там указывает на боевой релей — без выключателя
  // test дублировал бы алерты прода.
  it('RELAY_QWEN_MONITOR=off — unknown без чтения /health и БД', async () => {
    process.env.RELAY_QWEN_MONITOR = 'off';
    try {
      expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
      expect(get).not.toHaveBeenCalled();
      expect(pg.query).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      delete process.env.RELAY_QWEN_MONITOR;
    }
  });
  it('сбой чтения monitor_alert_state — считать не алертили, не падать', async () => {
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    const brokenPg = { query: jest.fn(async () => { throw new Error('connection lost'); }) };
    await expect(new RelayQwenMonitorService(brokenPg as any).check(NOW)).resolves.toBe('active');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Прогон — падает** — «прогон бэка: src/monitoring/claude-health.alert-line.spec.ts src/monitoring/relay-qwen-monitor.service.spec.ts». Expected: FAIL (нет `fallbackAlertLine`, `readRelayFallback`).

- [ ] **Step 3: Реализация**

`src/monitoring/claude-health.service.ts`:
- после строки `import { classifyLlmError, LlmOutageKind, looksLikeCliRefusal } from '../common/llm-error';` добавить `import { FALLBACK_ORDER, FallbackProvider, PROVIDER_LABELS } from '../common/services/llm-fallback';`; комментарий над импортом: `(запасной путь на Qwen)` → `(запасной путь)`;
- функцию `qwenFallbackAlertLine` с её комментарием заменить на:

```ts
/** Строка про запасных в алерте «Локальный Claude CLI недоступен»: видно,
 *  обслуживаются ли люди, пока вход не починен, и не лежат ли сами запасные.
 *  Без склонений — счётчики после тире. */
export function fallbackAlertLine(s: {
  windowMs: number;
  providers?: Partial<Record<FallbackProvider, { enabled: boolean; ok: number; failed: number }>>;
}): string {
  const parts = FALLBACK_ORDER.map((n) => {
    const p = s.providers?.[n];
    return p?.enabled ? `${PROVIDER_LABELS[n]} — ответов ${p.ok}, ошибок ${p.failed}` : `${PROVIDER_LABELS[n]} — не настроен`;
  });
  return `Запасные за ${Math.round(s.windowMs / 60_000)} мин: ${parts.join('; ')}`;
}
```

- в тексте алерта: `${qwenFallbackAlertLine(this.claudeCli.fallbackStats())}\n` → `${fallbackAlertLine(this.claudeCli.fallbackStats())}\n`.

`src/monitoring/relay-qwen-monitor.service.ts` — всё от начала файла до `const COMPONENT = 'relay_qwen_fallback';` (импорты, `RelayQwenHealth`, `relayFallbackVerdict`, `relayFallbackAlertText`) заменить на:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { sendTelegramPayload } from '../common/telegram-alert';
import { FALLBACK_ORDER, FallbackProvider, PROVIDER_LABELS } from '../common/services/llm-fallback';

/** Запасной провайдер в /health релея. */
export interface RelayProviderHealth {
  enabled: boolean;
  ok: number;
  failed: number;
  downUntil?: number;
}

/**
 * Запасной путь релея из /health: поле fallback (relay-agent/llm-fallback.mjs,
 * stats()), а у релея до выката Kimi — прежнее поле qwen (только Qwen).
 */
export interface RelayFallbackHealth {
  windowMs: number;
  /** Окно Claude открыто до (0 — закрыто; релей сам обнуляет истёкшее). */
  breakerOpenUntil: number;
  /** Когда окно Claude открывалось последний раз (0 — никогда). */
  lastOpenedAt: number;
  /** Когда Claude последний раз ответил; undefined — релей поле не отдаёт (старый). */
  lastClaudeOkAt?: number;
  providers: Partial<Record<FallbackProvider, RelayProviderHealth>>;
}

const num = (v: unknown): number => Number(v) || 0;

/** null — в /health нет ни fallback, ни qwen (релей без запасного пути или не ответил). */
export function readRelayFallback(health: any): RelayFallbackHealth | null {
  const fb = health?.fallback;
  if (fb && typeof fb === 'object') {
    const providers: Partial<Record<FallbackProvider, RelayProviderHealth>> = {};
    for (const n of FALLBACK_ORDER) {
      const p = fb.providers?.[n];
      if (p && typeof p === 'object') {
        providers[n] = { enabled: p.enabled === true, ok: num(p.ok), failed: num(p.failed), downUntil: num(p.downUntil) };
      }
    }
    return {
      windowMs: num(fb.windowMs) || 900_000,
      breakerOpenUntil: num(fb.breakerOpenUntil),
      lastOpenedAt: num(fb.lastOpenedAt),
      lastClaudeOkAt: 'lastClaudeOkAt' in fb ? num(fb.lastClaudeOkAt) : undefined,
      providers,
    };
  }
  const qw = health?.qwen;
  if (qw && typeof qw === 'object') {
    return {
      windowMs: num(qw.windowMs) || 900_000,
      breakerOpenUntil: num(qw.breakerOpenUntil),
      lastOpenedAt: num(qw.lastOpenedAt),
      lastClaudeOkAt: 'lastClaudeOkAt' in qw ? num(qw.lastClaudeOkAt) : undefined,
      providers: { qwen: { enabled: qw.enabled === true, ok: num(qw.ok), failed: num(qw.failed) } },
    };
  }
  return null;
}

function totals(fb: RelayFallbackHealth): { ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  for (const n of FALLBACK_ORDER) {
    ok += fb.providers[n]?.ok ?? 0;
    failed += fb.providers[n]?.failed ?? 0;
  }
  return { ok, failed };
}

/**
 * active — релей сейчас отвечает через запасных (окно Claude открыто, или были
 * аварийные ходы за окно статистики, или Claude с момента последнего сбоя ни
 * разу не ответил); idle — нет; unknown — /health не ответил или в нём нет
 * запасного пути. Ходы по выбору пользователя релей в эти счётчики не пишет.
 *
 * breakerOpenUntil сравнивается с нулём, а не с часами бэкенда: окно на релее
 * закрывается само через 5 мин, и релей сам обнуляет поле, когда оно истекло.
 * Сверка с часами бэкенда давала ложный отбой: окно истекало раньше, чем Claude
 * успевал ответить хотя бы раз (редкие ходы ночью) — третье условие
 * (lastOpenedAt/lastClaudeOkAt) ловит именно этот случай.
 */
export function relayFallbackVerdict(health: any, _now: number = Date.now()): 'active' | 'idle' | 'unknown' {
  const fb = readRelayFallback(health);
  if (!fb) return 'unknown';
  const { ok, failed } = totals(fb);
  if (fb.breakerOpenUntil > 0) return 'active';
  if (ok + failed > 0) return 'active';
  // Состояние в памяти релея пустое и сразу после рестарта процесса — тот же
  // набор нулей, что у «окно никогда не открывалось»: отличить нельзя. От
  // старого релея (поля lastClaudeOkAt нет вовсе) — только по наличию поля.
  if (fb.lastClaudeOkAt !== undefined && fb.lastOpenedAt === 0 && fb.lastClaudeOkAt === 0) return 'unknown';
  if (fb.lastOpenedAt > 0 && !((fb.lastClaudeOkAt ?? 0) >= fb.lastOpenedAt)) return 'active';
  return 'idle';
}

/** «Qwen: ответов N, ошибок M · Kimi: не настроен». */
function providersLine(fb: RelayFallbackHealth): string {
  return FALLBACK_ORDER.map((n) => {
    const p = fb.providers[n];
    return p?.enabled ? `${PROVIDER_LABELS[n]}: ответов ${p.ok}, ошибок ${p.failed}` : `${PROVIDER_LABELS[n]}: не настроен`;
  }).join(' · ');
}

export function relayFallbackAlertText(fb: RelayFallbackHealth): string {
  const mins = Math.round(fb.windowMs / 60_000);
  // <code>, не обратные кавычки: Telegram в parse_mode: 'HTML' их не раскрывает.
  const fixLine = 'Починка: на релее <code>claude</code> → /login, либо ждать сброса лимита подписки.';
  const { ok, failed } = totals(fb);
  // Активность только по «Claude молчит с момента сбоя»: ходов не было ни на
  // Claude, ни на запасных, окно само истекло — счётчики были бы шумом.
  if (ok === 0 && failed === 0 && fb.breakerOpenUntil === 0 && fb.lastOpenedAt > 0 && !((fb.lastClaudeOkAt ?? 0) >= fb.lastOpenedAt)) {
    return `<b>🟠 Релей: Claude не отвечал с момента сбоя — запасные за ${mins} мин не понадобились</b>\n${fixLine}`;
  }
  // Ответов ноль, ошибки есть: молчат все пути — «отвечают через запасные» было бы неправдой.
  const allDown = ok === 0 && failed > 0;
  const title = allDown
    ? '🔴 Релей: Claude недоступен, запасные тоже не отвечают'
    : '🟠 Релей: Claude недоступен — ассистенты отвечают через запасные';
  return `<b>${title}</b>\n${providersLine(fb)} за ${mins} мин.\n${fixLine}`;
}
```

В том же файле: комментарий класса — `Запасные на релее не должны прятать сбой Claude: раз в 15 минут читаем /health релея и шлём алерт в начале аварийного режима и отбой в конце (spec 2026-10-30-llm-provider-switch, 2026-10-31-kimi-provider-design). Антиповтор — та же таблица monitor_alert_state, что у алерта CLI; имена компонента и выключателя прежние.`; в `check`:

```ts
    if (verdict === 'active' && !alerted) {
      await this.send(relayFallbackAlertText(readRelayFallback(health)!));
      await this.setAlerted(true);
      this.log.error('relay: Claude недоступен, ходы идут через запасных — алерт отправлен');
    } else if (verdict === 'idle' && alerted) {
      await this.send('<b>🟢 Релей: Claude снова отвечает</b>\nЗапасные за последние 15 мин не понадобились.');
      await this.setAlerted(false);
      this.log.warn('relay: запасные больше не нужны — отбой отправлен');
    }
```

и в `send`: `relay qwen alert (no Telegram creds)` → `relay fallback alert (no Telegram creds)`, `relay qwen Telegram alert failed` → `relay fallback Telegram alert failed`.

- [ ] **Step 4: Прогон — зелёный** — «прогон бэка: src/monitoring» и «tsc бэка». Expected: PASS (красные — только базовые из Task 0), `TSC_OK`.

- [ ] **Step 5: Коммит**

```bash
git add src/monitoring/claude-health.service.ts src/monitoring/claude-health.alert-line.spec.ts src/monitoring/relay-qwen-monitor.service.ts src/monitoring/relay-qwen-monitor.service.spec.ts
git commit -q -m "feat(monitoring): счётчики по каждому запасному — в алерте CLI и мониторе релея (/health.fallback)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: живая проверка бэкенда на Linux

**Files:**
- Create: `scripts/llm-fallback-check.js`
- Delete: `scripts/qwen-fallback-check.js`

- [ ] **Step 1: Скрипт** — `scripts/llm-fallback-check.js`:

```js
#!/usr/bin/env node
// Живая проверка цепочки запасных ClaudeCliService (Qwen → Kimi) и выбора
// Kimi: настоящий claude, настоящие провайдеры, без выката. Запуск — из корня
// собранного клона (npm run build), ключи — только из env, скрипт их не печатает:
//   read -r KIMI_FALLBACK_API_KEY; read -r QWEN_FALLBACK_API_KEY; export KIMI_FALLBACK_API_KEY QWEN_FALLBACK_API_KEY
//   node scripts/llm-fallback-check.js
// QWEN_FALLBACK_API_KEY необязателен: без него проверки «через Qwen» пропускаются.
// Claude «ломается» пустым CLAUDE_CONFIG_DIR (вход не найден → auth); боевые
// креды не трогаются.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

if (!process.env.KIMI_FALLBACK_API_KEY) {
  console.error('нет KIMI_FALLBACK_API_KEY');
  process.exit(2);
}
const HAS_QWEN = !!process.env.QWEN_FALLBACK_API_KEY;
// Чужие креды из окружения: с ними Claude мог бы пройти, и проверка шла бы
// мимо цепочки. Снимаем до первого запуска.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete process.env[k];
}
// Без окон: каждая проверка идёт путём «Claude упал → цепочка», а «не отвечает»
// одной проверки не переносится на следующую.
process.env.LLM_FALLBACK_BREAKER_MS = '0';
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-cfg-'));
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

/** Ключи на время одной проверки: undefined — снять. */
async function withKeys(keys, fn) {
  const saved = {};
  for (const k of Object.keys(keys)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// --- Крошечный PNG-энкодер без внешних зависимостей (только zlib + Buffer) ---
// CRC32 считаем сами (не зависим от того, есть ли zlib.crc32 в этой версии Node).
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
/** Однотонный красный PNG size×size, 8-бит RGB, без палитры и без фильтрации строк. */
function makeRedPng(size = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: RGB
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace
  const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB pixels
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = 255; // R
    row[1 + x * 3 + 1] = 0; // G
    row[1 + x * 3 + 2] = 0; // B
  }
  const raw = Buffer.concat(new Array(size).fill(row));
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const svc = new ClaudeCliService();
  const results = [];
  const counts = () => {
    const p = svc.fallbackStats().providers;
    return { qwenOk: p.qwen.ok, qwenFailed: p.qwen.failed, kimiOk: p.kimi.ok, kimiFailed: p.kimi.failed };
  };
  /** grow — счётчики, которые обязаны вырасти ровно на 1 (остальные — не меняться);
   *  soft — сбой только в сведения, на итог не влияет. */
  const check = async (name, grow, fn, soft = false) => {
    const t0 = Date.now();
    const before = counts();
    try {
      const detail = await fn();
      const after = counts();
      for (const k of Object.keys(before)) {
        const want = grow.includes(k) ? 1 : 0;
        if (after[k] - before[k] !== want) throw new Error(`${k}: +${after[k] - before[k]}, ожидалось +${want}: ${detail}`);
      }
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
    } catch (e) {
      results.push({ name, ok: false, soft, ms: Date.now() - t0, detail: String((e && e.message) || e).slice(0, 300) });
    }
  };
  const NO_QWEN = { QWEN_FALLBACK_API_KEY: undefined };
  const ASK = 'Ответь одним словом: ок';

  try {
    await check('Qwen выключен: json, haiku-класс → Kimi', ['kimiOk'], () => withKeys(NO_QWEN, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 120000 });
      return `«${r.text}», $${r.costUsd}`;
    }));

    await check('Qwen выключен: stream-json + Read в своём cwd → Kimi', ['kimiOk'], () => withKeys(NO_QWEN, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-cwd-'));
      try {
        fs.writeFileSync(path.join(dir, 'note.txt'), 'Кодовое слово: черёмуха-47\n');
        const tools = [];
        const r = await svc.textWithCost('Прочитай файл note.txt инструментом Read и назови кодовое слово. Ответь только словом.', {
          model: 'claude-opus-5-5', cwd: dir, tools: 'Read', timeoutMs: 180000,
          onProgress: (e) => tools.push(e.name),
        });
        if (!/черёмуха-47/.test(r.text)) throw new Error(`не то слово: ${r.text}`);
        return `«${r.text}», инструменты: ${tools.join(',') || '—'}`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }));

    await check('сведения: вложение-картинка → Kimi (умеет ли Kimi картинки)', ['kimiOk'], () => withKeys(NO_QWEN, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-check-img-'));
      const imgPath = path.join(dir, 'red.png');
      try {
        fs.writeFileSync(imgPath, makeRedPng());
        const r = await svc.textWithCost('Какого цвета картинка во вложении? Ответь одним словом.', {
          model: 'claude-opus-5-5', attachments: [imgPath], onProgress: () => {}, timeoutMs: 180000,
        });
        if (!/красн|red/i.test(r.text)) throw new Error(`не то: ${r.text}`);
        return `«${r.text}»`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }), true);

    await check('выбран Kimi → ответ без аварийного счёта', [], () => withKeys(NO_QWEN, async () => {
      const r = await svc.textWithCost(ASK, { model: 'claude-opus-5-5', provider: 'kimi', timeoutMs: 120000 });
      if (!r.text.trim()) throw new Error('пустой ответ');
      return `«${r.text}» (Claude сломан — ответить мог только Kimi)`;
    }));

    await check('выбран Kimi с битым ключом → попытка Claude, ошибка цепочки', [], () =>
      withKeys({ ...NO_QWEN, KIMI_FALLBACK_API_KEY: 'sk-broken-check' }, async () => {
        let text;
        try {
          text = await svc.text(ASK, { model: 'claude-haiku-4-5', provider: 'kimi', timeoutMs: 120000 });
        } catch (e) {
          const m = String(e.message);
          if (!/^kimi \(выбран\): .* \| claude fallback: /.test(m)) throw new Error(`не та ошибка: ${m.slice(0, 200)}`);
          return 'ошибка начинается с выбранного, Claude пробовался';
        }
        throw new Error(`ответ пришёл, а не должен был: ${String(text).slice(0, 80)}`);
      }));

    if (HAS_QWEN) {
      await check('Claude → Qwen', ['qwenOk'], async () => {
        const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 120000 });
        return `«${r.text}»`;
      });
      await check('Claude → Qwen (битый ключ) → Kimi', ['qwenFailed', 'kimiOk'], () =>
        withKeys({ QWEN_FALLBACK_API_KEY: 'sk-broken-check' }, async () => {
          const r = await svc.textWithCost(ASK, { model: 'claude-haiku-4-5', timeoutMs: 180000 });
          return `«${r.text}»`;
        }));
    } else {
      results.push({ name: 'проверки через Qwen', ok: true, ms: 0, detail: 'пропущены: нет QWEN_FALLBACK_API_KEY' });
    }

    await check('noFallback (проба живости) обязана упасть на Claude', [], async () => {
      let text;
      try {
        text = await svc.text('Reply with exactly: ok', { model: 'claude-haiku-4-5', timeoutMs: 60000, noFallback: true });
      } catch (e) {
        return `упала, как и должна: ${String(e.message).slice(0, 100)}`;
      }
      throw new Error(`проба прошла — значит, пошла мимо Claude: ${String(text).slice(0, 100)}`);
    });
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  for (const r of results) console.log(`${r.ok ? 'OK  ' : r.soft ? 'INFO' : 'FAIL'} ${r.name} (${r.ms} мс): ${r.detail}`);
  console.log('fallbackStats:', JSON.stringify(svc.fallbackStats()));
  process.exit(results.every((r) => r.ok || r.soft) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

```bash
git rm -q scripts/qwen-fallback-check.js
node --check scripts/llm-fallback-check.js && echo CHECK_OK
```

- [ ] **Step 2: Коммит и прогон на ноде** (Linux; ключи — через stdin, не в argv)

```bash
git add scripts/llm-fallback-check.js scripts/qwen-fallback-check.js
git commit -q -m "chore: живая проверка цепочки запасных и выбора Kimi (scripts/llm-fallback-check.js)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q && SHA=$(git rev-parse HEAD)
python3 - <<'EOF' | ssh dv@85.192.61.231 "cd ~/ci/wt/kimi-back && git fetch -q origin && git checkout -q --detach ${SHA} && read -r KIMI_FALLBACK_API_KEY && read -r QWEN_FALLBACK_API_KEY && export KIMI_FALLBACK_API_KEY QWEN_FALLBACK_API_KEY && source ~/.nvm/nvm.sh && npm run build </dev/null >/dev/null 2>&1 && node scripts/llm-fallback-check.js </dev/null"
import json, os
print(open(os.path.expanduser('~/.linkeon/kimi.key')).read().strip())
print(json.load(open(os.path.expanduser('~/.qwen/settings.json')))['security']['auth']['apiKey'])
EOF
```

Expected: все строки `OK` (строка «сведения: картинка» — `OK` или `INFO`; `INFO` записать в отчёт и память: Kimi не берёт картинки — тогда фото от TG-бота при сбое Claude и Qwen не обработаются), код выхода 0. `FAIL` — стоп: разбор, правка, повтор Step 2.

---

### Task 8: релей — модуль `llm-fallback.mjs`

**Files:**
- Create: `relay-agent/llm-fallback.mjs`
- Test: `relay-agent/llm-fallback.test.mjs`

`qwen-provider.mjs` пока остаётся (его импортирует `server.mjs`) — снимается врезкой в Task 9.

- [ ] **Step 1: Падающий тест** — `relay-agent/llm-fallback.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as l from "./llm-fallback.mjs";

const QWEN_MODELS = { opus: "qwen3.8-max", sonnet: "qwen3.8-flash", haiku: "qwen3.6-flash" };
const KIMI_MODELS = { opus: "k3.1-pro", sonnet: "k3.1-pro", haiku: "k3.1-pro" };
const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

test("readProviderConfig: нет файла, пустой файл, чужое имя — null", () => {
  assert.equal(l.readProviderConfig("kimi", {}, missing), null);
  assert.equal(l.readProviderConfig("qwen", {}, () => "  \n"), null);
  assert.equal(l.readProviderConfig("gpt", {}, () => "k"), null);
});

test("readProviderConfig: Qwen — значения и путь ключа по умолчанию", () => {
  let asked;
  const cfg = l.readProviderConfig("qwen", {}, (p) => { asked = p; return " sk-sp-x \n"; });
  assert.equal(asked, "/home/dv/file-agent/secrets/qwen.key");
  assert.deepEqual(cfg, { name: "qwen", apiKey: "sk-sp-x", baseUrl: l.PROVIDER_DEFAULTS.qwen.baseUrl, models: QWEN_MODELS });
});

test("readProviderConfig: Kimi — адрес Kimi Code, k3.1-pro, ключ secrets/kimi.key", () => {
  let asked;
  const cfg = l.readProviderConfig("kimi", {}, (p) => { asked = p; return "sk-kimi-x"; });
  assert.equal(asked, "/home/dv/file-agent/secrets/kimi.key");
  assert.deepEqual(cfg, { name: "kimi", apiKey: "sk-kimi-x", baseUrl: "https://api.kimi.ai/coding", models: KIMI_MODELS });
});

test("readProviderConfig: путь и переопределения из env — у каждого свои", () => {
  let asked;
  const env = { KIMI_KEY_FILE: "/k", KIMI_FALLBACK_BASE_URL: "https://x/coding", KIMI_FALLBACK_MODEL_OPUS: "k3", QWEN_FALLBACK_MODEL_OPUS: "q" };
  const cfg = l.readProviderConfig("kimi", env, (p) => { asked = p; return "k"; });
  assert.equal(asked, "/k");
  assert.equal(cfg.baseUrl, "https://x/coding");
  assert.equal(cfg.models.opus, "k3");
  assert.equal(cfg.models.haiku, "k3.1-pro");
});

test("readProviderConfigs и anyConfigured", () => {
  const cfgs = l.readProviderConfigs({}, (p) => (p.endsWith("kimi.key") ? "k" : missing()));
  assert.equal(cfgs.qwen, null);
  assert.equal(cfgs.kimi.name, "kimi");
  assert.equal(l.anyConfigured(cfgs), true);
  assert.equal(l.anyConfigured(l.NO_CONFIGS), false);
});

test("readBreakerMs: новое имя, прежнее, кривое, 0", () => {
  assert.equal(l.readBreakerMs({}), 300000);
  assert.equal(l.readBreakerMs({ LLM_FALLBACK_BREAKER_MS: "60000" }), 60000);
  assert.equal(l.readBreakerMs({ QWEN_FALLBACK_BREAKER_MS: "30000" }), 30000);
  assert.equal(l.readBreakerMs({ LLM_FALLBACK_BREAKER_MS: "1000", QWEN_FALLBACK_BREAKER_MS: "2000" }), 1000);
  assert.equal(l.readBreakerMs({ LLM_FALLBACK_BREAKER_MS: "abc" }), 300000);
  assert.equal(l.readBreakerMs({ LLM_FALLBACK_BREAKER_MS: "0" }), 0);
});

test("parseSelected и isEmergency", () => {
  assert.equal(l.parseSelected("kimi"), "kimi");
  assert.equal(l.parseSelected(" qwen "), "qwen");
  for (const v of ["claude", "gpt", "", undefined, null]) assert.equal(l.parseSelected(v), "");
  assert.equal(l.isEmergency("claude", ""), false);
  assert.equal(l.isEmergency("qwen", ""), true);
  assert.equal(l.isEmergency("kimi", "kimi"), false);
  assert.equal(l.isEmergency("qwen", "kimi"), true);
});

test("modelFor", () => {
  for (const [req, want] of [["default", "qwen3.8-max"], ["claude-opus-5-5", "qwen3.8-max"],
    ["sonnet", "qwen3.8-flash"], ["Claude-Haiku-4-5", "qwen3.6-flash"]]) {
    assert.equal(l.modelFor(req, QWEN_MODELS), want, req);
  }
  for (const req of ["default", "sonnet", "haiku"]) assert.equal(l.modelFor(req, KIMI_MODELS), "k3.1-pro");
});

test("withModel: меняет только значение --model, исходный массив цел", () => {
  const args = ["--print", "--model", "default", "--max-turns", "40"];
  assert.deepEqual(l.withModel(args, "k3.1-pro"), ["--print", "--model", "k3.1-pro", "--max-turns", "40"]);
  assert.equal(args[2], "default");
});

test("providerSpawnEnv: снимает ANTHROPIC_* и OAuth-токен, ставит адрес и ключ провайдера, SCRUB=0", () => {
  const cfg = l.readProviderConfig("kimi", {}, () => "sk-kimi-x");
  const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "old", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
  const env = l.providerSpawnEnv(base, cfg);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.kimi.ai/coding");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-kimi-x");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "k3.1-pro");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "k3.1-pro");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.API_TIMEOUT_MS, "300000");
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "0");
  assert.equal(base.ANTHROPIC_API_KEY, "old");
});

test("looksLikeCliRefusal", () => {
  for (const t of ["Not logged in · Please run /login", "You've hit your session limit · resets 3am (UTC)",
    "You’ve hit your limit · resets 3am", "Claude AI usage limit reached|1730000000", "OAuth token has expired"]) {
    assert.equal(l.looksLikeCliRefusal(t), true, t);
  }
  for (const t of ["Это значит, что ключ неверный: Invalid API key", "Invalid API key — так ответил сервис",
    "Ответ: hit your usage limit", "x".repeat(301) + " Not logged in", ""]) {
    assert.equal(l.looksLikeCliRefusal(t), false, t.slice(0, 40));
  }
});

test("isAccessFailure", () => {
  assert.equal(l.isAccessFailure("Not logged in · Please run /login"), true);
  assert.equal(l.isAccessFailure("API Error: 429 Too Many Requests", { isError: true }), true);
  assert.equal(l.isAccessFailure("boom", { isError: true, apiStatus: 529 }), true);
  assert.equal(l.isAccessFailure("API Error: 401 Unauthorized", { isError: true }), true);
  assert.equal(l.isAccessFailure("API Error: 429", { isError: false }), false);
  assert.equal(l.isAccessFailure("Prompt is too long: 250000 tokens", { isError: true, apiStatus: 400 }), false);
  assert.equal(l.isAccessFailure("Context window exceeded · try again", { isError: true }), false);
  assert.equal(l.isAccessFailure("обычный ответ ассистента"), false);
});

test("isAccessFailure: статус 429/529/401/403 — раньше признаков длины контекста", () => {
  const perMinute = "API Error: 429 This request would exceed the rate limit of 400,000 output tokens per minute";
  assert.equal(l.isAccessFailure(perMinute, { isError: true, apiStatus: 429 }), true);
  assert.equal(l.isAccessFailure("overloaded: context window busy", { isError: true, apiStatus: 529 }), true);
  assert.equal(l.isAccessFailure(perMinute, { isError: true }), false);
  assert.equal(l.isAccessFailure(perMinute, { isError: false, apiStatus: 429 }), false);
});

test("planProviders", () => {
  const cfg = (name) => ({ name, apiKey: "k", baseUrl: "u", models: KIMI_MODELS });
  const both = { qwen: cfg("qwen"), kimi: cfg("kimi") };
  const T = 10_000;
  const fresh = () => l.createFallbackState();
  assert.deepEqual(l.planProviders({ cfgs: both, state: fresh(), noFallback: true, selected: "kimi", now: T }), ["claude"]);
  assert.deepEqual(l.planProviders({ cfgs: both, state: fresh(), now: T }), ["claude", "qwen", "kimi"]);
  assert.deepEqual(l.planProviders({ cfgs: { qwen: null, kimi: cfg("kimi") }, state: fresh(), now: T }), ["claude", "kimi"]);
  assert.deepEqual(l.planProviders({ cfgs: l.NO_CONFIGS, state: fresh(), now: T }), ["claude"]);
  const open = fresh();
  open.openClaudeWindow(60_000, T);
  assert.deepEqual(l.planProviders({ cfgs: both, state: open, now: T + 1 }), ["qwen", "kimi"]);
  assert.deepEqual(l.planProviders({ selected: "kimi", cfgs: both, state: open, now: T + 1 }), ["kimi", "qwen"]);
  const qDown = fresh();
  qDown.markDown("qwen", 60_000, T);
  assert.deepEqual(l.planProviders({ cfgs: both, state: qDown, now: T + 1 }), ["claude", "kimi"]);
  const allDown = fresh();
  allDown.openClaudeWindow(60_000, T);
  allDown.markDown("qwen", 60_000, T);
  allDown.markDown("kimi", 60_000, T);
  assert.deepEqual(l.planProviders({ cfgs: both, state: allDown, now: T + 1 }), ["claude"]);
  const kDown = fresh();
  kDown.markDown("kimi", 60_000, T);
  assert.deepEqual(l.planProviders({ selected: "kimi", cfgs: both, state: kDown, now: T + 1 }), ["kimi", "claude", "qwen"]);
  assert.deepEqual(l.planProviders({ selected: "kimi", cfgs: { qwen: cfg("qwen"), kimi: null }, state: fresh(), now: T }), ["claude", "qwen"]);
});

test("nextStep: следующий в плане; запасной, ставший «не отвечает», пропускается; Claude — нет", () => {
  const s = l.createFallbackState();
  const plan = ["claude", "qwen", "kimi"];
  assert.equal(l.nextStep(plan, 0, s, 1000), 1);
  s.markDown("qwen", 60_000, 1000);
  assert.equal(l.nextStep(plan, 0, s, 2000), 2);
  assert.equal(l.nextStep(plan, 2, s, 2000), -1);
  assert.equal(l.nextStep(["kimi", "claude"], 0, s, 2000), 1);
});

test("mayAdvance: выбранный — любой сбой; остальные — сбой доступа; не после текста и инструментов", () => {
  const base = { failed: "claude", selected: "", accessFailure: true, sentAnyText: false, riskyToolUsed: false };
  assert.equal(l.mayAdvance(base), true);
  assert.equal(l.mayAdvance({ ...base, accessFailure: false }), false);
  assert.equal(l.mayAdvance({ ...base, failed: "kimi", selected: "kimi", accessFailure: false }), true);
  assert.equal(l.mayAdvance({ ...base, sentAnyText: true }), false);
  assert.equal(l.mayAdvance({ ...base, riskyToolUsed: true }), false);
  assert.equal(l.mayAdvance({ ...base, failed: "kimi", selected: "kimi", riskyToolUsed: true }), false);
});

test("SIDE_EFFECT_FREE_TOOLS", () => {
  for (const t of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]) assert.equal(l.SIDE_EFFECT_FREE_TOOLS.has(t), true);
  for (const t of ["Bash", "Write", "mcp__linkeon__generate_image", "mcp__products__manage_product"]) assert.equal(l.SIDE_EFFECT_FREE_TOOLS.has(t), false);
});

test("createFallbackState: окно Claude, lastOpenedAt/lastClaudeOkAt", () => {
  const s = l.createFallbackState();
  assert.equal(s.claudeWindowOpen(1000), false);
  s.openClaudeWindow(60000, 1000);
  assert.equal(s.claudeWindowOpen(2000), true);
  s.claudeSucceeded(500); // начат до открытия — окно не закрывает
  assert.equal(s.claudeWindowOpen(2000), true);
  assert.equal(s.stats(l.NO_CONFIGS, 2000).lastClaudeOkAt, 500);
  s.claudeSucceeded(1500); // после — закрывает
  assert.equal(s.claudeWindowOpen(2200), false);
  s.openClaudeWindow(60000, 3000);
  assert.equal(s.stats(l.NO_CONFIGS, 3000).lastOpenedAt, 3000);
  assert.equal(s.stats(l.NO_CONFIGS, 3000).breakerOpenUntil, 63000);
  s.closeClaudeWindow();
  assert.equal(s.claudeWindowOpen(3001), false);
  assert.equal(s.stats(l.NO_CONFIGS, 3001).breakerOpenUntil, 0);
});

test("createFallbackState: lastClaudeOkAt — по началу хода, не по завершению", () => {
  const s = l.createFallbackState();
  s.openClaudeWindow(60000, 1000);
  s.claudeSucceeded(900); // ход начат до сбоя, кончился успехом после — не доказательство
  const { lastClaudeOkAt, lastOpenedAt } = s.stats(l.NO_CONFIGS, 5000);
  assert.ok(lastClaudeOkAt < lastOpenedAt, `${lastClaudeOkAt} not < ${lastOpenedAt}`);
  assert.equal(s.claudeWindowOpen(5000), true);
});

test("createFallbackState: «не отвечает» и исходы по провайдерам; stats и legacyQwenHealth", () => {
  const s = l.createFallbackState();
  const cfgs = { qwen: { name: "qwen" }, kimi: null };
  s.markDown("qwen", 60_000, 1000);
  s.recordOutcome("qwen", false, 1000);
  s.recordOutcome("kimi", true, 2000);
  const st = s.stats(cfgs, 3000);
  assert.deepEqual(st.providers, {
    qwen: { enabled: true, ok: 0, failed: 1, downUntil: 61_000 },
    kimi: { enabled: false, ok: 1, failed: 0, downUntil: 0 },
  });
  assert.equal(st.windowMs, l.STATS_WINDOW_MS);
  assert.deepEqual(l.legacyQwenHealth(st), {
    enabled: true, ok: 0, failed: 1, windowMs: l.STATS_WINDOW_MS, breakerOpenUntil: 0, lastOpenedAt: 0, lastClaudeOkAt: 0,
  });
  s.markUp("qwen");
  assert.equal(s.isDown("qwen", 3000), false);
  assert.deepEqual(s.stats(cfgs, 2000 + l.STATS_WINDOW_MS + 1).providers.kimi, { enabled: false, ok: 0, failed: 0, downUntil: 0 });
});
```

- [ ] **Step 2: Прогон — падает** — «прогон релея». Expected: `llm-fallback.test.mjs` FAIL (`Cannot find module`), остальные — как в базе.

- [ ] **Step 3: Реализация** — `relay-agent/llm-fallback.mjs`:

```js
// Запасные провайдеры на релее: выбор пользователя (provider=qwen|kimi из
// админки бэкенда) и аварийная цепочка Claude → Qwen → Kimi. Тот же claude и те
// же аргументы — другие модель и окружение процесса. Спецификация — spirits_back
// docs/superpowers/specs/2026-10-31-kimi-provider-design.md. Те же правила, что
// у бэкенда (src/common/services/llm-fallback.ts, src/common/llm-error.ts):
// меняешь здесь — сверь там.
import fs from "node:fs";

export const FALLBACK_ORDER = Object.freeze(["qwen", "kimi"]);
export const PROVIDER_LABELS = Object.freeze({ claude: "Claude", qwen: "Qwen", kimi: "Kimi" });
// Ключ — файлом (600): читается на каждом ходе, сменить можно без рестарта;
// нет файла — провайдер на релее выключен целиком.
export const PROVIDER_DEFAULTS = Object.freeze({
  qwen: Object.freeze({
    envPrefix: "QWEN",
    keyFile: "/home/dv/file-agent/secrets/qwen.key",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    models: Object.freeze({ opus: "qwen3.8-max", sonnet: "qwen3.8-flash", haiku: "qwen3.6-flash" }),
  }),
  kimi: Object.freeze({
    envPrefix: "KIMI",
    keyFile: "/home/dv/file-agent/secrets/kimi.key",
    baseUrl: "https://api.kimi.ai/coding",
    models: Object.freeze({ opus: "k3.1-pro", sonnet: "k3.1-pro", haiku: "k3.1-pro" }),
  }),
});
export const NO_CONFIGS = Object.freeze({ qwen: null, kimi: null });
export const DEFAULT_BREAKER_MS = 5 * 60_000;
export const STATS_WINDOW_MS = 15 * 60_000;
// После этих инструментов ход можно переиграть у другого провайдера: последствий нет.
export const SIDE_EFFECT_FREE_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

const trimmed = (v) => (v ?? "").toString().trim();

// Длина окон: LLM_FALLBACK_BREAKER_MS; прежнее QWEN_FALLBACK_BREAKER_MS — если нового нет.
export function readBreakerMs(env = process.env) {
  const raw = trimmed(env.LLM_FALLBACK_BREAKER_MS) || trimmed(env.QWEN_FALLBACK_BREAKER_MS);
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_BREAKER_MS;
}

export function readProviderConfig(name, env = process.env, readFile = (p) => fs.readFileSync(p, "utf8")) {
  const d = PROVIDER_DEFAULTS[name];
  if (!d) return null;
  const p = d.envPrefix;
  let apiKey = "";
  try { apiKey = trimmed(readFile(trimmed(env[p + "_KEY_FILE"]) || d.keyFile)); } catch { return null; }
  if (!apiKey) return null;
  return {
    name,
    apiKey,
    baseUrl: trimmed(env[p + "_FALLBACK_BASE_URL"]) || d.baseUrl,
    models: {
      opus: trimmed(env[p + "_FALLBACK_MODEL_OPUS"]) || d.models.opus,
      sonnet: trimmed(env[p + "_FALLBACK_MODEL_SONNET"]) || d.models.sonnet,
      haiku: trimmed(env[p + "_FALLBACK_MODEL_HAIKU"]) || d.models.haiku,
    },
  };
}

export function readProviderConfigs(env = process.env, readFile = undefined) {
  const out = {};
  for (const name of FALLBACK_ORDER) out[name] = readProviderConfig(name, env, readFile);
  return out;
}

export const anyConfigured = (cfgs) => FALLBACK_ORDER.some((n) => !!cfgs[n]);

// provider из формы запроса: только известный запасной, иначе "" (Claude).
export function parseSelected(v) {
  const s = trimmed(v);
  return FALLBACK_ORDER.includes(s) ? s : "";
}

// Аварийный провайдер — запасной не по выбору пользователя.
export const isEmergency = (provider, selected) => provider !== "claude" && provider !== selected;

export function modelFor(requested, models) {
  const m = trimmed(requested).toLowerCase();
  if (m === "haiku" || m.startsWith("claude-haiku")) return models.haiku;
  if (m === "sonnet" || m.startsWith("claude-sonnet")) return models.sonnet;
  return models.opus;
}

export function withModel(args, model) {
  const out = [...args];
  const i = out.indexOf("--model");
  if (i >= 0 && i + 1 < out.length) out[i + 1] = model;
  return out;
}

// Ключ — в ANTHROPIC_AUTH_TOKEN: ANTHROPIC_API_KEY живой OAuth не перебивает.
// MAX_RETRIES=1: без него на 401 CLI повторяет 11 раз с нарастающей паузой.
export function providerSpawnEnv(base, cfg) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("ANTHROPIC_") || k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
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
    CLAUDE_CODE_MAX_RETRIES: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "300000",
    // Вычистка ключа из окружения подпроцессов — ВЫКЛЮЧЕНА явно. На Linux
    // SCRUB=1 требует bubblewrap (bwrap), а на релее его нет: CLI 2.1.280 сразу
    // падает (exit 1), ход возвращал пустой done (30.10). Защита секретов релея
    // от Bash ассистента — отдельная задача. "0" — поверх унаследованного значения.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
  };
}

// Отказ CLI обычным ответом — по правилам looksLikeCliRefusal бэкенда: фраза в
// начале текста, не длиннее 300 символов, без кириллицы. Ложное срабатывание
// открыло бы окно для всех веб-чатов. Уведомление одного хода по-прежнему
// решает FATAL_RE в server.mjs.
const CLI_REFUSAL_RE = /^(?:Not logged in|Please run \/login|(?:You['’]ve |You have )?hit your (?:\w+ )?limit|Invalid API key|Credit balance is too low|OAuth token (?:has )?expired|Claude AI usage limit reached)/i;
const CONTEXT_LENGTH_RE = /context (window|length|limit)|prompt is too long|output token|max_tokens/i;
const ACCESS_STATUS = new Set([401, 403, 429, 529]);
const ACCESS_TEXT_RE = /\b(401|403|429|529)\b|Unauthorized|Forbidden|rate.?limit|overloaded/i;

export function looksLikeCliRefusal(text) {
  const t = trimmed(text);
  return !!t && t.length <= 300 && !/[а-яё]/i.test(t) && CLI_REFUSAL_RE.test(t);
}

// Сбой доступа: отказ CLI или ошибка со статусом входа/лимита/перегрузки.
// Статус ошибки проверяется раньше признаков длины контекста: ответ 429
// «… output tokens per minute» — лимит, а не длина запроса.
export function isAccessFailure(text, { isError = false, apiStatus } = {}) {
  const t = trimmed(text);
  if (isError && ACCESS_STATUS.has(Number(apiStatus))) return true;
  if (CONTEXT_LENGTH_RE.test(t)) return false;
  if (looksLikeCliRefusal(t)) return true;
  if (!isError) return false;
  return ACCESS_TEXT_RE.test(t);
}

// План хода (spec, раздел 3) — как planProviders бэкенда.
export function planProviders({ selected = "", cfgs, state, noFallback = false, now = Date.now() }) {
  if (noFallback) return ["claude"];
  const normal = (exclude) => {
    const alts = FALLBACK_ORDER.filter((n) => n !== exclude && !!cfgs[n] && !state.isDown(n, now));
    return state.claudeWindowOpen(now) && alts.length > 0 ? [...alts] : ["claude", ...alts];
  };
  if (selected && cfgs[selected]) return [selected, ...normal(selected)];
  return normal("");
}

// Следующий шаг плана после step: запасной, ставший «не отвечает» за время хода,
// пропускается. -1 — переходить некуда.
export function nextStep(plan, step, state, now = Date.now()) {
  for (let i = step + 1; i < plan.length; i++) {
    if (plan[i] !== "claude" && state.isDown(plan[i], now)) continue;
    return i;
  }
  return -1;
}

// Можно ли переиграть ход у следующего в плане: выбранный — при любом сбое,
// остальные — при сбое доступа; и только пока человек не видел текста и модель
// не вызывала инструментов с последствиями.
export function mayAdvance({ failed, selected, accessFailure, sentAnyText, riskyToolUsed }) {
  if (sentAnyText || riskyToolUsed) return false;
  if (selected && failed === selected) return true;
  return !!accessFailure;
}

// Окна запасного пути на весь процесс (spec, раздел 2): окно Claude и «не
// отвечает» у каждого запасного; исходы аварийных ходов — по провайдеру, 15 мин.
//
// lastOpenedAt/lastClaudeOkAt — отдельно от самого окна: окно истекает само, а
// монитор на бэкенде (relay-qwen-monitor.service.ts) должен понимать, отвечал
// ли Claude хоть раз с момента последнего сбоя, даже когда окно закрылось само
// по себе и свежих ходов не было (ночь) — иначе уходит ложное «Claude снова
// отвечает».
export function createFallbackState() {
  let claudeOpenUntil = 0;
  let claudeOpenedAt = 0;
  let lastOpenedAt = 0;
  let lastClaudeOkAt = 0;
  const downUntil = {};
  let outcomes = [];
  const prune = (now) => { outcomes = outcomes.filter((o) => o.at >= now - STATS_WINDOW_MS); };
  return {
    claudeWindowOpen: (now = Date.now()) => now < claudeOpenUntil,
    openClaudeWindow(ms, now = Date.now()) { claudeOpenedAt = now; claudeOpenUntil = now + ms; lastOpenedAt = now; },
    closeClaudeWindow() { claudeOpenUntil = 0; },
    // lastClaudeOkAt — по НАЧАЛУ хода: ход, начатый до открытия окна и
    // закончившийся успехом после, не доказывает, что Claude ожил. Math.max — не
    // сдвигать назад, если ходы завершаются не по порядку начала.
    claudeSucceeded(startedAt) {
      lastClaudeOkAt = Math.max(lastClaudeOkAt, startedAt);
      if (startedAt >= claudeOpenedAt) claudeOpenUntil = 0;
    },
    isDown: (name, now = Date.now()) => now < (downUntil[name] || 0),
    markDown(name, ms, now = Date.now()) { downUntil[name] = now + ms; },
    markUp(name) { downUntil[name] = 0; },
    recordOutcome(name, ok, now = Date.now()) { outcomes.push({ at: now, name, ok }); prune(now); },
    stats(cfgs, now = Date.now()) {
      prune(now);
      const providers = {};
      for (const name of FALLBACK_ORDER) {
        const mine = outcomes.filter((o) => o.name === name);
        const ok = mine.filter((o) => o.ok).length;
        const until = downUntil[name] || 0;
        providers[name] = { enabled: !!(cfgs && cfgs[name]), ok, failed: mine.length - ok, downUntil: until > now ? until : 0 };
      }
      return {
        windowMs: STATS_WINDOW_MS,
        breakerOpenUntil: claudeOpenUntil > now ? claudeOpenUntil : 0,
        lastOpenedAt,
        lastClaudeOkAt,
        providers,
      };
    },
  };
}

// Прежнее поле /health.qwen — для монитора бэкенда, пока не выкачен новый.
export function legacyQwenHealth(stats) {
  const q = stats.providers.qwen;
  return {
    enabled: q.enabled,
    ok: q.ok,
    failed: q.failed,
    windowMs: stats.windowMs,
    breakerOpenUntil: stats.breakerOpenUntil,
    lastOpenedAt: stats.lastOpenedAt,
    lastClaudeOkAt: stats.lastClaudeOkAt,
  };
}
```

- [ ] **Step 4: Прогон — зелёный** — «прогон релея». Expected: `# fail 0` (или ровно базовое число из Task 0).

- [ ] **Step 5: Коммит**

```bash
git add relay-agent/llm-fallback.mjs relay-agent/llm-fallback.test.mjs
git commit -q -m "relay: модуль llm-fallback.mjs — запасные Qwen и Kimi, план, окна

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: релей — врезка в `server.mjs` (копия в main)

**Files:**
- Create: `relay-agent/llm-fallback-patch.py`
- Modify: `relay-agent/server.mjs` (только запуском скрипта)
- Delete: `relay-agent/qwen-provider.mjs`, `relay-agent/qwen-provider.test.mjs`

- [ ] **Step 1: Скрипт врезки** — `relay-agent/llm-fallback-patch.py`. Якоря — текст врезки Qwen (`qwen-patch.py`), он одинаков в копии и в живом релее; каждый якорь — ровно один раз; все проверки — до записи.

```python
#!/usr/bin/env python3
"""Врезка цепочки запасных (Claude → Qwen → Kimi) и выбора Kimi в relay
server.mjs — поверх врезки Qwen (qwen-patch.py). Spec spirits_back
docs/superpowers/specs/2026-10-31-kimi-provider-design.md.
Одна и та же для копии relay-agent/ в main и живого релея: якоря — текст
врезки Qwen, одинаковый в обоих. Каждый якорь обязан встретиться ровно один
раз, иначе — выход без записи.
Запуск: python3 llm-fallback-patch.py <путь к server.mjs>"""
import re
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()
if "llm-fallback.mjs" in s:
    sys.exit("уже пропатчено")
if "qwen-provider.mjs" not in s:
    sys.exit("нет врезки Qwen — сначала qwen-patch.py")


def rep(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {old[:90]!r}")
    s = s.replace(old, new)


def region(start, end, new):
    """Заменить кусок от начала start до конца end; оба — ровно по разу."""
    global s
    for a in (start, end):
        n = s.count(a)
        if n != 1:
            sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {a[:90]!r}")
    i = s.index(start)
    j = s.index(end)
    if j < i:
        sys.exit(f"конец раньше начала: {end[:90]!r}")
    s = s[:i] + new + s[j + len(end):]


def need(snippet):
    if snippet not in s:
        sys.exit(f"нет объявления, на которое опирается врезка: {snippet!r}")


# 0. Объявления, которые читает врезка. Ошибку области видимости node --check не
# ловит, а handleEvent и внешний ход глотают исключения — ReferenceError молча
# ломал бы каждый ход. Поэтому — проверка до записи.
for decl in ('const sessionId = ', 'const args = [', 'const reqModel = ', 'let streamedAny = ',
             'let clientDisconnected = ', 'const notice = ', 'const FATAL_RE = ', 'const fatalHint = ',
             'const TRANSIENT_RE = ', 'const IMG_LIMIT_RE = ', 'const NO_RESP_PLACEHOLDER = '):
    need(decl)

# 1. Модуль.
rep('import * as qwen from "./qwen-provider.mjs";\n',
    'import * as llm from "./llm-fallback.mjs";\n')

# 2. Окна на весь процесс.
region('// Окно запасного Qwen и исходы аварийных ходов на нём — на весь процесс\n',
       'const qwenBreaker = qwen.createQwenBreaker();\n',
       '// Окна запасного пути (окно Claude и «не отвечает» у каждого запасного) и\n'
       '// исходы аварийных ходов — на весь процесс (llm-fallback.mjs; spec\n'
       '// spirits_back 2026-10-31-kimi-provider-design).\n'
       'const fallbackState = llm.createFallbackState();\n')

# 3. План хода.
region('  // Qwen: принудительный (provider=qwen — выбор пользователя в админке бэкенда)\n',
       '  let riskyToolUsed = false;\n',
       '  // Провайдер хода (llm-fallback.mjs): выбор пользователя (provider=qwen|kimi —\n'
       '  // админка бэкенда) и аварийная цепочка Claude → Qwen → Kimi. Ключи — файлами,\n'
       '  // читаются на каждом ходе: нет файла — провайдер выключен. noFallback=1 —\n'
       '  // пробы мониторинга, только Claude.\n'
       '  const reqNoFallback = String(req.body.noFallback || "") === "1";\n'
       '  const llmCfgs = reqNoFallback ? llm.NO_CONFIGS : llm.readProviderConfigs();\n'
       '  const breakerMs = llm.readBreakerMs();\n'
       '  const reqProvider = llm.parseSelected(req.body.provider);\n'
       '  if (reqProvider && !llmCfgs[reqProvider] && !reqNoFallback) console.warn("[llm] provider=" + reqProvider + ", но ключа нет — обычный путь");\n'
       '  const selected = reqProvider && llmCfgs[reqProvider] ? reqProvider : "";\n'
       '  // План хода — кого пробовать по порядку; planStep — текущая попытка.\n'
       '  const plan = llm.planProviders({ selected, cfgs: llmCfgs, state: fallbackState, noFallback: reqNoFallback });\n'
       '  let planStep = 0;\n'
       '  let provider = plan[0];\n'
       '  // Ответ даёт аварийный путь: запасной не по выбору (окно Claude или сбой в этом ходе).\n'
       '  let usedFallback = llm.isEmergency(provider, selected);\n'
       '  // Ход дошёл до запасных аварийно — для окна Claude по итогам хода.\n'
       '  let reachedFallback = usedFallback;\n'
       '  // Инструмент с последствиями в этом ходе — после него у другого провайдера не переигрываем.\n'
       '  let riskyToolUsed = false;\n')

# 4. runOnce: переход к следующему в плане.
region('  // Окно запасного Qwen открывается при сбое доступа к Claude и тогда, когда\n',
       '    return fallbackToQwen(useResume, "отказ CLI");\n  }\n',
       '  // Сбой доступа у провайдера (llm-fallback.mjs): у Claude — окно Claude (если\n'
       '  // есть хоть один запасной — иначе переключаться не на кого), у запасного — его\n'
       '  // окно «не отвечает». Пробы (noFallback) окон не трогают.\n'
       '  const noteAccessFailure = (failed, why) => {\n'
       '    if (reqNoFallback) return;\n'
       '    if (failed === "claude") {\n'
       '      if (!llm.anyConfigured(llmCfgs)) return;\n'
       '      fallbackState.openClaudeWindow(breakerMs);\n'
       '      console.warn("[llm] " + sessionId + ": Claude недоступен (" + why + ") — окно Claude открыто");\n'
       '    } else {\n'
       '      fallbackState.markDown(failed, breakerMs);\n'
       '      console.warn("[llm] " + sessionId + ": " + llm.PROVIDER_LABELS[failed] + " не отвечает (" + why + ")");\n'
       '    }\n'
       '  };\n'
       '  // Переход к следующему в плане: тот же ход (тот же --resume — беседа\n'
       '  // продолжается между провайдерами) у следующего провайдера; null — некуда.\n'
       '  // Аварийный исход упавшего запасного — в статистику здесь, финальный — по\n'
       '  // итогам хода.\n'
       '  const switchProvider = (useResume, why) => {\n'
       '    const i = llm.nextStep(plan, planStep, fallbackState);\n'
       '    if (i < 0) return null;\n'
       '    const from = provider;\n'
       '    if (llm.isEmergency(from, selected)) fallbackState.recordOutcome(from, false);\n'
       '    planStep = i;\n'
       '    provider = plan[i];\n'
       '    usedFallback = llm.isEmergency(provider, selected);\n'
       '    if (usedFallback) reachedFallback = true;\n'
       '    const model = provider === "claude" ? reqModel : llm.modelFor(reqModel, llmCfgs[provider].models);\n'
       '    console.warn("[llm] " + sessionId + ": " + llm.PROVIDER_LABELS[from] + " (" + why + ") → " + llm.PROVIDER_LABELS[provider] + " " + model);\n'
       '    return runOnce(useResume, provider);\n'
       '  };\n'
       '  // Запуск хода. Без провайдера — текущий провайдер хода: после переключения\n'
       '  // повтор, перезапуск и продолжение идут у нового. Сбой, после которого ход\n'
       '  // переходит к следующему в плане (switchHit, разбор result ниже), в ЛЮБОМ\n'
       '  // запуске — первом, после протухшего resume, повторе после временной ошибки,\n'
       '  // продолжении после потолка шагов — переигрывается здесь. Кроме хода,\n'
       '  // прерванного новым сообщением или брошенного бэкендом: запуск у следующего\n'
       '  // убил бы уже новый ход этой сессии (pre-empt ниже) или отвечал бы в\n'
       '  // закрытый канал. План кончился за время хода — уведомление, которое разбор\n'
       '  // result придержал.\n'
       '  async function runOnce(useResume, runProvider = provider) {\n'
       '    const r = await runProcessOnce(useResume, runProvider);\n'
       '    if (!r.switchHit || preempted || clientDisconnected) return r;\n'
       '    const next = switchProvider(useResume, r.switchWhy);\n'
       '    if (next) return next;\n'
       '    const fatal = FATAL_RE.test(r.switchText);\n'
       '    notice(fatal ? fatalHint(r.switchText) : "_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", fatal ? "cli_fatal" : "transient");\n'
       '    return r;\n'
       '  }\n')

# 5. Модель и окружение запуска; комментарий у preempt.
rep('      const baseArgs = runProvider === "qwen" ? qwen.withModel(args, qwen.qwenModelFor(reqModel, qwenCfg.models)) : args;\n',
    '      const baseArgs = runProvider === "claude" ? args : llm.withModel(args, llm.modelFor(reqModel, llmCfgs[runProvider].models));\n')
rep('...(runProvider === "qwen" ? qwen.qwenSpawnEnv(process.env, qwenCfg) : process.env), MCP_TIMEOUT: "120000"',
    '...(runProvider === "claude" ? process.env : llm.providerSpawnEnv(process.env, llmCfgs[runProvider])), MCP_TIMEOUT: "120000"')
rep('        // preempted — сбой доступа в прерванном ходе на Qwen не переигрывается.\n',
    '        // preempted — прерванный ход у другого провайдера не переигрывается.\n')

# 6. Признаки запуска.
rep('      let accessFailHit = false;\n      let transientAccessLike = false;\n      let sawResult = false;\n',
    '      // Сбой, после которого ход переходит к следующему в плане (runOnce выше).\n'
    '      let switchHit = false;\n'
    '      let switchWhy = "";\n'
    '      let switchText = "";\n'
    '      let transientAccessLike = false;\n'
    '      let sawResult = false;\n')
rep('              if (!qwen.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n',
    '              if (!llm.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n')

# 7. Разбор result.
region('          // Сбой доступа (qwen-provider.mjs): отказ CLI или ошибка, которую прежде\n',
       '          if (runProvider === "claude" && accessFailure && isErrorResult) transientAccessLike = true;\n',
       '          // Сбой провайдера (llm-fallback.mjs). Отказ CLI или ошибка, которую\n'
       '          // прежде закрывало уведомление cli_fatal (FATAL_RE: повтором не лечится,\n'
       '          // — например «API Error: 401 … OAuth token has expired»), — у любого\n'
       '          // провайдера; у выбранного пользователем — и любая другая ошибка, кроме\n'
       '          // тех, что штатно повторяются (временная, перегруз картинками, пустой\n'
       '          // ответ-заглушка). До первого текста и без инструментов с последствиями\n'
       '          // ход переходит к следующему в плане, уведомление не шлём; иначе ход не\n'
       '          // повторяется, но сбой доступа открывает окно. Ошибка доступа, которую\n'
       '          // штатно повторяют (TRANSIENT_RE), — признак для решения после повтора\n'
       '          // (transientHit ниже).\n'
       '          const accessFailure = llm.isAccessFailure(ev.result, { isError: isErrorResult, apiStatus: ev.api_error_status });\n'
       '          const fatalAccess = accessFailure && (llm.looksLikeCliRefusal(ev.result) || FATAL_RE.test(ev.result));\n'
       '          const selectedFail = !!selected && runProvider === selected && isErrorResult &&\n'
       '            !TRANSIENT_RE.test(ev.result) && !(IMG_LIMIT_RE.test(ev.result) && useResume) &&\n'
       '            ev.result.trim() !== NO_RESP_PLACEHOLDER;\n'
       '          if (fatalAccess || selectedFail) {\n'
       '            if (fatalAccess) noteAccessFailure(runProvider, "отказ CLI");\n'
       '            if (llm.nextStep(plan, planStep, fallbackState) >= 0 &&\n'
       '                llm.mayAdvance({ failed: runProvider, selected, accessFailure: fatalAccess, sentAnyText: streamedAny, riskyToolUsed })) {\n'
       '              switchHit = true;\n'
       '              switchWhy = fatalAccess ? "отказ CLI" : "ошибка";\n'
       '              switchText = String(ev.result);\n'
       '              return;\n'
       '            }\n'
       '          }\n'
       '          if (accessFailure && isErrorResult) transientAccessLike = true;\n')
rep('resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, accessFailHit, transientAccessLike, sawResult, startedAt: runStartedAt });',
    'resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, switchHit, switchWhy, switchText, transientAccessLike, sawResult, startedAt: runStartedAt });')

# 8. Штатный повтор после временной ошибки тоже упал.
region('        if (provider === "claude" && r.transientAccessLike) {\n',
       '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n',
       '        // Повтор тоже упал. Сбой доступа открывает окно (у Claude) или «не\n'
       '        // отвечает» (у запасного); ход переходит к следующему в плане — при сбое\n'
       '        // доступа или если упал выбранный пользователем провайдер.\n'
       '        if (r.transientAccessLike) noteAccessFailure(provider, "ошибка доступа после повтора");\n'
       '        if (!preempted && !clientDisconnected &&\n'
       '            llm.mayAdvance({ failed: provider, selected, accessFailure: !!r.transientAccessLike, sentAnyText: streamedAny, riskyToolUsed })) {\n'
       '          const next = switchProvider(useResume, r.transientAccessLike ? "ошибка доступа после повтора" : "ошибка после повтора");\n'
       '          if (next) r = await next;\n'
       '        }\n'
       '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n')

# 9. Окна по итогам хода.
region('    // Окно запасного Qwen: успех Claude, начатый после открытия окна, его\n',
       '      else if (provider === "claude" && runOk) qwenBreaker.claudeSucceeded(r.startedAt);\n    }\n',
       '    // Окна по итогам хода: успех Claude, начатый после открытия окна, его\n'
       '    // закрывает; успех запасного снимает его «не отвечает»; исход аварийного\n'
       '    // хода — в статистику; ход, дошедший до запасных и закончившийся неудачей,\n'
       '    // закрывает окно Claude (Claude мог уже ожить). Не считаются ходы с\n'
       '    // неизвестным исходом — прерванный новым сообщением, брошенный бэкендом,\n'
       '    // упёршийся в потолок шагов.\n'
       '    if (!preempted && !clientDisconnected && failReason !== "max_turns") {\n'
       '      const runOk = !!r.sawResult && !r.switchHit && !r.transientHit;\n'
       '      if (provider === "claude") {\n'
       '        if (runOk) fallbackState.claudeSucceeded(r.startedAt);\n'
       '      } else {\n'
       '        if (runOk) fallbackState.markUp(provider);\n'
       '        if (usedFallback) fallbackState.recordOutcome(provider, runOk);\n'
       '      }\n'
       '      if (!runOk && reachedFallback) fallbackState.closeClaudeWindow();\n'
       '    }\n')

# 10. /health.
rep('  res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime(), qwen: { enabled: !!qwen.readQwenConfig(), ...qwenBreaker.stats() } });\n',
    '  // fallback — окна и исходы по всем запасным; qwen — прежнее поле для монитора\n'
    '  // бэкенда, пока не выкачен новый (llm-fallback.mjs, legacyQwenHealth).\n'
    '  const fb = fallbackState.stats(llm.readProviderConfigs());\n'
    '  res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime(), fallback: fb, qwen: llm.legacyQwenHealth(fb) });\n')

# 11. От врезки Qwen ничего не осталось.
for leftover in ("qwenBreaker", "qwenCfg", "qwenForced", "accessFailHit", "fallbackToQwen", "qwenWindowOnly"):
    if leftover in s:
        sys.exit(f"осталось {leftover!r} — врезка неполна, ничего не записано")
if re.search(r"\bqwen\.[A-Za-z]", s):
    sys.exit("остались вызовы qwen.* — врезка неполна, ничего не записано")

open(path, "w", encoding="utf-8").write(s)
print("ok:", path)
```

- [ ] **Step 2: Применить к копии и снять старый модуль**

```bash
cd ~/Downloads/spirits_back/.worktrees/kimi-provider/relay-agent
python3 llm-fallback-patch.py server.mjs
python3 llm-fallback-patch.py server.mjs; echo "повторный запуск: $?"   # ожидается «уже пропатчено», код 1
git rm -q qwen-provider.mjs qwen-provider.test.mjs
git diff --stat server.mjs
```

Expected: `ok: server.mjs`; повторный — «уже пропатчено»; дифф около 200 строк (проба на копии из main при составлении плана — 200).

- [ ] **Step 3: Прочитать дифф глазами.** `git diff server.mjs` — для каждого места: `selected`, `plan`, `planStep`, `llmCfgs`, `breakerMs`, `fallbackState`, `useResume`, `streamedAny`, `riskyToolUsed`, `TRANSIENT_RE`, `IMG_LIMIT_RE`, `NO_RESP_PLACEHOLDER`, `fatalHint`, `notice` действительно в области видимости там, куда вставлены (п. 7 — внутри `handleEvent` в `runProcessOnce(useResume, runProvider)`; п. 8 — внутри внешнего `async`, где `let r`). Расхождение — правка скрипта, а не руками в `server.mjs`.

- [ ] **Step 4: Коммит; на ноде — `node --check` и все тесты релея**

```bash
cd ~/Downloads/spirits_back/.worktrees/kimi-provider
git add relay-agent/llm-fallback-patch.py relay-agent/server.mjs
git commit -q -m "relay: цепочка Claude → Qwen → Kimi и выбор Kimi (provider=kimi); /health.fallback; qwen-provider.mjs заменён llm-fallback.mjs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q && SHA=$(git rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/wt/kimi-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && cd relay-agent && node --check server.mjs && echo CHECK_OK && node --test --test-reporter=tap *.test.mjs 2>&1 | grep -aE '^# (pass|fail)'"
```

Expected: `CHECK_OK`; `# fail 0` (или базовое число из Task 0).

---

### Task 10: релей — живая версия и проверка на стенде (без выката)

Второй экземпляр релея на 5.101.115.184 запускать НЕЛЬЗЯ: порт 3033 и `sessions.json` прибиты в коде, а `sweepRuns` при старте убивает «чужие» ходы с меткой релея. Проверка — на ноде; стенд слушает **только 127.0.0.1** и снимается сразу после проверки (память «Стенд релея на ноде открыт наружу»).

- [ ] **Step 1: Снять живую версию и пропатчить её**

```bash
W=/private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/2ee1bf56-31d4-4343-84d9-321f7e3c99d0/scratchpad/relay-live-kimi
rm -rf "${W}" && mkdir -p "${W}"
ssh dv@5.101.115.184 'cd ~/file-agent && git rev-parse --short HEAD && git status --short && sha256sum server.mjs'
ssh dv@5.101.115.184 'cd ~/file-agent && tar czf - --exclude=node_modules --exclude=.git --exclude="sessions.json*" --exclude=secrets .' > "${W}/live.tgz"
tar xzf "${W}/live.tgz" -C "${W}" && rm "${W}/live.tgz"
B=~/Downloads/spirits_back/.worktrees/kimi-provider/relay-agent
cp "${B}/llm-fallback.mjs" "${B}/llm-fallback.test.mjs" "${B}/llm-fallback-patch.py" "${W}/"
python3 "${W}/llm-fallback-patch.py" "${W}/server.mjs"
rm "${W}/qwen-provider.mjs" "${W}/qwen-provider.test.mjs"
```

Expected: HEAD `e5c2737` (иначе — стоп и доклад: живой релей ушёл вперёд); в `git status` — не больше `?? sessions.json.bak-*`; sha256 живого `server.mjs` — записать в отчёт (Task 13 сверит); `ok: …/server.mjs`.

- [ ] **Step 2: Стенд на ноде — только 127.0.0.1**

```bash
ssh dv@85.192.61.231 'ls -d /home/dv/file-agent /tmp/agent-uploads /tmp/agent-output ~/relay-kimi-check 2>/dev/null; ss -ltn | grep -c ":3033 "'
```

Expected: ни одного пути и `0`. Иначе — стоп и доклад (чужой стенд не трогать).

```bash
ssh dv@85.192.61.231 'mkdir -p ~/relay-kimi-check' && tar czf - -C "${W}" . | ssh dv@85.192.61.231 'tar xzf - -C ~/relay-kimi-check'
ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh && cd ~/relay-kimi-check && sed -i "s/app.listen(PORT, \"0.0.0.0\"/app.listen(PORT, \"127.0.0.1\"/" server.mjs && grep -c "app.listen(PORT, \"127.0.0.1\"" server.mjs && npm ci --no-audit --no-fund 2>&1 | tail -1 && node --check server.mjs && node --test --test-reporter=tap llm-fallback.test.mjs 2>&1 | grep -aE "^# (pass|fail)" && mkdir -p /home/dv/file-agent && cp empty-mcp.json /home/dv/file-agent/ && echo READY'
```

Expected: `1`, `added N packages`, `# fail 0`, `READY`. (Правка `listen` — только в копии стенда; `${W}` для выката не трогается.)

- [ ] **Step 3: Ключи во временные файлы (через stdin) и запуск с пустым `CLAUDE_CONFIG_DIR`**

```bash
python3 - <<'EOF' | ssh dv@85.192.61.231 'cd ~/relay-kimi-check && umask 077 && read -r K && read -r Q && printf "%s" "$K" > kimi.good && printf "%s" "$Q" > qwen.good && printf "sk-broken-check" > broken.key && ls kimi.good qwen.good broken.key | wc -l'
import json, os
print(open(os.path.expanduser('~/.linkeon/kimi.key')).read().strip())
print(json.load(open(os.path.expanduser('~/.qwen/settings.json')))['security']['auth']['apiKey'])
EOF
ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh; cd ~/relay-kimi-check; umask 077; CFG=$(mktemp -d); echo "$CFG" > cfgdir.txt; cp kimi.good kimi.key; rm -f qwen.key; CLAUDE_CONFIG_DIR=$CFG QWEN_KEY_FILE=$PWD/qwen.key KIMI_KEY_FILE=$PWD/kimi.key LLM_FALLBACK_BREAKER_MS=0 setsid -f node server.mjs > relay.log 2>&1 < /dev/null; for i in $(seq 1 20); do curl -s 127.0.0.1:3033/health >/dev/null && break; read -t 1 < /dev/zero 2>/dev/null; done; curl -s 127.0.0.1:3033/health; echo; ss -ltn | grep ":3033 "'
```

Expected: `3`; `/health` с `"fallback":{…"providers":{"qwen":{"enabled":false,…},"kimi":{"enabled":true,…}}}` и прежним `"qwen":{"enabled":false,…}`; `ss` — `127.0.0.1:3033`, не `0.0.0.0`. (Ключи читаются на каждом ходе — сценарии ниже меняют файлы между ходами; `LLM_FALLBACK_BREAKER_MS=0` — окна не переносятся между сценариями.)

- [ ] **Step 4: Пять сценариев**

```bash
ssh dv@85.192.61.231 'cd ~/relay-kimi-check
ask() { curl -s -N -m 300 -X POST 127.0.0.1:3033/chat -F "message=Ответь одним словом: ок" -F "sessionId=kimi-check-$1" -F "model=claude-opus-5-5" $2 | grep -a "\"type\":\"done\"\|\"type\":\"notice\"" | cut -c1-300; }
echo "== 1. Qwen выключен: сбой Claude → Kimi"; rm -f qwen.key; ask a ""
echo "== 2. Qwen с битым ключом: Claude → Qwen → Kimi"; cp broken.key qwen.key; ask b ""
echo "== 3. provider=kimi → Kimi по выбору"; ask c "-F provider=kimi"
echo "== 4. provider=kimi с битым ключом, Qwen живой: Kimi → Claude → Qwen"; cp qwen.good qwen.key; cp broken.key kimi.key; ask d "-F provider=kimi"
echo "== 5. noFallback=1 → прежнее уведомление"; cp kimi.good kimi.key; ask e "-F noFallback=1"
curl -s 127.0.0.1:3033/health; echo; grep -a "\[llm\]" relay.log | tail -14'
```

Expected:
1. `done` с `"provider":"kimi","fallback":true`, `"failed":false`; в логе `[llm] kimi-check-a: Claude (отказ CLI) → Kimi k3.1-pro`;
2. `done` с `"provider":"kimi","fallback":true`; в логе — переход Claude → Qwen, затем `Qwen не отвечает (…)` и `Qwen (… после повтора) → Kimi k3.1-pro`;
3. `done` с `"provider":"kimi","fallback":false`;
4. `done` с `"provider":"qwen","fallback":true`; в логе — `Kimi (…) → Claude`, затем `Claude (отказ CLI) → Qwen qwen3.8-max`;
5. `notice` про сбой авторизации, `done` с `"failed":true`, `"failReason":"cli_fatal"`, `"provider":"claude"`;
6. `/health`: `fallback.providers.kimi.ok` = 2 (ходы 1–2), `qwen.failed` = 1 (ход 2), `qwen.ok` = 1 (ход 4); ход 3 не считается.

Что-то не так — стоп: разбор по `relay.log`, правка модуля/врезки в spirits_back (Task 8–9), повтор Task 10 с Step 1.

- [ ] **Step 5: Уборка стенда (обязательно, даже при провале)**

```bash
ssh dv@85.192.61.231 'for p in $(pgrep -u dv -f "node server.mjs"); do [ "$(readlink /proc/$p/cwd)" = "$HOME/relay-kimi-check" ] && kill $p; done; read -t 2 < /dev/zero 2>/dev/null; rm -rf "$(cat ~/relay-kimi-check/cfgdir.txt)" ~/relay-kimi-check /home/dv/file-agent /tmp/agent-uploads /tmp/agent-output; ss -ltn | grep -c ":3033 "'
```

Expected: `0`.

- [ ] **Step 6:** `${W}/server.mjs`, `${W}/llm-fallback.mjs`, `${W}/llm-fallback.test.mjs` остаются в scratchpad до Task 13 (выкат релея). В отчёт — sha256 живого `server.mjs` до патча (Step 1).

---

### Task 11: фронт — блок «Модель ответов» с Kimi

**Files:**
- Modify: `src/components/admin/UserLlmProviderControl.tsx`, `src/components/admin/UserLlmProviderControl.test.tsx`
- Modify: `src/i18n/locales/ru.json`, `en.json`, `pt.json`

Всё — в `~/Downloads/spirits_front/.worktrees/kimi-provider`.

- [ ] **Step 1: Падающий тест** — `src/components/admin/UserLlmProviderControl.test.tsx` заменить целиком:

```tsx
// @vitest-environment jsdom
/**
 * Модель ответов человека в карточке (spec spirits_back 2026-10-30-llm-provider-switch,
 * 2026-10-31-kimi-provider-design).
 */
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/apiClient', () => ({ apiClient: { get, post } }));

import { UserLlmProviderControl } from './UserLlmProviderControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
/** Ответ нового бэкенда: выбор и ключи по каждому запасному. */
const state = (provider: string, qwen = true, kimi = true, userId = 'u-1') =>
  ok({ userId, provider, qwenConfigured: qwen, configured: { qwen, kimi } });
const mount = async (userId = 'u-1') => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<UserLlmProviderControl userId={userId} />); });
  await settle();
};
const rerender = async (userId: string) => {
  await act(async () => { root.render(<UserLlmProviderControl userId={userId} />); });
  await settle();
};
const radio = (name: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find((el) => el.textContent?.includes(name)) as HTMLButtonElement;

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('UserLlmProviderControl', () => {
  it('три варианта; показывает текущий выбор', async () => {
    get.mockResolvedValue(state('kimi'));
    await mount();
    expect(get).toHaveBeenCalledWith('/webhook/admin/users/u-1/llm-provider');
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(radio('Kimi').getAttribute('aria-checked')).toBe('true');
    expect(radio('Qwen').getAttribute('aria-checked')).toBe('false');
    expect(radio('Claude').getAttribute('aria-checked')).toBe('false');
  });

  it('переключение на Kimi сохраняется сразу', async () => {
    get.mockResolvedValue(state('claude'));
    post.mockResolvedValue(state('kimi'));
    await mount();
    await act(async () => { radio('Kimi').click(); });
    await settle();
    expect(post).toHaveBeenCalledWith('/webhook/admin/users/u-1/llm-provider', { provider: 'kimi' });
    expect(radio('Kimi').getAttribute('aria-checked')).toBe('true');
  });

  it('вариант без ключа помечен «нет ключа»; предупреждения нет, пока он не выбран', async () => {
    get.mockResolvedValue(state('claude', true, false));
    await mount();
    expect(radio('Kimi').textContent).toContain('нет ключа');
    expect(radio('Qwen').textContent).not.toContain('нет ключа');
    expect(container.textContent).not.toContain('на сервере не настроен');
  });

  it('выбран Kimi без ключа — предупреждение про Kimi', async () => {
    get.mockResolvedValue(state('kimi', true, false));
    await mount();
    expect(container.textContent).toContain('Ключ Kimi на сервере не настроен');
  });

  it('старый бэкенд (только qwenConfigured): Kimi — без ключа, Qwen — по qwenConfigured', async () => {
    get.mockResolvedValue(ok({ userId: 'u-1', provider: 'qwen', qwenConfigured: false }));
    await mount();
    expect(container.textContent).toContain('Ключ Qwen на сервере не настроен');
    expect(radio('Kimi').textContent).toContain('нет ключа');
  });

  it('подсказка: при сбое выбранной ответит Claude', async () => {
    get.mockResolvedValue(state('claude'));
    await mount();
    expect(container.textContent).toContain('Если выбранная модель не ответит, ответит Claude.');
  });

  it('ошибка загрузки видна', async () => {
    get.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('Не удалось загрузить или сохранить выбор');
  });

  it('заголовок связан с radiogroup через aria-labelledby', async () => {
    get.mockResolvedValue(state('claude'));
    await mount();
    const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toContain('Модель ответов');
  });

  it('до ответа GET виден индикатор загрузки', async () => {
    let resolveGet: (v: unknown) => void = () => {};
    get.mockReturnValue(new Promise((resolve) => { resolveGet = resolve; }));
    await mount();
    expect(container.textContent).toContain('Загрузка…');
    await act(async () => { resolveGet(state('claude')); });
    await settle();
    expect(container.textContent).not.toContain('Загрузка…');
  });

  it('поздний ответ POST не ложится на чужую карточку после смены userId', async () => {
    let resolvePostA: (v: unknown) => void = () => {};
    get.mockImplementation((url: string) => Promise.resolve(
      url.includes('userA') ? state('claude', true, true, 'userA') : state('claude', true, true, 'userB'),
    ));
    post.mockReturnValue(new Promise((resolve) => { resolvePostA = resolve; }));
    await mount('userA');
    await act(async () => { radio('Kimi').click(); });
    await settle();

    await rerender('userB');
    await settle();
    expect(radio('Claude').getAttribute('aria-checked')).toBe('true');

    await act(async () => { resolvePostA(state('kimi', true, true, 'userA')); });
    await settle();
    expect(radio('Claude').getAttribute('aria-checked')).toBe('true');
    expect(radio('Kimi').getAttribute('aria-checked')).toBe('false');
  });

  it('POST 404 показывает понятную ошибку без кода', async () => {
    get.mockResolvedValue(state('claude'));
    post.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await mount();
    await act(async () => { radio('Kimi').click(); });
    await settle();
    expect(container.textContent).toContain('Пользователь не найден');
    expect(container.textContent).not.toContain('404');
  });
});
```

- [ ] **Step 2: Прогон — падает** — «прогон фронта: src/components/admin/UserLlmProviderControl.test.tsx». Expected: FAIL (два варианта вместо трёх, нет «нет ключа», нет подсказки).

- [ ] **Step 3: Реализация**

`src/components/admin/UserLlmProviderControl.tsx`:
- типы и `toState` (вместо `type Provider = 'claude' | 'qwen'; interface ProviderState …; const toState = …`):

```tsx
type Provider = 'claude' | 'qwen' | 'kimi';
type Alt = Exclude<Provider, 'claude'>;
const PROVIDERS: Provider[] = ['claude', 'qwen', 'kimi'];
interface ProviderState { provider: Provider; configured: Record<Alt, boolean> }

const toState = (j: any): ProviderState => ({
  provider: j?.provider === 'qwen' || j?.provider === 'kimi' ? j.provider : 'claude',
  // Старый бэкенд отдаёт только qwenConfigured — Kimi у него нет.
  configured: j?.configured && typeof j.configured === 'object'
    ? { qwen: j.configured.qwen === true, kimi: j.configured.kimi === true }
    : { qwen: j?.qwenConfigured === true, kimi: false },
});
```

- комментарий компонента: `(spec spirits_back 2026-10-30-llm-provider-switch, 2026-10-31-kimi-provider-design)`;
- `label` и предупреждение (вместо прежнего `label`):

```tsx
  const label = (p: Provider) => {
    if (p === 'claude') return t('admin.userActivity.llmProvider.claude', 'Claude (по умолчанию)');
    if (p === 'qwen') return t('admin.userActivity.llmProvider.qwen', 'Qwen');
    return t('admin.userActivity.llmProvider.kimi', 'Kimi');
  };
  // Ключи — литералами, без шаблона {{name}}: их видит check-keys.
  const noKeyWarning = (p: Alt) => (p === 'qwen'
    ? t('admin.userActivity.llmProvider.noKey', 'Ключ Qwen на сервере не настроен — ответы пойдут через Claude.')
    : t('admin.userActivity.llmProvider.noKeyKimi', 'Ключ Kimi на сервере не настроен — ответы пойдут через Claude.'));
```

- блок `{state && (…)}` заменить на:

```tsx
      {state && (
        <>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={titleId}>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={state.provider === p}
                aria-disabled={saving}
                onClick={() => choose(p)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg border text-sm',
                  state.provider === p
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50',
                )}
              >
                {label(p)}
                {p !== 'claude' && !state.configured[p] && (
                  <span className="ml-1 text-xs opacity-75">· {t('admin.userActivity.llmProvider.noKeyShort', 'нет ключа')}</span>
                )}
              </button>
            ))}
          </div>
          {state.provider !== 'claude' && !state.configured[state.provider] && (
            <p className="mt-2 text-xs text-amber-700">
              {noKeyWarning(state.provider)}
            </p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            {t('admin.userActivity.llmProvider.fallbackHint', 'Если выбранная модель не ответит, ответит Claude.')}
          </p>
          <p className="mt-2 text-xs text-gray-500">
            {t('admin.userActivity.llmProvider.hint', 'Веб-ассистенты, Маша и TG-боты этого человека. Пробы мониторинга и фоновые задачи — всегда Claude.')}
          </p>
        </>
      )}
```

Локали — после строки `"noKey": …` блока `admin.userActivity.llmProvider` (отступ 8 пробелов, как у соседей) добавить:

`src/i18n/locales/ru.json`:

```json
        "kimi": "Kimi",
        "noKeyKimi": "Ключ Kimi на сервере не настроен — ответы пойдут через Claude.",
        "noKeyShort": "нет ключа",
        "fallbackHint": "Если выбранная модель не ответит, ответит Claude.",
```

`src/i18n/locales/en.json`:

```json
        "kimi": "Kimi",
        "noKeyKimi": "Kimi key is not configured on the server — answers will go through Claude.",
        "noKeyShort": "no key",
        "fallbackHint": "If the chosen model does not answer, Claude will.",
```

`src/i18n/locales/pt.json` (европейский португальский — память «pt европейский»):

```json
        "kimi": "Kimi",
        "noKeyKimi": "A chave do Kimi não está configurada no servidor — as respostas irão pelo Claude.",
        "noKeyShort": "sem chave",
        "fallbackHint": "Se o modelo escolhido não responder, responde o Claude.",
```

Проверка JSON и ключей:

```bash
for l in ru en pt; do python3 -c "import json;d=json.load(open('src/i18n/locales/$l.json'));print('$l', sorted(d['admin']['userActivity']['llmProvider']))"; done
git diff --stat src/i18n/locales
```

Expected: в каждой локали 12 ключей (`claude, error, fallbackHint, hint, kimi, loading, noKey, noKeyKimi, noKeyShort, notFound, qwen, title`); дифф — по 4 добавленные строки на файл.

- [ ] **Step 4: Прогон — зелёный, проверки локалей, tsc**

«прогон фронта: src/components/admin», затем:

```bash
ssh dv@85.192.61.231 "cd ~/ci/wt/kimi-front && source ~/.nvm/nvm.sh && node scripts/check-keys-exist.mjs && node scripts/check-locales.mjs && echo LOCALES_OK; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'"
```

Expected: PASS; `LOCALES_OK`; число ошибок tsc — как в базе Task 0 (не больше).

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_front/.worktrees/kimi-provider
git add src/components/admin/UserLlmProviderControl.tsx src/components/admin/UserLlmProviderControl.test.tsx src/i18n/locales/ru.json src/i18n/locales/en.json src/i18n/locales/pt.json
git commit -q -m "admin: модель ответов — третий вариант Kimi, пометки «нет ключа», подсказка про ответ Claude

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -q
```

---

### Task 12: финальное ревью и слияние

- [ ] **Step 1: Ревью** — `superpowers:code-reviewer` по `origin/main..feat/kimi-provider` в обоих репозиториях, против spec; отдельно — `${W}/server.mjs` (пропатченная живая версия) против копии в main: `diff` по местам врезки должен совпадать (различия — только «часть Б», которой нет на живом релее).

- [ ] **Step 2: Полный прогон на финальных sha** — бэк: `npx tsc -p tsconfig.build.json --noEmit` и полный `npx jest` на ветке и на `origin/main` — дельта падений ноль (красное by design — те же наборы, память «npm test бэка красный by design»); релей: `node --test --test-reporter=tap *.test.mjs`; фронт: vitest целиком + `check-keys`/`check-locales` + tsc (дельта) + `pnpm build`.

- [ ] **Step 3: Слияние бэка** — squash поверх свежего `origin/main`:

```bash
cd ~/Downloads/spirits_back/.worktrees/kimi-provider && git fetch -q origin
git checkout -q --detach origin/main
git merge -q --squash feat/kimi-provider && git commit -q -m "feat: Kimi — третий провайдер ответов: выбор в карточке и запасной путь Claude → Qwen → Kimi (бэкенд, релей)

Spec docs/superpowers/specs/2026-10-31-kimi-provider-design.md, план docs/superpowers/plans/2026-10-31-kimi-provider.md.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
SQ=$(git rev-parse HEAD)
git push -q origin "${SQ}:refs/heads/tmp/kimi-squash"
```

На ноде: `git checkout -q --detach ${SQ}`, `npm ci` (если менялся lockfile), tsc + целевые наборы (`src/common src/admin src/chat src/tg-bot src/monitoring src/guest-trial`) + релей. Зелено:

```bash
git fetch -q origin && git merge-base --is-ancestor origin/main "${SQ}" && git push origin "${SQ}:refs/heads/main"
git push -q origin --delete tmp/kimi-squash
git checkout -q feat/kimi-provider
```

`merge-base` ложно (main ушёл вперёд) — повторить Step 3 от свежего `origin/main`.

- [ ] **Step 4: Слияние фронта** — squash поверх свежего `origin/main`:

```bash
cd ~/Downloads/spirits_front/.worktrees/kimi-provider && git fetch -q origin
git checkout -q --detach origin/main
git merge -q --squash feat/kimi-provider && git commit -q -m "admin: модель ответов — Kimi (spec spirits_back 2026-10-31-kimi-provider-design)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
FSQ=$(git rev-parse HEAD)
git push -q origin "${FSQ}:refs/heads/tmp/kimi-squash-front"
ssh dv@85.192.61.231 "cd ~/ci/wt/kimi-front && git fetch -q origin && git checkout -q --detach ${FSQ} && source ~/.nvm/nvm.sh && pnpm install --frozen-lockfile >/dev/null 2>&1; ./node_modules/.bin/vitest run 2>&1 | grep -aE 'Test Files|Tests '; node scripts/check-keys-exist.mjs && node scripts/check-locales.mjs && echo LOCALES_OK; npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'; pnpm build 2>&1 | tail -2"
```

Expected: vitest — как на `origin/main` плюс новые тесты, без новых падений; `LOCALES_OK`; tsc — не больше базы; сборка прошла. Затем:

```bash
git fetch -q origin && git merge-base --is-ancestor origin/main "${FSQ}" && git push origin "${FSQ}:refs/heads/main"
git push -q origin --delete tmp/kimi-squash-front
git checkout -q feat/kimi-provider
```

`merge-base` ложно — повторить Step 4 от свежего `origin/main`.

---

### Task 13: выкат — ТОЛЬКО С OK ВЛАДЕЛЬЦА НА КАЖДЫЙ ШАГ

Порядок по spec: релей **без ключа Kimi** первым (Kimi выключен; Qwen работает как прежде, кроме одного — сбой выбранного Qwen теперь переигрывается на Claude) → бэкенд и фронт (ключа Kimi нет — Kimi выключен) → **только после письменного подтверждения отказа Kimi от обучения** (решение владельца 31.10, spec «Соответствие концепции»; владелец пишет на support@moonshot.cn) — ключ Kimi в `.env` прода с перезапуском API и ключ на релей → проверки. Пришло подтверждение раньше Step 2 — Step 3 делается до Step 2, и отдельный перезапуск не нужен.

- [ ] **Step 1: Релей без ключа Kimi (OK)**

```bash
ssh dv@5.101.115.184 'cd ~/file-agent && git rev-parse --short HEAD && sha256sum server.mjs && git status --short'
```

HEAD `e5c2737` и sha256 = записанному в Task 10 Step 1 — иначе стоп (живой релей изменился, Task 10 — заново).

```bash
for f in llm-fallback.mjs llm-fallback.test.mjs; do ssh dv@5.101.115.184 "cat > ~/file-agent/${f}" < "${W}/${f}"; done
ssh dv@5.101.115.184 'cat > ~/file-agent/server.next.mjs' < "${W}/server.mjs"
ssh dv@5.101.115.184 'cd ~/file-agent && node --check server.next.mjs && echo CHECK_OK && node --test --test-reporter=tap llm-fallback.test.mjs 2>&1 | grep -aE "^# (pass|fail)"'
```

Expected: `CHECK_OK`, `# fail 0`. Затем:

```bash
ssh dv@5.101.115.184 'cd ~/file-agent && mv server.next.mjs server.mjs && git rm -q qwen-provider.mjs qwen-provider.test.mjs && git add server.mjs llm-fallback.mjs llm-fallback.test.mjs && git commit -q -m "релей: запасные Qwen → Kimi и выбор Kimi (provider=kimi); /health.fallback" && git log --oneline -1'
ssh dv@5.101.115.184 '[ -z "$(ps --ppid $(pm2 pid file-agent) -o pid=)" ] && pm2 restart file-agent >/dev/null && echo RESTARTED || echo BUSY'
```

`git add` — поимённо, не `-A`. `BUSY` — идут ходы: подождать и повторить только вторую команду (не рестартить при живых стримах). После рестарта:

```bash
ssh dv@5.101.115.184 'curl -s 127.0.0.1:3033/health'
```

Expected: `fallback.providers.qwen.enabled: true`, `fallback.providers.kimi.enabled: false`, рядом прежнее поле `qwen`.

- [ ] **Step 2: Бэкенд и фронт — `deploy.sh` (OK)** — с ноды из свежих клонов main, `SKIP_BOTS=1 SKIP_PRODUCTS_HOST=1`, отвязанно (`setsid -f`), слежение по логу; порядок и ловушки — память «Выкат: правила» и «deploy.sh: ловушки». После — сверить, что на проде `origin/main` с коммитом из Task 12 (бэк) и новый бандл фронта (память «Проверка выката»).

- [ ] **Step 3: Ключ Kimi в `.env` прода — ТОЛЬКО после подтверждения отказа Kimi от обучения (OK)** — через stdin; дописывается, только если его ещё нет:

```bash
python3 -c 'import os;print(open(os.path.expanduser("~/.linkeon/kimi.key")).read().strip())' \
 | ssh dvolkov@212.113.106.202 'cd ~/spirits_back && read -r K && if grep -q "^KIMI_FALLBACK_API_KEY=" .env; then echo "уже есть — стоп"; else [ -n "$(tail -c1 .env)" ] && echo >> .env; printf "KIMI_FALLBACK_API_KEY=%s\n" "$K" >> .env && grep -c "^KIMI_FALLBACK_API_KEY=" .env; fi'
```

Expected: `1`. На test ключ не кладётся (CLI там мёртв — всё ушло бы в цепочку). Если Step 2 уже прошёл — перезапуск API выкатом `deploy.sh` с `BACK_ONLY=1` (OK), иначе ключ подхватит выкат Step 2.

- [ ] **Step 4: Ключ Kimi на релей — ТОЛЬКО после подтверждения отказа Kimi от обучения (OK)**

```bash
python3 -c 'import os;print(open(os.path.expanduser("~/.linkeon/kimi.key")).read().strip())' \
 | ssh dv@5.101.115.184 'umask 077; read -r K && printf "%s" "$K" > ~/file-agent/secrets/kimi.key && stat -c "%a %s" ~/file-agent/secrets/kimi.key && grep -c "^secrets/" ~/file-agent/.gitignore && curl -s 127.0.0.1:3033/health | python3 -c "import json,sys; print(json.load(sys.stdin)[\"fallback\"][\"providers\"][\"kimi\"])"'
```

Expected: `600 72`, `1`, `{'enabled': True, …}`. Рестарт не нужен — ключ читается на каждом ходе.

- [ ] **Step 5: Проверки после выката**
  - прод, собранный сервис, выбор Kimi — скрипт в scratchpad `kimi-prod-check.js`:

```js
// Проверка выбора Kimi на проде из собранного сервиса. Ключи — из .env (не печатаются).
const fs = require('fs');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
}
const p = ['./dist/common/services/claude-cli.service.js', './dist/src/common/services/claude-cli.service.js'].find((f) => fs.existsSync(f));
const { ClaudeCliService } = require(p);
const svc = new ClaudeCliService();
svc.textWithCost('Ответь одним словом: ок', { model: 'claude-haiku-4-5', provider: 'kimi', timeoutMs: 120000 })
  .then((r) => console.log('OK', JSON.stringify(r), JSON.stringify(svc.fallbackStats().providers)))
  .catch((e) => console.log('FAIL', String(e.message).slice(0, 300)));
```

```bash
ssh dvolkov@212.113.106.202 'cd ~/spirits_back && node -' < /private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/2ee1bf56-31d4-4343-84d9-321f7e3c99d0/scratchpad/kimi-prod-check.js
```

Expected: `OK {"text":"ок"…}`, `kimi.enabled: true`.
  - владелец в админке выбирает себе «Kimi» (в карточке нет пометки «нет ключа») и пишет Роману, Маше, своему TG-боту; в `events` за последние полчаса: `chat_quality` с `provider: 'kimi', selected: 'kimi'` (Роман), `claude_cli_call` с `provider: 'kimi', fallback: false, selected: 'kimi'` (Маша, TG); в логе бэка — `llm_provider: <актор> → <id владельца> = kimi`;
  - `/health` релея: `fallback.providers.kimi.ok` не растёт от ходов владельца (ходы по выбору не считаются);
  - синтетика `chat_streaming` зелёная; в течение часа нет алерта «Релей: Claude недоступен».

- [ ] **Step 6: Память и уборка** — обновить `project_kimi_k3_via_claude_code.md` и `project_qwen_fallback_for_claude.md` (что на проде, где ключи, как проверять, итог проверки картинок из Task 7); снять воркдеревья на маке (`git worktree remove`) и ноде (`~/ci/wt/kimi-back`, `~/ci/wt/kimi-front`), scratchpad-копию релея `${W}`.
