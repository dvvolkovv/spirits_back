import { Module, Global } from '@nestjs/common';
import { PgService } from './services/pg.service';
import { RedisService } from './services/redis.service';
import { JwtService } from './services/jwt.service';
import { IpRateLimiter } from './guards/ip-rate-limit';
import { StorageService } from './services/storage.service';

@Global()
@Module({
  providers: [PgService, RedisService, JwtService, IpRateLimiter, StorageService],
  exports: [PgService, RedisService, JwtService, IpRateLimiter, StorageService],
})
export class CommonModule {}
