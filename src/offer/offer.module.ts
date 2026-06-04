import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { OfferController } from './offer.controller';
import { OfferService } from './offer.service';

@Module({
  imports: [CommonModule],
  controllers: [OfferController],
  providers: [OfferService],
  exports: [OfferService],
})
export class OfferModule {}
