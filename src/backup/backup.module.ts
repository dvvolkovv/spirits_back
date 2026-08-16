import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

// PgService/JwtService приходят из @Global() CommonModule; миграцию сервис
// накатывает сам через OnModuleInit — доп. вызова в модуле не нужно.
@Module({
  imports: [CommonModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
