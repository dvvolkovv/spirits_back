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

import fsp from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { AGENT_SCRATCH_ROOT, AGENT_MCP_DIR } from "./sandbox-policy.mjs";

export { AGENT_SCRATCH_ROOT, AGENT_MCP_DIR };

// Бюджет имени: SESSION_KEY_MAX + "_" + BASE_MAX + EXT_MAX = 241 < 255.
// Запас в 14 байт оставлен намеренно — суффиксы вроде "-talerid-mcp.json"
// клеятся к ключу сессии отдельно.
const SESSION_KEY_MAX = 48;
const BASE_MAX = 180;
const EXT_MAX = 12;
// Хеш исходного имени, когда очистка что-то потеряла: "-" + 8 hex = 9 байт,
// на столько короче режется основа — бюджет имени прежний.
const NAME_HASH_LEN = 8;

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

export function isValidFsKey(value) {
  return typeof value === "string" && FS_KEY_RE.test(value);
}

// Ключ папки хода: fs_key, если бэк его прислал и он корректен, иначе —
// прежний, из sessionId (старый бэк, анонимные и служебные ходы).
export function turnFsKey(fsKeyFromBackend, sessionId, fallback) {
  if (isValidFsKey(fsKeyFromBackend)) return fsKeyFromBackend;
  return sessionFsKey(sessionId, fallback);
}

// Ключ ПРЕЖНЕЙ папки хода — той, что была у сессии до перехода на fs_key
// (26.10.2026), или null, если отдельной прежней папки нет (fs_key не
// прислан — ход и так пишет в прежнюю). Модель может помнить путь к файлу
// оттуда из истории разговора, поэтому server.mjs снимает и диффит обе папки.
export function legacyTurnFsKey(fsKeyFromBackend, sessionId) {
  if (!isValidFsKey(fsKeyFromBackend)) return null;
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
  const cleaned = baseRaw.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Без потерь (только [a-zA-Z0-9._-] и в пределах длины) — как было:
  // на эти имена опираются легаси-пути и тесты.
  if (cleaned === baseRaw && cleaned.length <= BASE_MAX && ext === rawExt) {
    return fsKey + "_" + cleaned + ext;
  }
  // Потери были: «смета.xlsx» и «отчет.xlsx» иначе обе давали "_____.xlsx"
  // и вторая затирала первую (16.11.2026). Хеш — от исходного имени.
  const hash = createHash("sha256").update(String(originalname)).digest("hex").slice(0, NAME_HASH_LEN);
  return fsKey + "_" + cleaned.slice(0, BASE_MAX - NAME_HASH_LEN - 1) + "-" + hash + ext;
}

// Запасное имя, когда основное почему-то не легло на диск. Расширение уже
// урезано, поэтому уложиться в лимит оно обязано при любом входе.
export function fallbackFileName(originalname, fsKey, uuid) {
  const ext = path.extname(originalname).replace(/[^a-zA-Z0-9.]/g, "").slice(0, EXT_MAX);
  return fsKey + "_" + uuid + ext;
}

// Путь для загрузки, который ничего не перезаписывает: две «image.jpg» с
// iPhone, повторная загрузка того же файла. Занято — суффикс -2…-99 перед
// расширением, дальше 8 hex из uuid (полный uuid не влезает в NAME_MAX при
// длинном имени). Префикс "<ключ>_" сохраняется: легаси-сессии читают
// загрузки по маске <ключ>_*. exists — проверка занятости (fs.existsSync
// в сервере, заглушка в тестах).
export function uniqueUploadPath(dir, name, exists, random = () => randomUUID().slice(0, 8)) {
  const first = path.join(dir, name);
  if (!exists(first)) return first;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i <= 99; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = path.join(dir, `${base}-${random()}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error("нет свободного имени для загрузки: " + name);
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

export async function ensureSessionDirs(fsKey, { scratchRoot = AGENT_SCRATCH_ROOT, outputs = "/tmp/agent-output" } = {}) {
  const scratch = path.join(scratchRoot, fsKey);
  // Никакой автоматической очистки по возрасту: рабочая папка может содержать
  // незавершённую работу. Создаём/нормализуем только известные пути своего хода.
  await fsp.mkdir(scratch, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(outputs, fsKey), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.join(outputs, fsKey), 0o700);
  await fsp.chmod(scratch, 0o700);
  return scratch;
}

export async function ensureSessionUploadDir(fsKey, { uploads = "/tmp/agent-uploads" } = {}) {
  const dir = sessionOutputDir(uploads, fsKey);
  if (!dir) throw new TypeError("invalid fsKey");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  return dir;
}

// 0311: по имени папки можно зайти, перечислить чужие нельзя. Релей списком не читает.
export async function ensureListingGuard({ outputs = "/tmp/agent-output", uploads = "/tmp/agent-uploads", scratchRoot = AGENT_SCRATCH_ROOT } = {}) {
  for (const d of [outputs, uploads, scratchRoot]) {
    await fsp.mkdir(d, { recursive: true, mode: 0o311 });
    await fsp.chmod(d, 0o311);
  }
}
