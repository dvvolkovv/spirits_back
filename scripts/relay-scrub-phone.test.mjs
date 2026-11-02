// node --test scripts/relay-scrub-phone.test.mjs
//
// Разовая чистка номера телефона на релее (спека
// docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 5, вариант
// «слить старую папку в папку fs_key»): у каждой телефонной сессии из
// sessions.json содержимое старой папки хода и загрузки переезжают под fs_key, а в
// транскрипте сессии строка «Current user phone …» становится нейтральной, пути —
// новыми, прочие вхождения номера владельца — его fs_key.
//
// Всё синтетическое: временные каталоги, sessions.json, транскрипты в том виде,
// в каком их пишет CLI (JSON.stringify(запись) + "\n"). Номер владельца — только
// тестовый 70000000000; «другие пользователи» — 70000000001 и 70000000002,
// тоже синтетические (код +7 000 не выдаётся).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrubContent, sessionRules, readSnapshot, commitFile, runScrub, finishScrub, moveEntry } from "./relay-scrub-phone.mjs";

const PHONE = "70000000000";
const OTHER = "70000000001"; // другой пользователь релея (есть в sessions.json)
const STRANGER = "70000000002"; // номер не из таблицы
const KEY = PHONE + "_14_ru";
const FSKEY = "3f2a9c1b0e4d5f6a7b8c9d0e1f2a3b4c";
const NEW = "Current user: identifier omitted.";
const OLD = (num = PHONE) =>
  "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): " + num;
const OUT = "/tmp/agent-output/";
const UP = "/tmp/agent-uploads/";

// Реплика хода так, как её собирал релей до 01.11: шапка релея, строка с
// номером, служебная часть бэкенда, строка языка, текст человека.
const turn = (text = "Привет", num = PHONE, dir = "3f2a9c") =>
  "Output directory for created files: " + OUT + dir + "\n\n" + OLD(num) + "\n\n" +
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
const toolUse = (name, input) => ({
  ...assistant(""),
  message: { id: "msg_02", type: "message", role: "assistant", model: "claude-sonnet-x", content: [{ type: "tool_use", id: "toolu_1", name, input }] },
});
const toolResult = (text) => user([{ type: "tool_result", tool_use_id: "toolu_1", content: text }]);

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
const parsed = (buf) => lines(buf).filter((l) => l.length).map((l) => JSON.parse(l));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ch = (...codes) => String.fromCharCode(...codes);

// Правила сессии KEY → FSKEY; по умолчанию без переименований.
const rules = (over = {}) =>
  sessionRules({
    phone: PHONE, oldDir: KEY, fsKey: FSKEY,
    outNames: [], outRenames: new Map(), upRests: [], upRenames: new Map(),
    tablePhones: new Set([PHONE, OTHER]),
    ...over,
  });

// ---------------------------------------------------------------- строки транскрипта

test("фраза в тексте реплики заменяется; остальные строки файла — те же байты", () => {
  const src = jsonl(
    { type: "summary", summary: "Разговор о карте", leafUuid: "6f1d-a" },
    user(turn()),
    assistant("Здравствуйте! Чем помочь?"),
    { type: "cost-state", sessionId: SID, totalCostUSD: 0.1234567, totalAPIDuration: 5120 },
  );
  const r = scrubContent(src, rules());
  assert.equal(r.counts.phrase, 1);
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
  const r = scrubContent(jsonl(user([{ type: "text", text: turn() }, image])), rules());
  assert.equal(r.counts.phrase, 1);
  const [ev] = parsed(r.out);
  assert.equal(ev.message.content[0].text, turn().replace(OLD(), NEW));
  assert.deepEqual(ev.message.content[1], image);
});

test("фраза с номером с «+» и без — обе заменяются, плюс уходит вместе с номером", () => {
  const plus = "+" + PHONE;
  const r = scrubContent(jsonl(user(turn("а", plus)), user([{ type: "text", text: turn("б") }])), rules());
  assert.equal(r.counts.phrase, 2);
  const [a, b] = parsed(r.out);
  assert.equal(a.message.content, turn("а", plus).replace(OLD(plus), NEW));
  assert.equal(b.message.content[0].text, turn("б").replace(OLD(), NEW));
  assert.ok(!r.out.includes(PHONE));
});

test("фраза дважды в одной реплике (хвост прошлого поворота) — обе замены", () => {
  const tailed =
    "Недавний диалог с этим пользователем (только контекст для непрерывности — отвечай ТОЛЬКО на последнее сообщение ниже):\n" +
    "Пользователь: " + turn("старый вопрос").slice(0, 2000) + "\nАссистент: старый ответ\n---\n\n" +
    turn("новый вопрос");
  const r = scrubContent(jsonl(user(tailed)), rules());
  assert.equal(r.counts.phrase, 2);
  assert.ok(!r.out.includes(PHONE));
});

test("другие формулировки фразой не считаются: регулярка строгая, номер в них уходит как прочее вхождение", () => {
  const variants = [
    "Current user phone: " + PHONE,
    "Current user phone (use as the userId argument for any mcp__linkeon__* tool call): " + PHONE,
    "current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): " + PHONE,
    "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call):" + PHONE,
  ];
  const r = scrubContent(jsonl(...variants.map((v) => user(v))), rules());
  assert.equal(r.counts.phrase, 0);
  assert.equal(r.counts.other, variants.length);
  assert.deepEqual(parsed(r.out).map((e) => e.message.content), variants.map((v) => v.replace(PHONE, FSKEY)));
});

test("номер владельца в аргументах инструментов, результатах и тексте → fs_key сессии", () => {
  const src = jsonl(
    toolUse("mcp__linkeon__generate_image", { userId: PHONE, prompt: "кот" }),
    { ...toolResult("ok"), toolUseResult: { stdout: "user " + PHONE + " ok", stderr: "" } },
    assistant("Ваш номер +" + PHONE + " привязан."),
  );
  const r = scrubContent(src, rules());
  assert.equal(r.counts.other, 3);
  const [call, res, text] = parsed(r.out);
  assert.equal(call.message.content[0].input.userId, FSKEY);
  assert.equal(res.toolUseResult.stdout, "user " + FSKEY + " ok");
  assert.equal(text.message.content[0].text, "Ваш номер " + FSKEY + " привязан.");
});

test("номер внутри более длинного числа не трогается", () => {
  const text = "Заказ 1" + PHONE + ", счёт " + PHONE + "1, код 9" + PHONE + "9; номер " + PHONE + ".";
  const r = scrubContent(jsonl(assistant(text)), rules());
  assert.equal(r.counts.other, 1);
  assert.equal(parsed(r.out)[0].message.content[0].text, text.replace("номер " + PHONE, "номер " + FSKEY));
});

test("номера других пользователей не трогаются, но строка с номером из таблицы считается", () => {
  const src = jsonl(assistant("Контакт " + OTHER + " записан"), assistant("Ещё " + STRANGER), assistant("Без номеров"));
  const r = scrubContent(src, rules());
  assert.equal(r.out, null, "писать нечего");
  assert.equal(r.otherPhones, 1, "только " + OTHER + " есть в таблице");
});

test("пути старой папки хода → папка fs_key: путь, ссылка /files, строка «Output directory», голое имя", () => {
  const src = jsonl(
    user("Output directory for created files: " + OUT + KEY + "\n\nСделай отчёт"),
    toolUse("Write", { file_path: OUT + KEY + "/report.pdf", content: "…" }),
    assistant("Готово: https://r.linkeon.io/files/" + KEY + "/report.pdf"),
    toolResult("$ ls " + OUT + "\n" + KEY + "\n" + FSKEY),
  );
  const r = scrubContent(src, rules());
  assert.equal(r.counts.dirs, 4);
  assert.equal(r.counts.other, 0);
  const [a, b, c, d] = parsed(r.out);
  assert.equal(a.message.content, "Output directory for created files: " + OUT + FSKEY + "\n\nСделай отчёт");
  assert.equal(b.message.content[0].input.file_path, OUT + FSKEY + "/report.pdf");
  assert.equal(c.message.content[0].text, "Готово: https://r.linkeon.io/files/" + FSKEY + "/report.pdf");
  assert.equal(d.message.content[0].content, "$ ls " + OUT + "\n" + FSKEY + "\n" + FSKEY);
  assert.ok(!r.out.includes(PHONE));
});

test("переименованные при конфликте записи: путь — на итоговое имя; длинные имена и границы не путаются", () => {
  const r = scrubContent(
    jsonl(
      assistant(OUT + KEY + "/report.pdf"),
      assistant(OUT + KEY + "/report.pdf.bak"),
      assistant(OUT + KEY + "/report.pdf.old"), // такой записи нет — только смена папки
      assistant(OUT + KEY + "/sub/x.txt"),
      assistant("'" + OUT + KEY + "/a b.txt'"),
      assistant(OUT + KEY + "/a\n"),
      assistant("Файл " + OUT + KEY + "/report.pdf. Готово"),
    ),
    rules({
      outNames: ["report.pdf", "report.pdf.bak", "sub", "a", "a b.txt"],
      outRenames: new Map([["report.pdf", "report (прежний).pdf"], ["sub", "sub (прежний)"], ["a", "a (прежний)"]]),
    }),
  );
  assert.deepEqual(parsed(r.out).map((e) => e.message.content[0].text), [
    OUT + FSKEY + "/report (прежний).pdf",
    OUT + FSKEY + "/report.pdf.bak",
    OUT + FSKEY + "/report.pdf.old",
    OUT + FSKEY + "/sub (прежний)/x.txt",
    "'" + OUT + FSKEY + "/a b.txt'",
    OUT + FSKEY + "/a (прежний)\n",
    "Файл " + OUT + FSKEY + "/report (прежний).pdf. Готово",
  ]);
});

test("пути загрузок → <fs_key>_<имя>, переименованная при конфликте — на итоговое имя", () => {
  const listing =
    "User uploaded files:\n- " + UP + KEY + "_doc.pdf (name: doc.pdf, 10 bytes)\n" +
    "- " + UP + KEY + "_scan.png (name: scan.png, 5 bytes)\n\n" + turn("Посмотри");
  const r = scrubContent(
    jsonl(user(listing), toolUse("Read", { file_path: UP + KEY + "_scan.png" })),
    rules({ upRests: ["doc.pdf", "scan.png"], upRenames: new Map([["scan.png", "scan (прежний).png"]]) }),
  );
  assert.equal(r.counts.uploads, 3);
  assert.equal(r.counts.phrase, 1);
  const [a, b] = parsed(r.out);
  assert.ok(a.message.content.includes("- " + UP + FSKEY + "_doc.pdf (name: doc.pdf, 10 bytes)\n"));
  assert.ok(a.message.content.includes("- " + UP + FSKEY + "_scan (прежний).png (name: scan.png, 5 bytes)\n"));
  assert.equal(b.message.content[0].input.file_path, UP + FSKEY + "_scan (прежний).png");
  assert.ok(!r.out.includes(PHONE));
});

test("старая папка двухчастного ключа не захватывает имена трёхчастного", () => {
  const key2 = PHONE + "_14";
  const r = scrubContent(
    jsonl(assistant(OUT + key2 + "/a.txt"), assistant(OUT + key2 + "_ru/b.txt")),
    rules({ oldDir: key2 }),
  );
  const [a, b] = parsed(r.out).map((e) => e.message.content[0].text);
  assert.equal(a, OUT + FSKEY + "/a.txt");
  assert.ok(!b.startsWith(OUT + FSKEY + "/"), "чужая папка не стала папкой этой сессии");
  assert.ok(!b.includes(PHONE));
});

test("строка в виде JSON.stringify меняется только в заменах: порядок ключей, U+2028, суррогаты, числа — те же байты", () => {
  // CLI пишет транскрипт как JSON.stringify(запись) + "\n". Значит, разбор и
  // повторный JSON.stringify дают те же байты везде, кроме замен.
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
        { type: "text", text: exotic + "\n\n" + turn("x", PHONE, KEY) + "\n\n" + exotic },
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: exotic + " userId=" + PHONE }], is_error: false },
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

  const r = scrubContent(Buffer.from(line + "\n"), rules());
  assert.deepEqual(r.counts, { phrase: 1, dirs: 1, uploads: 0, other: 1 });
  assert.equal(r.nonCanonicalLines, 0);
  const expected = line.replace(OLD(), NEW).replace(OUT + KEY, OUT + FSKEY).replace("userId=" + PHONE, "userId=" + FSKEY);
  assert.equal(r.out.toString("utf8"), expected + "\n");
});

test("строка не в виде JSON.stringify: замена есть, JSON валиден, строка посчитана отдельно", () => {
  const line = '{"type": "user", "message": {"role": "user", "content": "' + OLD() + '"}}';
  const r = scrubContent(Buffer.from(line + "\n"), rules());
  assert.equal(r.counts.phrase, 1);
  assert.equal(r.nonCanonicalLines, 1);
  assert.deepEqual(JSON.parse(lines(r.out)[0]), { type: "user", message: { role: "user", content: NEW } });
});

test("битая строка остаётся как есть и считается, с номером — отдельно; остальной файл обрабатывается", () => {
  const good = JSON.stringify(user(turn()));
  const torn = good.slice(0, good.indexOf(PHONE) + PHONE.length + 3); // оборванная запись, номер в ней целиком
  const r = scrubContent(Buffer.from(good + "\n{не json\n" + torn), rules()); // хвост без перевода строки
  assert.equal(r.counts.phrase, 1);
  assert.equal(r.brokenLines, 2);
  assert.equal(r.brokenWithPhone, 1, "номер в битой строке остался — это видно в счётчике");
  const out = lines(r.out);
  assert.equal(out.length, 3);
  assert.equal(out[0].toString("utf8"), good.replace(OLD(), NEW));
  assert.equal(sha(out[1]), sha(Buffer.from("{не json")));
  assert.equal(sha(out[2]), sha(Buffer.from(torn)));
});

test("ведущие NUL (CLI их пропускает при чтении) и \\r в конце строки сохраняются", () => {
  const nul = ch(0);
  const line = JSON.stringify(user(turn()));
  const r = scrubContent(Buffer.from(nul + nul + line + "\r\n"), rules());
  assert.equal(r.counts.phrase, 1);
  assert.equal(r.brokenLines, 0);
  assert.equal(r.nonCanonicalLines, 0);
  assert.equal(r.out.toString("utf8"), nul + nul + line.replace(OLD(), NEW) + "\r\n");
});

test("пустые строки и транскрипт без номера: ничего не считается битым, писать нечего", () => {
  const r = scrubContent(Buffer.from("\n" + JSON.stringify(assistant("ок")) + "\n\n   \n"), rules());
  assert.deepEqual(r.counts, { phrase: 0, dirs: 0, uploads: 0, other: 0 });
  assert.equal(r.brokenLines, 0);
  assert.equal(r.out, null);
});

// ---------------------------------------------------------------- запись транскрипта

const hourAgo = () => new Date(Date.now() - 3_600_000);

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-scrub-phone-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Файл на диске; по умолчанию — давний (час назад), с правами CLI.
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
        out[rel] = "dir " + st.mode;
        walk(p);
      } else out[rel] = [sha(fs.readFileSync(p)), st.ino, st.mtimeNs, st.mode].join(" ");
    }
  };
  walk(root);
  return out;
}

test("транскрипт изменился между чтением и записью (подменён mtime) — не перезаписан, временного файла нет", async (t) => {
  const root = tmpRoot(t);
  const file = put(root, "-tmp/a.jsonl", jsonl(user(turn())));
  const snap = await readSnapshot(file);
  const r = scrubContent(snap.buf, rules());
  const touched = new Date(Date.now() - 1000);
  fs.utimesSync(file, touched, touched); // будто CLI тронул файл
  const before = state(root);

  assert.equal(await commitFile(file, snap.stat, r.out), "changed");
  assert.deepEqual(state(root), before);
});

// ---------------------------------------------------------------- проход по сессиям

const SALT = "тестовая соль";
// fs_key, как его считает бэк (src/chat/linkeon-relay-fields.ts, relayFsKey).
const fsKeyOf = (key) => createHmac("sha256", SALT).update(key).digest("hex").slice(0, 32);
const MIN15 = 15 * 60_000;
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const exists = (...p) => fs.existsSync(path.join(...p));
const pick = (o, ...keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// Релей в миниатюре: проекты claude, папки хода и загрузки, sessions.json,
// карта fs_key (TSV, 600), домашний каталог под таблицу и журнал.
function relayWorld(t) {
  const base = tmpRoot(t);
  const home = path.join(base, "home");
  const w = {
    base, home,
    root: path.join(base, "projects"),
    out: path.join(base, "agent-output"),
    up: path.join(base, "agent-uploads"),
    sessionsPath: path.join(base, "sessions.json"),
    mapPath: path.join(home, "fs-key-map.tsv"),
    statePath: path.join(home, ".relay-scrub-map.jsonl"),
    journalPath: path.join(home, "journal.jsonl"),
    sessions: {}, map: new Map(), mapExtra: "",
  };
  for (const d of [path.join(w.root, "-tmp"), w.out, path.join(w.up, "mcp"), home]) fs.mkdirSync(d, { recursive: true });
  saveWorld(w);
  return w;
}
function saveWorld(w) {
  fs.writeFileSync(w.sessionsPath, JSON.stringify(w.sessions));
  fs.writeFileSync(w.mapPath, [...w.map].map(([k, v]) => k + "\t" + v + "\n").join("") + w.mapExtra);
  fs.chmodSync(w.mapPath, 0o600);
}
// Сессия релея: запись в sessions.json, транскрипт (если строки даны), строка карты.
function addSession(w, key, rows, { inMap = true, mtime } = {}) {
  const cliId = randomUUID();
  w.sessions[key] = cliId;
  if (inMap) w.map.set(key, fsKeyOf(key));
  saveWorld(w);
  const file = rows ? put(w.root, "-tmp/" + cliId + ".jsonl", jsonl(...rows), mtime ? { mtime } : {}) : null;
  return { key, cliId, file, fk: fsKeyOf(key), rel: path.join("-tmp", cliId + ".jsonl") };
}
const runOpts = (w, extra = {}) => ({
  root: w.root, sessionsPath: w.sessionsPath, outputs: w.out, uploads: w.up,
  fsKeyMapPath: w.mapPath, statePath: w.statePath, journalPath: w.journalPath, minAgeMs: MIN15, ...extra,
});
// Ход до части Б: загрузки и папка по ключу сессии, строка с номером.
const preTurn = (w, key, text, files = []) =>
  user(
    (files.length
      ? "User uploaded files:\n" + files.map((n) => "- " + path.join(w.up, key + "_" + n) + " (name: " + n + ", 10 bytes)\n").join("") + "\n"
      : "") +
      "Output directory for created files: " + path.join(w.out, key) + "\n\n" + OLD(key.split("_")[0]) +
      "\n\nОтвечай по-русски.\n\n" + text,
  );
// Ход после части Б: папка по fs_key, номера нет.
const postTurn = (w, fk, text) =>
  user("Output directory for created files: " + path.join(w.out, fk) + "\n\nОтвечай по-русски.\n\n" + text);

// A — основная: конфликты файла, папки и загрузки; пути в вызовах; userId.
function sessionA(w) {
  const key = PHONE + "_14_ru";
  const fk = fsKeyOf(key);
  put(w.out, key + "/report.pdf", "старый отчёт");
  put(w.out, key + "/notes.txt", "заметки");
  put(w.out, key + "/sub/x.txt", "x");
  put(w.out, fk + "/report.pdf", "новый отчёт");
  put(w.out, fk + "/sub/y.txt", "y");
  put(w.up, key + "_doc.pdf", "doc");
  put(w.up, key + "_scan.png", "старый скан");
  put(w.up, fk + "_scan.png", "новый скан");
  put(w.up, key + "_z.pdf", "z"); // и префикс двухчастного ключа B подходит — берётся самый длинный
  return addSession(w, key, [
    preTurn(w, key, "Сделай отчёт по выписке", ["doc.pdf", "scan.png"]),
    toolUse("Write", { file_path: path.join(w.out, key, "report.pdf"), content: "…" }),
    toolUse("Bash", { command: "mkdir -p " + path.join(w.out, key, "sub") + " && cp a " + path.join(w.out, key, "sub/x.txt") }),
    toolUse("mcp__linkeon__generate_image", { userId: PHONE, prompt: "кот" }),
    assistant("Готово. Контакт юриста " + OTHER + " записал."),
    postTurn(w, fk, "Ещё вопрос"),
    assistant("Отвечаю."),
  ]);
}
// B — двухчастный ключ (до 18.08, загрузки — до 09.09): своя папка и загрузка;
// у старой папки права 750 — новая получает такие же.
function sessionB(w) {
  const key = PHONE + "_14";
  put(w.out, key + "/old.txt", "старое");
  fs.chmodSync(path.join(w.out, key), 0o750);
  put(w.up, key + "_y.pdf", "y");
  return addSession(w, key, [preTurn(w, key, "Посмотри файл", ["y.pdf"])]);
}
// C — другой пользователь: в его транскрипте уходит его номер.
const sessionC = (w) => addSession(w, OTHER + "_12_en", [preTurn(w, OTHER + "_12_en", "Hello")]);
// D — нет в карте; fs_key — из строки «Output directory» хода после части Б.
function sessionD(w) {
  const key = PHONE + "_15_ru";
  put(w.out, key + "/f.txt", "f");
  return addSession(w, key, [preTurn(w, key, "Старый ход"), postTurn(w, fsKeyOf(key), "Новый ход")], { inMap: false });
}
// E — fs_key нет ни в карте, ни в транскрипте: не трогается.
function sessionE(w) {
  const key = PHONE + "_16_ru";
  put(w.out, key + "/e.txt", "e");
  return addSession(w, key, [preTurn(w, key, "Ход")], { inMap: false });
}
// F — карта и транскрипт расходятся (карта посчитана не с той солью?): не трогается.
function sessionF(w) {
  const key = PHONE + "_17_ru";
  put(w.out, key + "/f.txt", "f");
  return addSession(w, key, [preTurn(w, key, "Ход"), postTurn(w, "f".repeat(32), "Ход")]);
}
// G — свежая: в ней, вероятно, идёт ход.
function sessionG(w) {
  const key = PHONE + "_18_ru";
  put(w.out, key + "/g.txt", "g");
  return addSession(w, key, [preTurn(w, key, "Ход")], { mtime: new Date() });
}
function fullWorld(t) {
  const w = relayWorld(t);
  const s = { A: sessionA(w), B: sessionB(w), C: sessionC(w), D: sessionD(w), E: sessionE(w), F: sessionF(w), G: sessionG(w) };
  addSession(w, randomUUID() + "_14_ru", [assistant("почтовый пользователь")]);
  s.orphanWith = put(w.root, "-tmp/" + randomUUID() + ".jsonl", jsonl(user(turn())));
  s.orphanWithout = put(w.root, "-tmp/" + randomUUID() + ".jsonl", jsonl(assistant("сирота без номера")));
  put(w.out, PHONE + "_99_ru/q.txt", "q"); // папка без сессии
  put(w.up, PHONE + "_98_w.pdf", "w"); // загрузка без сессии
  w.mapExtra = "сломанная строка\n";
  saveWorld(w);
  return { w, s };
}

test("сухой прогон: все счётчики по сессиям; на диске ничего не меняется, ни журнала, ни таблицы", async (t) => {
  const { w } = fullWorld(t);
  const before = state(w.base);

  const s = await runScrub(runOpts(w));
  assert.deepEqual(
    pick(s, "phones", "sessions", "nonPhoneSessions", "withMap", "withTranscriptKey", "keyAgree", "withoutKey", "keyMismatch", "noTranscript", "fresh"),
    { phones: 2, sessions: 7, nonPhoneSessions: 1, withMap: 3, withTranscriptKey: 1, keyAgree: 1, withoutKey: 1, keyMismatch: 1, noTranscript: 0, fresh: 1 },
  );
  assert.deepEqual(pick(s, "dirs", "entries", "uploads", "conflicts", "transcripts", "otherPhones"),
    { dirs: 3, entries: 5, uploads: 4, conflicts: 3, transcripts: 4, otherPhones: 1 });
  assert.deepEqual(s.repl, { phrase: 4, dirs: 7, uploads: 3, other: 1 });
  assert.deepEqual(pick(s, "orphans", "orphansWithPhone", "orphanDirs", "orphanUploads", "mapBadLines", "errors", "written"),
    { orphans: 2, orphansWithPhone: 1, orphanDirs: 1, orphanUploads: 1, mapBadLines: 1, errors: 0, written: 0 });
  assert.deepEqual(state(w.base), before);
  assert.equal(s.journal, null);
});

test("применение, сессия A: конфликты получают «(прежний)», пути в транскрипте — на итоговые имена; метаданные транскрипта прежние", async (t) => {
  const w = relayWorld(t);
  // B раньше A в sessions.json: «первая подходящая» сессия забрала бы z.pdf у A.
  sessionB(w);
  const a = sessionA(w);
  const st0 = fs.statSync(a.file, { bigint: true });

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.equal(s.errors, 0, JSON.stringify(s.errorList));
  // Папка: старая удалена, всё в папке fs_key; совпавшие имена не перезаписаны.
  assert.ok(!exists(w.out, a.key));
  assert.equal(read(w.out, a.fk, "report.pdf"), "новый отчёт");
  assert.equal(read(w.out, a.fk, "report (прежний).pdf"), "старый отчёт");
  assert.equal(read(w.out, a.fk, "notes.txt"), "заметки");
  assert.equal(read(w.out, a.fk, "sub", "y.txt"), "y");
  assert.equal(read(w.out, a.fk, "sub (прежний)", "x.txt"), "x");
  // Загрузки: <fs_key>_<имя>, конфликт — с суффиксом.
  assert.equal(read(w.up, a.fk + "_doc.pdf"), "doc");
  assert.equal(read(w.up, a.fk + "_scan.png"), "новый скан");
  assert.equal(read(w.up, a.fk + "_scan (прежний).png"), "старый скан");
  assert.equal(read(w.up, a.fk + "_z.pdf"), "z");
  // Транскрипт: номера нет, пути — на итоговые имена.
  const text = fs.readFileSync(a.file, "utf8");
  assert.ok(!text.includes(PHONE));
  const rows = parsed(Buffer.from(text));
  const msg = rows[0].message.content;
  assert.ok(msg.includes("- " + path.join(w.up, a.fk + "_doc.pdf") + " (name: doc.pdf"));
  assert.ok(msg.includes("- " + path.join(w.up, a.fk + "_scan (прежний).png") + " (name: scan.png"));
  assert.ok(msg.includes("Output directory for created files: " + path.join(w.out, a.fk) + "\n\n" + NEW));
  assert.equal(rows[1].message.content[0].input.file_path, path.join(w.out, a.fk, "report (прежний).pdf"));
  assert.equal(
    rows[2].message.content[0].input.command,
    "mkdir -p " + path.join(w.out, a.fk, "sub (прежний)") + " && cp a " + path.join(w.out, a.fk, "sub (прежний)/x.txt"),
  );
  assert.equal(rows[3].message.content[0].input.userId, a.fk);
  assert.ok(rows[4].message.content[0].text.includes(OTHER), "номер другого пользователя не тронут");
  // Метаданные транскрипта: тот же владелец, права и mtime, новый inode.
  const st1 = fs.statSync(a.file, { bigint: true });
  assert.notEqual(st1.ino, st0.ino);
  assert.deepEqual([st1.mode, st1.uid, st1.gid], [st0.mode, st0.uid, st0.gid]);
  assert.ok(Math.abs(Number(st1.mtimeMs) - Number(st0.mtimeMs)) <= 1);
  // Таблица переименований — 600; журнал — без номеров.
  assert.equal(fs.statSync(w.statePath).mode & 0o777, 0o600);
  const journal = fs.readFileSync(w.journalPath, "utf8");
  assert.ok(!journal.includes(PHONE) && !journal.includes(OTHER));
  assert.ok(journal.includes(a.rel));
});

test("применение, весь релей: двухчастный ключ, права новой папки, запасной fs_key; без fs_key, расхождение, свежие и сироты не тронуты", async (t) => {
  const { w, s: S } = fullWorld(t);
  const untouched = [S.E, S.F, S.G].map((x) => [x.file, fs.readFileSync(x.file)]);
  const orphansBefore = [S.orphanWith, S.orphanWithout].map((f) => [f, fs.readFileSync(f)]);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(pick(s, "written", "moved", "movedUploads", "dirsRemoved", "dirsLeft", "errors"),
    { written: 4, moved: 5, movedUploads: 4, dirsRemoved: 3, dirsLeft: 0, errors: 0 });
  // B: своя папка fs_key с правами старой, своя загрузка; z.pdf ушла к A.
  assert.ok(!exists(w.out, S.B.key));
  assert.equal(read(w.out, S.B.fk, "old.txt"), "старое");
  assert.equal(fs.statSync(path.join(w.out, S.B.fk)).mode & 0o777, 0o750);
  assert.equal(read(w.up, S.B.fk + "_y.pdf"), "y");
  assert.ok(exists(w.up, S.A.fk + "_z.pdf"));
  // C: номер другого пользователя ушёл из его собственного транскрипта.
  assert.ok(!fs.readFileSync(S.C.file, "utf8").includes(OTHER));
  // D: fs_key взят из транскрипта.
  assert.equal(read(w.out, S.D.fk, "f.txt"), "f");
  assert.ok(!fs.readFileSync(S.D.file, "utf8").includes(PHONE));
  // E, F, G и сироты — байт в байт; их папки и чужие файлы — на месте.
  for (const [f, buf] of [...untouched, ...orphansBefore]) assert.ok(fs.readFileSync(f).equals(buf), f);
  for (const k of [S.E.key, S.F.key, S.G.key, PHONE + "_99_ru"]) assert.ok(exists(w.out, k), k);
  assert.ok(exists(w.up, PHONE + "_98_w.pdf"));
  for (const row of fs.readFileSync(w.journalPath, "utf8").trim().split("\n")) {
    assert.deepEqual(Object.keys(JSON.parse(row)).sort(), ["at", "conflicts", "fsKey", "moved", "replacements", "transcript", "transcriptWritten", "uploads"]);
  }
});

test("второй заход: транскрипт, изменённый во время записи, доделывается теми же итоговыми именами", async (t) => {
  const w = relayWorld(t);
  const a = sessionA(w);

  const s1 = await runScrub(runOpts(w, { apply: true }), {
    commit: (file, stat, out) => {
      fs.appendFileSync(file, JSON.stringify(assistant("дописано CLI")) + "\n"); // начался ход
      return commitFile(file, stat, out);
    },
  });
  assert.deepEqual(pick(s1, "written", "fresh"), { written: 0, fresh: 1 });
  assert.ok(!exists(w.out, a.key), "папка уже перенесена");
  assert.ok(fs.readFileSync(a.file, "utf8").includes(PHONE), "транскрипт ещё прежний");

  const s2 = await runScrub(runOpts(w, { apply: true, minAgeMs: 0 }));
  assert.equal(s2.written, 1);
  const rows = parsed(fs.readFileSync(a.file));
  assert.equal(rows[1].message.content[0].input.file_path, path.join(w.out, a.fk, "report (прежний).pdf"));
  assert.ok(rows[0].message.content.includes(path.join(w.up, a.fk + "_scan (прежний).png")));
  assert.equal(rows.at(-1).message.content[0].text, "дописано CLI");
  assert.ok(!fs.readFileSync(a.file, "utf8").includes(PHONE));
});

test("повторный прогон ничего не находит и ничего не пишет", async (t) => {
  const { w } = fullWorld(t);
  await runScrub(runOpts(w, { apply: true }));
  const before = state(w.base);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(pick(s, "written", "dirs", "entries", "uploads", "transcripts"), { written: 0, dirs: 0, entries: 0, uploads: 0, transcripts: 0 });
  assert.deepEqual(state(w.base), before);
});

test("--finish: пока есть работа — отказ и всё на месте; после прохода — удаляет таблицу и карту", async (t) => {
  const w = relayWorld(t);
  sessionA(w);

  const early = await finishScrub(runOpts(w));
  assert.ok(early.pending > 0);
  assert.deepEqual(early.removed, []);
  assert.ok(fs.existsSync(w.mapPath));

  await runScrub(runOpts(w, { apply: true }));
  assert.ok(fs.existsSync(w.statePath));
  const done = await finishScrub(runOpts(w));
  assert.equal(done.pending, 0);
  assert.deepEqual(done.removed.sort(), [w.mapPath, w.statePath].sort());
  assert.ok(!fs.existsSync(w.mapPath) && !fs.existsSync(w.statePath));
});

test("перенос не перезаписывает имя, занятое после плана; своя жёсткая ссылка прерванного захода доделывается", async (t) => {
  const dir = tmpRoot(t);
  const src = put(dir, "old/a.txt", "старый");
  const dst = put(dir, "new/a.txt", "чужой, появился после плана");
  await assert.rejects(moveEntry({ src, dst, file: true }), { code: "EEXIST" });
  assert.equal(read(dst), "чужой, появился после плана");
  assert.equal(read(src), "старый");

  fs.rmSync(dst);
  fs.linkSync(src, dst); // прерванный заход успел сделать ссылку, но не убрал старое имя
  await moveEntry({ src, dst, file: true });
  assert.ok(!fs.existsSync(src));
  assert.equal(read(dst), "старый");

  const subSrc = path.join(dir, "old", "sub");
  const subDst = path.join(dir, "new", "sub");
  fs.mkdirSync(subSrc);
  fs.mkdirSync(subDst);
  await assert.rejects(moveEntry({ src: subSrc, dst: subDst, file: false }), { code: "EEXIST" });
  assert.ok(fs.existsSync(subSrc));
});

test("сессия без транскрипта: папка переносится по карте", async (t) => {
  const w = relayWorld(t);
  const key = PHONE + "_19_ru";
  put(w.out, key + "/h.txt", "h");
  const x = addSession(w, key, null);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(pick(s, "noTranscript", "moved", "written"), { noTranscript: 1, moved: 1, written: 0 });
  assert.equal(read(w.out, x.fk, "h.txt"), "h");
  assert.ok(!exists(w.out, key));
});

test("старая папка-симлинк не обходится: ошибка сессии без номера в тексте, остальные сессии идут дальше", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const elsewhere = tmpRoot(t);
  put(elsewhere, "real/x.txt", "x");
  const key = PHONE + "_20_ru";
  fs.symlinkSync(path.join(elsewhere, "real"), path.join(w.out, key));
  const x = addSession(w, key, [preTurn(w, key, "Ход")]);
  const elsewhereBefore = state(elsewhere);
  const transcriptBefore = fs.readFileSync(x.file);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(s.errorList, [{ file: x.rel, code: "ESYMLINK" }]);
  assert.equal(s.written, 1);
  assert.ok(fs.lstatSync(path.join(w.out, key)).isSymbolicLink());
  assert.deepEqual(state(elsewhere), elsewhereBefore);
  assert.ok(fs.readFileSync(x.file).equals(transcriptBefore));
});

test("прерывание: при поднятом сигнале ничего не трогается, итог помечен", async (t) => {
  const { w } = fullWorld(t);
  const before = state(w.base);
  const ac = new AbortController();
  ac.abort();

  const s = await runScrub(runOpts(w, { apply: true, signal: ac.signal }));
  assert.equal(s.interrupted, true);
  assert.equal(s.written, 0);
  assert.deepEqual(state(w.base), before);
});

// ---------------------------------------------------------------- запуск

const SCRIPT = fileURLToPath(new URL("./relay-scrub-phone.mjs", import.meta.url));
const cliArgs = (w, extra = []) => [
  "--root", w.root, "--sessions", w.sessionsPath, "--outputs", w.out, "--uploads", w.up,
  "--fs-key-map", w.mapPath, "--state", w.statePath, ...extra,
];
const cli = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
// На релей скрипт едет через stdin: ssh … 'node --input-type=module - <флаги>' < scripts/relay-scrub-phone.mjs.
// Тогда argv[1] — "-", а import.meta.url — не путь к файлу.
const viaStdin = (args, { input = fs.readFileSync(SCRIPT), env = {} } = {}) =>
  spawnSync(process.execPath, ["--input-type=module", "-", ...args], { input, encoding: "utf8", env: { ...process.env, ...env } });
const noPhones = (text) => !text.includes(PHONE) && !text.includes(OTHER);

test("CLI: без --apply — сухой прогон: все счётчики, ни одного номера в выводе, на диске ничего не меняется", (t) => {
  const { w } = fullWorld(t);
  const before = state(w.base);

  const r = cli(cliArgs(w));
  assert.equal(r.status, 0, r.stderr);
  for (const re of [
    /сухой прогон/,
    /^номеров: 2$/m,
    /^сессий: 7 \(без номера: 1\)$/m,
    /^fs_key: из карты 3, из транскрипта 1 \(совпало с картой 1\), без fs_key 1, расхождений 1$/m,
    /^свежих: 1\b/m,
    /^без транскрипта: 0$/m,
    /^папок к переносу: 3, записей в них: 5, загрузок: 4, конфликтов имён: 3$/m,
    /^замен в транскриптах: фраза 4, пути папок 7, пути загрузок 3, прочие 1; транскриптов к записи: 4$/m,
    /^транскриптов с номерами других пользователей: 1$/m,
    /^сирот: 2, из них с номером: 1; папок без сессии: 1; загрузок без сессии: 1$/m,
    /^карта fs_key: .+, строк с ошибкой: 1$/m,
    /^ошибок: 0$/m,
  ]) assert.match(r.stdout, re);
  assert.doesNotMatch(r.stdout, /переписано/);
  assert.ok(noPhones(r.stdout + r.stderr));
  assert.deepEqual(state(w.base), before);

  const all = cli(cliArgs(w, ["--min-age-min", "0"]));
  assert.match(all.stdout, /^свежих: 0$/m, "порог свежести задаётся флагом");
});

test("CLI через stdin (так скрипт едет на релей): --apply, журнал в домашнем каталоге 600, повторный сухой прогон — ноль", (t) => {
  const { w } = fullWorld(t);

  const r = viaStdin(cliArgs(w, ["--apply"]), { env: { HOME: w.home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^переписано транскриптов: 4; перенесено записей: 5, загрузок: 4; удалено старых папок: 3, осталось непустых: 0$/m);
  const journals = fs.readdirSync(w.home).filter((n) => /^relay-scrub-phone-.+\.jsonl$/.test(n));
  assert.equal(journals.length, 1);
  const journalPath = path.join(w.home, journals[0]);
  assert.ok(r.stdout.includes("журнал: " + journalPath), r.stdout);
  assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
  assert.ok(noPhones(r.stdout + r.stderr + fs.readFileSync(journalPath, "utf8")));

  const again = viaStdin(cliArgs(w));
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^папок к переносу: 0, записей в них: 0, загрузок: 0, конфликтов имён: 0$/m);
  assert.match(again.stdout, /транскриптов к записи: 0$/m);
});

test("импорт модуля из кода, пришедшего через stdin, сам проход не запускает", () => {
  const r = viaStdin(["--root", "/нет/такого/каталога"], {
    input: "await import(" + JSON.stringify(pathToFileURL(SCRIPT).href) + "); console.log('импортирован');",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "импортирован");
});

test("CLI --finish: пока есть работа — код 1 и всё на месте; после прохода — удаляет таблицу и карту, код 0", (t) => {
  const w = relayWorld(t);
  sessionA(w);

  const early = cli(cliArgs(w, ["--finish"]));
  assert.equal(early.status, 1, early.stdout + early.stderr);
  assert.match(early.stdout, /не всё сделано/);
  assert.ok(fs.existsSync(w.mapPath));

  assert.equal(cli(cliArgs(w, ["--apply", "--journal", w.journalPath])).status, 0);
  const done = cli(cliArgs(w, ["--finish"]));
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /делать больше нечего/);
  assert.ok(!fs.existsSync(w.mapPath) && !fs.existsSync(w.statePath));
  assert.ok(noPhones(early.stdout + early.stderr + done.stdout + done.stderr));
});

test("CLI: ошибки запуска — код 2 и ничего не тронуто; --help — код 0", (t) => {
  const { w } = fullWorld(t);
  const before = state(w.base);
  const cases = [
    cliArgs(w, ["--bogus"]),
    cliArgs(w, ["лишний-аргумент"]),
    cliArgs(w, ["--min-age-min", "abc"]),
    cliArgs(w, ["--min-age-min", "-1"]),
    cliArgs(w, ["--finish", "--apply"]),
    cliArgs(w, ["--apply", "--journal", path.join(w.base, "нет-каталога", "j.jsonl")]),
    ["--root", w.root, "--sessions", path.join(w.base, "нет.json"), "--outputs", w.out, "--uploads", w.up, "--state", w.statePath],
    // --finish проверяет по карте и её же удаляет — без карты недоделанные
    // сессии выглядели бы как «без fs_key», и таблица ушла бы раньше времени.
    ["--root", w.root, "--sessions", w.sessionsPath, "--outputs", w.out, "--uploads", w.up, "--state", w.statePath, "--finish"],
  ];
  for (const args of cases) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(" ") + "\n" + r.stdout + r.stderr);
    assert.ok(r.stderr.length > 0);
  }
  fs.chmodSync(w.mapPath, 0o640); // карту с номерами видит группа — не работаем
  const open = cli(cliArgs(w));
  assert.equal(open.status, 2);
  assert.match(open.stderr, /chmod 600/);
  fs.chmodSync(w.mapPath, 0o600);
  assert.deepEqual(state(w.base), before);

  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--fs-key-map/);
});

test(
  "CLI: ошибка на сессии — код 1, в stderr файл транскрипта и код ошибки, без номера",
  { skip: process.getuid?.() === 0 && "root читает и файл с правами 000" },
  (t) => {
    const w = relayWorld(t);
    sessionA(w);
    const key = PHONE + "_21_ru";
    const bad = addSession(w, key, [preTurn(w, key, "Ход")]);
    fs.chmodSync(bad.file, 0o000);

    const r = cli(cliArgs(w));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^ошибок: 1$/m);
    assert.ok(r.stderr.includes("ошибка: " + bad.rel + ": EACCES"), r.stderr);
    assert.ok(noPhones(r.stdout + r.stderr));
  },
);

test("CLI: Ctrl+C — текущая сессия доделывается, проход останавливается; полусделанных сессий нет, код 130", async (t) => {
  const w = relayWorld(t);
  const filler = assistant("ответ ".repeat(300));
  const list = [];
  for (let i = 0; i < 150; i++) {
    const key = PHONE + "_" + (100 + i) + "_ru";
    put(w.out, key + "/f.txt", "f" + i);
    list.push(addSession(w, key, [preTurn(w, key, "Ход " + i), ...Array(100).fill(filler)]));
  }

  const child = spawn(process.execPath, [SCRIPT, ...cliArgs(w, ["--apply", "--journal", w.journalPath])], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  // Сигнал — когда в журнале появилась первая запись: проход точно идёт.
  const deadline = Date.now() + 30_000;
  while (!(fs.existsSync(w.journalPath) && fs.statSync(w.journalPath).size > 0)) {
    assert.ok(Date.now() < deadline, "журнал не появился");
    await new Promise((r) => setTimeout(r, 5));
  }
  child.kill("SIGINT");
  const { code, signal } = await closed;

  assert.equal(signal, null, "процесс не убит сигналом, а завершился сам");
  assert.equal(code, 130);
  assert.match(stdout, /ПРЕРВАНО/);
  const done = new Set(fs.readFileSync(w.journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).transcript));
  assert.ok(done.size >= 1 && done.size < list.length, "сделано " + done.size);
  for (const x of list) {
    const moved = !exists(w.out, x.key);
    const clean = !fs.readFileSync(x.file, "utf8").includes(PHONE);
    assert.equal(moved, clean, x.rel + ": папка и транскрипт — вместе");
    assert.equal(done.has(x.rel), clean, x.rel + ": журнал совпадает с диском");
  }
  assert.deepEqual(fs.readdirSync(path.join(w.root, "-tmp")).filter((n) => n.startsWith(".")), [], "временных файлов нет");
});

// ---------------------------------------------------------------- объём

// Транскрипт около 1 МБ: каждая четвёртая строка — реплика с фразой.
function bigTranscript() {
  const rows = [];
  let size = 0;
  for (let i = 0; size < 1024 * 1024; i++) {
    const row = JSON.stringify(i % 4 === 0 ? user(turn("вопрос " + i)) : assistant("ответ ".repeat(200) + i));
    rows.push(row);
    size += Buffer.byteLength(row) + 1;
  }
  return Buffer.from(rows.join("\n") + "\n");
}

test("200 сессий по 1 МБ транскрипта: меньше минуты, в памяти — текущая сессия, после прохода ничего не копится", (t) => {
  const w = relayWorld(t);
  const content = bigTranscript();
  const perFile = content.toString("utf8").split(OLD()).length - 1;
  for (let i = 0; i < 200; i++) {
    const key = PHONE + "_" + (300 + i) + "_ru";
    put(w.out, key + "/f.txt", "f");
    put(w.up, key + "_u.pdf", "u");
    const cliId = randomUUID();
    w.sessions[key] = cliId;
    w.map.set(key, fsKeyOf(key));
    put(w.root, "-tmp/" + cliId + ".jsonl", content);
  }
  saveWorld(w);

  // Отдельный процесс с --expose-gc: память меряется после сборки мусора —
  // то, что удержано, а не то, что ещё не собрано.
  const driver = [
    "const { runScrub } = await import(process.env.SCRUB_MODULE);",
    "const mem = () => { const u = process.memoryUsage(); return u.heapUsed + u.arrayBuffers; };",
    "gc(); const base = mem(); let peak = base;",
    "const timer = setInterval(() => { gc(); peak = Math.max(peak, mem()); }, 20);",
    "const t0 = performance.now();",
    "const summary = await runScrub(JSON.parse(process.env.SCRUB_OPTS));",
    "const ms = performance.now() - t0;",
    "clearInterval(timer); gc(); const after = mem();",
    "const MB = 2 ** 20;",
    "process.stdout.write(JSON.stringify({ ms, peakMb: (peak - base) / MB, leakMb: (after - base) / MB, summary }));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", driver], {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, SCRUB_MODULE: pathToFileURL(SCRIPT).href, SCRUB_OPTS: JSON.stringify(runOpts(w, { apply: true })) },
  });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  t.diagnostic(
    `200 × ${(content.length / 2 ** 20).toFixed(2)} МБ, ${perFile} фраз в транскрипте: ` +
      `${(m.ms / 1000).toFixed(1)} с; удержано в пике ${m.peakMb.toFixed(1)} МБ, после прохода ${m.leakMb.toFixed(1)} МБ`,
  );
  assert.deepEqual(pick(m.summary, "written", "moved", "movedUploads", "errors", "nonCanonicalLines"),
    { written: 200, moved: 200, movedUploads: 200, errors: 0, nonCanonicalLines: 0 });
  assert.equal(m.summary.repl.phrase, 200 * perFile);
  assert.ok(m.ms < 60_000, "проход занял " + Math.round(m.ms) + " мс");
  assert.ok(m.peakMb < 64, "в пике удержано " + m.peakMb.toFixed(1) + " МБ — транскрипты копятся в памяти");
  assert.ok(m.leakMb < 16, "после прохода удержано " + m.leakMb.toFixed(1) + " МБ");
});
