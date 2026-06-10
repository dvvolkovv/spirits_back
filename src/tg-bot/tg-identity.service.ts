import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class TgIdentityService {
  private readonly logger = new Logger(TgIdentityService.name);
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000;

  constructor(private readonly pg: PgService) {}

  async createAuthToken(ownerId: string): Promise<string> {
    const expires = new Date(Date.now() + this.TOKEN_TTL_MS);
    const r = await this.pg.query(
      `INSERT INTO tg_claim_tokens (kind, owner_user_id, expires_at)
       VALUES ('auth', $1, $2)
       RETURNING token`,
      [ownerId, expires],
    );
    return r.rows[0].token;
  }

  async consumeAuthToken(
    token: string,
    tgUserId: number,
    tgUsername: string | null,
    tgFirstName: string | null,
  ): Promise<string> {
    const r = await this.pg.query(
      `SELECT owner_user_id FROM tg_claim_tokens
        WHERE token = $1 AND kind = 'auth' AND consumed_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [token],
    );
    if (r.rows.length === 0) {
      throw new BadRequestException('invalid or expired auth token');
    }
    const ownerId = r.rows[0].owner_user_id;
    await this.pg.query(
      `UPDATE tg_claim_tokens SET consumed_at = now() WHERE token = $1`,
      [token],
    );
    await this.pg.query(
      `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id, tg_username, tg_first_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (linkeon_user_id) DO UPDATE SET
         tg_user_id = EXCLUDED.tg_user_id,
         tg_username = EXCLUDED.tg_username,
         tg_first_name = EXCLUDED.tg_first_name`,
      [ownerId, tgUserId, tgUsername, tgFirstName],
    );
    return ownerId;
  }

  async getIdentityByLinkeonId(ownerId: string): Promise<{ tgUserId: number; tgUsername: string | null; tgFirstName: string | null } | null> {
    const r = await this.pg.query(
      `SELECT tg_user_id, tg_username, tg_first_name FROM tg_user_identities WHERE linkeon_user_id = $1 LIMIT 1`,
      [ownerId],
    );
    if (r.rows.length === 0) return null;
    return {
      tgUserId: Number(r.rows[0].tg_user_id),
      tgUsername: r.rows[0].tg_username,
      tgFirstName: r.rows[0].tg_first_name,
    };
  }

  async getLinkeonIdByTgUserId(tgUserId: number): Promise<string | null> {
    const r = await this.pg.query(
      `SELECT linkeon_user_id FROM tg_user_identities WHERE tg_user_id = $1 LIMIT 1`,
      [tgUserId],
    );
    return r.rows[0]?.linkeon_user_id ?? null;
  }
}
