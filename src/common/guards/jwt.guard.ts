import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '../services/jwt.service';
import { PgService } from '../services/pg.service';

@Injectable()
export class JwtGuard implements CanActivate {
  // Кеш isAdmin на 60 сек чтобы не дёргать БД на каждый запрос.
  private adminCache = new Map<string, { isAdmin: boolean; expires: number }>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly pg: PgService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = authHeader.substring(7);
    let payload: any;
    try {
      payload = this.jwtService.verify(token);
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type');
      }
    } catch (e) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const userId: string = payload.userId ?? payload.sub;
    let isAdmin = false;
    const cached = this.adminCache.get(userId);
    if (cached && cached.expires > Date.now()) {
      isAdmin = cached.isAdmin;
    } else {
      try {
        const r = await this.pg.query(
          `SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1`,
          [userId],
        );
        isAdmin = Boolean(r.rows[0]?.isadmin);
        this.adminCache.set(userId, { isAdmin, expires: Date.now() + 60_000 });
      } catch {
        // Если БД легла — пусть пользователь работает как не-админ, не отдаём 500
        isAdmin = false;
      }
    }

    request.user = { userId, sub: payload.sub, isAdmin };
    return true;
  }
}
