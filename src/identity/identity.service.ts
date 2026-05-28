import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import type { Provider, ProviderData, Identity, ResolveResult } from './identity.types';

@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly logger = new Logger(IdentityService.name);
  private readonly WELCOME_BONUS = 25000;

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_identity_init.sql'),
      path.join(__dirname, '..', '..', 'src', 'identity', 'migrations', '001_identity_init.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const sql = fs.readFileSync(p, 'utf8');
          await this.pg.query(sql);
          this.logger.log(`identity migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`identity migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('identity migration sql not found, skipping');
  }

  private normalize(provider: Provider, data: any): string {
    if (provider === 'phone') return (data.phone || '').replace(/\D/g, '');
    if (provider === 'email') return (data.email || '').trim().toLowerCase();
    if (provider === 'google' || provider === 'yandex') return data.sub;
    throw new Error(`unknown provider: ${provider}`);
  }

  private extractEmail(provider: Provider, data: any): { email: string | null; verified: boolean } {
    if (provider === 'email')  return { email: this.normalize('email', data), verified: true };
    if (provider === 'google' || provider === 'yandex') {
      return { email: (data.email || '').trim().toLowerCase(), verified: Boolean(data.emailVerified) };
    }
    return { email: null, verified: false };
  }

  async resolveOrCreate<P extends Provider>(provider: P, data: ProviderData<P>): Promise<ResolveResult> {
    if (!this.pg) throw new Error('pg not configured');

    const providerSub = this.normalize(provider, data);
    const { email, verified } = this.extractEmail(provider, data);

    // 1) Lookup
    const found = await this.pg.query(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_sub = $2 LIMIT 1`,
      [provider, providerSub],
    );
    if (found.rows.length) {
      const userId = found.rows[0].user_id;
      await this.pg.query(
        `UPDATE user_identities SET last_used_at = now() WHERE provider = $1 AND provider_sub = $2`,
        [provider, providerSub],
      );
      return { userId, isNew: false, mergedExisting: false };
    }

    // 2) Merge by verified email (для email/google/yandex с подтверждённым email)
    if (email && verified) {
      const merge = await this.pg.query(
        `SELECT user_id FROM user_identities WHERE email = $1 AND email_verified = true LIMIT 1`,
        [email],
      );
      if (merge.rows.length) {
        const userId = merge.rows[0].user_id;
        await this.pg.query(
          `INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified, last_used_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [userId, provider, providerSub, email, verified],
        );
        return { userId, isNew: false, mergedExisting: true };
      }
    }

    // 3) Create new — в транзакции
    await this.pg.query(`BEGIN`);
    try {
      let userId: string;
      if (provider === 'phone') {
        userId = providerSub;
        await this.pg.query(
          `INSERT INTO user_id (primary_phone, state, internal_id, signup_method)
           VALUES ($1, 'active', $2, $3) ON CONFLICT (internal_id) DO NOTHING
           RETURNING internal_id`,
          [providerSub, userId, provider],
        );
      } else {
        const ins = await this.pg.query(
          `INSERT INTO user_id (state, internal_id, primary_email, signup_method)
           VALUES ('active', gen_random_uuid()::text, $1, $2)
           RETURNING internal_id`,
          [email, provider],
        );
        userId = ins.rows[0].internal_id;
      }
      await this.pg.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens, isadmin) VALUES ($1, 0, false) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await this.pg.query(
        `INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified, last_used_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [userId, provider, providerSub, email, verified],
      );
      await this.issueWelcomeBonus(userId);
      await this.pg.query(`COMMIT`);
      return { userId, isNew: true, mergedExisting: false };
    } catch (e: any) {
      await this.pg.query(`ROLLBACK`);
      throw e;
    }
  }

  private async issueWelcomeBonus(userId: string): Promise<void> {
    if (!this.pg) return;
    const claimed = await this.pg.query(
      `UPDATE user_id SET welcome_bonus_at = now()
       WHERE internal_id = $1 AND welcome_bonus_at IS NULL
       RETURNING internal_id`,
      [userId],
    );
    if (claimed.rows.length === 0) return;
    await this.pg.query(
      `UPDATE ai_profiles_consolidated SET tokens = tokens + $1 WHERE user_id = $2`,
      [this.WELCOME_BONUS, userId],
    );
    this.logger.log(`welcome bonus ${this.WELCOME_BONUS} → ${userId}`);
  }

  async linkMethod<P extends Provider>(userId: string, provider: P, data: ProviderData<P>): Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'invalid' }> {
    if (!this.pg) return { ok: false, reason: 'invalid' };

    const providerSub = this.normalize(provider, data);
    const { email, verified } = this.extractEmail(provider, data);

    const existing = await this.pg.query(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_sub = $2 LIMIT 1`,
      [provider, providerSub],
    );
    if (existing.rows.length) {
      if (existing.rows[0].user_id === userId) return { ok: true };
      return { ok: false, reason: 'conflict' };
    }
    await this.pg.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified, last_used_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [userId, provider, providerSub, email, verified],
    );
    return { ok: true };
  }

  async unlinkMethod(userId: string, identityId: string): Promise<{ ok: true } | { ok: false; reason: 'last_method' }> {
    if (!this.pg) return { ok: false, reason: 'last_method' };
    const cnt = await this.pg.query(
      `SELECT count(*)::int AS count FROM user_identities WHERE user_id = $1`,
      [userId],
    );
    if (parseInt(cnt.rows[0].count, 10) <= 1) return { ok: false, reason: 'last_method' };
    await this.pg.query(
      `DELETE FROM user_identities WHERE id = $1 AND user_id = $2`,
      [identityId, userId],
    );
    return { ok: true };
  }

  async listIdentities(userId: string): Promise<Identity[]> {
    if (!this.pg) return [];
    const res = await this.pg.query(
      `SELECT id, provider, provider_sub, email, email_verified, created_at, last_used_at
         FROM user_identities WHERE user_id = $1
         ORDER BY created_at`,
      [userId],
    );
    return res.rows.map(r => ({
      id: r.id,
      provider: r.provider,
      providerSub: r.provider_sub,
      email: r.email,
      emailVerified: r.email_verified,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  async findIdentityByEmail(email: string): Promise<{ userId: string } | null> {
    if (!this.pg) return null;
    const normalized = email.trim().toLowerCase();
    const r = await this.pg.query(
      `SELECT user_id FROM user_identities
       WHERE provider = 'email' AND provider_sub = $1 AND email_verified = true
       LIMIT 1`,
      [normalized],
    );
    return r.rows[0] ? { userId: r.rows[0].user_id } : null;
  }

  async getUserPasswordHash(userId: string): Promise<string | null> {
    if (!this.pg) return null;
    const r = await this.pg.query(`SELECT password_hash FROM user_id WHERE internal_id = $1`, [userId]);
    return r.rows[0]?.password_hash || null;
  }

  async setUserPasswordHash(userId: string, hash: string): Promise<void> {
    if (!this.pg) return;
    await this.pg.query(`UPDATE user_id SET password_hash = $1 WHERE internal_id = $2`, [hash, userId]);
  }

  async touchIdentity(provider: Provider, providerSub: string): Promise<void> {
    if (!this.pg) return;
    await this.pg.query(
      `UPDATE user_identities SET last_used_at = now() WHERE provider = $1 AND provider_sub = $2`,
      [provider, providerSub],
    );
  }
}
