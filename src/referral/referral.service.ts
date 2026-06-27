import { Injectable, Logger, OnModuleInit, BadRequestException, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { EventsService } from '../events/events.service';
import axios from 'axios';

// Двусторонний реф-бонус: приглашённому — стартовые токены при переходе по
// ссылке (у пригласившего «сторона» = существующая комиссия с оплат).
// REFEREE_BONUS_TOKENS — столько же, сколько welcome на старте (подтверждено владельцем 2026-06-19).
const REFEREE_BONUS_TOKENS = 20000;

// Курс/порог вывода реферальных комиссий токенами (подтверждено владельцем).
const PAYOUT_RATE_TOKENS_PER_RUB = 600;
const PAYOUT_MIN_RUB = 100;

// Вывод ДЕНЬГАМИ (заявка на ручную выплату командой). WITHDRAW_MIN_RUB —
// денежный параметр, поставлен по умолчанию 1000₽, подтвердить/изменить у владельца.
const WITHDRAW_MIN_RUB = 1000;
const WITHDRAW_METHODS = ['card', 'sbp'];

// Авто-тиры комиссии L1: % растёт по числу ОПЛАТИВШИХ рефери (подтверждено
// владельцем 2026-06-27). 0–4 → 10%, 5–14 → 12%, 15+ → 15%. Спец-сделки админа
// (leader.commission_pct выше тира) сохраняются — берём max. L2-parent % не трогаем.
const COMMISSION_TIERS: Array<{ min: number; pct: number }> = [
  { min: 15, pct: 15 },
  { min: 5, pct: 12 },
  { min: 0, pct: 10 },
];
export function tierPct(paidReferees: number): number {
  for (const t of COMMISSION_TIERS) if (paidReferees >= t.min) return t.pct;
  return 10;
}

@Injectable()
export class ReferralService implements OnModuleInit {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly events?: EventsService,
  ) {}

  async onModuleInit() {
    // Журнал выплат комиссий токенами (аудит + атомарность/идемпотентность).
    try {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS referral_token_payouts (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          leader_id uuid NOT NULL,
          user_phone varchar(20) NOT NULL,
          rub numeric(10,2) NOT NULL,
          tokens integer NOT NULL,
          rate integer NOT NULL,
          commission_ids uuid[] NOT NULL,
          created_at timestamptz DEFAULT now()
        )`);
    } catch (e: any) {
      this.logger.error(`referral_token_payouts migration failed: ${e.message}`);
    }
    // Заявки на вывод ДЕНЬГАМИ — команда обрабатывает вручную (DEV-1).
    try {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS referral_withdrawals (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          leader_id uuid NOT NULL,
          user_phone varchar(20) NOT NULL,
          amount_rub numeric(10,2) NOT NULL,
          method varchar(20) NOT NULL,
          requisites text NOT NULL,
          status varchar(20) NOT NULL DEFAULT 'pending',
          commission_ids uuid[] NOT NULL,
          created_at timestamptz DEFAULT now(),
          processed_at timestamptz,
          processed_by varchar(40)
        )`);
    } catch (e: any) {
      this.logger.error(`referral_withdrawals migration failed: ${e.message}`);
    }
    // Двусторонний бонус: сколько токенов начислено приглашённому (аудит/идемпотентность).
    try {
      await this.pg.query(`ALTER TABLE referral_referees ADD COLUMN IF NOT EXISTS bonus_tokens integer NOT NULL DEFAULT 0`);
    } catch (e: any) {
      this.logger.error(`referral_referees.bonus_tokens migration failed: ${e.message}`);
    }
    // Флаг «уже уведомили SMS о достижении порога вывода» (1 SMS на цикл накопления).
    try {
      await this.pg.query(`ALTER TABLE referral_leaders ADD COLUMN IF NOT EXISTS payout_notified boolean NOT NULL DEFAULT false`);
    } catch (e: any) {
      this.logger.error(`referral_leaders.payout_notified migration failed: ${e.message}`);
    }
  }

  // SMS лидеру при достижении порога вывода (>= WITHDRAW_MIN_RUB). Платный канал
  // оправдан на этой сумме (подтверждено владельцем). Один SMS на цикл: флаг
  // payout_notified сбрасывается при выводе. Только реальные номера (не oauth-id).
  private async sendSms(phone: string, text: string): Promise<boolean> {
    const login = process.env.SMSAERO_LOGIN, apiKey = process.env.SMSAERO_API_KEY;
    if (!login || !apiKey) return false;
    try {
      const auth = Buffer.from(`${login}:${apiKey}`).toString('base64');
      const resp = await axios.get('https://gate.smsaero.ru/v2/sms/send', {
        params: { number: phone, text, sign: 'SMSAero' },
        headers: { Authorization: `Basic ${auth}` }, timeout: 10000, validateStatus: () => true,
      });
      return resp.status < 400;
    } catch { return false; }
  }

  private async notifyPayoutIfReady(leaderId: string): Promise<void> {
    try {
      const r = await this.pg.query(
        `SELECT l.user_phone, l.payout_notified,
                COALESCE(SUM(c.commission_rub) FILTER (WHERE NOT c.paid_out), 0) AS pending
           FROM referral_leaders l LEFT JOIN referral_commissions c ON c.leader_id = l.id
          WHERE l.id = $1 GROUP BY l.user_phone, l.payout_notified`,
        [leaderId],
      );
      const row = r.rows[0];
      if (!row || row.payout_notified) return;
      const pending = Math.round(Number(row.pending) * 100) / 100;
      const phone = String(row.user_phone || '');
      if (pending < WITHDRAW_MIN_RUB) return;
      if (!/^\d{10,15}$/.test(phone)) return; // не SMS-абельный (oauth/email id)
      const ok = await this.sendSms(phone, `Linkeon: у вас ${pending} руб. реферального вознаграждения. Вывести деньгами или токенами — в приложении: профиль, раздел «Рефералы».`);
      if (ok) {
        await this.pg.query('UPDATE referral_leaders SET payout_notified = true WHERE id = $1', [leaderId]);
        this.events?.track('referral_payout_sms', { userId: phone, props: { leader_id: leaderId, pending } });
        this.logger.log(`referral payout SMS → ${phone}: ${pending}₽`);
      }
    } catch (e: any) {
      this.logger.warn(`notifyPayoutIfReady failed: ${e.message}`);
    }
  }

  // DEV-1: заявка на вывод накопленных комиссий ДЕНЬГАМИ. Резервирует комиссии
  // (paid_out=true) в той же транзакции — исключает двойной вывод (и деньгами, и
  // токенами). Реальная выплата — вручную командой; статус ведётся в
  // referral_withdrawals. DEV-2: после создания — Telegram-уведомление команде.
  async requestWithdrawal(userId: string, method: string, requisites: string): Promise<{ id: string; amount_rub: number; status: string }> {
    method = String(method || '').trim().toLowerCase();
    requisites = String(requisites || '').trim();
    if (!WITHDRAW_METHODS.includes(method)) {
      throw new BadRequestException(`Способ вывода: ${WITHDRAW_METHODS.join(' / ')}`);
    }
    if (requisites.length < 4) throw new BadRequestException('Укажите реквизиты для вывода');

    const leaderRes = await this.pg.query('SELECT id FROM referral_leaders WHERE user_phone = $1 LIMIT 1', [userId]);
    const leaderId = leaderRes.rows[0]?.id;
    if (!leaderId) throw new BadRequestException('Реферальный аккаунт не найден');

    const client = await this.pg.getClient();
    let row: { id: string; amount_rub: number };
    try {
      await client.query('BEGIN');
      const unpaid = await client.query(
        `SELECT id, commission_rub FROM referral_commissions
          WHERE leader_id = $1 AND paid_out = false FOR UPDATE`,
        [leaderId],
      );
      const rub = Math.round(unpaid.rows.reduce((s, r) => s + (Number(r.commission_rub) || 0), 0) * 100) / 100;
      if (rub < WITHDRAW_MIN_RUB) {
        await client.query('ROLLBACK');
        throw new BadRequestException(`Минимум для вывода деньгами — ${WITHDRAW_MIN_RUB} ₽ (у вас ${rub} ₽)`);
      }
      const ids = unpaid.rows.map((r) => r.id);
      await client.query('UPDATE referral_commissions SET paid_out = true WHERE id = ANY($1)', [ids]);
      await client.query('UPDATE referral_leaders SET payout_notified = false WHERE id = $1', [leaderId]);
      const ins = await client.query(
        `INSERT INTO referral_withdrawals (leader_id, user_phone, amount_rub, method, requisites, commission_ids)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, amount_rub`,
        [leaderId, userId, rub, method, requisites, ids],
      );
      await client.query('COMMIT');
      row = { id: ins.rows[0].id, amount_rub: Number(ins.rows[0].amount_rub) };
      this.logger.log(`referral withdrawal request: ${userId} ${rub}₽ via ${method} (id ${row.id})`);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }

    // DEV-2: оперативное уведомление команде (fire-and-forget, не блокирует ответ).
    if (telegramConfigured()) {
      const text =
        `💸 <b>Заявка на вывод реф-средств</b>\n` +
        `Лидер: <code>${userId}</code>\n` +
        `Сумма: <b>${row.amount_rub} ₽</b>\n` +
        `Способ: ${method} · реквизиты: <code>${requisites}</code>\n` +
        `Заявка: <code>${row.id}</code>\n` +
        `Обработать: admin → Рефералы (mark paid/rejected)`;
      sendTelegramAlert(text).catch((e) => this.logger.warn(`withdrawal TG notify failed: ${e.message}`));
    }
    return { id: row.id, amount_rub: row.amount_rub, status: 'pending' };
  }

  // Админ: список заявок (по статусу или все).
  async listWithdrawals(status?: string): Promise<any[]> {
    const params: any[] = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE status = $1`; }
    const r = await this.pg.query(
      `SELECT id, user_phone, amount_rub, method, requisites, status, created_at, processed_at, processed_by
         FROM referral_withdrawals ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    return r.rows;
  }

  // Админ: обработать заявку. paid -> выплачено; rejected -> вернуть комиссии в пул.
  async processWithdrawal(id: string, decision: 'paid' | 'rejected', adminPhone: string): Promise<{ id: string; status: string }> {
    if (decision !== 'paid' && decision !== 'rejected') throw new BadRequestException('decision: paid | rejected');
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const w = await client.query('SELECT * FROM referral_withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (!w.rows[0]) { await client.query('ROLLBACK'); throw new BadRequestException('Заявка не найдена'); }
      if (w.rows[0].status !== 'pending') { await client.query('ROLLBACK'); throw new BadRequestException(`Заявка уже обработана (${w.rows[0].status})`); }
      if (decision === 'rejected') {
        // Вернуть зарезервированные комиссии в пул (доступны к повторному выводу).
        await client.query('UPDATE referral_commissions SET paid_out = false WHERE id = ANY($1)', [w.rows[0].commission_ids]);
      }
      await client.query(
        `UPDATE referral_withdrawals SET status = $1, processed_at = now(), processed_by = $2 WHERE id = $3`,
        [decision, adminPhone || 'admin', id],
      );
      await client.query('COMMIT');
      this.logger.log(`referral withdrawal ${id} -> ${decision} by ${adminPhone}`);
      return { id, status: decision };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Вывод накопленных невыплаченных комиссий ТОКЕНАМИ на баланс (мгновенно,
  // без модерации — внутренняя операция). Атомарно: зачисление токенов +
  // пометка комиссий paid_out + запись в журнал, в одной транзакции.
  async payoutTokens(userId: string): Promise<{ rub: number; tokens: number; newBalance: number }> {
    const leaderRes = await this.pg.query('SELECT id FROM referral_leaders WHERE user_phone = $1 LIMIT 1', [userId]);
    const leaderId = leaderRes.rows[0]?.id;
    if (!leaderId) throw new BadRequestException('Реферальный аккаунт не найден');

    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      // Блокируем невыплаченные комиссии этого лидера, чтобы исключить двойной вывод.
      const unpaid = await client.query(
        `SELECT id, commission_rub FROM referral_commissions
          WHERE leader_id = $1 AND paid_out = false FOR UPDATE`,
        [leaderId],
      );
      const rub = Math.round(unpaid.rows.reduce((s, r) => s + (Number(r.commission_rub) || 0), 0) * 100) / 100;
      if (rub < PAYOUT_MIN_RUB) {
        await client.query('ROLLBACK');
        throw new BadRequestException(`Минимум для вывода — ${PAYOUT_MIN_RUB} ₽ (у вас ${rub} ₽)`);
      }
      const tokens = Math.round(rub * PAYOUT_RATE_TOKENS_PER_RUB);
      const ids = unpaid.rows.map((r) => r.id);

      const bal = await client.query(
        'UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1 WHERE user_id = $2 RETURNING tokens',
        [tokens, userId],
      );
      if (!bal.rows[0]) {
        await client.query('ROLLBACK');
        throw new BadRequestException('Профиль не найден для зачисления токенов');
      }
      await client.query('UPDATE referral_commissions SET paid_out = true WHERE id = ANY($1)', [ids]);
      await client.query('UPDATE referral_leaders SET payout_notified = false WHERE id = $1', [leaderId]);
      await client.query(
        `INSERT INTO referral_token_payouts (leader_id, user_phone, rub, tokens, rate, commission_ids)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [leaderId, userId, rub, tokens, PAYOUT_RATE_TOKENS_PER_RUB, ids],
      );
      await client.query('COMMIT');
      this.logger.log(`referral payout tokens: ${userId} ${rub}₽ → ${tokens} tokens`);
      return { rub, tokens, newBalance: Number(bal.rows[0].tokens) || 0 };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async register(userId: string, slug: string) {
    const leader = await this.pg.query(
      'SELECT * FROM referral_leaders WHERE slug = $1 AND is_active = true LIMIT 1',
      [slug],
    );
    if (!leader.rows.length) return { success: false, error: 'Invalid referral link' };
    // Анти-абуз: нельзя пригласить самого себя (и получить бонус).
    if (leader.rows[0].user_phone === userId) return { success: false, error: 'Нельзя пригласить самого себя' };

    // Check if already registered as referee
    const existing = await this.pg.query(
      'SELECT id FROM referral_referees WHERE referee_phone = $1',
      [userId],
    );
    if (existing.rows.length) return { success: false, error: 'Already registered' };

    const ins = await this.pg.query(
      `INSERT INTO referral_referees (referee_phone, leader_id)
       VALUES ($1, $2) ON CONFLICT (referee_phone) DO NOTHING RETURNING id`,
      [userId, leader.rows[0].id],
    );

    // Двусторонний бонус: приглашённому — стартовые токены (один раз, только при
    // новой записи referee → не фармится повторными запросами).
    let bonusTokens = 0;
    if (ins.rows.length) {
      const bal = await this.pg.query(
        'UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1 WHERE user_id = $2 RETURNING tokens',
        [REFEREE_BONUS_TOKENS, userId],
      );
      if (bal.rows.length) {
        bonusTokens = REFEREE_BONUS_TOKENS;
        await this.pg.query('UPDATE referral_referees SET bonus_tokens = $1 WHERE referee_phone = $2', [bonusTokens, userId]);
        this.events?.track('referral_referee_bonus', { userId, props: { tokens: bonusTokens, leader_id: leader.rows[0].id } });
        this.logger.log(`referee bonus: ${userId} +${bonusTokens} tokens (leader ${leader.rows[0].id})`);
      }
    }
    return { success: true, leader_name: leader.rows[0].name, bonus_tokens: bonusTokens };
  }

  // Get the user's referral-leader row, creating one on first request so every
  // user has a shareable link (task bbb80368). We only supply name/slug/
  // user_phone — commission_pct (10), level (1), parent_commission_pct (0),
  // is_active are the program's schema defaults (marketing-agreed), NOT changed
  // here. slug = 8 hex chars (matches the slug CHECK ^[a-z0-9-]+$).
  private async getOrCreateLeader(userId: string): Promise<any> {
    const existing = await this.pg.query(
      'SELECT * FROM referral_leaders WHERE user_phone = $1 LIMIT 1',
      [userId],
    );
    if (existing.rows.length) return existing.rows[0];

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = (await this.pg.query(
        `SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 8) AS s`,
      )).rows[0].s as string;
      const taken = await this.pg.query('SELECT 1 FROM referral_leaders WHERE slug = $1', [slug]);
      if (taken.rows.length) continue;
      // Re-check user didn't get a row concurrently before inserting.
      const recheck = await this.pg.query('SELECT * FROM referral_leaders WHERE user_phone = $1 LIMIT 1', [userId]);
      if (recheck.rows.length) return recheck.rows[0];
      const ins = await this.pg.query(
        `INSERT INTO referral_leaders (name, slug, user_phone) VALUES ($1, $2, $3) RETURNING *`,
        [userId, slug, userId],
      );
      this.logger.log(`Auto-created self-serve referral leader for ${userId} (slug ${slug})`);
      return ins.rows[0];
    }
    throw new Error('could not allocate a unique referral slug');
  }

  async getStats(userId: string) {
    const l = await this.getOrCreateLeader(userId);

    // Get referees
    const refs = await this.pg.query(
      'SELECT * FROM referral_referees WHERE leader_id = $1 ORDER BY registered_at DESC',
      [l.id],
    );

    // Get commissions from referral_commissions table
    const commissionsRes = await this.pg.query(
      `SELECT * FROM referral_commissions WHERE leader_id = $1 ORDER BY created_at DESC`,
      [l.id],
    );

    const commissions = commissionsRes.rows.map(c => ({
      id: c.id,
      date: c.created_at,
      referee_phone: c.referee_phone,
      payment_amount: Number(c.payment_amount_rub) || 0,
      commission_pct: Number(c.commission_pct) || 0,
      commission_rub: Number(c.commission_rub) || 0,
      level: c.commission_level || 1,
      paid_out: c.paid_out || false,
    }));

    const totalCommission = commissions.reduce((s, c) => s + c.commission_rub, 0);
    const paidOut = commissions.filter(c => c.paid_out).reduce((s, c) => s + c.commission_rub, 0);
    const pending = totalCommission - paidOut;
    const totalPaid = commissions.reduce((s, c) => s + c.payment_amount, 0);

    const directCommissions = commissions.filter(c => c.level === 1);
    const upstreamCommissions = commissions.filter(c => c.level === 2);

    // Get referees with their total spend
    const referees = await Promise.all(refs.rows.map(async (r) => {
      const refCommissions = commissions.filter(c => c.referee_phone === r.referee_phone);
      return {
        phone: r.referee_phone,
        registered_at: r.registered_at,
        total_spent: refCommissions.reduce((s, c) => s + c.payment_amount, 0),
        commission: refCommissions.reduce((s, c) => s + c.commission_rub, 0),
      };
    }));

    return {
      referral_link: `https://my.linkeon.io/?ref=${l.slug}`,
      referee_bonus_tokens: REFEREE_BONUS_TOKENS,
      leader: {
        name: l.name,
        slug: l.slug,
        level: l.level || 1,
        commission_pct: Number(l.commission_pct) || 10,
      },
      total_referees: refs.rows.length,
      total_paid_rub: totalPaid,
      total_commission_rub: totalCommission,
      pending_rub: pending,
      paid_out_rub: paidOut,
      commission_breakdown: {
        direct_commission_rub: directCommissions.reduce((s, c) => s + c.commission_rub, 0),
        direct_pct: Number(l.commission_pct) || 10,
        upstream_commission_rub: upstreamCommissions.reduce((s, c) => s + c.commission_rub, 0),
        upstream_pct: Number(l.parent_commission_pct) || 0,
      },
      referees,
      commissions,
    };
  }

  /**
   * Called after successful payment to create referral commissions
   */
  // Число УНИКАЛЬНЫХ оплативших рефери лидера (по L1-комиссиям) ВКЛЮЧАЯ текущего —
  // для авто-тира комиссии. Текущий рефери добавляется через UNION, т.к. его
  // L1-строка ещё не вставлена в момент расчёта.
  private async countPaidReferees(leaderId: string, currentReferee: string): Promise<number> {
    const r = await this.pg.query(
      `SELECT COUNT(DISTINCT rp)::int AS n FROM (
         SELECT referee_phone AS rp FROM referral_commissions WHERE leader_id = $1 AND commission_level = 1
         UNION SELECT $2
       ) u`,
      [leaderId, currentReferee],
    );
    return Number((r.rows[0] as any)?.n || 1);
  }

  async processPaymentCommission(refereePhone: string, paymentId: string, amountRub: number): Promise<void> {
    // Find which leader referred this user
    const referee = await this.pg.query(
      'SELECT rr.leader_id, rl.commission_pct, rl.parent_leader_id, rl.parent_commission_pct FROM referral_referees rr JOIN referral_leaders rl ON rl.id = rr.leader_id WHERE rr.referee_phone = $1',
      [refereePhone],
    );
    if (!referee.rows.length) return;

    const { leader_id, commission_pct, parent_leader_id, parent_commission_pct } = referee.rows[0];

    // Level 1 commission (direct leader) — авто-тир по числу оплативших рефери
    // (включая текущего). max(тир, спец-сделка админа), чтобы не понижать ручные %.
    const paidReferees = await this.countPaidReferees(leader_id, refereePhone);
    const effectivePct = Math.max(tierPct(paidReferees), Number(commission_pct) || 0);
    const commissionRub = amountRub * (effectivePct / 100);
    await this.pg.query(
      `INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
       VALUES ($1, $2, $3, 1, $4, $5, $6)`,
      [leader_id, paymentId, refereePhone, amountRub, effectivePct, commissionRub],
    );

    // Level 2 commission (parent leader, if exists)
    if (parent_leader_id && Number(parent_commission_pct) > 0) {
      const upstreamRub = amountRub * (Number(parent_commission_pct) / 100);
      await this.pg.query(
        `INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
         VALUES ($1, $2, $3, 2, $4, $5, $6)`,
        [parent_leader_id, paymentId, refereePhone, amountRub, parent_commission_pct, upstreamRub],
      );
    }

    this.logger.log(`Commission created: payment=${paymentId}, referee=${refereePhone}, amount=${amountRub}, commission=${commissionRub}`);

    // SMS-уведомление лидерам, чьё накопление достигло порога вывода (>1000₽).
    await this.notifyPayoutIfReady(leader_id).catch(() => {});
    if (parent_leader_id && Number(parent_commission_pct) > 0) {
      await this.notifyPayoutIfReady(parent_leader_id).catch(() => {});
    }
  }
}
