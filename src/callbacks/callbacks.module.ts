import { Module } from '@nestjs/common';
import { ChangellyCallbackController } from './changelly-callback.controller';

@Module({
  controllers: [ChangellyCallbackController],
})
export class CallbacksModule {}
