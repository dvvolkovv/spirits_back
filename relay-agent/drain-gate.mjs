import fs from "node:fs";

// Инвариант для бэка: spirits_back (src/chat/relay-drain-retry.ts) повторяет
// POST /chat на 502/503/ECONNREFUSED. 503 шлагбаума безопасен, только пока он
// стоит до начала хода; обработчик /chat за ним никогда не отвечает 502/503, а
// заголовки SSE уходят раньше перехвата сессии и запуска CLI — иначе
// оплаченный ход может пройти дважды.
export function createDrainGate({
  drainPath = process.env.RELAY_DRAIN_FILE || "/tmp/linkeon-relay-drain",
} = {}) {
  return function drainGate(req, res, next) {
    if (fs.existsSync(drainPath)) {
      return res.status(503).json({ error: "relay_draining" });
    }
    return next();
  };
}
