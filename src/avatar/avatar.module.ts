import { Module } from '@nestjs/common';
import { AvatarController } from './avatar.controller';
import { AvatarService } from './avatar.service';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AvatarAccountDeletionAdapter } from './avatar-account-deletion.adapter';

@Module({
  imports: [AccountDeletionModule],
  controllers: [AvatarController],
  providers: [AvatarService, AvatarAccountDeletionAdapter],
})
export class AvatarModule {}
