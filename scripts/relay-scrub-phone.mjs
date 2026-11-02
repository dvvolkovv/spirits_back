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
// Дешёвая проверка до регулярки: в подавляющем большинстве строк фразы нет.
const MARKER = "Current user phone (";

const NL = 0x0a;
const isJsonSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;

// Замены во всех строковых значениях разобранного JSON. Объект правится на
// месте: присваивание существующему ключу его места в порядке ключей не меняет.
function scrubValue(v, count) {
  if (typeof v === "string") {
    if (!v.includes(MARKER)) return v;
    return v.replace(PHRASE_RE, () => {
      count.n++;
      return REPLACEMENT;
    });
  }
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x = scrubValue(v[i], count);
      if (x !== v[i]) v[i] = x;
    }
    return v;
  }
  for (const k of Object.keys(v)) {
    const x = scrubValue(v[k], count);
    if (x !== v[k]) v[k] = x;
  }
  return v;
}

// Одна строка файла (без "\n"). text === null — строка остаётся прежними байтами.
function scrubLine(lineBuf) {
  const res = { text: null, replacements: 0, broken: false, brokenWithPhrase: false, nonCanonical: false };
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

  let value;
  try {
    value = JSON.parse(s.slice(start, end));
  } catch {
    // Битая строка остаётся как есть. Если в ней фраза — номер в ней остаётся,
    // и это должно быть видно в счётчиках.
    res.broken = true;
    res.brokenWithPhrase = s.search(PHRASE_RE) !== -1;
    return res;
  }
  const count = { n: 0 };
  value = scrubValue(value, count);
  if (count.n === 0) return res;

  res.replacements = count.n;
  res.text = s.slice(0, start) + JSON.stringify(value) + s.slice(end);
  // CLI пишет строку как JSON.stringify(запись), поэтому повторный
  // JSON.stringify совпадает с исходником везде, кроме фразы. Не совпал —
  // строку писал не CLI (или в ней не UTF-8): запись поменяет и форму JSON.
  // Смысл тот же, но это стоит видеть до применения.
  res.nonCanonical =
    res.text !== s.replace(PHRASE_RE, REPLACEMENT) || !Buffer.from(s, "utf8").equals(lineBuf);
  return res;
}

// Правила транскрипта одной сессии — заготовка интерфейса.
export function sessionRules() {
  throw new Error("не реализовано");
}

// Содержимое файла целиком. out === null — замен нет, файл писать не нужно.
// Строки без замены попадают в out исходными байтами.
export function scrubContent(buf) {
  const sum = { out: null, replacements: 0, brokenLines: 0, brokenWithPhrase: 0, nonCanonicalLines: 0 };
  const changed = []; // [начало, конец, новые байты]
  let pos = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(NL, pos);
    if (end === -1) end = buf.length;
    const r = scrubLine(buf.subarray(pos, end));
    if (r.broken) {
      sum.brokenLines++;
      if (r.brokenWithPhrase) sum.brokenWithPhrase++;
    }
    if (r.text !== null) {
      sum.replacements += r.replacements;
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

// Кандидаты: <root>/*/*.jsonl — только обычные файлы и каталоги. Dirent
// симлинка — не файл и не каталог, так что симлинки не обходятся.
async function listTranscripts(root) {
  const files = [];
  const errors = [];
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const d of (await fsp.readdir(root, { withFileTypes: true })).sort(byName)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ file: d.name, code: e.code || e.name });
      continue;
    }
    for (const f of entries.sort(byName)) {
      if (f.isFile() && f.name.endsWith(".jsonl")) files.push(path.join(dir, f.name));
    }
  }
  return { files, errors };
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

// Весь проход. Файлы — по одному: в памяти только текущий.
// found = scanned + fresh + errors (+ непройденные при прерывании).
export async function scrubTree(
  { root, apply = false, minAgeMs = 15 * 60_000, journalPath = null, signal } = {},
  { commit = commitFile } = {},
) {
  const s = {
    found: 0, scanned: 0, withPhrase: 0, replacements: 0, written: 0, fresh: 0,
    brokenLines: 0, brokenWithPhrase: 0, nonCanonicalLines: 0,
    errors: 0, errorList: [], interrupted: false, journal: null,
  };
  const fail = (file, e) => {
    s.errors++;
    // Только код: в сообщениях бывает кусок содержимого.
    s.errorList.push({ file, code: e.code || e.name || "Error" });
  };

  const { files, errors } = await listTranscripts(root);
  s.found = files.length;
  for (const { file, code } of errors) fail(file, { code });

  const journal = apply ? await openJournal(journalPath) : null;
  try {
    for (const file of files) {
      if (signal?.aborted) {
        s.interrupted = true;
        break;
      }
      const rel = path.relative(root, file);
      try {
        const snap = await readSnapshot(file, { minAgeMs });
        if (snap.fresh) {
          s.fresh++;
          continue;
        }
        const r = scrubContent(snap.buf);
        if (r.out && apply && (await commit(file, snap.stat, r.out)) === "changed") {
          s.fresh++; // CLI дописал, пока мы читали: второй заход
          continue;
        }
        s.scanned++;
        s.brokenLines += r.brokenLines;
        s.brokenWithPhrase += r.brokenWithPhrase;
        if (!r.out) continue;
        s.withPhrase++;
        s.replacements += r.replacements;
        s.nonCanonicalLines += r.nonCanonicalLines;
        if (!apply) continue;
        s.written++;
        await journal.add({ file: rel, replacements: r.replacements, at: new Date().toISOString() });
      } catch (e) {
        fail(rel, e);
      }
    }
  } finally {
    if (journal) s.journal = await journal.close();
  }
  return s;
}

// ---------------------------------------------------------------- запуск

const USAGE = `Использование: node --input-type=module - [--root <каталог>] [--apply] [--min-age-min <минуты>] [--journal <файл>] < relay-scrub-phone.mjs
               (или node relay-scrub-phone.mjs с теми же флагами)
  --root         каталог проектов claude, по умолчанию ~/.claude/projects; смотрятся <root>/*/*.jsonl
  --apply        заменить; без него — сухой прогон, только счётчики
  --min-age-min  не трогать файлы, менявшиеся за последние N минут; по умолчанию 15
  --journal      журнал применения; по умолчанию ~/scrub-phone-line-<метка>.jsonl, права 600
`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      root: { type: "string" },
      apply: { type: "boolean" },
      "min-age-min": { type: "string" },
      journal: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const rawAge = values["min-age-min"] ?? "15";
  const minutes = rawAge.trim() === "" ? NaN : Number(rawAge);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--min-age-min: нужно число минут, не меньше 0");
  const home = os.homedir();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261102T153000Z
  return {
    help: !!values.help,
    apply: !!values.apply,
    root: path.resolve(values.root ?? path.join(home, ".claude", "projects")),
    minAgeMs: minutes * 60_000,
    journalPath: path.resolve(values.journal ?? path.join(home, "scrub-phone-line-" + stamp + ".jsonl")),
  };
}

function report(s, { root, apply }) {
  const lines = [
    "scrub-phone-line: " + (apply ? "применение" : "сухой прогон — файлы не меняются (замена — с --apply)"),
    "каталог: " + root,
    "найдено транскриптов: " + s.found,
    "файлов просмотрено: " + s.scanned,
    "пропущено свежих: " + s.fresh + (s.fresh ? " — пройти вторым заходом позже" : ""),
    "файлов со строкой: " + s.withPhrase,
    "замен: " + s.replacements,
  ];
  if (apply) lines.push("записано файлов: " + s.written);
  lines.push(
    "битых строк: " + s.brokenLines + ", из них с фразой (номер в них остался): " + s.brokenWithPhrase,
    "строк, где JSON.stringify меняет не только фразу: " + s.nonCanonicalLines,
    "ошибок: " + s.errors,
  );
  if (apply) lines.push("журнал: " + (s.journal ?? "не создан — записывать нечего"));
  if (s.interrupted) lines.push("ПРЕРВАНО: пройдены не все файлы, итог неполный");
  return lines.join("\n") + "\n";
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (e) {
    err.write("scrub-phone-line: " + e.message + "\n\n" + USAGE);
    return 2;
  }
  if (opts.help) {
    out.write(USAGE);
    return 0;
  }
  try {
    if (!(await fsp.stat(opts.root)).isDirectory()) throw withCode("ENOTDIR");
  } catch (e) {
    err.write("scrub-phone-line: нет каталога " + opts.root + " (" + (e.code || e.name) + ")\n");
    return 2;
  }

  // Ctrl+C и SIGTERM дают доделать текущий файл: временный файл не остаётся.
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let s;
  try {
    s = await scrubTree({
      root: opts.root,
      apply: opts.apply,
      minAgeMs: opts.minAgeMs,
      journalPath: opts.journalPath,
      signal: ac.signal,
    });
  } catch (e) {
    // Сюда доходят ошибки вне прохода по файлам — каталог, журнал. Если не
    // открылся журнал, ни один файл ещё не тронут. В сообщении — путь, не
    // содержимое.
    err.write("scrub-phone-line: " + (e.code || e.name) + (e.path ? " " + e.path : "") + "\n");
    return 2;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  out.write(report(s, opts));
  for (const { file, code } of s.errorList) err.write("ошибка: " + file + ": " + code + "\n");
  return s.interrupted ? 130 : s.errors ? 1 : 0;
}

// Запущен как скрипт, а не импортирован (тесты).
// - Через stdin (node - < relay-scrub-phone.mjs, так он едет на релей):
//   argv[1] — "-", а import.meta.url — не путь к файлу ("<cwd>/[eval1]").
//   Если же через stdin пришёл другой код и импортировал этот модуль, у
//   модуля настоящий файл — тогда прогон не запускается.
// - Файлом: сравнение с realpath — на случай запуска через симлинк,
//   import.meta.url у Node — настоящий путь.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (entry === "-") return !fs.existsSync(fileURLToPath(import.meta.url));
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main();
