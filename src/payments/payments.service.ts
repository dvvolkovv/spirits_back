import { Injectable, Logger, Optional, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { ReferralService } from '../referral/referral.service';
import { EventsService } from '../events/events.service';
import { creditWithBonus, OFFER_MSG_THRESHOLD } from '../offer/offer-bonus';
import { sendTelegramAlert } from '../common/telegram-alert';
import { resolvePackage } from './packages';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly referralService: ReferralService,
    @Optional() private readonly events?: EventsService,
  ) {}

  // Глобальный npm run migrate на проде застрял на base/001 и не докатывает
  // ничего после — из-за этого 001_priem_provider.sql и 002_backfill катали
  // руками. Модульный раннер, как в tg-bot: идемпотентный SQL при старте.
  async onModuleInit() {
    await this.applyMigration('003_payment_attempts.sql');
  }

  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'payments', 'migrations', filename),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`payments migration ${filename} applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`payments migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn(`payments migration ${filename} not found, skipping`);
  }

  async createPayment(userId: string, amount: number, pkg: string) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) throw new Error('YooKassa not configured');

    const idempotenceKey = uuidv4();
    const baseReturnUrl = process.env.RETURN_URL || 'https://my.linkeon.io/payment/success';
    // First create payment, then use real payment_id in return URL
    // YooKassa allows return_url with user_id; payment_id stored in localStorage on frontend
    let resp: any;
    try {
      resp = await axios.post(
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
    } catch (e: any) {
      // Тело ответа провайдера — единственное место, где написана причина.
      // Инцидент 14.08.2026: 403 означал status=disabled у магазина, но и лог,
      // и ответ пользователю несли только «Internal server error», поэтому два
      // дня никто не понимал, что оплаты не работают.
      const status = e?.response?.status ?? null;
      const body = e?.response?.data;
      const detail = body ? JSON.stringify(body) : e.message;
      this.logger.error(`yookassa create-payment failed: HTTP ${status ?? '—'} ${detail}`);
      await this.recordAttempt({
        userId, provider: 'yookassa', packageId: pkg, amount, currency: 'RUB',
        ok: false, httpStatus: status, error: detail,
      });
      // 503, а не 500: у нас всё исправно, недоступен внешний провайдер.
      // Пользователю нужен понятный текст, а не пятисотка.
      throw new ServiceUnavailableException({
        error: 'payment_provider_unavailable',
        message: 'Оплата временно недоступна. Мы уже знаем о проблеме — попробуйте позже.',
      });
    }

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

    // Успех тоже пишем: без него «три отказа подряд» не отличить от «три отказа
    // за месяц вперемешку с успехами», а мониторинг должен будить только на
    // первом.
    await this.recordAttempt({
      userId, provider: 'yookassa', packageId: pkg, amount, currency: 'RUB',
      ok: true, httpStatus: 200, paymentId: resp.data.id,
    });

    return {
      payment_id: resp.data.id,
      confirmation_url: confirmUrl,
    };
  }

  /**
   * Журнал попыток оплаты. Никогда не роняет сам платёж: если запись не
   * удалась, пользователь всё равно должен получить ссылку (или внятную
   * ошибку), а не пятисотку из-за мониторинга.
   */
  private async recordAttempt(a: {
    userId: string; provider: string; packageId?: string | null;
    amount?: number | null; currency?: string | null; ok: boolean;
    httpStatus?: number | null; error?: string | null; paymentId?: string | null;
  }): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO payment_attempts (user_id, provider, package_id, amount, currency, ok, http_status, error, payment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          a.userId, a.provider, a.packageId ?? null, a.amount ?? null, a.currency ?? null,
          a.ok, a.httpStatus ?? null, a.error ? String(a.error).slice(0, 2000) : null,
          a.paymentId ?? null,
        ],
      );
    } catch (e: any) {
      this.logger.warn(`payment_attempts insert failed: ${e.message}`);
    }
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
      'SELECT tokens, user_id, amount, package_id, provider, currency FROM payments WHERE payment_id = $1',
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
    // Через add_user_tokens, а не прямым UPDATE: процедура заодно пишет строку
    // в token_transactions с balance_after. Без неё пополнений в истории не было
    // вовсе — на 2026-08-08 в таблице 29 840 списаний и НОЛЬ покупок, то есть
    // пользователь видел, как токены тают, но не видел, откуда они взялись.
    const payRow = paymentRow.rows[0] || {};
    await this.pg.query(
      `SELECT add_user_tokens($1, $2, 'purchase', $3, $4::jsonb)`,
      [
        userId,
        credit,
        `Пополнение: ${payRow.package_id || 'пакет'}`,
        JSON.stringify({
          payment_id: paymentId,
          provider: payRow.provider || 'yookassa',
          amount: Number(payRow.amount || 0),
          currency: payRow.currency || 'RUB',
          base_tokens: tokensToAdd,
          bonus_tokens: credit - tokensToAdd,
        }),
      ],
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

  /**
   * Сколько токенов начислить за пакет.
   *
   * Объём приходит из общего модуля прайса. Своя карта здесь была третьей
   * копией и 08.04.2026 подвела: `starter` в ней отсутствовал, сработал
   * откат, и десять человек получили по 149 000 токенов вместо 50 000.
   *
   * Откат по сумме сейчас НЕДОСТИЖИМ: единственный путь сюда — createPayment,
   * а его зовёт только контроллер, который уже отверг незнакомый пакет
   * отказом 400. Он оставлен вторым слоем на случай, если этот гард когда-то
   * уберут или появится второй вызывающий.
   *
   * Не заменять на throw: платёж в YooKassa создаётся выше по коду, а строка
   * в payments пишется ниже. Исключение здесь оставило бы висящий счёт, за
   * который можно заплатить и ничего не получить, — это хуже неверного числа.
   * Поэтому вместо падения громкий лог: срабатывание отката означает, что
   * инвариант нарушен и разбираться надо немедленно.
   */
  private tokensForPackage(pkg: string, amount: number): number {
    const known = resolvePackage(pkg);
    if (known) return known.tokens;

    this.logger.error(
      `tokensForPackage: пакет "${pkg}" не найден в прайсе — начисляю по сумме ${amount}. ` +
        'Это не должно происходить: контроллер отвергает незнакомые пакеты раньше.',
    );
    return Math.floor((amount || 0) * 1000);
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

  /**
   * Применение промокода.
   *
   * Транзакция и `FOR UPDATE` на строке купона нужны не ради самой строки, а
   * ради сериализации: проверка «уже применял?» и вставка иначе разъезжаются
   * между параллельными запросами. Один клик, разошедшийся в три запроса,
   * 05.03.2026 начислил пользователю 79035281880 три миллиона токенов вместо
   * одного — в coupon_redemptions легли три строки с совпадающим до
   * микросекунды временем. По базе таких случаев шесть, лишнего роздано
   * 2 300 000 токенов.
   *
   * Уникального индекса на (coupon_id, user_id) нет: в таблице живут те самые
   * исторические дубли, и повесить его без удаления истории нельзя (решение
   * владельца — историю не трогать). Значит вся защита здесь: блокировка
   * держится до COMMIT, и второй запрос входит в критическую секцию уже после
   * вставки первого — то есть видит её.
   */
  async redeemCoupon(userId: string, code: string) {
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        'SELECT * FROM coupons WHERE code = $1 AND is_active = true LIMIT 1 FOR UPDATE',
        [code],
      );
      if (!res.rows.length) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Invalid coupon' };
      }
      const coupon = res.rows[0];

      const redeemed = await client.query(
        'SELECT id FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2',
        [coupon.id, userId],
      );
      if (redeemed.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Coupon already redeemed' };
      }

      const tokens = Number(coupon.token_amount);
      await client.query(
        'INSERT INTO coupon_redemptions (coupon_id, user_id, tokens_granted) VALUES ($1, $2, $3)',
        [coupon.id, userId, tokens],
      );
      await client.query(
        'UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1',
        [coupon.id],
      );
      // Через процедуру — чтобы купон тоже попал в историю пополнений.
      await client.query(
        `SELECT add_user_tokens($1, $2, 'coupon', $3, $4::jsonb)`,
        [userId, tokens, 'Промокод', JSON.stringify({ coupon_id: coupon.id })],
      );

      await client.query('COMMIT');
      return { success: true, tokens_added: tokens };
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      this.logger.error(`redeemCoupon failed (${code} → ${userId}): ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }
}
