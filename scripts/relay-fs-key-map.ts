#!/usr/bin/env ts-node
/**
 * Карта «ключ сессии → fs_key» для разовой чистки номера на релее
 * (scripts/relay-scrub-phone.mjs, флаг --fs-key-map; спека
 * docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 5).
 * Соль RELAY_FS_SALT есть только на проде, поэтому карту считает прод — той
 * же функцией, что даёт fs_key ходам (src/chat/linkeon-relay-fields.ts), без
 * подъёма Nest.
 *
 * Запуск — на проде, из ~/spirits_back (соль — из .env рабочего каталога, как
 * у приложения). Ключи и карта несут номера: только трубой, на диск мака не
 * пишутся.
 *   ssh <релей> '<ключи sessions.json по строке>' \
 *     | ssh <прод> 'cd ~/spirits_back && npx ts-node scripts/relay-fs-key-map.ts' \
 *     | ssh <релей> 'umask 077 && cat > ~/.relay-fs-key-map.tsv'
 * stdout — «ключ<TAB>fs_key» на строку; stderr — одна строка счётчиков.
 * Коды выхода: 0 — готово, 2 — нет ни RELAY_FS_SALT, ни JWT_SECRET.
 */
import 'dotenv/config';
import { relayFsKeyMap } from '../src/chat/relay-fs-key-map';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<number> {
  const salt = (process.env.RELAY_FS_SALT || '').trim();
  if (!salt && !process.env.JWT_SECRET) {
    process.stderr.write('relay-fs-key-map: нет ни RELAY_FS_SALT, ни JWT_SECRET — fs_key не посчитать\n');
    return 2;
  }
  const input = await readStdin();
  // relayFsKey на JWT_SECRET предупреждает в stderr на каждый ключ — здесь
  // одна строка итога вместо тысяч одинаковых.
  const warn = console.warn;
  console.warn = () => undefined;
  let r;
  try {
    r = relayFsKeyMap(input);
  } finally {
    console.warn = warn;
  }
  process.stdout.write(r.lines.map((l) => l + '\n').join(''));
  process.stderr.write(
    `relay-fs-key-map: ключей ${r.keys}, пропущено ${r.skipped}; соль — ${salt ? 'RELAY_FS_SALT' : 'JWT_SECRET (RELAY_FS_SALT не задан)'}\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    // Только код: в сообщении могли бы оказаться ключи, а в них номера.
    process.stderr.write(`relay-fs-key-map: ошибка ${e?.code || e?.name || ''}\n`);
    process.exitCode = 1;
  },
);
