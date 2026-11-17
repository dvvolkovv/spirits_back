// src/video/video.module.ts
import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { MiscModule } from '../misc/misc.module';
import { CommonModule } from '../common/common.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { VideoAccountDeletionAdapter } from './video-account-deletion.adapter';

@Module({
  // ChatUploadsModule — ради загрузок пользователя как портрета image2video
  // (VideoService.fetchPortraitB64). Цикла нет: он импортирует только
  // CommonModule и AccountDeletionModule.
  imports: [CommonModule, MiscModule, AccountDeletionModule, ChatUploadsModule],
  controllers: [VideoController],
  providers: [VideoService, VideoAccountDeletionAdapter],
  exports: [VideoService],
})
export class VideoModule {}
