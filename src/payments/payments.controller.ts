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
    const result = await this.paymentsService.createPayment(user.phone, body.amount, body.package);
    return res.status(200).json(result);
  }

  @Post('yookassa/verify-payment')
  @UseGuards(JwtGuard)
  async verifyPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const result = await this.paymentsService.verifyPayment(body.payment_id, user.phone);
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
