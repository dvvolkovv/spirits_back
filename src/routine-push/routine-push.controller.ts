import { Controller, Get, Post, Body, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { RoutinePushService } from './routine-push.service';

@Controller('routines')
export class RoutinePushController {
  constructor(private readonly routines: RoutinePushService) {}

  // Текущая конфигурация «энергии дня» пользователя (null — не настроена).
  @Get()
  @UseGuards(JwtGuard)
  async get(@CurrentUser() user: any, @Res() res: Response) {
    const cfg = await this.routines.getForUser(user.userId);
    return res.json({ energyOfDay: cfg });
  }

  // Включить/выключить + время. Body: { enabled, sendHour?, tz? }
  @Post()
  @UseGuards(JwtGuard)
  async set(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const cfg = await this.routines.upsert(user.userId, {
      enabled: !!body?.enabled,
      sendHour: body?.sendHour,
      tz: body?.tz,
    });
    return res.json({ ok: true, energyOfDay: cfg });
  }

  // «Проверить сейчас» — сгенерировать и прислать пуш немедленно.
  @Post('test')
  @UseGuards(JwtGuard)
  async test(@CurrentUser() user: any, @Res() res: Response) {
    const r = await this.routines.fireNow(user.userId);
    return res.json({ ok: true, delivered: r.delivered });
  }
}
