import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PeerController } from './peer.controller';
import { PeerService } from './peer.service';

@Module({
  imports: [CommonModule],
  controllers: [PeerController],
  providers: [PeerService],
  exports: [PeerService],
})
export class PeerModule {}
