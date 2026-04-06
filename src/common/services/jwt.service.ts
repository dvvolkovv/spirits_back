import { Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class JwtService {
  private readonly secret = process.env.JWT_SECRET || 'default_secret_change_me';
  private readonly accessExpires = parseInt(process.env.JWT_ACCESS_EXPIRES || '7200');
  private readonly refreshExpires = parseInt(process.env.JWT_REFRESH_EXPIRES || '2592000');

  signAccess(phone: string): string {
    return jwt.sign(
      { sub: phone, phone, type: 'access' },
      this.secret,
      { expiresIn: this.accessExpires },
    );
  }

  signRefresh(phone: string): string {
    return jwt.sign(
      { sub: phone, phone, type: 'refresh' },
      this.secret,
      { expiresIn: this.refreshExpires },
    );
  }

  verify(token: string): any {
    return jwt.verify(token, this.secret);
  }

  decode(token: string): any {
    return jwt.decode(token);
  }
}
