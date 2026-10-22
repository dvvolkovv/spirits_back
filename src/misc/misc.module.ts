import { Module } from '@nestjs/common';
import { MiscController } from './misc.controller';
import { MiscService } from './misc.service';
import { VeoService } from './veo.service';

@Module({
  controllers: [MiscController],
  providers: [MiscService, VeoService],
  exports: [MiscService, VeoService],
})
export class MiscModule {}
