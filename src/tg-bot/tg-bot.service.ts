import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { TgIdentityService } from './tg-identity.service';
import { TgClaimService } from './tg-claim.service';
import { TgConfigService } from './tg-config.service';
import { TgRouterService } from './tg-router.service';
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
    private readonly grammy: TgGrammyClient,
  ) {}

  async onModuleInit() {
    await this.applyMigration('001_tg_bot_schema.sql');
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
    } catch (e: any) {
      this.logger.error(`handleUpdate failed: ${e.message}\n${e.stack}`);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.from?.is_bot) return;
    if (msg.new_chat_members || msg.left_chat_member || msg.pinned_message) return;

    const chatType = msg.chat?.type;

    if (chatType === 'private' && typeof msg.text === 'string' && msg.text.startsWith('/start ')) {
      const token = msg.text.substring('/start '.length).trim();
      await this.handleDmStart(msg, token);
      return;
    }

    if (chatType === 'private' && msg.text === '/start') {
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
      if (typeof msg.text === 'string' && msg.text.startsWith('/start ')) {
        const token = msg.text.substring('/start '.length).trim();
        await this.handleGroupClaim(msg, token);
        return;
      }
      await this.handleGroupMessage(msg);
      return;
    }
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
    if (!cfg) return;  // нет активного конфига (бот в группе без claim'а)

    const isVoice = !!(msg.voice || msg.audio);
    const text = msg.text ?? msg.caption ?? '';

    // Voice — Phase 6 добавит STT. Пока пропускаем.
    if (isVoice) {
      this.logger.debug(`voice in chat ${msg.chat.id} — STT not implemented yet`);
      return;
    }

    if (!text) return;  // ни текста ни voice

    const botUserId = await this.grammy.getBotUserId();
    const ctx = {
      chatId: msg.chat.id,
      msgId: msg.message_id,
      fromTgUserId: msg.from.id,
      fromTgUserName: msg.from.first_name ?? msg.from.username ?? null,
      text,
      replyToBotMessageId: msg.reply_to_message?.message_id,
      replyToFromBot: msg.reply_to_message?.from?.id === botUserId,
      isVoice: false,
    };

    // Per-chat advisory lock — последовательная обработка
    const lockId = this.hashLock(`tg-chat:${msg.chat.id}`);
    const lockRes = await this.pg.query(`SELECT pg_try_advisory_lock($1)`, [lockId]);
    if (!lockRes.rows[0].pg_try_advisory_lock) {
      this.logger.debug(`chat ${msg.chat.id} busy, skipping`);
      return;
    }

    try {
      await this.router.persistUserMessage(cfg, ctx);

      const should = await this.router.shouldRespond(cfg, ctx);
      if (!should) return;

      // Phase 8 добавит handling команд (/help, /balance, /silent, /resume) до LLM-вызова

      // Имя владельца берём из ai_profiles_consolidated.profile_data->>'name'
      const ownerRes = await this.pg.query(
        `SELECT profile_data->>'name' AS first_name FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const ownerFirstName = ownerRes.rows[0]?.first_name ?? 'Linkeon-пользователь';

      const reply = await this.router.generateReply(cfg, ownerFirstName);
      await this.grammy.sendMessage(msg.chat.id, reply.text, {
        reply_to_message_id: msg.message_id,
      });

      // Phase 7 включит реальный billing. Пока tokensCharged = 0.
      await this.router.persistAssistantReply(cfg, reply.text, 'text', 0);
    } finally {
      await this.pg.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
    }
  }

  // hashtext-эквивалент: 32-битный знаковый int для pg_advisory_lock
  private hashLock(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return h;
  }
}
