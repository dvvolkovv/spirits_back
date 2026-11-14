import { Global, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DELETION_DISCOVERERS } from './account-deletion.catalog';
import { AccountDeletionCoordinator } from './account-deletion.coordinator';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionLifecycle } from './account-deletion.lifecycle';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRegistry } from './account-deletion.registry';
import { AccountDeletionRunner } from './account-deletion.runner';
import { AccountDeletionSchemaService } from './account-deletion.schema';
import { PgService } from '../common/services/pg.service';

@Global()
@Module({
  imports: [CommonModule],
  providers: [
    AccountDeletionSchemaService,
    {
      provide: AccountDeletionPlanner,
      useFactory: () => new AccountDeletionPlanner(DELETION_DISCOVERERS),
    },
    {
      provide: AccountDeletionJobs,
      useFactory: (pg: PgService) => new AccountDeletionJobs(pg),
      inject: [PgService],
    },
    AccountDeletionRegistry,
    AccountDeletionRunner,
    AccountDeletionCoordinator,
    // Task 18: явный путь удаления (HTTP DELETE) — тот же framework, что и
    // воркер, поэтому живёт здесь, а не в ProfileModule: зависимости
    // (Planner/Jobs/Registry/Runner, PgService из CommonModule) уже собраны
    // в этом @Global-модуле, и DI-циклов не возникает. ProfileModule
    // получает lifecycle через глобальный export, его imports не меняются.
    AccountDeletionLifecycle,
  ],
  exports: [
    AccountDeletionSchemaService,
    AccountDeletionPlanner,
    AccountDeletionJobs,
    AccountDeletionRegistry,
    AccountDeletionRunner,
    AccountDeletionCoordinator,
    AccountDeletionLifecycle,
  ],
})
export class AccountDeletionModule {}
