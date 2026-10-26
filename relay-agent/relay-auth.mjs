// Проверка секрета бэка на входе релея (spirits_back,
// docs/superpowers/specs/2026-10-26-relay-secret-design.md).
// Список секретов и режим — в файлах рядом с server.mjs; перечитываются не
// чаще раза в RELOAD_MS, поэтому смена секрета и включение отказа идут без
// рестарта. Значение заголовка в лог не пишется никогда.
import crypto from "crypto";
import fs from "fs";
import { performance } from "node:perf_hooks";

export const RELOAD_MS = 30_000;
export const HEADER = "x-agent-secret";

// Строки короче 32 символов отбрасываем: настоящий секрет — 64-символьный
// hex (32 случайных байта), короткая строка — почти наверняка перепутанный
// файл (например, случайно подсунутый relay-auth-mode).
const MIN_SECRET_LEN = 32;

export function parseSecrets(text) {
  return String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#") && s.length >= MIN_SECRET_LEN);
}

export function parseMode(text) {
  return String(text || "").trim() === "enforce" ? "enforce" : "log";
}

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

// Сравнение через хеши одинаковой длины: время не зависит от того, сколько
// символов совпало, и от длины присланного значения.
export function isAuthorized(header, secrets) {
  if (typeof header !== "string" || header === "") return false;
  const h = digest(header);
  let ok = false;
  for (const s of secrets) if (crypto.timingSafeEqual(h, digest(s))) ok = true;
  return ok;
}

// Пути без проверки: живость и статика.
const FREE = (req) =>
  req.method === "OPTIONS" || req.path === "/health" || req.path === "/files" || req.path.startsWith("/files/");

export function createRelayAuth({
  secretsPath,
  modePath,
  now = () => performance.now(),
  readFile = (p) => fs.readFileSync(p, "utf8"),
  log = (line) => console.log(line),
}) {
  let cache = { at: -Infinity, secrets: [], mode: "log" };
  // Тихий отчёт о переменах: сравниваем с итогом ПРЕДЫДУЩЕЙ перечитки и
  // пишем строку только когда что-то реально изменилось — молчим на первой
  // загрузке и пока конфигурация стабильна. Значения секретов в лог не
  // попадают, только код ошибки (если она есть) и счётчики.
  let last = null;

  const readOrError = (p) => {
    try {
      return { text: readFile(p), errCode: null };
    } catch (e) {
      return { text: "", errCode: (e && (e.code || e.message)) || "ERR" };
    }
  };

  const load = () => {
    if (now() - cache.at < RELOAD_MS) return cache;

    const secretsRead = readOrError(secretsPath);
    const modeRead = readOrError(modePath);
    const secrets = secretsRead.errCode ? [] : parseSecrets(secretsRead.text);
    const mode = modeRead.errCode ? "log" : parseMode(modeRead.text);

    if (last) {
      if (secretsRead.errCode && secretsRead.errCode !== last.secretsErr) {
        log(`relay-auth: relay-secrets: ${secretsRead.errCode}`);
      }
      if (modeRead.errCode && modeRead.errCode !== last.modeErr) {
        log(`relay-auth: relay-auth-mode: ${modeRead.errCode}`);
      }
      if (mode !== last.mode || secrets.length !== last.secretsCount) {
        log(`relay-auth: режим ${mode}, секретов ${secrets.length}`);
      }
    }
    last = { mode, secretsCount: secrets.length, secretsErr: secretsRead.errCode, modeErr: modeRead.errCode };

    cache = { at: now(), secrets, mode };
    return cache;
  };

  return function relayAuth(req, res, next) {
    if (FREE(req)) return next();
    const { secrets, mode } = load();
    const header = req.get(HEADER);
    if (isAuthorized(header, secrets)) return next();
    const why = header ? "неверный" : "нет секрета";
    const ip = req.get("x-real-ip") || req.socket?.remoteAddress || "?";
    if (mode === "enforce") {
      log(`relay-auth: отказ (${why}), ip=${ip}, path=${req.path}`);
      return res.status(401).json({ error: "unauthorized" });
    }
    log(`relay-auth: отказ был бы (${why}), ip=${ip}, path=${req.path}`);
    return next();
  };
}
