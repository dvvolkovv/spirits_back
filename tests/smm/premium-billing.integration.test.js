const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { SmmPremiumGenerationService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'billing', 'smm-premium-generation.service'),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pg = { query: (t, p) => pool.query(t, p), getClient: () => pool.connect() };
const TEST_USER = '70000099911';

async function reset() {
  await pool.query(`DELETE FROM smm_premium_generation WHERE user_id = $1`, [TEST_USER]);
  await pool.query(
    `INSERT INTO ai_profiles_consolidated (user_id, tokens, profile_data)
       VALUES ($1, 500000, '{}'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET tokens = 500000`,
    [TEST_USER],
  );
}

async function makeVideo() {
  // smm_video has FK to smm_scenario; create a throwaway scenario+campaign chain.
  const camp = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count, topic)
       VALUES ($1, 'topic', 1, 'test') RETURNING id`,
    [TEST_USER],
  );
  const scen = await pool.query(
    `INSERT INTO smm_scenario (campaign_id, title, assistant_role, dialog, mood, broll_prompts, tts_tier, status)
       VALUES ($1, 't', 'psy', '[]'::jsonb, 'neutral', '[]'::jsonb, 'economy', 'pending_review') RETURNING id`,
    [camp.rows[0].id],
  );
  const vid = await pool.query(
    `INSERT INTO smm_video (scenario_id, status) VALUES ($1, 'queued') RETURNING id`,
    [scen.rows[0].id],
  );
  return vid.rows[0].id;
}

module.exports = {
  'premium-billing: charge списывает токены и пишет запись со status=in_progress': async () => {
    await reset();
    const videoId = await makeVideo();
    const svc = new SmmPremiumGenerationService(pg);
    const gen = await svc.charge({
      userId: TEST_USER, videoId, genre: 'surreal', sceneCount: 2, tokensCost: 180000,
    });
    if (gen.tokensCharged !== 180000) throw new Error(`tokensCharged=${gen.tokensCharged}`);
    if (gen.status !== 'in_progress') throw new Error(`status=${gen.status}`);
    const bal = await pool.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`, [TEST_USER]);
    if (Number(bal.rows[0].tokens) !== 320000) throw new Error(`balance=${bal.rows[0].tokens}`);
  },

  'premium-billing: refund возвращает токены и обновляет статус': async () => {
    await reset();
    const videoId = await makeVideo();
    const svc = new SmmPremiumGenerationService(pg);
    const gen = await svc.charge({
      userId: TEST_USER, videoId, genre: 'pov', sceneCount: 1, tokensCost: 100000,
    });
    await svc.refund({ generationId: gen.id, refundTokens: 100000, status: 'full_refund' });
    const bal = await pool.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1`, [TEST_USER]);
    if (Number(bal.rows[0].tokens) !== 500000) throw new Error(`balance=${bal.rows[0].tokens}`);
    const row = await pool.query(`SELECT status, tokens_refunded FROM smm_premium_generation WHERE id=$1`, [gen.id]);
    if (row.rows[0].status !== 'full_refund') throw new Error(`status=${row.rows[0].status}`);
    if (Number(row.rows[0].tokens_refunded) !== 100000) throw new Error(`refunded=${row.rows[0].tokens_refunded}`);
  },

  'premium-billing: checkRateLimit отбивает 6-й вызов за час': async () => {
    await reset();
    const svc = new SmmPremiumGenerationService(pg);
    for (let i = 0; i < 5; i++) {
      const videoId = await makeVideo();
      await svc.charge({
        userId: TEST_USER, videoId, genre: 'cinematic', sceneCount: 1, tokensCost: 100000,
      });
    }
    let threw = false;
    try {
      await svc.checkRateLimit(TEST_USER);
    } catch (e) {
      threw = true;
      if (!/rate.limit/i.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
    if (!threw) throw new Error('checkRateLimit did not throw on 6th call');
  },
};
