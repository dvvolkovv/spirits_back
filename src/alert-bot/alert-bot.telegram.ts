import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { sendTelegramAlert } from '../common/telegram-alert';
import { splitForTelegram } from '../tg-bot/tg-text-split';

@Injectable()
export class AlertBotTelegram {
  private readonly logger = new Logger(AlertBotTelegram.name);
  private identity: { id: number; username: string } | null = null;

  private async call(method: string, payload: Record<string, unknown> = {}): Promise<any> {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) throw new Error('telegram token missing');
    try {
      const r = await axios.post(`https://api.telegram.org/bot${token}/${method}`, payload, { timeout: 8000 });
      if (!r.data?.ok) throw new Error('telegram returned not ok');
      return r.data.result;
    } catch (e: any) {
      const why = e?.response?.data?.description || e?.code || 'request failed';
      throw new Error(`telegram ${method}: ${why}`);
    }
  }
  async getMe(): Promise<{ id: number; username: string }> {
    if (!this.identity) {
      const me = await this.call('getMe');
      this.identity = { id: me.id, username: me.username };
    }
    return this.identity;
  }
  getWebhookInfo(): Promise<{ url?: string }> { return this.call('getWebhookInfo'); }
  sendMessage(chatId: string, text: string, replyTo?: number, replyMarkup?: unknown): Promise<{ message_id: number }> {
    return this.call('sendMessage', {
      chat_id: chatId, text,
      ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      link_preview_options: { is_disabled: true },
    });
  }
  editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: unknown): Promise<void> {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      link_preview_options: { is_disabled: true },
    });
  }
  answerCallbackQuery(id: string, text: string): Promise<void> {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }
  async sendChunks(chatId: string, text: string, firstMessageId: number, replyTo: number, replyMarkup?: unknown): Promise<number[]> {
    const chunks = splitForTelegram(text);
    if (!chunks.length) {
      await this.editMessageText(chatId, firstMessageId, 'Модель вернула пустой ответ');
      return [firstMessageId];
    }
    await this.editMessageText(chatId, firstMessageId, chunks[0], replyMarkup);
    const messageIds = [firstMessageId];
    for (const chunk of chunks.slice(1)) {
      const continuation = await this.sendMessage(chatId, chunk, replyTo);
      messageIds.push(continuation.message_id);
    }
    return messageIds;
  }
  async registerWebhook(): Promise<void> {
    const url = process.env.ALERT_BOT_WEBHOOK_URL || '';
    const secret = process.env.ALERT_BOT_WEBHOOK_SECRET || '';
    if (!url || !secret) return;
    const info = await this.getWebhookInfo();
    if (info.url && info.url !== url) {
      this.logger.error('alert-bot webhook occupied by another URL');
      await sendTelegramAlert('⚠️ <b>Бот алертов:</b> webhook занят другим адресом; ответы не включены').catch(() => {});
      return;
    }
    await this.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    const commands = [
      { command: 'ask', description: 'Спросить бота' },
      { command: 'status', description: 'Сводка без модели' },
      { command: 'close', description: 'Закрыть тикет' },
    ];
    await this.call('setMyCommands', { commands, scope: { type: 'all_private_chats' } });
    await this.call('setMyCommands', { commands, scope: { type: 'all_group_chats' } });
  }
}
