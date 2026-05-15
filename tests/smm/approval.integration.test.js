const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { ApprovalService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'producer', 'approval.service'),
);
const { SmmBillingService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'billing', 'smm-billing.service'),
);
const { SmmPricingService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'billing', 'smm-pricing.service'),
);
const { RenderQueueService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'render', 'render-queue.service'),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pg = { query: (text, params) => pool.query(text, params), getClient: () => pool.connect() };
const TEST_USER = '70000099999';

async function setupCampaignWithScenarios(n = 2, tier = 'economy') {
  await pool.query(
    `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, updated_at)
     VALUES ($1, true, 1000000, now())
     ON CONFLICT (user_id) DO UPDATE SET tokens = 1000000`, [TEST_USER]);
  const c = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count) VALUES ($1, 'topic', $2) RETURNING id`,
    [TEST_USER, n]);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const s = await pool.query(
      `INSERT INTO smm_scenario (campaign_id, title, assistant_role, dialog, mood, tts_tier, status)
       VALUES ($1, $2, 'psy', '[]'::jsonb, 'neutral', $3, 'pending_review') RETURNING id`,
      [c.rows[0].id, `S${i}`, tier]);
    ids.push(s.rows[0].id);
  }
  return { campaignId: c.rows[0].id, scenarioIds: ids };
}

async function cleanup() {
  await pool.query(`DELETE FROM smm_billing_ledger WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM smm_campaign WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`UPDATE ai_profiles_consolidated SET tokens = 1000000 WHERE user_id = $1`, [TEST_USER]);
}

async function buildServices() {
  const pricing = new SmmPricingService(pg);
  await pricing.onModuleInit();
  const billing = new SmmBillingService(pg, pricing);
  const queue = new RenderQueueService();
  queue.onModuleInit();
  return { billing, queue, pricing };
}

module.exports = {
  'approval: approve N scenarios → N charges + N enqueued render jobs': async () => {
    const { campaignId, scenarioIds } = await setupCampaignWithScenarios(2, 'economy');
    let queue;
    try {
      const services = await buildServices();
      queue = services.queue;
      const approval = new ApprovalService(pg, services.billing, services.queue);
      const balanceBefore = (await pool.query(
        `SELECT tokens::int as t FROM ai_profiles_consolidated WHERE user_id = $1`, [TEST_USER])).rows[0].t;

      const result = await approval.approveScenarios({ userId: TEST_USER, scenarioIds });
      if (result.approved.length !== 2) throw new Error(`Expected 2 approved, got ${result.approved.length}`);
      if (result.failed.length !== 0) throw new Error(`Unexpected failures: ${JSON.stringify(result.failed)}`);

      for (const a of result.approved) {
        if (!a.videoId || !a.jobId) throw new Error(`bad approved entry: ${JSON.stringify(a)}`);
      }

      const statuses = await pool.query(
        `SELECT status FROM smm_scenario WHERE id = ANY($1::uuid[])`, [scenarioIds]);
      for (const r of statuses.rows) {
        if (r.status !== 'approved') throw new Error(`status not approved: ${r.status}`);
      }

      const balanceAfter = (await pool.query(
        `SELECT tokens::int as t FROM ai_profiles_consolidated WHERE user_id = $1`, [TEST_USER])).rows[0].t;
      if (balanceAfter !== balanceBefore - 2 * 15000) {
        throw new Error(`Expected ${balanceBefore - 30000}, got ${balanceAfter}`);
      }

      const ledger = await pool.query(
        `SELECT count(*)::int as n FROM smm_billing_ledger WHERE user_id = $1 AND op = 'charge'`, [TEST_USER]);
      if (ledger.rows[0].n !== 2) throw new Error(`Expected 2 charge rows`);
    } finally {
      if (queue) await queue.onModuleDestroy?.();
      await cleanup();
    }
  },

  'approval: insufficient tokens for second scenario → first approved + second in failed list': async () => {
    const { scenarioIds } = await setupCampaignWithScenarios(2, 'economy');
    let queue;
    try {
      // Set balance to only 15000 (enough for 1 of 2)
      await pool.query(`UPDATE ai_profiles_consolidated SET tokens = 15000 WHERE user_id = $1`, [TEST_USER]);
      const services = await buildServices();
      queue = services.queue;
      const approval = new ApprovalService(pg, services.billing, services.queue);

      const result = await approval.approveScenarios({ userId: TEST_USER, scenarioIds });
      if (result.approved.length !== 1) throw new Error(`Expected 1 approved, got ${result.approved.length}`);
      if (result.failed.length !== 1) throw new Error(`Expected 1 failed, got ${result.failed.length}`);
      if (result.failed[0].reason !== 'insufficient_tokens') throw new Error(`Expected insufficient_tokens, got ${result.failed[0].reason}`);
    } finally {
      if (queue) await queue.onModuleDestroy?.();
      await cleanup();
    }
  },
};
