import { Module } from '@nestjs/common';
import { AppOtaController } from './app-ota.controller';

@Module({
  controllers: [AppOtaController],
})
export class AppOtaModule {}
