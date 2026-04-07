import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ReferralService } from '../referral/referral.service';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly referralService: ReferralService,
  ) {}

  async createPayment(userId: string, amount: number, pkg: string) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) throw new Error('YooKassa not configured');

    const idempotenceKey = uuidv4();
    const returnUrl = process.env.RETURN_URL || 'https://b.linkeon.io/payment/success';
    const resp = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: `Токены: ${pkg}`,
        capture: true,
        metadata: { userId, package: pkg },
      },
      {
        auth: { username: shopId, password: secretKey },
        headers: { 'Idempotence-Key': idempotenceKey },
      },
    );

    const tokensForPkg = this.tokensForPackage(pkg, amount);
    const confirmUrl = resp.data.confirmation?.confirmation_url || '';

    await this.pg.query(
      `INSERT INTO payments (payment_id, user_id, package_id, amount, tokens, status, payment_url)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [resp.data.id, userId, pkg, amount, tokensForPkg, confirmUrl],
    );

    return {
      payment_id: resp.data.id,
      confirmation_url: confirmUrl,
    };
  }

  async verifyPayment(paymentId: string, userId: string) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;

    const resp = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      auth: { username: shopId, password: secretKey },
    });

    if (resp.data.status === 'succeeded') {
      await this.processSucceededPayment(paymentId, resp.data.metadata?.userId || userId);
    }

    return { status: resp.data.status };
  }

  async processSucceededPayment(paymentId: string, userId: string) {
    const existing = await this.pg.query(
      `SELECT status FROM payments WHERE payment_id = $1`,
      [paymentId],
    );
    if (existing.rows[0]?.status === 'succeeded') return; // already processed

    const paymentRow = await this.pg.query(
      'SELECT tokens, user_id, amount FROM payments WHERE payment_id = $1',
      [paymentId],
    );
    const tokensToAdd = Number(paymentRow.rows[0]?.tokens || 0);

    await this.pg.query(
      'UPDATE payments SET status = $1, completed_at = now(), updated_at = now() WHERE payment_id = $2',
      ['succeeded', paymentId],
    );
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2',
      [tokensToAdd, userId],
    );

    // Process referral commission
    if (this.referralService) {
      const amount = Number(paymentRow.rows[0]?.amount || 0);
      if (amount > 0) {
        try {
          await this.referralService.processPaymentCommission(userId, paymentId, amount);
        } catch (e) {
          this.logger.error(`Referral commission error: ${e.message}`);
        }
      }
    }
  }

  private tokensForPackage(pkg: string, amount: number): number {
    const map: Record<string, number> = {
      basic: 100000,
      standard: 500000,
      premium: 2000000,
    };
    return map[pkg] || Math.floor((amount || 0) * 1000);
  }

  async handleNotification(body: any) {
    if (body.event === 'payment.succeeded' && body.object) {
      const paymentId = body.object.id;
      const userId = body.object.metadata?.userId;
      if (paymentId) {
        await this.processSucceededPayment(paymentId, userId);
      }
    }
    return { ok: true };
  }

  async redeemCoupon(userId: string, code: string) {
    const res = await this.pg.query(
      'SELECT * FROM coupons WHERE code = $1 AND is_active = true LIMIT 1',
      [code],
    );
    if (!res.rows.length) return { success: false, error: 'Invalid coupon' };

    // Check if already redeemed
    const redeemed = await this.pg.query(
      'SELECT id FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2',
      [res.rows[0].id, userId],
    );
    if (redeemed.rows.length > 0) return { success: false, error: 'Coupon already redeemed' };

    const tokens = Number(res.rows[0].token_amount);
    await this.pg.query(
      'INSERT INTO coupon_redemptions (coupon_id, user_id, tokens_granted) VALUES ($1, $2, $3)',
      [res.rows[0].id, userId, tokens],
    );
    await this.pg.query(
      'UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1',
      [res.rows[0].id],
    );
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2',
      [tokens, userId],
    );
    return { success: true, tokens_added: tokens };
  }
}
