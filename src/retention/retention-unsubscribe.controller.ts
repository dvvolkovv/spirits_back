import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { LanguageService } from '../common/services/language.service';
import { maskRetentionEmail, RetentionUnsubscribeService } from './retention-unsubscribe.service';
import { retentionUnsubscribePage } from './retention-unsubscribe-page';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

@Controller('retention')
export class RetentionUnsubscribeController {
  constructor(private readonly unsubscribes: RetentionUnsubscribeService) {}

  @Get('unsubscribe')
  async get(@Query('token') token: string, @Query('lang') lang: string, @Res() res: Response) {
    const language = LanguageService.normalize(lang);
    const record = await this.unsubscribes.findByToken(token);
    if (!record) return this.page(res, 400, retentionUnsubscribePage({ language, status: 'invalid' }));
    return this.page(res, 200, retentionUnsubscribePage({
      language,
      status: record.unsubscribedAt ? 'already' : 'confirm',
      email: maskRetentionEmail(record.email), token,
    }));
  }

  @Post('unsubscribe')
  async post(@Body() body: { token?: string; lang?: string }, @Res() res: Response) {
    const language = LanguageService.normalize(body?.lang);
    const record = await this.unsubscribes.unsubscribe(String(body?.token || ''));
    if (!record) return this.page(res, 400, retentionUnsubscribePage({ language, status: 'invalid' }));
    return this.page(res, 200, retentionUnsubscribePage({
      language, status: 'done', email: maskRetentionEmail(record.email),
    }));
  }

  private page(res: Response, status: number, html: string) {
    return res.status(status)
      .set('Cache-Control', 'no-store')
      .set('X-Robots-Tag', 'noindex')
      .set('Referrer-Policy', 'no-referrer')
      .set('Content-Security-Policy', CSP)
      .type('html').send(html);
  }
}
