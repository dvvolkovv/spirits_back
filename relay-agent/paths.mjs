// Построение путей для загруженных файлов и папки вывода.
//
// Вынесено из server.mjs отдельным модулем ровно по одной причине: это
// единственная в релее логика, которую можно проверить без запуска сервера и
// без живой claude-сессии. Тесты — в paths.test.mjs.
//
// Контекст: Linux NAME_MAX = 255 БАЙТ на одно имя файла. Имена приходят от
// пользователя (кириллические выписки из банка), а после санитизации каждый
// не-ASCII символ превращается в "_", поэтому длина в байтах равна длине
// строки. В мае 2026 это уронило загрузку файлов: имя на ~280 кириллических
// символов давало 280+ подчёркиваний, renameSync падал с ENAMETOOLONG.

import path from "path";

// Бюджет имени: SESSION_KEY_MAX + "_" + BASE_MAX + EXT_MAX = 241 < 255.
// Запас в 14 байт оставлен намеренно — суффиксы вроде "-talerid-mcp.json"
// клеятся к ключу сессии отдельно.
const SESSION_KEY_MAX = 48;
const BASE_MAX = 180;
const EXT_MAX = 12;

// sessionId прилетает прямо из тела запроса и уходит в пути на диске
// (префикс загрузки, папка вывода, URL /files/...). Ключ файловой системы
// делается из него отдельно: сам sessionId остаётся логическим ключом для
// sessionMap/activeChildren, иначе сломается --resume у живых сессий.
//
// Слэши здесь не переживают замену, так что "../../etc" превращается в
// ".._.._etc" и наружу не выходит. Отдельно отбиваются "." и ".." целиком:
// они состоят из разрешённых символов, но как сегмент пути означают выход
// из каталога.
export function sessionFsKey(sessionId, fallback) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, SESSION_KEY_MAX);
  if (safe === "" || safe === "." || safe === "..") return fallback;
  return safe;
}

// fs_key от бэка (spirits_back src/chat/linkeon-relay-fields.ts): первые 32
// hex от HMAC ключа сессии. Им называются папка хода и загрузки вместо ключа
// сессии, в котором у телефонных пользователей номер. Строго этот алфавит и
// длина: значение уходит в пути на диске. Сторож согласия с бэком —
// src/chat/relay-linkeon-guard.spec.ts.
const FS_KEY_RE = /^[0-9a-f]{32}$/;

// Ключ папки хода: fs_key, если бэк его прислал и он корректен, иначе —
// прежний, из sessionId (старый бэк, анонимные и служебные ходы).
export function turnFsKey(fsKeyFromBackend, sessionId, fallback) {
  if (typeof fsKeyFromBackend === "string" && FS_KEY_RE.test(fsKeyFromBackend)) return fsKeyFromBackend;
  return sessionFsKey(sessionId, fallback);
}

// Ключ ПРЕЖНЕЙ папки хода — той, что была у сессии до перехода на fs_key
// (26.10.2026), или null, если отдельной прежней папки нет (fs_key не
// прислан — ход и так пишет в прежнюю). Модель может помнить путь к файлу
// оттуда из истории разговора, поэтому server.mjs снимает и диффит обе папки.
export function legacyTurnFsKey(fsKeyFromBackend, sessionId) {
  if (typeof fsKeyFromBackend !== "string" || !FS_KEY_RE.test(fsKeyFromBackend)) return null;
  const legacy = sessionFsKey(sessionId, null);
  return legacy && legacy !== fsKeyFromBackend ? legacy : null;
}

// Имя для загруженного файла: <ключ сессии>_<база><расширение>.
//
// Расширение тоже режется. path.extname() отдаёт всё после последней точки,
// то есть у файла "report.<300 символов>" расширением окажутся все 300 — и
// прежний код падал на таком имени дважды: сначала на основном пути, потом
// на запасном, потому что запасной переиспользовал то же расширение. Файл
// после этого молча удалялся, а пользователь не видел ни файла, ни ошибки.
export function uploadFileName(originalname, fsKey) {
  const rawExt = path.extname(originalname);
  const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, "").slice(0, EXT_MAX);
  const baseRaw = path.basename(originalname, rawExt);
  const baseSafe = baseRaw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, BASE_MAX);
  return fsKey + "_" + baseSafe + ext;
}

// Запасное имя, когда основное почему-то не легло на диск. Расширение уже
// урезано, поэтому уложиться в лимит оно обязано при любом входе.
export function fallbackFileName(originalname, fsKey, uuid) {
  const ext = path.extname(originalname).replace(/[^a-zA-Z0-9.]/g, "").slice(0, EXT_MAX);
  return fsKey + "_" + uuid + ext;
}

// sid в GET /session/:sid/files идёт прямо из URL (Express сам его
// раскодирует) в path.join(outputDir, sid) — проверяется отдельно, не через
// sessionFsKey (та функция не отбивает "/", она санитизирует одно сегментное
// имя файла, а не путь из нескольких сегментов). Допустимы только
// [A-Za-z0-9_.-]; "/" среди них нет, поэтому составной выход вида "../.."
// отсекается уже алфавитом. Отдельно отбиваются голые "." и ".." — это
// разрешённые символы, но как целый сегмент означают "текущий"/"родитель".
// Финальная проверка — путь должен остаться строго внутри outputDir.
// Не прошло — null; вызывающий код отвечает так же, как на несуществующий
// каталог.
const SID_RE = /^[A-Za-z0-9_.-]+$/;

export function sessionOutputDir(outputDir, sid) {
  if (typeof sid !== "string" || sid === "" || sid === "." || sid === "..") return null;
  if (!SID_RE.test(sid)) return null;
  const base = path.resolve(outputDir);
  const resolved = path.resolve(path.join(base, sid));
  const rel = path.relative(base, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}
