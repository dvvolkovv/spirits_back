// Снимок и дифф файлов папки хода — вынесено из server.mjs ради node:test
// (реальная файловая система: diff идёт по mtime, мок его не проверит).
// Тесты — turn-files.test.mjs.
//
// Нужны ДВЕ папки, не одна: ход может писать не только в свою папку (по
// fs_key), но и в ПРЕЖНЮЮ, если модель помнит путь к файлу, созданному до
// перехода на fs_key (26.10.2026), из истории разговора, и правит именно
// его — см. server.mjs, где это применяется для обеих папок.

import fs from "fs";
import path from "path";

function walkDir(dir, visit, prefix = "") {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const rel = prefix ? prefix + "/" + item : item;
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walkDir(full, visit, rel);
      else visit(rel, stat);
    } catch {}
  }
}

// Map<относительный путь, mtimeMs>. Несуществующая папка — пустой снимок.
export function snapshotDir(dir) {
  const before = new Map();
  if (!fs.existsSync(dir)) return before;
  walkDir(dir, (rel, stat) => before.set(rel, stat.mtimeMs));
  return before;
}

// Файлы dir, которых не было в before или чей mtime вырос с момента снимка —
// то есть новые или изменённые за ход. urlPrefix (например "/files/<fsKey>")
// должен указывать на ТУ папку, которую обошли (dir), а не на папку
// текущего хода — вызывающий отвечает за это, передавая верный префикс.
export function changedFiles(dir, before, urlPrefix) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  walkDir(dir, (rel, stat) => {
    if (!before.has(rel) || stat.mtimeMs > before.get(rel)) {
      out.push({ name: rel, size: stat.size, url: urlPrefix + "/" + rel });
    }
  });
  return out;
}
