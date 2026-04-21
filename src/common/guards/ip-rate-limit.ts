// src/common/guards/ip-rate-limit.ts
import { Injectable, Logger, HttpException } from '@nestjs/common';
import { RedisService } from '../services/redis.service';

@Injectable()
export class IpRateLimiter {
  private readonly logger = new Logger(IpRateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Atomically increment a per-IP counter within a fixed window bucket.
   * Throws HttpException 429 when the count exceeds `limit`.
   */
  async check(ip: string, bucket: string, limit: number, windowSeconds: number): Promise<void> {
    const bucketId = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rl:${bucket}:${ip}:${bucketId}`;
    const n = await this.redis.incr(key);
    if (n === 1) {
      // first increment — set TTL so the bucket eventually cleans itself
      await this.redis.expire(key, windowSeconds);
    }
    if (n > limit) {
      throw new HttpException(
        { error: 'rate_limited', retryAfter: windowSeconds },
        429,
      );
    }
  }
}
