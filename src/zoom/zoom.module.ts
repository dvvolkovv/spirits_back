import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ZoomController } from './zoom.controller';
import { ZoomOauthClient } from './zoom-oauth.client';
import { ZoomOauthService } from './zoom-oauth.service';
import { ZoomStoreService } from './zoom-store.service';

/**
 * Подключение аккаунта Zoom ради токена On-Behalf-Of.
 *
 * Нужен, чтобы ассистент мог заходить на встречи ЛЮБЫХ хозяев, а не только
 * нашего аккаунта: с 2 марта 2026 Zoom требует такой токен, и выдаётся он от
 * имени человека, который приложение авторизовал и на встрече присутствует.
 *
 * Сервис вынесен наружу: его зовёт `MeetingService` перед созданием бота.
 */
@Module({
  imports: [CommonModule],
  controllers: [ZoomController],
  providers: [ZoomStoreService, ZoomOauthClient, ZoomOauthService],
  exports: [ZoomOauthService],
})
export class ZoomModule {}
