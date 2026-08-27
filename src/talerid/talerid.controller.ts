import { Body, Controller, Get, Post, Delete, UseGuards, HttpCode, HttpStatus, Logger, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { TalerIdOauthService } from './talerid-oauth.service';
import { TalerIdStoreService } from './talerid-store.service';
import { TalerIdLinkService } from './talerid-link.service';
import { TalerIdLoginService } from './talerid-login.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

/**
 * Task 5 — connect/status/disconnect for the TalerID partner-provision flow.
 *
 * ⚠️ `@Controller('ecosystem/talerid')`, NOT `@Controller('webhook/ecosystem/talerid')` — the
 * app sets a global prefix `webhook` (see plan §Global Constraints), so this already resolves to
 * `/webhook/ecosystem/talerid/*`. Adding 'webhook' here would double it.
 */
@Controller('ecosystem/talerid')
export class TalerIdController {
  private readonly logger = new Logger(TalerIdController.name);

  constructor(
    private readonly oauth: TalerIdOauthService,
    private readonly store: TalerIdStoreService,
    private readonly link: TalerIdLinkService,
    private readonly login: TalerIdLoginService,
  ) {}

  /**
   * 'ambiguous' is a known guardrail state (≥2 phone matches at TalerID), not an error — the UI
   * explains it and lets the user retry with support. Always resolves 200 (never throws), for
   * connected/ambiguous/error alike. Identity lookup + provision live in the oauth service
   * (shared with the auto-reprovision self-heal) — the controller just delegates.
   */
  @Post('connect')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async connect(@CurrentUser() user: any) {
    const status = await this.oauth.provisionForUser(String(user.userId));
    return { status };
  }

  @Get('status')
  @UseGuards(JwtGuard)
  async status(@CurrentUser() user: any) {
    const connection = await this.store.getConnection(String(user.userId));
    return { connected: connection?.status === 'connected', status: connection?.status ?? null };
  }

  @Delete('disconnect')
  @UseGuards(JwtGuard)
  async disconnect(@CurrentUser() user: any) {
    await this.oauth.disconnect(String(user.userId));
    return { ok: true };
  }

  /**
   * Account linking — leg 1 (authenticated). Look the user's phone up server-side and stash it with
   * the PKCE state, then return the TalerID authorize URL for the frontend to open. No phone ever
   * comes from the (public) callback. `no_phone` → the user has no phone on file (shouldn't happen
   * for an SMS-onboarded user) → frontend keeps the plain "завести новый" path.
   */
  @Post('oauth/start')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async oauthStart(@CurrentUser() user: any) {
    const userId = String(user.userId);
    const { phone } = await this.oauth.lookupProvisionInput(userId);
    if (!phone) return { error: 'no_phone' };
    return this.link.startLink(userId, phone);
  }

  /**
   * Account linking — leg 2 (PUBLIC: TalerID redirects the user's browser here after login; the
   * Linkeon JWT is NOT present — the request is tied back to the user via the one-time `state`).
   * Resolves the outcome and redirects the browser back into the SPA with ?talerid_link=<status>,
   * which the frontend turns into a toast + a status refresh.
   */
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const base = (process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io').replace(/\/$/, '');

    // Один redirect_uri на два сценария: привязку и вход. Он зарегистрирован
    // у провайдера, и заводить второй ради входа значило бы держать две
    // регистрации ради одного и того же обмена. Различаем по state.
    const login = await this.login.peekLogin(state);
    if (login) {
      // Мобильному клиенту возврат нужен ссылкой в приложение: согласие он
      // проходил в системном браузере (иначе установленный Taler ID его не
      // перехватит), и страницы Linkeon оттуда уже не видит.
      const back = login.mobile
        ? (process.env.TALERID_MOBILE_RETURN_URL || 'linkeon://auth/talerid')
        : `${base}/`;
      // Отказ на стороне провайдера — тоже конец входа, а не привязки:
      // возврат с `talerid_link` экран входа не понимает.
      if (error) return res.redirect(`${back}?talerid_login_error=1`);
      const handoff = await this.login.completeLogin(state, code);
      // Токены уезжают не в адресной строке, а одноразовым кодом: строка
      // осела бы в истории браузера и в логах прокси.
      return res.redirect(
        handoff
          ? `${back}?talerid_login=${encodeURIComponent(handoff)}`
          : `${back}?talerid_login_error=1`,
      );
    }

    let status: string;
    if (error) {
      status = 'cancelled'; // user denied/aborted at TalerID's login screen
    } else {
      try {
        status = await this.link.completeLink(state, code);
      } catch (e: any) {
        this.logger.warn(`talerid oauth callback failed: ${e?.message}`);
        status = 'error';
      }
    }
    return res.redirect(`${base}/?talerid_link=${encodeURIComponent(status)}`);
  }

  /**
   * Вход через Taler ID — шаг 1. Публичный: человек ещё НЕ вошёл в Linkeon,
   * тем и отличается от `oauth/start`, который привязывает провайдера к уже
   * существующей сессии и требует JWT.
   *
   * `platform: 'mobile'` шлёт приложение — по нему решается, куда вернуть
   * человека после согласия. Веб его не присылает и не задет.
   */
  @Post('login/start')
  @HttpCode(HttpStatus.OK)
  async loginStart(@Body() body: { platform?: string }) {
    return this.login.startLogin(body?.platform);
  }

  /**
   * Вход через Taler ID — шаг 3. Обмен одноразового кода на токены Linkeon.
   * Код живёт две минуты и срабатывает единожды.
   */
  @Post('login/redeem')
  @HttpCode(HttpStatus.OK)
  async loginRedeem(@Body() body: { handoff?: string }, @Res() res: Response) {
    const tokens = await this.login.redeemHandoff(body?.handoff || '');
    if (!tokens) return res.status(400).json({ error: 'handoff expired or already used' });
    return res.status(200).json(tokens);
  }
}
