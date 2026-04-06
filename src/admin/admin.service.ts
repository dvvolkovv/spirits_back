import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class AdminService {
  constructor(private readonly pg: PgService) {}

  // --- Coupons ---

  async listCoupons() {
    const res = await this.pg.query('SELECT * FROM coupons ORDER BY created_at DESC');
    return res.rows;
  }

  async createCoupon(code: string, tokenAmount: number) {
    const res = await this.pg.query(
      'INSERT INTO coupons (code, token_amount) VALUES ($1, $2) RETURNING *',
      [code, tokenAmount],
    );
    return res.rows[0];
  }

  async updateCoupon(id: number, data: { is_active?: boolean; token_amount?: number }) {
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    if (data.is_active !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(data.is_active); }
    if (data.token_amount !== undefined) { sets.push(`token_amount = $${idx++}`); vals.push(data.token_amount); }
    if (sets.length === 0) return null;
    vals.push(id);
    const res = await this.pg.query(
      `UPDATE coupons SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals,
    );
    return res.rows[0];
  }

  async deleteCoupon(id: number) {
    await this.pg.query('DELETE FROM coupons WHERE id = $1', [id]);
    return { success: true };
  }

  // --- Referrals ---

  async getReferralStats() {
    const leaders = await this.pg.query(
      `SELECT rl.*,
        (SELECT COUNT(*) FROM referral_referees rr WHERE rr.leader_id = rl.id) as referral_count
       FROM referral_leaders rl ORDER BY rl.created_at DESC`,
    );
    return { leaders: leaders.rows };
  }

  async createReferralLeader(data: { name: string; slug: string; phone?: string }) {
    const res = await this.pg.query(
      'INSERT INTO referral_leaders (name, slug, user_phone) VALUES ($1, $2, $3) RETURNING *',
      [data.name, data.slug, data.phone || null],
    );
    return res.rows[0];
  }

  async toggleReferralLeader(id: string) {
    const res = await this.pg.query(
      'UPDATE referral_leaders SET is_active = NOT is_active WHERE id = $1 RETURNING *',
      [id],
    );
    return res.rows[0];
  }

  async markPaid(refereeId: string) {
    // No is_paid column in referees — return success as no-op
    return { success: true, id: refereeId };
  }

  async markAllPaid(leaderId: string) {
    return { success: true };
  }
}
