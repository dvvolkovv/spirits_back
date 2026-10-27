import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConnectPage, ShortsYoutubeService, connectPage } from './shorts-youtube.service';

const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

/** Страница без внешних ресурсов: ничего не грузит и никуда не отправляет — code и state из адреса не утекут. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Адрес возврата Google после входа владельца (спека YouTube, «Сценарий
 * владельца»). Публичный: браузер приходит без токена кабинета, всё решает
 * подписанный state. С глобальным префиксом — /webhook/shorts/youtube/oauth/callback,
 * ровно так он зарегистрирован в Google Cloud.
 */
@Controller('shorts/youtube')
export class ShortsYoutubeController {
  private readonly logger = new Logger(ShortsYoutubeController.name);

  constructor(private readonly youtube: ShortsYoutubeService) {}

  @Get('oauth/callback')
  async callback(@Query() q: Record<string, unknown>, @Res() res: Response): Promise<void> {
    let page: ConnectPage;
    try {
      page = await this.youtube.completeConnect({ code: str(q?.code), state: str(q?.state), error: str(q?.error) });
    } catch (e: any) {
      // completeConnect задуман без исключений; страховка — страница вместо JSON 500.
      this.logger.error(`адрес возврата YouTube упал: ${e?.message ?? e}`);
      page = connectPage(500, 'Не получилось подключить канал', 'Пришлите боту /youtube и попробуйте ещё раз.');
    }
    res
      .status(page.status)
      .set('Cache-Control', 'no-store')
      .set('Referrer-Policy', 'no-referrer')
      .set('Content-Security-Policy', CSP)
      .type('html')
      .send(page.html);
  }
}
