#!/usr/bin/env ts-node
/**
 * Разовый перенос голосовых документов: documents/<id>/<docId>.md (у
 * телефонных пользователей — номер) → documents/<солёный хэш>/<docId>.md.
 * Спека docs/superpowers/specs/2026-11-02-pii-out-of-prompts-design.md, п. 2.
 * Логика и тесты — src/voice-call/voice-document-migration.ts (*.pg.spec.ts —
 * на живом SQL).
 *
 * Запуск — на сервере, из ~/spirits_back, ПОСЛЕ выката кода, который кладёт
 * новые документы уже в новую папку:
 *   npx ts-node scripts/migrate-voice-document-keys.ts                        # сухой прогон: счётчики, ничего не пишет
 *   npx ts-node scripts/migrate-voice-document-keys.ts --apply                # копия и замена адресов; старые объекты остаются
 *   npx ts-node scripts/migrate-voice-document-keys.ts --delete-old <журнал>  # удалить старые объекты из журнала --apply
 *   npx ts-node scripts/migrate-voice-document-keys.ts --revert <журнал>
 *
 * Старые объекты --apply не удаляет. Их удаляет --delete-old — когда решит
 * владелец, по журналу --apply: только записанные как «replaced» или
 * «copied» и только если новая копия на месте, а ссылок на старый ключ в базе
 * нет. Удаления дописываются в тот
 * же журнал. Повторный --delete-old ничего не делает.
 *
 * Требует в окружении (берутся из .env, как у приложения): DATABASE_URL,
 * RELAY_FS_SALT (та же соль, что у приложения, — иначе папки разойдутся с
 * новыми документами; JWT_SECRET как запасная не принимается), MINIO_ENDPOINT
 * / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_PUBLIC_URL.
 *
 * Журнал --apply — в домашний каталог (или BACKFILL_JOURNAL_DIR):
 * ~/voice-document-keys-<метка>.jsonl, по строке на копию, замену в строке
 * базы, «можно удалять» и (после --delete-old) удаление; только места и
 * ключи, без текстов. Он же — вход для --delete-old и --revert: откат
 * возвращает удалённые объекты копией с нового ключа и прежние адреса.
 * Журнал — с правами 600 (umask 077); удалить его после окна отката.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { StorageService } from '../src/common/services/storage.service';
import {
  DocJournalEntry,
  deleteOldDocuments,
  revertDocumentMigration,
  runDocumentMigration,
} from '../src/voice-call/voice-document-migration';
import { appendPrivateLine, requireRelayFsSalt, scriptErrorText } from '../src/common/one-off-script';

// В журнале — ключи с номерами: всё, что создаёт скрипт, — только владельцу.
process.umask(0o077);

function readJournal(file: string | undefined, flag: string): DocJournalEntry[] {
  if (!file) throw new Error(`${flag} требует путь к журналу`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main() {
  const args = process.argv.slice(2);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    // StorageService — обычный Nest-провайдер; без DI-контейнера ему нужен
    // ручной onModuleInit (так же в backfill-chat-files.ts).
    const storage = new StorageService();
    storage.onModuleInit();

    const revertAt = args.indexOf('--revert');
    if (revertAt >= 0) {
      const entries = readJournal(args[revertAt + 1], '--revert');
      const r = await revertDocumentMigration({ pg, store: storage, entries, log: (m) => console.log(m) });
      console.log(`откат: объектов восстановлено ${r.restoredObjects}, строк возвращено ${r.revertedRows}, пропущено ${r.skippedRows}`);
      return;
    }

    const deleteAt = args.indexOf('--delete-old');
    if (deleteAt >= 0) {
      const file = args[deleteAt + 1];
      const entries = readJournal(file, '--delete-old');
      const r = await deleteOldDocuments({
        pg,
        store: storage,
        entries,
        // Удаления — в тот же журнал: по нему откат вернёт и объекты.
        journal: (e) => appendPrivateLine(file, JSON.stringify(e)),
        log: (m) => console.log(m),
      });
      console.log(`удаление старых: удалено ${r.deleted}, уже не было ${r.alreadyGone}, оставлено ${r.kept}`);
      return;
    }

    const apply = args.includes('--apply');
    // Солёный хэш — только на RELAY_FS_SALT, как у приложения; без неё — отказ.
    requireRelayFsSalt();
    const journalPath = path.join(
      process.env.BACKFILL_JOURNAL_DIR || os.homedir(),
      `voice-document-keys-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );
    const r = await runDocumentMigration({
      pg,
      store: storage,
      apply,
      journal: (e) => appendPrivateLine(journalPath, JSON.stringify(e)),
      log: (m) => console.log(m),
    });
    console.log(JSON.stringify(r));
    if (apply) console.log(`журнал: ${fs.existsSync(journalPath) ? journalPath : 'пуст — менять было нечего'}`);
  } finally {
    await pg.end();
  }
}

// Только сообщение и код: у ошибок S3 в объекте метаданные запроса.
main().catch((e) => {
  console.error(scriptErrorText(e));
  process.exit(1);
});
