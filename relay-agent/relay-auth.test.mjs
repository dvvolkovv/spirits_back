// node --test relay-agent/relay-auth.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { parseSecrets, parseMode, isAuthorized, createRelayAuth } from "./relay-auth.mjs";

test("parseSecrets: строки без пустых и комментариев", () => {
  assert.deepEqual(parseSecrets("# прод\naaa\n\n  bbb  \n#x\n"), ["aaa", "bbb"]);
  assert.deepEqual(parseSecrets(""), []);
});

test("parseMode: только enforce включает отказ, остальное — log", () => {
  assert.equal(parseMode("enforce\n"), "enforce");
  assert.equal(parseMode("log"), "log");
  assert.equal(parseMode("ENFORCE"), "log");
  assert.equal(parseMode(""), "log");
});

test("isAuthorized: совпадение с любым из списка", () => {
  assert.equal(isAuthorized("bbb", ["aaa", "bbb"]), true);
  assert.equal(isAuthorized("ccc", ["aaa", "bbb"]), false);
  assert.equal(isAuthorized("", ["aaa"]), false);
  assert.equal(isAuthorized(undefined, ["aaa"]), false);
  assert.equal(isAuthorized("aaa", []), false);
});

// Настоящий Express: middleware + маршруты, как в server.mjs.
async function serve(files, nowRef) {
  const logs = [];
  const app = express();
  app.use(createRelayAuth({
    secretsPath: "S", modePath: "M",
    readFile: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
    now: () => nowRef.t,
    log: (line) => logs.push(line),
  }));
  app.post("/chat", (req, res) => res.json({ ok: true }));
  app.get("/session/:sid/files", (req, res) => res.json([]));
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/files/x.txt", (req, res) => res.send("file"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs, close: () => new Promise((r) => server.close(r)) };
}

test("log: без секрета проходит и пишет строку без значения заголовка", async () => {
  const t = { t: 0 };
  const s = await serve({ S: "good\n", M: "log\n" }, t);
  try {
    const r = await fetch(`${s.base}/chat`, { method: "POST", headers: { "X-Agent-Secret": "bad-value" } });
    assert.equal(r.status, 200);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /relay-auth: отказ был бы \(неверный\)/);
    assert.equal(s.logs[0].includes("bad-value"), false);
  } finally { await s.close(); }
});

test("enforce: без секрета 401, с верным — проходит; /health и /files без проверки", async () => {
  const t = { t: 0 };
  const s = await serve({ S: "good\nother\n", M: "enforce" }, t);
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${s.base}/session/abc/files`)).status, 401);
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST", headers: { "X-Agent-Secret": "other" } })).status, 200);
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    assert.equal((await fetch(`${s.base}/files/x.txt`)).status, 200);
  } finally { await s.close(); }
});

test("файлы перечитываются не чаще раза в 30 с; нет файла режима — log", async () => {
  const files = { S: "good", M: "enforce" };
  const t = { t: 0 };
  const s = await serve(files, t);
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 401);
    delete files.M;                       // режим убрали — но кэш ещё жив
    t.t = 10_000;
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 401);
    t.t = 31_000;                         // прошло 30 с — перечитали, файла нет → log
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 200);
  } finally { await s.close(); }
});

test("enforce без единого секрета — отказ всем (безопасное умолчание)", async () => {
  const s = await serve({ M: "enforce" }, { t: 0 });
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST", headers: { "X-Agent-Secret": "x" } })).status, 401);
  } finally { await s.close(); }
});

// Прямые вызовы middleware (без сети) — для проверки тихого отчёта о
// переменах конфигурации: изолируют лог перечитывания от логов самой
// авторизации (их отключаем, всегда посылая верный секрет).
const LONG_A = "a".repeat(40);
const LONG_B = "b".repeat(40);

function fakeCall(mw, { headers = {} } = {}) {
  let status = null;
  let nextCalled = false;
  const req = {
    method: "POST",
    path: "/chat",
    get: (name) => headers[name.toLowerCase()],
    socket: { remoteAddress: "9.9.9.9" },
  };
  const res = { status: (c) => { status = c; return { json: () => {} }; } };
  mw(req, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

test("тихий отчёт о переменах: молчит на первой загрузке и без изменений", () => {
  const logs = [];
  const files = { S: `${LONG_A}\n`, M: "log\n" };
  const t = { t: 0 };
  const mw = createRelayAuth({
    secretsPath: "S", modePath: "M",
    readFile: (p) => { if (!(p in files)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return files[p]; },
    now: () => t.t, log: (l) => logs.push(l),
  });
  const call = () => fakeCall(mw, { headers: { "x-agent-secret": LONG_A } });

  assert.equal(call().nextCalled, true);     // первая загрузка — молча
  assert.deepEqual(logs, []);
  t.t = 31_000;
  assert.equal(call().nextCalled, true);     // перечитали — без изменений
  assert.deepEqual(logs, []);
});

test("тихий отчёт о переменах: лог при смене режима и числа секретов", () => {
  const logs = [];
  const files = { S: `${LONG_A}\n`, M: "log\n" };
  const t = { t: 0 };
  const mw = createRelayAuth({
    secretsPath: "S", modePath: "M",
    readFile: (p) => files[p],
    now: () => t.t, log: (l) => logs.push(l),
  });
  const call = () => fakeCall(mw, { headers: { "x-agent-secret": LONG_A } });

  call();                                    // первая загрузка — молча
  assert.deepEqual(logs, []);

  files.M = "enforce\n";
  t.t = 31_000;
  call();                                    // режим поменялся
  assert.deepEqual(logs, ["relay-auth: режим enforce, секретов 1"]);

  files.S = `${LONG_A}\n${LONG_B}\n`;
  t.t = 62_000;
  call();                                    // секретов стало больше
  assert.deepEqual(logs, [
    "relay-auth: режим enforce, секретов 1",
    "relay-auth: режим enforce, секретов 2",
  ]);
});

test("тихий отчёт о переменах: ошибка чтения — код один раз, без повтора", () => {
  const logs = [];
  const t = { t: 0 };
  let secretsBroken = false;
  const mw = createRelayAuth({
    secretsPath: "S", modePath: "M",
    readFile: (p) => {
      if (p === "M") return "enforce\n";
      if (secretsBroken) { const e = new Error("permission denied"); e.code = "EACCES"; throw e; }
      return `${LONG_A}\n`;
    },
    now: () => t.t, log: (l) => logs.push(l),
  });
  const call = () => fakeCall(mw, { headers: {} });

  call();                                    // первая загрузка — молча
  secretsBroken = true;
  t.t = 31_000;
  call();                                    // ошибка появилась
  assert.deepEqual(logs.filter((l) => l.includes("relay-secrets")), ["relay-auth: relay-secrets: EACCES"]);

  t.t = 62_000;
  call();                                    // та же ошибка снова — не повторяем
  assert.equal(logs.filter((l) => l.includes("relay-secrets")).length, 1);
});
