import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(private readonly pg: PgService) {}

  async register(userId: string, slug: string) {
    const leader = await this.pg.query(
      'SELECT * FROM referral_leaders WHERE slug = $1 AND is_active = true LIMIT 1',
      [slug],
    );
    if (!leader.rows.length) return { success: false, error: 'Invalid referral link' };

    // Check if already registered as referee
    const existing = await this.pg.query(
      'SELECT id FROM referral_referees WHERE referee_phone = $1',
      [userId],
    );
    if (existing.rows.length) return { success: false, error: 'Already registered' };

    await this.pg.query(
      `INSERT INTO referral_referees (referee_phone, leader_id)
       VALUES ($1, $2) ON CONFLICT (referee_phone) DO NOTHING`,
      [userId, leader.rows[0].id],
    );
    return { success: true, leader_name: leader.rows[0].name };
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
  async processPaymentCommission(refereePhone: string, paymentId: string, amountRub: number): Promise<void> {
    // Find which leader referred this user
    const referee = await this.pg.query(
      'SELECT rr.leader_id, rl.commission_pct, rl.parent_leader_id, rl.parent_commission_pct FROM referral_referees rr JOIN referral_leaders rl ON rl.id = rr.leader_id WHERE rr.referee_phone = $1',
      [refereePhone],
    );
    if (!referee.rows.length) return;

    const { leader_id, commission_pct, parent_leader_id, parent_commission_pct } = referee.rows[0];

    // Level 1 commission (direct leader)
    const commissionRub = amountRub * (Number(commission_pct) / 100);
    await this.pg.query(
      `INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
       VALUES ($1, $2, $3, 1, $4, $5, $6)`,
      [leader_id, paymentId, refereePhone, amountRub, commission_pct, commissionRub],
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
  }
}
