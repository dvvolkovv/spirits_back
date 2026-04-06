import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProfileService } from '../profile/profile.service';

@Controller('')
export class TokensController {
  constructor(private readonly profileService: ProfileService) {}

  @Get('user/tokens')
  @UseGuards(JwtGuard)
  async getTokens(@CurrentUser() user: any, @Res() res: Response) {
    const tokens = await this.profileService.getTokenBalance(user.phone);
    return res.status(200).json({ success: true, tokens });
  }
}
