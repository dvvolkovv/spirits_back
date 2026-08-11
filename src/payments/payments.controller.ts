import { Controller, Post, Body, Req, Res, UseGuards, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('yookassa/create-payment')
  @UseGuards(JwtGuard)
  async createPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    // Цена пакета. Витрина шлёт id (starter/extended/professional/business/
    // maximum либо исторические basic/standard/premium) — сумму называет
    // сервер, из клиента она не берётся никогда.
    //
    // Это четвёртая копия прайса: витрина, оферта, карта токенов и вот эта
    // таблица. Копия уже подводила дважды. 08.04.2026 `starter` не было в
    // карте токенов, и десять человек получили по 149 000 токенов вместо
    // 50 000 — сработал откат `amount × 1000`. 11.08.2026 `business` и
    // `maximum` появились на витрине, но не здесь, и покупка «Бизнеса» за
    // 4 990 ₽ выставила бы счёт на 149 ₽ с начислением 50 000 токенов.
    // Пока прайс живёт в четырёх местах, эти грабли лежат тут же.
    const pkgMap: Record<string, { amount: number; pkg: string }> = {
      basic: { amount: 149, pkg: 'basic' },
      starter: { amount: 149, pkg: 'basic' },
      standard: { amount: 499, pkg: 'standard' },
      extended: { amount: 499, pkg: 'standard' },
      premium: { amount: 1990, pkg: 'premium' },
      professional: { amount: 1990, pkg: 'premium' },
      business: { amount: 4990, pkg: 'business' },
      maximum: { amount: 9990, pkg: 'maximum' },
    };
    const pkg = body.package || body.package_id || 'basic';
    const mapped = pkgMap[pkg];

    // Неизвестный пакет — отказ, а не тихая подмена самым дешёвым. Прежний
    // откат `{ amount: body.amount || 149, pkg: 'basic' }` делал ровно две
    // скверные вещи: человек платил и получал не тот товар, не увидев ни
    // ошибки, ни предупреждения, — и цену при этом мог назвать клиент,
    // купив пакет за рубль.
    if (!mapped) {
      this.logger.warn(`create-payment: неизвестный пакет "${pkg}" от ${user.userId}`);
      return res.status(400).json({ error: 'unknown package' });
    }

    const result = await this.paymentsService.createPayment(user.userId, mapped.amount, mapped.pkg);
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
