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
// Длина: fsKey (32 hex) + "-" + turnId (36, канонический UUID) + suffix (17)
// = 86 байт — заведомо меньше NAME_MAX (255).
export function sessionMcpConfigName(fsKey, turnId) {
  return fsKey + "-" + turnId + SUFFIX;
}

// Осиротевшие файлы — `finally` не отработал (SIGKILL, падение процесса
// релея). Файл несёт чужие Bearer-токены, оставлять его нельзя. Возраст сам
// по себе НЕ доказывает, что ход завершился — консультация или self-heal
// ретрай того же процесса могут идти дольше maxAgeMs, а конфиг при этом
// валиден и используется. liveSet — полные пути конфигов идущих ходов
// этого процесса (server.mjs: добавляет при записи, убирает в finally) —
// такие пропускаются независимо от возраста. Для конфигов ПРЕЖНЕГО процесса
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
    if (liveSet.has(full)) continue;
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        removed.push(item);
      }
    } catch {}
  }
  return removed;
}
