import { Module, Global } from '@nestjs/common';
import { PgService } from './services/pg.service';
import { RedisService } from './services/redis.service';
import { JwtService } from './services/jwt.service';
import { IpRateLimiter } from './guards/ip-rate-limit';
import { StorageService } from './services/storage.service';
import { ClaudeCliService } from './services/claude-cli.service';

@Global()
@Module({
  providers: [PgService, RedisService, JwtService, IpRateLimiter, StorageService, ClaudeCliService],
  exports: [PgService, RedisService, JwtService, IpRateLimiter, StorageService, ClaudeCliService],
})
export class CommonModule {}
