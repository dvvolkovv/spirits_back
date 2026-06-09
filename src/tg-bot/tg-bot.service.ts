import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { TgIdentityService } from './tg-identity.service';
import { TgGrammyClient } from './tg-grammy.client';

@Injectable()
export class TgBotService implements OnModuleInit {
  private readonly logger = new Logger(TgBotService.name);

  constructor(
    private readonly pg: PgService,
    private readonly identity: TgIdentityService,
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
      // my_chat_member will be handled in Phase 9
    } catch (e: any) {
      this.logger.error(`handleUpdate failed: ${e.message}\n${e.stack}`);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    // Защиты от петель и сервисных сообщений
    if (msg.from?.is_bot) return;
    if (msg.new_chat_members || msg.left_chat_member || msg.pinned_message) return;

    const chatType = msg.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'

    // DM with /start AUTH_TOKEN — identity binding
    if (chatType === 'private' && typeof msg.text === 'string' && msg.text.startsWith('/start ')) {
      const token = msg.text.substring('/start '.length).trim();
      await this.handleDmStart(msg, token);
      return;
    }

    // DM plain /start without arguments
    if (chatType === 'private' && msg.text === '/start') {
      await this.grammy.sendMessage(
        msg.chat.id,
        'Привет! Для подключения зайди в Linkeon и нажми «Подключить Telegram».',
      );
      return;
    }

    // Channels — not supported
    if (chatType === 'channel') {
      try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
      return;
    }

    // Group/supergroup handling will be added in Phase 3+ (claim) and Phase 4+ (router)
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
}
