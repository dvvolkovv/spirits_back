import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { BackupAccountDeletionAdapter } from './backup-account-deletion.adapter';

// PgService/JwtService приходят из @Global() CommonModule; миграцию сервис
// накатывает сам через OnModuleInit — доп. вызова в модуле не нужно.
@Module({
  imports: [CommonModule, AccountDeletionModule],
  controllers: [BackupController],
  providers: [BackupService, BackupAccountDeletionAdapter],
  exports: [BackupService],
})
export class BackupModule {}
