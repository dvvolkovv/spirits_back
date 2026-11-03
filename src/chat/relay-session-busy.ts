/**
 * Фоновый ход (рутина, «Путь») не стартует, пока в той же сессии релея идёт
 * ход человека или другой фоновый ход: релей пре-эмптит процесс сессии, и
 * рутина оборвала бы длинную работу человека (бэклог e777aa94).
 */
export class RelaySessionBusyError extends Error {
  readonly code = 'RELAY_SESSION_BUSY';
  constructor() {
    super('relay session busy');
    this.name = 'RelaySessionBusyError';
  }
}
