import { Module } from '@nestjs/common';
import { TmaController } from './tma.controller';
import { CommonModule } from '../common/common.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [CommonModule, IdentityModule],
  controllers: [TmaController],
})
export class TmaModule {}
