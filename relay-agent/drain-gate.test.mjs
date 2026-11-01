// node --test relay-agent/drain-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDrainGate } from "./drain-gate.mjs";

async function serve(drainPath) {
  const app = express();
  app.post("/chat", createDrainGate({ drainPath }), (req, res) => res.json({ ok: true }));
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-drain-test-"));
  return {
    dir,
    drainPath: path.join(dir, "relay-drain.marker"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("запрос между drain и PM2 restart отклоняется, /health остаётся доступен", async () => {
  const f = fixture();
  const s = await serve(f.drainPath);
  try {
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 200);
    fs.writeFileSync(f.drainPath, "rollout\n");
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 503);
    const health = await fetch(`${s.base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
  } finally {
    await s.close();
    f.cleanup();
  }
});

test("chat возобновляется только после снятия filesystem gate", async () => {
  const f = fixture();
  const s = await serve(f.drainPath);
  try {
    fs.writeFileSync(f.drainPath, "rollout\n");
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 503);
    fs.rmSync(f.drainPath);
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 200);
    fs.writeFileSync(f.drainPath, "another rollout\n");
    assert.equal((await fetch(`${s.base}/chat`, { method: "POST" })).status, 503);
  } finally {
    await s.close();
    f.cleanup();
  }
});
