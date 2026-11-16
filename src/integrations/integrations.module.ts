import { Global, Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { CommonModule } from '../common/common.module';
import { IdentityModule } from '../identity/identity.module';
import { TalerIdModule } from '../talerid/talerid.module';
import { ZoomModule } from '../zoom/zoom.module';
// OAuthAppleService объявлен здесь, а не притянут из AuthModule: тот его не
// экспортирует, а тянуть AuthModule целиком — рискнуть круговой зависимостью
// (та же схема, что в ProfileModule).
import { OAuthAppleService } from '../auth/oauth-apple.service';
import { IntegrationFlagsService } from './integration-flags.service';
import { IntegrationFlagsController } from './integration-flags.controller';
import { IntegrationAccountDeletionAdapter } from './integration-account-deletion.adapter';

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
  imports: [CommonModule, IdentityModule, ZoomModule, TalerIdModule, AccountDeletionModule],
  controllers: [IntegrationFlagsController],
  providers: [IntegrationFlagsService, OAuthAppleService, IntegrationAccountDeletionAdapter],
  exports: [IntegrationFlagsService],
})
export class IntegrationsModule {}
