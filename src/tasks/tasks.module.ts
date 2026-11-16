import { Module, Global } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksAccountDeletionAdapter } from './tasks-account-deletion.adapter';

@Global()
@Module({
  imports: [AccountDeletionModule],
  controllers: [TasksController],
  providers: [TasksService, TasksAccountDeletionAdapter],
  exports: [TasksService],
})
export class TasksModule {}
