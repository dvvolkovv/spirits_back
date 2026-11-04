import { Controller, Post, Req, Res, HttpCode, NotFoundException, UnauthorizedException, Inject, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ALERT_BOT_HANDLER, alertBotEnabled, validAlertBotSecret } from './alert-bot.config';

@Controller('alert-bot')
export class AlertBotController {
  private readonly logger = new Logger(AlertBotController.name);
  constructor(@Inject(ALERT_BOT_HANDLER) private readonly handler: { handleUpdate(update: unknown): Promise<void> }) {}

  @Post('telegram')
  @HttpCode(200)
  async hook(@Req() req: Request, @Res() res: Response) {
    if (!alertBotEnabled()) throw new NotFoundException();
    if (!validAlertBotSecret(req.headers['x-telegram-bot-api-secret-token'])) throw new UnauthorizedException();
    res.status(200).json({ ok: true });
    setImmediate(() => this.handler.handleUpdate(req.body).catch((e: any) => {
      this.logger.error(`alert-bot update failed: ${e?.code || e?.kind || 'error'}`);
    }));
  }
}
