// node --test relay-agent/stop-my-jobs.test.mjs
//
// Как и proc-reaper.test.mjs — на живых процессах, только Linux. Команду
// запускаем так же, как её запустит модель: отдельным процессом с меткой хода
// в окружении.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { spawn, execFile } from "child_process";
import { randomUUID } from "crypto";
import { RUN_ENV, runTag, taggedProcesses } from "./proc-reaper.mjs";

const HELPER = new URL("./stop-my-jobs.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function orphanTree(tag, script) {
  spawn("setsid", ["bash", "-c", script], {
    env: { ...process.env, [RUN_ENV]: tag },
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function pidsOf(tag, cmd, want) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const pids = [];
    for (const p of await taggedProcesses()) {
      if (p.tag !== tag) continue;
      try {
        if (fs.readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0").join(" ").trim() === cmd) pids.push(p.pid);
      } catch {}
    }
    if (pids.length >= want || Date.now() > deadline) return pids;
    await sleep(50);
  }
}

function gone(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z";
  } catch {
    return true;
  }
}

function run(args, tag) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (tag) env[RUN_ENV] = tag; else delete env[RUN_ENV];
    execFile("node", [HELPER, ...args], { env }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const killAll = (pids) => pids.forEach((p) => { try { process.kill(p, "SIGKILL"); } catch {} });

test("гасит только свои процессы с этой частью команды; чужой разговор цел", async () => {
  const mine = runTag(randomUUID());
  const other = runTag(randomUUID());
  orphanTree(mine, "sleep 611 & sleep 612 & wait");
  orphanTree(other, "sleep 611 & wait");
  const [mine611] = await pidsOf(mine, "sleep 611", 1);
  const [mine612] = await pidsOf(mine, "sleep 612", 1);
  const [other611] = await pidsOf(other, "sleep 611", 1);
  try {
    assert.ok(mine611 && mine612 && other611, "все три sleep запущены");
    const r = await run(["sleep 611"], mine);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /stopped/);
    await sleep(200);
    assert.ok(gone(mine611), "свой sleep 611 остановлен");
    assert.ok(!gone(mine612), "свой sleep 612 под шаблон не попал");
    assert.ok(!gone(other611), "чужой разговор не задет, хотя команда та же");
  } finally {
    killAll([mine611, mine612, other611].filter(Boolean));
  }
});

test("не трогает собственную цепочку: оболочку, из которой его позвали", async () => {
  const tag = runTag(randomUUID());
  // В командной строке оболочки есть сам шаблон — она должна уцелеть и дописать вывод.
  const out = await new Promise((resolve) => {
    execFile("bash", ["-c", `node ${HELPER} zz-no-such-job; echo shell-survived`],
      { env: { ...process.env, [RUN_ENV]: tag } }, (err, stdout) => resolve(stdout));
  });
  assert.match(out, /nothing to stop/);
  assert.match(out, /shell-survived/);
});

test("вне хода релея отказывается работать", async () => {
  const r = await run(["sleep"], null);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only inside/);
});
