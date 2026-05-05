import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PgService } from '../services/pg.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly pg: PgService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const user = ctx.switchToHttp().getRequest().user;
    if (!user?.phone) throw new ForbiddenException('Admin only');
    const res = await this.pg.query(
      `SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1`,
      [user.phone],
    );
    if (!res.rows[0]?.isadmin) throw new ForbiddenException('Admin only');
    return true;
  }
}
