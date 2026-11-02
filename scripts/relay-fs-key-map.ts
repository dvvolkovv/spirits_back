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
 * пишутся; pipefail — чтобы отказ на проде не дал пустую карту молча.
 *   set -o pipefail
 *   ssh <релей> '<ключи sessions.json по строке>' \
 *     | ssh <прод> 'cd ~/spirits_back && TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/relay-fs-key-map.ts' \
 *     | ssh <релей> 'umask 077 && cat > ~/.relay-fs-key-map.tsv'
 * stdout — «ключ<TAB>fs_key» на строку; stderr — одна строка счётчиков,
 * в ней «соль — RELAY_FS_SALT».
 * Коды выхода: 0 — готово, 2 — нет RELAY_FS_SALT. Отката на JWT_SECRET (как у
 * relayFsKey) здесь нет: карта на другой соли разложила бы файлы по чужим
 * папкам — пусть лучше не будет карты.
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
  if (!(process.env.RELAY_FS_SALT || '').trim()) {
    process.stderr.write('relay-fs-key-map: нет RELAY_FS_SALT — fs_key не посчитать (откат на JWT_SECRET не делаем)\n');
    return 2;
  }
  const r = relayFsKeyMap(await readStdin());
  process.stdout.write(r.lines.map((l) => l + '\n').join(''));
  process.stderr.write(`relay-fs-key-map: ключей ${r.keys}, пропущено ${r.skipped}; соль — RELAY_FS_SALT\n`);
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
