import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgIdentityService } from './tg-identity.service';

@Injectable()
export class TgClaimService {
  private readonly logger = new Logger(TgClaimService.name);

  constructor(
    private readonly pg: PgService,
    private readonly identity: TgIdentityService,
  ) {}

  async claim(
    token: string,
    tgUserId: number,
    tgChatId: number,
    tgChatTitle: string | null,
  ): Promise<{ ownerUserId: string; configId: string; displayName: string }> {
    const tokRes = await this.pg.query(
      `SELECT t.owner_user_id, t.config_id, c.display_name
         FROM tg_claim_tokens t
         LEFT JOIN tg_bot_configs c ON c.id = t.config_id
        WHERE t.token = $1 AND t.kind = 'claim'
          AND t.consumed_at IS NULL AND t.expires_at > now()
        LIMIT 1`,
      [token],
    );
    if (tokRes.rows.length === 0) {
      throw new BadRequestException('invalid or expired claim token');
    }
    const { owner_user_id: ownerId, config_id: configId, display_name: displayName } = tokRes.rows[0];

    const expectedTgUserId = await this.identity.getIdentityByLinkeonId(ownerId);
    if (!expectedTgUserId || expectedTgUserId.tgUserId !== tgUserId) {
      throw new BadRequestException('claim token не принадлежит этому Telegram-аккаунту');
    }

    const conflictRes = await this.pg.query(
      `SELECT id FROM tg_bot_configs
        WHERE tg_chat_id = $1 AND status IN ('active','silent') AND id != $2 LIMIT 1`,
      [tgChatId, configId],
    );
    if (conflictRes.rows.length > 0) {
      throw new ConflictException('эта группа уже привязана к другому аккаунту Linkeon');
    }

    await this.pg.query(
      `UPDATE tg_bot_configs SET tg_chat_id = $1, tg_chat_title = $2, status = 'active'
        WHERE id = $3`,
      [tgChatId, tgChatTitle, configId],
    );
    await this.pg.query(
      `UPDATE tg_claim_tokens SET consumed_at = now() WHERE token = $1`,
      [token],
    );

    return { ownerUserId: ownerId, configId, displayName };
  }
}
