import { Body, Controller, Get, Post, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { BusinessProfileService } from './business-profile.service';
import { isBusinessProfileEmpty } from './business-profile.types';

/**
 * Отдельные эндпоинты, а не расширение /webhook/profile-update.
 *
 * Причина не в чистоте: profile-update по своей семантике шлёт объект
 * целиком и перезаписывает, а правило «не затирать правки пользователя»
 * должно жить в одной серверной точке.
 */
@Controller('')
export class BusinessProfileController {
  constructor(@Optional() private readonly svc?: BusinessProfileService) {}

  @Get('business-profile')
  @UseGuards(JwtGuard)
  async get(@Req() req: any, @Res() r: Response) {
    if (!this.svc) return r.status(503).json({ error: 'business profile service not configured' });
    const userId: string = req.user?.userId;
    if (!userId) return r.status(401).json({ error: 'unauthorized' });

    const [profile, hasHistory] = await Promise.all([
      this.svc.read(userId),
      this.svc.hasBusinessHistory(userId),
    ]);
    const filled = !isBusinessProfileEmpty(profile);
    return r.status(200).json({ profile, visible: filled || hasHistory });
  }

  @Post('business-profile')
  @UseGuards(JwtGuard)
  async update(@Req() req: any, @Body() body: any, @Res() r: Response) {
    if (!this.svc) return r.status(503).json({ error: 'business profile service not configured' });
    const userId: string = req.user?.userId;
    if (!userId) return r.status(401).json({ error: 'unauthorized' });

    const profile = await this.svc.merge(userId, body?.fields || {}, 'user');
    return r.status(200).json({ profile });
  }
}
