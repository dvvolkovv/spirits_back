// Разовая чистка транскриптов релея от строки «Current user phone …: <номер>».
//
// До 01.11.2026 релей вклеивал в каждую реплику пользователя строку
//   Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): <номер>
// Из кода её убрали, но в транскриптах claude-сессий (~/.claude/projects/*/*.jsonl)
// она осталась и уходит модели при каждом --resume, пока сессия не повернётся
// по размеру. Скрипт заменяет её нейтральной «Current user: identifier omitted.»
// прямо в транскриптах. Спека: spirits_back
// docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 5.
//
// Запуск — на релее, от dv (владельца транскриптов). Скрипт разовый и в
// дерево релея не кладётся: едет через stdin.
//   ssh <релей> 'node --input-type=module -' < scripts/relay-scrub-phone.mjs
//       сухой прогон: только счётчики
//   ssh <релей> 'node --input-type=module - --apply' < scripts/relay-scrub-phone.mjs
//       замена + журнал
// Флаги: --root <каталог> (по умолчанию ~/.claude/projects; смотрятся
// <root>/*/*.jsonl), --min-age-min <минуты> (по умолчанию 15),
// --journal <файл> (по умолчанию ~/scrub-phone-line-<метка>.jsonl).
// Коды выхода: 0 — без ошибок, 1 — были ошибки на файлах, 2 — ошибка
// запуска (ничего не тронуто), 130 — прерван сигналом.
//
// Как устроено:
// - строка файла разбирается как JSON, фраза ищется во всех строковых
//   значениях. Строка без замены остаётся прежними байтами, с заменой —
//   JSON.stringify: CLI сам пишет строку как JSON.stringify(запись), поэтому
//   вне фразы байты те же (счётчик «меняет не только фразу» это проверяет);
// - битая строка остаётся как есть и считается; с фразой — отдельно: номер
//   в ней остался;
// - запись атомарная: временный файл рядом (.<имя>.scrub-<pid>-<hex>.tmp) с
//   правами, владельцем и временем исходного → сверка, что исходный не
//   менялся с чтения → rename. Копий исходника не остаётся;
// - свежие файлы (mtime моложе --min-age-min) и изменённые во время прохода
//   пропускаются — их проходят вторым заходом;
// - журнал и вывод — без номеров и без содержимого.
//
// Node 22, ESM, без зависимостей: на релее системный Node, без nvm и npm.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// Строгая форма строки — ровно та, что собирал релей. Номер — 10–15 цифр,
// иногда с «+».
const PHRASE_RE = /Current user phone \(use as the `userId` argument for any mcp__linkeon__\* tool call\): \+?\d{10,15}/g;
const REPLACEMENT = "Current user: identifier omitted.";
const MARKER = "Current user phone (";
// Быстрая проверка до регулярок: без десяти цифр подряд номера в строке нет.
const LONG_DIGITS = /[0-9]{10}/;
// Номер как целое число: не часть более длинной цифровой последовательности.
const ANY_PHONE_RE = /(?<![0-9])\+?([0-9]{10,15})(?![0-9])/g;

const NL = 0x0a;
const isJsonSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
// Символы имён папок и загрузок релея (paths.mjs: всё прочее он заменял на "_").
const isNameCh = (c) => c !== undefined && /[A-Za-z0-9._-]/.test(c);
// Имя записи в тексте кончилось: дальше разделитель пути, пробел, кавычка,
// скобка, знак препинания — или точка в конце предложения.
function endsName(s, i) {
  const c = s[i];
  if (c === undefined || /[\s/"'`)\]}>,;:|*?<&]/.test(c)) return true;
  return c === "." && (s[i + 1] === undefined || /\s/.test(s[i + 1]));
}

// Правила транскрипта одной телефонной сессии:
// 1) строка «Current user phone …» → нейтральная;
// 2) старая папка хода <oldDir> (имя целиком) → <fsKey>; запись, переименованная
//    при конфликте, — на итоговое имя;
// 3) загрузка <oldDir>_<имя> (имя — из загрузок этой сессии) → <fsKey>_<итоговое имя>;
// 4) остальные вхождения номера владельца как целого числа → <fsKey>.
// Номера других пользователей не трогаются; otherPhones говорит, есть ли в
// строке номер из таблицы — для счётчика.
export function sessionRules({
  phone, oldDir, fsKey,
  outNames = [], outRenames = new Map(), upRests = [], upRenames = new Map(),
  tablePhones = new Set(),
}) {
  // Длинные имена первыми: «a b.txt» не должен стать «a» + « b.txt».
  const byLength = (list) => [...new Set(list)].sort((a, b) => b.length - a.length);
  const names = byLength(outNames);
  const rests = byLength(upRests);
  const ownPhoneRe = new RegExp("(?<![0-9])\\+?" + phone + "(?![0-9])", "g");
  const upPrefix = oldDir + "_";

  function dirs(s, counts) {
    let out = "";
    let from = 0;
    let changed = false;
    let i = s.indexOf(oldDir);
    while (i !== -1) {
      const end = i + oldDir.length;
      if (isNameCh(s[i - 1]) || isNameCh(s[end])) {
        i = s.indexOf(oldDir, i + 1);
        continue;
      }
      let repl = fsKey;
      let next = end;
      if (s[end] === "/") {
        const name = names.find((n) => s.startsWith(n, end + 1) && endsName(s, end + 1 + n.length));
        if (name !== undefined && outRenames.has(name)) {
          repl = fsKey + "/" + outRenames.get(name);
          next = end + 1 + name.length;
        }
      }
      out += s.slice(from, i) + repl;
      from = next;
      changed = true;
      counts.dirs++;
      i = s.indexOf(oldDir, next);
    }
    return changed ? out + s.slice(from) : s;
  }

  function uploads(s, counts) {
    let out = "";
    let from = 0;
    let changed = false;
    let i = s.indexOf(upPrefix);
    while (i !== -1) {
      const at = i + upPrefix.length;
      const rest = isNameCh(s[i - 1]) ? undefined : rests.find((r) => s.startsWith(r, at) && endsName(s, at + r.length));
      if (rest === undefined) {
        i = s.indexOf(upPrefix, i + 1);
        continue;
      }
      out += s.slice(from, i) + fsKey + "_" + (upRenames.get(rest) ?? rest);
      from = at + rest.length;
      changed = true;
      counts.uploads++;
      i = s.indexOf(upPrefix, from);
    }
    return changed ? out + s.slice(from) : s;
  }

  return {
    transform(s, counts) {
      if (!s.includes(MARKER) && !LONG_DIGITS.test(s)) return s;
      let x = s.replace(PHRASE_RE, () => {
        counts.phrase++;
        return REPLACEMENT;
      });
      if (x.includes(oldDir)) x = uploads(dirs(x, counts), counts);
      return x.replace(ownPhoneRe, () => {
        counts.other++;
        return fsKey;
      });
    },
    otherPhones(s) {
      if (!LONG_DIGITS.test(s)) return false;
      for (const m of s.matchAll(ANY_PHONE_RE)) if (m[1] !== phone && tablePhones.has(m[1])) return true;
      return false;
    },
    // Битая строка: есть ли в ней то, что правила заменили бы.
    touches(s) {
      return s.includes(MARKER) || s.search(ownPhoneRe) !== -1;
    },
  };
}

// Замены во всех строковых значениях разобранного JSON. Объект правится на
// месте: присваивание существующему ключу его места в порядке ключей не меняет.
function scrubValue(v, ctx) {
  if (typeof v === "string") {
    const x = ctx.rules.transform(v, ctx.counts);
    if (x !== v) ctx.changed = true;
    if (!ctx.otherPhones && ctx.rules.otherPhones(x)) ctx.otherPhones = true;
    return x;
  }
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x = scrubValue(v[i], ctx);
      if (x !== v[i]) v[i] = x;
    }
    return v;
  }
  for (const k of Object.keys(v)) {
    const x = scrubValue(v[k], ctx);
    if (x !== v[k]) v[k] = x;
  }
  return v;
}

// Одна строка файла (без "\n"). text === null — строка остаётся прежними байтами.
function scrubLine(lineBuf, rules, counts) {
  const res = { text: null, broken: false, brokenWithPhone: false, otherPhones: false, nonCanonical: false };
  if (lineBuf.length === 0) return res;
  const s = lineBuf.toString("utf8");
  // Как CLI при чтении: ведущие NUL пропускаются (остаются от оборванной
  // записи). Они и пробелы вокруг JSON сохраняются как были.
  let a = 0;
  while (a < s.length && s.charCodeAt(a) === 0) a++;
  let end = s.length;
  while (end > a && isJsonSpace(s.charCodeAt(end - 1))) end--;
  let start = a;
  while (start < end && isJsonSpace(s.charCodeAt(start))) start++;
  if (start === end) return res; // пустая строка или одни пробелы

  const core = s.slice(start, end);
  let value;
  try {
    value = JSON.parse(core);
  } catch {
    // Битая строка остаётся как есть. Если в ней номер — он в ней остаётся,
    // и это должно быть видно в счётчиках.
    res.broken = true;
    res.brokenWithPhone = rules.touches(s);
    return res;
  }
  const ctx = { rules, counts, changed: false, otherPhones: false };
  value = scrubValue(value, ctx);
  res.otherPhones = ctx.otherPhones;
  if (!ctx.changed) return res;

  res.text = s.slice(0, start) + JSON.stringify(value) + s.slice(end);
  // CLI пишет строку как JSON.stringify(запись), поэтому повторный
  // JSON.stringify совпадает с исходником везде, кроме замен. Не совпал —
  // строку писал не CLI (или в ней не UTF-8): запись поменяет и форму JSON.
  // Смысл тот же, но это стоит видеть до применения.
  res.nonCanonical = JSON.stringify(JSON.parse(core)) !== core || !Buffer.from(s, "utf8").equals(lineBuf);
  return res;
}

// Содержимое транскрипта целиком. out === null — замен нет, файл писать не
// нужно. Строки без замены попадают в out исходными байтами.
export function scrubContent(buf, rules) {
  const sum = {
    out: null,
    counts: { phrase: 0, dirs: 0, uploads: 0, other: 0 },
    otherPhones: 0, brokenLines: 0, brokenWithPhone: 0, nonCanonicalLines: 0,
  };
  const changed = []; // [начало, конец, новые байты]
  let pos = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(NL, pos);
    if (end === -1) end = buf.length;
    const r = scrubLine(buf.subarray(pos, end), rules, sum.counts);
    if (r.broken) {
      sum.brokenLines++;
      if (r.brokenWithPhone) sum.brokenWithPhone++;
    }
    if (r.otherPhones) sum.otherPhones++;
    if (r.text !== null) {
      if (r.nonCanonical) sum.nonCanonicalLines++;
      changed.push([pos, end, Buffer.from(r.text, "utf8")]);
    }
    pos = end + 1;
  }
  if (changed.length) {
    const parts = [];
    let at = 0;
    for (const [from, to, bytes] of changed) {
      parts.push(buf.subarray(at, from), bytes);
      at = to;
    }
    parts.push(buf.subarray(at));
    sum.out = Buffer.concat(parts);
  }
  return sum;
}

// ---------------------------------------------------------------- файлы

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW } = fs.constants;
// O_NONBLOCK: если вместо файла окажется FIFO, open не повиснет.
const READ_FLAGS = O_RDONLY | O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0);

const withCode = (code) => Object.assign(new Error(code), { code });

// Прочитать транскрипт, не переходя по симлинку. { fresh: true } — файл
// менялся меньше minAgeMs назад: в нём, вероятно, идёт ход. Иначе
// { buf, stat }, где stat (bigint) снят до чтения. Если CLI допишет файл во
// время чтения, это поймает сверка в commitFile: размер и mtime разойдутся.
export async function readSnapshot(file, { minAgeMs = 0 } = {}) {
  const fh = await fsp.open(file, READ_FLAGS);
  try {
    const stat = await fh.stat({ bigint: true });
    if (!stat.isFile()) throw withCode("ENOTREG");
    if (Date.now() - Number(stat.mtimeMs) < minAgeMs) return { fresh: true };
    return { buf: await fh.readFile(), stat };
  } finally {
    await fh.close();
  }
}

// Атомарно заменить file содержимым out. Временный файл — в том же каталоге
// (rename не пересекает файловые системы), с правами, владельцем и временем
// исходного. Перед rename исходный сверяется с чтением: другой inode, размер
// или mtime — CLI мог дописать ход, файл не трогаем ("changed"). Время
// изменения сохраняется: иначе второй заход принял бы переписанные файлы за
// свежие, а очистка старых сессий CLI (по mtime) отложилась бы.
export async function commitFile(file, stat, out) {
  const tmp = path.join(
    path.dirname(file),
    "." + path.basename(file) + ".scrub-" + process.pid + "-" + randomBytes(4).toString("hex") + ".tmp",
  );
  let fh = null;
  let renamed = false;
  try {
    fh = await fsp.open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    await fh.writeFile(out);
    // chown раньше chmod: у не-root chown сбрасывает setuid/setgid.
    await fh.chown(Number(stat.uid), Number(stat.gid));
    await fh.chmod(Number(stat.mode) & 0o7777);
    await fh.utimes(Number(stat.atimeNs) / 1e9, Number(stat.mtimeNs) / 1e9);
    await fh.sync();
    await fh.close();
    fh = null;
    const now = await fsp.lstat(file, { bigint: true });
    if (now.ino !== stat.ino || now.dev !== stat.dev || now.size !== stat.size || now.mtimeNs !== stat.mtimeNs) {
      return "changed";
    }
    await fsp.rename(tmp, file);
    renamed = true;
    return "written";
  } finally {
    if (fh) await fh.close().catch(() => {});
    if (!renamed) await fsp.unlink(tmp).catch(() => {});
  }
}

// Журнал применения: строка JSON на переписанный файл — имя, число замен,
// время. Права 600. Если записей не было, а файл создан этим прогоном, он
// удаляется: повторный прогон не оставляет после себя ничего.
async function openJournal(journalPath) {
  let existed = true;
  try {
    await fsp.lstat(journalPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    existed = false;
  }
  const fh = await fsp.open(journalPath, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
  await fh.chmod(0o600);
  let rows = 0;
  return {
    async add(row) {
      await fh.write(JSON.stringify(row) + "\n");
      rows++;
    },
    async close() {
      await fh.close();
      if (rows === 0 && !existed) {
        await fsp.unlink(journalPath).catch(() => {});
        return null;
      }
      return journalPath;
    },
  };
}


// ---------------------------------------------------------------- сессии релея

// Ключ сессии телефонного пользователя: <номер>_<ассистент>[_<язык>]
// (бэк, src/chat/relay-session.ts). У почтовых и OAuth — UUID, их не трогаем.
const PHONE_KEY_RE = /^\+?([0-9]{10,15})_/;
// Имя папки или загрузки по такому ключу («+» релей заменял на «_»).
const PHONE_NAME_RE = /^_?([0-9]{10,15})_/;
const FS_KEY_RE = /^[0-9a-f]{32}$/;
const NAME_MAX = 255;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Имя папки хода по ключу сессии — как его делал релей до части Б
// (relay-agent/paths.mjs, sessionFsKey). Загрузка — это имя + "_" + имя файла.
function legacyDirName(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return safe === "" || safe === "." || safe === ".." ? null : safe;
}

async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p, { bigint: true });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function readdirOrEmpty(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function sameInode(a, b) {
  const [x, y] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
  return !!x && !!y && x.ino === y.ino && x.dev === y.dev;
}

// sessions.json релея: ключ сессии → id сессии CLI.
async function loadSessions(file) {
  const raw = JSON.parse(await fsp.readFile(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw withCode("EBADSESSIONS");
  return Object.entries(raw).filter(([, v]) => typeof v === "string" && v);
}

// Карта «ключ сессии → fs_key» (TSV) — её считает прод, у которого соль.
// В ней номера, поэтому доступна только владельцу. Ключ с двумя разными
// fs_key — не ключ, а ошибка: такой выбрасывается и считается.
async function loadFsKeyMap(file) {
  const st = await fsp.stat(file);
  if (st.mode & 0o077) throw withCode("EMAPMODE");
  const map = new Map();
  const doubtful = new Set();
  let bad = 0;
  for (const line of (await fsp.readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const key = tab > 0 ? line.slice(0, tab) : "";
    const fsKey = tab > 0 ? line.slice(tab + 1).trim() : "";
    if (!key || !FS_KEY_RE.test(fsKey)) {
      bad++;
      continue;
    }
    if (map.has(key) && map.get(key) !== fsKey) doubtful.add(key);
    map.set(key, fsKey);
  }
  for (const key of doubtful) {
    map.delete(key);
    bad++;
  }
  return { map, bad };
}

// Таблица переименований (JSONL, 600): что куда переехало при конфликте имён.
// Нужна второму заходу, когда старой папки уже нет, а транскрипт ещё не
// переписан. Строка — сессия; более поздняя дополняет раннюю.
async function loadState(file) {
  const state = new Map();
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return state;
    throw e;
  }
  for (const line of text.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // пустая или оборванная строка
    }
    if (!e || typeof e.k !== "string" || !FS_KEY_RE.test(e.f)) continue;
    const cur = state.get(e.k) ?? { f: e.f, on: new Set(), or: new Map(), un: new Set(), ur: new Map() };
    cur.f = e.f;
    for (const n of e.on ?? []) cur.on.add(n);
    for (const [a, b] of Object.entries(e.or ?? {})) cur.or.set(a, b);
    for (const n of e.un ?? []) cur.un.add(n);
    for (const [a, b] of Object.entries(e.ur ?? {})) cur.ur.set(a, b);
    state.set(e.k, cur);
  }
  return state;
}

async function appendState(file, entry) {
  const fh = await fsp.open(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
  try {
    await fh.chmod(0o600);
    await fh.write(JSON.stringify(entry) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Транскрипты: <root>/*/<id CLI>.jsonl — только обычные файлы, без симлинков.
async function indexTranscripts(root) {
  const byId = new Map();
  for (const d of (await fsp.readdir(root, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name))) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = await fsp.readdir(path.join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const id = f.name.slice(0, -".jsonl".length);
      if (!byId.has(id)) byId.set(id, path.join(root, d.name, f.name));
    }
  }
  return byId;
}

// fs_key из самого транскрипта: строка «Output directory for created files:
// <outputs>/<32 hex>» у ходов после части Б. Нет — undefined, разные — null.
function transcriptFsKey(buf, outputs) {
  const re = new RegExp(
    "Output directory for created files: " + escapeRe(path.resolve(outputs)) + "/([0-9a-f]{32})(?![A-Za-z0-9._-])",
    "g",
  );
  const found = new Set();
  for (const m of buf.toString("utf8").matchAll(re)) found.add(m[1]);
  if (found.size === 0) return undefined;
  return found.size === 1 ? [...found][0] : null;
}

function mentionsPhone(buf, phones) {
  const text = buf.toString("utf8");
  if (text.includes(MARKER)) return true;
  for (const m of text.matchAll(ANY_PHONE_RE)) if (phones.has(m[1])) return true;
  return false;
}

// Свободное имя для записи, чьё имя в новой папке занято: «имя (прежний).расш»,
// дальше «(прежний 2)»… Не длиннее NAME_MAX байт вместе с префиксом
// (у загрузок это «<fs_key>_»).
function freeName(name, isDir, isTaken, prefixBytes = 0) {
  const ext = isDir ? "" : path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const tag = n === 1 ? " (прежний)" : " (прежний " + n + ")";
    let b = base;
    while (b && prefixBytes + Buffer.byteLength(b + tag + ext) > NAME_MAX) b = Array.from(b).slice(0, -1).join("");
    const candidate = b + tag + ext;
    if (!isTaken(candidate)) return candidate;
  }
}

// План сессии: что из старой папки и загрузок куда переезжает. Решения
// прошлых заходов (таблица) сохраняются: итоговое имя у записи одно на все
// заходы, иначе пути в транскрипте разошлись бы с диском.
async function planSession(sess, fsKey, prev, ctx) {
  const oldPath = path.join(ctx.outputs, sess.oldDir);
  const newPath = path.join(ctx.outputs, fsKey);
  const oldSt = await lstatOrNull(oldPath);
  if (oldSt && !oldSt.isDirectory()) throw withCode(oldSt.isSymbolicLink() ? "ESYMLINK" : "ENOTDIR");
  const newSt = await lstatOrNull(newPath);
  if (newSt && !newSt.isDirectory()) throw withCode(newSt.isSymbolicLink() ? "ESYMLINK" : "ENOTDIR");

  const plan = {
    oldPath, newPath, oldSt, newSt,
    outNames: new Set(prev?.on), outRenames: new Map(prev?.or),
    upRests: new Set(prev?.un), upRenames: new Map(prev?.ur),
    outMoves: [], upMoves: [], conflicts: 0, newRenames: false,
  };
  if (oldSt) {
    const taken = new Set(newSt ? await fsp.readdir(newPath) : []);
    const entries = (await fsp.readdir(oldPath, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name));
    for (const ent of entries) {
      const src = path.join(oldPath, ent.name);
      plan.outNames.add(ent.name);
      let dst = plan.outRenames.get(ent.name) ?? ent.name;
      // Занято — не перезаписываем: у старой записи будет суффикс. Тот же inode
      // — это наша же жёсткая ссылка от прерванного захода.
      if (taken.has(dst) && !(await sameInode(src, path.join(newPath, dst)))) {
        dst = freeName(ent.name, ent.isDirectory(), (c) => taken.has(c));
        plan.outRenames.set(ent.name, dst);
        plan.newRenames = true;
      }
      taken.add(dst);
      if (dst !== ent.name) plan.conflicts++;
      plan.outMoves.push({ src, dst: path.join(newPath, dst), file: ent.isFile() });
    }
  }
  const prefix = fsKey + "_";
  for (const u of ctx.uploadsOf.get(sess.key) ?? []) {
    const src = path.join(ctx.uploads, u.name);
    plan.upRests.add(u.rest);
    let rest = plan.upRenames.get(u.rest) ?? u.rest;
    if (ctx.uploadNames.has(prefix + rest) && !(await sameInode(src, path.join(ctx.uploads, prefix + rest)))) {
      rest = freeName(u.rest, false, (c) => ctx.uploadNames.has(prefix + c), Buffer.byteLength(prefix));
      plan.upRenames.set(u.rest, rest);
      plan.newRenames = true;
    }
    ctx.uploadNames.add(prefix + rest);
    if (rest !== u.rest) plan.conflicts++;
    plan.upMoves.push({ src, dst: path.join(ctx.uploads, prefix + rest), file: u.file });
  }
  return plan;
}

// Перенос без перезаписи. Файл — жёсткой ссылкой (link падает, если имя
// занято) и удалением старого имени; папка — rename после проверки. Если
// жёсткие ссылки запрещены (protected_hardlinks, файловая система), — так же,
// как папка.
export async function moveEntry({ src, dst, file }) {
  if (file) {
    try {
      await fsp.link(src, dst);
      await fsp.unlink(src);
      return;
    } catch (e) {
      if (e.code === "EEXIST") {
        if (!(await sameInode(src, dst))) throw e;
        await fsp.unlink(src);
        return;
      }
      if (e.code !== "EPERM" && e.code !== "ENOTSUP") throw e;
    }
  }
  if (await lstatOrNull(dst)) throw withCode("EEXIST");
  await fsp.rename(src, dst);
}

async function executePlan(plan, s) {
  if (plan.outMoves.length) {
    if (!plan.newSt) {
      // Папки fs_key ещё нет — права и владелец как у старой папки сессии.
      try {
        await fsp.mkdir(plan.newPath);
        await fsp.chown(plan.newPath, Number(plan.oldSt.uid), Number(plan.oldSt.gid));
        await fsp.chmod(plan.newPath, Number(plan.oldSt.mode) & 0o7777);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    for (const m of plan.outMoves) {
      await moveEntry(m);
      s.moved++;
    }
  }
  if (plan.oldSt) {
    try {
      await fsp.rmdir(plan.oldPath);
      s.dirsRemoved++;
    } catch (e) {
      if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e;
      s.dirsLeft++;
    }
  }
  for (const m of plan.upMoves) {
    await moveEntry(m);
    s.movedUploads++;
  }
}

// Весь проход по сессиям sessions.json. По каждой телефонной сессии — сразу
// папка, загрузки и её транскрипт; свежесть — по mtime транскрипта. Сироты
// (транскрипты не из sessions.json), папки и загрузки без сессии — только счёт.
export async function runScrub(opts, { commit = commitFile } = {}) {
  const {
    root, sessionsPath, outputs, uploads, fsKeyMapPath = null, statePath,
    journalPath = null, apply = false, minAgeMs = 15 * 60_000, signal,
  } = opts;
  const s = {
    phones: 0, sessions: 0, nonPhoneSessions: 0,
    withMap: 0, withTranscriptKey: 0, keyAgree: 0, withoutKey: 0, keyMismatch: 0, noTranscript: 0, fresh: 0,
    dirs: 0, entries: 0, uploads: 0, conflicts: 0,
    repl: { phrase: 0, dirs: 0, uploads: 0, other: 0 },
    transcripts: 0, otherPhones: 0,
    orphans: 0, orphansWithPhone: 0, orphanDirs: 0, orphanUploads: 0, mapBadLines: 0,
    brokenLines: 0, brokenWithPhone: 0, nonCanonicalLines: 0,
    written: 0, moved: 0, movedUploads: 0, dirsRemoved: 0, dirsLeft: 0,
    errors: 0, errorList: [], interrupted: false, journal: null,
  };
  // Только код: в сообщениях бывает кусок содержимого. Имя — файл транскрипта,
  // не ключ сессии: в ключе номер.
  const fail = (file, e) => {
    s.errors++;
    s.errorList.push({ file, code: e.code || e.name || "Error" });
  };

  const entries = await loadSessions(sessionsPath);
  const { map: fsMap, bad } = fsKeyMapPath ? await loadFsKeyMap(fsKeyMapPath) : { map: new Map(), bad: 0 };
  s.mapBadLines = bad;
  const state = await loadState(statePath);
  const transcripts = await indexTranscripts(root);

  const sessions = [];
  const byPhone = new Map();
  const sessionIds = new Set();
  for (const [key, cliId] of entries) {
    sessionIds.add(cliId);
    const m = PHONE_KEY_RE.exec(key);
    const oldDir = m ? legacyDirName(key) : null;
    if (!oldDir) {
      s.nonPhoneSessions++;
      continue;
    }
    const sess = { key, cliId, phone: m[1], oldDir, transcript: transcripts.get(cliId) ?? null };
    sessions.push(sess);
    if (!byPhone.has(sess.phone)) byPhone.set(sess.phone, []);
    byPhone.get(sess.phone).push(sess);
  }
  sessions.sort((a, b) => byName(a.key, b.key));
  const tablePhones = new Set(byPhone.keys());
  s.phones = tablePhones.size;
  s.sessions = sessions.length;

  // Загрузка принадлежит сессии с самым длинным совпавшим ключом-префиксом:
  // «<номер>_14_ru_x.pdf» — сессии «<номер>_14_ru», а не «<номер>_14».
  const uploadNames = new Set();
  const uploadsOf = new Map();
  for (const ent of await readdirOrEmpty(uploads)) {
    uploadNames.add(ent.name);
    const m = PHONE_NAME_RE.exec(ent.name);
    if (!m) continue;
    let owner = null;
    for (const c of byPhone.get(m[1]) ?? []) {
      if (ent.name.startsWith(c.oldDir + "_") && (!owner || c.oldDir.length > owner.oldDir.length)) owner = c;
    }
    if (!owner) {
      s.orphanUploads++;
      continue;
    }
    if (!uploadsOf.has(owner.key)) uploadsOf.set(owner.key, []);
    uploadsOf.get(owner.key).push({ name: ent.name, rest: ent.name.slice(owner.oldDir.length + 1), file: ent.isFile() });
  }
  const oldDirs = new Set(sessions.map((x) => x.oldDir));
  for (const ent of await readdirOrEmpty(outputs)) {
    if (PHONE_NAME_RE.test(ent.name) && !oldDirs.has(ent.name) && (ent.isDirectory() || ent.isSymbolicLink())) s.orphanDirs++;
  }
  const ctx = { outputs, uploads, uploadsOf, uploadNames };

  async function processSession(sess) {
    let snap = null;
    if (sess.transcript) {
      snap = await readSnapshot(sess.transcript, { minAgeMs });
      if (snap.fresh) {
        s.fresh++;
        return;
      }
    } else s.noTranscript++;

    // fs_key: карта прода, запасной — из транскрипта. Расходятся — не трогаем:
    // скорее всего, карта посчитана не с той солью.
    const fromMap = fsMap.get(sess.key);
    const fromTranscript = snap ? transcriptFsKey(snap.buf, outputs) : undefined;
    if (fromTranscript === null || (fromMap && fromTranscript && fromMap !== fromTranscript)) {
      s.keyMismatch++;
      return;
    }
    const fsKey = fromMap ?? fromTranscript;
    if (!fsKey) {
      s.withoutKey++;
      return;
    }
    const prev = state.get(sess.key);
    if (prev && prev.f !== fsKey) {
      s.keyMismatch++;
      return;
    }
    if (fromMap) s.withMap++;
    else s.withTranscriptKey++;
    if (fromMap && fromTranscript) s.keyAgree++;

    const plan = await planSession(sess, fsKey, prev, ctx);
    const rules = sessionRules({
      phone: sess.phone, oldDir: sess.oldDir, fsKey,
      outNames: [...plan.outNames], outRenames: plan.outRenames,
      upRests: [...plan.upRests], upRenames: plan.upRenames,
      tablePhones,
    });
    const r = snap ? scrubContent(snap.buf, rules) : null;
    if (plan.oldSt) s.dirs++;
    s.entries += plan.outMoves.length;
    s.uploads += plan.upMoves.length;
    s.conflicts += plan.conflicts;
    if (r) {
      for (const k of Object.keys(s.repl)) s.repl[k] += r.counts[k];
      if (r.out) s.transcripts++;
      if (r.otherPhones) s.otherPhones++;
      s.brokenLines += r.brokenLines;
      s.brokenWithPhone += r.brokenWithPhone;
      s.nonCanonicalLines += r.nonCanonicalLines;
    }
    if (!apply) return;

    // Решения о новых именах — в таблицу до переноса: прервёмся посередине —
    // следующий заход возьмёт те же имена.
    if (plan.newRenames) {
      await appendState(statePath, {
        k: sess.key, f: fsKey,
        on: [...plan.outNames], or: Object.fromEntries(plan.outRenames),
        un: [...plan.upRests], ur: Object.fromEntries(plan.upRenames),
      });
    }
    await executePlan(plan, s);
    let written = false;
    if (r?.out) {
      // CLI дописал транскрипт, пока шёл перенос: файлы уже на новом месте,
      // транскрипт перепишет следующий заход — по таблице.
      if ((await commit(sess.transcript, snap.stat, r.out)) === "changed") s.fresh++;
      else {
        s.written++;
        written = true;
      }
    }
    if (plan.oldSt || plan.outMoves.length || plan.upMoves.length || written) {
      await journal.add({
        transcript: sess.transcript ? path.relative(root, sess.transcript) : null,
        fsKey,
        moved: plan.outMoves.length,
        uploads: plan.upMoves.length,
        conflicts: plan.conflicts,
        replacements: r ? r.counts : null,
        transcriptWritten: written,
        at: new Date().toISOString(),
      });
    }
  }

  const journal = apply ? await openJournal(journalPath) : null;
  try {
    for (const sess of sessions) {
      if (signal?.aborted) {
        s.interrupted = true;
        break;
      }
      try {
        await processSession(sess);
      } catch (e) {
        fail(sess.transcript ? path.relative(root, sess.transcript) : "сессия без транскрипта", e);
      }
    }
    for (const [id, file] of transcripts) {
      if (s.interrupted) break;
      if (sessionIds.has(id)) continue;
      if (signal?.aborted) {
        s.interrupted = true;
        break;
      }
      s.orphans++;
      try {
        if (mentionsPhone((await readSnapshot(file)).buf, tablePhones)) s.orphansWithPhone++;
      } catch (e) {
        fail(path.relative(root, file), e);
      }
    }
  } finally {
    if (journal) s.journal = await journal.close();
  }
  return s;
}

// --finish: сначала проверка, что делать больше нечего (и в свежих сессиях —
// только чтение), потом удаление таблицы переименований и карты fs_key.
export async function finishScrub(opts) {
  const s = await runScrub({ ...opts, apply: false, minAgeMs: 0, journalPath: null });
  const pending = s.dirs + s.uploads + s.transcripts;
  if (pending > 0 || s.errors > 0 || s.interrupted) return { pending, removed: [], summary: s };
  const removed = [];
  for (const p of [opts.statePath, opts.fsKeyMapPath]) {
    if (!p) continue;
    try {
      await fsp.unlink(p);
      removed.push(p);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return { pending, removed, summary: s };
}
