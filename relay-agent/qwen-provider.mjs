// Qwen на релее: принудительный (выбор пользователя в админке бэкенда) и
// запасной (сбой доступа к Claude). Тот же claude и те же аргументы — другие
// модель и окружение процесса. Спецификация — spirits_back
// docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md. Те же правила,
// что у бэкенда (src/common/services/qwen-fallback.ts, src/common/llm-error.ts):
// меняешь здесь — сверь там.
import fs from "node:fs";

export const QWEN_DEFAULT_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
export const QWEN_DEFAULT_MODELS = Object.freeze({ opus: "qwen3.8-max", sonnet: "qwen3.8-flash", haiku: "qwen3.6-flash" });
// Ключ — файлом (600): читается на каждом ходе, сменить можно без рестарта;
// нет файла — Qwen на релее выключен целиком.
export const QWEN_DEFAULT_KEY_FILE = "/home/dv/file-agent/secrets/qwen.key";
export const QWEN_DEFAULT_BREAKER_MS = 5 * 60_000;
export const QWEN_STATS_WINDOW_MS = 15 * 60_000;
// После этих инструментов ход можно переиграть на Qwen: последствий нет.
export const SIDE_EFFECT_FREE_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

const trimmed = (v) => (v ?? "").toString().trim();

export function readQwenConfig(env = process.env, readFile = (p) => fs.readFileSync(p, "utf8")) {
  let apiKey = "";
  try { apiKey = trimmed(readFile(trimmed(env.QWEN_KEY_FILE) || QWEN_DEFAULT_KEY_FILE)); } catch { return null; }
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
    breakerMs: breakerRaw !== "" && Number.isFinite(breaker) && breaker >= 0 ? breaker : QWEN_DEFAULT_BREAKER_MS,
  };
}

export function qwenModelFor(requested, models) {
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
export function qwenSpawnEnv(base, cfg) {
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
    // падает (exit 1), и ход на Qwen возвращал пустой done (30.10). Ключ Qwen
    // при этом доступен Bash ассистента так же, как и прочие секреты релея на
    // диске (файл ключа, креды Claude) — защита одна на всех: песочница для Bash,
    // отдельная задача. '0' — поверх унаследованного значения.
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

// Сбой доступа к Claude: отказ CLI или ошибка со статусом входа/лимита/перегрузки.
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

export function pickProvider({ forced, cfg, breakerOpen, noFallback }) {
  if (!cfg || noFallback) return "claude";
  if (forced) return "qwen";
  return breakerOpen ? "qwen" : "claude";
}

export function mayFallback({ provider, cfg, noFallback, sentAnyText, riskyToolUsed }) {
  return provider === "claude" && !!cfg && !noFallback && !sentAnyText && !riskyToolUsed;
}

// Окно запасного Qwen на весь процесс: после сбоя доступа к Claude ходы идут
// сразу на Qwen. Закрывается успехом Claude, начатым после открытия окна, и
// любым сбоем аварийного хода на Qwen. Статистика — только аварийные ходы.
//
// lastOpenedAt/lastClaudeOkAt — отдельно от самого окна: окно истекает само
// через breakerMs, а монитор на бэкенде (relay-qwen-monitor.service.ts)
// должен понимать «отвечал ли Claude хоть раз с момента последнего сбоя»,
// даже когда окно уже закрылось сам по себе и свежих ходов на Qwen не было
// (ночь, редкие ходы) — иначе уходит ложное «Claude снова отвечает».
export function createQwenBreaker() {
  let openUntil = 0;
  let openedAt = 0;
  let lastOpenedAt = 0;
  let lastClaudeOkAt = 0;
  let outcomes = [];
  const prune = (now) => { outcomes = outcomes.filter((o) => o.at >= now - QWEN_STATS_WINDOW_MS); };
  return {
    isOpen: (now = Date.now()) => now < openUntil,
    open(ms, now = Date.now()) { openedAt = now; openUntil = now + ms; lastOpenedAt = now; },
    // lastClaudeOkAt — по НАЧАЛУ хода (startedAt), не по его завершению: ход,
    // начатый до открытия окна и закончившийся успехом после, не доказывает,
    // что Claude ожил, — то же правило, по которому ниже закрывается окно.
    // Math.max — не сдвигать lastClaudeOkAt назад, если ходы завершаются не
    // по порядку начала (параллельные чаты).
    claudeSucceeded(startedAt) {
      lastClaudeOkAt = Math.max(lastClaudeOkAt, startedAt);
      if (startedAt >= openedAt) openUntil = 0;
    },
    qwenFinished(ok, now = Date.now()) {
      outcomes.push({ at: now, ok });
      prune(now);
      if (!ok) openUntil = 0;
    },
    stats(now = Date.now()) {
      prune(now);
      const ok = outcomes.filter((o) => o.ok).length;
      return {
        ok,
        failed: outcomes.length - ok,
        windowMs: QWEN_STATS_WINDOW_MS,
        breakerOpenUntil: openUntil > now ? openUntil : 0,
        lastOpenedAt,
        lastClaudeOkAt,
      };
    },
  };
}
