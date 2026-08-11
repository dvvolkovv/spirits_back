import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';

@Module({
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
