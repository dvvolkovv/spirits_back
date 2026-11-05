import { Controller, Post, Req, Res, HttpCode, NotFoundException, UnauthorizedException, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ALERT_BOT_HANDLER, alertBotEnabled, validAlertBotSecret } from './alert-bot.config';

@Controller('alert-bot')
export class AlertBotController {
  private readonly logger = new Logger(AlertBotController.name);
  constructor(@Inject(ALERT_BOT_HANDLER) private readonly handler: {
    claimUpdate(update: unknown): Promise<boolean>;
    handleUpdate(update: unknown, alreadyClaimed?: boolean): Promise<void>;
  }) {}

  @Post('telegram')
  @HttpCode(200)
  async hook(@Req() req: Request, @Res() res: Response) {
    if (!alertBotEnabled()) throw new NotFoundException();
    if (!validAlertBotSecret(req.headers['x-telegram-bot-api-secret-token'])) throw new UnauthorizedException();
    let claimed: boolean;
    try {
      claimed = await this.handler.claimUpdate(req.body);
    } catch {
      // Telegram не получает 200, пока payload не сохранён durable claim.
      throw new ServiceUnavailableException('alert bot durable claim unavailable');
    }
    res.status(200).json({ ok: true });
    if (!claimed) return;
    setImmediate(() => this.handler.handleUpdate(req.body, true).catch((e: any) => {
      this.logger.error(`alert-bot update failed: ${e?.code || e?.kind || 'error'}`);
    }));
  }
}
