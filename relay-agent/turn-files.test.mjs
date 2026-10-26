// node --test relay-agent/turn-files.test.mjs
//
// Бьёт по настоящей файловой системе (mtime), а не по моку: ход различает
// новый/изменённый файл от нетронутого ровно по этому сигналу.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { snapshotDir, changedFiles } from "./turn-files.mjs";

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turn-files-"));
}

test("snapshotDir: несуществующая папка — пустой снимок, не бросает", () => {
  assert.equal(snapshotDir("/tmp/does-not-exist-xyz-" + Date.now()).size, 0);
});

test("snapshotDir: рекурсивно, относительные пути через /", () => {
  const dir = mkdir();
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "2");
    const snap = snapshotDir(dir);
    assert.ok(snap.has("a.txt"));
    assert.ok(snap.has("sub/b.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changedFiles: новый файл после снимка — попадает в список", () => {
  const dir = mkdir();
  try {
    const before = snapshotDir(dir);
    fs.writeFileSync(path.join(dir, "new.txt"), "x");
    const out = changedFiles(dir, before, "/files/key1");
    assert.deepEqual(out.map((f) => f.name), ["new.txt"]);
    assert.equal(out[0].url, "/files/key1/new.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changedFiles: нетронутый файл — не попадает", () => {
  const dir = mkdir();
  try {
    fs.writeFileSync(path.join(dir, "old.txt"), "x");
    const before = snapshotDir(dir);
    const out = changedFiles(dir, before, "/files/key1");
    assert.deepEqual(out, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changedFiles: изменённый файл (mtime вырос) — попадает", async () => {
  const dir = mkdir();
  try {
    const p = path.join(dir, "old.txt");
    fs.writeFileSync(p, "x");
    const before = snapshotDir(dir);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(p, "xx");
    const out = changedFiles(dir, before, "/files/key1");
    assert.deepEqual(out.map((f) => f.name), ["old.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Ревью 26.10.2026: правка файла, созданного до выката (старая папка по
// sessionId, не по fs_key) — url обязан указывать на ТУ папку, которую
// обошли (urlPrefix), а не на папку текущего хода.
test("changedFiles: url — из urlPrefix (папка хода может быть не той, что у fsKey текущего хода)", () => {
  const dir = mkdir();
  try {
    const before = snapshotDir(dir);
    fs.writeFileSync(path.join(dir, "x.txt"), "1");
    const out = changedFiles(dir, before, "/files/LEGACY_KEY");
    assert.equal(out[0].url, "/files/LEGACY_KEY/x.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
