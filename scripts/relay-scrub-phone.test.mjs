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

const KEY2 = PHONE + "_12_en"; // другая сессия того же номера
const FSKEY2 = "9e8d7f6a5b4c3d2e1f0a9b8c7d6e5f4a";
// Правила сессии KEY → FSKEY. own — имена и переименования её папки и
// загрузок; dirs — папки других сессий того же номера: [старое имя, { fsKey | null, … }];
// keep — имена на диске, которые не переносятся (сироты).
const rules = ({ own = {}, dirs = [], keep = [] } = {}) =>
  sessionRules({
    phone: PHONE, fsKey: FSKEY,
    dirs: new Map([[KEY, { fsKey: FSKEY, outNames: [], outRenames: new Map(), upRests: [], upRenames: new Map(), ...own }], ...dirs]),
    keep: new Set(keep),
    uploadsRoot: UP.slice(0, -1),
    tablePhones: new Set([PHONE, OTHER]),
  });
const ZERO = { phrase: 0, dirs: 0, uploads: 0, other: 0, kept: 0 };
const texts = (r) => parsed(r.out).map((e) => (typeof e.message.content === "string" ? e.message.content : e.message.content[0].text));

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
  assert.equal(texts(r)[0], text.replace("номер " + PHONE, "номер " + FSKEY));
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
      own: {
        outNames: ["report.pdf", "report.pdf.bak", "sub", "a", "a b.txt"],
        outRenames: new Map([["report.pdf", "report (прежний).pdf"], ["sub", "sub (прежний)"], ["a", "a (прежний)"]]),
      },
    }),
  );
  assert.deepEqual(texts(r), [
    OUT + FSKEY + "/report (прежний).pdf",
    OUT + FSKEY + "/report.pdf.bak",
    OUT + FSKEY + "/report.pdf.old",
    OUT + FSKEY + "/sub (прежний)/x.txt",
    "'" + OUT + FSKEY + "/a b.txt'",
    OUT + FSKEY + "/a (прежний)\n",
    "Файл " + OUT + FSKEY + "/report (прежний).pdf. Готово",
  ]);
});

test("граница имени: » ! ” … и точка в конце фразы после папки — не продолжение имени", () => {
  const r = scrubContent(
    jsonl(
      assistant("Папка " + OUT + KEY + "."),
      assistant("Файл «" + OUT + KEY + "/report.pdf»"),
      assistant(OUT + KEY + "/report.pdf!"),
      assistant("“" + OUT + KEY + "/report.pdf”"),
      assistant(OUT + KEY + "/report.pdf…"),
    ),
    rules({ own: { outNames: ["report.pdf"], outRenames: new Map([["report.pdf", "report (прежний).pdf"]]) } }),
  );
  assert.deepEqual(texts(r), [
    "Папка " + OUT + FSKEY + ".",
    "Файл «" + OUT + FSKEY + "/report (прежний).pdf»",
    OUT + FSKEY + "/report (прежний).pdf!",
    "“" + OUT + FSKEY + "/report (прежний).pdf”",
    OUT + FSKEY + "/report (прежний).pdf…",
  ]);
  assert.equal(r.counts.other, 0);
});

test("пути загрузок → <fs_key>_<имя>; переименованная — на итоговое; незнакомая в корне загрузок — тоже под fs_key", () => {
  const listing =
    "User uploaded files:\n- " + UP + KEY + "_doc.pdf (name: doc.pdf, 10 bytes)\n" +
    "- " + UP + KEY + "_scan.png (name: scan.png, 5 bytes)\n\n" + turn("Посмотри");
  const r = scrubContent(
    jsonl(user(listing), toolUse("Read", { file_path: UP + KEY + "_scan.png" }), assistant(UP + KEY + "_old.pdf")),
    rules({ own: { upRests: ["doc.pdf", "scan.png"], upRenames: new Map([["scan.png", "scan (прежний).png"]]) } }),
  );
  assert.equal(r.counts.uploads, 4);
  assert.equal(r.counts.phrase, 1);
  const [a, b, c] = parsed(r.out);
  assert.ok(a.message.content.includes("- " + UP + FSKEY + "_doc.pdf (name: doc.pdf, 10 bytes)\n"));
  assert.ok(a.message.content.includes("- " + UP + FSKEY + "_scan (прежний).png (name: scan.png, 5 bytes)\n"));
  assert.equal(b.message.content[0].input.file_path, UP + FSKEY + "_scan (прежний).png");
  assert.equal(c.message.content[0].text, UP + FSKEY + "_old.pdf");
  assert.ok(!r.out.includes(PHONE));
});

test("папки и загрузки других сессий того же номера → их fs_key, с их переименованиями", () => {
  const r = scrubContent(
    jsonl(assistant(OUT + KEY2 + "/x.pdf"), assistant(UP + KEY2 + "_doc.pdf"), assistant(OUT + KEY + "/y.pdf")),
    rules({ dirs: [[KEY2, { fsKey: FSKEY2, outNames: ["x.pdf"], outRenames: new Map([["x.pdf", "x (прежний).pdf"]]), upRests: [], upRenames: new Map() }]] }),
  );
  assert.deepEqual(texts(r), [OUT + FSKEY2 + "/x (прежний).pdf", UP + FSKEY2 + "_doc.pdf", OUT + FSKEY + "/y.pdf"]);
});

test("старая папка двухчастного ключа не съедает имена трёхчастного; незнакомое имя теряет только номер", () => {
  const key14 = PHONE + "_14";
  const r = scrubContent(
    jsonl(assistant(OUT + key14 + "/a.txt"), assistant(OUT + KEY + "/b.txt"), assistant(OUT + PHONE + "_14_xx/c.txt")),
    sessionRules({
      phone: PHONE, fsKey: FSKEY2,
      dirs: new Map([[key14, { fsKey: FSKEY2 }], [KEY, { fsKey: FSKEY }]]),
      uploadsRoot: UP.slice(0, -1), tablePhones: new Set([PHONE]),
    }),
  );
  const [a, b, c] = texts(r);
  assert.equal(a, OUT + FSKEY2 + "/a.txt");
  assert.equal(b, OUT + FSKEY + "/b.txt");
  assert.ok(!c.startsWith(OUT + FSKEY2 + "/") && !c.includes(PHONE), c);
});

test("папка, которая не переносится (общая, без fs_key), и сирота на диске — пути как есть; строка и userId меняются", () => {
  const sharedKey = PHONE + "_custom_0b7c9d1e-5a2f-4c3b-9e8d-7f6a5b"; // 48 знаков — общая для _ru и _en
  const r = scrubContent(
    jsonl(
      user("Output directory for created files: " + OUT + sharedKey + "\n\n" + OLD() + "\n\nОтвечай по-русски.\n\nТекст"),
      toolUse("mcp__linkeon__read_calendar", { userId: PHONE }),
      assistant(UP + sharedKey + "_doc.pdf и " + OUT + PHONE + "_99_ru/q.txt"),
    ),
    sessionRules({
      phone: PHONE, fsKey: FSKEY,
      dirs: new Map([[sharedKey, { fsKey: null }]]),
      keep: new Set([PHONE + "_99_ru"]),
      uploadsRoot: UP.slice(0, -1), tablePhones: new Set([PHONE]),
    }),
  );
  assert.deepEqual(r.counts, { phrase: 1, dirs: 0, uploads: 0, other: 1, kept: 3 });
  const [a, b, c] = parsed(r.out);
  assert.ok(a.message.content.startsWith("Output directory for created files: " + OUT + sharedKey + "\n\n" + NEW));
  assert.equal(b.message.content[0].input.userId, FSKEY);
  assert.equal(c.message.content[0].text, UP + sharedKey + "_doc.pdf и " + OUT + PHONE + "_99_ru/q.txt");
});

test("номер в имени файла внутри переносимой папки остаётся: имя на диске то же", () => {
  const name = "dogovor_" + PHONE + ".pdf";
  const r = scrubContent(jsonl(assistant(OUT + KEY + "/" + name)), rules({ own: { outNames: [name] } }));
  assert.equal(texts(r)[0], OUT + FSKEY + "/" + name);
  assert.deepEqual(r.counts, { ...ZERO, dirs: 1, kept: 1 });
});

test("блоки рассуждений не трогаются (подпись сверяется с текстом); блок с номером считается", () => {
  const thinking = { type: "thinking", thinking: "Номер " + PHONE + ", папка " + OUT + KEY, signature: "EqQBCkYIBRgCKkB" };
  const redacted = { type: "redacted_thinking", data: "c2VjcmV0" };
  const ev = assistant("");
  ev.message.content = [thinking, redacted, { type: "text", text: "Номер " + PHONE }];
  const line = JSON.stringify(ev);
  const r = scrubContent(Buffer.from(line + "\n"), rules());
  assert.equal(r.thinkingWithPhone, 1);
  assert.deepEqual(r.counts, { ...ZERO, other: 1 });
  const out = r.out.toString("utf8");
  assert.ok(out.includes(JSON.stringify(thinking)), "блок рассуждений — байт в байт");
  assert.ok(out.includes(JSON.stringify(redacted)));
  assert.equal(JSON.parse(out).message.content[2].text, "Номер " + FSKEY);
});

test("ключи JSON с номером (trackedFileBackups) не меняются — считаются", () => {
  const snapshot = {
    type: "file-history-snapshot", messageId: "m1",
    snapshot: { trackedFileBackups: { [OUT + KEY + "/report.pdf"]: { backupFileName: "a1b2@v1", version: 1 } } },
  };
  const r = scrubContent(jsonl(snapshot), rules());
  assert.equal(r.out, null);
  assert.equal(r.keysWithPhone, 1);
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
  assert.deepEqual(r.counts, { ...ZERO, phrase: 1, dirs: 1, other: 1 });
  assert.equal(r.nonCanonicalLines, 0);
  const expected = line.replace(OLD(), NEW).replace(OUT + KEY, OUT + FSKEY).replace("userId=" + PHONE, "userId=" + FSKEY);
  assert.equal(r.out.toString("utf8"), expected + "\n");
});

test("строка не в виде JSON.stringify не пишется: остаётся как была, считается, замены в ней не засчитаны", () => {
  const line = '{"type": "user", "message": {"role": "user", "content": "' + OLD() + '"}}';
  const r = scrubContent(Buffer.from(line + "\n" + JSON.stringify(assistant("номер " + PHONE)) + "\n"), rules());
  assert.equal(r.nonCanonicalLines, 1);
  assert.deepEqual(r.counts, { ...ZERO, other: 1 });
  assert.equal(lines(r.out)[0].toString("utf8"), line);
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
  assert.deepEqual(r.counts, ZERO);
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
const fsKeyOf = (key, salt = SALT) => createHmac("sha256", salt).update(key).digest("hex").slice(0, 32);
const MIN15 = 15 * 60_000;
const THIRD = "70000000003"; // ещё один синтетический пользователь (свежая сессия)
// i-й синтетический номер для объёмных тестов: код +7 000 не выдаётся.
const phoneN = (i) => "7000000" + String(1000 + i);
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
    standMapPath: null,
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
function addSession(w, key, rows, { inMap = true, mtime, save = true } = {}) {
  const cliId = randomUUID();
  w.sessions[key] = cliId;
  if (inMap) w.map.set(key, fsKeyOf(key));
  if (save) saveWorld(w);
  const file = rows ? put(w.root, "-tmp/" + cliId + ".jsonl", jsonl(...rows), mtime ? { mtime } : {}) : null;
  return { key, cliId, file, fk: fsKeyOf(key), rel: path.join("-tmp", cliId + ".jsonl") };
}
const runOpts = (w, extra = {}) => ({
  root: w.root, sessionsPath: w.sessionsPath, outputs: w.out, uploads: w.up,
  fsKeyMapPath: w.mapPath, standMapPath: w.standMapPath, statePath: w.statePath, journalPath: w.journalPath,
  minAgeMs: MIN15, ...extra,
});
// Тестовый стенд ходит в тот же релей с теми же ключами, но со своей солью.
const STAND = "соль стенда";
function saveStandMap(w) {
  w.standMapPath = path.join(w.home, "fs-key-map-stand.tsv");
  fs.writeFileSync(w.standMapPath, Object.keys(w.sessions).map((k) => k + "\t" + fsKeyOf(k, STAND) + "\n").join(""));
  fs.chmodSync(w.standMapPath, 0o600);
}
// Ход до части Б: загрузки и папка по ключу сессии, строка с номером.
const preTurn = (w, key, text, files = [], dir = key) =>
  user(
    (files.length
      ? "User uploaded files:\n" + files.map((n) => "- " + path.join(w.up, dir + "_" + n) + " (name: " + n + ", 10 bytes)\n").join("") + "\n"
      : "") +
      "Output directory for created files: " + path.join(w.out, dir) + "\n\n" + OLD(key.split("_")[0]) +
      "\n\nОтвечай по-русски.\n\n" + text,
  );
// Ход после части Б: папка по fs_key, номера нет.
const postTurn = (w, fk, text) =>
  user("Output directory for created files: " + path.join(w.out, fk) + "\n\nОтвечай по-русски.\n\n" + text);

// A — основная: конфликты файла, папки и загрузки; пути в вызовах; userId;
// ход после части Б — по нему сверяется карта.
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
// F — карта и транскрипт расходятся (карта посчитана не с той солью?).
function sessionF(w) {
  const key = PHONE + "_17_ru";
  put(w.out, key + "/f.txt", "f");
  return addSession(w, key, [preTurn(w, key, "Ход"), postTurn(w, "f".repeat(32), "Ход")]);
}
// G — свежая (идёт ход). Другой номер: свежая сессия откладывает весь свой номер.
function sessionG(w) {
  const key = THIRD + "_18_ru";
  put(w.out, key + "/g.txt", "g");
  return addSession(w, key, [preTurn(w, key, "Ход")], { mtime: new Date() });
}
function fullWorld(t, { mismatch = false } = {}) {
  const w = relayWorld(t);
  const s = { A: sessionA(w), B: sessionB(w), C: sessionC(w), D: sessionD(w), E: sessionE(w), G: sessionG(w) };
  if (mismatch) s.F = sessionF(w);
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
    pick(s, "phones", "sessions", "nonPhoneSessions", "selected", "keyAgree", "keyMismatch", "keyAmbiguous", "mapRefused"),
    { phones: 3, sessions: 6, nonPhoneSessions: 1, selected: 6, keyAgree: 1, keyMismatch: 0, keyAmbiguous: 0, mapRefused: false },
  );
  assert.deepEqual(
    pick(s, "withMap", "withTranscriptKey", "withoutKey", "withoutKeyWithPhone", "noTranscript", "fresh", "live", "deferred", "shared", "sharedSessions"),
    { withMap: 4, withTranscriptKey: 1, withoutKey: 1, withoutKeyWithPhone: 1, noTranscript: 0, fresh: 1, live: 0, deferred: 1, shared: 0, sharedSessions: 0 },
  );
  assert.deepEqual(pick(s, "dirs", "entries", "uploads", "conflicts", "transcripts", "otherPhones", "thinkingWithPhone", "keysWithPhone"),
    { dirs: 3, entries: 5, uploads: 4, conflicts: 3, transcripts: 4, otherPhones: 1, thinkingWithPhone: 0, keysWithPhone: 0 });
  assert.deepEqual(s.repl, { phrase: 4, dirs: 7, uploads: 3, other: 1, kept: 0 });
  assert.deepEqual(pick(s, "orphans", "orphansWithPhone", "orphanDirs", "orphanUploads", "mapBadLines", "errors", "written"),
    { orphans: 2, orphansWithPhone: 1, orphanDirs: 1, orphanUploads: 1, mapBadLines: 1, errors: 0, written: 0 });
  assert.deepEqual(state(w.base), before);
  assert.equal(s.journal, null);
});

test("применение, сессия A: конфликты получают «(прежний)», пути — на итоговые имена; метаданные транскрипта прежние; таблица без номера", async (t) => {
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
  // Таблица — по fs_key, без номера, 600; журнал — без номеров.
  const table = fs.readFileSync(w.statePath, "utf8");
  assert.equal(fs.statSync(w.statePath).mode & 0o777, 0o600);
  assert.ok(!table.includes(PHONE), "в таблице нет номера");
  assert.ok(table.includes(a.fk));
  const journal = fs.readFileSync(w.journalPath, "utf8");
  assert.ok(!journal.includes(PHONE) && !journal.includes(OTHER));
  assert.ok(journal.includes(a.rel));
});

test("применение, весь релей: двухчастный ключ, права новой папки, запасной fs_key; без fs_key, свежий номер и сироты не тронуты", async (t) => {
  const { w, s: S } = fullWorld(t);
  const untouched = [S.E, S.G].map((x) => [x.file, fs.readFileSync(x.file)]);
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
  // E, G и сироты — байт в байт; их папки и чужие файлы — на месте.
  for (const [f, buf] of [...untouched, ...orphansBefore]) assert.ok(fs.readFileSync(f).equals(buf), f);
  for (const k of [S.E.key, S.G.key, PHONE + "_99_ru"]) assert.ok(exists(w.out, k), k);
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
  assert.deepEqual(pick(s1, "written", "changedDuringWrite"), { written: 0, changedDuringWrite: 1 });
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

test("второй заход у сессии БЕЗ конфликтов: таблица пишется до переноса — пути загрузок верные, а не <fs_key>_14_ru_…", async (t) => {
  const w = relayWorld(t);
  const key = PHONE + "_22_ru";
  const fk = fsKeyOf(key);
  put(w.out, key + "/f.txt", "f");
  put(w.up, key + "_doc.pdf", "doc");
  const n = addSession(w, key, [preTurn(w, key, "Посмотри", ["doc.pdf"]), postTurn(w, fk, "Ещё")]);

  const s1 = await runScrub(runOpts(w, { apply: true }), {
    commit: (file, stat, out) => {
      fs.appendFileSync(file, JSON.stringify(assistant("дописано CLI")) + "\n");
      return commitFile(file, stat, out);
    },
  });
  assert.equal(s1.changedDuringWrite, 1);
  assert.equal(read(w.up, fk + "_doc.pdf"), "doc");
  const table = fs.readFileSync(w.statePath, "utf8");
  assert.ok(table.includes(fk) && table.includes("doc.pdf") && !table.includes(PHONE));

  const s2 = await runScrub(runOpts(w, { apply: true, minAgeMs: 0 }));
  assert.equal(s2.written, 1);
  const msg = parsed(fs.readFileSync(n.file))[0].message.content;
  assert.ok(msg.includes("- " + path.join(w.up, fk + "_doc.pdf") + " (name: doc.pdf"), msg);
  assert.ok(msg.includes("Output directory for created files: " + path.join(w.out, fk) + "\n\n" + NEW));
  assert.ok(!fs.readFileSync(n.file, "utf8").includes(PHONE));
});

test("путь на папку соседней сессии номера — на её fs_key; на непереносимую (без fs_key) — как есть", async (t) => {
  const w = relayWorld(t);
  const b = sessionB(w);
  const e = sessionE(w);
  const a = sessionA(w);
  fs.appendFileSync(
    a.file,
    JSON.stringify(toolUse("Read", { file_path: path.join(w.out, b.key, "old.txt") })) + "\n" +
      JSON.stringify(toolUse("Read", { file_path: path.join(w.out, e.key, "e.txt") })) + "\n",
  );
  fs.utimesSync(a.file, hourAgo(), hourAgo());

  const s = await runScrub(runOpts(w, { apply: true }));
  const rows = parsed(fs.readFileSync(a.file));
  assert.equal(rows.at(-2).message.content[0].input.file_path, path.join(w.out, b.fk, "old.txt"));
  assert.equal(read(w.out, b.fk, "old.txt"), "старое");
  assert.equal(rows.at(-1).message.content[0].input.file_path, path.join(w.out, e.key, "e.txt"), "папка E не переносится — путь живой");
  assert.equal(read(w.out, e.key, "e.txt"), "e");
  assert.equal(s.repl.kept, 1);
});

test("повторный прогон ничего не находит и ничего не пишет", async (t) => {
  const { w } = fullWorld(t);
  await runScrub(runOpts(w, { apply: true }));
  const before = state(w.base);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(pick(s, "written", "dirs", "entries", "uploads", "transcripts"), { written: 0, dirs: 0, entries: 0, uploads: 0, transcripts: 0 });
  assert.deepEqual(state(w.base), before);
});

test("--finish: пока есть работа — отказ и всё на месте; после прохода — удаляет таблицу и обе карты", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  saveStandMap(w);

  const early = await finishScrub(runOpts(w));
  assert.equal(early.ok, false);
  assert.ok(early.reasons.length > 0);
  assert.deepEqual(early.removed, []);
  assert.ok(fs.existsSync(w.mapPath));

  await runScrub(runOpts(w, { apply: true }));
  assert.ok(fs.existsSync(w.statePath));
  const done = await finishScrub(runOpts(w));
  assert.equal(done.ok, true, done.reasons.join("; "));
  assert.deepEqual(done.removed.sort(), [w.mapPath, w.statePath, w.standMapPath].sort());
  assert.ok(!fs.existsSync(w.mapPath) && !fs.existsSync(w.statePath) && !fs.existsSync(w.standMapPath));
});

test("--finish отказывает, пока у сессии без fs_key номер в транскрипте: причина названа", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  sessionE(w);
  await runScrub(runOpts(w, { apply: true }));

  const f = await finishScrub(runOpts(w));
  assert.equal(f.ok, false);
  assert.ok(f.reasons.includes("без fs_key с номером: 1"), f.reasons.join("; "));
  assert.ok(fs.existsSync(w.mapPath));
});

test("сессия без транскрипта: папка переносится по карте", async (t) => {
  const w = relayWorld(t);
  sessionA(w); // карта сверяется по ходу после части Б
  const key = PHONE + "_19_ru";
  put(w.out, key + "/h.txt", "h");
  const x = addSession(w, key, null);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.equal(s.noTranscript, 1);
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

test("карта на чужой соли: сухой прогон предупреждает, --apply отказывает — ничего не тронуто", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  sessionB(w);
  for (const k of w.map.keys()) w.map.set(k, fsKeyOf(k, "чужая соль"));
  saveWorld(w);
  const before = state(w.base);

  const dry = await runScrub(runOpts(w));
  assert.deepEqual(pick(dry, "keyAgree", "keyMismatch", "mapRefused"), { keyAgree: 0, keyMismatch: 1, mapRefused: true });
  await assert.rejects(runScrub(runOpts(w, { apply: true })), { code: "EMAPCHECK" });
  assert.deepEqual(state(w.base), before);
});

test("расхождение карты хотя бы в одной сессии (в том числе свежей) — --apply отказывает", async (t) => {
  const { w } = fullWorld(t, { mismatch: true });
  const before = state(w.base);
  const dry = await runScrub(runOpts(w));
  assert.deepEqual(pick(dry, "keyAgree", "keyMismatch", "mapRefused"), { keyAgree: 1, keyMismatch: 1, mapRefused: true });
  await assert.rejects(runScrub(runOpts(w, { apply: true })), { code: "EMAPCHECK" });
  assert.deepEqual(state(w.base), before);
});

test("карту нечем сверить (ни одного хода после части Б) — --apply отказывает", async (t) => {
  const w = relayWorld(t);
  sessionB(w);
  await assert.rejects(runScrub(runOpts(w, { apply: true })), { code: "EMAPCHECK" });
  assert.ok(exists(w.out, PHONE + "_14"));
});

test("два разных fs_key в одном транскрипте: сессия не трогается, считается отдельно, применение не останавливает", async (t) => {
  const w = relayWorld(t);
  const a = sessionA(w);
  const key = PHONE + "_23_ru";
  put(w.out, key + "/h.txt", "h");
  const h = addSession(w, key, [preTurn(w, key, "Ход"), postTurn(w, fsKeyOf(key), "Ход"), postTurn(w, "a".repeat(32), "Ход")]);
  const before = fs.readFileSync(h.file);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.equal(s.keyAmbiguous, 1);
  assert.ok(fs.readFileSync(h.file).equals(before));
  assert.ok(exists(w.out, key, "h.txt"));
  assert.ok(!fs.readFileSync(a.file, "utf8").includes(PHONE));
});

test("общая старая папка (ключи длиннее 48 знаков): папка и загрузки не трогаются, в транскриптах — только строка и userId", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const keyRu = PHONE + "_custom:0b7c9d1e-5a2f-4c3b-9e8d-7f6a5b4c3d2e_ru";
  const keyEn = PHONE + "_custom:0b7c9d1e-5a2f-4c3b-9e8d-7f6a5b4c3d2e_en";
  const shared = keyRu.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  assert.equal(shared, keyEn.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48));
  put(w.out, shared + "/c.txt", "c");
  put(w.up, shared + "_x.pdf", "x");
  const mk = (key) =>
    addSession(w, key, [preTurn(w, key, "Ход", ["x.pdf"], shared), toolUse("mcp__linkeon__read_calendar", { userId: PHONE })]);
  const ru = mk(keyRu);
  const en = mk(keyEn);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(pick(s, "shared", "sharedSessions", "errors"), { shared: 1, sharedSessions: 2, errors: 0 });
  assert.equal(read(w.out, shared, "c.txt"), "c");
  assert.equal(read(w.up, shared + "_x.pdf"), "x");
  for (const x of [ru, en]) {
    const rows = parsed(fs.readFileSync(x.file));
    assert.ok(rows[0].message.content.includes("Output directory for created files: " + path.join(w.out, shared) + "\n\n" + NEW));
    assert.ok(rows[0].message.content.includes("- " + path.join(w.up, shared + "_x.pdf")));
    assert.equal(rows[1].message.content[0].input.userId, x.fk);
  }
});

test("живой процесс claude --resume <сессия>: весь её номер откладывается, другие номера идут", async (t) => {
  const w = relayWorld(t);
  const a = sessionA(w);
  const c = sessionC(w);
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--resume", a.cliId], { stdio: "ignore" });
  t.after(() => live.kill());
  const before = fs.readFileSync(a.file);

  const s = await runScrub(runOpts(w, { apply: true }));
  assert.deepEqual(pick(s, "live", "deferred"), { live: 1, deferred: 1 });
  assert.ok(fs.readFileSync(a.file).equals(before));
  assert.ok(exists(w.out, a.key));
  assert.ok(!fs.readFileSync(c.file, "utf8").includes(OTHER));
});

test("канарейка: --only-phones берёт первые N номеров со всеми их сессиями; список ключей — только их", async (t) => {
  const one = fullWorld(t);
  const cBefore = fs.readFileSync(one.s.C.file);
  const s1 = await runScrub(runOpts(one.w, { apply: true, onlyPhones: 1 }));
  assert.equal(s1.selected, 4); // A, B, D, E — все сессии первого номера
  assert.ok(!fs.readFileSync(one.s.A.file, "utf8").includes(PHONE));
  assert.ok(fs.readFileSync(one.s.C.file).equals(cBefore));

  const two = fullWorld(t);
  const aBefore = fs.readFileSync(two.s.A.file);
  const s2 = await runScrub(runOpts(two.w, { apply: true, sessionsFilter: new Set([two.s.C.key]) }));
  assert.equal(s2.selected, 1);
  assert.ok(!fs.readFileSync(two.s.C.file, "utf8").includes(OTHER));
  assert.ok(fs.readFileSync(two.s.A.file).equals(aBefore));
});

// S — ходы после части Б только со стенда (его соль), M — с прода и со стенда.
function sessionS(w) {
  const key = PHONE + "_24_ru";
  put(w.out, key + "/s.txt", "s");
  return addSession(w, key, [preTurn(w, key, "Ход"), postTurn(w, fsKeyOf(key, STAND), "Ход стенда")]);
}
function sessionM(w) {
  const key = PHONE + "_26_ru";
  put(w.out, key + "/m.txt", "m");
  return addSession(w, key, [preTurn(w, key, "Ход"), postTurn(w, fsKeyOf(key), "Ход прода"), postTurn(w, fsKeyOf(key, STAND), "Ход стенда")]);
}

test("карта стенда: ходы стенда — не расхождение; смешанная сессия — в пользу прода; папки — под fs_key прода", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const st = sessionS(w);
  const mx = sessionM(w);

  // Без карты стенда его ходы выглядят расхождением — --apply отказал бы целиком.
  const blind = await runScrub(runOpts(w));
  assert.deepEqual(pick(blind, "keyMismatch", "mapRefused"), { keyMismatch: 1, mapRefused: true });

  saveStandMap(w);
  const dry = await runScrub(runOpts(w));
  assert.deepEqual(
    pick(dry, "keyAgree", "keyMismatch", "keyAmbiguous", "keyStand", "keyMixed", "mapRefused"),
    { keyAgree: 2, keyMismatch: 0, keyAmbiguous: 0, keyStand: 1, keyMixed: 1, mapRefused: false },
  );
  const s = await runScrub(runOpts(w, { apply: true }));
  assert.equal(s.errors, 0, JSON.stringify(s.errorList));
  assert.equal(read(w.out, st.fk, "s.txt"), "s");
  assert.equal(read(w.out, mx.fk, "m.txt"), "m");
  for (const x of [st, mx]) {
    const text = fs.readFileSync(x.file, "utf8");
    assert.ok(!text.includes(PHONE), x.rel);
    assert.ok(text.includes(path.join(w.out, fsKeyOf(x.key, STAND))), "пути стенда не тронуты");
    assert.ok(parsed(Buffer.from(text))[0].message.content.includes("Output directory for created files: " + path.join(w.out, x.fk) + "\n\n" + NEW));
  }
});

test("карта стенда не спасает чужую соль: ход ни прода, ни стенда — расхождение, --apply отказывает", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const key = PHONE + "_27_ru";
  put(w.out, key + "/q.txt", "q");
  addSession(w, key, [preTurn(w, key, "Ход"), postTurn(w, fsKeyOf(key, "третья соль"), "Ход")]);
  saveStandMap(w);
  const before = state(w.base);

  const dry = await runScrub(runOpts(w));
  assert.deepEqual(pick(dry, "keyMismatch", "mapRefused"), { keyMismatch: 1, mapRefused: true });
  await assert.rejects(runScrub(runOpts(w, { apply: true })), { code: "EMAPCHECK" });
  assert.deepEqual(state(w.base), before);
});

test("канарейка: в списке ключей должны быть ВСЕ сессии номера и только существующие ключи", async (t) => {
  const { w, s } = fullWorld(t);
  const before = state(w.base);
  await assert.rejects(runScrub(runOpts(w, { apply: true, sessionsFilter: new Set([s.A.key]) })), { code: "EPARTIAL" });
  await assert.rejects(
    runScrub(runOpts(w, { apply: true, sessionsFilter: new Set([s.C.key, phoneN(999) + "_1_ru"]) })),
    { code: "EKEYSUNKNOWN" },
  );
  assert.deepEqual(state(w.base), before);

  const all = await runScrub(runOpts(w, { apply: true, sessionsFilter: new Set([s.A.key, s.B.key, s.D.key, s.E.key]) }));
  assert.equal(all.selected, 4);
  assert.ok(!fs.readFileSync(s.A.file, "utf8").includes(PHONE));
});

test("причины пропуска выбранных сессий считаются отдельно: «к записи 0» не путается с успехом", async (t) => {
  const { w, s } = fullWorld(t);
  addSession(w, THIRD + "_19_ru", [preTurn(w, THIRD + "_19_ru", "Ход")]); // номер G занят свежей сессией
  const r = await runScrub(runOpts(w));
  assert.deepEqual(r.sel, { processed: 4, nokey: 1, ambiguous: 0, mismatch: 0, fresh: 1, live: 0, busy: 1, shared: 0, error: 0 });
  void s;
});

test("--list-residual: id сессий CLI, где номер владельца остаётся после чистки, с причинами; ничего не меняет", async (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const c = sessionC(w);
  const e = sessionE(w);
  // T — номер в блоке рассуждений: его не трогаем.
  const keyT = PHONE + "_25_ru";
  const think = assistant("");
  think.message.content = [{ type: "thinking", thinking: "Номер " + PHONE, signature: "EqQBCkYI" }, { type: "text", text: "ок" }];
  const tr = addSession(w, keyT, [preTurn(w, keyT, "Ход"), think, postTurn(w, fsKeyOf(keyT), "Ход")]);
  // Общая папка: пути в её транскриптах остаются с номером.
  const keyRu = PHONE + "_custom:0b7c9d1e-5a2f-4c3b-9e8d-7f6a5b4c3d2e_ru";
  const keyEn = PHONE + "_custom:0b7c9d1e-5a2f-4c3b-9e8d-7f6a5b4c3d2e_en";
  const shared = keyRu.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  put(w.out, shared + "/c.txt", "c");
  const ru = addSession(w, keyRu, [preTurn(w, keyRu, "Ход", [], shared)]);
  const en = addSession(w, keyEn, [preTurn(w, keyEn, "Ход", [], shared)]);
  await runScrub(runOpts(w, { apply: true }));
  const before = state(w.base);

  const listPath = path.join(w.base, "residual.txt");
  const r = await runScrub(runOpts(w, { residual: true }));
  assert.deepEqual(r.residual.counts, {
    "рассуждения": 1, "пути": 2, "без fs_key": 1, "неоднозначная": 0, "расхождение": 0,
    "битые строки": 0, "неканоничные строки": 0, "ждёт прохода": 0, "ошибка": 0,
  });
  const rows = new Map(r.residual.list.map((x) => [x.id, x.reasons]));
  assert.deepEqual([...rows.keys()].sort(), [tr.cliId, ru.cliId, en.cliId, e.cliId].sort());
  assert.deepEqual(rows.get(tr.cliId), ["рассуждения"]);
  assert.deepEqual(rows.get(e.cliId), ["без fs_key"]);
  assert.ok(!rows.has(c.cliId), "чистая сессия не в списке");
  assert.deepEqual(state(w.base), before);
  void listPath;
});

// ---------------------------------------------------------------- запуск

const SCRIPT = fileURLToPath(new URL("./relay-scrub-phone.mjs", import.meta.url));
const cliArgs = (w, extra = []) => [
  "--root", w.root, "--sessions", w.sessionsPath, "--outputs", w.out, "--uploads", w.up,
  "--fs-key-map", w.mapPath, "--state", w.statePath,
  ...(w.standMapPath ? ["--stand-map", w.standMapPath] : []), ...extra,
];
const cli = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
// На релей скрипт едет через stdin: ssh … 'node --input-type=module - <флаги>' < scripts/relay-scrub-phone.mjs.
// Тогда argv[1] — "-", а import.meta.url — не путь к файлу.
const viaStdin = (args, { input = fs.readFileSync(SCRIPT), env = {} } = {}) =>
  spawnSync(process.execPath, ["--input-type=module", "-", ...args], { input, encoding: "utf8", env: { ...process.env, ...env } });
const noPhones = (text) => !text.includes(PHONE) && !text.includes(OTHER) && !text.includes(THIRD);

test("CLI: без --apply — сухой прогон: все счётчики, ни одного номера в выводе, на диске ничего не меняется", (t) => {
  const { w } = fullWorld(t);
  const before = state(w.base);

  const r = cli(cliArgs(w));
  assert.equal(r.status, 0, r.stderr);
  for (const re of [
    /сухой прогон/,
    /^карта fs_key: .+, строк с ошибкой: 1$/m,
    /^карта стенда: не задана$/m,
    /^сверка карты с транскриптами: совпало 1, расхождений 0, неоднозначных 0, ходы стенда 0, смешанных 0$/m,
    /^номеров: 3; сессий: 6 \(без номера: 1\); выбрано: 6$/m,
    /^выбранные сессии: обработано 4; пропущено: без fs_key 1, неоднозначных 0, расхождений 0, свежих 1, с живым процессом 0, номер занят 0, общая папка 0, с ошибкой 0$/m,
    /^fs_key: из карты 4, из транскрипта 1, без fs_key 1 \(из них с номером: 1\)$/m,
    /^свежих: 1, с живым процессом CLI: 0; отложено сессий \(весь номер\): 1\b/m,
    /^без транскрипта: 0$/m,
    /^общих старых папок \(не трогаются\): 0, их сессий: 0$/m,
    /^папок к переносу: 3, записей в них: 5, загрузок: 4, конфликтов имён: 3$/m,
    /^замен в транскриптах: фраза 4, пути папок 7, пути загрузок 3, прочие 1; оставлено в путях: 0; транскриптов к записи: 4$/m,
    /^транскриптов с номерами других пользователей: 1$/m,
    /^блоков рассуждений с номером \(не трогаются\): 0; ключей JSON с номером \(не трогаются\): 0$/m,
    /^сирот: 2, из них с номером: 1; папок без сессии: 1; загрузок без сессии: 1$/m,
    /^битых строк: 0, из них с номером: 0$/m,
    /^строк, где JSON.stringify меняет не только замены \(не пишутся\): 0$/m,
    /^ошибок: 0$/m,
  ]) assert.match(r.stdout, re);
  assert.doesNotMatch(r.stdout, /переписано|откажет/);
  assert.ok(noPhones(r.stdout + r.stderr));
  assert.deepEqual(state(w.base), before);

  const all = cli(cliArgs(w, ["--min-age-min", "0"]));
  assert.match(all.stdout, /^свежих: 0, с живым процессом CLI: 0; отложено сессий \(весь номер\): 0$/m, "порог свежести задаётся флагом");
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

test("CLI --finish: пока есть работа — код 1 и причины; после прохода — удаляет таблицу и карту, код 0", (t) => {
  const w = relayWorld(t);
  sessionA(w);

  const early = cli(cliArgs(w, ["--finish"]));
  assert.equal(early.status, 1, early.stdout + early.stderr);
  assert.match(early.stdout, /не всё сделано — .*папок к переносу: 1/);
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
  const keysFile = path.join(w.home, "keys.txt");
  fs.writeFileSync(keysFile, PHONE + "_14_ru\n");
  fs.chmodSync(keysFile, 0o640); // ключи с номерами видит группа — не работаем
  const cases = [
    cliArgs(w, ["--bogus"]),
    cliArgs(w, ["лишний-аргумент"]),
    cliArgs(w, ["--min-age-min", "abc"]),
    cliArgs(w, ["--min-age-min", "-1"]),
    cliArgs(w, ["--only-phones", "0"]),
    cliArgs(w, ["--only-phones", "абв"]),
    cliArgs(w, ["--only-phones", "1", "--sessions-file", keysFile]),
    cliArgs(w, ["--sessions-file", keysFile]),
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
  fs.rmSync(keysFile);
  assert.deepEqual(state(w.base), before);

  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--fs-key-map/);
  assert.match(help.stdout, /--only-phones/);
});

test("CLI: карта на чужой соли — --apply с кодом 2 и объяснением, сухой прогон предупреждает", (t) => {
  const w = relayWorld(t);
  sessionA(w);
  for (const k of w.map.keys()) w.map.set(k, fsKeyOf(k, "чужая соль"));
  saveWorld(w);
  const before = state(w.base);

  const dry = cli(cliArgs(w));
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /--apply откажет/);
  const r = cli(cliArgs(w, ["--apply", "--journal", w.journalPath]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /карта fs_key не сходится с транскриптами: совпало 0, расхождений 1/);
  assert.deepEqual(state(w.base), before);
});

test("CLI: канарейка по списку ключей (--sessions-file, 600)", (t) => {
  const { w, s } = fullWorld(t);
  const keysFile = path.join(w.home, "keys.txt");
  fs.writeFileSync(keysFile, s.C.key + "\n", { mode: 0o600 });
  const aBefore = fs.readFileSync(s.A.file);

  const r = cli(cliArgs(w, ["--apply", "--journal", w.journalPath, "--sessions-file", keysFile]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /выбрано: 1$/m);
  assert.ok(!fs.readFileSync(s.C.file, "utf8").includes(OTHER));
  assert.ok(fs.readFileSync(s.A.file).equals(aBefore));
});

test("CLI: --stand-map (600) снимает отказ из-за ходов стенда; неполный список номера — код 2", (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const st = sessionS(w);
  const blind = cli(cliArgs(w, ["--apply", "--journal", w.journalPath]));
  assert.equal(blind.status, 2);
  assert.match(blind.stderr, /не сходится с транскриптами/);

  saveStandMap(w);
  fs.chmodSync(w.standMapPath, 0o640);
  const open = cli(cliArgs(w));
  assert.equal(open.status, 2);
  assert.match(open.stderr, /карта стенда доступна не только владельцу — chmod 600/);
  fs.chmodSync(w.standMapPath, 0o600);

  const keys = path.join(w.home, "canary.keys");
  fs.writeFileSync(keys, st.key + "\n", { mode: 0o600 }); // у номера ещё A
  const partial = cli(cliArgs(w, ["--sessions-file", keys]));
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /не все сессии номера/);

  const r = cli(cliArgs(w, ["--apply", "--journal", w.journalPath]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^карта стенда: .+, строк с ошибкой: 0$/m);
  assert.match(r.stdout, /ходы стенда 1, смешанных 0$/m);
  assert.equal(read(w.out, st.fk, "s.txt"), "s");
  assert.ok(noPhones(r.stdout + r.stderr));
});

test("CLI --list-residual: файл 600 с id сессий и причинами, без ключей и номеров; ничего не меняет", (t) => {
  const w = relayWorld(t);
  sessionA(w);
  const e = sessionE(w);
  assert.equal(cli(cliArgs(w, ["--apply", "--journal", w.journalPath])).status, 0);
  const before = state(w.base);
  const listPath = path.join(tmpRoot(t), "residual.txt");

  const r = cli(cliArgs(w, ["--list-residual", listPath]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^сессий с остатком номера: 1 — .*без fs_key 1/m);
  assert.equal(fs.statSync(listPath).mode & 0o777, 0o600);
  const text = fs.readFileSync(listPath, "utf8");
  assert.equal(text, e.cliId + "\tбез fs_key\n");
  assert.ok(noPhones(r.stdout + r.stderr + text));
  assert.deepEqual(state(w.base), before);
  assert.equal(cli(cliArgs(w, ["--list-residual", listPath, "--apply"])).status, 2, "только чтение — без --apply");
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

for (const sig of ["SIGINT", "SIGHUP"]) {
  test(`CLI: ${sig} — текущий номер доделывается, проход останавливается; полусделанных сессий нет, код 130`, async (t) => {
    const w = relayWorld(t);
    const filler = assistant("ответ ".repeat(300));
    const list = [];
    for (let i = 0; i < 150; i++) {
      const key = phoneN(i) + "_14_ru";
      put(w.out, key + "/f.txt", "f" + i);
      list.push(addSession(w, key, [preTurn(w, key, "Ход " + i), ...Array(100).fill(filler), postTurn(w, fsKeyOf(key), "Ход")], { save: false }));
    }
    saveWorld(w);

    const child = spawn(process.execPath, [SCRIPT, ...cliArgs(w, ["--apply", "--journal", w.journalPath])], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    // Сигнал — когда в журнале появилась первая запись: проход точно идёт.
    const deadline = Date.now() + 60_000;
    while (!(fs.existsSync(w.journalPath) && fs.statSync(w.journalPath).size > 0)) {
      assert.ok(Date.now() < deadline, "журнал не появился");
      await new Promise((r) => setTimeout(r, 5));
    }
    child.kill(sig);
    const { code, signal } = await closed;

    assert.equal(signal, null, "процесс не убит сигналом, а завершился сам");
    assert.equal(code, 130);
    assert.match(stdout, /ПРЕРВАНО/);
    const done = new Set(fs.readFileSync(w.journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).transcript));
    assert.ok(done.size >= 1 && done.size < list.length, "сделано " + done.size);
    for (const x of list) {
      const moved = !exists(w.out, x.key);
      const clean = !fs.readFileSync(x.file, "utf8").includes(x.key.slice(0, 11));
      assert.equal(moved, clean, x.rel + ": папка и транскрипт — вместе");
      assert.equal(done.has(x.rel), clean, x.rel + ": журнал совпадает с диском");
    }
    assert.deepEqual(fs.readdirSync(path.join(w.root, "-tmp")).filter((n) => n.startsWith(".")), [], "временных файлов нет");
  });
}

// ---------------------------------------------------------------- объём

// Транскрипт около 1 МБ: каждая четвёртая строка — реплика с фразой.
function bigTranscript(num) {
  const rows = [];
  let size = 0;
  for (let i = 0; size < 1024 * 1024; i++) {
    const row = JSON.stringify(i % 4 === 0 ? user(turn("вопрос " + i, num)) : assistant("ответ ".repeat(200) + i));
    rows.push(row);
    size += Buffer.byteLength(row) + 1;
  }
  return rows.join("\n") + "\n";
}

test("200 сессий по 1 МБ транскрипта: меньше минуты, в памяти — текущая сессия, после прохода ничего не копится", (t) => {
  const w = relayWorld(t);
  let perFile = 0;
  let size = 0;
  for (let i = 0; i < 200; i++) {
    const num = phoneN(i);
    const key = num + "_14_ru";
    const content = bigTranscript(num) + JSON.stringify(postTurn(w, fsKeyOf(key), "x")) + "\n";
    perFile = content.split(OLD(num)).length - 1;
    size = Buffer.byteLength(content);
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
    `200 × ${(size / 2 ** 20).toFixed(2)} МБ, ${perFile} фраз в транскрипте: ` +
      `${(m.ms / 1000).toFixed(1)} с; удержано в пике ${m.peakMb.toFixed(1)} МБ, после прохода ${m.leakMb.toFixed(1)} МБ`,
  );
  assert.deepEqual(pick(m.summary, "written", "moved", "movedUploads", "errors", "nonCanonicalLines"),
    { written: 200, moved: 200, movedUploads: 200, errors: 0, nonCanonicalLines: 0 });
  assert.equal(m.summary.repl.phrase, 200 * perFile);
  assert.ok(m.ms < 60_000, "проход занял " + Math.round(m.ms) + " мс");
  assert.ok(m.peakMb < 64, "в пике удержано " + m.peakMb.toFixed(1) + " МБ — транскрипты копятся в памяти");
  assert.ok(m.leakMb < 16, "после прохода удержано " + m.leakMb.toFixed(1) + " МБ");
});
