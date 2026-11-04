import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { AdminIdentity } from './alert-bot.types';

@Injectable()
export class AlertBotAccess {
  private cache = new Map<string, { value: AdminIdentity | boolean; expires: number }>();
  constructor(private readonly pg: PgService) {}
  private cached<T extends AdminIdentity | boolean>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);
    return read().then((value) => {
      const now = Date.now();
      this.cache.set(key, { value, expires: now + 60_000 });
      for (const [cachedKey, entry] of this.cache) {
        if (entry.expires <= now) this.cache.delete(cachedKey);
      }
      while (this.cache.size > 1000) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
      return value;
    });
  }
  async resolveTelegram(tgUserId: string | number): Promise<AdminIdentity> {
    return this.cached(`tg:${tgUserId}`, async () => {
      const r = await this.pg.query(
        `SELECT p.user_id, p.isadmin FROM tg_user_identities t
         JOIN ai_profiles_consolidated p ON p.user_id = t.linkeon_user_id
         WHERE t.tg_user_id = $1 LIMIT 1`, [String(tgUserId)]);
      const row = r.rows[0];
      return { userId: row?.user_id || null, isAdmin: row?.isadmin === true };
    });
  }
  async isAdminUserId(userId: string): Promise<boolean> {
    return this.cached(`user:${userId}`, async () => {
      const r = await this.pg.query('SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      return r.rows[0]?.isadmin === true;
    });
  }
}
