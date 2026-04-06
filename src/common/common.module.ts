import { Module, Global } from '@nestjs/common';
import { PgService } from './services/pg.service';
import { RedisService } from './services/redis.service';
import { JwtService } from './services/jwt.service';

@Global()
@Module({
  providers: [PgService, RedisService, JwtService],
  exports: [PgService, RedisService, JwtService],
})
export class CommonModule {}
