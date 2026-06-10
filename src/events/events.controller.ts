import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { EventsService } from './events.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

interface TrackBody {
  name?: string;
  sessionId?: string;
  userId?: string;
  props?: Record<string, unknown>;
  source?: string;
}

// Frontend tracking endpoint. Anonymous (no auth) — landing_view fires before signup.
// Hostile callers can pollute events; we accept that on this product's scale.
// If abuse becomes a problem, gate via IP rate limit or a lightweight HMAC token.
@Controller('')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post('events/track')
  track(@Body() body: TrackBody, @Req() req: Request, @Res() res: Response) {
    if (!body?.name) {
      return res.status(400).json({ error: 'name required' });
    }
    const userId =
      body.userId ||
      (req as any).user?.phone ||  // present if a JWT slipped through
      null;
    this.events.track(body.name, {
      userId,
      sessionId: body.sessionId || null,
      props: body.props || {},
      source: body.source || null,
    });
    return res.status(204).end();
  }

  // Привязка источника привлечения к юзеру (надёжная атрибуция: session_id между
  // анонимным лендингом и регистрацией не доживает — разные визиты/домены).
  // Фронт зовёт это после авторизации с source из localStorage. Пишем
  // signup_source ОДИН раз (если ещё пуст) — first-touch не перетирается.
  @Post('events/attribute')
  @UseGuards(JwtGuard)
  async attribute(@CurrentUser() u: any, @Body() body: { source?: string; campaign?: string }, @Res() res: Response) {
    const userId = u?.userId ? String(u.userId) : null;
    const src = (body?.source || '').trim();
    const campaign = (body?.campaign || '').trim();
    if (userId && src) {
      await this.events.setSignupSourceIfEmpty(userId, src, campaign);
    }
    return res.status(204).end();
  }
}
