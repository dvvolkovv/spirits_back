import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { PaymentsService } from './payments.service';

/**
 * Приём криптоплатежей через «Приём» (priem.io) — для пользователей, которым
 * недоступна YooKassa. Рублёвый путь не затрагивается.
 *
 * Порядок такой: сервер создаёт платёж, ведёт клиента на paymentUrl, а об
 * оплате узнаёт из коллбэка с подписью HMAC-SHA256. Зачисление идёт через
 * PaymentsService.processSucceededPayment — он уже идемпотентен и делает бонус
 * первой оплаты, реферальную комиссию и события. Дублировать это здесь нельзя:
 * разъедется при первой же правке одной из веток.
 */

export interface PriemPackage {
  id: string;
  tokens: number;
  usd: number;
}

/**
 * Долларовые пакеты. Намеренно НЕ конвертируются из рублёвых.
 *
 * Комиссия сети не зависит от суммы, поэтому на мелком чеке она разорительна:
 * по замерам «Приёма» на $5 это +16% в TRON и +19% в Ethereum. Плюс оплата
 * картой у них недоступна ниже $10 — кнопка просто не показывается. Рублёвые
 * пакеты в пересчёте дают $1.86 и $6.24, то есть два из трёх были бы витриной,
 * отпугивающей комиссией. Поэтому за криптовалюту продаём только крупные.
 */
export const PRIEM_PACKAGES: PriemPackage[] = [
  { id: 'pro_usd', tokens: 1_000_000, usd: 25 },
  { id: 'max_usd', tokens: 2_500_000, usd: 49 },
];

/** Состояние, по которому и только по которому отгружаем заказ. */
const SETTLED = 'settled';

/** Допустимый возраст подписи. Старше — это повтор перехваченного запроса. */
const SIGNATURE_MAX_AGE_SEC = 300;

/** Состояния, после которых опрашивать платёж больше незачем. */
const TERMINAL_FAILED = ['expired', 'failed', 'refunded'];

/**
 * Сколько ждать до отказа от опроса. Коллбэк «Приём» повторяет 33 часа; берём
 * с запасом, но не бесконечно — иначе брошенные счета будут опрашиваться вечно.
 */
const POLL_WINDOW_HOURS = 72;

/** Сколько платежей опрашивать за один проход, чтобы не долбить их API. */
const POLL_BATCH = 20;

@Injectable()
export class PriemService {
  private readonly logger = new Logger(PriemService.name);
  private readonly apiUrl = process.env.PRIEM_API_URL || 'https://api.priem.io';

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly payments?: PaymentsService,
  ) {}

  private get apiKey(): string {
    return process.env.PRIEM_API_KEY || '';
  }

  private get webhookSecret(): string {
    return process.env.PRIEM_WEBHOOK_SECRET || '';
  }

  configured(): boolean {
    return !!this.apiKey && !!this.webhookSecret;
  }

  packages(): PriemPackage[] {
    return PRIEM_PACKAGES;
  }

  /**
   * Создаёт платёж и возвращает ссылку, на которую надо отправить клиента.
   *
   * Строка в payments заводится ДО обращения к «Приёму»: idempotencyKey должен
   * быть нашим и переживать повтор запроса. Если их API не ответит, строка
   * останется в pending, и повторная попытка с тем же ключом вернёт тот же
   * платёж, а не выставит второй счёт.
   */
  async createPayment(userId: string, packageId: string): Promise<{ paymentId: string; paymentUrl: string }> {
    const pkg = PRIEM_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) throw new Error(`неизвестный пакет: ${packageId}`);
    if (!this.apiKey) throw new Error('PRIEM_API_KEY не задан');

    // Ключ идемпотентности — наш номер заказа. Не время и не случайность:
    // такой ключ не защищает от того, ради чего заведён.
    const idempotencyKey = `linkeon-${randomUUID()}`;

    await this.pg.query(
      `INSERT INTO payments (user_id, payment_id, package_id, amount, tokens, status, provider, currency, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'priem', 'USD', $6)`,
      [userId, idempotencyKey, pkg.id, pkg.usd, pkg.tokens, idempotencyKey],
    );

    let data: any;
    try {
      const resp = await axios.post(
        `${this.apiUrl}/v1/payments`,
        {
          amount: pkg.usd.toFixed(2), // строкой, не числом — так требует API
          currency: 'USD',
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 20_000,
        },
      );
      data = resp.data;
    } catch (e: any) {
      const body = e?.response?.data;
      this.logger.error(`создание платежа не удалось: ${e.message} ${body ? JSON.stringify(body) : ''}`);
      throw new Error(body?.message || 'не удалось создать платёж');
    }

    if (!data?.id || !data?.paymentUrl) {
      throw new Error('ответ «Приёма» без id или paymentUrl');
    }

    // Настоящий идентификатор платежа приходит от них — по нему придёт коллбэк.
    // Наш ключ остаётся в idempotency_key.
    await this.pg.query(
      `UPDATE payments SET payment_id = $1, payment_url = $2, updated_at = now() WHERE idempotency_key = $3`,
      [data.id, data.paymentUrl, idempotencyKey],
    );

    this.logger.log(`платёж ${data.id} на $${pkg.usd} создан для ${userId} (пакет ${pkg.id})`);
    return { paymentId: data.id, paymentUrl: data.paymentUrl };
  }

  /**
   * Проверка подписи коллбэка.
   *
   * rawBody — именно те байты, что пришли. Разобранный и собранный обратно JSON
   * подпись не пройдёт: изменится порядок ключей или пробелы.
   */
  verifySignature(rawBody: Buffer | string, timestamp: string | undefined, signature: string | undefined): boolean {
    if (!this.webhookSecret || !timestamp || !signature) return false;

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    // Сравнение за постоянное время: обычное === выдаёт длину общего префикса.
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    return Number.isFinite(age) && age <= SIGNATURE_MAX_AGE_SEC;
  }

  /**
   * Обработка коллбэка. Возвращает true, если платёж зачислен.
   *
   * Отгружаем строго по state === 'settled', а не по факту прихода коллбэка:
   * промежуточные состояния (detected, confirming, converting) означают, что
   * деньги ещё в пути. Повторный коллбэк по тому же платежу безопасен —
   * processSucceededPayment выходит сразу, если статус уже succeeded.
   */
  async handleCallback(payload: any): Promise<boolean> {
    const paymentId = String(payload?.paymentId || '');
    const state = String(payload?.state || '');
    if (!paymentId) {
      this.logger.warn('коллбэк без paymentId — игнорирую');
      return false;
    }

    if (state !== SETTLED) {
      this.logger.log(`платёж ${paymentId} в состоянии ${state} — не зачисляю`);
      return false;
    }

    const row = await this.pg.query(
      `SELECT user_id, status FROM payments WHERE payment_id = $1 AND provider = 'priem'`,
      [paymentId],
    );
    if (row.rows.length === 0) {
      // Чужой или неизвестный платёж. Отвечаем 2xx (иначе будут повторять
      // 33 часа), но не зачисляем.
      this.logger.warn(`коллбэк по неизвестному платежу ${paymentId}`);
      return false;
    }

    const { user_id: userId, status } = row.rows[0];
    if (status === 'succeeded') {
      this.logger.log(`платёж ${paymentId} уже зачислен — повтор коллбэка`);
      return true;
    }

    if (!this.payments) {
      this.logger.error('PaymentsService недоступен — зачислить нечем');
      return false;
    }
    await this.payments.processSucceededPayment(paymentId, userId);
    this.logger.log(`платёж ${paymentId} зачислен пользователю ${userId}`);
    return true;
  }

  /**
   * Страховка на случай, когда коллбэк не дошёл.
   *
   * Заведена по факту: 2026-08-08 платёж 3426dc27 дошёл у «Приёма» до settled,
   * а коллбэк к нам не пришёл ни разу за 33 часа, отведённые на повторы. Их же
   * документация предупреждает: «не полагайтесь на один лишь коллбэк». Без
   * опроса такой платёж висит в pending, пока кто-то не заметит руками — для
   * приёма денег это неприемлемо.
   *
   * Сбой доставки после этого перестаёт быть потерей платежа и становится
   * задержкой на пару минут.
   */
  @Cron('0 */2 * * * *')
  async pollPendingPayments(): Promise<void> {
    if (!this.apiKey) return;

    const rows = await this.pg.query(
      `SELECT payment_id FROM payments
        WHERE provider = 'priem'
          AND status = 'pending'
          AND created_at > now() - ($1 || ' hours')::interval
          -- строки, где создание в «Приёме» не удалось: payment_id так и остался
          -- нашим ключом идемпотентности, опрашивать по нему нечего
          AND payment_id NOT LIKE 'linkeon-%'
        ORDER BY created_at
        LIMIT $2`,
      [POLL_WINDOW_HOURS, POLL_BATCH],
    );
    if (rows.rows.length === 0) return;

    for (const row of rows.rows) {
      const id = row.payment_id;
      try {
        const state = await this.syncPayment(id);
        if (state && TERMINAL_FAILED.includes(state)) {
          // Больше не опрашиваем: деньги не придут.
          await this.pg.query(
            `UPDATE payments SET status = 'failed', updated_at = now() WHERE payment_id = $1 AND status = 'pending'`,
            [id],
          );
          this.logger.log(`платёж ${id} в состоянии ${state} — помечен failed`);
        }
      } catch (e: any) {
        this.logger.warn(`опрос ${id} не удался: ${e.message}`);
      }
    }
  }

  /**
   * Опрос состояния платежа. Нужен как страховка: коллбэк повторяется семь раз
   * в течение полутора суток, и если сервер лежал дольше, состояние придётся
   * забрать самим. Состояние в API всегда актуально.
   */
  async syncPayment(paymentId: string): Promise<string | null> {
    if (!this.apiKey) return null;
    try {
      const resp = await axios.get(`${this.apiUrl}/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 15_000,
      });
      const state = String(resp.data?.state || '');
      if (state === SETTLED) await this.handleCallback({ paymentId, state });
      return state || null;
    } catch (e: any) {
      // Чужой и несуществующий платёж отвечают одинаково — 404.
      this.logger.warn(`опрос платежа ${paymentId} не удался: ${e.message}`);
      return null;
    }
  }
}
