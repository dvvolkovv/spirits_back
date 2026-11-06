import { Controller, Post, Req, Res, HttpCode, NotFoundException, UnauthorizedException, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ALERT_BOT_HANDLER, alertBotEnabled, validAlertBotSecret } from './alert-bot.config';

@Controller()
export class AlertBotController {
  private readonly logger = new Logger(AlertBotController.name);
  constructor(@Inject(ALERT_BOT_HANDLER) private readonly handler: {
    claimUpdate(update: unknown): Promise<boolean | 'claimed' | 'duplicate' | 'stopped' | 'invalid'>;
    handleUpdate(update: unknown, alreadyClaimed?: boolean): Promise<void>;
  }) {}

  @Post('alert-bot/telegram')
  @HttpCode(200)
  async hook(@Req() req: Request, @Res() res: Response) {
    if (!alertBotEnabled()) throw new NotFoundException();
    if (!validAlertBotSecret(req.headers['x-telegram-bot-api-secret-token'])) throw new UnauthorizedException();
    let claimed: boolean | 'claimed' | 'duplicate' | 'stopped' | 'invalid';
    try {
      claimed = await this.handler.claimUpdate(req.body);
    } catch {
      // Telegram не получает 200, пока payload не сохранён durable claim.
      throw new ServiceUnavailableException('alert bot durable claim unavailable');
    }
    if (claimed === 'stopped') {
      throw new ServiceUnavailableException('alert bot admission stopped');
    }
    res.status(200).json({ ok: true });
    if (claimed === false || claimed === 'duplicate' || claimed === 'invalid') return;
    setImmediate(() => this.handler.handleUpdate(req.body, true).catch((e: any) => {
      this.logger.error(`alert-bot update failed: ${e?.code || e?.kind || 'error'}`);
    }));
  }

  @Post('telegram/alert-bot')
  @HttpCode(200)
  async directHook(@Req() req: Request, @Res() res: Response) {
    return this.hook(req, res);
  }

  // Второй сегмент после alert-bot не даёт маршруту telegram/:secret перехватить запрос.
  @Post('telegram/alert-bot/telegram')
  @HttpCode(200)
  async directTelegramHook(@Req() req: Request, @Res() res: Response) {
    return this.hook(req, res);
  }
}
