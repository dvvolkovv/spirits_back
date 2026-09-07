import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PgService } from '../common/services/pg.service';

/**
 * Раннер живёт на клиентской VM и приходит с per-product токеном. JwtGuard
 * здесь не подходит: у раннера нет пользователя, он представляет продукт.
 *
 * В базе лежит только sha256 токена — утечка дампа не даёт доступа к VM.
 */
@Injectable()
export class RunnerGuard implements CanActivate {
  constructor(private readonly pg: PgService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = String(req.headers['authorization'] ?? '');
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    if (!token) throw new UnauthorizedException('Missing runner token');

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await this.pg.query(
      `SELECT id, user_id, checkout_path, build_cmd, restart_cmd, health_url,
              repo_url, claude_session_id
         FROM products
        WHERE runner_token_hash = $1 AND archived_at IS NULL`,
      [hash],
    );
    if (!r.rows[0]) throw new UnauthorizedException('Unknown runner token');

    req.product = r.rows[0];
    return true;
  }
}
