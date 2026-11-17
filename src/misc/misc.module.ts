import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { MiscController } from './misc.controller';
import { MiscService } from './misc.service';
import { VeoService } from './veo.service';
import { ImageAccountDeletionAdapter } from './image-account-deletion.adapter';
import { LegacySmmAccountDeletionAdapter } from './legacy-smm-account-deletion.adapter';

@Module({
  // ChatUploadsModule — ради загрузок пользователя как исходника правки
  // картинок (MiscService.fetchImageAsBase64). Цикла нет: он импортирует
  // только CommonModule и AccountDeletionModule.
  imports: [AccountDeletionModule, ChatUploadsModule],
  controllers: [MiscController],
  providers: [MiscService, VeoService, ImageAccountDeletionAdapter, LegacySmmAccountDeletionAdapter],
  exports: [MiscService, VeoService],
})
export class MiscModule {}
