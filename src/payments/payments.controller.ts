import { Controller, Post, Body, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('yookassa/create-payment')
  @UseGuards(JwtGuard)
  async createPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    // Map package_id to amount (frontend sends starter/extended/professional or basic/standard/premium)
    const pkgMap: Record<string, { amount: number; pkg: string }> = {
      basic: { amount: 149, pkg: 'basic' },
      starter: { amount: 149, pkg: 'basic' },
      standard: { amount: 499, pkg: 'standard' },
      extended: { amount: 499, pkg: 'standard' },
      premium: { amount: 1990, pkg: 'premium' },
      professional: { amount: 1990, pkg: 'premium' },
    };
    const pkg = body.package || body.package_id || 'basic';
    const mapped = pkgMap[pkg] || { amount: body.amount || 149, pkg: 'basic' };
    const result = await this.paymentsService.createPayment(user.phone, mapped.amount, mapped.pkg);
    return res.status(200).json(result);
  }

  @Post('yookassa/verify-payment')
  @UseGuards(JwtGuard)
  async verifyPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    let paymentId = body.payment_id;

    // If no payment_id — find latest payment for this user
    if (!paymentId) {
      const latest = await this.paymentsService.getLatestPayment(user.phone);
      if (latest) paymentId = latest.payment_id;
    }

    if (!paymentId) {
      return res.status(200).json({ status: 'not_found' });
    }

    const result = await this.paymentsService.verifyPayment(paymentId, user.phone);
    return res.status(200).json(result);
  }

  @Post('yookassa/notification')
  async notification(@Body() body: any, @Res() res: Response) {
    const result = await this.paymentsService.handleNotification(body);
    return res.status(200).json(result);
  }

  @Post('coupon/redeem')
  @UseGuards(JwtGuard)
  async redeemCoupon(@CurrentUser() user: any, @Body() body: { code: string }, @Res() res: Response) {
    const result = await this.paymentsService.redeemCoupon(user.phone, body.code);
    return res.status(200).json(result);
  }
}
