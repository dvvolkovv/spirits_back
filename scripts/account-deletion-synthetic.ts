#!/usr/bin/env ts-node
/**
 * Task 22 — синтетическая проверка ПОЛНОГО lifecycle удаления аккаунта
 * (stop → reactivate/cancel → новое удаление → partial failures на внешних
 * границах → retry → done) на живой базе стенда.
 *
 * Запуск — ТОЛЬКО Gate B владельца, только на стенде test.linkeon.io,
 * из чекаута бэкенда на тест-ноде:
 *
 *   ACCOUNT_DELETION_SYNTHETIC_ENV=test.linkeon.io \
 *   npx ts-node -P tsconfig.json scripts/account-deletion-synthetic.ts \
 *     --apply --confirm-account-deletion-cleanup
 *
 * Тройной гейт (оба флага + env-значение + hostname ugliest-salmon)
 * проверяется ПЕРВЫМ, до любого подключения и до любой записи: неполная
 * комбинация — код 2 и synthetic_gates_not_met в stderr, stdout пуст.
 * Нет DATABASE_URL — тоже код 2, без подключения.
 *
 * Данные — только синтетические фикстуры (src/account-deletion/
 * account-deletion.synthetic.ts): телефоны последовательности 7999000010x,
 * ресурсы с префиксом synthetic-deletion-. Внешние границы (MinIO-транспорт,
 * LiveKit, Attendee, ElevenLabs, календарь/OAuth-провайдеры, Telegram,
 * Redis, Neo4j, host-агент) — doubles со strict tri-state; никаких реальных
 * внешних вызовов. Уборка фикстур — в finally по deletion_id/userId.
 *
 * stdout — только JSON-счётчики (без userId/deletionId/телефонов) и маркер
 * SYNTHETIC_TEST_OK. Ошибки — только сообщение и код (scriptErrorText).
 * Коды выхода: 0 успех, 2 гейты/аргументы/preflight, 1 прочее.
 */
import 'dotenv/config';
import { hostname } from 'os';
import { dryRunAccountDeletion } from '../src/account-deletion/account-deletion.dry-run';
import {
  assertSyntheticPreflight,
  checkSyntheticGates,
  cleanupSyntheticFixture,
  createSyntheticStack,
  runSyntheticScenario,
  seedSyntheticFixture,
  SyntheticGateError,
  SyntheticPreflightError,
  SYNTHETIC_HIST_PHONE,
  SYNTHETIC_MAIN_PHONE,
  SYNTHETIC_OTHER_ID,
  SYNTHETIC_RESTART_PHONE,
} from '../src/account-deletion/account-deletion.synthetic';
import { PgService } from '../src/common/services/pg.service';
import { scriptErrorText } from '../src/common/one-off-script';

async function main(): Promise<void> {
  // Гейты — до любого подключения/записи (прецедент: dry-run CLI).
  try {
    checkSyntheticGates({
      argv: process.argv.slice(2),
      env: process.env,
      hostname: hostname(),
    });
  } catch (error) {
    if (error instanceof SyntheticGateError) {
      console.error(scriptErrorText(error));
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (!(process.env.DATABASE_URL || '').trim()) {
    console.error(scriptErrorText(new Error('DATABASE_URL не задан — подключение невозможно')));
    process.exitCode = 2;
    return;
  }

  const pg = new PgService();
  await pg.onModuleInit();
  const stack = createSyntheticStack(pg);
  const deletionIds: string[] = [];
  try {
    await stack.schema.onModuleInit();
    stack.registry.assertReady();

    // Dry-run перед apply (ловушка 13): прогноз плана и доказательство,
    // что он не пишет и не зовёт внешние границы.
    const jobsBefore = await pg.query(
      `SELECT count(*)::int AS n FROM account_deletion_jobs`,
    );
    const dryRun = await dryRunAccountDeletion(stack.db, { retentionMs: 1 });
    const jobsAfter = await pg.query(
      `SELECT count(*)::int AS n FROM account_deletion_jobs`,
    );
    if ((jobsAfter.rows[0]?.n ?? -1) !== (jobsBefore.rows[0]?.n ?? -2)) {
      throw new Error('dry_run_wrote_jobs');
    }
    if (stack.failures.totalCalls() !== 0) {
      throw new Error('dry_run_called_external_boundaries');
    }

    // T22-Q5: preflight перед посевом — при чужих due-поколениях abort
    // (код 2, счётчик в stderr без PII). Tick-обёртки сценария на живой БД
    // обрабатывают ВСЕ due-аккаунты, поэтому чужие поколения не должны
    // попасть в tick; посев при отказе не выполняется (finally-уборка по
    // ещё не созданным фикстурам — no-op).
    try {
      assertSyntheticPreflight({ accounts: dryRun.accounts });
    } catch (error) {
      if (error instanceof SyntheticPreflightError) {
        console.error(scriptErrorText(error));
        process.exitCode = 2;
        return;
      }
      throw error;
    }

    const fixture = await seedSyntheticFixture(stack);
    const counts = await runSyntheticScenario(stack, fixture, deletionIds);

    // T22-Q4: контракт stdout — «только счётчики», с одним ОСОЗНАННЫМ
    // отклонением: failedKinds — enum-строки DeletionErrorKind (timeout/
    // external_5xx/external_unknown/…), без userId/телефонов/deletionId/
    // внешних идентификаторов. Они нужны, чтобы Gate B мог подтвердить
    // срабатывание всех четырёх внешних границ, не читая базу.
    process.stdout.write(`${JSON.stringify(
      {
        dryRunAccounts: dryRun.accounts,
        dryRunJobTypes: Object.keys(dryRun.jobsByType ?? {}).length,
        ...counts,
      },
      null,
      2,
    )}\n`);
    process.stdout.write('SYNTHETIC_TEST_OK\n');
  } finally {
    try {
      await cleanupSyntheticFixture(stack, {
        deletionIds,
        userIds: [
          SYNTHETIC_MAIN_PHONE,
          SYNTHETIC_OTHER_ID,
          SYNTHETIC_HIST_PHONE,
          SYNTHETIC_RESTART_PHONE,
        ],
      });
    } catch (error) {
      console.error(`cleanup: ${scriptErrorText(error)}`);
    }
    await pg.onModuleDestroy().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(scriptErrorText(error));
  process.exitCode = 1;
});
