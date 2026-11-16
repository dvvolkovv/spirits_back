import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { IdentityModule } from '../identity/identity.module';
import { OAuthAppleService } from '../auth/oauth-apple.service';
import { EmailService } from '../auth/email.service';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { ProfileAccountDeletionAdapter } from './profile-account-deletion.adapter';
import { ProfileAccountDeletionRecapture } from './profile-account-deletion.discovery';

@Module({
  // ChatUploadsModule здесь больше не нужен: chat_uploads стирает конвейер
  // (chat-upload.purge, адаптер живёт в ChatUploadsModule и регистрируется
  // в AccountDeletionRegistry), ProfileService реестр загрузок не использует.
  imports: [Neo4jModule, IdentityModule, AccountDeletionModule],
  controllers: [ProfileController],
  // OAuthAppleService объявлен здесь, а не притянут из AuthModule: тот его не
  // экспортирует, а импортировать модуль целиком ради одного сервиса значило
  // бы рискнуть круговой зависимостью — AuthModule сам тянет IdentityModule.
  // Сервис не хранит состояния между вызовами, кроме кеша публичных ключей
  // Apple, так что второй экземпляр ничего не ломает.
  //
  // Task 17: адаптер account.core.* регистрируется в AccountDeletionRegistry
  // через onModuleInit; AccountDeletionModule (@Global) даёт Jobs/Planner/
  // Registry, PgService глобален. Recapture — обычный класс без декоратора,
  // поэтому провайдером useFactory (та же форма, что у Jobs/Planner в
  // AccountDeletionModule). Env не передаём: discoverChatFiles берёт
  // extractEnv() из process.env воркера.
  providers: [
    ProfileService,
    OAuthAppleService,
    EmailService,
    ProfileAccountDeletionAdapter,
    {
      provide: ProfileAccountDeletionRecapture,
      useFactory: (pg: PgService, planner: AccountDeletionPlanner) =>
        new ProfileAccountDeletionRecapture(pg, planner),
      inject: [PgService, AccountDeletionPlanner],
    },
  ],
  exports: [ProfileService],
})
export class ProfileModule {}
