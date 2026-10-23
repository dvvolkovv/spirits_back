import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProfileService } from '../profile/profile.service';
import { SpendingService } from './spending.service';

@Controller('')
export class TokensController {
  private readonly logger = new Logger(TokensController.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly spending: SpendingService,
  ) {}

  @Get('user/tokens')
  @UseGuards(JwtGuard)
  async getTokens(@CurrentUser() user: any, @Res() res: Response) {
    const tokens = await this.profileService.getTokenBalance(user.userId);
    return res.status(200).json({ success: true, tokens });
  }

  /**
   * Сводка расхода по месяцам и категориям — блок «Расход по месяцам» в окне
   * оплаты, на /tokens и в кошельке мини-аппа. tz — пояс браузера (границы
   * месяцев), months — сколько месяцев (1–24, по умолчанию 12).
   */
  @Get('tokens/spending')
  @UseGuards(JwtGuard)
  async getSpending(
    @CurrentUser() user: any,
    @Query('tz') tz: string,
    @Query('months') months: string,
    @Res() res: Response,
  ) {
    try {
      const result = await this.spending.monthly(user.userId, tz, months);
      return res.status(200).json({ months: result });
    } catch (e: any) {
      this.logger.error(`сводка расхода для ${user?.userId}: ${e?.message}`, e?.stack);
      return res.status(500).json({ error: 'spending_failed' });
    }
  }
}
