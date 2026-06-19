import { Controller, Get, Post, Body, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ReferralService } from './referral.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Post('referral/register')
  @UseGuards(JwtGuard)
  async register(@CurrentUser() user: any, @Body() body: { slug: string }, @Res() res: Response) {
    const result = await this.referralService.register(user.userId, body.slug);
    return res.status(result.success ? 200 : 400).json(result);
  }

  @Get('referral/stats')
  @UseGuards(JwtGuard)
  async getStats(@CurrentUser() user: any, @Res() res: Response) {
    const result = await this.referralService.getStats(user.userId);
    return res.status(200).json(result);
  }

  // Вывод накопленных комиссий токенами на баланс (мгновенно).
  @Post('referral/payout')
  @UseGuards(JwtGuard)
  async payout(@CurrentUser() user: any, @Body() body: { method?: string }, @Res() res: Response) {
    if (body?.method && body.method !== 'tokens') {
      return res.status(400).json({ error: 'Поддерживается только вывод токенами' });
    }
    const result = await this.referralService.payoutTokens(user.userId);
    return res.status(200).json(result);
  }

  // DEV-1: заявка на вывод комиссий ДЕНЬГАМИ (ручная выплата командой).
  @Post('referral/withdraw')
  @UseGuards(JwtGuard)
  async withdraw(@CurrentUser() user: any, @Body() body: { method: string; requisites: string }, @Res() res: Response) {
    try {
      const result = await this.referralService.requestWithdrawal(user.userId, body?.method, body?.requisites);
      return res.status(200).json(result);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'Не удалось создать заявку' });
    }
  }
}
