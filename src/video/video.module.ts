// src/video/video.module.ts
import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { MiscModule } from '../misc/misc.module';
import { CommonModule } from '../common/common.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { VideoAccountDeletionAdapter } from './video-account-deletion.adapter';

@Module({
  imports: [CommonModule, MiscModule, AccountDeletionModule],
  controllers: [VideoController],
  providers: [VideoService, VideoAccountDeletionAdapter],
  exports: [VideoService],
})
export class VideoModule {}
