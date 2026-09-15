import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * `openssl rand -hex 32` даёт 64 символа; граница вдвое ниже — чтобы отсечь
 * заглушки вроде `test` или `changeme`, но не спорить с тем, кто принесёт свой
 * длинный токен не в hex. За гвардом лежит claimJob, отдающий расшифрованные
 * секреты ВСЕХ продуктов, так что молчаливый слабый токен здесь дороже, чем
 * гибкость формата.
 */
const MIN_TOKEN_LEN = 32;

/**
 * Печатный ASCII без пробела. Не про стойкость, а про то, что иначе конфиг
 * недостижим в принципе: значения HTTP-заголовков латинские (latin1), и
 * неASCII-токен нашему же агенту не отправить — `http.request` бросает
 * ERR_INVALID_CHAR ещё до запроса. Досланный сырым сокетом, он вернётся
 * latin1-строкой и после utf8-перекодировки разойдётся с ожидаемым по длине
 * (измерено: 23 байта против 45). Пробел отсечён заодно: хвостовой пробел в
 * .env иначе даёт вечный 401 без единой подсказки.
 */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/**
 * Агент хоста представляет машину, а не продукт и не пользователя, поэтому ни
 * JwtGuard, ни RunnerGuard не подходят.
 *
 * Токен один и лежит в окружении: хост один. Таблица хостов — YAGNI, триггер
 * пересмотра назван в спеке (второй хост).
 *
 * Разбор заголовка намеренно слово-в-слово повторяет RunnerGuard: два гварда с
 * разным пониманием `Bearer ` в одном модуле — готовый источник «на одном хосте
 * работает, на другом нет».
 */
@Injectable()
export class HostGuard implements CanActivate {
  private readonly log = new Logger(HostGuard.name);

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const expected = this.config.get<string>('PRODUCT_HOST_TOKEN');
    const problem = this.configProblem(expected);
    if (problem) {
      // Причина — в лог, наружу общее сообщение. Иначе единственным сигналом о
      // сломанном конфиге был бы 401 тому, кто постучится: оператор узнавал бы
      // о поломке от агента, а не от сервера. Сам токен в лог не пишем.
      this.log.error(`PRODUCT_HOST_TOKEN ${problem}: агент хоста не заберёт ни одного задания`);
      throw new UnauthorizedException('host token not configured');
    }

    // Заголовок берём только строкой. `String(...)` принял бы одноэлементный
    // массив (`String(['Bearer x']) === 'Bearer x'`), и безопасность держалась
    // бы на том, что Node отбрасывает дубликаты Authorization — детали ядра вне
    // этого репозитория, которую здесь ничто не проверяет.
    const header = context.switchToHttp().getRequest().headers['authorization'];
    const raw = typeof header === 'string' ? header : '';
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

  /** Человеческая причина для лога либо null, если с конфигом всё в порядке. */
  private configProblem(expected?: string): string | null {
    // Пустое ожидаемое обязано закрывать вход, а не открывать: иначе оно
    // совпало бы с пустым присланным.
    if (!expected) return 'не задан';
    if (!TOKEN_SHAPE.test(expected)) return 'содержит пробел, управляющий символ или неASCII';
    if (expected.length < MIN_TOKEN_LEN) return `короче ${MIN_TOKEN_LEN} символов`;
    return null;
  }
}
