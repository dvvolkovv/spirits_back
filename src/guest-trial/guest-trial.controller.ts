// src/guest-trial/guest-trial.controller.ts
import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { RedisService } from '../common/services/redis.service';
import { GuestTurnService, parseGuestTurnInput } from './guest-turn.service';
import { GuestClaimService } from './guest-claim.service';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { hashGuestToken, isGuestTokenShape } from './guest-token';
import { isAllowedGuestOrigin } from './guest-origin';
import { GUEST_REDIS_TIMEOUT_MS } from './guest-trial.types';
import { withTimeout } from '../common/with-timeout';

const WINDOW_KEYS = ['guest-lim:trials:h', 'guest-lim:trials:d', 'guest-lim:answers:h', 'guest-lim:answers:d'];

/**
 * Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md).
 * Ключ гостя ходит только в теле запроса: адреса оседают в журналах nginx и прокси.
 */
@Controller('')
export class GuestTrialController {
  constructor(
    private readonly turns: GuestTurnService,
    private readonly claims: GuestClaimService,
    private readonly store: GuestTrialStore,
    private readonly sessions: GuestSessionsService,
    private readonly redis: RedisService,
  ) {}

  /** Открыта: кабинет без входа решает, показывать ли пробу. */
  @Get('guest/config')
  async config(@Req() req: Request, @Res() res: Response) {
    if (!isAllowedGuestOrigin(req.headers.origin)) return res.status(403).json({ error: 'origin' });
    const { mode, limits } = await this.store.settings();
    return res.status(200).json({ mode, answersPerTrial: limits.answersPerTrial, maxChars: limits.maxChars });
  }

  @Post('guest/chat')
  async chat(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    if (!isAllowedGuestOrigin(req.headers.origin)) return res.status(403).json({ error: 'origin' });
    await this.turns.handle(parseGuestTurnInput(body), res);
  }

  /** Разговор пробы после перезагрузки страницы. */
  @Post('guest/session')
  async session(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    if (!isAllowedGuestOrigin(req.headers.origin)) return res.status(403).json({ error: 'origin' });
    const token = body?.token;
    if (!isGuestTokenShape(token)) return res.status(404).json({ error: 'trial' });
    const row = await this.sessions.findLive(hashGuestToken(token));
    if (!row || row.claimed_at) return res.status(404).json({ error: 'trial' });
    const { limits } = await this.store.settings();
    const messages = await this.sessions.messages(row.id);
    return res.status(200).json({
      assistantId: String(row.assistant_id),
      messages: messages.map((m) => ({ role: m.sender_type === 'human' ? 'user' : 'assistant', content: m.content })),
      left: Math.max(0, limits.answersPerTrial - row.answers),
    });
  }

  @Post('guest/claim')
  @UseGuards(JwtGuard)
  async claim(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const r = await this.claims.claim(String(user?.userId ?? ''), String(body?.token ?? ''));
    return res.status(r.status).json(r.body);
  }

  /** Как у остальной админки: status, enable, preview, disable, set (лимиты). */
  @Post('admin/guest-trial')
  @UseGuards(JwtGuard, AdminGuard)
  async admin(@Body() body: any, @Res() res: Response) {
    switch (body?.action) {
      case 'status': {
        const settings = await this.store.settings();
        return res.status(200).json({ ...settings, counts: await this.sessions.status(), windows: await this.windows() });
      }
      case 'enable':
        await this.store.setMode('on');
        return res.status(200).json({ mode: 'on' });
      case 'preview':
        await this.store.setMode('preview');
        return res.status(200).json({ mode: 'preview' });
      case 'disable':
        await this.store.setMode('off');
        return res.status(200).json({ mode: 'off' });
      case 'set': {
        // Ревью A3: setLimits ничего не пишет и отдаёт changed:false, если в
        // патче нет ни одного валидного ключа (опечатка, не объект) — это
        // ошибка вызова, а не успех с лимитами по умолчанию.
        const r = await this.store.setLimits(body?.limits);
        return res.status(r.changed ? 200 : 400).json(r);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${body?.action}` });
    }
  }

  private async windows(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    for (const key of WINDOW_KEYS) {
      try {
        const v = await withTimeout(this.redis.get(key), GUEST_REDIS_TIMEOUT_MS);
        out[key] = v === null ? 0 : Number(v);
      } catch {
        out[key] = null;
      }
    }
    return out;
  }
}
