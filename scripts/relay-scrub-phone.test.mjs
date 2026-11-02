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
import { scrubContent, sessionRules, readSnapshot, commitFile } from "./relay-scrub-phone.mjs";

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
