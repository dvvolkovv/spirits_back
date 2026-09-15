import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Агент хоста представляет машину, а не продукт и не пользователя, поэтому ни
 * JwtGuard, ни RunnerGuard не подходят.
 *
 * Токен один и лежит в окружении: хост один. Таблица хостов — YAGNI, триггер
 * пересмотра назван в спеке (второй хост).
 */
@Injectable()
export class HostGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const expected = this.config.get<string>('PRODUCT_HOST_TOKEN');
    // Ненастроенный токен обязан закрывать вход, а не открывать: иначе
    // пустое ожидаемое совпало бы с пустым присланным.
    if (!expected) throw new UnauthorizedException('host token not configured');

    const raw = String(context.switchToHttp().getRequest().headers['authorization'] ?? '');
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    if (!token) throw new UnauthorizedException('Missing host token');

    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    // Длины сверяются до timingSafeEqual: на разных длинах он бросает
    // RangeError, и агент с укороченным токеном получил бы 500 вместо отказа.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Bad host token');
    }
    return true;
  }
}
