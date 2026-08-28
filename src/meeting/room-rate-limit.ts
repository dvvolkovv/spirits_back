import { HttpException, Injectable, Logger } from '@nestjs/common';
import { IpRateLimiter } from '../common/guards/ip-rate-limit';

/** Справка о комнате дешёвая — предел щедрый. */
export const LOOKUP_LIMIT_PER_IP = 60;
/** Вход выпускает токен в комнату — предел строже. */
export const JOIN_LIMIT_PER_IP = 10;

const WINDOW_SEC = 60;

/**
 * Ограничение частоты на публичных ручках комнаты.
 *
 * Это единственное место в проекте, куда стучатся без токена: гости — не
 * пользователи Linkeon, авторизации у них нет. Код шестисимвольный, и без
 * ограничения он перебирается, а за ним чужие переговоры.
 *
 * Считает не сам, а поверх общего IpRateLimiter — тот уже умеет атомарный
 * счётчик с окном. Здесь только политика, которой там нет:
 *
 *   1. Раздельные вёдра для справки и входа. С общим десяток обновлений
 *      страницы съедал бы право войти.
 *   2. Отказ Redis ПРОПУСКАЕТ, а не запирает. IpRateLimiter выпустит наружу
 *      ошибку соединения, и ручка ответит 500 — то есть «никто не может войти
 *      во встречу». Перебор кода это риск, а сорванная встреча у всех сразу —
 *      уже ущерб.
 */
@Injectable()
export class RoomRateLimit {
  private readonly logger = new Logger(RoomRateLimit.name);

  constructor(private readonly limiter: IpRateLimiter) {}

  checkLookup(ip: string): Promise<boolean> {
    return this.allow(ip, 'room-lookup', LOOKUP_LIMIT_PER_IP);
  }

  checkJoin(ip: string): Promise<boolean> {
    return this.allow(ip, 'room-join', JOIN_LIMIT_PER_IP);
  }

  private async allow(ip: string, bucket: string, limit: number): Promise<boolean> {
    try {
      await this.limiter.check(ip || 'unknown', bucket, limit, WINDOW_SEC);
      return true;
    } catch (e: any) {
      // 429 — предел действительно превышен, это рабочий исход.
      if (e instanceof HttpException && e.getStatus() === 429) return false;
      // Всё остальное — инфраструктура. Пропускаем.
      this.logger.warn(`ограничение частоты ${bucket} недоступно: ${e?.message}`);
      return true;
    }
  }
}
