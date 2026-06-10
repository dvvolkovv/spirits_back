import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';

export interface TgBotConfigRow {
  id: string;
  owner_user_id: string;
  tg_chat_id: string | null;
  tg_chat_title: string | null;
  display_name: string;
  preset_agent_id: string | null;
  custom_agent_id: string | null;
  addressing_mode: 'strict' | 'always' | 'smart';
  voice_reply_mode: 'never' | 'mirror' | 'always';
  status: 'pending' | 'active' | 'silent' | 'archived' | 'deleted';
  last_low_balance_dm_at: string | null;
  last_zero_balance_msg_at: string | null;
  last_reply_at: string | null;
  created_at: string;
  archived_at: string | null;
}

@Injectable()
export class TgConfigService {
  private readonly logger = new Logger(TgConfigService.name);
  private readonly CLAIM_TTL_MS = 15 * 60 * 1000;

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
  ) {}

  async createPending(
    ownerId: string,
    data: {
      displayName: string;
      presetAgentId?: string;
      customAgentId?: string;
      addressingMode: 'strict' | 'always' | 'smart';
      voiceReplyMode: 'never' | 'mirror' | 'always';
    },
  ): Promise<{ config: TgBotConfigRow; claimToken: string; deepLink: string }> {
    if (!data.presetAgentId && !data.customAgentId) {
      throw new BadRequestException('either presetAgentId or customAgentId required');
    }
    if (data.presetAgentId && data.customAgentId) {
      throw new BadRequestException('only one of presetAgentId/customAgentId');
    }
    // Security: if customAgentId is provided, verify it belongs to this owner
    if (data.customAgentId) {
      const own = await this.pg.query(
        `SELECT 1 FROM custom_agents WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
        [data.customAgentId, ownerId],
      );
      if (own.rows.length === 0) {
        throw new BadRequestException('custom agent not found or not owned by user');
      }
    }
    const cfgRes = await this.pg.query(
      `INSERT INTO tg_bot_configs (
         owner_user_id, display_name, preset_agent_id, custom_agent_id,
         addressing_mode, voice_reply_mode, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [
        ownerId,
        data.displayName.trim(),
        data.presetAgentId ?? null,
        data.customAgentId ?? null,
        data.addressingMode,
        data.voiceReplyMode,
      ],
    );
    const config: TgBotConfigRow = cfgRes.rows[0];

    const expires = new Date(Date.now() + this.CLAIM_TTL_MS);
    const tokRes = await this.pg.query(
      `INSERT INTO tg_claim_tokens (kind, owner_user_id, config_id, expires_at)
       VALUES ('claim', $1, $2, $3)
       RETURNING token`,
      [ownerId, config.id, expires],
    );
    const claimToken = tokRes.rows[0].token;

    const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
    const deepLink = `https://t.me/${botUsername}?startgroup=${claimToken}`;

    return { config, claimToken, deepLink };
  }

  async listForOwner(ownerId: string): Promise<TgBotConfigRow[]> {
    const r = await this.pg.query(
      `SELECT * FROM tg_bot_configs
        WHERE owner_user_id = $1 AND status != 'deleted'
        ORDER BY created_at DESC`,
      [ownerId],
    );
    return r.rows;
  }

  async getById(id: string, ownerId: string): Promise<TgBotConfigRow> {
    const r = await this.pg.query(
      `SELECT * FROM tg_bot_configs WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
      [id, ownerId],
    );
    if (r.rows.length === 0) throw new NotFoundException(`config ${id} not found`);
    return r.rows[0];
  }

  async update(
    id: string,
    ownerId: string,
    patch: {
      displayName?: string;
      presetAgentId?: string;
      customAgentId?: string;
      addressingMode?: 'strict' | 'always' | 'smart';
      voiceReplyMode?: 'never' | 'mirror' | 'always';
    },
  ): Promise<TgBotConfigRow> {
    await this.getById(id, ownerId);
    if (patch.customAgentId) {
      const own = await this.pg.query(
        `SELECT 1 FROM custom_agents WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
        [patch.customAgentId, ownerId],
      );
      if (own.rows.length === 0) {
        throw new BadRequestException('custom agent not found or not owned by user');
      }
    }
    const fields: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (patch.displayName !== undefined) { fields.push(`display_name = $${idx++}`); params.push(patch.displayName.trim()); }
    if (patch.presetAgentId !== undefined) {
      fields.push(`preset_agent_id = $${idx++}`); params.push(patch.presetAgentId || null);
      fields.push(`custom_agent_id = NULL`);
    }
    if (patch.customAgentId !== undefined) {
      fields.push(`custom_agent_id = $${idx++}`); params.push(patch.customAgentId || null);
      fields.push(`preset_agent_id = NULL`);
    }
    if (patch.addressingMode !== undefined) { fields.push(`addressing_mode = $${idx++}`); params.push(patch.addressingMode); }
    if (patch.voiceReplyMode !== undefined) { fields.push(`voice_reply_mode = $${idx++}`); params.push(patch.voiceReplyMode); }
    if (fields.length === 0) return this.getById(id, ownerId);
    params.push(id, ownerId);
    const r = await this.pg.query(
      `UPDATE tg_bot_configs SET ${fields.join(', ')} WHERE id = $${idx++} AND owner_user_id = $${idx} RETURNING *`,
      params,
    );
    return r.rows[0];
  }

  async archive(id: string, ownerId: string): Promise<void> {
    const cfg = await this.getById(id, ownerId);
    if (cfg.tg_chat_id && ['active', 'silent'].includes(cfg.status)) {
      try {
        await this.grammy.leaveChat(Number(cfg.tg_chat_id));
      } catch (e: any) {
        this.logger.warn(`leaveChat failed for ${cfg.tg_chat_id}: ${e.message}`);
      }
    }
    await this.pg.query(
      `UPDATE tg_bot_configs SET status = 'archived', archived_at = now() WHERE id = $1`,
      [id],
    );
  }

  async getActiveByTgChatId(tgChatId: number): Promise<TgBotConfigRow | null> {
    const r = await this.pg.query(
      `SELECT * FROM tg_bot_configs WHERE tg_chat_id = $1 AND status IN ('active','silent') LIMIT 1`,
      [tgChatId],
    );
    return r.rows[0] ?? null;
  }

  async getMessagesForConfig(configId: string, ownerId: string, limit: number = 50): Promise<any[]> {
    await this.getById(configId, ownerId);
    const r = await this.pg.query(
      `SELECT id, tg_user_id, tg_user_name, role, content, content_type, tokens_charged, created_at
         FROM tg_bot_messages
        WHERE config_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [configId, limit],
    );
    return r.rows;
  }
}
