// Проверка секрета бэка на входе релея (spirits_back,
// docs/superpowers/specs/2026-10-26-relay-secret-design.md).
// Список секретов и режим — в файлах рядом с server.mjs; перечитываются не
// чаще раза в RELOAD_MS, поэтому смена секрета и включение отказа идут без
// рестарта. Значение заголовка в лог не пишется никогда.
import crypto from "crypto";
import fs from "fs";

export const RELOAD_MS = 30_000;
export const HEADER = "x-agent-secret";

export function parseSecrets(text) {
  return String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
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

// Пути без проверки: живость и статика файлов (файлы — отдельная задача).
const FREE = (req) =>
  req.method === "OPTIONS" || req.path === "/health" || req.path === "/files" || req.path.startsWith("/files/");

export function createRelayAuth({
  secretsPath,
  modePath,
  now = () => Date.now(),
  readFile = (p) => fs.readFileSync(p, "utf8"),
  log = (line) => console.log(line),
}) {
  let cache = { at: -Infinity, secrets: [], mode: "log" };
  const load = () => {
    if (now() - cache.at < RELOAD_MS) return cache;
    let secrets = [];
    let mode = "log";
    try { secrets = parseSecrets(readFile(secretsPath)); } catch {}
    try { mode = parseMode(readFile(modePath)); } catch {}
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
