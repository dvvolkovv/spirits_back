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

async function createFixture() {
  await pool.query(
    `INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, updated_at)
     VALUES ($1, true, 1000000, now())
     ON CONFLICT (user_id) DO UPDATE SET tokens = 1000000`, [TEST_USER]);
  const c = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count)
     VALUES ($1, 'topic', 1) RETURNING id`, [TEST_USER]);
  const dialog = [{ speaker: 'hero', text: 'Помоги!', tStart: 0, tEnd: 2 }];
  const s = await pool.query(
    `INSERT INTO smm_scenario
       (campaign_id, title, assistant_role, dialog, mood, tts_tier)
     VALUES ($1, 'Стресс', 'psy', $2::jsonb, 'calm', 'economy') RETURNING id`,
    [c.rows[0].id, JSON.stringify(dialog)]);
  const v = await pool.query(
    `INSERT INTO smm_video (scenario_id) VALUES ($1) RETURNING id`, [s.rows[0].id]);
  return { campaignId: c.rows[0].id, videoId: v.rows[0].id, scenarioId: s.rows[0].id };
}

async function cleanup(campaignId) {
  await pool.query(`DELETE FROM smm_campaign WHERE id = $1`, [campaignId]);
}

module.exports = {
  'render-context: without secret → 401': async () => {
    const resp = await http.get('/webhook/smm/internal/render-context/00000000-0000-0000-0000-000000000000');
    if (resp.status !== 401) throw new Error(`Expected 401, got ${resp.status}`);
  },

  'render-context: unknown videoId → 404': async () => {
    if (!WORKER_SECRET) { console.log('  (skip)'); return; }
    const resp = await http.get(
      '/webhook/smm/internal/render-context/00000000-0000-0000-0000-000000000000',
      { headers: { 'X-Smm-Worker-Secret': WORKER_SECRET } });
    if (resp.status !== 404) throw new Error(`Expected 404, got ${resp.status}`);
  },

  'render-context: returns video + scenario': async () => {
    if (!WORKER_SECRET) { console.log('  (skip)'); return; }
    const { campaignId, videoId, scenarioId } = await createFixture();
    try {
      const resp = await http.get(
        `/webhook/smm/internal/render-context/${videoId}`,
        { headers: { 'X-Smm-Worker-Secret': WORKER_SECRET } });
      if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}: ${JSON.stringify(resp.data)}`);
      if (resp.data.video.id !== videoId) throw new Error('video.id mismatch');
      if (resp.data.scenario.id !== scenarioId) throw new Error('scenario.id mismatch');
      if (resp.data.scenario.dialog[0].text !== 'Помоги!') throw new Error('dialog not returned');
      if (resp.data.scenario.mood !== 'calm') throw new Error('mood mismatch');
    } finally { await cleanup(campaignId); }
  },
};
