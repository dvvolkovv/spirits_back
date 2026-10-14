#!/usr/bin/env node
// stop-my-jobs [часть команды] — остановить процессы, запущенные в этом ходе.
//
// Все разговоры релея работают от одного пользователя dv, поэтому pkill -f или
// killall из одного разговора бьют по процессам всех остальных. 14.10.2026
// модель останавливала свой OCR через pkill -f tesseract — чужой OCR в тот
// момент лёг бы вместе с ним. Здесь выбор идёт по метке хода FILE_AGENT_RUN
// (proc-reaper.mjs): чужие разговоры и сам claude со своей оболочкой не
// задеваются. Вывод читает модель, поэтому он по-английски, как её инструкция.

import fs from "fs";
import { RUN_ENV, taggedProcesses } from "./proc-reaper.mjs";

const tag = process.env[RUN_ENV];
if (!tag) {
  console.error("stop-my-jobs: works only inside an agent turn");
  process.exit(2);
}
const pattern = process.argv.slice(2).join(" ");

// Себя и всю цепочку вверх — оболочку инструмента и сам claude — не трогаем.
function ancestors() {
  const out = new Set();
  let pid = process.pid;
  while (pid > 1 && !out.has(pid)) {
    out.add(pid);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return out;
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return null;
  }
}

const skip = ancestors();
async function mine() {
  return (await taggedProcesses()).filter((p) => {
    if (p.tag !== tag || skip.has(p.pid)) return false;
    const cmd = cmdline(p.pid);
    return cmd !== null && cmd.includes(pattern);
  });
}

function signal(pid, sig) {
  try { process.kill(pid, sig); } catch {}
}

const victims = await mine();
if (victims.length === 0) {
  console.log(pattern ? `stop-my-jobs: nothing to stop matching "${pattern}"` : "stop-my-jobs: nothing to stop");
  process.exit(0);
}
for (const p of victims) signal(p.pid, "SIGTERM");
const deadline = Date.now() + 3000;
while (Date.now() < deadline && (await mine()).length > 0) {
  await new Promise((r) => setTimeout(r, 100));
}
for (const p of await mine()) signal(p.pid, "SIGKILL");

const byName = {};
for (const v of victims) byName[v.comm || "?"] = (byName[v.comm || "?"] || 0) + 1;
const summary = Object.entries(byName).map(([name, n]) => (n > 1 ? name + "×" + n : name)).join(", ");
console.log(`stop-my-jobs: stopped ${victims.length} (${summary})`);
