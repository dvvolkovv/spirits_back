import { Controller, Post, Body, Req, Res, UseGuards, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { resolvePackage } from './packages';

@Controller('')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('yookassa/create-payment')
  @UseGuards(JwtGuard)
  async createPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    // Цена пакета приходит из общего модуля — сумму называет сервер, из
    // клиента она не берётся никогда. Своя таблица цен здесь была четвёртой
    // копией прайса и 11.08.2026 разошлась с витриной: новые тарифы
    // продавались бы по 149 ₽ с начислением 50 000 токенов вместо 3 000 000.
    const pkg = body.package || body.package_id || 'basic';
    const mapped = resolvePackage(pkg);

    // Неизвестный пакет — отказ, а не тихая подмена самым дешёвым. Прежний
    // откат `{ amount: body.amount || 149, pkg: 'basic' }` делал ровно две
    // скверные вещи: человек платил и получал не тот товар, не увидев ни
    // ошибки, ни предупреждения, — и цену при этом мог назвать клиент,
    // купив пакет за рубль.
    if (!mapped) {
      this.logger.warn(`create-payment: неизвестный пакет "${pkg}" от ${user.userId}`);
      return res.status(400).json({ error: 'unknown package' });
    }

    const result = await this.paymentsService.createPayment(user.userId, mapped.priceRub, mapped.id);
    return res.status(200).json(result);
  }

  @Post('yookassa/verify-payment')
  @UseGuards(JwtGuard)
  async verifyPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    let paymentId = body.payment_id;

    // If no payment_id — find latest payment for this user
    if (!paymentId) {
      const latest = await this.paymentsService.getLatestPayment(user.userId);
      if (latest) paymentId = latest.payment_id;
    }

    if (!paymentId) {
      return res.status(200).json({ status: 'not_found' });
    }

    const result = await this.paymentsService.verifyPayment(paymentId, user.userId);
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
    const result = await this.paymentsService.redeemCoupon(user.userId, body.code);
    return res.status(200).json(result);
  }
}
