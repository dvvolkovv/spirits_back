#!/usr/bin/env ts-node
/**
 * Task 21 — строгий dry-run очистки аккаунтов: прогноз плана удаления
 * (сколько аккаунтов, какие задачи по типам, какие skips по причинам)
 * БЕЗ побочных эффектов.
 *
 * Никакого Nest-приложения, AppModule, schema service и миграций: подключение
 * — голый pg.Client с сессионным `default_transaction_read_only=on`, поэтому
 * случайная запись/DDL отклоняется самим сервером (SQLSTATE 25006), а не
 * соглашением в коде. Персистенция плана, реестр/адаптеры, внешние клиенты
 * (MinIO/Telegram/products-host) не задействованы — только
 * AccountDeletionPlanner.collect (src/account-deletion/account-deletion.dry-run.ts).
 *
 * Запуск — на сервере, из ~/spirits_back (DATABASE_URL берётся из .env):
 *   npx ts-node -P tsconfig.json scripts/account-deletion-dry-run.ts
 *   npx ts-node -P tsconfig.json scripts/account-deletion-dry-run.ts --retention-ms=2592000000
 *
 * Режима исполнения НЕТ: любой --apply — код 2 и «dry-run only» в stderr,
 * до попытки подключения. stdout — только JSON-сводка (счётчики, без
 * userId/deletionId, без списков и файлов) и маркер
 * ACCOUNT_DELETION_DRY_RUN_OK. Ошибки — только сообщение и код
 * (scriptErrorText), коды выхода: 0 успех, 2 аргументы/--apply, 1 прочее.
 */
import 'dotenv/config';
import { Client } from 'pg';
import {
  dryRunAccountDeletion,
  parseDryRunArgs,
} from '../src/account-deletion/account-deletion.dry-run';
import { scriptErrorText } from '../src/common/one-off-script';

async function main(): Promise<void> {
  let retentionMs: number;
  try {
    retentionMs = parseDryRunArgs(process.argv.slice(2)).retentionMs;
  } catch (error) {
    // Ошибка аргументов (включая --apply → DryRunApplyError): код 2,
    // подключение к БД не создаётся.
    console.error(scriptErrorText(error));
    process.exitCode = 2;
    return;
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on',
  });
  try {
    await client.connect();
    const summary = await dryRunAccountDeletion(
      { query: (sql, params) => client.query(sql, params as any[]) },
      { retentionMs },
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write('ACCOUNT_DELETION_DRY_RUN_OK\n');
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(scriptErrorText(error));
  process.exitCode = 1;
});
