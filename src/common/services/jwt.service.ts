import { Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class JwtService {
  private readonly secret = process.env.JWT_SECRET || 'default_secret_change_me';
  private readonly accessExpires = parseInt(process.env.JWT_ACCESS_EXPIRES || '7200');
  private readonly refreshExpires = parseInt(process.env.JWT_REFRESH_EXPIRES || '2592000');

  signAccess(userId: string): string {
    return jwt.sign(
      { sub: userId, userId, type: 'access' },
      this.secret,
      { expiresIn: this.accessExpires },
    );
  }

  signRefresh(userId: string): string {
    return jwt.sign(
      { sub: userId, userId, type: 'refresh' },
      this.secret,
      { expiresIn: this.refreshExpires },
    );
  }

  verify(token: string): any {
    return jwt.verify(token, this.secret);
  }

  /**
   * Только токен доступа. Тем же секретом подписаны токены обновления и
   * токены инструмента продуктов — последние живут на релее, где их видят и
   * чужие сессии. Где решается «чей это аккаунт», нужен именно этот метод.
   */
  verifyAccess(token: string): any {
    const payload: any = this.verify(token);
    if (payload?.type !== 'access') throw new Error('not an access token');
    return payload;
  }

  decode(token: string): any {
    return jwt.decode(token);
  }
}
