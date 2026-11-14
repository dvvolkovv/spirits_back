import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/** Экранирует glob-метасимволы Redis (* ? [ ] \), чтобы префикс матчился буквально. */
function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&');
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;
  private readonly logger = new Logger(RedisService.name);

  onModuleInit() {
    this.client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err) => this.logger.error('Redis error:', err.message));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  /**
   * Lua-скрипт на стороне Redis (EVAL): выполняется атомарно, никакая другая
   * команда не вклинится между его шагами. Нужен там, где проверка и запись
   * должны быть одним действием — см. src/auth/quota.ts.
   */
  async eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  /** SET NX PX: записать, только если ключа нет; true — записали мы. */
  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  /**
   * Task 17D — удалить все ключи с префиксом: курсорный SCAN (MATCH
   * "<префикс>*", COUNT-подсказка) + UNLINK батчами. Никогда не использует
   * KEYS: KEYS блокирует сервер O(N) по всему keyspace'у, SCAN итерирует
   * небольшими порциями, UNLINK освобождает память асинхронно. Возвращает
   * число удалённых ключей.
   *
   * Glob-метасимволы ('*', '?', '[', ']', '\') в префиксе экранируются —
   * префикс матчится буквально (вызывающий передаёт userId, но helper общий).
   * SCAN может вернуть один ключ дважды — UNLINK идемпотентен. Батч режется
   * на чанки по 100 ключей: COUNT это подсказка, Redis вправе вернуть больше,
   * а spread на тысячи аргументов рискован.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    const pattern = `${escapeRedisGlob(prefix)}*`;
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        deleted += await this.client.unlink(...batch);
      }
    } while (cursor !== '0');
    return deleted;
  }

  /** Добавляет значение в конец списка. Нужно буферу событий хода (products). */
  async rpush(key: string, value: string): Promise<number> {
    return this.client.rpush(key, value);
  }

  /** Диапазон списка включительно, как в ioredis/Redis (`-1` — последний элемент). */
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }
}
