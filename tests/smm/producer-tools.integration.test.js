const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { SmmProducerToolsService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'producer', 'smm-producer-tools.service'),
);
const { ScenarioService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'producer', 'scenario.service'),
);
const { TrendsService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'producer', 'trends.service'),
);
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
const { RedisService } = require(
  path.join(__dirname, '..', '..', 'dist', 'common', 'services', 'redis.service'),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pg = { query: (text, params) => pool.query(text, params), getClient: () => pool.connect() };
const TEST_USER = '70000099999';

async function buildSvc() {
  const pricing = new SmmPricingService(pg);
  await pricing.onModuleInit();
  const billing = new SmmBillingService(pg, pricing);
  const queue = new RenderQueueService();
  queue.onModuleInit();
  const redis = new RedisService();
  if (typeof redis.onModuleInit === 'function') redis.onModuleInit();
  const scenario = new ScenarioService(pg);
  const trends = new TrendsService(redis);
  const approval = new ApprovalService(pg, billing, queue);
  return { svc: new SmmProducerToolsService(pg, scenario, trends, approval), queue, redis };
}

async function cleanup() {
  await pool.query(`DELETE FROM smm_billing_ledger WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM smm_campaign WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`UPDATE ai_profiles_consolidated SET tokens = 1000000 WHERE user_id = $1`, [TEST_USER]);
}

module.exports = {
  'producer-tools: list_scenarios with no campaign — returns empty list (no error)': async () => {
    const { svc, queue } = await buildSvc();
    try {
      const out = await svc.handle('list_scenarios', {}, { userId: TEST_USER });
      if (!Array.isArray(out.scenarios)) throw new Error('expected scenarios array');
    } finally {
      await queue.onModuleDestroy?.();
      await cleanup();
    }
  },

  'producer-tools: reject_scenario on pending → status becomes rejected': async () => {
    const { svc, queue } = await buildSvc();
    try {
      await pool.query(
        `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, updated_at)
         VALUES ($1, true, 1000000, now()) ON CONFLICT (user_id) DO UPDATE SET tokens = 1000000`, [TEST_USER]);
      const c = await pool.query(
        `INSERT INTO smm_campaign (user_id, source_mode, requested_count) VALUES ($1, 'topic', 1) RETURNING id`, [TEST_USER]);
      const s = await pool.query(
        `INSERT INTO smm_scenario (campaign_id, title, assistant_role, dialog, mood, tts_tier)
         VALUES ($1, 't', 'psy', '[]'::jsonb, 'neutral', 'economy') RETURNING id`, [c.rows[0].id]);

      const out = await svc.handle('reject_scenario', { scenario_id: s.rows[0].id }, { userId: TEST_USER });
      if (out.ok !== true) throw new Error(`expected ok=true, got ${JSON.stringify(out)}`);

      const r = await pool.query(`SELECT status FROM smm_scenario WHERE id = $1`, [s.rows[0].id]);
      if (r.rows[0].status !== 'rejected') throw new Error(`expected rejected, got ${r.rows[0].status}`);
    } finally {
      await queue.onModuleDestroy?.();
      await cleanup();
    }
  },

  'producer-tools: unknown tool name → error response': async () => {
    const { svc, queue } = await buildSvc();
    try {
      const out = await svc.handle('foo', {}, { userId: TEST_USER });
      if (!out.error) throw new Error('expected error response');
      if (!out.error.includes('unknown tool')) throw new Error(`bad error: ${out.error}`);
    } finally {
      await queue.onModuleDestroy?.();
      await cleanup();
    }
  },
};
