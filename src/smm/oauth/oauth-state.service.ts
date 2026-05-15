// src/smm/oauth/oauth-state.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PgService } from '../../common/services/pg.service';

export type Platform = 'vk' | 'youtube' | 'tiktok' | 'instagram';

@Injectable()
export class OAuthStateService {
  private readonly logger = new Logger(OAuthStateService.name);

  constructor(private readonly pg: PgService) {}

  /** Generate and persist a fresh CSRF state token. Returns the state value to embed in the OAuth URL. */
  async create(userId: string, platform: Platform, redirectUrl?: string): Promise<string> {
    const state = crypto.randomBytes(24).toString('hex');
    await this.pg.query(
      `INSERT INTO smm_oauth_state (state, user_id, platform, redirect_url)
       VALUES ($1, $2, $3, $4)`,
      [state, userId, platform, redirectUrl ?? null],
    );
    return state;
  }

  /** Look up, validate, and delete a state token. Returns the original userId or throws. */
  async consume(state: string, platform: Platform): Promise<{ userId: string; redirectUrl: string | null }> {
    const r = await this.pg.query(
      `DELETE FROM smm_oauth_state
        WHERE state = $1 AND platform = $2 AND created_at > now() - interval '10 minutes'
       RETURNING user_id, redirect_url`,
      [state, platform],
    );
    if (r.rows.length === 0) throw new Error(`Invalid or expired OAuth state for ${platform}`);
    return { userId: r.rows[0].user_id, redirectUrl: r.rows[0].redirect_url };
  }

  /** Periodic cleanup of stale rows (called from a cron, not implemented here). */
  async pruneStale(): Promise<number> {
    const r = await this.pg.query(
      `DELETE FROM smm_oauth_state WHERE created_at < now() - interval '10 minutes'`,
    );
    return r.rowCount ?? 0;
  }
}
