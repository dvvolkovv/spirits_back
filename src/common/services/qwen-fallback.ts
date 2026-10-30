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
/** Нижняя граница таймаута запасного вызова: Qwen нужно время ответить, даже
 *  когда попытка Claude съела почти весь бюджет. */
export const QWEN_MIN_FALLBACK_TIMEOUT_MS = 60_000;

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

/** Ошибки длины контекста — свойство самого запроса, а не доступа к Claude:
 *  Qwen их не исправит, а «limit reached» / «try again» в них классификатор
 *  принял бы за лимит или перегрузку и открыл бы окно для всех. */
const CONTEXT_LENGTH_RE = /context (window|length|limit)|prompt is too long|output token|max_tokens/i;

export function isFallbackWorthy(errorMessage: string): boolean {
  if (CONTEXT_LENGTH_RE.test(errorMessage)) return false;
  return FALLBACK_KINDS.has(classifyLlmError(errorMessage).kind);
}

/**
 * Таймаут запасного вызова: остаток бюджета вызова после упавшей попытки
 * Claude (на 429/529 CLI сам повторяет запрос, и попытка бывает долгой — ход
 * не должен растягиваться вдвое), но не меньше минуты, а при бюджете меньше
 * минуты — весь бюджет. 0 (и меньше) — без таймаута, как в spawnClaude.
 */
export function fallbackTimeoutMs(timeoutMs: number, elapsedMs: number): number {
  if (!(timeoutMs > 0)) return 0;
  return Math.max(timeoutMs - elapsedMs, Math.min(timeoutMs, QWEN_MIN_FALLBACK_TIMEOUT_MS));
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
    // Таймаут одного запроса к API: без него ход без таймаута (TG, timeoutMs: 0) на зависшем Alibaba висел бы до 2×600 с.
    API_TIMEOUT_MS: '300000',
    // Без этого ключ Alibaba виден подпроцессам инструментов (Bash: printenv,
    // env и т.п.) — проверено 30.10 на CLI 2.1.280. Любой пользователь
    // веб-чата мог бы попросить ассистента выполнить env и унести ключ.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  };
}
