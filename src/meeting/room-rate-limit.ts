import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';

/** Справка о комнате дешёвая — предел щедрый. */
export const LOOKUP_LIMIT_PER_IP = 60;
/** Вход выпускает токен в комнату — предел строже. */
export const JOIN_LIMIT_PER_IP = 10;

const WINDOW_SEC = 60;

/**
 * Ограничение частоты на публичных ручках комнаты.
 *
 * Это единственное место в проекте, куда можно стучаться без токена: гости —
 * не пользователи Linkeon, авторизации у них нет. Код комнаты шестисимвольный,
 * и без ограничения он перебирается, а за ним чужие переговоры.
 *
 * Счётчики раздельные для справки и входа: иначе десяток обновлений страницы
 * съедал бы право войти.
 */
@Injectable()
export class RoomRateLimit {
  private readonly logger = new Logger(RoomRateLimit.name);

  constructor(private readonly redis: RedisService) {}

  checkLookup(ip: string): Promise<boolean> {
    return this.hit(`room:lookup:${ip || 'unknown'}`, LOOKUP_LIMIT_PER_IP);
  }

  checkJoin(ip: string): Promise<boolean> {
    return this.hit(`room:join:${ip || 'unknown'}`, JOIN_LIMIT_PER_IP);
  }

  private async hit(key: string, limit: number): Promise<boolean> {
    try {
      const n = await this.redis.incr(key);
      // TTL ставим только на первом попадании. Иначе окно продлевается с
      // каждым запросом и не заканчивается никогда — вместо «60 в минуту»
      // получается «60 навсегда».
      if (n === 1) await this.redis.expire(key, WINDOW_SEC);
      return n <= limit;
    } catch (e: any) {
      // Отказ Redis не должен запирать вход всем сразу: перебор кода — риск,
      // а сорванная встреча у всех — точно ущерб.
      this.logger.warn(`ограничение частоты ${key} недоступно: ${e?.message}`);
      return true;
    }
  }
}
