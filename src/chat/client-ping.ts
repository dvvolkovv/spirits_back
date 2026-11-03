/**
 * Пинг клиенту на долгом ходе: строка {"type":"ping"}, пока ответа нет.
 *
 * Тишина считается У КЛИЕНТА — сколько прошло с последней строки, ушедшей ему.
 * До 03.11.2026 счётчик сбрасывало всё, что приходило ОТ релея, а релей шлёт
 * свой heartbeat раз в 30 с и события инструментов, которые клиент без `ui`
 * не получает вовсе. Клиент сидел без единой строки по две минуты и дольше:
 * Flutter (receiveTimeout 60 с) рвал такой ход, а внешнему клиенту API нечем
 * было отличить долгую работу от мёртвого соединения.
 *
 * Проверка раз в 5 с при пороге 20 с — пауза у клиента не больше ~25 с.
 * Документация для внешних сервисов (my.linkeon.io/developers/, репозиторий
 * фронта) обещает «не реже раза в 30 секунд»: поднимая пороги, правьте и её.
 */
export const CLIENT_PING_IDLE_MS = 20_000;
export const CLIENT_PING_CHECK_MS = 5_000;

export interface ClientPing {
  /** Клиенту только что ушла строка — тишина отсчитывается заново. */
  touch(): void;
  stop(): void;
}

export function startClientPing(sendPing: () => void): ClientPing {
  let lastWriteAt = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - lastWriteAt < CLIENT_PING_IDLE_MS) return;
    lastWriteAt = Date.now();
    sendPing();
  }, CLIENT_PING_CHECK_MS);
  return {
    touch: () => { lastWriteAt = Date.now(); },
    stop: () => clearInterval(timer),
  };
}
