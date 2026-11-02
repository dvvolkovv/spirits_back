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
// Node 22, ESM, без зависимостей: на релее системный Node, без nvm и npm.

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
