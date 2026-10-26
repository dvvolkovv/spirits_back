// Имя временного файла MCP-конфига хода (server.mjs пишет его на каждый ход
// с токенами постояльцев — linkeon/talerid/products — и убирает в finally)
// и уборка осиротевших файлов. Тесты — session-mcp-config.test.mjs.

import fs from "fs";
import path from "path";

const SUFFIX = "-session-mcp.json";

// Имя — fsKey + уникальный id ХОДА + суффикс. Не просто fsKey + суффикс:
// до 26.10.2026 имя было одно на СЕССИЮ, а не на ход, и это была гонка за
// файл. Второе сообщение в сессии, начатое до того, как `finally` первого
// хода убрал файл, писало поверх того же пути своим конфигом; а `finally`
// ЛЮБОГО из двух ходов, кто завершился первым, удалял файл ещё живого —
// тот получал на старте CLI либо ENOENT, либо (хуже) уже переписанный чужим
// ходом конфиг. turnId — randomUUID() вызывающего, свой на каждый вызов.
//
// Длина: fsKey (32 hex от бэка или прежний ключ — до 48 символов, paths.mjs)
// + "-" + turnId (36, канонический UUID) + suffix (17) — не больше 102 байт,
// заведомо меньше NAME_MAX (255).
export function sessionMcpConfigName(fsKey, turnId) {
  return fsKey + "-" + turnId + SUFFIX;
}

// Потолок для живого конфига: если close у дочернего процесса так и не
// пришёл, файл с токенами не лежит до рестарта. Ни один ход столько не идёт.
export const LIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Каталог конфигов — создать, если его нет (могли снести посреди работы:
// без него каждый ход молча остался бы без инструментов до рестарта), и
// выставить 0700: mode в mkdirSync на уже существующий каталог не действует.
export function ensureMcpConfigDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Остановка процесса (pm2 restart): process.exit не доходит до finally
// ходов — их конфиги убираются здесь.
export function removeLiveConfigs(liveSet) {
  for (const full of liveSet) {
    try { fs.unlinkSync(full); } catch {}
  }
  liveSet.clear();
}

// Осиротевшие файлы — `finally` не отработал (SIGKILL, падение процесса
// релея). Файл несёт чужие Bearer-токены, оставлять его нельзя. Возраст сам
// по себе НЕ доказывает, что ход завершился — консультация или self-heal
// ретрай того же процесса могут идти дольше maxAgeMs, а конфиг при этом
// валиден и используется. liveSet — полные пути конфигов идущих ходов
// этого процесса (server.mjs: добавляет при записи, убирает в finally) —
// такие пропускаются до LIVE_MAX_AGE_MS. Для конфигов ПРЕЖНЕГО процесса
// (он не попал в liveSet этого) возраст остаётся единственным сигналом.
export function sweepStaleSessionMcpConfigs(dir, maxAgeMs, liveSet = new Set(), now = Date.now()) {
  const removed = [];
  let items;
  try {
    items = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const item of items) {
    if (!item.endsWith(SUFFIX)) continue;
    const full = path.join(dir, item);
    try {
      const age = now - fs.statSync(full).mtimeMs;
      const live = liveSet.has(full);
      if (live ? age > LIVE_MAX_AGE_MS : age > maxAgeMs) {
        fs.unlinkSync(full);
        liveSet.delete(full);
        removed.push(item);
      }
    } catch {}
  }
  return removed;
}
