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

  // Перевыпуск claim-токена для существующего конфига (pending/archived).
  // Кейс: бот вышел из группы (протухший claim, кик) — юзер переподключает
  // тот же конфиг свежей ссылкой вместо создания нового.
  async reissueClaim(
    id: string,
    ownerId: string,
  ): Promise<{ config: TgBotConfigRow; claimToken: string; deepLink: string }> {
    const cfg = await this.getById(id, ownerId);
    if (!['pending', 'archived'].includes(cfg.status)) {
      throw new BadRequestException(
        `reissue доступен только для pending/archived конфигов (сейчас: ${cfg.status})`,
      );
    }

    // Статус — в самом UPDATE: проверка выше читала его без блокировки, и
    // привязка, успевшая между ними, иначе была бы стёрта (бот поздоровался
    // в группе, а конфиг снова pending без чата). Прежние ссылки НЕ гасим:
    // бота по второй ссылке и так не перенести (привязка — только из pending
    // и только владельцем), а честно открытая минуту назад ссылка стала бы
    // «просроченной».
    const updRes = await this.pg.query(
      `UPDATE tg_bot_configs
          SET status = 'pending', tg_chat_id = NULL, tg_chat_title = NULL, archived_at = NULL
        WHERE id = $1 AND status IN ('pending', 'archived')
        RETURNING *`,
      [id],
    );
    if (updRes.rows.length === 0) {
      throw new BadRequestException('reissue доступен только для pending/archived конфигов');
    }
    const config: TgBotConfigRow = updRes.rows[0];

    const expires = new Date(Date.now() + this.CLAIM_TTL_MS);
    const tokRes = await this.pg.query(
      `INSERT INTO tg_claim_tokens (kind, owner_user_id, config_id, expires_at)
       VALUES ('claim', $1, $2, $3)
       RETURNING token`,
      [ownerId, id, expires],
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

  /**
   * Группа стала супергруппой (migrate_to_chat_id): у неё новый id. Конфиг и
   * его история переезжают — иначе бот в новой супергруппе молчит, а
   * мониторинг молчания ищет ответ не в том чате. Идемпотентно: второе
   * служебное сообщение (migrate_from_chat_id) старого id уже не найдёт.
   */
  async moveToChat(fromChatId: number, toChatId: number): Promise<void> {
    try {
      // Одним запросом: упади между двумя UPDATE — история навсегда осталась
      // бы на старом id (второе служебное сообщение конфиг уже не найдёт).
      // Переезжает ВСЯ история чата, а не только этого конфига: «писал ли
      // здесь кто-то, кроме владельца» (isSoloChat, onlySpeakerIs) смотрит на
      // tg_chat_id, и реплики прежних ботов, оставшись на старом id, дали бы
      // в новой супергруппе ложное «пишет один владелец». Ждущие видео — туда
      // же, иначе доставка уйдёт в мёртвый чат; ответ на сообщение старой
      // группы сбрасываем — в супергруппе своя нумерация сообщений.
      const moved = await this.pg.query(
        `WITH moved AS (
           UPDATE tg_bot_configs SET tg_chat_id = $2
            WHERE tg_chat_id = $1 AND status IN ('active','silent')
            RETURNING id
         ), msgs AS (
           UPDATE tg_bot_messages SET tg_chat_id = $2
            WHERE tg_chat_id = $1 AND EXISTS (SELECT 1 FROM moved)
         ), vids AS (
           UPDATE tg_bot_video_jobs SET tg_chat_id = $2, tg_reply_to_message_id = NULL
            WHERE tg_chat_id = $1 AND delivery_status = 'pending' AND EXISTS (SELECT 1 FROM moved)
         )
         SELECT id FROM moved`,
        [fromChatId, toChatId],
      );
      const id = moved.rows[0]?.id;
      if (!id) return;
      this.logger.log(`config ${id}: группа ${fromChatId} стала супергруппой ${toChatId}`);
    } catch (e: any) {
      // На новом id уже стоит свой бот (уникальный индекс по активным
      // чатам) — переезжать некуда. Остальную обработку апдейта не роняем.
      this.logger.warn(`moveToChat ${fromChatId} → ${toChatId} failed: ${e?.message}`);
    }
  }

  async getActiveByTgChatId(tgChatId: number): Promise<TgBotConfigRow | null> {
    const r = await this.pg.query(
      `SELECT * FROM tg_bot_configs WHERE tg_chat_id = $1 AND status IN ('active','silent') LIMIT 1`,
      [tgChatId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Конфиг для личного чата: находит активный или заводит новый.
   *
   * preset_agent_id заполняется текущим ассистентом владельца только ради
   * констрейнта tg_bot_configs_check (строка без ассистента запрещена). Для
   * приватных конфигов это поле инертно — кто отвечает, решает
   * resolveSystemPrompt по preferred_agent. Специально НЕ обновляем его при
   * переключении: см. комментарий там же.
   *
   * addressing_mode='always' — в личке отвечать на каждое сообщение; strict
   * потребовал бы обращения по имени, что в диалоге один на один абсурдно.
   */
  async ensurePrivateConfig(ownerId: string, tgChatId: number): Promise<TgBotConfigRow> {
    const existing = await this.pg.query(
      `SELECT * FROM tg_bot_configs
        WHERE tg_chat_id = $1 AND status IN ('active','silent')
        LIMIT 1`,
      [tgChatId],
    );
    const found = existing.rows[0];
    if (found?.status === 'silent') {
      // Личку глушил только прежний /silent в личке (до 14.10.2026): веб такого
      // статуса не ставит, групповой /silent до лички не доходит. Не будить —
      // значит молчать человеку один на один, пока он не догадается про /resume.
      const woke = await this.pg.query(
        `UPDATE tg_bot_configs SET status = 'active' WHERE id = $1 AND status = 'silent' RETURNING *`,
        [found.id],
      );
      return woke.rows[0] ?? { ...found, status: 'active' };
    }
    if (found) return found;

    const prof = await this.pg.query(
      `SELECT preferred_agent FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerId],
    );
    let agentId = '12';
    const preferred = prof.rows[0]?.preferred_agent;
    if (preferred) {
      const a = await this.pg.query(`SELECT id FROM agents WHERE name = $1 LIMIT 1`, [preferred]);
      if (a.rows[0]) agentId = String(a.rows[0].id);
    }

    const created = await this.pg.query(
      `INSERT INTO tg_bot_configs (
         owner_user_id, tg_chat_id, display_name, preset_agent_id,
         addressing_mode, voice_reply_mode, status
       ) VALUES ($1, $2, $3, $4, $5, 'mirror', 'active')
       RETURNING *`,
      [ownerId, tgChatId, 'Linkeon', agentId, 'always'],
    );
    this.logger.log(`создан приватный конфиг для чата ${tgChatId} (владелец ${ownerId})`);
    return created.rows[0];
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
