import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Bot, InputFile } from 'grammy';

@Injectable()
export class TgGrammyClient implements OnModuleInit {
  private readonly logger = new Logger(TgGrammyClient.name);
  private bot!: Bot;
  private cachedMeId: number | null = null;

  async onModuleInit() {
    const token = process.env.TG_BOT_TOKEN;
    if (!token) {
      this.logger.warn('TG_BOT_TOKEN not set — Telegram bot disabled');
      return;
    }
    this.bot = new Bot(token);

    // Register webhook — idempotent
    const baseUrl = process.env.TG_WEBHOOK_BASE_URL || 'https://my.linkeon.io';
    const urlSecret = process.env.TG_WEBHOOK_URL_SECRET;
    const headerSecret = process.env.TG_WEBHOOK_HEADER_SECRET;
    if (!urlSecret || !headerSecret) {
      this.logger.error('TG_WEBHOOK_URL_SECRET or TG_WEBHOOK_HEADER_SECRET missing — webhook not registered');
      return;
    }
    const webhookUrl = `${baseUrl}/webhook/telegram/${urlSecret}`;
    try {
      await this.bot.api.setWebhook(webhookUrl, {
        secret_token: headerSecret,
        allowed_updates: ['message', 'edited_message', 'my_chat_member', 'callback_query'],
        drop_pending_updates: false,
      });
      this.logger.log(`Telegram webhook set: ${webhookUrl}`);
    } catch (e: any) {
      this.logger.error(`setWebhook failed: ${e.message}`);
    }
  }

  async sendMessage(chatId: number, text: string, options: any = {}) {
    return this.bot.api.sendMessage(chatId, text, options);
  }

  async sendVoice(chatId: number, voice: Buffer, options: any = {}) {
    return this.bot.api.sendVoice(chatId, new InputFile(voice), options);
  }

  async sendPhoto(chatId: number, photo: Buffer | string, options: any = {}) {
    // photo может быть Buffer (загруженный файл) или URL/file_id (строка).
    const input = typeof photo === 'string' ? photo : new InputFile(photo);
    return this.bot.api.sendPhoto(chatId, input as any, options);
  }

  async sendDocument(chatId: number, doc: Buffer | string, filename: string | undefined, options: any = {}) {
    const input = typeof doc === 'string'
      ? doc
      : new InputFile(doc, filename);
    return this.bot.api.sendDocument(chatId, input as any, options);
  }

  async leaveChat(chatId: number) {
    return this.bot.api.leaveChat(chatId);
  }

  async getFile(fileId: string) {
    return this.bot.api.getFile(fileId);
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const token = process.env.TG_BOT_TOKEN!;
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const resp = await fetch(url);
    return Buffer.from(await resp.arrayBuffer());
  }

  async getBotUserId(): Promise<number> {
    if (this.cachedMeId !== null) return this.cachedMeId;
    const me = await this.bot.api.getMe();
    this.cachedMeId = me.id;
    return me.id;
  }

  getBot(): Bot {
    return this.bot;
  }
}
