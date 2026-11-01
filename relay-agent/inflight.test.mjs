// node --test relay-agent/inflight.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInflight } from "./inflight.mjs";
import { createDrainGate } from "./drain-gate.mjs";

test("upload, принятый до drain, виден в health до response finish и не даёт restart раньше времени", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inflight-test-"));
  const drainPath = path.join(dir, "drain.marker");
  const inflight = createInflight();
  const app = express();
  let uploadStarted;
  let releaseUpload;
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  const release = new Promise((resolve) => { releaseUpload = resolve; });
  app.post(
    "/chat",
    inflight.middleware,
    createDrainGate({ drainPath }),
    async (req, res, next) => {
      uploadStarted();
      await release;
      next();
    },
    (req, res) => res.json({ ok: true }),
  );
  app.get("/health", (req, res) => res.json({ status: "ok", inflight: inflight.count() }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pending = fetch(`${base}/chat`, { method: "POST" });
    await started;
    fs.writeFileSync(drainPath, "rollout\n");
    assert.equal((await fetch(`${base}/health`).then((r) => r.json())).inflight, 1);
    assert.equal((await fetch(`${base}/chat`, { method: "POST" })).status, 503);
    releaseUpload();
    assert.equal((await pending).status, 200);
    assert.equal((await fetch(`${base}/health`).then((r) => r.json())).inflight, 0);
  } finally {
    releaseUpload();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("close без finish тоже освобождает in-flight ровно один раз", () => {
  const inflight = createInflight();
  const listeners = {};
  const req = {};
  const res = { on: (event, fn) => { listeners[event] = fn; } };
  inflight.middleware(req, res, () => {});
  assert.equal(inflight.count(), 1);
  listeners.close();
  listeners.finish();
  assert.equal(inflight.count(), 0);
});
