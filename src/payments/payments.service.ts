import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly pg: PgService) {}

  async createPayment(userId: string, amount: number, pkg: string) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) throw new Error('YooKassa not configured');

    const idempotenceKey = uuidv4();
    const resp = await axios.post(
      'https://api.yookassa.ru/v2/payments',
      {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: 'https://my.linkeon.io/payment/success' },
        description: `Токены: ${pkg}`,
        metadata: { userId, package: pkg },
      },
      {
        auth: { username: shopId, password: secretKey },
        headers: { 'Idempotence-Key': idempotenceKey },
      },
    );

    await this.pg.query(
      `INSERT INTO payments (payment_id, status, amount, user_phone, package, created_at)
       VALUES ($1, 'pending', $2, $3, $4, now())`,
      [resp.data.id, amount, userId, pkg],
    );

    return {
      payment_id: resp.data.id,
      confirmation_url: resp.data.confirmation.confirmation_url,
    };
  }

  async verifyPayment(paymentId: string, userId: string) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;

    const resp = await axios.get(`https://api.yookassa.ru/v2/payments/${paymentId}`, {
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

    // Token packages: simple mapping
    const paymentRow = await this.pg.query(
      'SELECT amount, package FROM payments WHERE payment_id = $1',
      [paymentId],
    );
    const tokensToAdd = this.tokensForPackage(paymentRow.rows[0]?.package, paymentRow.rows[0]?.amount);

    await this.pg.query(
      'UPDATE payments SET status = $1, updated_at = now() WHERE payment_id = $2',
      ['succeeded', paymentId],
    );
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2',
      [tokensToAdd, userId],
    );
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
    // Look up coupon — table may vary
    const res = await this.pg.query(
      `SELECT * FROM referral_leaders WHERE slug = $1 AND is_active = true LIMIT 1`,
      [code],
    );
    if (!res.rows.length) return { success: false, error: 'Invalid coupon' };

    const tokens = 50000; // default coupon value
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2',
      [tokens, userId],
    );
    return { success: true, tokens_added: tokens };
  }
}
