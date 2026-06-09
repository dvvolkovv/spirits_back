import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { TgIdentityService } from './tg-identity.service';
import { TgClaimService } from './tg-claim.service';
import { TgConfigService } from './tg-config.service';
import { TgRouterService } from './tg-router.service';
import { TgVoiceService } from './tg-voice.service';
import { TgBillingService } from './tg-billing.service';
import { TgCommandsService } from './tg-commands.service';
import { TgGrammyClient } from './tg-grammy.client';

@Injectable()
export class TgBotService implements OnModuleInit {
  private readonly logger = new Logger(TgBotService.name);

  constructor(
    private readonly pg: PgService,
    private readonly identity: TgIdentityService,
    private readonly claim: TgClaimService,
    private readonly configs: TgConfigService,
    private readonly router: TgRouterService,
    private readonly voice: TgVoiceService,
    private readonly billing: TgBillingService,
    private readonly commands: TgCommandsService,
    private readonly grammy: TgGrammyClient,
  ) {}

  async onModuleInit() {
    await this.applyMigration('001_tg_bot_schema.sql');
    await this.applyMigration('002_tg_bot_custom_agent_fk.sql');
  }

  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'tg-bot', 'migrations', filename),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`tg-bot migration ${filename} applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`tg-bot migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn(`tg-bot migration ${filename} not found, skipping`);
  }

  async handleUpdate(update: any): Promise<void> {
    try {
      const msg = update.message ?? update.edited_message;
      if (msg) {
        await this.handleMessage(msg);
        return;
      }
      if (update.my_chat_member) {
        await this.handleMyChatMember(update.my_chat_member);
        return;
      }
    } catch (e: any) {
      this.logger.error(`handleUpdate failed: ${e.message}\n${e.stack}`);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.from?.is_bot) return;
    if (msg.new_chat_members || msg.left_chat_member || msg.pinned_message) return;

    const chatType = msg.chat?.type;

    // В группах Telegram добавляет к командам @<botname>: `/start@LinkeonTestBot <token>`.
    // В личке — без суффикса. Парсим оба формата.
    const startToken = typeof msg.text === 'string' ? this.parseStartToken(msg.text) : null;

    if (chatType === 'private' && startToken) {
      await this.handleDmStart(msg, startToken);
      return;
    }

    if (chatType === 'private' && (msg.text === '/start' || msg.text?.startsWith('/start@'))) {
      await this.grammy.sendMessage(
        msg.chat.id,
        'Привет! Для подключения зайди в Linkeon и нажми «Подключить Telegram».',
      );
      return;
    }

    if (chatType === 'channel') {
      try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
      return;
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      if (startToken) {
        await this.handleGroupClaim(msg, startToken);
        return;
      }
      await this.handleGroupMessage(msg);
      return;
    }
  }

  // Парсит `/start <token>` и `/start@<botname> <token>`. Возвращает токен или null.
  private parseStartToken(text: string): string | null {
    const m = text.match(/^\/start(?:@\S+)?\s+(\S+)/);
    return m ? m[1] : null;
  }

  private async handleDmStart(msg: any, token: string): Promise<void> {
    try {
      const ownerId = await this.identity.consumeAuthToken(
        token,
        msg.from.id,
        msg.from.username ?? null,
        msg.from.first_name ?? null,
      );
      await this.grammy.sendMessage(
        msg.chat.id,
        `Привет, ${msg.from.first_name}! Твой Telegram привязан к Linkeon. Теперь возвращайся в кабинет и создавай ботов для групп.`,
      );
      this.logger.log(`identity bound: linkeon=${ownerId} tg=${msg.from.id}`);
    } catch (e: any) {
      await this.grammy.sendMessage(
        msg.chat.id,
        `Не получилось привязать: ${e.message}. Сгенерируй новую ссылку в Linkeon (старая могла истечь — TTL 15 минут).`,
      );
    }
  }

  private async handleGroupClaim(msg: any, token: string): Promise<void> {
    try {
      const result = await this.claim.claim(
        token,
        msg.from.id,
        msg.chat.id,
        msg.chat.title ?? null,
      );
      const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
      await this.grammy.sendMessage(
        msg.chat.id,
        `Я ${result.displayName}. Зови меня @${botUsername} или ответом на это сообщение.`,
      );
      this.logger.log(`config ${result.configId} activated for chat ${msg.chat.id}`);
    } catch (e: any) {
      const ownerTgId = msg.from.id;
      try {
        await this.grammy.sendMessage(ownerTgId, `Не получилось привязать бота: ${e.message}`);
      } catch { /* ignore */ }
      this.logger.warn(`claim failed for chat ${msg.chat.id}: ${e.message}`);
      try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
    }
  }

  private async handleGroupMessage(msg: any): Promise<void> {
    const cfg = await this.configs.getActiveByTgChatId(msg.chat.id);
    if (!cfg) return;

    const isVoice = !!(msg.voice || msg.audio);
    let workingText: string = msg.text ?? msg.caption ?? '';
    let actualIsVoice = false;
    let voiceFileId: string | undefined;

    if (isVoice) {
      voiceFileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (!voiceFileId) return;
      try {
        workingText = await this.voice.transcribe(voiceFileId);
        actualIsVoice = true;
        this.logger.log(`voice transcribed in chat ${msg.chat.id}: "${workingText.substring(0, 50)}..."`);
      } catch (e: any) {
        this.logger.warn(`STT failed for chat ${msg.chat.id}: ${e.message}`);
        return;
      }
    }

    if (!workingText) return;

    // Pre-flight: balance check. При 0 — однократное сообщение в группе.
    const preBalance = await this.billing.getBalance(cfg.owner_user_id);
    if (preBalance <= 0) {
      const notified = await this.billing.hasZeroBalanceFlag(cfg.id);
      if (!notified) {
        try {
          await this.grammy.sendMessage(
            msg.chat.id,
            `У владельца закончились токены. Пополнить: https://my.linkeon.io/tokens`,
          );
          await this.billing.markZeroBalanceNotified(cfg.id);
        } catch { /* ignore */ }
      }
      return;
    }

    const botUserId = await this.grammy.getBotUserId();
    const ctx = {
      chatId: msg.chat.id,
      msgId: msg.message_id,
      fromTgUserId: msg.from.id,
      fromTgUserName: msg.from.first_name ?? msg.from.username ?? null,
      text: workingText,
      replyToBotMessageId: msg.reply_to_message?.message_id,
      replyToFromBot: msg.reply_to_message?.from?.id === botUserId,
      isVoice: actualIsVoice,
      voiceFileId,
    };

    const lockId = this.hashLock(`tg-chat:${msg.chat.id}`);
    const lockRes = await this.pg.query(`SELECT pg_try_advisory_lock($1)`, [lockId]);
    if (!lockRes.rows[0].pg_try_advisory_lock) {
      this.logger.debug(`chat ${msg.chat.id} busy, skipping`);
      return;
    }

    try {
      await this.router.persistUserMessage(cfg, ctx);

      // Phase 8: handle slash-commands (/help /balance /silent /resume) ДО LLM-вызова.
      // tryHandle вернёт true если это была команда — в таком случае биллинг не запускаем.
      const handled = await this.commands.tryHandle(cfg, msg);
      if (handled) return;

      const should = await this.router.shouldRespond(cfg, ctx);
      if (!should) return;

      const ownerRes = await this.pg.query(
        `SELECT profile_data->>'name' AS first_name FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const ownerFirstName = ownerRes.rows[0]?.first_name ?? 'Linkeon-пользователь';

      const reply = await this.router.generateReply(cfg, ownerFirstName);

      // Voice reply policy
      const wantsVoice =
        cfg.voice_reply_mode === 'always' ||
        (cfg.voice_reply_mode === 'mirror' && actualIsVoice);

      let contentType: 'text' | 'voice_reply' = 'text';
      let voiceTtsCostUsd = 0;

      if (wantsVoice) {
        try {
          const tts = await this.voice.synthesize(reply.text);
          voiceTtsCostUsd = tts.costUsd;
          await this.grammy.sendVoice(msg.chat.id, tts.buffer, {
            reply_to_message_id: msg.message_id,
            caption: reply.text.substring(0, 1024),
          });
          contentType = 'voice_reply';
        } catch (e: any) {
          this.logger.warn(`TTS failed for chat ${msg.chat.id}, fallback to text: ${e.message}`);
          await this.grammy.sendMessage(msg.chat.id, reply.text, {
            reply_to_message_id: msg.message_id,
          });
        }
      } else {
        await this.grammy.sendMessage(msg.chat.id, reply.text, {
          reply_to_message_id: msg.message_id,
        });
      }

      const totalCostUsd = reply.costUsd + voiceTtsCostUsd;
      const tokensCharged = this.billing.tokensFromUsd(totalCostUsd);
      const newBalance = await this.billing.deduct(cfg.owner_user_id, tokensCharged);
      this.logger.log(
        `tg-bot billing: config=${cfg.id} cost=$${totalCostUsd.toFixed(5)} deducted=${tokensCharged} balance=${newBalance}`,
      );
      // При успешном списании > 0 — сбрасываем flag, чтобы при следующем падении в 0 снова срабатывало однократное сообщение
      if (newBalance > 0) {
        await this.billing.clearZeroBalanceFlag(cfg.id);
      }
      await this.router.persistAssistantReply(cfg, reply.text, contentType, tokensCharged);

      // DM-alert при низком балансе (post-deduct)
      const ownerTg = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
      await this.billing.checkBalanceAlerts(cfg.id, cfg.owner_user_id, ownerTg?.tgUserId ?? null);
    } finally {
      await this.pg.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
    }
  }

  /**
   * Bot kicked/left from a chat — archive the config + DM owner.
   * Telegram sends `my_chat_member` update with new_status='left'/'kicked' (also 'banned').
   */
  private async handleMyChatMember(event: any): Promise<void> {
    const newStatus = event.new_chat_member?.status;
    if (!['left', 'kicked', 'banned'].includes(newStatus)) return;

    const cfg = await this.configs.getActiveByTgChatId(event.chat.id);
    if (!cfg) return;

    await this.pg.query(
      `UPDATE tg_bot_configs SET status = 'archived', archived_at = now() WHERE id = $1`,
      [cfg.id],
    );
    this.logger.log(`config ${cfg.id} archived — bot ${newStatus} from chat ${event.chat.id}`);

    // DM owner (silent failure ok — owner may not have started DM with bot)
    const ownerTg = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
    if (ownerTg) {
      try {
        await this.grammy.sendMessage(
          ownerTg.tgUserId,
          `Бот «${cfg.display_name}» удалён из «${cfg.tg_chat_title ?? 'группы'}». Конфигурация архивирована — её можно восстановить в кабинете.`,
        );
      } catch { /* ignore */ }
    }
  }

  // hashtext-эквивалент: 32-битный знаковый int для pg_advisory_lock
  private hashLock(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return h;
  }
}
