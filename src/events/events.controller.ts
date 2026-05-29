import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { EventsService } from './events.service';

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

  @Post('webhook/events/track')
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
}
