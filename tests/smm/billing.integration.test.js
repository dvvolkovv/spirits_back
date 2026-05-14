const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { SmmBillingService } = require(
  path.join(__dirname, '..', '..', 'dist', 'src', 'smm', 'billing', 'smm-billing.service'),
);
const { SmmPricingService } = require(
  path.join(__dirname, '..', '..', 'dist', 'src', 'smm', 'billing', 'smm-pricing.service'),
);
const { InsufficientTokensError } = require(
  path.join(__dirname, '..', '..', 'dist', 'src', 'smm', 'billing', 'insufficient-tokens.error'),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pg = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};

const TEST_USER = '70000099999';

async function setBalance(balance) {
  await pool.query(
    `UPDATE ai_profiles_consolidated SET tokens = $1 WHERE user_id = $2`,
    [balance, TEST_USER],
  );
}

async function getBalance() {
  const r = await pool.query(
    `SELECT tokens::int AS tokens FROM ai_profiles_consolidated WHERE user_id = $1`,
    [TEST_USER],
  );
  return r.rows[0].tokens;
}

async function ensureFixture() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'admin-user.sql'),
    'utf-8',
  );
  await pool.query(sql);
}

async function createScenarioAndVideo() {
  // minimal campaign + scenario + video to attach billing to
  const c = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count)
     VALUES ($1, 'topic', 1) RETURNING id`,
    [TEST_USER],
  );
  const campaignId = c.rows[0].id;
  const s = await pool.query(
    `INSERT INTO smm_scenario
        (campaign_id, title, assistant_role, dialog, mood, tts_tier)
     VALUES ($1, 't', 'psy', '[]'::jsonb, 'neutral', 'economy')
     RETURNING id`,
    [campaignId],
  );
  const scenarioId = s.rows[0].id;
  const v = await pool.query(
    `INSERT INTO smm_video (scenario_id) VALUES ($1) RETURNING id`,
    [scenarioId],
  );
  return { campaignId, scenarioId, videoId: v.rows[0].id };
}

async function cleanup(campaignId) {
  // cascade deletes scenario, video, ledger rows tied to video
  await pool.query(`DELETE FROM smm_billing_ledger WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM smm_campaign WHERE id = $1`, [campaignId]);
}

async function buildServices() {
  const pricing = new SmmPricingService(pg);
  await pricing.onModuleInit();
  const billing = new SmmBillingService(pg, pricing);
  return { billing, pricing };
}

module.exports = {
  'billing: charge succeeds when balance is sufficient': async () => {
    await ensureFixture();
    await setBalance(100000);
    const { campaignId, videoId } = await createScenarioAndVideo();
    try {
      const { billing } = await buildServices();
      await billing.charge({ userId: TEST_USER, videoId, tier: 'economy' });
      const after = await getBalance();
      if (after !== 100000 - 15000) {
        throw new Error(`Expected balance ${100000 - 15000}, got ${after}`);
      }
      const ledger = await pool.query(
        `SELECT amount, op, reason FROM smm_billing_ledger WHERE video_id = $1`,
        [videoId],
      );
      if (ledger.rows.length !== 1) throw new Error(`Expected 1 ledger row, got ${ledger.rows.length}`);
      if (ledger.rows[0].op !== 'charge') throw new Error('Expected op=charge');
      if (ledger.rows[0].amount !== 15000) throw new Error(`Expected amount=15000`);
    } finally {
      await cleanup(campaignId);
    }
  },

  'billing: charge throws InsufficientTokensError when balance is too low': async () => {
    await ensureFixture();
    await setBalance(1000);
    const { campaignId, videoId } = await createScenarioAndVideo();
    try {
      const { billing } = await buildServices();
      let thrown = null;
      try {
        await billing.charge({ userId: TEST_USER, videoId, tier: 'premium' });
      } catch (e) {
        thrown = e;
      }
      if (!(thrown instanceof InsufficientTokensError)) {
        throw new Error(`Expected InsufficientTokensError, got: ${thrown && thrown.constructor.name}`);
      }
      // Verify no balance change and no ledger row
      const after = await getBalance();
      if (after !== 1000) throw new Error(`Balance changed: ${after}`);
      const ledger = await pool.query(
        `SELECT count(*)::int as n FROM smm_billing_ledger WHERE video_id = $1`,
        [videoId],
      );
      if (ledger.rows[0].n !== 0) throw new Error(`Expected 0 ledger rows on failed charge`);
    } finally {
      await cleanup(campaignId);
    }
  },

  'billing: refund returns tokens and writes ledger': async () => {
    await ensureFixture();
    await setBalance(100000);
    const { campaignId, videoId } = await createScenarioAndVideo();
    try {
      const { billing } = await buildServices();
      await billing.charge({ userId: TEST_USER, videoId, tier: 'economy' });
      await billing.refund({ videoId, reason: 'render_failed' });
      const after = await getBalance();
      if (after !== 100000) throw new Error(`Expected restored 100000, got ${after}`);
      const ledger = await pool.query(
        `SELECT op, amount FROM smm_billing_ledger
         WHERE video_id = $1 ORDER BY created_at`,
        [videoId],
      );
      if (ledger.rows.length !== 2) throw new Error(`Expected 2 ledger rows, got ${ledger.rows.length}`);
      if (ledger.rows[1].op !== 'refund') throw new Error('Expected second row op=refund');
      if (ledger.rows[1].amount !== -15000) throw new Error(`Expected refund amount -15000`);
      const sumRes = await pool.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS s FROM smm_billing_ledger WHERE video_id = $1`,
        [videoId],
      );
      if (sumRes.rows[0].s !== 0) {
        throw new Error(`Ledger sum non-zero after refund: ${sumRes.rows[0].s}`);
      }
    } finally {
      await cleanup(campaignId);
    }
  },

  'billing: refund is idempotent (second refund is no-op)': async () => {
    await ensureFixture();
    await setBalance(100000);
    const { campaignId, videoId } = await createScenarioAndVideo();
    try {
      const { billing } = await buildServices();
      await billing.charge({ userId: TEST_USER, videoId, tier: 'economy' });
      await billing.refund({ videoId, reason: 'render_failed' });
      await billing.refund({ videoId, reason: 'render_failed' });
      const after = await getBalance();
      if (after !== 100000) throw new Error(`Expected 100000 after double refund, got ${after}`);
      const ledger = await pool.query(
        `SELECT count(*)::int as n FROM smm_billing_ledger WHERE video_id = $1`,
        [videoId],
      );
      if (ledger.rows[0].n !== 2) throw new Error(`Expected exactly 2 ledger rows`);
    } finally {
      await cleanup(campaignId);
    }
  },

  'billing: charge throws plain Error (not InsufficientTokensError) when user is unknown': async () => {
    await ensureFixture();
    const { campaignId, videoId } = await createScenarioAndVideo();
    try {
      const { billing } = await buildServices();
      let thrown = null;
      try {
        await billing.charge({ userId: 'nonexistent_user_999', videoId, tier: 'economy' });
      } catch (e) {
        thrown = e;
      }
      if (!thrown) throw new Error('Expected an error on unknown user');
      if (thrown instanceof InsufficientTokensError) {
        throw new Error('Should be plain Error, not InsufficientTokensError');
      }
      if (!thrown.message.includes('not found')) {
        throw new Error(`Expected message about not found, got: ${thrown.message}`);
      }
    } finally {
      await cleanup(campaignId);
    }
  },

  'billing: refund is a no-op when there was no charge': async () => {
    await ensureFixture();
    await setBalance(50000);
    const before = await getBalance();
    const { campaignId, videoId } = await createScenarioAndVideo();
    try {
      const { billing } = await buildServices();
      // refund without prior charge — should silently succeed
      await billing.refund({ videoId, reason: 'spurious' });
      const after = await getBalance();
      if (after !== before) {
        throw new Error(`Balance changed: ${before} → ${after}`);
      }
      const ledger = await pool.query(
        `SELECT count(*)::int as n FROM smm_billing_ledger WHERE video_id = $1`,
        [videoId],
      );
      if (ledger.rows[0].n !== 0) {
        throw new Error(`Expected 0 ledger rows, got ${ledger.rows[0].n}`);
      }
    } finally {
      await cleanup(campaignId);
    }
  },
};
