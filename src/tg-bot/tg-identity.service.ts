import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

/**
 * Telegram, из которого пришли, уже принадлежит другому аккаунту Linkeon.
 *
 * Отдельный тип, потому что вызывающий код обязан отличать этот случай от
 * протухшего токена: совет «сгенерируй новую ссылку» здесь бесполезен — новая
 * упрётся в то же ограничение (жалоба владельца 22.08.2026, @nomira_ai был
 * привязан к другому аккаунту с 10 июня).
 */
export class TgIdentityConflictError extends Error {
  constructor(readonly tgUserId: number, readonly tgUsername: string | null) {
    super('telegram already bound to another linkeon account');
    this.name = 'TgIdentityConflictError';
  }
}

@Injectable()
export class TgIdentityService {
  private readonly logger = new Logger(TgIdentityService.name);
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000;

  constructor(private readonly pg: PgService) {}

  async createAuthToken(ownerId: string): Promise<string> {
    // Новая ссылка гасит прежние: старая, утёкшая или пересланная, иначе
    // ещё 15 минут привязывала бы к аккаунту владельца ЛЮБОЙ Telegram — а с
    // ним и инструмент продуктов в его чатах. Мастер выдаёт новую ссылку по
    // кнопке, так что «получить новую» заодно значит «отозвать старую».
    await this.pg.query(
      `UPDATE tg_claim_tokens SET consumed_at = now()
        WHERE owner_user_id = $1 AND kind = 'auth' AND consumed_at IS NULL`,
      [ownerId],
    );
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
    // Всё одной транзакцией. Раньше токен гасился ДО вставки: при конфликте по
    // tg_user_id привязка падала, а ссылка была уже сожжена — пользователю
    // советовали сгенерировать новую, и она умирала так же.
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT owner_user_id FROM tg_claim_tokens
          WHERE token = $1 AND kind = 'auth' AND consumed_at IS NULL AND expires_at > now()
            AND EXISTS (
              SELECT 1 FROM user_id u
              WHERE u.internal_id=tg_claim_tokens.owner_user_id AND u.state='active'
            )
          LIMIT 1
          FOR UPDATE`,
        [token],
      );
      if (r.rows.length === 0) {
        throw new BadRequestException('invalid or expired auth token');
      }
      const ownerId = r.rows[0].owner_user_id;
      const ownerLock = await client.query(
        `SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active' FOR UPDATE`,
        [ownerId],
      );
      if (ownerLock.rows.length === 0) {
        throw new BadRequestException('invalid or expired auth token');
      }
      const consumed = await client.query(
        `UPDATE tg_claim_tokens t SET consumed_at=now()
         WHERE t.token=$1 AND t.consumed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM user_id u
             WHERE u.internal_id=t.owner_user_id AND u.state='active'
           )`,
        [token],
      );
      if (consumed.rowCount !== 1) {
        throw new BadRequestException('invalid or expired auth token');
      }
      try {
        const linked = await client.query(
          `INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id, tg_username, tg_first_name)
           SELECT $1, $2, $3, $4
           WHERE EXISTS (
             SELECT 1 FROM user_id u WHERE u.internal_id=$1 AND u.state='active'
           )
           ON CONFLICT (linkeon_user_id) DO UPDATE SET
             tg_user_id = EXCLUDED.tg_user_id,
             tg_username = EXCLUDED.tg_username,
             tg_first_name = EXCLUDED.tg_first_name`,
          [ownerId, tgUserId, tgUsername, tgFirstName],
        );
        if (linked.rowCount !== 1) {
          throw new BadRequestException('invalid or expired auth token');
        }
      } catch (e: any) {
        // ON CONFLICT закрывает только linkeon_user_id, поэтому 23505 здесь —
        // это UNIQUE на tg_user_id: Telegram занят другим аккаунтом Linkeon.
        if (e?.code === '23505') throw new TgIdentityConflictError(tgUserId, tgUsername);
        throw e;
      }
      await client.query('COMMIT');
      return ownerId;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
