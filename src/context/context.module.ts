import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TripModule } from '../trip/trip.module';
import { ContextService } from './context.service';

/**
 * Neo4jService и BusinessProfileService инжектятся опционально и их модули тут
 * НЕ импортируются — ровно так же, как в VoiceCallService: они доступны из
 * глобального графа, а лишний импорт рискует замкнуть цикл.
 */
@Module({
  imports: [CommonModule, TripModule],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
