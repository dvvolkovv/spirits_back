import { Module } from '@nestjs/common';
import { MiscController } from './misc.controller';
import { MiscService } from './misc.service';
import { KlingService } from './kling.service';

@Module({
  controllers: [MiscController],
  providers: [MiscService, KlingService],
  exports: [KlingService],
})
export class MiscModule {}
