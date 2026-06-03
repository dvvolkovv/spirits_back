import { Module } from '@nestjs/common';
import { MiscController } from './misc.controller';
import { MiscService } from './misc.service';
import { KlingService } from './kling.service';
import { VeoService } from './veo.service';

@Module({
  controllers: [MiscController],
  providers: [MiscService, KlingService, VeoService],
  exports: [KlingService, MiscService, VeoService],
})
export class MiscModule {}
