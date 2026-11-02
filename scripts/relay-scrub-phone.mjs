// Разовая чистка номера телефона на релее (r.linkeon.io). Спека: spirits_back
// docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 5 —
// вариант «слить старую папку в папку fs_key».
//
// До части Б (26.10–01.11.2026) релей называл папку хода и загрузки ключом
// сессии — <номер>_<ассистент>[_<язык>] — и вклеивал в реплику строку
//   Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): <номер>
// Всё это лежит в транскриптах claude-сессий и уходит модели при каждом
// --resume. Теперь папка хода — fs_key (32 hex от HMAC ключа сессии; соль только
// на проде), и скрипт приводит старое к тому же виду.
//
// ПОРЯДОК (обязательно): на проде сначала п. 6 бэка — перенос ссылок
// /files/<номер>_… из истории чатов в MinIO (ему нужны файлы по старым путям),
// и только потом --apply здесь. После переноса папок старые адреса
// /files/<номер>_… отдают 404 — в том числе из кэшей браузеров и Telegram; это
// принято.
//
// Единица работы — номер, все его сессии из sessions.json вместе:
// - содержимое /tmp/agent-output/<старый ключ> → /tmp/agent-output/<fs_key>
//   (папка создаётся с правами старой); занятое имя не перезаписывается —
//   старая запись получает « (прежний)»; пустая старая папка удаляется;
// - загрузки /tmp/agent-uploads/<старый ключ>_<имя> → <fs_key>_<имя>, так же;
// - сразу за ними транскрипты: строка с номером → «Current user: identifier
//   omitted.», пути старых папок и загрузок (свои и соседних сессий номера) →
//   новые, остальные вхождения номера владельца → fs_key сессии.
// Не трогаются (только счёт): блоки thinking/redacted_thinking (API сверяет их
// подпись — правка ломает --resume), ключи JSON, строки не в форме
// JSON.stringify, номера других пользователей; общие старые папки — ключи
// длиннее 48 знаков (custom:<uuid>, fresh) обрезались в одну папку на
// несколько сессий: папка и её загрузки как есть, в транскриптах — только
// строка и userId; сессии без fs_key или с двумя fs_key; сироты (транскрипты не
// из sessions.json), папки и загрузки без сессии.
//
// fs_key — из карты прода (--fs-key-map), запасной — из строки «Output
// directory … /<32 hex>» хода после части Б. Тестовый стенд ходит в тот же
// релей с теми же ключами, но со своей солью: его fs_key узнаются по карте
// стенда (--stand-map) и расхождением не считаются; сессия с ходами прода и
// стенда переезжает под fs_key прода. С картой --apply сначала сверяет её с
// транскриптами ВСЕХ сессий (свежих тоже): незнакомый fs_key или сверить нечем
// — отказ, ничего не тронуто.
//
// Защита: номер, в сессии которого идёт ход (транскрипт моложе
// --min-age-min или живой «claude --resume <сессия>»), откладывается целиком —
// второй заход; таблица переносов (--state, по fs_key, без номера, 600)
// пишется до переноса — второй заход берёт те же имена; перенос без
// перезаписи (жёсткая ссылка, затем удаление старого имени); транскрипт —
// временный файл рядом, сверка с чтением, rename, права, владелец и mtime
// прежние; SIGINT/SIGTERM/SIGHUP доделывают текущий номер. Журнал и вывод — без
// номеров и содержимого.
// Канарейка — только --sessions-file со ВСЕМИ ключами одного номера (иначе код
// 2); --only-phones N — поэтапно уже после неё: сортировка по цифрам может дать
// живого пользователя. У выбранных сессий причины пропуска считаются отдельно.
// --list-residual <файл> — только чтение: id сессий CLI, где номер владельца
// после чистки остаётся (рассуждения, пути непереносимых папок, без fs_key…).
// --finish удаляет таблицу и карты, только когда делать больше нечего.
//
// Запуск — на релее, от dv; скрипт разовый и в дерево релея не кладётся.
// Сухой прогон — прямо через stdin:
//   ssh <релей> 'node --input-type=module - --fs-key-map <карта>' < scripts/relay-scrub-phone.mjs
// Долгое применение — отвязанно, с логом (обрыв ssh его не прервёт):
//   ssh <релей> 'umask 077 && cat > ~/relay-scrub-phone.mjs' < scripts/relay-scrub-phone.mjs
//   ssh <релей> 'setsid nohup node ~/relay-scrub-phone.mjs --fs-key-map <карта> --apply > ~/relay-scrub-1.log 2>&1 < /dev/null &'
// Флаги — USAGE ниже. Коды выхода: 0 — без ошибок, 1 — ошибки на сессиях или
// --finish отказал, 2 — ошибка запуска или отказ сверки карты (ничего не
// тронуто), 130 — прерван сигналом.
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
const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
// Символы имён папок и загрузок релея (paths.mjs: всё прочее он заменял на "_").
const isNameCh = (c) => c !== undefined && /[A-Za-z0-9._-]/.test(c);
// Имя записи в тексте кончилось: дальше разделитель пути, пробел, кавычка,
// скобка, знак препинания — или точка в конце фразы.
function endsName(s, i) {
  const c = s[i];
  if (c === undefined || /[\s/"'`)\]}>,;:|*?<&!»”…]/.test(c)) return true;
  return c === "." && endsName(s, i + 1);
}
// Конец имени по номеру (символы имён релея); точка в конце фразы — не часть имени.
function nameEnd(s, start) {
  let e = start;
  while (isNameCh(s[e])) e++;
  while (e > start && s[e - 1] === ".") e--;
  return e;
}

// Правила транскрипта одной телефонной сессии.
//   phone  — номер владельца (цифры), fsKey — fs_key этой сессии;
//   dirs   — старые папки ВСЕХ сессий этого номера: имя → { fsKey | null,
//            outNames, outRenames, upRests, upRenames }; fsKey null — папка не
//            переносится (общая, без fs_key, не выбрана): пути к ней как есть;
//   keep   — имена на диске, которые не переносятся (сироты): пути как есть;
//   uploadsRoot — корень загрузок: «<папка>_<имя>» в нём — загрузка, даже
//            незнакомая (удалённая раньше).
// Что делается со строкой:
// 1) строка «Current user phone …» → нейтральная;
// 2) имя по номеру — «<номер>_…» (у ключей с «+» — «_<номер>_…») — по самой
//    длинной подходящей старой папке номера: папка → её fs_key (запись,
//    переименованная при конфликте, — на итоговое имя), загрузка →
//    «<fs_key>_<итоговое имя>»; папка не переносится или имя — сирота на
//    диске — как есть (counts.kept);
// 3) остальные вхождения номера владельца как целого числа → fsKey сессии.
// Номера других пользователей не трогаются; otherPhones говорит, есть ли в
// строке номер из таблицы, — для счётчика.
export function sessionRules({ phone, fsKey, dirs = new Map(), keep = new Set(), uploadsRoot = null, tablePhones = new Set() }) {
  // Длинные имена первыми: «a b.txt» не должен стать «a» + « b.txt».
  const byLength = (list) => [...new Set(list)].sort((a, b) => b.length - a.length);
  const info = new Map();
  for (const [dir, d] of dirs) {
    info.set(dir, {
      fsKey: d.fsKey ?? null,
      names: byLength(d.outNames ?? []),
      renames: d.outRenames ?? new Map(),
      rests: new Set(d.upRests ?? []),
      upRenames: d.upRenames ?? new Map(),
    });
  }
  const dirNames = byLength([...info.keys()]);
  const upPrefix = uploadsRoot ? path.resolve(uploadsRoot) + "/" : null;
  const ownPhoneRe = new RegExp("(?<![0-9])\\+?" + phone + "(?![0-9])", "g");

  // Имя по номеру, начинающееся в start и кончающееся в end. Возвращает
  // [замена, где кончилась заменённая часть] или null — не папка и не загрузка;
  // { keep: true } — имя оставить как есть.
  function resolveName(x, start, end, counts) {
    const token = x.slice(start, end);
    const dir = dirNames.find((d) => token === d || token.startsWith(d + "_"));
    const d = dir === undefined ? null : info.get(dir);
    // Папка не переносится — её имена (и загрузки) как есть в любом месте,
    // в том числе голыми именами в выводе ls.
    if (d && !d.fsKey) return { keep: true };
    if (d && token === dir) {
      let repl = d.fsKey;
      let consumed = end;
      if (x[end] === "/") {
        const name = d.names.find((n) => x.startsWith(n, end + 1) && endsName(x, end + 1 + n.length));
        if (name !== undefined) {
          // Имя записи на диске не меняется — номер в нём остаётся.
          if (name.includes(phone)) counts.kept++;
          repl = d.fsKey + "/" + (d.renames.get(name) ?? name);
          consumed = end + 1 + name.length;
        }
      }
      counts.dirs++;
      return { repl, consumed };
    }
    if (d) {
      const rest = token.slice(dir.length + 1);
      const inUploads = upPrefix && start >= upPrefix.length && x.startsWith(upPrefix, start - upPrefix.length);
      if (d.rests.has(rest) || inUploads) {
        if (rest.includes(phone)) counts.kept++;
        counts.uploads++;
        return { repl: d.fsKey + "_" + (d.upRenames.get(rest) ?? rest), consumed: end };
      }
    }
    if (keep.has(token)) return { keep: true };
    return null;
  }

  function phones(x, counts) {
    let out = "";
    let from = 0;
    let pos = 0;
    for (;;) {
      const i = x.indexOf(phone, pos);
      if (i === -1) break;
      const after = i + phone.length;
      pos = i + 1;
      if (isDigit(x[i - 1]) || isDigit(x[after])) continue; // часть длинного числа
      const start = x[i - 1] === "_" && !isNameCh(x[i - 2]) ? i - 1 : i;
      if (x[after] === "_" && (start < i || !isNameCh(x[i - 1]))) {
        const end = nameEnd(x, start);
        const r = resolveName(x, start, end, counts);
        if (r && r.keep) {
          counts.kept++;
          pos = end;
          continue;
        }
        if (r) {
          out += x.slice(from, start) + r.repl;
          from = pos = r.consumed;
          continue;
        }
      }
      const s0 = x[i - 1] === "+" && !isDigit(x[i - 2]) ? i - 1 : i;
      out += x.slice(from, s0) + fsKey;
      from = pos = after;
      counts.other++;
    }
    return from === 0 ? x : out + x.slice(from);
  }

  return {
    transform(s, counts) {
      if (!s.includes(MARKER) && !LONG_DIGITS.test(s)) return s;
      const x = s.replace(PHRASE_RE, () => {
        counts.phrase++;
        return REPLACEMENT;
      });
      return x.includes(phone) ? phones(x, counts) : x;
    },
    otherPhones(s) {
      if (!LONG_DIGITS.test(s)) return false;
      for (const m of s.matchAll(ANY_PHONE_RE)) if (m[1] !== phone && tablePhones.has(m[1])) return true;
      return false;
    },
    // Есть ли в строке то, что правила заменили бы (для битых строк, блоков
    // рассуждений и ключей JSON — их не трогаем, только считаем).
    touches(s) {
      return s.includes(MARKER) || s.search(ownPhoneRe) !== -1;
    },
  };
}

const newCounts = () => ({ phrase: 0, dirs: 0, uploads: 0, other: 0, kept: 0 });

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
  // Блоки рассуждений не трогаем совсем: API сверяет их подпись с текстом, и
  // правка ломает --resume («Invalid signature») — сессия перестаёт отвечать.
  if (v.type === "thinking" || v.type === "redacted_thinking") {
    if (ctx.rules.touches(JSON.stringify(v))) ctx.thinking++;
    return v;
  }
  for (const k of Object.keys(v)) {
    // Ключи не меняем (trackedFileBackups у CLI — пути файлов): только счёт.
    if (ctx.rules.touches(k)) ctx.keys++;
    const x = scrubValue(v[k], ctx);
    if (x !== v[k]) v[k] = x;
  }
  return v;
}

// Одна строка файла (без "\n"). text === null — строка остаётся прежними байтами.
function scrubLine(lineBuf, rules) {
  const res = {
    text: null, counts: null, broken: false, brokenWithPhone: false, otherPhones: false,
    nonCanonical: false, thinking: 0, keys: 0,
  };
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
  const ctx = { rules, counts: newCounts(), changed: false, otherPhones: false, thinking: 0, keys: 0 };
  value = scrubValue(value, ctx);
  res.otherPhones = ctx.otherPhones;
  res.thinking = ctx.thinking;
  res.keys = ctx.keys;
  res.counts = ctx.counts;
  if (!ctx.changed) return res;

  // CLI пишет строку как JSON.stringify(запись), поэтому повторный
  // JSON.stringify совпадает с исходником везде, кроме замен. Не совпал —
  // строку писал не CLI (или в ней не UTF-8): такую не пишем вовсе, только
  // считаем — пусть посмотрит человек.
  if (JSON.stringify(JSON.parse(core)) !== core || !Buffer.from(s, "utf8").equals(lineBuf)) {
    res.nonCanonical = true;
    return res;
  }
  res.text = s.slice(0, start) + JSON.stringify(value) + s.slice(end);
  return res;
}

// Содержимое транскрипта целиком. out === null — замен нет, файл писать не
// нужно. Строки без замены попадают в out исходными байтами; замены считаются
// только у записанных строк.
export function scrubContent(buf, rules) {
  const sum = {
    out: null,
    counts: newCounts(),
    otherPhones: 0, brokenLines: 0, brokenWithPhone: 0, nonCanonicalLines: 0,
    thinkingWithPhone: 0, keysWithPhone: 0,
  };
  const changed = []; // [начало, конец, новые байты]
  let pos = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(NL, pos);
    if (end === -1) end = buf.length;
    const r = scrubLine(buf.subarray(pos, end), rules);
    if (r.broken) {
      sum.brokenLines++;
      if (r.brokenWithPhone) sum.brokenWithPhone++;
    }
    if (r.otherPhones) sum.otherPhones++;
    if (r.nonCanonical) sum.nonCanonicalLines++;
    sum.thinkingWithPhone += r.thinking;
    sum.keysWithPhone += r.keys;
    if (r.text !== null) {
      for (const k of Object.keys(sum.counts)) sum.counts[k] += r.counts[k];
      changed.push([pos, end, Buffer.from(r.text, "utf8")]);
    } else if (r.counts && !r.nonCanonical) {
      // Строка не меняется, но номер в ней оставлен намеренно (непереносимая
      // папка, сирота) — это остаток, его видно в счётчике.
      sum.counts.kept += r.counts.kept;
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

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_TRUNC, O_NOFOLLOW } = fs.constants;
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

// Имя папки хода по ключу сессии — как его делал релей до части Б
// (relay-agent/paths.mjs, sessionFsKey): не больше 48 знаков. Длинные ключи
// (<номер>_custom:<uuid>_<язык>, …_fresh_<время>) обрезались — несколько
// сессий получали ОДНУ папку и один префикс загрузок.
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

// Файл с номерами (карта, список ключей) — только владельцу.
async function readPrivate(file, code) {
  const st = await fsp.stat(file);
  if (st.mode & 0o077) throw withCode(code);
  return fsp.readFile(file, "utf8");
}

// Карта «ключ сессии → fs_key» (TSV) — её считает прод, у которого соль; карта
// стенда — тот же помощник с .env стенда. Ключ с двумя разными fs_key — не
// ключ, а ошибка: такой выбрасывается и считается.
async function loadFsKeyMap(file, code = "EMAPMODE") {
  const map = new Map();
  const doubtful = new Set();
  let bad = 0;
  for (const line of (await readPrivate(file, code)).split("\n")) {
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

// Список ключей сессий для канарейки (--sessions-file), по строке.
export async function loadSessionsFilter(file) {
  return new Set((await readPrivate(file, "EKEYSMODE")).split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean));
}

// Таблица переносов (JSONL, 600) — по fs_key, без номера: что из старой папки
// и загрузок сессии куда переехало (и одноимённое тоже). Пишется ДО переноса:
// оборвётся проход между переносом и записью транскрипта — следующий заход
// перепишет пути по ней теми же именами.
async function loadTable(file) {
  const table = new Map();
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return table;
    throw e;
  }
  for (const line of text.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // пустая или оборванная строка
    }
    if (!e || !FS_KEY_RE.test(e.f)) continue;
    const cur = table.get(e.f) ?? { o: new Map(), u: new Map() };
    for (const [a, b] of Object.entries(e.o ?? {})) cur.o.set(a, b);
    for (const [a, b] of Object.entries(e.u ?? {})) cur.u.set(a, b);
    table.set(e.f, cur);
  }
  return table;
}

async function appendTable(file, entry) {
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

// fs_key из самого транскрипта: строки «Output directory for created files:
// <outputs>/<32 hex>» у ходов после части Б — все разные, какие есть (ходы
// прода и стенда дают разные: соль у стендов своя).
function transcriptFsKeys(buf, outputs) {
  const marker = Buffer.from("Output directory for created files: " + path.resolve(outputs) + "/");
  const found = new Set();
  for (let i = buf.indexOf(marker); i !== -1; i = buf.indexOf(marker, i + 1)) {
    const at = i + marker.length;
    const candidate = buf.toString("latin1", at, at + 32);
    if (FS_KEY_RE.test(candidate) && !isNameCh(buf[at + 32] === undefined ? undefined : String.fromCharCode(buf[at + 32]))) {
      found.add(candidate);
    }
  }
  return [...found];
}

function mentionsPhone(buf, phones) {
  const text = buf.toString("utf8");
  if (text.includes(MARKER)) return true;
  for (const m of text.matchAll(ANY_PHONE_RE)) if (phones.has(m[1])) return true;
  return false;
}

// Процессы «claude --resume <id>» по /proc/*/cmdline: в такой сессии идёт ход.
// Снимок живёт секунду — /proc не читается на каждую сессию.
function liveResumes() {
  let at = 0;
  let ids = new Set();
  return async () => {
    if (Date.now() - at < 1000) return ids;
    const next = new Set();
    let pids = [];
    try {
      pids = await fsp.readdir("/proc");
    } catch {
      // не Linux — живых не видно
    }
    for (const pid of pids) {
      if (!/^[0-9]+$/.test(pid)) continue;
      let cmd;
      try {
        cmd = await fsp.readFile("/proc/" + pid + "/cmdline", "latin1");
      } catch {
        continue;
      }
      const args = cmd.split("\0");
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--resume" && args[i + 1]) next.add(args[i + 1]);
        else if (args[i].startsWith("--resume=")) next.add(args[i].slice("--resume=".length));
      }
    }
    at = Date.now();
    ids = next;
    return ids;
  };
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
async function planSession(sess, prev, ctx) {
  const oldPath = path.join(ctx.outputs, sess.oldDir);
  const newPath = path.join(ctx.outputs, sess.fsKey);
  const oldSt = await lstatOrNull(oldPath);
  if (oldSt && !oldSt.isDirectory()) throw withCode(oldSt.isSymbolicLink() ? "ESYMLINK" : "ENOTDIR");
  const newSt = await lstatOrNull(newPath);
  if (newSt && !newSt.isDirectory()) throw withCode(newSt.isSymbolicLink() ? "ESYMLINK" : "ENOTDIR");

  const plan = {
    oldPath, newPath, oldSt, newSt,
    outMap: new Map(prev?.o), upMap: new Map(prev?.u),
    outMoves: [], upMoves: [], conflicts: 0,
  };
  if (oldSt) {
    const taken = new Set(newSt ? await fsp.readdir(newPath) : []);
    const entries = (await fsp.readdir(oldPath, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name));
    for (const ent of entries) {
      const src = path.join(oldPath, ent.name);
      let dst = plan.outMap.get(ent.name) ?? ent.name;
      // Занято — не перезаписываем: у старой записи будет суффикс. Тот же inode
      // — это наша же жёсткая ссылка от прерванного захода.
      if (taken.has(dst) && !(await sameInode(src, path.join(newPath, dst)))) {
        dst = freeName(ent.name, ent.isDirectory(), (c) => taken.has(c));
      }
      taken.add(dst);
      plan.outMap.set(ent.name, dst);
      if (dst !== ent.name) plan.conflicts++;
      plan.outMoves.push({ src, dst: path.join(newPath, dst), file: ent.isFile() });
    }
  }
  const prefix = sess.fsKey + "_";
  for (const u of ctx.uploadsOf.get(sess.key) ?? []) {
    const src = path.join(ctx.uploads, u.name);
    let rest = plan.upMap.get(u.rest) ?? u.rest;
    if (ctx.uploadNames.has(prefix + rest) && !(await sameInode(src, path.join(ctx.uploads, prefix + rest)))) {
      rest = freeName(u.rest, false, (c) => ctx.uploadNames.has(prefix + c), Buffer.byteLength(prefix));
    }
    ctx.uploadNames.add(prefix + rest);
    plan.upMap.set(u.rest, rest);
    if (rest !== u.rest) plan.conflicts++;
    plan.upMoves.push({ src, dst: path.join(ctx.uploads, prefix + rest), file: u.file });
  }
  return plan;
}

// Перенос без перезаписи. Файл — жёсткой ссылкой (link падает, если имя
// занято) и удалением старого имени; не вышло — ошибка сессии, без запасных
// путей. Папка — rename после проверки, что имени нет.
export async function moveEntry({ src, dst, file }) {
  if (file) {
    try {
      await fsp.link(src, dst);
    } catch (e) {
      if (e.code !== "EEXIST" || !(await sameInode(src, dst))) throw e;
    }
    await fsp.unlink(src);
    return;
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

function newSummary() {
  return {
    phones: 0, sessions: 0, nonPhoneSessions: 0, selected: 0,
    keyAgree: 0, keyMismatch: 0, keyAmbiguous: 0, keyStand: 0, keyMixed: 0, mapRefused: false, standBadLines: 0,
    withMap: 0, withTranscriptKey: 0, withoutKey: 0, withoutKeyWithPhone: 0, noTranscript: 0,
    fresh: 0, live: 0, deferred: 0, shared: 0, sharedSessions: 0,
    dirs: 0, entries: 0, uploads: 0, conflicts: 0,
    repl: newCounts(),
    transcripts: 0, otherPhones: 0, thinkingWithPhone: 0, keysWithPhone: 0,
    orphans: 0, orphansWithPhone: 0, orphanDirs: 0, orphanUploads: 0, mapBadLines: 0,
    brokenLines: 0, brokenWithPhone: 0, nonCanonicalLines: 0,
    written: 0, changedDuringWrite: 0, moved: 0, movedUploads: 0, dirsRemoved: 0, dirsLeft: 0,
    sel: { processed: 0, nokey: 0, ambiguous: 0, mismatch: 0, fresh: 0, live: 0, busy: 0, shared: 0, error: 0 },
    residual: null,
    errors: 0, errorList: [], interrupted: false, journal: null,
  };
}

const RESIDUAL_REASONS = [
  "рассуждения", "пути", "без fs_key", "неоднозначная", "расхождение",
  "битые строки", "неканоничные строки", "ждёт прохода", "ошибка",
];

// Весь проход. Единица работы — номер: все его сессии вместе (пути в
// транскриптах ссылаются и на папки соседних сессий того же номера). Если в
// какой-то сессии номера идёт ход (свежий транскрипт или живой
// «claude --resume») — весь номер откладывается до второго захода. По
// номеру: план → таблица → перенос папок и загрузок → сразу транскрипты.
// Сироты (транскрипты не из sessions.json), папки и загрузки без сессии —
// только счёт. С картой --apply сначала сверяет её по всем сессиям и при
// расхождении (или если сверить нечем) отказывает, ничего не тронув.
export async function runScrub(opts, { commit = commitFile } = {}) {
  const {
    root, sessionsPath, outputs, uploads, fsKeyMapPath = null, statePath,
    journalPath = null, apply = false, minAgeMs = 15 * 60_000, signal,
    onlyPhones = null, sessionsFilter = null, standMapPath = null,
    residual = false, // --list-residual: где номер владельца остался — только чтение
  } = opts;
  // --finish и --list-residual: смотреть и свежие, и занятые живым процессом.
  const inspectAll = opts.inspectAll || residual;
  const s = newSummary();
  // Только код: в сообщениях бывает кусок содержимого. Имя — файл транскрипта,
  // не ключ сессии: в ключе номер.
  const fail = (x, e) => {
    s.errors++;
    s.errorList.push({ file: x.transcript ? path.relative(root, x.transcript) : "сессия без транскрипта", code: e.code || e.name || "Error" });
  };

  const entries = await loadSessions(sessionsPath);
  const { map: fsMap, bad } = fsKeyMapPath ? await loadFsKeyMap(fsKeyMapPath) : { map: new Map(), bad: 0 };
  s.mapBadLines = bad;
  const stand = standMapPath ? await loadFsKeyMap(standMapPath, "ESTANDMODE") : { map: new Map(), bad: 0 };
  const standMap = stand.map;
  s.standBadLines = stand.bad;
  if (residual) s.residual = { list: [], counts: Object.fromEntries(RESIDUAL_REASONS.map((r) => [r, 0])) };
  const table = await loadTable(statePath);
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
    const x = { key, cliId, phone: m[1], oldDir, transcript: transcripts.get(cliId) ?? null };
    sessions.push(x);
    if (!byPhone.has(x.phone)) byPhone.set(x.phone, []);
    byPhone.get(x.phone).push(x);
  }
  sessions.sort((a, b) => byName(a.key, b.key));
  const tablePhones = new Set(byPhone.keys());
  s.phones = tablePhones.size;
  s.sessions = sessions.length;

  // Общие папки: обрезка до 48 знаков дала одну папку нескольким сессиям.
  const perDir = new Map();
  for (const x of sessions) perDir.set(x.oldDir, (perDir.get(x.oldDir) ?? 0) + 1);
  for (const n of perDir.values()) if (n > 1) s.shared++;
  const isShared = (x) => perDir.get(x.oldDir) > 1;

  // Канарейка — номер целиком: список ключей обязан содержать ВСЕ сессии
  // выбранного номера (иначе соседние сессии остались бы со старыми путями) и
  // только ключи из sessions.json (опечатка не должна дать «выбрано 0»).
  if (sessionsFilter) {
    const known = new Set(entries.map(([k]) => k));
    const unknownKeys = [...sessionsFilter].filter((k) => !known.has(k)).length;
    if (unknownKeys) throw Object.assign(withCode("EKEYSUNKNOWN"), { count: unknownKeys });
    let partial = 0;
    for (const list of byPhone.values()) {
      const n = list.filter((x) => sessionsFilter.has(x.key)).length;
      if (n && n < list.length) partial++;
    }
    if (partial) throw Object.assign(withCode("EPARTIAL"), { count: partial });
  }

  // Поэтапно: первые N номеров (со всеми их сессиями) или список ключей.
  const phonesSorted = [...byPhone.keys()].sort(byName);
  const chosen = onlyPhones ? new Set(phonesSorted.slice(0, onlyPhones)) : null;
  const isSelected = (x) => (!chosen || chosen.has(x.phone)) && (!sessionsFilter || sessionsFilter.has(x.key));
  for (const x of sessions) if (isSelected(x)) s.selected++;

  // Загрузка принадлежит сессии с самым длинным совпавшим ключом-префиксом:
  // «<номер>_14_ru_x.pdf» — сессии «<номер>_14_ru», а не «<номер>_14».
  // Загрузки общей папки и без сессии не переносятся.
  const uploadNames = new Set();
  const uploadsOf = new Map();
  const keep = new Set();
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
      keep.add(ent.name);
      continue;
    }
    if (isShared(owner)) continue;
    if (!uploadsOf.has(owner.key)) uploadsOf.set(owner.key, []);
    uploadsOf.get(owner.key).push({ name: ent.name, rest: ent.name.slice(owner.oldDir.length + 1), file: ent.isFile() });
  }
  const oldDirs = new Set(sessions.map((x) => x.oldDir));
  for (const ent of await readdirOrEmpty(outputs)) {
    if (!PHONE_NAME_RE.test(ent.name) || oldDirs.has(ent.name)) continue;
    if (ent.isDirectory() || ent.isSymbolicLink()) {
      s.orphanDirs++;
      keep.add(ent.name);
    }
  }

  // Сверка: fs_key из транскриптов всех сессий (и свежих — только чтение).
  for (const x of sessions) {
    if (signal?.aborted) break;
    if (!x.transcript) continue;
    try {
      x.found = transcriptFsKeys((await readSnapshot(x.transcript)).buf, outputs);
    } catch (e) {
      x.failed = true;
      fail(x, e);
    }
  }
  if (signal?.aborted) {
    s.interrupted = true;
    return s;
  }
  // fs_key транскрипта сверяется с картой прода и картой стенда (стенд ходит в
  // тот же релей с теми же ключами, но со своей солью). Ход стенда — не
  // расхождение; сессия с ходами прода и стенда решается в пользу прода.
  // Незнакомый fs_key рядом с подтверждённым продовым — неоднозначно (сессию не
  // трогаем); незнакомый без продового — расхождение (с картой — отказ).
  for (const x of sessions) {
    if (x.failed) continue;
    const found = x.found ?? [];
    const prodKey = fsMap.get(x.key);
    const standKey = standMap.get(x.key);
    const hasStand = !!standKey && found.includes(standKey);
    if (prodKey) {
      const hasProd = found.includes(prodKey);
      const unknown = found.filter((k) => k !== prodKey && k !== standKey);
      if (unknown.length && hasProd) {
        s.keyAmbiguous++;
        x.reason = "ambiguous";
      } else if (unknown.length) {
        s.keyMismatch++;
        x.reason = "mismatch";
      } else {
        if (hasProd) s.keyAgree++;
        if (hasProd && hasStand) s.keyMixed++;
        else if (hasStand) s.keyStand++;
        x.fsKey = prodKey;
        s.withMap++;
      }
    } else {
      // Карты прода для ключа нет: запасной fs_key — из транскрипта, но не стендовый.
      const candidates = found.filter((k) => k !== standKey);
      if (candidates.length > 1) {
        s.keyAmbiguous++;
        x.reason = "ambiguous";
      } else if (candidates.length === 1) {
        x.fsKey = candidates[0];
        s.withTranscriptKey++;
        if (hasStand) s.keyMixed++;
      } else {
        if (hasStand) s.keyStand++;
        s.withoutKey++;
        x.reason = "nokey";
      }
    }
    if (!x.transcript) s.noTranscript++;
  }
  s.mapRefused = !!fsKeyMapPath && (s.keyMismatch > 0 || s.keyAgree === 0);
  if (apply && s.mapRefused) throw Object.assign(withCode("EMAPCHECK"), { agree: s.keyAgree, mismatch: s.keyMismatch });
  // Сессии, которые не обрабатываются: есть ли в их транскрипте номер владельца.
  for (const x of sessions) {
    if (!x.reason || !x.transcript) continue;
    try {
      x.mentions = mentionsPhone((await readSnapshot(x.transcript)).buf, new Set([x.phone]));
      if (x.mentions && x.reason === "nokey") s.withoutKeyWithPhone++;
    } catch (e) {
      x.failed = true;
      fail(x, e);
    }
  }

  // Папка переезжает в этом заходе или уже переехала раньше (есть в таблице).
  const movable = (x) => !!x.fsKey && !x.failed && !isShared(x) && (isSelected(x) || table.has(x.fsKey));
  const ctx = { outputs, uploads, uploadsOf, uploadNames };
  const live = liveResumes();
  let journal = null;

  async function processPhone(phone, group) {
    const work = group.filter((x) => x.fsKey && !x.failed);
    if (!work.length) return;
    if (!inspectAll) {
      const ids = await live();
      let fresh = 0;
      let busy = 0;
      for (const x of work) {
        if (ids.has(x.cliId)) {
          busy++;
          x.outcome = "live";
        } else if (x.transcript) {
          const st = await lstatOrNull(x.transcript);
          if (st && Date.now() - Number(st.mtimeMs) < minAgeMs) {
            fresh++;
            x.outcome = "fresh";
          }
        }
      }
      if (fresh || busy) {
        s.fresh += fresh;
        s.live += busy;
        s.deferred += work.length;
        for (const x of work) x.outcome ??= "busy"; // номер занят соседней сессией
        return;
      }
    }
    s.sharedSessions += work.filter(isShared).length;

    const plans = new Map();
    for (const x of work) {
      if (isShared(x)) continue;
      try {
        plans.set(x.key, await planSession(x, table.get(x.fsKey), ctx));
      } catch (e) {
        x.failed = true;
        fail(x, e);
      }
    }
    for (const p of plans.values()) {
      if (p.oldSt) s.dirs++;
      s.entries += p.outMoves.length;
      s.uploads += p.upMoves.length;
      s.conflicts += p.conflicts;
    }

    if (apply) {
      for (const x of work) {
        const p = plans.get(x.key);
        if (!p || x.failed) continue;
        try {
          if (p.outMoves.length || p.upMoves.length) {
            await appendTable(statePath, { f: x.fsKey, o: Object.fromEntries(p.outMap), u: Object.fromEntries(p.upMap) });
          }
          await executePlan(p, s);
        } catch (e) {
          x.failed = true;
          fail(x, e);
        }
      }
    }

    // Папки всех сессий номера — для путей в транскриптах.
    const dirs = new Map();
    for (const y of byPhone.get(phone)) {
      const p = plans.get(y.key);
      const t = table.get(y.fsKey);
      const outMap = p ? p.outMap : new Map(t?.o);
      const upMap = p ? p.upMap : new Map(t?.u);
      dirs.set(y.oldDir, {
        fsKey: movable(y) ? y.fsKey : null,
        outNames: [...outMap.keys()], outRenames: outMap,
        upRests: [...upMap.keys()], upRenames: upMap,
      });
    }

    for (const x of work) {
      if (x.failed) continue;
      const p = plans.get(x.key);
      try {
        let r = null;
        let written = false;
        if (x.transcript) {
          const snap = await readSnapshot(x.transcript);
          r = scrubContent(snap.buf, sessionRules({ phone, fsKey: x.fsKey, dirs, keep, uploadsRoot: uploads, tablePhones }));
          for (const k of Object.keys(s.repl)) s.repl[k] += r.counts[k];
          if (r.out) s.transcripts++;
          if (r.otherPhones) s.otherPhones++;
          s.thinkingWithPhone += r.thinkingWithPhone;
          s.keysWithPhone += r.keysWithPhone;
          s.brokenLines += r.brokenLines;
          s.brokenWithPhone += r.brokenWithPhone;
          s.nonCanonicalLines += r.nonCanonicalLines;
          if (s.residual) {
            const reasons = [];
            if (r.thinkingWithPhone) reasons.push("рассуждения");
            if (r.counts.kept) reasons.push("пути");
            if (r.brokenWithPhone) reasons.push("битые строки");
            if (r.nonCanonicalLines) reasons.push("неканоничные строки");
            if (r.out) reasons.push("ждёт прохода");
            addResidual(x, reasons);
          }
          if (apply && r.out) {
            // CLI дописал транскрипт, пока шёл перенос: файлы уже на новом
            // месте, транскрипт перепишет следующий заход — по таблице.
            if ((await commit(x.transcript, snap.stat, r.out)) === "changed") s.changedDuringWrite++;
            else {
              s.written++;
              written = true;
            }
          }
        }
        if (apply && (written || (p && (p.oldSt || p.outMoves.length || p.upMoves.length)))) {
          await journal.add({
            transcript: x.transcript ? path.relative(root, x.transcript) : null,
            fsKey: x.fsKey,
            moved: p ? p.outMoves.length : 0,
            uploads: p ? p.upMoves.length : 0,
            conflicts: p ? p.conflicts : 0,
            replacements: r ? r.counts : null,
            transcriptWritten: written,
            at: new Date().toISOString(),
          });
        }
      } catch (e) {
        x.failed = true;
        fail(x, e);
      }
    }
    for (const x of work) if (!x.outcome) x.outcome = x.failed ? "error" : isShared(x) ? "shared" : "processed";
  }

  function addResidual(x, reasons) {
    if (!reasons.length) return;
    s.residual.list.push({ id: x.cliId, reasons });
    for (const r of reasons) s.residual.counts[r]++;
  }

  journal = apply ? await openJournal(journalPath) : null;
  try {
    for (const phone of phonesSorted) {
      const group = byPhone.get(phone).filter(isSelected);
      if (!group.length) continue;
      if (signal?.aborted) {
        s.interrupted = true;
        break;
      }
      await processPhone(phone, group);
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
        fail({ transcript: file }, e);
      }
    }
  } finally {
    if (journal) s.journal = await journal.close();
  }
  const REASON_OUTCOME = { nokey: "nokey", ambiguous: "ambiguous", mismatch: "mismatch" };
  const RESIDUAL_OF = { nokey: "без fs_key", ambiguous: "неоднозначная", mismatch: "расхождение" };
  for (const x of sessions) {
    if (!isSelected(x)) continue;
    const outcome = x.failed && !x.outcome ? "error" : REASON_OUTCOME[x.reason] ?? x.outcome;
    if (outcome) s.sel[outcome]++;
    if (!s.residual || !x.transcript) continue;
    // Сессия с ошибкой не обработана — номер в ней мог остаться.
    if (x.failed) addResidual(x, ["ошибка"]);
    else if (x.reason && x.mentions) addResidual(x, [RESIDUAL_OF[x.reason]]);
  }
  return s;
}

// --finish: проверка только чтением (свежие и занятые — тоже), что делать
// больше нечего и не осталось того, из-за чего номер остался бы в сессии,
// которую можно было обработать; потом удаление таблицы и карт (прода и стенда).
export async function finishScrub(opts) {
  const s = await runScrub({
    ...opts, apply: false, minAgeMs: 0, journalPath: null, inspectAll: true, onlyPhones: null, sessionsFilter: null,
  });
  const reasons = [];
  const add = (n, label) => {
    if (n) reasons.push(label + ": " + n);
  };
  add(s.dirs, "папок к переносу");
  add(s.uploads, "загрузок к переносу");
  add(s.transcripts, "транскриптов к записи");
  add(s.keyMismatch, "расхождений fs_key");
  add(s.keyAmbiguous, "неоднозначных fs_key");
  add(s.withoutKeyWithPhone, "без fs_key с номером");
  add(s.brokenWithPhone, "битых строк с номером");
  add(s.nonCanonicalLines, "неканоничных строк");
  add(s.errors, "ошибок");
  if (s.interrupted) reasons.push("прервано");
  if (reasons.length) return { ok: false, reasons, removed: [], summary: s };
  const removed = [];
  for (const p of [opts.statePath, opts.fsKeyMapPath, opts.standMapPath]) {
    if (!p) continue;
    try {
      await fsp.unlink(p);
      removed.push(p);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return { ok: true, reasons, removed, summary: s };
}

// ---------------------------------------------------------------- запуск

const USAGE = `Использование (на релее, от dv):
  ssh <релей> 'node --input-type=module - [флаги]' < scripts/relay-scrub-phone.mjs
  (или node relay-scrub-phone.mjs [флаги])
Флаги:
  --fs-key-map <файл>    карта «ключ сессии<TAB>fs_key» от прода, права 600
  --stand-map <файл>     такая же карта по соли тестового стенда (ходит в тот же релей), права 600
  --apply                перенести и переписать; без него — сухой прогон, только счётчики
  --sessions-file <файл> канарейка: только сессии из списка ключей (по строке, ВСЕ ключи номера), права 600
  --only-phones <N>      поэтапно, после канарейки: первые N номеров по сортировке цифр
                         (могут оказаться живыми пользователями), все их сессии
  --list-residual <файл> только чтение: id сессий CLI, где номер владельца остаётся, с причинами (600)
  --finish               проверить, что делать больше нечего, и удалить таблицу и карты
  --min-age-min <N>      номер, в сессии которого транскрипт менялся за N минут, — позже; по умолчанию 15
  --root <каталог>       проекты claude; по умолчанию ~/.claude/projects
  --sessions <файл>      sessions.json релея; по умолчанию ~/file-agent/sessions.json
  --outputs <каталог>    папки хода; по умолчанию /tmp/agent-output
  --uploads <каталог>    загрузки; по умолчанию /tmp/agent-uploads
  --state <файл>         таблица переносов; по умолчанию ~/.relay-scrub-map.jsonl
  --journal <файл>       журнал; по умолчанию ~/relay-scrub-phone-<метка>.jsonl, права 600
`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "fs-key-map": { type: "string" },
      "stand-map": { type: "string" },
      "list-residual": { type: "string" },
      apply: { type: "boolean" },
      finish: { type: "boolean" },
      "only-phones": { type: "string" },
      "sessions-file": { type: "string" },
      "min-age-min": { type: "string" },
      root: { type: "string" },
      sessions: { type: "string" },
      outputs: { type: "string" },
      uploads: { type: "string" },
      state: { type: "string" },
      journal: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.apply && values.finish) throw new Error("--finish — отдельным запуском, без --apply");
  if (values["list-residual"] !== undefined && (values.apply || values.finish)) {
    throw new Error("--list-residual — только чтение, без --apply и --finish");
  }
  // --finish проверяет по карте и её же удаляет: без карты недоделанные сессии
  // выглядели бы как «без fs_key», и таблица ушла бы раньше времени.
  if (values.finish && !values["fs-key-map"]) throw new Error("--finish — только с --fs-key-map");
  if (values["only-phones"] !== undefined && values["sessions-file"] !== undefined) {
    throw new Error("--only-phones и --sessions-file — что-то одно");
  }
  if (values["only-phones"] !== undefined && !/^[1-9][0-9]*$/.test(values["only-phones"])) {
    throw new Error("--only-phones: нужно целое число номеров, больше 0");
  }
  const rawAge = values["min-age-min"] ?? "15";
  const minutes = rawAge.trim() === "" ? NaN : Number(rawAge);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--min-age-min: нужно число минут, не меньше 0");
  const home = os.homedir();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261102T153000Z
  const abs = (v) => (v === undefined ? undefined : path.resolve(v));
  return {
    help: !!values.help,
    apply: !!values.apply,
    finish: !!values.finish,
    minAgeMs: minutes * 60_000,
    onlyPhones: values["only-phones"] === undefined ? null : Number(values["only-phones"]),
    sessionsFile: abs(values["sessions-file"]) ?? null,
    fsKeyMapPath: abs(values["fs-key-map"]) ?? null,
    standMapPath: abs(values["stand-map"]) ?? null,
    listResidual: abs(values["list-residual"]) ?? null,
    root: abs(values.root) ?? path.join(home, ".claude", "projects"),
    sessionsPath: abs(values.sessions) ?? path.join(home, "file-agent", "sessions.json"),
    outputs: abs(values.outputs) ?? "/tmp/agent-output",
    uploads: abs(values.uploads) ?? "/tmp/agent-uploads",
    statePath: abs(values.state) ?? path.join(home, ".relay-scrub-map.jsonl"),
    journalPath: abs(values.journal) ?? path.join(home, "relay-scrub-phone-" + stamp + ".jsonl"),
  };
}

function report(s, o) {
  const r = s.repl;
  const lines = [
    "relay-scrub-phone: " + (o.apply ? "применение" : "сухой прогон — ничего не меняется (применение — с --apply)"),
    "транскрипты: " + o.root + "; sessions.json: " + o.sessionsPath,
    "папки хода: " + o.outputs + "; загрузки: " + o.uploads,
    "карта fs_key: " + (o.fsKeyMapPath ?? "не задана") + ", строк с ошибкой: " + s.mapBadLines,
    "карта стенда: " + (o.standMapPath ? o.standMapPath + ", строк с ошибкой: " + s.standBadLines : "не задана"),
    "сверка карты с транскриптами: совпало " + s.keyAgree + ", расхождений " + s.keyMismatch +
      ", неоднозначных " + s.keyAmbiguous + ", ходы стенда " + s.keyStand + ", смешанных " + s.keyMixed,
  ];
  if (s.mapRefused) {
    lines.push("--apply откажет: " + (s.keyMismatch ? "карта не сходится с транскриптами" : "карту нечем сверить — ни одного хода после части Б"));
  }
  lines.push(
    "номеров: " + s.phones + "; сессий: " + s.sessions + " (без номера: " + s.nonPhoneSessions + "); выбрано: " + s.selected,
    "выбранные сессии: обработано " + s.sel.processed + "; пропущено: без fs_key " + s.sel.nokey +
      ", неоднозначных " + s.sel.ambiguous + ", расхождений " + s.sel.mismatch + ", свежих " + s.sel.fresh +
      ", с живым процессом " + s.sel.live + ", номер занят " + s.sel.busy + ", общая папка " + s.sel.shared +
      ", с ошибкой " + s.sel.error,
    "fs_key: из карты " + s.withMap + ", из транскрипта " + s.withTranscriptKey + ", без fs_key " + s.withoutKey +
      " (из них с номером: " + s.withoutKeyWithPhone + ")",
    "свежих: " + s.fresh + ", с живым процессом CLI: " + s.live + "; отложено сессий (весь номер): " + s.deferred +
      (s.deferred ? " — пройти вторым заходом позже" : ""),
    "без транскрипта: " + s.noTranscript,
    "общих старых папок (не трогаются): " + s.shared + ", их сессий: " + s.sharedSessions,
    "папок к переносу: " + s.dirs + ", записей в них: " + s.entries + ", загрузок: " + s.uploads +
      ", конфликтов имён: " + s.conflicts,
    "замен в транскриптах: фраза " + r.phrase + ", пути папок " + r.dirs + ", пути загрузок " + r.uploads +
      ", прочие " + r.other + "; оставлено в путях: " + r.kept + "; транскриптов к записи: " + s.transcripts,
    "транскриптов с номерами других пользователей: " + s.otherPhones,
    "блоков рассуждений с номером (не трогаются): " + s.thinkingWithPhone + "; ключей JSON с номером (не трогаются): " +
      s.keysWithPhone,
    "сирот: " + s.orphans + ", из них с номером: " + s.orphansWithPhone + "; папок без сессии: " + s.orphanDirs +
      "; загрузок без сессии: " + s.orphanUploads,
    "битых строк: " + s.brokenLines + ", из них с номером: " + s.brokenWithPhone,
    "строк, где JSON.stringify меняет не только замены (не пишутся): " + s.nonCanonicalLines,
  );
  if (o.apply) {
    lines.push(
      "переписано транскриптов: " + s.written + "; перенесено записей: " + s.moved + ", загрузок: " + s.movedUploads +
        "; удалено старых папок: " + s.dirsRemoved + ", осталось непустых: " + s.dirsLeft,
      "изменились во время записи (второй заход): " + s.changedDuringWrite,
      "журнал: " + (s.journal ?? "не создан — записывать нечего"),
      "таблица переносов: " + o.statePath + " (удалить — --finish после последнего захода)",
    );
  }
  lines.push("ошибок: " + s.errors);
  if (s.interrupted) lines.push("ПРЕРВАНО: пройдены не все номера, итог неполный");
  return lines.join("\n") + "\n";
}

// Файл только для владельца (список остатка): без перехода по симлинку.
async function writePrivate(file, text) {
  let fh;
  try {
    fh = await fsp.open(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
  } catch (e) {
    throw Object.assign(withCode("ERESIDUALOUT"), { cause: e });
  }
  try {
    await fh.chmod(0o600);
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

// Ошибка до прохода: путь можно, содержимое и номера — нет.
function startError(e, o) {
  if (e.code === "EMAPMODE") return "карта fs_key доступна не только владельцу — chmod 600 " + o.fsKeyMapPath;
  if (e.code === "EKEYSMODE") return "список ключей доступен не только владельцу — chmod 600 " + o.sessionsFile;
  if (e.code === "ESTANDMODE") return "карта стенда доступна не только владельцу — chmod 600 " + o.standMapPath;
  if (e.code === "EPARTIAL") return "в --sessions-file не все сессии номера (номеров: " + e.count + ") — канарейка берёт номер целиком";
  if (e.code === "EKEYSUNKNOWN") return "в --sessions-file ключей нет в sessions.json: " + e.count;
  if (e.code === "ERESIDUALOUT") return "список остатка не записать: " + o.listResidual;
  if (e.code === "EMAPCHECK") {
    return e.mismatch
      ? "карта fs_key не сходится с транскриптами: совпало " + e.agree + ", расхождений " + e.mismatch + " — ничего не тронуто"
      : "карту fs_key нечем сверить — ни одного хода после части Б; ничего не тронуто";
  }
  if (e.code === "EBADSESSIONS" || e.name === "SyntaxError") return "sessions.json не разобрался: " + o.sessionsPath;
  return (e.code || e.name) + (e.path ? " " + e.path : "");
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    err.write("relay-scrub-phone: " + e.message + "\n\n" + USAGE);
    return 2;
  }
  if (o.help) {
    out.write(USAGE);
    return 0;
  }
  try {
    if (!(await fsp.stat(o.root)).isDirectory()) throw withCode("ENOTDIR");
  } catch (e) {
    err.write("relay-scrub-phone: нет каталога " + o.root + " (" + (e.code || e.name) + ")\n");
    return 2;
  }

  // Ctrl+C, SIGTERM и SIGHUP дают доделать текущий номер: папки и
  // транскрипты его сессий — вместе.
  const ac = new AbortController();
  const stop = () => ac.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) process.once(sig, stop);
  try {
    const sessionsFilter = o.sessionsFile ? await loadSessionsFilter(o.sessionsFile) : null;
    if (o.finish) {
      const f = await finishScrub({ ...o, signal: ac.signal });
      if (f.ok) {
        out.write("relay-scrub-phone --finish: делать больше нечего; удалено: " + (f.removed.join(", ") || "нечего удалять") + "\n");
        return 0;
      }
      out.write("relay-scrub-phone --finish: не всё сделано — " + f.reasons.join(", ") + ". Таблица и карта оставлены.\n");
      return 1;
    }
    if (o.listResidual) {
      const s = await runScrub({ ...o, sessionsFilter, residual: true, apply: false, signal: ac.signal });
      await writePrivate(o.listResidual, s.residual.list.map((x) => x.id + "\t" + x.reasons.join(",") + "\n").join(""));
      out.write(
        "сессий с остатком номера: " + s.residual.list.length + " — " +
          RESIDUAL_REASONS.map((r) => r + " " + s.residual.counts[r]).join(", ") + "; список: " + o.listResidual + "\n" +
          "ошибок: " + s.errors + "\n",
      );
      for (const { file, code } of s.errorList) err.write("ошибка: " + file + ": " + code + "\n");
      return s.errors ? 1 : 0;
    }
    const s = await runScrub({ ...o, sessionsFilter, signal: ac.signal });
    out.write(report(s, o));
    for (const { file, code } of s.errorList) err.write("ошибка: " + file + ": " + code + "\n");
    return s.interrupted ? 130 : s.errors ? 1 : 0;
  } catch (e) {
    err.write("relay-scrub-phone: " + startError(e, o) + "\n");
    return 2;
  } finally {
    for (const sig of signals) process.off(sig, stop);
  }
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

export async function retireResidual() {
  throw new Error("не реализовано");
}
