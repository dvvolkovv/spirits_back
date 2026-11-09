import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RetentionRecipientResolver } from './retention-recipient-resolver';
import { RetentionService } from './retention.service';
import { RetentionUnsubscribeController } from './retention-unsubscribe.controller';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';

@Module({
  imports: [CommonModule],
  controllers: [RetentionUnsubscribeController],
  providers: [RetentionService, RetentionRecipientResolver, RetentionUnsubscribeService],
  exports: [RetentionService],
})
export class RetentionModule {}
