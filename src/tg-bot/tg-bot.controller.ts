import { Controller, Post, Param, Req, Res, HttpCode, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TgBotService } from './tg-bot.service';

@Controller('')
export class TgBotController {
  constructor(private readonly bot: TgBotService) {}

  @Post('telegram/:secret')
  @HttpCode(200)
  async handle(
    @Param('secret') urlSecret: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // 1. URL-секрет
    if (urlSecret !== process.env.TG_WEBHOOK_URL_SECRET) {
      throw new UnauthorizedException('bad url secret');
    }
    // 2. Header-секрет (выставляется Telegram'ом из setWebhook secret_token)
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== process.env.TG_WEBHOOK_HEADER_SECRET) {
      throw new UnauthorizedException('bad header secret');
    }
    // 3. Ответ 200 быстро + обработка в фоне (fire-and-forget)
    res.status(200).json({ ok: true });
    setImmediate(() => {
      this.bot.handleUpdate(req.body).catch(() => { /* errors logged inside */ });
    });
    return;
  }
}
