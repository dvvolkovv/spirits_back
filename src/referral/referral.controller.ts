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
    const result = await this.referralService.register(user.phone, body.slug);
    return res.status(result.success ? 200 : 400).json(result);
  }

  @Get('referral/stats')
  @UseGuards(JwtGuard)
  async getStats(@CurrentUser() user: any, @Res() res: Response) {
    const result = await this.referralService.getStats(user.phone);
    return res.status(200).json(result);
  }
}
