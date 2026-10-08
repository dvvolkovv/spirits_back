#!/usr/bin/env ts-node
/**
 * Разовый перенос ещё живых файлов релея в MinIO (chat-files).
 *
 * Запуск — на сервере, из ~/spirits_back:
 *   npx ts-node scripts/backfill-chat-files.ts              # сухой прогон: только счётчики
 *   npx ts-node scripts/backfill-chat-files.ts --apply      # копирует и меняет адреса в истории
 *   npx ts-node scripts/backfill-chat-files.ts --revert <журнал.jsonl>
 *
 * Требует в окружении (берутся из .env, как у приложения): DATABASE_URL,
 * MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_PUBLIC_URL,
 * необязательно AGENT_URL и MINIO_BUCKET_CHAT_FILES.
 *
 * Журнал --apply пишется в домашний каталог, а не в рабочее дерево репо:
 * ~/backfill-chat-files-<метка>.jsonl, по строке на заменённый адрес. Он же —
 * вход для --revert. Каталог можно сменить через BACKFILL_JOURNAL_DIR.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { Client } from 'pg';
import { StorageService } from '../src/common/services/storage.service';
import { ChatFileStore } from '../src/chat/chat-files/chat-file-store';
import { relayRequestUrl } from '../src/chat/chat-files/file-meta';
import { JournalEntry, revertBackfill, runBackfill } from '../src/chat/chat-files/backfill';

async function main() {
  const args = process.argv.slice(2);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const revertAt = args.indexOf('--revert');
    if (revertAt >= 0) {
      const file = args[revertAt + 1];
      if (!file) throw new Error('--revert требует путь к журналу');
      const entries: JournalEntry[] = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const r = await revertBackfill({ pg, entries, log: (m) => console.log(m) });
      console.log(`откат: возвращено строк ${r.reverted}, пропущено ${r.skipped}`);
      return;
    }

    const apply = args.includes('--apply');
    // StorageService — обычный Nest-провайдер; без DI-контейнера ему нужен
    // ручной onModuleInit (так же в generate-voice-samples.ts).
    const storage = new StorageService();
    storage.onModuleInit();
    const store = new ChatFileStore(storage);
    const journalPath = path.join(
      process.env.BACKFILL_JOURNAL_DIR || os.homedir(),
      `backfill-chat-files-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );

    const r = await runBackfill({
      pg,
      store,
      agentUrl: process.env.AGENT_URL || 'https://r.linkeon.io',
      apply,
      probe: async (u) =>
        (await axios.head(relayRequestUrl(u), { timeout: 15_000, validateStatus: () => true })).status === 200,
      journal: (e) => fs.appendFileSync(journalPath, JSON.stringify(e) + '\n'),
      log: (m) => console.log(m),
    });
    // Список пропавших — в файл, а не в консоль: там могут быть тысячи адресов.
    const { missingUrls, ...summary } = r;
    console.log(JSON.stringify(summary));
    const missingPath = journalPath.replace(/\.jsonl$/, '.missing.txt');
    fs.writeFileSync(missingPath, missingUrls.length > 0 ? missingUrls.join('\n') + '\n' : '');
    console.log(`не нашлось на релее: ${missingUrls.length}, список: ${missingPath}`);
    if (apply) console.log(`журнал: ${journalPath}`);
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
