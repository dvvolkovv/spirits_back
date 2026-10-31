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

/** 403/Forbidden/Access denied/Arrearage — classifyLlmError этого не видит (он
 *  понимает только формулировки самого Claude), а у запасных это тоже сбой
 *  доступа: Qwen Token Plan с неоплаченным планом отвечает
 *  403 AccessDenied.Unpurchased, Alibaba при долге — Arrearage; на релее
 *  403/Forbidden уже считаются сбоем доступа — здесь та же логика для бэкенда. */
const ACCESS_EXTRA_RE = /\b403\b|forbidden|access.?denied|arrearage/i;

export function isFallbackWorthy(errorMessage: string): boolean {
  if (CONTEXT_LENGTH_RE.test(errorMessage)) return false;
  if (ACCESS_EXTRA_RE.test(errorMessage)) return true;
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
    this.prune(now); // попутно чистит исходы старше окна статистики — намеренно
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
  // Истинностью, не !== null: незнакомое значение selected (например, мусор из
  // БД) даёт configs[selected] === undefined, а undefined !== null — истина,
  // и мусор встал бы первым в план. FALLBACK_ORDER.includes — отдельная защита:
  // имя из прототипа объекта (например 'constructor') даёт configs[selected]
  // правду через цепочку прототипов, а не null/undefined, и первую проверку
  // не ловит вовсе.
  if (args.selected && FALLBACK_ORDER.includes(args.selected) && args.configs[args.selected]) {
    return [args.selected, ...normal(args.selected)];
  }
  return normal();
}
