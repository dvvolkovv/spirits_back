import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { PeerController } from './peer.controller';
import { PeerService } from './peer.service';
import { PeerAccountDeletionAdapter } from './peer-account-deletion.adapter';

@Module({
  imports: [CommonModule, AccountDeletionModule],
  controllers: [PeerController],
  providers: [PeerService, PeerAccountDeletionAdapter],
  exports: [PeerService],
})
export class PeerModule {}
