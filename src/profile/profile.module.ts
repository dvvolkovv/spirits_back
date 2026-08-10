import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { IdentityModule } from '../identity/identity.module';
import { OAuthAppleService } from '../auth/oauth-apple.service';

@Module({
  imports: [Neo4jModule, IdentityModule],
  controllers: [ProfileController],
  // OAuthAppleService объявлен здесь, а не притянут из AuthModule: тот его не
  // экспортирует, а импортировать модуль целиком ради одного сервиса значило
  // бы рискнуть круговой зависимостью — AuthModule сам тянет IdentityModule.
  // Сервис не хранит состояния между вызовами, кроме кеша публичных ключей
  // Apple, так что второй экземпляр ничего не ломает.
  providers: [ProfileService, OAuthAppleService],
  exports: [ProfileService],
})
export class ProfileModule {}
