#!/usr/bin/env ts-node
/**
 * Разовый перенос ссылок релея в истории чатов (chat-files).
 *
 * Для каждой ссылки на наш релей — в любом написании адреса (схема, регистр,
 * порт) — спрашивается сам релей (HEAD по каноническому адресу AGENT_URL):
 *   - файл жив (200) — копия в MinIO, в тексте меняется адрес (как раньше);
 *   - файла нет (404) — номер (или uuid) пользователя в папке адреса меняется
 *     на солёный хэш пользователя: ссылка остаётся мёртвой, но без номера
 *     (спека docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 6);
 *   - релей не ответил толком — ссылка не трогается.
 * Ссылки /files/<номер>_… под чужим хостом или без хоста наш релей не отдаёт,
 * но того же вида бывают и живые сторонние адреса — номер в них меняется на
 * тот же солёный хэш, только если id — владелец строки (session_id), иначе
 * не трогаются; счётчики otherRows / otherOrigins / otherForeignSkipped /
 * maskedOtherRows.
 * Пути на диске релея с номером (/tmp/agent-output/<номер>_…,
 * /tmp/agent-uploads/<номер>_…), которые модель повторяла в ответах, — номер
 * на тот же солёный хэш; счётчики outputPathRows / uploadPathRows /
 * maskedPathRows.
 * Логика и тесты — src/chat/chat-files/backfill.ts (backfill.pg.spec.ts — на
 * живом SQL).
 *
 * Запуск — на сервере, из ~/spirits_back:
 *   npx ts-node scripts/backfill-chat-files.ts              # сухой прогон: разбивка по причинам и список кандидатов в маску
 *   npx ts-node scripts/backfill-chat-files.ts --apply      # копирует живые, маскирует номер в мёртвых
 *   npx ts-node scripts/backfill-chat-files.ts --revert <журнал.jsonl>
 *
 * Требует в окружении (берутся из .env, как у приложения): DATABASE_URL,
 * RELAY_FS_SALT (та же соль, что у приложения), MINIO_ENDPOINT /
 * MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_PUBLIC_URL, необязательно
 * AGENT_URL и MINIO_BUCKET_CHAT_FILES.
 *
 * Журнал --apply пишется в домашний каталог, а не в рабочее дерево репо:
 * ~/backfill-chat-files-<метка>.jsonl, по строке на заменённый адрес (копия —
 * storedUrl, адрес без номера — maskedUrl), на чужую ссылку в строке
 * (linkFrom → linkTo) и на путь релея в строке (pathFrom → pathTo). Он же —
 * вход для --revert. Каталог
 * можно сменить через BACKFILL_JOURNAL_DIR. Сухой прогон в базу не пишет, а
 * кандидатов в маску (мёртвые 404 и чужие ссылки владельца) кладёт рядом, в
 * .dry-run.txt, — уже с хэшем вместо id, без номеров: ложные 404 видно до
 * --apply. Список мёртвых адресов с номерами — в .missing.txt, только при
 * --apply; в консоль он не печатается. Все файлы — с правами 600 (umask
 * 077); удалить их после окна отката.
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
import { relayFsKey } from '../src/chat/linkeon-relay-fields';
import {
  JournalEntry,
  ProbeResult,
  revertBackfill,
  runBackfill,
  saveDryRunList,
  saveMissingList,
} from '../src/chat/chat-files/backfill';
import { appendPrivateLine, requireRelayFsSalt, scriptErrorText } from '../src/common/one-off-script';

// Журнал и список мёртвых адресов — с номерами: всё, что создаёт скрипт, —
// только владельцу.
process.umask(0o077);

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
    // Солёный хэш — той же функцией и с той же солью, что у приложения (папки
    // релея, голосовые документы); только RELAY_FS_SALT — отказ до первого запроса.
    requireRelayFsSalt();
    // StorageService — обычный Nest-провайдер; без DI-контейнера ему нужен
    // ручной onModuleInit (так же в generate-voice-samples.ts).
    const storage = new StorageService();
    storage.onModuleInit();
    const store = new ChatFileStore(storage);
    const journalPath = path.join(
      process.env.BACKFILL_JOURNAL_DIR || os.homedir(),
      `backfill-chat-files-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );

    // 200 — файл жив, 404 — файла нет; всё прочее (5xx, 401, таймаут) — «не
    // ответил»: такую ссылку не трогаем, а не считаем мёртвой.
    const probe = async (u: string): Promise<ProbeResult> => {
      try {
        const res = await axios.head(relayRequestUrl(u), { timeout: 15_000, maxRedirects: 0, validateStatus: () => true });
        return res.status === 200 ? 'alive' : res.status === 404 ? 'missing' : 'unknown';
      } catch {
        return 'unknown';
      }
    };

    const r = await runBackfill({
      pg,
      store,
      agentUrl: process.env.AGENT_URL || 'https://r.linkeon.io',
      apply,
      probe,
      fsKey: (id) => relayFsKey(id),
      journal: (e) => appendPrivateLine(journalPath, JSON.stringify(e)),
      log: (m) => console.log(m),
    });
    // Списки — в файлы, а не в консоль: там могут быть тысячи адресов. Сухой
    // прогон — кандидаты в маску без номеров (.dry-run.txt); --apply — мёртвые
    // адреса с номерами (.missing.txt).
    const { missingUrls, maskCandidates, ...summary } = r;
    console.log(JSON.stringify(summary));
    const dryRunPath = saveDryRunList(apply, journalPath, maskCandidates);
    if (dryRunPath) console.log(`кандидатов в маску: ${maskCandidates.length}, список (без номеров): ${dryRunPath}`);
    const missingPath = saveMissingList(apply, journalPath, missingUrls);
    console.log(`не нашлось на релее: ${missingUrls.length}${missingPath ? `, список: ${missingPath}` : ''}`);
    if (apply) console.log(`журнал: ${fs.existsSync(journalPath) ? journalPath : 'пуст — менять было нечего'}`);
  } finally {
    await pg.end();
  }
}

// Только сообщение и код: у ошибок S3 и axios в объекте метаданные и заголовки.
main().catch((e) => {
  console.error(scriptErrorText(e));
  process.exit(1);
});
