/**
 * Отчего кончился звонок — в терминах, которые что-то значат для разговора.
 *
 * Человек попрощался или связь порвалась — это два разных начала следующего
 * разговора (спека «Контекст и суверенитет», §4.8). До 29.10.2026 сервер их не
 * различал: воркер в обоих случаях сообщал `participant_disconnected`, строка
 * писалась `completed`, и при перезвоне Роман не мог сказать «нас прервало».
 *
 * Правда лежит у LiveKit: у уходящего участника своя причина отключения
 * (`DisconnectReason` в livekit_models), и `CLIENT_INITIATED` там отличается
 * от `SIGNAL_CLOSE`. Воркер её забирает и присылает сюда сырой.
 *
 * ⚠️ Сырые значения хранятся в базе рядом с вердиктом НАМЕРЕННО. Это
 * отображение — догадка о смысле кодов, проверенная пока только по
 * документации протокола; если живые звонки покажут, что код приходит другой,
 * чинить надо будет здесь, а не ехать за данными, которых не записали.
 */
export type EndVerdict = 'hangup' | 'lost' | 'limit' | 'error' | 'reaped' | 'unknown';

/** Клиент отключился сам — то есть человек нажал «Отбой». */
const HANGUP = ['client_initiated'];

/**
 * Связь оборвалась. `signal_close` — websocket закрылся неожиданно,
 * `connection_timeout` — сервер сам выкинул участника, `state_mismatch` и
 * `join_failure` — клиент не смог восстановить или довести соединение.
 */
const LOST = ['signal_close', 'connection_timeout', 'state_mismatch', 'join_failure'];

/**
 * Закрыли мы или инфраструктура: реапер, предохранитель, перезапуск SFU,
 * второй вход под той же личностью. Поступком человека это не является ни в
 * одном из случаев, и говорить ему «ты попрощался» нельзя.
 */
const REAPED = ['room_deleted', 'participant_removed', 'server_shutdown', 'duplicate_identity'];

/**
 * @param disconnect причина ухода участника от LiveKit (`DisconnectReason`)
 * @param close причина закрытия сессии от @livekit/agents (`CloseReason`)
 *
 * ⚠️ Неизвестное остаётся неизвестным. Соврать здесь хуже, чем промолчать:
 * «ты попрощался» про разговор, который оборвался на полуслове, — ровно та
 * обида, ради которой всё это и делается.
 */
export function endVerdict(disconnect?: string, close?: string): EndVerdict {
  const d = (disconnect || '').trim().toLowerCase();
  const c = (close || '').trim().toLowerCase();

  if (HANGUP.includes(d)) return 'hangup';
  if (LOST.includes(d)) return 'lost';
  if (REAPED.includes(d)) return 'reaped';

  // Причины участника нет — остаётся то, что сказала сама сессия. Её
  // `participant_disconnected` как раз и есть неразличимый случай, ради
  // которого всё затевалось: он сюда не попадает намеренно.
  if (c === 'error') return 'error';
  if (c === 'user_initiated') return 'limit';
  if (c === 'job_shutdown') return 'reaped';

  return 'unknown';
}
