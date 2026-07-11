import { Controller, Get, Post, Body, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { RoutinePushService } from './routine-push.service';
import { RoutineStore } from './routine-store.service';

@Controller('routines')
export class RoutinePushController {
  constructor(
    private readonly routines: RoutinePushService,
    private readonly store: RoutineStore,
  ) {}

  // Список всех рутин пользователя.
  @Get()
  @UseGuards(JwtGuard)
  async list(@CurrentUser() user: any, @Res() res: Response) {
    return res.json({ routines: await this.store.list(user.userId) });
  }

  // Единая точка мутаций: { action: create|update|delete|test|preset_energy, ... }
  @Post()
  @UseGuards(JwtGuard)
  async mutate(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const uid = user.userId;
    const action = String(body?.action || '');
    try {
      switch (action) {
        case 'create': {
          if (!body?.assistant && !body?.assistantId) return res.status(400).json({ error: 'assistant required' });
          if (!String(body?.prompt || '').trim()) return res.status(400).json({ error: 'prompt required' });
          const row = await this.store.create(uid, {
            title: String(body.title || 'Напоминание'),
            assistantId: String(body.assistant ?? body.assistantId),
            prompt: String(body.prompt),
            sendHour: body.sendHour,
            tz: body.tz,
            days: body.days,
            enabled: body.enabled !== false,
          });
          return res.json({ ok: true, routine: row });
        }
        case 'update': {
          if (!body?.id) return res.status(400).json({ error: 'id required' });
          const row = await this.store.update(uid, String(body.id), {
            title: body.title,
            assistantId: body.assistant ?? body.assistantId,
            prompt: body.prompt,
            sendHour: body.sendHour,
            tz: body.tz,
            days: body.days,
            enabled: body.enabled,
          });
          if (!row) return res.status(404).json({ error: 'not found' });
          return res.json({ ok: true, routine: row });
        }
        case 'delete': {
          if (!body?.id) return res.status(400).json({ error: 'id required' });
          return res.json({ ok: await this.store.remove(uid, String(body.id)) });
        }
        case 'test': {
          if (!body?.id) return res.status(400).json({ error: 'id required' });
          const r = await this.routines.fireNow(uid, String(body.id));
          if (!r) return res.status(404).json({ error: 'not found' });
          return res.json({ ok: true, delivered: r.delivered });
        }
        case 'preset_energy': {
          const row = await this.routines.ensureEnergyPreset(uid, body?.tz);
          return res.json({ ok: true, routine: row });
        }
        default:
          return res.status(400).json({ error: 'unknown action' });
      }
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'routine op failed' });
    }
  }
}
