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
import { scrubContent } from "./scrub-phone-line.mjs";

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
