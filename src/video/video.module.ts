// src/video/video.module.ts
import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { MiscModule } from '../misc/misc.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule, MiscModule],
  controllers: [VideoController],
  providers: [VideoService],
  exports: [VideoService],
})
export class VideoModule {}
