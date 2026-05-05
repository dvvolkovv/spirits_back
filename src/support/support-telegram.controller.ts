import { Controller, Post, Req, Res, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { SupportService } from './support.service';
import { TelegramNotifierService } from './telegram-notifier.service';

/**
 * Public (unauthenticated by JWT) controller for Telegram webhook.
 * Owner replies posted in the configured support chat get relayed into the matching ticket.
 * Guarded by a secret token header Telegram sends back on every update.
 */
@Controller('support')
export class SupportTelegramController {
  constructor(
    private readonly support: SupportService,
    private readonly telegram: TelegramNotifierService,
  ) {}

  @Post('telegram-hook')
  @HttpCode(200)
  async hook(@Req() req: Request, @Res() res: Response) {
    const respondOk = () => res.status(200).json({ ok: true });

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (got !== expectedSecret) {
        return res.status(401).json({ error: 'bad secret' });
      }
    }

    const update: any = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return respondOk();

    const expectedChat = String(process.env.TELEGRAM_SUPPORT_CHAT_ID || '');
    if (expectedChat && String(msg.chat?.id) !== expectedChat) {
      return respondOk();
    }

    const fromId = String(msg.from?.id || '');
    const author = msg.from?.first_name || msg.from?.username || 'Команда';
    const text: string = String(msg.text || '').trim();

    try {
      // /status
      if (/^\/status(?:@\S+)?\b/i.test(text)) {
        const c = await this.support.countActiveTickets();
        await this.telegram.replyTo(
          msg.message_id,
          `📊 Активных тикетов:\n🚨 escalated: ${c.escalated}\n🛠 owner_handling: ${c.owner_handling}\n🤖 ai_handling: ${c.ai_handling}`,
        );
        return respondOk();
      }

      // /close <prefix>
      const closeMatch = text.match(/^\/close(?:@\S+)?\s+([a-f0-9]{6,8})/i);
      if (closeMatch) {
        const prefix = closeMatch[1];
        const ticket = await this.support.findTicketByPrefix(prefix);
        if (!ticket) {
          await this.telegram.replyTo(msg.message_id, `❌ Тикет #${prefix} не найден`);
        } else {
          await this.support.setStatusFromTelegram(ticket.id, fromId, 'resolved');
          await this.telegram.replyTo(msg.message_id, `✅ Тикет #${ticket.id.slice(0, 8)} закрыт`);
        }
        return respondOk();
      }

      // Reply-to flow
      const replyTo = msg.reply_to_message;
      if (replyTo && (replyTo.text || replyTo.caption)) {
        const replySource = String(replyTo.text || replyTo.caption || '');
        const prefixMatch = replySource.match(/#([a-f0-9]{8})/i);
        if (prefixMatch) {
          const ticket = await this.support.findTicketByPrefix(prefixMatch[1]);
          if (!ticket) {
            await this.telegram.replyTo(msg.message_id, `❌ Не нашёл тикет #${prefixMatch[1]}. Возможно он закрыт.`);
            return respondOk();
          }
          if (ticket.status === 'closed' || ticket.status === 'resolved') {
            await this.telegram.replyTo(msg.message_id,
              `⚠️ Тикет #${ticket.id.slice(0, 8)} уже ${ticket.status}. Сообщение пользователя откроет новый.`);
            return respondOk();
          }
          await this.support.postOwnerReplyFromTelegram(ticket.id, fromId, author, text, true);
          await this.telegram.replyTo(msg.message_id, `✅ Отправлено пользователю (#${ticket.id.slice(0, 8)})`);
          return respondOk();
        }
      }

      return respondOk();
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[telegram-hook] error:', e.message);
      try { await this.telegram.replyTo(msg.message_id, `⚠️ Ошибка: ${e.message}`); } catch {}
      return respondOk();
    }
  }
}
