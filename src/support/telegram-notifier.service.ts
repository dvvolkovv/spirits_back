import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface EscalationPayload {
  ticketId: string;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  userTokens?: number | null;
  urgency?: string | null;
  reason: string;
  summary: string;
  lastUserMessage?: string | null;
}

export interface HealthAlertPayload {
  service: string;
  prevStatus: string;
  newStatus: string;
  latencyMs?: number | null;
  lastError?: string | null;
}

export interface UserReplyPayload {
  ticketId: string;
  userName: string;
  userText: string;
  ticketStatus: string;
}

@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);
  private readonly token = process.env.TELEGRAM_BOT_TOKEN || '';
  private readonly chatId = process.env.TELEGRAM_SUPPORT_CHAT_ID || '';
  private readonly adminOrigin = process.env.ADMIN_ORIGIN || 'https://my.linkeon.io';

  constructor() {
    this.logger.log(
      `telegram notifier: ${this.isConfigured() ? `configured for chat ${this.chatId}` : 'NOT configured'}`,
    );
  }

  private isConfigured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  private async send(text: string, replyMarkup?: any): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('telegram not configured — skipping');
      return;
    }
    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
        { timeout: 8000 },
      );
      this.logger.log(`telegram sent (msg ${r.data?.result?.message_id})`);
    } catch (e: any) {
      const desc = e?.response?.data?.description || e.message;
      this.logger.error(`telegram send failed: ${desc}`);
    }
  }

  private esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private maskPhone(p: string): string {
    const d = String(p).replace(/\D/g, '');
    if (d.length < 6) return 'Пользователь';
    return `+${d.slice(0, 1)} *** *** ${d.slice(-2)}`;
  }

  private urgencyEmoji(u: string | null | undefined): string {
    switch (u) {
      case 'critical': return '🔥';
      case 'high': return '🚨';
      case 'normal': return '⚠️';
      case 'low': return 'ℹ️';
      default: return '⚠️';
    }
  }

  async notifyEscalation(p: EscalationPayload): Promise<void> {
    const name = p.userName || this.maskPhone(p.userId);
    const tokens = (p.userTokens ?? 0).toLocaleString('ru-RU');
    const short = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + '…' : s);

    const text = [
      `${this.urgencyEmoji(p.urgency)} <b>Escalation</b> · ${this.esc(p.urgency || 'normal')}`,
      `<b>${this.esc(name)}</b> · ${tokens} токенов${p.userEmail ? ' · ' + this.esc(p.userEmail) : ''}`,
      '',
      `<b>Причина:</b> ${this.esc(short(p.reason, 200))}`,
      '',
      `<b>Контекст:</b>\n${this.esc(short(p.summary, 800))}`,
      p.lastUserMessage
        ? `\n<b>Последнее сообщение:</b>\n<i>${this.esc(short(p.lastUserMessage, 400))}</i>`
        : '',
      '',
      `<code>#${p.ticketId.slice(0, 8)}</code>`,
    ].filter(Boolean).join('\n');

    const replyMarkup = {
      inline_keyboard: [[
        { text: '🔧 Открыть тикет', url: `${this.adminOrigin}/admin?tab=support&ticket=${p.ticketId}` },
      ]],
    };

    await this.send(text, replyMarkup);
  }

  /** Reply to a specific message in the support chat (used to ACK owner commands). */
  async replyTo(messageId: number, text: string): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          reply_to_message_id: messageId,
          disable_web_page_preview: true,
        },
        { timeout: 6000 },
      );
    } catch (e: any) {
      const desc = e?.response?.data?.description || e.message;
      this.logger.error(`telegram reply failed: ${desc}`);
    }
  }

  async notifyUserReply(p: UserReplyPayload): Promise<void> {
    const short = (s: string, n = 500) => (s.length > n ? s.slice(0, n) + '…' : s);
    const text = [
      `💬 <b>${this.esc(p.userName)}</b> написал в тикете <code>#${p.ticketId.slice(0, 8)}</code>`,
      `<i>(статус: ${this.esc(p.ticketStatus)} — ответьте реплаем в этот чат)</i>`,
      '',
      `${this.esc(short(p.userText))}`,
    ].join('\n');
    const replyMarkup = {
      inline_keyboard: [[
        { text: '🔧 Открыть тикет', url: `${this.adminOrigin}/admin?tab=support&ticket=${p.ticketId}` },
      ]],
    };
    await this.send(text, replyMarkup);
  }

  async notifyHealthAlert(p: HealthAlertPayload): Promise<void> {
    const emoji = p.newStatus === 'down' ? '🔴' : p.newStatus === 'degraded' ? '🟡' : '🟢';
    const lat = p.latencyMs != null ? ` · ${p.latencyMs}мс` : '';
    const err = p.lastError ? `\n<code>${this.esc(String(p.lastError).slice(0, 400))}</code>` : '';
    const text = [
      `${emoji} <b>${this.esc(p.service)}</b>: ${this.esc(p.prevStatus)} → <b>${this.esc(p.newStatus)}</b>${lat}`,
      err,
    ].filter(Boolean).join('');
    await this.send(text);
  }
}
