import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { ReferralService } from '../referral/referral.service';
import { EventsService } from '../events/events.service';
import { creditWithBonus, OFFER_MSG_THRESHOLD } from '../offer/offer-bonus';
import { sendTelegramAlert } from '../common/telegram-alert';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly referralService: ReferralService,
    @Optional() private readonly events?: EventsService,
  ) {}

  async createPayment(userId: string, amount: number, pkg: string) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) throw new Error('YooKassa not configured');

    const idempotenceKey = uuidv4();
    const baseReturnUrl = process.env.RETURN_URL || 'https://my.linkeon.io/payment/success';
    // First create payment, then use real payment_id in return URL
    // YooKassa allows return_url with user_id; payment_id stored in localStorage on frontend
    const resp = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: `${baseReturnUrl}?user_id=${encodeURIComponent(userId)}` },
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

    this.events?.track('payment_initiated', {
      userId,
      props: { payment_id: resp.data.id, package: pkg, amount, tokens: tokensForPkg },
    });

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

    // Get tokens from DB
    const payRow = await this.pg.query('SELECT tokens, status FROM payments WHERE payment_id = $1', [paymentId]);
    const tokens = Number(payRow.rows[0]?.tokens || 0);
    const dbStatus = payRow.rows[0]?.status || 'unknown';

    return { status: resp.data.status, yoo_status: resp.data.status, db_status: dbStatus, tokens };
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

    // Оффер вовлечённому неплатящему: +50% к ПЕРВОЙ оплате. Считаем ДО пометки
    // succeeded, чтобы prior-count был корректен. Бонус строго server-side —
    // от клиента не зависит (накрутки нет). Идемпотентность — гардом выше.
    const priorPaid = await this.pg.query(
      `SELECT count(*)::int AS n FROM payments WHERE user_id = $1 AND status = 'succeeded'`,
      [userId],
    );
    const firstPayment = (priorPaid.rows[0]?.n ?? 0) === 0;
    const msgCnt = await this.pg.query(
      `SELECT count(*)::int AS n FROM custom_chat_history
       WHERE sender_type = 'human' AND (session_id = $1 OR session_id LIKE $1 || '\\_%')`,
      [userId],
    );
    const engaged = (msgCnt.rows[0]?.n ?? 0) >= OFFER_MSG_THRESHOLD;
    const credit = creditWithBonus(tokensToAdd, firstPayment, engaged);

    await this.pg.query(
      'UPDATE payments SET status = $1, completed_at = now(), updated_at = now() WHERE payment_id = $2',
      ['succeeded', paymentId],
    );
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2',
      [credit, userId],
    );
    if (credit > tokensToAdd) {
      this.events?.track('offer_converted', {
        userId,
        props: { base: tokensToAdd, bonus: credit - tokensToAdd, payment_id: paymentId },
      });
    }

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

    this.events?.track('payment_success', {
      userId,
      props: {
        payment_id: paymentId,
        amount: Number(paymentRow.rows[0]?.amount || 0),
        tokens: tokensToAdd,
      },
    });
  }

  // Реконсиляция «зависших» pending-платежей (safety-net к вебхуку). Раз в 30 мин
  // опрашиваем YooKassa по pending старше 15 мин и:
  //  • succeeded → processSucceededPayment (идемпотентно начисляет токены+реф,
  //    ставит succeeded) — ловит ПРОПУЩЕННЫЕ вебхуки («оплатил, а токенов нет») + TG-алерт;
  //  • canceled  → помечаем canceled (чистим админку от мёртвых брошенных корзин).
  // Свежие pending (<15 мин) не трогаем — идёт оплата/вебхук. Отключается PAYMENT_RECONCILE_DISABLED=1.
  @Cron('0 9,39 * * * *')
  async reconcilePendingPayments(): Promise<void> {
    if (process.env.PAYMENT_RECONCILE_DISABLED === '1') return;
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) return;
    let rows: Array<{ payment_id: string; user_id: string }>;
    try {
      rows = (await this.pg.query(
        `SELECT payment_id, user_id FROM payments
          WHERE status = 'pending' AND created_at < now() - interval '15 minutes'
          ORDER BY created_at DESC LIMIT 100`,
      )).rows as any;
    } catch (e: any) {
      this.logger.error(`reconcile query failed: ${e.message}`);
      return;
    }
    if (!rows.length) return;
    let credited = 0, canceled = 0;
    for (const p of rows) {
      try {
        const resp = await axios.get(`https://api.yookassa.ru/v3/payments/${p.payment_id}`, {
          auth: { username: shopId, password: secretKey }, timeout: 10000, validateStatus: () => true,
        });
        if (resp.status >= 400) continue; // 404/purged — пропускаем
        const st = resp.data?.status;
        if (st === 'succeeded') {
          const uid = resp.data?.metadata?.userId || p.user_id;
          await this.processSucceededPayment(p.payment_id, uid); // идемпотентно
          credited++;
          this.logger.warn(`reconcile: payment ${p.payment_id} PAID but was stuck pending — credited user ${uid}`);
          await sendTelegramAlert(
            `⚠️ <b>Платёж-реконсиляция</b>: ${p.payment_id} оплачен в YooKassa, но завис в pending (пропущенный вебхук). Токены начислены юзеру ${uid}.`,
          ).catch(() => {});
        } else if (st === 'canceled') {
          await this.pg.query(
            `UPDATE payments SET status='canceled', updated_at=now() WHERE payment_id=$1 AND status='pending'`,
            [p.payment_id],
          );
          canceled++;
        }
      } catch (e: any) {
        this.logger.warn(`reconcile ${p.payment_id} failed: ${e.message}`);
      }
    }
    if (credited || canceled) {
      this.logger.log(`payment reconcile: stuck-paid credited=${credited}, marked-canceled=${canceled}, checked=${rows.length}`);
    }
  }

  async getLatestPayment(userId: string): Promise<any | null> {
    const res = await this.pg.query(
      'SELECT payment_id, status FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId],
    );
    return res.rows[0] || null;
  }

  private tokensForPackage(pkg: string, amount: number): number {
    const map: Record<string, number> = {
      basic: 50000,
      starter: 50000,
      standard: 200000,
      extended: 200000,
      premium: 1000000,
      professional: 1000000,
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
