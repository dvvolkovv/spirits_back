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

test("withModel: без --model в аргументах — массив не меняется", () => {
  assert.deepEqual(l.withModel(["--print", "--max-turns", "40"], "k3.1-pro"), ["--print", "--max-turns", "40"]);
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
  assert.equal(l.isAccessFailure('API Error: 403 {"code":"AccessDenied.Unpurchased"}', { isError: true }), true);
  assert.equal(l.isAccessFailure("API Error: 400 Arrearage: account overdue", { isError: true }), true);
});

test("isAccessFailure: статус 429/529/401/403 — раньше признаков длины контекста", () => {
  const perMinute = "API Error: 429 This request would exceed the rate limit of 400,000 output tokens per minute";
  assert.equal(l.isAccessFailure(perMinute, { isError: true, apiStatus: 429 }), true);
  assert.equal(l.isAccessFailure("overloaded: context window busy", { isError: true, apiStatus: 529 }), true);
  assert.equal(l.isAccessFailure(perMinute, { isError: true }), false);
  assert.equal(l.isAccessFailure(perMinute, { isError: false, apiStatus: 429 }), false);
});

test("isNonRetryAccess: 403/Forbidden/Arrearage — true; 429/529/длина контекста — false", () => {
  for (const t of ['API Error: 403 {"code":"AccessDenied.Unpurchased"}', "Forbidden", "400 Arrearage: account overdue"]) {
    assert.equal(l.isNonRetryAccess(t), true, t);
  }
  for (const t of ["API Error: 429 Too Many Requests", "overloaded: 529", "Context window exceeded · try again"]) {
    assert.equal(l.isNonRetryAccess(t), false, t);
  }
});

test("isErrorWithoutText: ошибка без текста — error_during_execution с errors[], api_error_status, пустой result", () => {
  assert.equal(l.isErrorWithoutText({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 500 Internal server error"] }), true);
  assert.equal(l.isErrorWithoutText({ type: "result", api_error_status: 500 }), true);
  assert.equal(l.isErrorWithoutText({ type: "result", is_error: true, result: "" }), true);
});

test("isErrorWithoutText: текст в result, успех, потолок шагов, не result, null/undefined — нет", () => {
  // С текстом — дело ветки `result && ev.result` в server.mjs, не этой проверки.
  assert.equal(l.isErrorWithoutText({ type: "result", is_error: true, result: "API Error: 500" }), false);
  assert.equal(l.isErrorWithoutText({ type: "result", subtype: "success", is_error: false }), false);
  // Потолок шагов — не сбой: ход продолжается тем же --resume.
  assert.equal(l.isErrorWithoutText({ type: "result", subtype: "error_max_turns", is_error: true }), false);
  assert.equal(l.isErrorWithoutText({ type: "assistant", is_error: true }), false);
  assert.equal(l.isErrorWithoutText(null), false);
  assert.equal(l.isErrorWithoutText(undefined), false);
});

// Так errors[] собирает CLI 2.1.x: первой — диагностика, дальше — ошибки хода
// (error.stack || error.message, со строками стека).
const DIAG = "[ede_diagnostic] result_type=user last_content_type=tool_result stop_reason=null";

test("safeErrorDetail: status N — только целое 100…599", () => {
  assert.equal(l.safeErrorDetail({ type: "result", is_error: true, api_error_status: 500 }), "status 500");
  for (const st of ["500", "abc", 99, 600, 500.5, NaN, null, true, {}]) {
    assert.equal(l.safeErrorDetail({ type: "result", is_error: true, api_error_status: st }), "", String(st));
  }
});

test("safeErrorDetail: строка [ede_diagnostic] из errors[] — проходит; со статусом — через «, »", () => {
  const ev = { type: "result", subtype: "error_during_execution", is_error: true, errors: [DIAG, "Error: Request was aborted."] };
  assert.equal(l.safeErrorDetail(ev), DIAG);
  assert.equal(l.safeErrorDetail({ ...ev, api_error_status: 529 }), "status 529, " + DIAG);
  // Не первым элементом — тоже находится.
  assert.equal(l.safeErrorDetail({ errors: ["Error: x", DIAG] }), DIAG);
  // Длинная — не длиннее 160.
  const long = "[ede_diagnostic]" + " k=v".repeat(100);
  assert.equal(l.safeErrorDetail({ errors: [long] }), long.slice(0, 160));
});

test("safeErrorDetail: диагностика с пробелом, кавычкой или переводом строки в значении — не пишется вовсе", () => {
  for (const bad of [
    "[ede_diagnostic] result_type=user stop_reason=end turn",
    '[ede_diagnostic] result_type="user" stop_reason=null',
    "[ede_diagnostic] result_type=it's stop_reason=null",
    "[ede_diagnostic] result_type=user\nstop_reason=null",
    "[ede_diagnostic] result_type=user stop_reason=null ",
  ]) {
    assert.equal(l.safeErrorDetail({ errors: [bad] }), "", JSON.stringify(bad));
    assert.equal(l.safeErrorDetail({ errors: [bad], api_error_status: 500 }), "status 500", JSON.stringify(bad));
  }
  // Берётся первая строка с [ede_diagnostic]; не прошла проверку — не ищем дальше.
  assert.equal(l.safeErrorDetail({ errors: ['[ede_diagnostic] a="x"', DIAG] }), "");
});

test("safeErrorDetail: в значении путь, адрес, «=», кириллица; ключ не из [a-z_] — диагностика не пишется", () => {
  for (const bad of [
    "[ede_diagnostic] a=/home/u/doc.pdf",
    "[ede_diagnostic] a=x@y.ru",
    "[ede_diagnostic] a=b=c",
    "[ede_diagnostic] a=привет",
    "[ede_diagnostic] любой текст=x",
    // Ключ с пробелом — латиницей: кириллица выше отсекается на первой букве и
    // до пробела не доходит.
    "[ede_diagnostic] any text=x",
    "[ede_diagnostic] A=1",
  ]) {
    assert.equal(l.safeErrorDetail({ errors: [bad] }), "", bad);
  }
});

// Сторож на время. Шаблон вида \s*[\r\n]+\s* на полосе пробелов без перевода
// строки квадратичен: 4e4 пробелов — 1,9 с, 1e5 — секунды. Случай " ".repeat(1e5)
// без префикса сторожит нормализацию всех errors[] до поиска диагностики, случаи
// с префиксом [ede_diagnostic] — саму EDE_DIAGNOSTIC_RE. Время — процессорное, не
// настенное: тест идёт и на живом релее перед рестартом, где вытеснение процесса
// и steal у VPS дали бы ложный красный и остановили выкат. Обычно — единицы мс.
test("safeErrorDetail: длинные строки без перевода строки — без зависания (сторож на время)", () => {
  const valid = "[ede_diagnostic]" + " a=b".repeat(25_000);
  for (const [s, want] of [
    [" ".repeat(1e5), ""],
    ["[ede_diagnostic]" + " ".repeat(1e5) + "x", ""],
    ["[ede_diagnostic]" + " a=b".repeat(25_000) + "!", ""],
    ["[ede_diagnostic] a=" + "b".repeat(1e5) + " ", ""],
    [valid, valid.slice(0, 160)],
  ]) {
    const c0 = process.cpuUsage();
    const got = l.safeErrorDetail({ errors: [s] });
    const { user, system } = process.cpuUsage(c0);
    const ms = (user + system) / 1000;
    assert.equal(got, want, JSON.stringify(s.slice(0, 40)));
    assert.ok(ms < 200, `${ms.toFixed(1)} мс процессора на строке длиной ${s.length}`);
  }
});

test("safeErrorDetail: не строки в errors[] (null, число, объект) пропускаются, диагностика за ними находится", () => {
  assert.equal(l.safeErrorDetail({ type: "result", subtype: "error_during_execution", is_error: true, errors: [null, 42, { code: "E1" }, DIAG] }), DIAG);
});

test("safeErrorDetail: ни result, ни обычные строки errors[] (стек с путём файла) в журнал не попадают", () => {
  assert.equal(l.safeErrorDetail({ type: "result", is_error: true, result: 'API Error: 400 {"message":"bad input: привет"}' }), "");
  assert.equal(l.safeErrorDetail({
    type: "result", subtype: "error_during_execution", is_error: true,
    errors: ["Error: ENOENT: no such file or directory, open '/home/dv/file-agent/uploads/u-1/doc.pdf'\n    at open (/x.js:1:1)"],
  }), "");
  assert.equal(l.safeErrorDetail({ type: "result", is_error: true, api_error_status: 400, result: "API Error: 400 bad input" }), "status 400");
});

test("safeErrorDetail: null, undefined, событие без полей, errors не массив — пустая строка", () => {
  for (const ev of [null, undefined, {}, { type: "result" }, { errors: DIAG }, { errors: null }]) {
    assert.equal(l.safeErrorDetail(ev), "", JSON.stringify(ev));
  }
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

test("planProviders: выбранное имя — только известный провайдер (constructor — не провайдер, защита от прототипа)", () => {
  const cfg = (name) => ({ name, apiKey: "k", baseUrl: "u", models: KIMI_MODELS });
  const both = { qwen: cfg("qwen"), kimi: cfg("kimi") };
  assert.deepEqual(l.planProviders({ selected: "constructor", cfgs: both, state: l.createFallbackState(), now: 10_000 }), ["claude", "qwen", "kimi"]);
});

test("planProviders: выбран Qwen", () => {
  const cfg = (name) => ({ name, apiKey: "k", baseUrl: "u", models: KIMI_MODELS });
  const both = { qwen: cfg("qwen"), kimi: cfg("kimi") };
  assert.deepEqual(l.planProviders({ selected: "qwen", cfgs: both, state: l.createFallbackState(), now: 10_000 }), ["qwen", "claude", "kimi"]);
});

test("planProviders: выбран Kimi, окно Claude открыто, Qwen «не отвечает» — [kimi, claude]", () => {
  const cfg = (name) => ({ name, apiKey: "k", baseUrl: "u", models: KIMI_MODELS });
  const both = { qwen: cfg("qwen"), kimi: cfg("kimi") };
  const T = 10_000;
  const s = l.createFallbackState();
  s.openClaudeWindow(60_000, T);
  s.markDown("qwen", 60_000, T);
  assert.deepEqual(l.planProviders({ selected: "kimi", cfgs: both, state: s, now: T + 1 }), ["kimi", "claude"]);
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

test("createFallbackState: markDown(…, 0) — сразу «отвечает»; downUntil истекает ровно по границе", () => {
  const s = l.createFallbackState();
  s.markDown("qwen", 0, 1000);
  assert.equal(s.isDown("qwen", 1000), false);
  s.markDown("kimi", 1000, 1000);
  assert.equal(s.isDown("kimi", 1999), true);
  assert.equal(s.isDown("kimi", 2000), false);
});
