// node --test relay-agent/tools/scrub-phone-line.test.mjs
//
// Разовая чистка транскриптов релея (спека
// docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 5): строку
// «Current user phone (…): <номер>», которую релей до 01.11.2026 вклеивал в
// каждую реплику пользователя, скрипт заменяет нейтральной прямо в
// ~/.claude/projects/*/*.jsonl.
//
// Транскрипты здесь синтетические, но строки собраны так же, как их пишет CLI:
// JSON.stringify(запись) + "\n". Номер — только тестовый.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrubContent, readSnapshot, commitFile, scrubTree } from "./scrub-phone-line.mjs";

const PHONE = "70000000000";
const NEW = "Current user: identifier omitted.";
const OLD = (num = PHONE) =>
  "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): " + num;

// Реплика хода так, как её собирал релей до 01.11: шапка релея, строка с
// номером, служебная часть бэкенда, строка языка, текст человека.
const turn = (text = "Привет", num = PHONE) =>
  "Output directory for created files: /tmp/agent-output/3f2a9c\n\n" + OLD(num) + "\n\n" +
  "--- ФОРМА ОТВЕТА ---\n• Ответы держи короткими.\n\nОтвечай по-русски.\n\n" + text;

const SID = "0b7c9d1e-5a2f-4c3b-9e8d-7f6a5b4c3d2e";
const TS = "2026-10-30T10:00:00.000Z";
const user = (content) => ({
  parentUuid: null, isSidechain: false, userType: "external", cwd: "/tmp", sessionId: SID,
  version: "2.1.280", gitBranch: "", type: "user", message: { role: "user", content },
  uuid: "6f1d-u", timestamp: TS,
});
const assistant = (text) => ({
  parentUuid: "6f1d-u", isSidechain: false, userType: "external", cwd: "/tmp", sessionId: SID,
  version: "2.1.280", gitBranch: "",
  message: {
    id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-x",
    content: [{ type: "text", text }], stop_reason: null,
    usage: { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 15000, output_tokens: 120 },
  },
  requestId: "req_01", type: "assistant", uuid: "6f1d-a", timestamp: TS,
});

// Транскрипт: строки JSON через "\n"; строка-аргумент кладётся как есть.
const jsonl = (...rows) =>
  Buffer.from(rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");

// Строки файла как байты (последний элемент — то, что после последнего "\n").
function lines(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl === -1) { out.push(buf.subarray(pos)); return out; }
    out.push(buf.subarray(pos, nl));
    pos = nl + 1;
  }
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ch = (...codes) => String.fromCharCode(...codes);

// ---------------------------------------------------------------- строки

test("фраза в тексте реплики заменяется; остальные строки файла — те же байты", () => {
  const src = jsonl(
    { type: "summary", summary: "Разговор о карте", leafUuid: "6f1d-a" },
    user(turn()),
    assistant("Здравствуйте! Чем помочь?"),
    { type: "cost-state", sessionId: SID, totalCostUSD: 0.1234567, totalAPIDuration: 5120 },
  );
  const r = scrubContent(src);
  assert.equal(r.replacements, 1);
  const before = lines(src);
  const after = lines(r.out);
  assert.equal(after.length, before.length);
  before.forEach((b, i) => {
    if (i !== 1) assert.equal(sha(after[i]), sha(b), "строка " + i + " изменилась");
  });
  assert.equal(JSON.parse(after[1]).message.content, turn().replace(OLD(), NEW));
  assert.ok(!r.out.includes(PHONE));
});

test("фраза в блоке content: [{type: 'text', text}] заменяется, соседние блоки целы", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const r = scrubContent(jsonl(user([{ type: "text", text: turn() }, image])));
  assert.equal(r.replacements, 1);
  const ev = JSON.parse(lines(r.out)[0]);
  assert.equal(ev.message.content[0].text, turn().replace(OLD(), NEW));
  assert.deepEqual(ev.message.content[1], image);
});

test("номер с «+» и без — заменяются оба, плюс уходит вместе с номером", () => {
  const plus = "+" + PHONE;
  const r = scrubContent(jsonl(user(turn("а", plus)), user([{ type: "text", text: turn("б") }])));
  assert.equal(r.replacements, 2);
  const [a, b] = lines(r.out).map((l) => (l.length ? JSON.parse(l) : null));
  assert.equal(a.message.content, turn("а", plus).replace(OLD(plus), NEW));
  assert.equal(b.message.content[0].text, turn("б").replace(OLD(), NEW));
  assert.ok(!r.out.includes(PHONE));
});

test("фраза в других полях записи — результат инструмента, toolUseResult — тоже заменяется", () => {
  const ev = {
    ...user([{ type: "tool_result", tool_use_id: "toolu_1", content: "grep нашёл: " + OLD() }]),
    toolUseResult: { stdout: OLD(), stderr: "", interrupted: false },
  };
  const r = scrubContent(jsonl(ev));
  assert.equal(r.replacements, 2);
  const out = JSON.parse(lines(r.out)[0]);
  assert.equal(out.message.content[0].content, "grep нашёл: " + NEW);
  assert.equal(out.toolUseResult.stdout, NEW);
});

test("фраза дважды в одной реплике (хвост прошлого поворота) — обе замены", () => {
  const tailed =
    "Недавний диалог с этим пользователем (только контекст для непрерывности — отвечай ТОЛЬКО на последнее сообщение ниже):\n" +
    "Пользователь: " + turn("старый вопрос").slice(0, 2000) + "\nАссистент: старый ответ\n---\n\n" +
    turn("новый вопрос");
  const r = scrubContent(jsonl(user(tailed)));
  assert.equal(r.replacements, 2);
  assert.ok(!r.out.includes(PHONE));
});

test("другие формулировки не трогаются: регулярка строгая", () => {
  const variants = [
    "Current user phone: " + PHONE,
    "Current user phone (use as the userId argument for any mcp__linkeon__* tool call): " + PHONE,
    "current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): " + PHONE,
    "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call):" + PHONE,
    OLD("700000000"),
    OLD("+ " + PHONE),
  ];
  const r = scrubContent(jsonl(...variants.map((v) => user(v))));
  assert.equal(r.replacements, 0);
  assert.equal(r.out, null, "без замен файл не переписывается");
});

test("строка в виде JSON.stringify меняется только во фразе: порядок ключей, U+2028, суррогаты, числа — те же байты", () => {
  // CLI пишет транскрипт как JSON.stringify(запись) + "\n". Значит, разбор и
  // повторный JSON.stringify дают те же байты везде, кроме самой фразы.
  const exotic = [
    "Кириллица и эмодзи " + String.fromCodePoint(0x1f600),
    "разделители строк " + ch(0x2028) + " и абзацев " + ch(0x2029),
    "управляющие " + ch(0, 7, 27) + "[0m " + ch(0x7f),
    "одинокие суррогаты " + ch(0xd800) + " " + ch(0xdfff),
    'кавычки " и обратный слэш \\ и слэш /',
    "таб\tи переводы\r\nстрок",
  ].join(" | ");
  const ev = {
    10: "ключ-число", 2: "ещё ключ-число",
    parentUuid: "6f1d-a", type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: exotic + "\n\n" + turn() + "\n\n" + exotic },
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: exotic }], is_error: false },
      ],
    },
    numbers: [0, -0, 0.1, 1e21, 1.5e-7, 123456789012, -42, Math.PI, Number.MAX_SAFE_INTEGER, 5e-324, 1.7976931348623157e308],
    misc: [true, false, null, "", {}, []],
  };
  const line = JSON.stringify(ev);
  // Самопроверка набора: U+2028 в строке сырой, суррогат — экранирован,
  // ключи-числа JSON.stringify ставит первыми.
  assert.ok(line.includes(ch(0x2028)));
  assert.ok(line.includes("\\" + "ud800"));
  assert.ok(line.startsWith('{"2":'));

  const r = scrubContent(Buffer.from(line + "\n"));
  assert.equal(r.replacements, 1);
  assert.equal(r.nonCanonicalLines, 0);
  assert.equal(r.out.toString("utf8"), line.replace(OLD(), NEW) + "\n");
});

test("строка не в виде JSON.stringify: замена есть, JSON валиден, строка посчитана отдельно", () => {
  const line = '{"type": "user", "message": {"role": "user", "content": "' + OLD() + '"}}';
  const r = scrubContent(Buffer.from(line + "\n"));
  assert.equal(r.replacements, 1);
  assert.equal(r.nonCanonicalLines, 1);
  assert.deepEqual(JSON.parse(lines(r.out)[0]), { type: "user", message: { role: "user", content: NEW } });
});

test("битая строка остаётся как есть и считается; остальной файл обрабатывается", () => {
  const good = JSON.stringify(user(turn()));
  const torn = good.slice(0, good.indexOf(PHONE) + PHONE.length + 3); // оборванная запись, номер в ней целиком
  const src = Buffer.from(good + "\n{не json\n" + torn); // хвост без перевода строки
  const r = scrubContent(src);
  assert.equal(r.replacements, 1);
  assert.equal(r.brokenLines, 2);
  assert.equal(r.brokenWithPhrase, 1, "битая строка с фразой — номер в ней остался, это видно в счётчике");
  const out = lines(r.out);
  assert.equal(out.length, 3);
  assert.equal(out[0].toString("utf8"), good.replace(OLD(), NEW));
  assert.equal(sha(out[1]), sha(Buffer.from("{не json")));
  assert.equal(sha(out[2]), sha(Buffer.from(torn)));
});

test("ведущие NUL (CLI их пропускает при чтении) и \\r в конце строки сохраняются", () => {
  const nul = ch(0);
  const line = JSON.stringify(user(turn()));
  const r = scrubContent(Buffer.from(nul + nul + line + "\r\n"));
  assert.equal(r.replacements, 1);
  assert.equal(r.brokenLines, 0);
  assert.equal(r.nonCanonicalLines, 0);
  assert.equal(r.out.toString("utf8"), nul + nul + line.replace(OLD(), NEW) + "\r\n");
});

test("пустые строки и файл без фразы: ничего не считается битым, писать нечего", () => {
  const r = scrubContent(Buffer.from("\n" + JSON.stringify(assistant("ок")) + "\n\n   \n"));
  assert.equal(r.replacements, 0);
  assert.equal(r.brokenLines, 0);
  assert.equal(r.out, null);
});

// ---------------------------------------------------------------- файлы

const MIN15 = 15 * 60_000;
const hourAgo = () => new Date(Date.now() - 3_600_000);
const pick = (o, ...keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-phone-line-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Транскрипт на диске; по умолчанию — давний (час назад), с правами CLI.
function put(root, rel, content, { mode = 0o600, mtime = hourAgo() } = {}) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  fs.utimesSync(p, mtime, mtime);
  return p;
}

// Состояние дерева без разыменования симлинков: изменённое, новое или
// пропавшее — видно (содержимое, inode, mtime, права).
function state(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isSymbolicLink()) out[rel] = "-> " + fs.readlinkSync(p);
      else if (st.isDirectory()) {
        out[rel] = "dir";
        walk(p);
      } else out[rel] = [sha(fs.readFileSync(p)), st.ino, st.mtimeNs, st.mode].join(" ");
    }
  };
  walk(root);
  return out;
}

test("сухой прогон: счётчики есть, на диске ничего не меняется, журнала нет", async (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/a.jsonl", jsonl(user(turn()), assistant("ок"), user(turn("ещё"))));
  put(root, "-tmp/b.jsonl", jsonl(assistant("без фразы"), "{битая"));
  const journalPath = path.join(root, "journal.jsonl");
  const before = state(root);

  const s = await scrubTree({ root, apply: false, minAgeMs: MIN15, journalPath });
  assert.deepEqual(
    pick(s, "found", "scanned", "withPhrase", "replacements", "written", "fresh", "brokenLines", "errors"),
    { found: 2, scanned: 2, withPhrase: 1, replacements: 2, written: 0, fresh: 0, brokenLines: 1, errors: 0 },
  );
  assert.deepEqual(state(root), before);
  assert.equal(s.journal, null);
});

test("применение: замена на диске; права, владелец, группа и mtime — прежние; временных файлов нет", async (t) => {
  const root = tmpRoot(t);
  const mtime = hourAgo();
  const src = jsonl(user(turn()), assistant("ок"));
  const file = put(root, "-tmp/a.jsonl", src, { mode: 0o640, mtime });
  // Группа — не основная: временный файл получает основную, и без явного
  // chown проверка это бы поймала.
  const alt = process.getgroups().find((g) => g !== process.getgid());
  if (alt !== undefined) fs.chownSync(file, process.getuid(), alt);
  else t.diagnostic("дополнительных групп нет — группа проверена только основная");
  const st0 = fs.statSync(file, { bigint: true });

  const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: path.join(root, "j.jsonl") });
  assert.equal(s.written, 1);
  assert.equal(fs.readFileSync(file, "utf8"), src.toString("utf8").replace(OLD(), NEW));
  const st1 = fs.statSync(file, { bigint: true });
  assert.notEqual(st1.ino, st0.ino, "файл заменён через rename, а не переписан на месте");
  assert.equal(st1.mode, st0.mode);
  assert.equal(st1.uid, st0.uid);
  assert.equal(st1.gid, st0.gid);
  assert.ok(Math.abs(Number(st1.mtimeMs) - mtime.getTime()) <= 1, "mtime прежний");
  assert.deepEqual(fs.readdirSync(path.join(root, "-tmp")), ["a.jsonl"]);
});

test("свежий файл (менялся меньше --min-age-min назад) пропускается и считается отдельно", async (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/live.jsonl", jsonl(user(turn())), { mtime: new Date(Date.now() - 60_000) });
  put(root, "-tmp/old.jsonl", jsonl(user(turn())));
  const liveBefore = state(root)["-tmp/live.jsonl"];

  const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: path.join(root, "j.jsonl") });
  assert.deepEqual(pick(s, "found", "fresh", "scanned", "written"), { found: 2, fresh: 1, scanned: 1, written: 1 });
  assert.equal(state(root)["-tmp/live.jsonl"], liveBefore);
});

test("файл изменился между чтением и записью (подменён mtime) — не перезаписан, временного файла нет", async (t) => {
  const root = tmpRoot(t);
  const file = put(root, "-tmp/a.jsonl", jsonl(user(turn())));
  const snap = await readSnapshot(file);
  const r = scrubContent(snap.buf);
  const touched = new Date(Date.now() - 1000);
  fs.utimesSync(file, touched, touched); // будто CLI тронул файл
  const before = state(root);

  assert.equal(await commitFile(file, snap.stat, r.out), "changed");
  assert.deepEqual(state(root), before);
});

test("CLI дописал файл во время прохода: файл идёт как свежий, дописанное цело, в журнале его нет", async (t) => {
  const root = tmpRoot(t);
  const file = put(root, "-tmp/a.jsonl", jsonl(user(turn())));
  const journalPath = path.join(root, "j.jsonl");

  const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath }, {
    commit: (f, stat, out) => {
      fs.appendFileSync(f, JSON.stringify(assistant("дописано CLI")) + "\n");
      return commitFile(f, stat, out);
    },
  });
  assert.deepEqual(pick(s, "fresh", "scanned", "withPhrase", "written"), { fresh: 1, scanned: 0, withPhrase: 0, written: 0 });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(PHONE), "файл не тронут");
  assert.ok(text.includes("дописано CLI"), "дописанное не потеряно");
  assert.deepEqual(fs.readdirSync(path.join(root, "-tmp")), ["a.jsonl"]);
  assert.equal(s.journal, null);
  assert.ok(!fs.existsSync(journalPath));
});

test("журнал: имя файла, число замен и время — без номеров и текста; права 600", async (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/a.jsonl", jsonl(user(turn()), user(turn("ещё", "+" + PHONE))));
  put(root, "-tmp/b.jsonl", jsonl(assistant("без фразы")));
  const journalPath = path.join(root, "journal.jsonl");

  const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath });
  assert.equal(s.journal, journalPath);
  const text = fs.readFileSync(journalPath, "utf8");
  assert.doesNotMatch(text, /\d{10}/, "в журнале нет номеров");
  assert.ok(!text.includes("Привет") && !text.includes("Current user"), "в журнале нет текста");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "file", "replacements"]);
  assert.equal(rows[0].file, path.join("-tmp", "a.jsonl"));
  assert.equal(rows[0].replacements, 2);
  assert.ok(Math.abs(Date.parse(rows[0].at) - Date.now()) < 60_000);
  assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
});

test("повторный прогон ничего не находит и ничего не пишет", async (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/a.jsonl", jsonl(user(turn()), assistant("ок")));
  put(root, "-tmp/b.jsonl", jsonl(assistant("без фразы")));
  const first = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: path.join(root, "j1.jsonl") });
  assert.equal(first.written, 1);
  const before = state(root);
  const journal2 = path.join(root, "j2.jsonl");

  const second = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: journal2 });
  // scanned: 2 — переписанный файл сохранил mtime и не выглядит свежим.
  assert.deepEqual(
    pick(second, "scanned", "fresh", "withPhrase", "replacements", "written"),
    { scanned: 2, fresh: 0, withPhrase: 0, replacements: 0, written: 0 },
  );
  assert.deepEqual(state(root), before);
  assert.ok(!fs.existsSync(journal2), "пустой журнал не остаётся");
});

test("симлинки не обходятся; трогаются только обычные <root>/*/*.jsonl", async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  const elsewhere = tmpRoot(t);
  const target = put(outside, "proj/target.jsonl", jsonl(user(turn())));
  put(root, "-tmp/real.jsonl", jsonl(user(turn())));
  fs.symlinkSync(target, path.join(root, "-tmp", "link.jsonl")); // файл-симлинк
  fs.symlinkSync(path.join(outside, "proj"), path.join(root, "linked-proj")); // каталог-симлинк
  put(root, "top.jsonl", jsonl(user(turn()))); // в самом корне
  put(root, "-tmp/sub/deep.jsonl", jsonl(user(turn()))); // глубже одного уровня
  put(root, "-tmp/notes.txt", jsonl(user(turn()))); // не .jsonl
  put(root, "-tmp/a.jsonl.bak", jsonl(user(turn())));
  const rootBefore = state(root);
  const outsideBefore = state(outside);

  const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: path.join(elsewhere, "j.jsonl") });
  assert.deepEqual(pick(s, "found", "written"), { found: 1, written: 1 });
  const rootAfter = state(root);
  assert.deepEqual(Object.keys(rootAfter), Object.keys(rootBefore));
  assert.deepEqual(Object.keys(rootBefore).filter((k) => rootBefore[k] !== rootAfter[k]), ["-tmp/real.jsonl"]);
  assert.deepEqual(state(outside), outsideBefore);
});

test(
  "ошибка на одном файле не останавливает проход; в списке ошибок — имя и код, без текста",
  { skip: process.getuid?.() === 0 && "root читает и файл с правами 000" },
  async (t) => {
    const root = tmpRoot(t);
    put(root, "-tmp/bad.jsonl", jsonl(user(turn())), { mode: 0o000 });
    put(root, "-tmp/good.jsonl", jsonl(user(turn())));

    const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: path.join(root, "j.jsonl") });
    assert.equal(s.errors, 1);
    assert.deepEqual(s.errorList, [{ file: path.join("-tmp", "bad.jsonl"), code: "EACCES" }]);
    assert.equal(s.written, 1);
  },
);

test("прерывание: при поднятом сигнале файлы не трогаются, итог помечен", async (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/a.jsonl", jsonl(user(turn())));
  const before = state(root);
  const ac = new AbortController();
  ac.abort();

  const s = await scrubTree({ root, apply: true, minAgeMs: MIN15, journalPath: path.join(root, "j.jsonl"), signal: ac.signal });
  assert.equal(s.interrupted, true);
  assert.equal(s.scanned, 0);
  assert.deepEqual(state(root), before);
});

// ---------------------------------------------------------------- запуск

const SCRIPT = fileURLToPath(new URL("./scrub-phone-line.mjs", import.meta.url));
const cli = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("CLI: без --apply — сухой прогон: счётчики на месте, номер не печатается, файлы не меняются", (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/a.jsonl", jsonl(user(turn()), user(turn("ещё"))));
  put(root, "-tmp/b.jsonl", jsonl(assistant("без фразы")));
  put(root, "-tmp/live.jsonl", jsonl(user(turn())), { mtime: new Date() });
  const before = state(root);

  const r = cli(["--root", root]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /сухой прогон/);
  for (const re of [
    /^файлов просмотрено: 2$/m,
    /^файлов со строкой: 1$/m,
    /^замен: 2$/m,
    /^пропущено свежих: 1\b/m,
    /^ошибок: 0$/m,
  ]) assert.match(r.stdout, re);
  assert.doesNotMatch(r.stdout, /записано файлов/);
  assert.ok(!(r.stdout + r.stderr).includes(PHONE));
  assert.deepEqual(state(root), before);
});

test("CLI: --apply меняет файлы и пишет журнал в домашний каталог с правами 600", (t) => {
  const root = tmpRoot(t);
  const home = tmpRoot(t);
  const file = put(root, "-tmp/a.jsonl", jsonl(user(turn())));

  const r = cli(["--root", root, "--apply"], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^записано файлов: 1$/m);
  assert.ok(!fs.readFileSync(file).includes(PHONE));
  const journals = fs.readdirSync(home).filter((n) => /^scrub-phone-line-.+\.jsonl$/.test(n));
  assert.equal(journals.length, 1);
  const journalPath = path.join(home, journals[0]);
  assert.ok(r.stdout.includes("журнал: " + journalPath), r.stdout);
  assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
  assert.ok(!(r.stdout + r.stderr + fs.readFileSync(journalPath, "utf8")).includes(PHONE));
});

test("CLI: --min-age-min задаёт порог свежести, --journal — путь журнала", (t) => {
  const root = tmpRoot(t);
  const file = put(root, "-tmp/a.jsonl", jsonl(user(turn())), { mtime: new Date(Date.now() - 5 * 60_000) });
  const journalPath = path.join(tmpRoot(t), "j.jsonl");

  const byDefault = cli(["--root", root, "--apply", "--journal", journalPath]);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.match(byDefault.stdout, /^пропущено свежих: 1\b/m);
  assert.ok(fs.readFileSync(file).includes(PHONE), "пять минут — свежий при пороге по умолчанию 15");

  const r = cli(["--root", root, "--apply", "--min-age-min", "1", "--journal", journalPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^записано файлов: 1$/m);
  assert.ok(!fs.readFileSync(file).includes(PHONE));
  assert.equal(fs.readFileSync(journalPath, "utf8").trim().split("\n").length, 1);
});

test("CLI: ошибки запуска — код 2 и ничего не тронуто; --help — код 0", (t) => {
  const root = tmpRoot(t);
  put(root, "-tmp/a.jsonl", jsonl(user(turn())));
  const before = state(root);
  const cases = [
    ["--root", root, "--bogus"],
    ["--root", root, "лишний-аргумент"],
    ["--root", root, "--min-age-min", "abc"],
    ["--root", root, "--min-age-min", "-1"],
    ["--root", root, "--min-age-min", ""],
    ["--root", path.join(root, "нет-такого")],
    // журнал не открылся — замен не было ни одной
    ["--root", root, "--apply", "--journal", path.join(root, "нет-каталога", "j.jsonl")],
  ];
  for (const args of cases) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" ") + "\n" + r.stdout + r.stderr);
    assert.ok(r.stderr.length > 0, args.join(" "));
  }
  assert.deepEqual(state(root), before);

  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--apply/);
});

test(
  "CLI: ошибка на файле — код 1, в stderr имя файла и код ошибки, без номера",
  { skip: process.getuid?.() === 0 && "root читает и файл с правами 000" },
  (t) => {
    const root = tmpRoot(t);
    put(root, "-tmp/bad.jsonl", jsonl(user(turn())), { mode: 0o000 });

    const r = cli(["--root", root]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^ошибок: 1$/m);
    assert.match(r.stderr, /-tmp\/bad\.jsonl: EACCES/);
    assert.ok(!(r.stdout + r.stderr).includes(PHONE));
  },
);

// ---------------------------------------------------------------- объём

test("200 файлов по 1 МБ: меньше минуты, в памяти — текущий файл, после прохода ничего не копится", (t) => {
  const root = tmpRoot(t);
  const rows = [];
  let size = 0;
  for (let i = 0; size < 1024 * 1024; i++) {
    const row = JSON.stringify(i % 4 === 0 ? user(turn("вопрос " + i)) : assistant("ответ ".repeat(200) + i));
    rows.push(row);
    size += Buffer.byteLength(row) + 1;
  }
  const content = rows.join("\n") + "\n";
  const perFile = content.split(OLD()).length - 1;
  const old = hourAgo();
  for (let i = 0; i < 200; i++) put(root, "-tmp/s" + String(i).padStart(3, "0") + ".jsonl", content, { mtime: old });
  const journalPath = path.join(tmpRoot(t), "j.jsonl");

  // Отдельный процесс с --expose-gc: память меряется после сборки мусора —
  // то, что удержано, а не то, что ещё не собрано.
  const driver = [
    "const { scrubTree } = await import(process.env.SCRUB_MODULE);",
    "const mem = () => { const u = process.memoryUsage(); return u.heapUsed + u.arrayBuffers; };",
    "gc(); const base = mem(); let peak = base;",
    "const timer = setInterval(() => { gc(); peak = Math.max(peak, mem()); }, 20);",
    "const t0 = performance.now();",
    "const summary = await scrubTree({ root: process.env.SCRUB_ROOT, apply: true, minAgeMs: 15 * 60000, journalPath: process.env.SCRUB_JOURNAL });",
    "const ms = performance.now() - t0;",
    "clearInterval(timer); gc(); const after = mem();",
    "const MB = 2 ** 20;",
    "process.stdout.write(JSON.stringify({ ms, peakMb: (peak - base) / MB, leakMb: (after - base) / MB, summary }));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", driver], {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, SCRUB_MODULE: pathToFileURL(SCRIPT).href, SCRUB_ROOT: root, SCRUB_JOURNAL: journalPath },
  });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  t.diagnostic(
    `200 × ${(Buffer.byteLength(content) / 2 ** 20).toFixed(2)} МБ, ${perFile} фраз в файле: ` +
      `${(m.ms / 1000).toFixed(1)} с; удержано в пике ${m.peakMb.toFixed(1)} МБ, после прохода ${m.leakMb.toFixed(1)} МБ`,
  );
  assert.equal(m.summary.written, 200);
  assert.equal(m.summary.replacements, 200 * perFile);
  assert.equal(m.summary.nonCanonicalLines, 0);
  assert.ok(m.ms < 60_000, "проход занял " + Math.round(m.ms) + " мс");
  assert.ok(m.peakMb < 64, "в пике удержано " + m.peakMb.toFixed(1) + " МБ — файлы копятся в памяти");
  assert.ok(m.leakMb < 16, "после прохода удержано " + m.leakMb.toFixed(1) + " МБ");
  assert.ok(!fs.readFileSync(path.join(root, "-tmp", "s123.jsonl")).includes(PHONE));
});
