const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const axios = require('axios');
const { Pool } = require('pg');
const config = require('../config');

const BASE_URL = process.env.SMM_API_BASE || config.BASE_URL;
const WORKER_SECRET = process.env.SMM_WORKER_SECRET || '';

const http = axios.create({
  baseURL: BASE_URL,
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  timeout: 15000,
  validateStatus: () => true,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TEST_USER = '70000099999';

function workerHeaders() {
  return { 'X-Smm-Worker-Secret': WORKER_SECRET };
}

async function createVideoFixture() {
  await pool.query(
    `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, updated_at)
     VALUES ($1, true, 1000000, now())
     ON CONFLICT (user_id) DO UPDATE SET tokens = 1000000`,
    [TEST_USER],
  );
  const c = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count)
     VALUES ($1, 'topic', 1) RETURNING id`, [TEST_USER]);
  const s = await pool.query(
    `INSERT INTO smm_scenario (campaign_id, title, assistant_role, dialog, mood, tts_tier)
     VALUES ($1, 't', 'psy', '[]'::jsonb, 'neutral', 'economy') RETURNING id`,
    [c.rows[0].id]);
  const v = await pool.query(
    `INSERT INTO smm_video (scenario_id, status, tokens_charged)
     VALUES ($1, 'rendering', 15000) RETURNING id`, [s.rows[0].id]);
  await pool.query(
    `INSERT INTO smm_billing_ledger (user_id, video_id, amount, op, reason)
     VALUES ($1, $2, 15000, 'charge', 'queued')`,
    [TEST_USER, v.rows[0].id],
  );
  await pool.query(
    `UPDATE ai_profiles_consolidated SET tokens = tokens - 15000 WHERE user_id = $1`,
    [TEST_USER],
  );
  return { campaignId: c.rows[0].id, videoId: v.rows[0].id };
}

async function cleanup(campaignId) {
  await pool.query(`DELETE FROM smm_billing_ledger WHERE user_id = $1`, [TEST_USER]);
  await pool.query(`DELETE FROM smm_campaign WHERE id = $1`, [campaignId]);
  await pool.query(`UPDATE ai_profiles_consolidated SET tokens = 1000000 WHERE user_id = $1`, [TEST_USER]);
}

module.exports = {
  'render-callback: without secret → 401': async () => {
    const resp = await http.post('/webhook/smm/internal/render-callback', {
      videoId: '00000000-0000-0000-0000-000000000000', status: 'ready', mp4Url: 'x',
    });
    if (resp.status !== 401) throw new Error(`Expected 401, got ${resp.status}`);
  },

  'render-callback: with wrong secret → 401': async () => {
    if (!WORKER_SECRET) { console.log('  (skip: SMM_WORKER_SECRET not set)'); return; }
    const resp = await http.post(
      '/webhook/smm/internal/render-callback',
      { videoId: '00000000-0000-0000-0000-000000000000', status: 'ready', mp4Url: 'x' },
      { headers: { 'X-Smm-Worker-Secret': 'wrong' } });
    if (resp.status !== 401) throw new Error(`Expected 401, got ${resp.status}`);
  },

  'render-callback: ready → updates video, no refund': async () => {
    if (!WORKER_SECRET) { console.log('  (skip)'); return; }
    const { campaignId, videoId } = await createVideoFixture();
    try {
      const resp = await http.post(
        '/webhook/smm/internal/render-callback',
        { videoId, status: 'ready', mp4Url: 'https://example/v.mp4', durationSec: 60, sizeBytes: 5000000 },
        { headers: workerHeaders() });
      if (resp.status !== 201 && resp.status !== 200) {
        throw new Error(`Expected 200/201, got ${resp.status}: ${JSON.stringify(resp.data)}`);
      }
      const v = await pool.query(`SELECT status, mp4_url, duration_sec FROM smm_video WHERE id = $1`, [videoId]);
      if (v.rows[0].status !== 'ready') throw new Error(`Expected status=ready, got ${v.rows[0].status}`);
      if (v.rows[0].mp4_url !== 'https://example/v.mp4') throw new Error('mp4_url mismatch');
      if (v.rows[0].duration_sec !== 60) throw new Error('duration_sec mismatch');
      const refunds = await pool.query(
        `SELECT count(*)::int as n FROM smm_billing_ledger WHERE video_id = $1 AND op = 'refund'`, [videoId]);
      if (refunds.rows[0].n !== 0) throw new Error('Expected no refund row');
    } finally { await cleanup(campaignId); }
  },

  'render-callback: failed → updates video + refund': async () => {
    if (!WORKER_SECRET) { console.log('  (skip)'); return; }
    const { campaignId, videoId } = await createVideoFixture();
    try {
      const resp = await http.post(
        '/webhook/smm/internal/render-callback',
        { videoId, status: 'failed', errorMessage: 'TTS API 503' },
        { headers: workerHeaders() });
      if (resp.status !== 201 && resp.status !== 200) {
        throw new Error(`Expected 200/201, got ${resp.status}`);
      }
      const v = await pool.query(`SELECT status, error_message FROM smm_video WHERE id = $1`, [videoId]);
      if (v.rows[0].status !== 'failed') throw new Error('expected failed');
      if (!v.rows[0].error_message.includes('TTS')) throw new Error('error message missing');
      const refunds = await pool.query(
        `SELECT amount FROM smm_billing_ledger WHERE video_id = $1 AND op = 'refund'`, [videoId]);
      if (refunds.rows.length !== 1) throw new Error('Expected 1 refund row');
      if (refunds.rows[0].amount !== -15000) throw new Error(`Expected -15000, got ${refunds.rows[0].amount}`);
    } finally { await cleanup(campaignId); }
  },

  'render-state: updates render_state jsonb': async () => {
    if (!WORKER_SECRET) { console.log('  (skip)'); return; }
    const { campaignId, videoId } = await createVideoFixture();
    try {
      const newState = { scenarioLoaded: true, voicesSynthesized: ['voice-0.mp3'] };
      const resp = await http.post(
        '/webhook/smm/internal/render-state',
        { videoId, renderState: newState },
        { headers: workerHeaders() });
      if (resp.status !== 201 && resp.status !== 200) {
        throw new Error(`Expected 200/201, got ${resp.status}`);
      }
      const v = await pool.query(`SELECT render_state, status FROM smm_video WHERE id = $1`, [videoId]);
      if (v.rows[0].status !== 'rendering') throw new Error(`status not flipped to rendering`);
      if (!v.rows[0].render_state.scenarioLoaded) throw new Error('render_state not persisted');
    } finally { await cleanup(campaignId); }
  },
};
