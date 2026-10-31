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
// AccessDenied (Qwen с неоплаченным планом — 403 AccessDenied.Unpurchased) и
// Arrearage (долг у Alibaba) — тоже сбой доступа, как у бэкенда (isFallbackWorthy).
const ACCESS_TEXT_RE = /\b(401|403|429|529)\b|Unauthorized|Forbidden|access.?denied|arrearage|rate.?limit|overloaded/i;

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

// Сбой доступа, который штатно НЕ повторяют (в отличие от 401/429/5xx/network —
// те TRANSIENT_RE в server.mjs гоняет на повтор): 403 (в т.ч. Qwen Token Plan
// AccessDenied.Unpurchased), Forbidden, Arrearage (долг у Alibaba). Повторный
// запуск того же провайдера тут бессмыслен — переходить к следующему в плане
// сразу, не дожидаясь штатного повтора.
export const NON_RETRY_ACCESS_RE = /\b403\b|forbidden|access.?denied|arrearage/i;
export const isNonRetryAccess = (text) => NON_RETRY_ACCESS_RE.test(trimmed(text));

/** Событие result с ошибкой, но без текста (например subtype "error_during_execution":
 *  причина — в errors[], поля result нет). Потолок шагов (error_max_turns) — не сбой.
 *  Условие `ev.result` (истинность) — то же, что у ветки `ev.type === "result" && ev.result`
 *  в server.mjs: случаи взаимоисключающие, событие с текстом разбирает та ветка. */
export function isErrorWithoutText(ev) {
  if (!ev || ev.type !== "result" || ev.result) return false;
  if (ev.subtype === "error_max_turns") return false;
  return ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success") || !!ev.api_error_status;
}

// План хода (spec, раздел 3) — как planProviders бэкенда.
export function planProviders({ selected = "", cfgs, state, noFallback = false, now = Date.now() }) {
  if (noFallback) return ["claude"];
  const normal = (exclude) => {
    const alts = FALLBACK_ORDER.filter((n) => n !== exclude && !!cfgs[n] && !state.isDown(n, now));
    return state.claudeWindowOpen(now) && alts.length > 0 ? [...alts] : ["claude", ...alts];
  };
  // FALLBACK_ORDER.includes — раньше, чем обращение к cfgs[selected]: иначе
  // "constructor"/"__proto__" читают прототип Object, а не отсутствие ключа
  // (паритет с бэкендом, src/common/services/llm-fallback.ts).
  if (FALLBACK_ORDER.includes(selected) && cfgs[selected]) return [selected, ...normal(selected)];
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
