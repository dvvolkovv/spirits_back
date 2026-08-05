import { Module, Global } from '@nestjs/common';
import { PgService } from './services/pg.service';
import { RedisService } from './services/redis.service';
import { JwtService } from './services/jwt.service';
import { IpRateLimiter } from './guards/ip-rate-limit';
import { StorageService } from './services/storage.service';
import { ClaudeCliService } from './services/claude-cli.service';
import { LanguageService } from './services/language.service';

@Global()
@Module({
  providers: [PgService, RedisService, JwtService, IpRateLimiter, StorageService, ClaudeCliService, LanguageService],
  exports: [PgService, RedisService, JwtService, IpRateLimiter, StorageService, ClaudeCliService, LanguageService],
})
export class CommonModule {}
