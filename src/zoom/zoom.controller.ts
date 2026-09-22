import { Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { ZoomOauthService } from './zoom-oauth.service';

/**
 * Подключение аккаунта Zoom.
 *
 * ⚠️ `@Controller('ecosystem/zoom')`, а не `webhook/ecosystem/zoom`: глобальный
 * префикс `webhook` приложение ставит само, и это уже даёт
 * `/webhook/ecosystem/zoom/*`. Тот же порядок, что у Taler ID.
 *
 * Возврат от Zoom принимает БЭКЕНД, а не страница фронта: код в браузере не
 * нужен никому, кроме нас, а лишний шаг — лишнее место, где его можно потерять.
 * Адрес возврата зарегистрирован в кабинете Zoom и обязан совпадать с ним
 * символ в символ.
 */
@Controller('ecosystem/zoom')
export class ZoomController {
  private readonly logger = new Logger(ZoomController.name);

  constructor(private readonly oauth: ZoomOauthService) {}

  /** Куда отправить человека за согласием. */
  @Post('oauth/start')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async start(@CurrentUser() user: any) {
    return this.oauth.start(String(user.userId));
  }

  /**
   * Возврат от Zoom — ПУБЛИЧНЫЙ: браузер приходит сюда без нашего токена, и
   * с пользователем запрос связывает одноразовый `state`.
   *
   * Отвечаем перенаправлением обратно в приложение с пометкой об исходе —
   * фронт превращает её в уведомление и обновляет состояние подключения.
   */
  @Get('oauth/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const base = (process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io').replace(/\/+$/, '');
    const back = (status: string) => res.redirect(`${base}/?zoom_connect=${status}`);

    // Человек мог нажать «Отклонить» — это его право, а не сбой.
    if (error) return back('denied');

    const userId = await this.oauth.claimState(state);
    if (!userId) return back('expired');

    const ok = await this.oauth.complete(userId, code);
    return back(ok ? 'ok' : 'failed');
  }

  @Get('status')
  @UseGuards(JwtGuard)
  async status(@CurrentUser() user: any) {
    return this.oauth.status(String(user.userId));
  }

  @Post('disconnect')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async disconnect(@CurrentUser() user: any) {
    await this.oauth.disconnect(String(user.userId));
    return { ok: true };
  }
}
