import { test } from "node:test";
import assert from "node:assert/strict";
import * as q from "./qwen-provider.mjs";

const MODELS = { opus: "qwen3.8-max", sonnet: "qwen3.8-flash", haiku: "qwen3.6-flash" };
const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

test("readQwenConfig: нет файла или пустой — null", () => {
  assert.equal(q.readQwenConfig({}, missing), null);
  assert.equal(q.readQwenConfig({}, () => "  \n"), null);
});

test("readQwenConfig: значения по умолчанию, ключ без пробелов, путь по умолчанию", () => {
  let asked;
  const cfg = q.readQwenConfig({}, (p) => { asked = p; return " sk-sp-x \n"; });
  assert.equal(asked, q.QWEN_DEFAULT_KEY_FILE);
  assert.deepEqual(cfg, { apiKey: "sk-sp-x", baseUrl: q.QWEN_DEFAULT_BASE_URL, models: MODELS, breakerMs: 300000 });
});

test("readQwenConfig: путь и переопределения из env", () => {
  let asked;
  const cfg = q.readQwenConfig({
    QWEN_KEY_FILE: "/k", QWEN_FALLBACK_BASE_URL: "https://x/apps/anthropic",
    QWEN_FALLBACK_MODEL_OPUS: "m", QWEN_FALLBACK_BREAKER_MS: "0",
  }, (p) => { asked = p; return "k"; });
  assert.equal(asked, "/k");
  assert.equal(cfg.baseUrl, "https://x/apps/anthropic");
  assert.equal(cfg.models.opus, "m");
  assert.equal(cfg.breakerMs, 0);
  assert.equal(q.readQwenConfig({ QWEN_FALLBACK_BREAKER_MS: "abc" }, () => "k").breakerMs, 300000);
});

test("qwenModelFor", () => {
  for (const [req, want] of [["default", "qwen3.8-max"], ["opus", "qwen3.8-max"], ["claude-opus-5-5", "qwen3.8-max"],
    ["sonnet", "qwen3.8-flash"], ["claude-sonnet-5", "qwen3.8-flash"], ["haiku", "qwen3.6-flash"], ["Claude-Haiku-4-5", "qwen3.6-flash"]]) {
    assert.equal(q.qwenModelFor(req, MODELS), want, req);
  }
});

test("withModel: меняет только значение --model, исходный массив цел", () => {
  const args = ["--print", "--model", "default", "--max-turns", "40"];
  assert.deepEqual(q.withModel(args, "qwen3.8-max"), ["--print", "--model", "qwen3.8-max", "--max-turns", "40"]);
  assert.equal(args[2], "default");
});

test("qwenSpawnEnv: снимает ANTHROPIC_* и OAuth-токен, ставит Alibaba", () => {
  const cfg = q.readQwenConfig({}, () => "sk-sp-x");
  const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "old", CLAUDE_CODE_OAUTH_TOKEN: "o" };
  const env = q.qwenSpawnEnv(base, cfg);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, q.QWEN_DEFAULT_BASE_URL);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-sp-x");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen3.6-flash");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.API_TIMEOUT_MS, "300000");
  assert.equal(base.ANTHROPIC_API_KEY, "old");
});

test("qwenSpawnEnv: вычистка окружения подпроцессов выключена явно (SCRUB=1 без bwrap роняет CLI)", () => {
  const cfg = q.readQwenConfig({}, () => "sk-sp-x");
  assert.equal(q.qwenSpawnEnv({}, cfg).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "0");
  assert.equal(q.qwenSpawnEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }, cfg).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "0");
});

test("looksLikeCliRefusal", () => {
  for (const t of ["Not logged in · Please run /login", "You've hit your session limit · resets 3am (UTC)",
    "You’ve hit your limit · resets 3am", "Claude AI usage limit reached|1730000000", "OAuth token has expired"]) {
    assert.equal(q.looksLikeCliRefusal(t), true, t);
  }
  for (const t of ["Это значит, что ключ неверный: Invalid API key", "Invalid API key — так ответил сервис",
    "Ответ: hit your usage limit", "x".repeat(301) + " Not logged in", ""]) {
    assert.equal(q.looksLikeCliRefusal(t), false, t.slice(0, 40));
  }
});

test("isAccessFailure", () => {
  assert.equal(q.isAccessFailure("Not logged in · Please run /login"), true);
  assert.equal(q.isAccessFailure("API Error: 429 Too Many Requests", { isError: true }), true);
  assert.equal(q.isAccessFailure("boom", { isError: true, apiStatus: 529 }), true);
  assert.equal(q.isAccessFailure("API Error: 401 Unauthorized", { isError: true }), true);
  assert.equal(q.isAccessFailure("API Error: 429", { isError: false }), false);
  assert.equal(q.isAccessFailure("Prompt is too long: 250000 tokens", { isError: true, apiStatus: 400 }), false);
  assert.equal(q.isAccessFailure("Context window exceeded · try again", { isError: true }), false);
  assert.equal(q.isAccessFailure("обычный ответ ассистента"), false);
});

test("isAccessFailure: статус 429/529/401/403 ошибки — раньше признаков длины контекста", () => {
  const perMinute = "API Error: 429 This request would exceed the rate limit of 400,000 output tokens per minute";
  assert.equal(q.isAccessFailure(perMinute, { isError: true, apiStatus: 429 }), true);
  assert.equal(q.isAccessFailure("overloaded: context window busy", { isError: true, apiStatus: 529 }), true);
  // Без статуса текст о длине контекста — по-прежнему не сбой доступа.
  assert.equal(q.isAccessFailure(perMinute, { isError: true }), false);
  // Статус без признака ошибки — не сбой.
  assert.equal(q.isAccessFailure(perMinute, { isError: false, apiStatus: 429 }), false);
});

test("pickProvider", () => {
  const cfg = { apiKey: "k" };
  assert.equal(q.pickProvider({ forced: true, cfg, breakerOpen: false, noFallback: false }), "qwen");
  assert.equal(q.pickProvider({ forced: false, cfg, breakerOpen: true, noFallback: false }), "qwen");
  assert.equal(q.pickProvider({ forced: false, cfg, breakerOpen: false, noFallback: false }), "claude");
  assert.equal(q.pickProvider({ forced: true, cfg: null, breakerOpen: true, noFallback: false }), "claude");
  assert.equal(q.pickProvider({ forced: true, cfg, breakerOpen: true, noFallback: true }), "claude");
});

test("mayFallback", () => {
  const ok = { provider: "claude", cfg: { apiKey: "k" }, noFallback: false, sentAnyText: false, riskyToolUsed: false };
  assert.equal(q.mayFallback(ok), true);
  assert.equal(q.mayFallback({ ...ok, provider: "qwen" }), false);
  assert.equal(q.mayFallback({ ...ok, cfg: null }), false);
  assert.equal(q.mayFallback({ ...ok, noFallback: true }), false);
  assert.equal(q.mayFallback({ ...ok, sentAnyText: true }), false);
  assert.equal(q.mayFallback({ ...ok, riskyToolUsed: true }), false);
});

test("SIDE_EFFECT_FREE_TOOLS", () => {
  for (const t of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]) assert.equal(q.SIDE_EFFECT_FREE_TOOLS.has(t), true);
  for (const t of ["Bash", "Write", "mcp__linkeon__generate_image", "mcp__products__manage_product"]) assert.equal(q.SIDE_EFFECT_FREE_TOOLS.has(t), false);
});

test("createQwenBreaker: открытие, закрытие, статистика", () => {
  const b = q.createQwenBreaker();
  assert.equal(b.isOpen(1000), false);
  b.open(60000, 1000); // lastOpenedAt = 1000
  assert.equal(b.isOpen(2000), true);
  b.claudeSucceeded(500); // ход начат до открытия — окно не закрывает; lastClaudeOkAt = startedAt (500), не момент завершения
  assert.equal(b.isOpen(2000), true);
  assert.equal(b.stats(2000).lastClaudeOkAt, 500);
  b.claudeSucceeded(1500); // начат после открытия — закрывает; lastClaudeOkAt = startedAt (1500)
  assert.equal(b.isOpen(2200), false);
  assert.equal(b.stats(2200).lastClaudeOkAt, 1500);
  b.open(60000, 3000); // новое открытие — lastOpenedAt двигается вперёд
  assert.equal(b.stats(3000).lastOpenedAt, 3000);
  b.qwenFinished(true, 4000);
  assert.equal(b.isOpen(5000), true);
  b.qwenFinished(false, 5000); // сбой Qwen закрывает окно
  assert.equal(b.isOpen(5001), false);
  assert.deepEqual(b.stats(6000), { ok: 1, failed: 1, windowMs: q.QWEN_STATS_WINDOW_MS, breakerOpenUntil: 0, lastOpenedAt: 3000, lastClaudeOkAt: 1500 });
  assert.deepEqual(b.stats(6000 + q.QWEN_STATS_WINDOW_MS), { ok: 0, failed: 0, windowMs: q.QWEN_STATS_WINDOW_MS, breakerOpenUntil: 0, lastOpenedAt: 3000, lastClaudeOkAt: 1500 });
});

test("createQwenBreaker: lastClaudeOkAt — по началу хода, не по завершению (ход начат до открытия окна и успешен после — не доказывает, что Claude ожил)", () => {
  const b = q.createQwenBreaker();
  b.open(60000, 1000); // окно открылось в 1000 (сбой Claude)
  // Ход стартовал раньше сбоя (900) и завершился успехом уже после открытия
  // окна. Один аргумент — как вызывает server.mjs: claudeSucceeded(r.startedAt).
  b.claudeSucceeded(900);
  const { lastClaudeOkAt, lastOpenedAt } = b.stats(5000);
  assert.ok(lastClaudeOkAt < lastOpenedAt, `${lastClaudeOkAt} not < ${lastOpenedAt}`);
  assert.equal(b.isOpen(5000), true); // такой «успех» окно не закрывает
});
