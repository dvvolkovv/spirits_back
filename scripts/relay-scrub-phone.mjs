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

