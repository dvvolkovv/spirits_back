import { Global, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { IntegrationFlagsService } from './integration-flags.service';
import { IntegrationFlagsController } from './integration-flags.controller';

/**
 * Выключатели интеграций.
 *
 * Модуль глобальный намеренно: флаги спрашивают в трёх несвязанных местах —
 * распознавание ссылки в веб-чате, вход во встречу и кнопка в телеграм-боте,
 * — и протаскивать импорт в каждый из этих модулей значило бы плодить связи
 * ради одного булева значения.
 */
@Global()
@Module({
  imports: [CommonModule],
  controllers: [IntegrationFlagsController],
  providers: [IntegrationFlagsService],
  exports: [IntegrationFlagsService],
})
export class IntegrationsModule {}
