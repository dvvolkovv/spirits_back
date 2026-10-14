// node --test relay-agent/proc-reaper.test.mjs
//
// Тесты бьют по настоящим процессам: весь смысл уборки в том, что её не
// обходят ни setsid, ни смерть родителя, а проверить это можно только на
// живом /proc. Поэтому только Linux — там, где релей и работает.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { RUN_ENV, runTag, taggedProcesses, finishedRun, reap } from "./proc-reaper.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Дерево как у фоновой задачи claude: своя сессия, внутри оболочка с детьми.
// Запускатель (setsid) сразу выходит, и дерево остаётся сиротой — ровно так
// 14.10.2026 остался OCR после того, как ход убили SIGKILL-ом.
function orphanTree(tag, script = "sleep 600 & sleep 600 & wait") {
  const launcher = spawn("setsid", ["bash", "-c", script], {
    env: { ...process.env, [RUN_ENV]: tag },
    detached: true,
    stdio: "ignore",
  });
  launcher.unref();
}

async function pidsOf(tag, want) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const pids = (await taggedProcesses()).filter((p) => p.tag === tag).map((p) => p.pid);
    if (pids.length >= want || Date.now() > deadline) return pids;
    await sleep(50);
  }
}

// Убитый процесс до уборки родителем числится зомби, и kill(pid, 0) по нему
// всё ещё успешен. Поэтому «умер» — это нет в /proc или состояние Z.
function gone(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z";
  } catch {
    return true;
  }
}

async function allGone(pids) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (pids.every(gone)) return true;
    await sleep(50);
  }
  return pids.every(gone);
}

const killAll = (pids) => pids.forEach((p) => { try { process.kill(p, "SIGKILL"); } catch {} });

test("сирота в своей сессии гасится целиком — оболочка и её дети", async () => {
  const tag = runTag(randomUUID());
  orphanTree(tag);
  const pids = await pidsOf(tag, 3);
  try {
    assert.equal(pids.length, 3, "bash и два sleep должны нести метку хода");
    const victims = await reap((t) => t === tag, { graceMs: 200 });
    assert.equal(victims.length, 3);
    assert.ok(await allGone(pids), "после уборки никого из дерева не осталось");
  } finally {
    killAll(pids);
  }
});

test("чужой ход не трогаем", async () => {
  const mine = runTag(randomUUID());
  const other = runTag(randomUUID());
  orphanTree(mine);
  orphanTree(other);
  const minePids = await pidsOf(mine, 3);
  const otherPids = await pidsOf(other, 3);
  try {
    await reap((t) => t === mine, { graceMs: 200 });
    assert.ok(await allGone(minePids));
    assert.ok(otherPids.length === 3 && otherPids.every((p) => !gone(p)), "чужой ход жив");
  } finally {
    killAll([...minePids, ...otherPids]);
  }
});

test("кто глух к SIGTERM, получает SIGKILL после паузы", async () => {
  const tag = runTag(randomUUID());
  // Игнор сигнала наследуется детьми, так что глухи и оболочка, и sleep.
  orphanTree(tag, 'trap "" TERM; sleep 600 & wait');
  const pids = await pidsOf(tag, 2);
  try {
    assert.equal(pids.length, 2);
    await reap((t) => t === tag, { graceMs: 300 });
    assert.ok(await allGone(pids));
  } finally {
    killAll(pids);
  }
});

test("finishedRun: свой ход — по списку живых, ход другого релея — по жизни хозяина", () => {
  const live = runTag("live");
  const isFinished = finishedRun(new Set([live]));
  assert.equal(isFinished(live), false, "claude хода ещё работает");
  assert.equal(isFinished(runTag("ended")), true, "ход этого релея, которого уже нет среди живых");
  // Хозяин жив, но это не мы: второй экземпляр релея или прогон тестов.
  assert.equal(isFinished(runTag("x", process.ppid)), false);
  // Прежний экземпляр релея, умерший при рестарте.
  const pidMax = Number(fs.readFileSync("/proc/sys/kernel/pid_max", "utf8"));
  assert.equal(isFinished(runTag("x", pidMax + 1)), true);
  // Метка не нашего формата: убивать по ней не за что.
  assert.equal(isFinished("garbage"), false);
  assert.equal(isFinished(":x"), false);
});

test("taggedProcesses: в /proc берёт только метку и молча пропускает лишнее", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-reaper-test-"));
  try {
    const proc = (name, files) => {
      fs.mkdirSync(path.join(root, name));
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name, f), body);
    };
    proc("101", { environ: `A=1\0${RUN_ENV}=7:abc\0B=2\0`, comm: "tesseract\n" });
    proc("102", { environ: "A=1\0B=2\0", comm: "bash\n" });
    proc("103", { comm: "kworker\n" }); // environ не читается: чужой или успел умереть
    proc("self", { environ: `${RUN_ENV}=7:zzz\0` }); // не pid
    proc("104", { environ: `X${RUN_ENV}=7:nope\0` }); // похожее имя — не наша переменная
    assert.deepEqual(await taggedProcesses(root), [{ pid: 101, tag: "7:abc", comm: "tesseract" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
