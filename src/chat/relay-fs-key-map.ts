import { relayFsKey } from './linkeon-relay-fields';

/**
 * Карта «ключ сессии → fs_key» для разовой чистки номера на релее
 * (scripts/relay-scrub-phone.mjs; спека
 * docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 5).
 * Соль RELAY_FS_SALT есть только на проде, поэтому карту считает прод — той же
 * функцией, что даёт fs_key ходам (relayFsKey). Скрипт —
 * scripts/relay-fs-key-map.ts.
 *
 * Вход — ключи сессий из sessions.json релея, по строке. Выход — строки
 * «ключ<TAB>fs_key». Ключ с табом в TSV не записать, повтор ничего не добавит,
 * без соли fs_key нет — такие пропускаются и считаются.
 */
export interface RelayFsKeyMap {
  lines: string[];
  keys: number;
  skipped: number;
}

export function relayFsKeyMap(input: string, fsKey: (key: string) => string | undefined = relayFsKey): RelayFsKeyMap {
  const lines: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of input.split('\n')) {
    const key = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!key) continue;
    if (key.includes('\t') || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const value = fsKey(key);
    if (!value) {
      skipped++;
      continue;
    }
    lines.push(`${key}\t${value}`);
  }
  return { lines, keys: lines.length, skipped };
}
