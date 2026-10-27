import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ShortsYoutubeService } from './shorts-youtube.service';

const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

/**
 * Адрес возврата Google после входа владельца (спека YouTube, «Сценарий
 * владельца»). Публичный: браузер приходит без токена кабинета, всё решает
 * подписанный state. С глобальным префиксом — /webhook/shorts/youtube/oauth/callback,
 * ровно так он зарегистрирован в Google Cloud.
 */
@Controller('shorts/youtube')
export class ShortsYoutubeController {
  constructor(private readonly youtube: ShortsYoutubeService) {}

  @Get('oauth/callback')
  async callback(@Query() q: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const page = await this.youtube.completeConnect({ code: str(q?.code), state: str(q?.state), error: str(q?.error) });
    res.status(page.status).set('Cache-Control', 'no-store').type('html').send(page.html);
  }
}
