import { Module, Global } from '@nestjs/common';
import { PgService } from './services/pg.service';
import { RedisService } from './services/redis.service';
import { JwtService } from './services/jwt.service';
import { IpRateLimiter } from './guards/ip-rate-limit';
import { StorageService } from './services/storage.service';
import { ClaudeCliService } from './services/claude-cli.service';
import { LanguageService } from './services/language.service';
import { MailService } from './services/mail.service';
// Инфраструктурный клиент без состояния — читает env и ходит в LiveKit, ровно
// как PgService в базу. Живёт здесь, чтобы комнаты, звонки и встречи получали
// его не через импорты друг друга: с ними граф модулей замыкался в кольцо.
import { LiveKitClient } from '../voice-call/livekit.client';

@Global()
@Module({
  providers: [PgService, RedisService, JwtService, IpRateLimiter, StorageService, ClaudeCliService, LanguageService, MailService, LiveKitClient],
  exports: [PgService, RedisService, JwtService, IpRateLimiter, StorageService, ClaudeCliService, LanguageService, MailService, LiveKitClient],
})
export class CommonModule {}
