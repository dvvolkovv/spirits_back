// Карта «ключ сессии → fs_key» для разовой чистки номера на релее — заготовка интерфейса.
export interface RelayFsKeyMap {
  lines: string[];
  keys: number;
  skipped: number;
}

export function relayFsKeyMap(_input: string): RelayFsKeyMap {
  throw new Error('не реализовано');
}
