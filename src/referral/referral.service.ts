import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class ReferralService {
  constructor(private readonly pg: PgService) {}

  async register(userId: string, slug: string) {
    const leader = await this.pg.query(
      'SELECT * FROM referral_leaders WHERE slug = $1 AND is_active = true LIMIT 1',
      [slug],
    );
    if (!leader.rows.length) return { success: false, error: 'Invalid referral link' };

    await this.pg.query(
      `INSERT INTO referral_referees (referee_phone, leader_id, registered_at)
       VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [userId, leader.rows[0].id],
    );
    return { success: true };
  }

  async getStats(userId: string) {
    const leader = await this.pg.query(
      'SELECT * FROM referral_leaders WHERE user_phone = $1 LIMIT 1',
      [userId],
    );
    if (!leader.rows.length) return { referrals: 0, earnings: 0, isLeader: false };

    const l = leader.rows[0];
    const refs = await this.pg.query(
      'SELECT * FROM referral_referees WHERE leader_id = $1 ORDER BY registered_at DESC',
      [l.id],
    );

    const referees = refs.rows.map(r => ({
      phone: r.referee_phone,
      registered_at: r.registered_at,
      total_spent: 0,
      commission: 0,
    }));

    const commissions = refs.rows.map(r => ({
      id: r.id,
      date: r.registered_at,
      referee_phone: r.referee_phone,
      payment_amount: 0,
      commission_pct: Number(l.commission_pct) || 10,
      commission_rub: 0,
      level: 1,
      paid_out: false,
    }));

    return {
      referral_link: `https://b.linkeon.io/?ref=${l.slug}`,
      leader: {
        name: l.name,
        slug: l.slug,
        level: l.level || 1,
        commission_pct: Number(l.commission_pct) || 10,
      },
      total_referees: refs.rows.length,
      total_paid_rub: 0,
      total_commission_rub: 0,
      pending_rub: 0,
      paid_out_rub: 0,
      commission_breakdown: {
        direct_commission_rub: 0,
        direct_pct: Number(l.commission_pct) || 10,
        upstream_commission_rub: 0,
        upstream_pct: Number(l.parent_commission_pct) || 0,
      },
      referees,
      commissions,
    };
  }
}
