import { Module, Global } from '@nestjs/common';
import { VoiceAvatarService } from './voice-avatar.service';
import { VoiceAvatarController } from './voice-avatar.controller';

@Global()
@Module({
  controllers: [VoiceAvatarController],
  providers: [VoiceAvatarService],
  exports: [VoiceAvatarService],
})
export class VoiceAvatarModule {}
