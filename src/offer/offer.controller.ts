import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { OfferService } from './offer.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class OfferController {
  constructor(private readonly offer: OfferService) {}

  @Get('offer/status')
  @UseGuards(JwtGuard)
  async status(@CurrentUser() user: any, @Res() res: Response) {
    return res.status(200).json(await this.offer.status(user.userId));
  }

  @Post('offer/dismiss')
  @UseGuards(JwtGuard)
  async dismiss(@CurrentUser() user: any, @Query('kind') kind: string, @Res() res: Response) {
    const k = kind === 'referral' ? 'referral' : 'offer';
    return res.status(200).json(await this.offer.dismiss(user.userId, k));
  }
}
