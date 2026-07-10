import { Controller, Get, Post, Body, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { PushService } from './push.service';

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  // Публичный VAPID-ключ для PushManager.subscribe на фронте.
  @Get('public-key')
  publicKey(@Res() res: Response) {
    return res.json({ publicKey: this.push.getPublicKey() });
  }

  @Post('subscribe')
  @UseGuards(JwtGuard)
  async subscribe(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    await this.push.subscribe(user.userId, body?.subscription || body);
    return res.json({ ok: true });
  }

  @Post('unsubscribe')
  @UseGuards(JwtGuard)
  async unsubscribe(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    await this.push.unsubscribe(user.userId, body?.endpoint);
    return res.json({ ok: true });
  }

  // Тестовый пуш самому себе (проверка транспорта с устройства).
  @Post('test')
  @UseGuards(JwtGuard)
  async test(@CurrentUser() user: any, @Res() res: Response) {
    const n = await this.push.sendPush(user.userId, {
      title: 'Linkeon', body: 'Уведомления включены ✅', url: '/chat', tag: 'test',
    });
    return res.json({ ok: true, delivered: n });
  }
}
