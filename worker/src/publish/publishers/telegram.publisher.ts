// worker/src/publish/publishers/telegram.publisher.ts
import axios from 'axios';
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';
import { logger } from '../../logger';

interface TelegramCreds {
  botToken: string;
  chatId: string | number;   // channel id like @mychannel or numeric -100...
}

export const telegramPublisher: Publisher = {
  async publish(input: PublishInput): Promise<PublishResult> {
    const creds = input.credentials as unknown as TelegramCreds;
    if (!creds.botToken || !creds.chatId) {
      throw new Error('telegram credentials missing botToken or chatId');
    }

    const url = `https://api.telegram.org/bot${creds.botToken}/sendVideo`;
    const params = new URLSearchParams();
    params.set('chat_id', String(creds.chatId));
    params.set('video', input.videoUrl);
    if (input.caption) params.set('caption', input.caption);
    params.set('supports_streaming', 'true');

    const r = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 60000,
      validateStatus: () => true,
    });
    if (r.status !== 200 || !r.data?.ok) {
      const desc = r.data?.description ?? JSON.stringify(r.data).slice(0, 200);
      throw new Error(`Telegram sendVideo failed: ${r.status} ${desc}`);
    }

    const msg = r.data.result;
    const messageId = msg.message_id as number;
    const chat = msg.chat ?? {};
    let externalUrl = '';
    if (chat.username) {
      externalUrl = `https://t.me/${chat.username}/${messageId}`;
    } else if (typeof chat.id === 'number' && chat.id < 0) {
      // For private channels (-100xxxxxxxxxx), construct t.me/c/xxxxxxxxxx/<msgid>
      const cleanedId = String(chat.id).replace(/^-100/, '');
      externalUrl = `https://t.me/c/${cleanedId}/${messageId}`;
    } else {
      externalUrl = `tg://msg?chat_id=${chat.id}&msg_id=${messageId}`;
    }
    logger.info({ chatId: chat.id, messageId, externalUrl }, 'telegram publish ok');

    return {
      externalUrl,
      externalPostId: String(messageId),
    };
  },

  async delete(input) {
    const creds = input.credentials as unknown as TelegramCreds;
    if (!creds.botToken || !creds.chatId) return;
    const url = `https://api.telegram.org/bot${creds.botToken}/deleteMessage`;
    await axios.post(url, new URLSearchParams({
      chat_id: String(creds.chatId),
      message_id: input.externalPostId,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
      validateStatus: () => true,
    });
  },
};
