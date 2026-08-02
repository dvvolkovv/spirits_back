import { Controller, Get, Post, Delete, Body, UseGuards, HttpCode, HttpStatus, Logger, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { TalerIdOauthService } from './talerid-oauth.service';
import { TalerIdStoreService } from './talerid-store.service';
import { TalerIdLinkService } from './talerid-link.service';
import { TalerIdCalendarConnector } from './talerid-calendar.connector';
import { PgService } from '../common/services/pg.service';
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
    private readonly calConnector: TalerIdCalendarConnector,
    private readonly pg: PgService,
  ) {}

  // ⚠️ ВРЕМЕННО (2026-08-02): сырой MCP для миграции умываний event→task. Удалить после.
  @Post('test-raw')
  @UseGuards(JwtGuard)
  async testRaw(@CurrentUser() user: any, @Body() body: { name?: string; args?: any }) {
    return this.calConnector.rawCall(String(user.userId), String(body?.name || ''), body?.args || {});
  }

  /**
   * Best-effort profile lookup for provisioning: phone is required (TalerID accounts are keyed by
   * phone — see contract), email/firstName are only used to disambiguate a last-10 phone match and
   * are optional. Mirrors the join ProfileService.getProfile already does (user_id.primary_phone /
   * primary_email + ai_profiles_consolidated.email / profile_data.name) — kept intentionally
   * minimal here rather than pulling in the full profile (Neo4j entities etc. are irrelevant).
   * Any failure degrades to phone:null rather than throwing — connect() then reports 'error'.
   */
  private async lookupProvisionInput(userId: string): Promise<{ phone: string | null; email?: string; firstName?: string }> {
    try {
      const [uidRes, profileRes] = await Promise.all([
        this.pg.query(`SELECT primary_phone, primary_email FROM user_id WHERE internal_id=$1`, [userId]),
        this.pg.query(`SELECT email, profile_data FROM ai_profiles_consolidated WHERE user_id=$1`, [userId]),
      ]);
      const uidRow = uidRes.rows[0] || {};
      const profileRow = profileRes.rows[0] || {};
      const phone: string | null = uidRow.primary_phone || null; // stored WITHOUT '+' — TalerIdOauthClient.toE164 normalizes
      const email: string | undefined = profileRow.email || uidRow.primary_email || undefined;
      const firstName: string | undefined = profileRow.profile_data?.name || undefined;
      return { phone, email, firstName };
    } catch (e: any) {
      this.logger.warn(`lookupProvisionInput failed for user ${userId}: ${e?.message}`);
      return { phone: null };
    }
  }

  /**
   * 'ambiguous' is a known guardrail state (≥2 phone matches at TalerID), not an error — the UI
   * explains it and lets the user retry with support. Always resolves 200 (never throws), for
   * connected/ambiguous/error alike.
   */
  @Post('connect')
  @UseGuards(JwtGuard)
  @HttpCode(HttpStatus.OK)
  async connect(@CurrentUser() user: any) {
    const userId = String(user.userId);
    const { phone, email, firstName } = await this.lookupProvisionInput(userId);
    if (!phone) return { status: 'error' };
    const status = await this.oauth.connect(userId, phone, email, firstName);
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
    const { phone } = await this.lookupProvisionInput(userId);
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
}
