import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TripModule } from '../trip/trip.module';
import { TalerIdModule } from '../talerid/talerid.module';
import { ContextResetModule } from '../chat/context-reset/context-reset.module';
import { ContextService } from './context.service';
import { RecallService } from './recall.service';

/**
 * Neo4jService и BusinessProfileService инжектятся опционально и их модули тут
 * НЕ импортируются — ровно так же, как в VoiceCallService: они доступны из
 * глобального графа, а лишний импорт рискует замкнуть цикл.
 */
/**
 * `TalerIdModule` импортируется явно: заметки живут там, а глобального графа
 * у его коннектора нет. Цикла это не создаёт — TalerID про контекст не знает.
 *
 * `ContextResetModule` — точка «Чистого листа» для раздела «Из переписки».
 * Импортируется сам, а не через ChatModule: он зависит только от CommonModule,
 * и цикла через чат не возникает.
 */
@Module({
  imports: [CommonModule, TripModule, TalerIdModule, ContextResetModule],
  providers: [ContextService, RecallService],
  exports: [ContextService, RecallService],
})
export class ContextModule {}
