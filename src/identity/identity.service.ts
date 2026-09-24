import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { EventsService } from '../events/events.service';
import type { Provider, ProviderData, Identity, ResolveResult, ResolveOptions } from './identity.types';

/**
 * Файлы схемы, переутверждаемые при каждом старте.
 *
 * Это НЕ история миграций: таблицы schema_migrations здесь нет, каждый файл
 * идемпотентен и накатывается заново на каждом запуске. Поэтому в списке
 * только актуальные утверждения, а не всё, что когда-либо писалось.
 *
 * 002_talerid_provider.sql сюда намеренно не входит. Он перезаписывает
 * констрейнт провайдеров БЕЗ apple, и его целиком заменяет 003. До 25.08.2026
 * загрузчик катал только 001 и выходил, поэтому 002 никогда не исполнялся —
 * apple уцелел лишь потому, что 001 переутверждает констрейнт на каждом старте.
 * Включить 002 в список означало бы впервые запустить заведомо устаревшее
 * утверждение ради того, чтобы следующей строкой его откатить.
 */
export const IDENTITY_MIGRATIONS = [
  '001_identity_init.sql',
  '003_telegram_provider.sql',
];

@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly logger = new Logger(IdentityService.name);
  private readonly WELCOME_BONUS = 25000;

  constructor(
    @Optional() private readonly pg?: PgService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * Билет на незавершённый вход.
   *
   * Выдаётся, когда найден кандидат на привязку. Хранит уже доказанные данные
   * провайдера, чтобы человеку не пришлось заново подтверждать почту, каким бы
   * из двух выходов он ни воспользовался: войти по номеру и привязать или
   * всё-таки завести новый аккаунт.
   *
   * Живёт здесь, а не в контроллере: через кандидата проходят и /auth/oauth/*,
   * и talerid, у которого свой контроллер. Две копии формата билета разъехались
   * бы при первой же правке.
   *
   * Одноразовый, 15 минут.
   */
  async issueLinkTicket(provider: Provider, data: any, candidateUserId: string): Promise<string> {
    if (!this.redis) throw new Error('redis not configured');
    const ticket = crypto.randomBytes(24).toString('base64url');
    await this.redis.set(
      `link-ticket-${ticket}`,
      JSON.stringify({ provider, data, candidateUserId }),
      900,
    );
    return ticket;
  }

  async consumeLinkTicket(ticket?: string): Promise<{ provider: Provider; data: any } | null> {
    if (!this.redis || !ticket) return null;
    const raw = await this.redis.get(`link-ticket-${ticket}`);
    if (!raw) return null;
    await this.redis.del(`link-ticket-${ticket}`);
    const { provider, data } = JSON.parse(raw);
    return { provider, data };
  }

  async onModuleInit() {
    if (!this.pg) return;
    for (const file of IDENTITY_MIGRATIONS) {
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

  async resolveOrCreate<P extends Provider>(
    provider: P,
    data: ProviderData<P>,
    opts: ResolveOptions = {},
  ): Promise<ResolveResult> {
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
      return { status: 'ok', userId, isNew: false, mergedExisting: false };
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
        return { status: 'ok', userId, isNew: false, mergedExisting: true };
      }
    }

    // 2.5) Почта известна аккаунту, но не как способ входа
    //
    // Шаг 2 смотрит только в user_identities. Почта, вписанная человеком в
    // профиль (profile.setEmail → ai_profiles_consolidated.email), туда не
    // попадает — и 19.09.2026 вход по magic link завёл victoria-337@mail.ru
    // второй аккаунт с отдельным приветственным бонусом, при живом первом.
    //
    // Склеивать автоматически нельзя: профильный адрес никем не проверен.
    // Владелец аккаунта может вписать туда чужую почту, и тогда её хозяин по
    // своей же ссылке окажется внутри чужого аккаунта — а тот сохранит к нему
    // доступ по номеру и прочитает всё, что там будет написано. Поэтому здесь
    // мы только останавливаемся и просим подтвердить владение номером.
    if (email && verified && !opts.forceNew) {
      const candidate = await this.findLinkCandidate(email);
      if (candidate) {
        this.events?.track('auth_link_required', {
          userId: candidate.userId,
          props: { method: provider },
        });
        return {
          status: 'link_required',
          candidateUserId: candidate.userId,
          phoneHint: this.maskPhone(candidate.phone),
        };
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
      return { status: 'ok', userId, isNew: true, mergedExisting: false };
    } catch (e: any) {
      await this.pg.query(`ROLLBACK`);
      throw e;
    }
  }

  /**
   * Активный аккаунт, у которого эта почта указана в профиле, но не заведена
   * как способ входа.
   *
   * Требование «в аккаунт есть чем войти» обязательное. У всех email/OAuth
   * аккаунтов есть фиктивная связка provider='phone' с provider_sub, равным
   * их собственному UUID (бэкфилл в 001_identity_init.sql не отличал телефон
   * от UUID и переутверждался на каждом старте). Войти по ней нельзя ничем,
   * и отправить туда человека значило бы запереть его вне обоих аккаунтов —
   * поэтому связка должна быть из одних цифр.
   */
  private async findLinkCandidate(email: string): Promise<{ userId: string; phone: string } | null> {
    if (!this.pg) return null;
    const res = await this.pg.query(
      `SELECT u.internal_id, u.primary_phone
         FROM user_id u
         JOIN ai_profiles_consolidated a ON a.user_id = u.internal_id
        WHERE lower(NULLIF(a.email, '')) = $1
          AND u.state = 'active'
          AND EXISTS (
            SELECT 1 FROM user_identities i
             WHERE i.user_id = u.internal_id
               AND i.provider = 'phone'
               AND i.provider_sub ~ '^[0-9]+$'
          )
        ORDER BY u.create_date
        LIMIT 1`,
      [email],
    );
    const row = res.rows[0];
    return row ? { userId: row.internal_id, phone: row.primary_phone || row.internal_id } : null;
  }

  /** Номер без всего, кроме последних четырёх цифр: узнать свой можно, чужой — нет. */
  private maskPhone(phone: string): string {
    const digits = (phone || '').replace(/\D/g, '');
    return digits.length >= 4 ? `···${digits.slice(-4)}` : '···';
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

  /**
   * Слить аккаунт conflictUserId в targetUserId.
   *
   * Баланс переносится ПЕРВЫМ и именно в таком порядке — сначала начисление на
   * целевой, потом списание с исходного. Транзакции здесь нет по-настоящему:
   * PgService раздаёт соединения из пула, и BEGIN/COMMIT отдельными query()
   * могут уехать на разные соединения. Значит надо выбирать, куда падать при
   * обрыве между шагами, — и падать следует в пользу человека: задвоенный
   * баланс лучше сгоревшего.
   *
   * До 21.09.2026 перенос не делался вовсе: метод помечал аккаунт удалённым,
   * оставляя на нём токены. На проде так осело 47 458 токенов на двух
   * аккаунтах.
   *
   * История чатов НЕ переносится сознательно: session_id собран как
   * `{userId}_{agentId}`, и перенос склеил бы два параллельных разговора с
   * одним ассистентом в одну ленту вперемешку по времени.
   */
  async mergeAccounts(conflictUserId: string, targetUserId: string): Promise<{ survivorUserId: string; loserUserId: string }> {
    if (!this.pg) throw new Error('pg not configured');

    // Выживает СТАРШИЙ аккаунт (по user_id.create_date): в нём обычно больше
    // накопленного. При равных/неизвестных датах выживает targetUserId — тот,
    // под которым человек сейчас залогинен, чтобы зря не менять сессию. Если
    // выжил не target, контроллер выдаст свежий JWT на survivor.
    const dates = await this.pg.query(
      `SELECT internal_id, create_date FROM user_id WHERE internal_id = ANY($1)`,
      [[conflictUserId, targetUserId]],
    );
    const at = (id: string) => {
      const r = dates.rows.find((x: any) => x.internal_id === id);
      return r?.create_date ? new Date(r.create_date).getTime() : null;
    };
    const dc = at(conflictUserId);
    const dt = at(targetUserId);
    const survivorUserId =
      dc != null && dt != null && dc !== dt ? (dc < dt ? conflictUserId : targetUserId) : targetUserId;
    const loserUserId = survivorUserId === conflictUserId ? targetUserId : conflictUserId;
    if (survivorUserId === loserUserId) return { survivorUserId, loserUserId };

    // Баланс: сначала начисление на survivor, потом списание с loser — порядок
    // «падать в пользу человека» (задвоенный баланс лучше сгоревшего), т.к.
    // PgService раздаёт соединения из пула и настоящей транзакции здесь нет.
    // Историю чата НЕ переносим сознательно: session_id = `{userId}_{agentId}`,
    // перенос склеил бы два параллельных разговора с одним ассистентом.
    const bal = await this.pg.query(
      `SELECT COALESCE(tokens, 0) AS tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`,
      [loserUserId],
    );
    const tokens = Number(bal.rows[0]?.tokens ?? 0);
    if (tokens > 0) {
      await this.pg.query(`SELECT add_user_tokens($1, $2, 'adjustment', $3, NULL)`, [
        survivorUserId,
        tokens,
        `Перенос остатка с объединённого аккаунта ${loserUserId}`,
      ]);
      await this.pg.query(`SELECT add_user_tokens($1, $2, 'adjustment', $3, NULL)`, [
        loserUserId,
        -tokens,
        `Перенос остатка на основной аккаунт ${survivorUserId}`,
      ]);
      this.logger.log(`merge: ${tokens} токенов ${loserUserId} → ${survivorUserId}`);
    }

    await this.pg.query(
      `UPDATE user_identities SET user_id = $1 WHERE user_id = $2`,
      [survivorUserId, loserUserId],
    );
    await this.pg.query(
      `UPDATE user_id SET state = 'deleted', update_date = now() WHERE internal_id = $1`,
      [loserUserId],
    );
    return { survivorUserId, loserUserId };
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
