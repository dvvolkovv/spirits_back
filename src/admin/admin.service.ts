import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class AdminService {
  constructor(private readonly pg: PgService) {}

  // --- Coupons ---

  async listCoupons() {
    const res = await this.pg.query('SELECT * FROM coupons ORDER BY created_at DESC');
    return res.rows.map(r => ({
      ...r,
      token_amount: Number(r.token_amount),
    }));
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
    const leadersRes = await this.pg.query(
      `SELECT rl.*,
        pl.name AS parent_name,
        (SELECT COUNT(*) FROM referral_referees rr WHERE rr.leader_id = rl.id) AS total_referees
       FROM referral_leaders rl
       LEFT JOIN referral_leaders pl ON pl.id = rl.parent_leader_id
       ORDER BY rl.created_at DESC`,
    );

    const leaders = await Promise.all(leadersRes.rows.map(async (l) => {
      // Get commissions (referees) for this leader
      const refsRes = await this.pg.query(
        'SELECT * FROM referral_referees WHERE leader_id = $1 ORDER BY registered_at DESC',
        [l.id],
      );
      const commissions = refsRes.rows.map(r => ({
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
        id: l.id,
        name: l.name,
        slug: l.slug,
        user_phone: l.user_phone,
        parent_name: l.parent_name || null,
        parent_leader_id: l.parent_leader_id || null,
        level: l.level || 1,
        commission_pct: Number(l.commission_pct) || 10,
        parent_commission_pct: Number(l.parent_commission_pct) || 0,
        is_active: l.is_active,
        total_referees: parseInt(l.total_referees) || 0,
        total_commission_rub: 0,
        paid_out_rub: 0,
        pending_rub: 0,
        commissions,
      };
    }));

    return {
      summary: {
        total_commission_all_rub: 0,
        total_paid_out_rub: 0,
        total_pending_rub: 0,
      },
      leaders,
    };
  }

  async createReferralLeader(data: any) {
    const res = await this.pg.query(
      `INSERT INTO referral_leaders (name, slug, user_phone, level, commission_pct, parent_commission_pct, parent_leader_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.name,
        data.slug,
        data.user_phone || null,
        data.level || 1,
        data.commission_pct || 10,
        data.parent_commission_pct || 0,
        data.parent_leader_id || null,
      ],
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

  async markPaid(commissionId: string) {
    return { success: true, id: commissionId };
  }

  async markAllPaid(leaderId: string) {
    return { success: true };
  }
}
