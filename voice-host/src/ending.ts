/**
 * Причина ухода участника из комнаты — словами.
 *
 * LiveKit присылает её числом (`livekit.DisconnectReason`). Именно она, а не
 * причина закрытия сессии, отличает «человек положил трубку» от «связь
 * порвалась»: CloseReason у @livekit/agents на оба случая отвечает
 * `participant_disconnected`, и до 29.10.2026 сервер считал их одним и тем же.
 *
 * Таблица записана числами намеренно, а не через обратное отображение enum'а
 * из SDK: номера заданы протоколом и стабильны, а способ генерации enum'а в
 * пакете может поменяться при обновлении и сломать разбор молча.
 */
const NAMES: Record<number, string> = {
  0: 'unknown_reason',
  1: 'client_initiated',
  2: 'duplicate_identity',
  3: 'server_shutdown',
  4: 'participant_removed',
  5: 'room_deleted',
  6: 'state_mismatch',
  7: 'join_failure',
  8: 'migration',
  9: 'signal_close',
  10: 'room_closed',
  11: 'user_unavailable',
  12: 'user_rejected',
  13: 'sip_trunk_failure',
  14: 'connection_timeout',
};

/**
 * `undefined` означает «причины не было вовсе» и отличается от `unknown_reason`
 * («спросили, ответили „не знаю“»). Незнакомый код не выбрасывается, а едет
 * как `code_N`: протокол растёт, и новое значение должно быть видно в базе.
 */
export function disconnectName(code?: number | null): string | undefined {
  if (code === undefined || code === null) return undefined;
  return NAMES[code] ?? `code_${code}`;
}
