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
      const commissionsRes = await this.pg.query(
        'SELECT * FROM referral_commissions WHERE leader_id = $1 ORDER BY created_at DESC',
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
        total_commission_rub: totalCommission,
        paid_out_rub: paidOut,
        pending_rub: totalCommission - paidOut,
        commissions,
      };
    }));

    const allCommissions = leaders.flatMap(l => l.commissions);
    return {
      summary: {
        total_commission_all_rub: allCommissions.reduce((s, c) => s + c.commission_rub, 0),
        total_paid_out_rub: allCommissions.filter(c => c.paid_out).reduce((s, c) => s + c.commission_rub, 0),
        total_pending_rub: allCommissions.filter(c => !c.paid_out).reduce((s, c) => s + c.commission_rub, 0),
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
    await this.pg.query(
      'UPDATE referral_commissions SET paid_out = true WHERE id = $1',
      [commissionId],
    );
    return { success: true };
  }

  async markAllPaid(leaderId: string) {
    await this.pg.query(
      'UPDATE referral_commissions SET paid_out = true WHERE leader_id = $1 AND paid_out = false',
      [leaderId],
    );
    return { success: true };
  }

  // --- Payments ---

  async listPayments(opts: { status?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const params: any[] = [limit];
    let where = '';
    if (opts.status && opts.status !== 'all') {
      params.push(opts.status);
      where = `WHERE p.status = $${params.length}`;
    }
    const res = await this.pg.query(
      `SELECT
         p.id, p.payment_id, p.user_id AS phone, p.package_id,
         p.amount, p.tokens, p.status,
         p.created_at, p.completed_at,
         rl.id AS referral_leader_id,
         rl.name AS referral_leader_name,
         rl.slug AS referral_leader_slug
       FROM payments p
       LEFT JOIN referral_referees rr ON rr.referee_phone = p.user_id
       LEFT JOIN referral_leaders rl ON rl.id = rr.leader_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $1`,
      params,
    );
    return res.rows.map(r => ({
      id: r.id,
      payment_id: r.payment_id,
      phone: r.phone,
      package_id: r.package_id,
      amount: Number(r.amount) || 0,
      tokens: Number(r.tokens) || 0,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
      referral_leader: r.referral_leader_id
        ? { id: r.referral_leader_id, name: r.referral_leader_name, slug: r.referral_leader_slug }
        : null,
    }));
  }

  // --- Tokens ---

  async getUsersTokensList(opts: { limit?: number; sortBy?: 'balance' | 'spent_period'; hours?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const hours = Math.min(Math.max(opts.hours ?? 24 * 30, 1), 24 * 365);
    const sortBy = opts.sortBy === 'spent_period' ? 'spent_period' : 'balance';

    const res = await this.pg.query(
      `SELECT
         a.user_id AS phone,
         a.created_at AS registered_at,
         COALESCE(a.tokens, 0)::bigint AS balance,
         COALESCE(spent_total.spent, 0)::bigint AS spent_total,
         COALESCE(spent_period.spent, 0)::bigint AS spent_period,
         COALESCE(spent_period.last_active, NULL) AS last_active,
         pay.paid_count::int AS paid_count,
         COALESCE(pay.paid_rub, 0)::numeric AS paid_rub,
         rl.name AS referral_leader_name
       FROM ai_profiles_consolidated a
       LEFT JOIN (
         SELECT user_id, ABS(SUM(amount)) AS spent
         FROM token_transactions
         WHERE transaction_type = 'consumed'
         GROUP BY user_id
       ) spent_total ON spent_total.user_id = a.user_id
       LEFT JOIN (
         SELECT user_id, ABS(SUM(amount)) AS spent, MAX(created_at) AS last_active
         FROM token_transactions
         WHERE transaction_type = 'consumed' AND created_at >= now() - make_interval(hours => $2)
         GROUP BY user_id
       ) spent_period ON spent_period.user_id = a.user_id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS paid_count, SUM(amount) AS paid_rub
         FROM payments
         WHERE status = 'succeeded'
         GROUP BY user_id
       ) pay ON pay.user_id = a.user_id
       LEFT JOIN referral_referees rr ON rr.referee_phone = a.user_id
       LEFT JOIN referral_leaders rl ON rl.id = rr.leader_id
       WHERE a.user_id IS NOT NULL
         ${sortBy === 'spent_period' ? 'AND COALESCE(spent_period.spent, 0) > 0' : ''}
       ORDER BY ${sortBy} DESC NULLS LAST
       LIMIT $1`,
      [limit, hours],
    );

    const totalsRes = await this.pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(a.tokens, 0) > 0) AS users_with_balance,
         COUNT(*) AS users_total,
         COALESCE(SUM(a.tokens), 0)::bigint AS total_balance
       FROM ai_profiles_consolidated a
       WHERE a.user_id IS NOT NULL`,
    );
    const t = totalsRes.rows[0] || {};

    return {
      hours,
      users: res.rows.map(r => ({
        phone: r.phone,
        registered_at: r.registered_at,
        balance: Number(r.balance) || 0,
        spent_total: Number(r.spent_total) || 0,
        spent_period: Number(r.spent_period) || 0,
        last_active: r.last_active,
        paid_count: Number(r.paid_count) || 0,
        paid_rub: Number(r.paid_rub) || 0,
        referral_leader_name: r.referral_leader_name || null,
      })),
      totals: {
        users_with_balance: Number(t.users_with_balance) || 0,
        users_total: Number(t.users_total) || 0,
        total_balance: Number(t.total_balance) || 0,
      },
    };
  }

  async getTokensSpendStats(opts: { bucket?: 'day' | 'hour'; days?: number } = {}) {
    const bucket = opts.bucket === 'hour' ? 'hour' : 'day';
    const days = bucket === 'hour'
      ? Math.min(Math.max(opts.days ?? 2, 1), 14)
      : Math.min(Math.max(opts.days ?? 30, 1), 365);
    const stepInterval = bucket === 'hour' ? '1 hour' : '1 day';
    const stepCount = bucket === 'hour' ? days * 24 - 1 : days - 1;

    const seriesRes = await this.pg.query(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc('${bucket}', now()) - $1 * interval '${stepInterval}',
           date_trunc('${bucket}', now()),
           interval '${stepInterval}'
         ) AS bucket
       )
       SELECT
         b.bucket,
         COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.transaction_type = 'consumed')), 0)::bigint AS spent,
         COALESCE(COUNT(*) FILTER (WHERE t.transaction_type = 'consumed'), 0)::int AS tx_count
       FROM buckets b
       LEFT JOIN token_transactions t
         ON date_trunc('${bucket}', t.created_at) = b.bucket
       GROUP BY b.bucket
       ORDER BY b.bucket ASC`,
      [stepCount],
    );

    const totalsRes = await this.pg.query(
      `SELECT
         COALESCE(ABS(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', now()))), 0)::bigint AS spent_today,
         COALESCE(ABS(SUM(amount) FILTER (WHERE created_at >= now() - interval '7 days')), 0)::bigint AS spent_7d,
         COALESCE(ABS(SUM(amount) FILTER (WHERE created_at >= now() - interval '30 days')), 0)::bigint AS spent_30d,
         COALESCE(ABS(SUM(amount)), 0)::bigint AS spent_all,
         COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '30 days') AS active_users_30d
       FROM token_transactions
       WHERE transaction_type = 'consumed'`,
    );
    const t = totalsRes.rows[0] || {};

    return {
      bucket,
      series: seriesRes.rows.map(r => ({
        bucket: r.bucket,
        spent: Number(r.spent) || 0,
        tx_count: Number(r.tx_count) || 0,
      })),
      totals: {
        spent_today: Number(t.spent_today) || 0,
        spent_7d: Number(t.spent_7d) || 0,
        spent_30d: Number(t.spent_30d) || 0,
        spent_all: Number(t.spent_all) || 0,
        active_users_30d: Number(t.active_users_30d) || 0,
      },
    };
  }

  async getActiveUsersStats(opts: { days?: number; bucket?: 'day' | 'week' } = {}) {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
    const bucket = opts.bucket === 'week' ? 'week' : 'day';

    const seriesRes = await this.pg.query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc($1, now() - make_interval(days => $2 - 1)),
           date_trunc($1, now()),
           ('1 ' || $1)::interval
         ) AS bucket
       )
       SELECT
         to_char(d.bucket, 'YYYY-MM-DD') AS day,
         COALESCE(active.unique_users, 0)::int AS unique_users,
         COALESCE(newr.new_users, 0)::int AS new_users
       FROM days d
       LEFT JOIN (
         SELECT date_trunc($1, t.created_at) AS bucket,
                COUNT(DISTINCT t.user_id) AS unique_users
         FROM token_transactions t
         WHERE t.created_at >= now() - make_interval(days => $2)
           AND t.transaction_type = 'consumed'
         GROUP BY 1
       ) active ON active.bucket = d.bucket
       LEFT JOIN (
         SELECT date_trunc($1, a.created_at) AS bucket,
                COUNT(*) AS new_users
         FROM ai_profiles_consolidated a
         WHERE a.created_at >= now() - make_interval(days => $2)
         GROUP BY 1
       ) newr ON newr.bucket = d.bucket
       ORDER BY d.bucket`,
      [bucket, days],
    );

    const totalsRes = await this.pg.query(
      `SELECT
         (SELECT COUNT(*) FROM ai_profiles_consolidated)::int AS total_users,
         (SELECT COUNT(*) FROM ai_profiles_consolidated
            WHERE created_at >= now() - interval '30 days')::int AS new_30d,
         (SELECT COUNT(*) FROM ai_profiles_consolidated
            WHERE created_at >= now() - interval '7 days')::int AS new_7d,
         (SELECT COUNT(*) FROM ai_profiles_consolidated
            WHERE created_at >= date_trunc('day', now()))::int AS new_today,
         (SELECT COUNT(DISTINCT user_id) FROM token_transactions
            WHERE transaction_type = 'consumed'
            AND created_at >= date_trunc('day', now()))::int AS dau,
         (SELECT COUNT(DISTINCT user_id) FROM token_transactions
            WHERE transaction_type = 'consumed'
            AND created_at >= now() - interval '7 days')::int AS wau,
         (SELECT COUNT(DISTINCT user_id) FROM token_transactions
            WHERE transaction_type = 'consumed'
            AND created_at >= now() - interval '30 days')::int AS mau
      `,
    );

    return {
      days,
      bucket,
      series: seriesRes.rows,
      totals: totalsRes.rows[0],
    };
  }

  async getAssistantsUsageStats(opts: { days?: number } = {}) {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);

    // Daily series: queries (= rows) and tokens spent per day, last `days` days.
    const seriesRes = await this.pg.query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', now()) - ($1 - 1) * interval '1 day',
           date_trunc('day', now()),
           interval '1 day'
         )::date AS day
       )
       SELECT
         d.day,
         COALESCE(COUNT(t.id), 0)::int AS queries,
         COALESCE(SUM(t.tokens_to_consume), 0)::bigint AS tokens
       FROM days d
       LEFT JOIN token_consumption_tasks t
         ON date_trunc('day', t.created_at)::date = d.day
        AND t.status = 'completed'
       GROUP BY d.day
       ORDER BY d.day ASC`,
      [days],
    );

    // Per-assistant usage for the selected period (LEFT JOIN keeps assistants with 0 usage).
    const byAgentRes = await this.pg.query(
      `SELECT
         a.id,
         a.name,
         COALESCE(a.description, '') AS description,
         COALESCE(SUM(t.tokens_to_consume), 0)::bigint AS tokens,
         COALESCE(COUNT(t.id), 0)::int AS queries,
         COALESCE(COUNT(DISTINCT t.user_id), 0)::int AS unique_users,
         MAX(t.created_at) AS last_used
       FROM agents a
       LEFT JOIN token_consumption_tasks t
         ON t.agent_id = a.id
        AND t.status = 'completed'
        AND t.created_at >= now() - $1 * interval '1 day'
       GROUP BY a.id, a.name, a.description
       ORDER BY tokens DESC, queries DESC, a.id ASC`,
      [days],
    );

    // Totals across all time + bucketed (today/7d/30d/all).
    const totalsRes = await this.pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS queries_today,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS queries_7d,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS queries_30d,
         COUNT(*)::int AS queries_all,
         COALESCE(SUM(tokens_to_consume) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS tokens_today,
         COALESCE(SUM(tokens_to_consume) FILTER (WHERE created_at >= now() - interval '7 days'), 0)::bigint AS tokens_7d,
         COALESCE(SUM(tokens_to_consume) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::bigint AS tokens_30d,
         COALESCE(SUM(tokens_to_consume), 0)::bigint AS tokens_all,
         COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days')::int AS active_users_7d,
         COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '30 days')::int AS active_users_30d
       FROM token_consumption_tasks
       WHERE status = 'completed' AND agent_id IS NOT NULL`,
    );
    const tot = totalsRes.rows[0] || {};

    return {
      days,
      series: seriesRes.rows.map(r => ({
        day: r.day,
        queries: Number(r.queries) || 0,
        tokens: Number(r.tokens) || 0,
      })),
      byAssistant: byAgentRes.rows.map(r => ({
        id: Number(r.id),
        name: r.name,
        description: r.description || '',
        tokens: Number(r.tokens) || 0,
        queries: Number(r.queries) || 0,
        unique_users: Number(r.unique_users) || 0,
        last_used: r.last_used,
      })),
      totals: {
        queries_today: Number(tot.queries_today) || 0,
        queries_7d: Number(tot.queries_7d) || 0,
        queries_30d: Number(tot.queries_30d) || 0,
        queries_all: Number(tot.queries_all) || 0,
        tokens_today: Number(tot.tokens_today) || 0,
        tokens_7d: Number(tot.tokens_7d) || 0,
        tokens_30d: Number(tot.tokens_30d) || 0,
        tokens_all: Number(tot.tokens_all) || 0,
        active_users_7d: Number(tot.active_users_7d) || 0,
        active_users_30d: Number(tot.active_users_30d) || 0,
      },
    };
  }

  // --- Per-user activity drill-down ---

  async getUserActivity(phone: string, opts: { days?: number } = {}) {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);

    // 1) Base profile + totals from payments + last_active + referral leader.
    const userRes = await this.pg.query(
      `SELECT
         a.user_id AS phone,
         a.created_at AS registered_at,
         COALESCE(a.tokens, 0)::bigint AS balance,
         a.email,
         a.isadmin,
         a.preferred_agent,
         a.profile_data,
         pay.paid_count::int AS paid_count,
         COALESCE(pay.paid_rub, 0)::numeric AS paid_rub,
         rl.name AS referral_leader_name,
         spent_total.spent::bigint AS spent_total,
         spent_period.spent::bigint AS spent_period,
         spent_period.last_active AS last_active
       FROM ai_profiles_consolidated a
       LEFT JOIN (
         SELECT user_id, ABS(SUM(amount)) AS spent
         FROM token_transactions
         WHERE transaction_type = 'consumed' AND user_id = $1
         GROUP BY user_id
       ) spent_total ON spent_total.user_id = a.user_id
       LEFT JOIN (
         SELECT user_id, ABS(SUM(amount)) AS spent, MAX(created_at) AS last_active
         FROM token_transactions
         WHERE transaction_type = 'consumed' AND user_id = $1
           AND created_at >= now() - make_interval(days => $2)
         GROUP BY user_id
       ) spent_period ON spent_period.user_id = a.user_id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS paid_count, SUM(amount) AS paid_rub
         FROM payments
         WHERE status = 'succeeded' AND user_id = $1
         GROUP BY user_id
       ) pay ON pay.user_id = a.user_id
       LEFT JOIN referral_referees rr ON rr.referee_phone = a.user_id
       LEFT JOIN referral_leaders rl ON rl.id = rr.leader_id
       WHERE a.user_id = $1
       LIMIT 1`,
      [phone, days],
    );

    if (userRes.rows.length === 0) {
      return {
        user: null,
        totals: {
          spent_total: 0, spent_period: 0,
          queries_total: 0, queries_period: 0,
          images_count: 0, videos_count: 0, calls_count: 0,
        },
        series: [],
        byAssistant: [],
        transactions: [],
        recentMessages: [],
      };
    }

    const u = userRes.rows[0];

    // 2) Queries totals (token_consumption_tasks for completed agent runs;
    //    falls back to message count from custom_chat_history).
    let queriesTotal = 0;
    let queriesPeriod = 0;
    try {
      const r = await this.pg.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'completed' AND agent_id IS NOT NULL)::int AS total,
           COUNT(*) FILTER (
             WHERE status = 'completed' AND agent_id IS NOT NULL
               AND created_at >= now() - make_interval(days => $2)
           )::int AS period
         FROM token_consumption_tasks
         WHERE user_id = $1`,
        [phone, days],
      );
      queriesTotal = Number(r.rows[0]?.total) || 0;
      queriesPeriod = Number(r.rows[0]?.period) || 0;
    } catch { /* table missing → 0 */ }

    // 3) Images / videos / calls counts (graceful 0 if tables absent).
    let imagesCount = 0;
    try {
      const r = await this.pg.query(
        `SELECT COUNT(*)::int AS c FROM generated_images WHERE user_id = $1`, [phone]);
      imagesCount = Number(r.rows[0]?.c) || 0;
    } catch {}

    let videosCount = 0;
    try {
      const r = await this.pg.query(
        `SELECT COUNT(*)::int AS c FROM video_jobs WHERE user_id = $1`, [phone]);
      videosCount = Number(r.rows[0]?.c) || 0;
    } catch {}

    let callsCount = 0;
    try {
      const r = await this.pg.query(
        `SELECT COUNT(*)::int AS c
         FROM dozvon_calls dc
         JOIN dozvon_campaigns dcm ON dcm.id = dc.campaign_id
         WHERE dcm.user_id = $1`, [phone]);
      callsCount = Number(r.rows[0]?.c) || 0;
    } catch {}

    // 4) Daily series (tokens spent + queries via custom_chat_history human messages).
    let series: Array<{ day: string; tokens_spent: number; queries: number }> = [];
    try {
      const r = await this.pg.query(
        `WITH d AS (
           SELECT generate_series(
             date_trunc('day', now() - make_interval(days => $2 - 1)),
             date_trunc('day', now()),
             interval '1 day'
           )::date AS day
         )
         SELECT
           to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE(spent.tokens, 0)::bigint AS tokens_spent,
           COALESCE(qs.queries, 0)::int AS queries
         FROM d
         LEFT JOIN (
           SELECT date_trunc('day', created_at)::date AS day,
                  ABS(SUM(amount)) AS tokens
           FROM token_transactions
           WHERE user_id = $1 AND transaction_type='consumed'
             AND created_at >= now() - make_interval(days => $2)
           GROUP BY 1
         ) spent ON spent.day = d.day
         LEFT JOIN (
           SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS queries
           FROM custom_chat_history
           WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'
             AND sender_type = 'human'
             AND created_at >= now() - make_interval(days => $2)
           GROUP BY 1
         ) qs ON qs.day = d.day
         ORDER BY d.day ASC`,
        [phone, days],
      );
      series = r.rows.map(row => ({
        day: row.day,
        tokens_spent: Number(row.tokens_spent) || 0,
        queries: Number(row.queries) || 0,
      }));
    } catch {
      series = [];
    }

    // 5) By-assistant: queries (token_consumption_tasks completed) + tokens (sum of tokens_to_consume).
    //    LEFT JOIN agents to get name; HAVING queries > 0 keeps it tight.
    let byAssistant: Array<{ id: number; name: string; queries: number; tokens: number; last_used: string | null }> = [];
    try {
      const r = await this.pg.query(
        `SELECT
           a.id,
           COALESCE(a.name, 'Agent ' || a.id::text) AS name,
           COUNT(t.*)::int AS queries,
           COALESCE(SUM(t.tokens_to_consume), 0)::bigint AS tokens,
           MAX(t.created_at) AS last_used
         FROM token_consumption_tasks t
         JOIN agents a ON a.id = t.agent_id
         WHERE t.user_id = $1
           AND t.status = 'completed'
           AND t.agent_id IS NOT NULL
         GROUP BY a.id, a.name
         ORDER BY queries DESC, tokens DESC, a.id ASC
         LIMIT 100`,
        [phone],
      );
      byAssistant = r.rows.map(row => ({
        id: Number(row.id),
        name: row.name,
        queries: Number(row.queries) || 0,
        tokens: Number(row.tokens) || 0,
        last_used: row.last_used,
      }));
    } catch {
      byAssistant = [];
    }

    // 6) Recent transactions (last 20).
    let transactions: Array<{ id: string; created_at: string; amount: number; transaction_type: string; reason: string }> = [];
    try {
      const r = await this.pg.query(
        `SELECT id, created_at, amount, transaction_type::text AS transaction_type,
                COALESCE(description, '') AS reason
         FROM token_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [phone],
      );
      transactions = r.rows.map(row => ({
        id: row.id,
        created_at: row.created_at,
        amount: Number(row.amount) || 0,
        transaction_type: row.transaction_type,
        reason: row.reason || '',
      }));
    } catch {
      transactions = [];
    }

    // 7) Recent messages (last 10 from custom_chat_history; agent name via JOIN).
    let recentMessages: Array<{
      id: string; created_at: string; agent_id: number | null;
      agent_name: string | null; role: string; preview: string;
    }> = [];
    try {
      const r = await this.pg.query(
        `SELECT
           c.id::text AS id,
           c.created_at,
           c.agent AS agent_id,
           a.name AS agent_name,
           c.sender_type AS role,
           SUBSTRING(c.content, 1, 80) AS preview
         FROM custom_chat_history c
         LEFT JOIN agents a ON a.id = c.agent
         WHERE c.session_id LIKE $1 || '\\_%' ESCAPE '\\'
         ORDER BY c.created_at DESC
         LIMIT 10`,
        [phone],
      );
      recentMessages = r.rows.map(row => ({
        id: row.id,
        created_at: row.created_at,
        agent_id: row.agent_id !== null ? Number(row.agent_id) : null,
        agent_name: row.agent_name || null,
        role: row.role,
        preview: row.preview || '',
      }));
    } catch {
      recentMessages = [];
    }

    // 8) Recent payments (last 20).
    let payments: Array<{
      id: string;
      payment_id: string;
      package_id: string | null;
      amount_rub: number;
      tokens: number;
      status: string;
      created_at: string;
      completed_at: string | null;
    }> = [];
    try {
      const r = await this.pg.query(
        `SELECT id, payment_id, package_id, amount, tokens, status::text AS status,
                created_at, completed_at
         FROM payments
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [phone],
      );
      payments = r.rows.map(row => ({
        id: row.id,
        payment_id: row.payment_id,
        package_id: row.package_id || null,
        amount_rub: Number(row.amount) || 0,
        tokens: Number(row.tokens) || 0,
        status: row.status,
        created_at: row.created_at,
        completed_at: row.completed_at,
      }));
    } catch {
      payments = [];
    }

    return {
      user: {
        phone: u.phone,
        registered_at: u.registered_at,
        balance: Number(u.balance) || 0,
        email: u.email || null,
        isadmin: !!u.isadmin,
        preferred_agent: u.preferred_agent || null,
        paid_count: Number(u.paid_count) || 0,
        paid_rub: Number(u.paid_rub) || 0,
        referral_leader_name: u.referral_leader_name || null,
        last_active: u.last_active || null,
      },
      totals: {
        spent_total: Number(u.spent_total) || 0,
        spent_period: Number(u.spent_period) || 0,
        queries_total: queriesTotal,
        queries_period: queriesPeriod,
        images_count: imagesCount,
        videos_count: videosCount,
        calls_count: callsCount,
      },
      series,
      byAssistant,
      transactions,
      recentMessages,
      payments,
    };
  }

  async getPaymentsStats(opts: { days?: number } = {}) {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);

    const dailyRes = await this.pg.query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', now() AT TIME ZONE 'UTC') - ($1 - 1) * interval '1 day',
           date_trunc('day', now() AT TIME ZONE 'UTC'),
           interval '1 day'
         )::date AS day
       )
       SELECT
         d.day,
         COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN p.amount ELSE 0 END), 0)::numeric AS revenue,
         COALESCE(SUM(CASE WHEN p.status = 'succeeded' THEN 1 ELSE 0 END), 0)::int AS succeeded_count,
         COALESCE(SUM(CASE WHEN p.status = 'pending'   THEN 1 ELSE 0 END), 0)::int AS pending_count,
         COALESCE(SUM(CASE WHEN p.status = 'canceled'  THEN 1 ELSE 0 END), 0)::int AS canceled_count
       FROM days d
       LEFT JOIN payments p
         ON date_trunc('day', COALESCE(p.completed_at, p.created_at)) = d.day
       GROUP BY d.day
       ORDER BY d.day ASC`,
      [days],
    );

    const totalsRes = await this.pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded_count,
         COUNT(*) FILTER (WHERE status = 'pending')   AS pending_count,
         COUNT(*) FILTER (WHERE status = 'canceled')  AS canceled_count,
         COUNT(*)                                       AS total_count,
         COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS revenue_all,
         COALESCE(SUM(amount) FILTER (
           WHERE status = 'succeeded'
             AND COALESCE(completed_at, created_at) >= now() - interval '30 days'
         ), 0) AS revenue_30d,
         COALESCE(SUM(amount) FILTER (
           WHERE status = 'succeeded'
             AND COALESCE(completed_at, created_at) >= now() - interval '7 days'
         ), 0) AS revenue_7d,
         COALESCE(SUM(amount) FILTER (
           WHERE status = 'succeeded'
             AND date_trunc('day', COALESCE(completed_at, created_at)) = date_trunc('day', now())
         ), 0) AS revenue_today,
         COUNT(DISTINCT user_id) FILTER (WHERE status = 'succeeded') AS unique_payers
       FROM payments`,
    );
    const t = totalsRes.rows[0] || {};

    return {
      daily: dailyRes.rows.map(r => ({
        day: r.day,
        revenue: Number(r.revenue) || 0,
        succeeded: Number(r.succeeded_count) || 0,
        pending: Number(r.pending_count) || 0,
        canceled: Number(r.canceled_count) || 0,
      })),
      totals: {
        succeeded_count: Number(t.succeeded_count) || 0,
        pending_count: Number(t.pending_count) || 0,
        canceled_count: Number(t.canceled_count) || 0,
        total_count: Number(t.total_count) || 0,
        revenue_all: Number(t.revenue_all) || 0,
        revenue_30d: Number(t.revenue_30d) || 0,
        revenue_7d: Number(t.revenue_7d) || 0,
        revenue_today: Number(t.revenue_today) || 0,
        unique_payers: Number(t.unique_payers) || 0,
      },
    };
  }
}
