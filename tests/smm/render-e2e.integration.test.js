const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const config = require('../config');

const BASE_URL = process.env.SMM_API_BASE || config.BASE_URL;
const WORKER_SECRET = process.env.SMM_WORKER_SECRET || '';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TEST_USER = '70000099999';

async function setupFixture() {
  await pool.query(
    `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, updated_at)
     VALUES ($1, true, 1000000, now())
     ON CONFLICT (user_id) DO UPDATE SET tokens = 1000000`, [TEST_USER]);

  const c = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count, status)
     VALUES ($1, 'topic', 1, 'approved') RETURNING id`, [TEST_USER]);

  const dialog = [
    { speaker: 'hero',      text: 'Не могу уснуть.',          tStart: 3,  tEnd: 7 },
    { speaker: 'assistant', text: 'Попробуй технику 4-7-8.', tStart: 8, tEnd: 18 },
  ];
  // No B-roll, no music — keep test surface area minimal.
  const broll = [];

  const s = await pool.query(
    `INSERT INTO smm_scenario
       (campaign_id, title, assistant_role, dialog, mood, broll_prompts, tts_tier, status)
     VALUES ($1, 'E2E test', 'psy', $2::jsonb, 'calm', $3::jsonb, 'economy', 'approved')
     RETURNING id`,
    [c.rows[0].id, JSON.stringify(dialog), JSON.stringify(broll)]);

  // Create video row + charge tokens (mirrors what SmmBillingService.charge would do)
  const v = await pool.query(
    `INSERT INTO smm_video (scenario_id, status, tokens_charged)
     VALUES ($1, 'queued', 15000) RETURNING id`, [s.rows[0].id]);
  await pool.query(
    `INSERT INTO smm_billing_ledger (user_id, video_id, amount, op, reason)
     VALUES ($1, $2, 15000, 'charge', 'queued')`, [TEST_USER, v.rows[0].id]);
  await pool.query(
    `UPDATE ai_profiles_consolidated SET tokens = tokens - 15000 WHERE user_id = $1`, [TEST_USER]);

  return { campaignId: c.rows[0].id, videoId: v.rows[0].id };
}

async function waitForTerminal(videoId, maxSec = 180) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSec) {
    const r = await pool.query(
      `SELECT status, mp4_url, error_message FROM smm_video WHERE id = $1`, [videoId]);
    const row = r.rows[0];
    if (row.status === 'ready' || row.status === 'failed') return row;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { status: 'timeout' };
}

async function cleanup(campaignId) {
  await pool.query(`DELETE FROM smm_billing_ledger WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM smm_campaign WHERE id = $1`, [campaignId]);
  await pool.query(`UPDATE ai_profiles_consolidated SET tokens = 1000000 WHERE user_id = $1`, [TEST_USER]);
}

module.exports = {
  'render-e2e (lighter): enqueue → worker pipeline fails at TTS → callback marks video failed + refunds tokens': async () => {
    if (process.env.SKIP_RENDER_E2E === '1') { console.log('  (skip: SKIP_RENDER_E2E=1)'); return; }
    const { campaignId, videoId } = await setupFixture();
    try {
      // Enqueue via BullMQ directly
      const { Queue } = require('bullmq');
      const u = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6380');
      const q = new Queue('smm-render', { connection: {
        host: u.hostname, port: +u.port || 6380, password: u.password || undefined,
      }});
      const job = await q.add('e2e', { videoId, scenarioId: videoId });
      await q.close();
      console.log(`    enqueued job ${job.id} for video ${videoId}`);

      const result = await waitForTerminal(videoId, 180);
      if (result.status === 'timeout') throw new Error('Pipeline timed out after 180s — worker not running?');

      // We EXPECT failed because YANDEX_TTS_FOLDER_ID is not set.
      // If it IS set somehow and the render succeeded — that's fine too, but only one of the two is expected.
      if (result.status !== 'failed' && result.status !== 'ready') {
        throw new Error(`Unexpected terminal status: ${result.status}`);
      }

      if (result.status === 'failed') {
        if (!result.error_message) throw new Error('failed status without error_message');

        // Verify refund happened
        const refunds = await pool.query(
          `SELECT amount FROM smm_billing_ledger WHERE video_id = $1 AND op = 'refund'`, [videoId]);
        if (refunds.rows.length !== 1) {
          throw new Error(`Expected 1 refund row, got ${refunds.rows.length}`);
        }
        if (Number(refunds.rows[0].amount) !== -15000) {
          throw new Error(`Expected refund amount -15000, got ${refunds.rows[0].amount}`);
        }

        // Verify user balance restored
        const bal = await pool.query(
          `SELECT tokens::int as t FROM ai_profiles_consolidated WHERE user_id = $1`, [TEST_USER]);
        if (bal.rows[0].t !== 1000000) {
          throw new Error(`Expected balance 1000000 (refunded), got ${bal.rows[0].t}`);
        }
        console.log(`    ✓ pipeline failed gracefully with refund, error: "${result.error_message.slice(0, 60)}..."`);
      } else {
        // status === 'ready' — happy path (someone set YANDEX_TTS_FOLDER_ID)
        if (!result.mp4_url || !result.mp4_url.includes('/smm-media/')) {
          throw new Error(`Bad mp4_url: ${result.mp4_url}`);
        }
        console.log(`    ✓ pipeline succeeded, mp4_url=${result.mp4_url}`);
      }
    } finally {
      await cleanup(campaignId);
    }
  },
};
