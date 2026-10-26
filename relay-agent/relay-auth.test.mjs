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
