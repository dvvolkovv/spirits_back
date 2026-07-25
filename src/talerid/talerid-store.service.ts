import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { encryptSecret, decryptSecret } from '../calendar/crypto';
import { TalerIdConnection, TalerIdConnectionStatus } from './talerid.types';

export interface SaveConnectionParams {
  taleridUserId: string;
  refreshToken: string;
  accessToken?: string;
  accessExpiresAt?: Date;
  scopes: string;
}

/**
 * Store for the TalerID partner connection (§ Task 1 of the connector plan).
 * Tokens are encrypted at rest (AES-256-GCM, reusing src/calendar/crypto.ts —
 * same CALENDAR_SECRET_KEY as the CalDAV connector) and decrypted only on read.
 * Every query is scoped WHERE user_id=$1 — one row per user (PRIMARY KEY).
 *
 * updateRefresh is a dedicated, atomic overwrite: the TalerID refresh token
 * rotates on every oauth/token exchange, and reusing a stale refresh revokes
 * the whole chain — so the caller (TalerIdOauthService, Task 3) MUST call this
 * on every refresh before handing out the new access token.
 */
@Injectable()
export class TalerIdStoreService implements OnModuleInit {
  private readonly logger = new Logger(TalerIdStoreService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_talerid.sql'),
      path.join(__dirname, '..', '..', 'src', 'talerid', 'migrations', '001_talerid.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const sql = fs.readFileSync(p, 'utf8');
          await this.pg.query(sql);
          this.logger.log(`talerid migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`talerid migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('talerid migration sql not found, skipping');
  }

  /** Upsert on success (provision ok): encrypts refresh + optional access token, status='connected'. */
  async saveConnection(userId: string, params: SaveConnectionParams): Promise<void> {
    const refreshEnc = encryptSecret(params.refreshToken);
    const accessEnc = params.accessToken ? encryptSecret(params.accessToken) : null;
    await this.pg.query(
      `INSERT INTO talerid_connections
         (user_id, talerid_user_id, refresh_token_enc, access_token_enc, access_expires_at, scopes, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'connected',now())
       ON CONFLICT (user_id) DO UPDATE SET
         talerid_user_id=EXCLUDED.talerid_user_id,
         refresh_token_enc=EXCLUDED.refresh_token_enc,
         access_token_enc=EXCLUDED.access_token_enc,
         access_expires_at=EXCLUDED.access_expires_at,
         scopes=EXCLUDED.scopes,
         status='connected',
         updated_at=now()`,
      [userId, params.taleridUserId, refreshEnc, accessEnc, params.accessExpiresAt ?? null, params.scopes],
    );
  }

  /**
   * Atomic overwrite of the refresh token — MUST be called on every refresh-token
   * exchange (rotation). Never merges with a stale value.
   */
  async updateRefresh(userId: string, newRefreshToken: string): Promise<void> {
    await this.pg.query(
      `UPDATE talerid_connections SET refresh_token_enc=$2, updated_at=now() WHERE user_id=$1`,
      [userId, encryptSecret(newRefreshToken)],
    );
  }

  async updateAccess(userId: string, accessToken: string, expiresAt: Date): Promise<void> {
    await this.pg.query(
      `UPDATE talerid_connections SET access_token_enc=$2, access_expires_at=$3, updated_at=now() WHERE user_id=$1`,
      [userId, encryptSecret(accessToken), expiresAt],
    );
  }

  async getConnection(userId: string): Promise<TalerIdConnection | null> {
    const r = await this.pg.query(
      `SELECT user_id, talerid_user_id, scopes, status, access_expires_at FROM talerid_connections WHERE user_id=$1`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      taleridUserId: row.talerid_user_id,
      scopes: row.scopes,
      status: row.status,
      accessExpiresAt: row.access_expires_at ?? undefined,
    };
  }

  async getRefresh(userId: string): Promise<string | null> {
    const r = await this.pg.query(`SELECT refresh_token_enc FROM talerid_connections WHERE user_id=$1`, [userId]);
    const row = r.rows[0];
    if (!row?.refresh_token_enc) return null;
    return decryptSecret(row.refresh_token_enc);
  }

  async getAccess(userId: string): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
    const r = await this.pg.query(
      `SELECT access_token_enc, access_expires_at FROM talerid_connections WHERE user_id=$1`,
      [userId],
    );
    const row = r.rows[0];
    if (!row?.access_token_enc) return null;
    return { accessToken: decryptSecret(row.access_token_enc), expiresAt: row.access_expires_at ?? null };
  }

  async setStatus(userId: string, status: TalerIdConnectionStatus): Promise<void> {
    await this.pg.query(
      `INSERT INTO talerid_connections (user_id, status, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, updated_at=now()`,
      [userId, status],
    );
  }

  async delete(userId: string): Promise<void> {
    await this.pg.query(`DELETE FROM talerid_connections WHERE user_id=$1`, [userId]);
  }
}
