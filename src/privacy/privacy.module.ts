import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PrivacyController } from './privacy.controller';

@Module({
  imports: [CommonModule],
  controllers: [PrivacyController],
})
export class PrivacyModule {}
