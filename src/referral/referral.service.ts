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
      'SELECT * FROM referral_leaders WHERE slug = $1 OR name = $1 LIMIT 1',
      [userId],
    );
    if (!leader.rows.length) return { referrals: 0, earnings: 0 };

    const refs = await this.pg.query(
      'SELECT COUNT(*) as count FROM referral_referees WHERE leader_id = $1',
      [leader.rows[0].id],
    );
    return { referrals: parseInt(refs.rows[0].count), earnings: 0 };
  }
}
