import { Controller, Get, Post, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { TgIdentityService } from './tg-identity.service';

@Controller('webhook/tg-bot')
@UseGuards(JwtGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class TgBotConfigController {
  constructor(private readonly identity: TgIdentityService) {}

  @Get('identity-status')
  async identityStatus(@CurrentUser() user: any, @Res() res: Response) {
    const id = await this.identity.getIdentityByLinkeonId(user.userId);
    if (!id) return res.status(200).json({ bound: false });
    return res.status(200).json({
      bound: true,
      tgUsername: id.tgUsername,
      tgFirstName: id.tgFirstName,
    });
  }

  @Post('identity-link')
  async identityLink(@CurrentUser() user: any, @Res() res: Response) {
    const token = await this.identity.createAuthToken(user.userId);
    const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
    const deepLink = `https://t.me/${botUsername}?start=${token}`;
    return res.status(200).json({ token, deepLink });
  }
}
