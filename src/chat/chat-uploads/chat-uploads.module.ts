import { Module, OnModuleInit } from '@nestjs/common';
import { AccountDeletionModule } from '../../account-deletion/account-deletion.module';
import { CommonModule } from '../../common/common.module';
import { ChatUploadAccountDeletionAdapter } from './chat-upload-account-deletion.adapter';
import { ChatUploadsController } from './chat-uploads.controller';
import { ChatUploadsService } from './chat-uploads.service';

/**
 * Реестр загруженных исходников живёт отдельным модулем: ChatModule его
 * импортирует, а очистка chat_uploads при удалении аккаунта идёт через
 * конвейер — собственный адаптер ChatUploadAccountDeletionAdapter
 * (chat-upload.purge), поэтому ProfileModule этот модуль не импортирует.
 *
 * Миграция применяется при старте (образец — alert-bot.lifecycle.ts): сбой
 * migrate() прокидывается наверх и не даёт приложению подняться без таблицы.
 */
@Module({
  // AccountDeletionModule — ради ChatUploadAccountDeletionAdapter (Phase 2:
  // chat_uploads стираются через конвейер удаления). Модуль @Global, но
  // импорт явный — форма как у chat.module.ts с ChatFileAccountDeletionAdapter;
  // цикла нет: AccountDeletionModule импортирует только CommonModule.
  imports: [CommonModule, AccountDeletionModule],
  controllers: [ChatUploadsController],
  // Адаптер регистрируется в AccountDeletionRegistry через onModuleInit.
  providers: [ChatUploadsService, ChatUploadAccountDeletionAdapter],
  exports: [ChatUploadsService],
})
export class ChatUploadsModule implements OnModuleInit {
  constructor(private readonly uploads: ChatUploadsService) {}

  async onModuleInit(): Promise<void> {
    await this.uploads.migrate();
  }
}
