import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { EventsService } from '../events/events.service';
import type { Provider, ProviderData, Identity, ResolveResult } from './identity.types';

@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly logger = new Logger(IdentityService.name);
  private readonly WELCOME_BONUS = 25000;

  constructor(
    @Optional() private readonly pg?: PgService,
    @Optional() private readonly events?: EventsService,
  ) {}

  async onModuleInit() {
    if (!this.pg) return;
    const files = ['001_identity_init.sql', '002_talerid_provider.sql', '003_telegram_provider.sql'];
    for (const file of files) {
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'identity', 'migrations', file),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) {
        this.logger.warn(`identity migration ${file} not found, skipping`);
        continue;
      }
      const sql = fs.readFileSync(found, 'utf8');
      // Retry up to 5× with 1s backoff — PG pool connections are lazy and
      // occasionally the first query races against pool warm-up on startup.
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await this.pg.query(sql);
          this.logger.log(`identity migration applied: ${file}`);
          break;
        } catch (e: any) {
          if (attempt < 5) {
            this.logger.warn(`identity migration ${file} attempt ${attempt} failed: ${e.message} — retrying in 1s`);
            await new Promise((r) => setTimeout(r, 1000));
          } else {
            this.logger.error(`identity migration ${file} failed after ${attempt} attempts: ${e.message}`);
          }
        }
      }
    }
  }

  private normalize(provider: Provider, data: any): string {
    if (provider === 'phone') return (data.phone || '').replace(/\D/g, '');
    if (provider === 'email') return (data.email || '').trim().toLowerCase();
    // talerid отдаёт тот же {sub,email,emailVerified}, что google/yandex —
    // без этой ветки normalize бросал бы «unknown provider» уже в рантайме,
    // хотя типы бы сошлись.
    if (provider === 'google' || provider === 'yandex' || provider === 'talerid' || provider === 'apple') return data.sub;
    if (provider === 'telegram') return String(data.sub);
    throw new Error(`unknown provider: ${provider}`);
  }

  private extractEmail(provider: Provider, data: any): { email: string | null; verified: boolean } {
    if (provider === 'email')  return { email: this.normalize('email', data), verified: true };
    if (provider === 'google' || provider === 'yandex' || provider === 'talerid' || provider === 'apple') {
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
      this.events?.track('auth_succeeded', { userId, props: { method: provider, is_new: false } });
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
        this.events?.track('auth_succeeded', { userId, props: { method: provider, is_new: false, merged: true } });
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
        // Регистрация тем же номером после удаления неизбежно попадает в ту же
        // строку: у телефонного входа internal_id — это сам номер, и вставка
        // молча ничего не делает. Строку надо вернуть в активные явно, иначе
        // человек зарегистрируется в аккаунт с состоянием deleted.
        //
        // Данными прошлого владельца это не грозит: удаление их уже стёрло
        // вместе с балансом, связками и паролем. Сюда мы попадаем только
        // когда связок нет — значит аккаунт либо новый, либо удалённый.
        await this.pg.query(
          `UPDATE user_id SET state = 'active', update_date = now()
           WHERE internal_id = $1 AND state <> 'active'`,
          [userId],
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
      this.events?.track('signup_completed', { userId, props: { method: provider } });
      this.events?.track('auth_succeeded', { userId, props: { method: provider, is_new: true } });
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
    // Через процедуру: стартовый бонус — тоже пополнение, и в истории он должен
    // быть видно, иначе у нового юзера баланс возникает из ниоткуда.
    await this.pg.query(
      `SELECT add_user_tokens($1, $2, 'bonus', $3, NULL)`,
      [userId, this.WELCOME_BONUS, 'Приветственный бонус'],
    );
    this.logger.log(`welcome bonus ${this.WELCOME_BONUS} → ${userId}`);
  }

  async linkMethod<P extends Provider>(userId: string, provider: P, data: ProviderData<P>): Promise<{ ok: true } | { ok: false; reason: 'conflict' | 'invalid'; conflictUserId?: string }> {
    if (!this.pg) return { ok: false, reason: 'invalid' };

    const providerSub = this.normalize(provider, data);
    const { email, verified } = this.extractEmail(provider, data);

    const existing = await this.pg.query(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_sub = $2 LIMIT 1`,
      [provider, providerSub],
    );
    if (existing.rows.length) {
      if (existing.rows[0].user_id === userId) return { ok: true };
      return { ok: false, reason: 'conflict', conflictUserId: existing.rows[0].user_id };
    }
    await this.pg.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified, last_used_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [userId, provider, providerSub, email, verified],
    );
    return { ok: true };
  }

  async mergeAccounts(conflictUserId: string, targetUserId: string): Promise<void> {
    if (!this.pg) throw new Error('pg not configured');
    await this.pg.query(
      `UPDATE user_identities SET user_id = $1 WHERE user_id = $2`,
      [targetUserId, conflictUserId],
    );
    await this.pg.query(
      `UPDATE user_id SET state = 'deleted', update_date = now() WHERE internal_id = $1`,
      [conflictUserId],
    );
  }

  /**
   * Записать имя в профиль, если своего там ещё нет.
   *
   * Нужен для входа через Apple: имя приходит ТОЛЬКО при самой первой
   * авторизации и больше никогда — второй раз Apple его не отдаёт ни при
   * каких условиях. Поэтому его надо сохранить сразу.
   *
   * Условие «если пусто» обязательно: у Apple имя можно подставить любое,
   * а человек мог уже указать своё в профиле. Перетирать введённое руками
   * данными провайдера нельзя.
   */
  async setDisplayNameIfEmpty(userId: string, name: string): Promise<void> {
    if (!this.pg) throw new Error('pg not configured');
    const trimmed = name.trim();
    if (!trimmed) return;

    await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = COALESCE(profile_data, '{}'::jsonb) || jsonb_build_object('name', $2::text),
              updated_at = now()
        WHERE user_id = $1
          AND COALESCE(NULLIF(TRIM(profile_data->>'name'), ''), NULL) IS NULL`,
      [userId, trimmed],
    );
  }


  /**
   * Сохранить refresh-токен провайдера.
   *
   * Пока нужен только Apple: без него нечем отозвать доступ при удалении
   * аккаунта, а Apple этого требует. Пишем один раз, при первом входе —
   * authorizationCode обменивается ровно однажды, и повторно токен взять
   * будет неоткуда.
   */
  async saveProviderRefreshToken(
    provider: Provider,
    providerSub: string,
    refreshToken: string,
  ): Promise<void> {
    if (!this.pg) throw new Error('pg not configured');
    await this.pg.query(
      `UPDATE user_identities
          SET provider_refresh_token = $3
        WHERE provider = $1 AND provider_sub = $2`,
      [provider, providerSub, refreshToken],
    );
  }

  /** Все сохранённые refresh-токены пользователя по провайдеру. */
  async providerRefreshTokens(userId: string, provider: Provider): Promise<string[]> {
    if (!this.pg) return [];
    const res = await this.pg.query(
      `SELECT provider_refresh_token FROM user_identities
        WHERE user_id = $1 AND provider = $2 AND provider_refresh_token IS NOT NULL`,
      [userId, provider],
    );
    return res.rows.map((r: any) => r.provider_refresh_token).filter(Boolean);
  }

  async getTokenBalance(userId: string): Promise<number> {
    if (!this.pg) return 0;
    const res = await this.pg.query(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    return Number(res.rows[0]?.tokens ?? 0);
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
