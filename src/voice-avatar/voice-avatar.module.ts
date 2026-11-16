import { Module, Global } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { VoiceAvatarService } from './voice-avatar.service';
import { VoiceAvatarController } from './voice-avatar.controller';
import { VoiceAvatarAccountDeletionAdapter } from './voice-account-deletion.adapter';

@Global()
@Module({
  imports: [AccountDeletionModule],
  controllers: [VoiceAvatarController],
  providers: [VoiceAvatarService, VoiceAvatarAccountDeletionAdapter],
  exports: [VoiceAvatarService],
})
export class VoiceAvatarModule {}
