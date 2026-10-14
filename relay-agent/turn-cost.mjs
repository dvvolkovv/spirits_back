// Стоимость ОДНОГО запуска claude (хода) по счёту самого CLI.
//
// С Claude CLI 2.1.280 total_cost_usd в result-событии у сессии, поднятой через
// --resume, — стоимость ВСЕЙ сессии, а не хода: CLI пишет в транскрипт записи
// {"type":"cost-state","totalCostUSD":…} и при resume продолжает счёт с
// последней. Бэкенд принимал эту сумму за стоимость хода, и каждый следующий
// ответ длинной сессии стоил дороже предыдущего: жалоба 14.10.2026 — ход за
// $0.16 списан как $6.21.
//
// Стоимость хода = total_cost_usd − база, где база — totalCostUSD последней
// записи cost-state ДО запуска. В неё входит всё, чего не видно в usage:
// субагенты, Haiku внутри WebSearch/WebFetch, плата за поиск. Ход 13.10.2026 с
// четырьмя субагентами и 192 поисками: usage основной модели — $1.57, ход — $10.57.

import fs from "fs";

// Запись cost-state CLI пишет в конце каждого запуска, то есть у самого хвоста
// файла. Мегабайта хватает с запасом; не нашлась в хвосте — читаем файл целиком.
const TAIL_BYTES = 1024 * 1024;

/** totalCostUSD последней записи cost-state в тексте транскрипта; null — записей нет. */
export function lastCostState(text) {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    if (line.includes('"cost-state"')) {
      try {
        const e = JSON.parse(line);
        if (e && e.type === "cost-state" && typeof e.totalCostUSD === "number") return e.totalCostUSD;
      } catch { /* оборванная строка на границе хвоста или мусор */ }
    }
    end = start - 1;
  }
  return null;
}

/**
 * База хода: сколько CLI насчитал сессии до запуска.
 * 0 — записей cost-state нет: сессия старше CLI 2.1.280 или ни один запуск не
 * дошёл до конца, и CLI начнёт счёт с нуля.
 * null — транскрипт не прочитался: базы нет, и стоимость хода назвать нельзя.
 */
export function costBaseline(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > TAIL_BYTES) {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(TAIL_BYTES);
        const n = fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
        const found = lastCostState(buf.subarray(0, n).toString("utf8"));
        if (found !== null) return found;
      } finally {
        fs.closeSync(fd);
      }
    }
    const found = lastCostState(fs.readFileSync(file, "utf8"));
    return found === null ? 0 : found;
  } catch {
    return null;
  }
}

/**
 * Стоимость запуска: итог CLI минус база. Отрицательной не бывает. Если CLI
 * когда-нибудь перестанет продолжать счёт с cost-state, разница уйдёт в минус —
 * тогда это ноль, и бэкенд посчитает ход по одному usage.
 */
export function runCost(total, base) {
  return Math.max(0, total - base);
}
