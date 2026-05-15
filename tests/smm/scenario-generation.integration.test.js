const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { ScenarioService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'producer', 'scenario.service'),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pg = { query: (text, params) => pool.query(text, params) };

async function makeCampaign(userId, mode = 'topic', count = 2, topic = null) {
  const r = await pool.query(
    `INSERT INTO smm_campaign (user_id, source_mode, requested_count, topic)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, mode, count, topic],
  );
  return r.rows[0].id;
}

async function cleanup(userId) {
  await pool.query(`DELETE FROM smm_campaign WHERE user_id = $1`, [userId]);
}

module.exports = {
  'scenarios: generate 2 from topic — returns 2 rows in smm_scenario': async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('  (skip: ANTHROPIC_API_KEY not set)');
      return;
    }
    const TEST_USER = '70000099999';
    const campaignId = await makeCampaign(TEST_USER, 'topic', 2, 'тревога перед сном');
    try {
      const svc = new ScenarioService(pg);
      const ids = await svc.generate({
        campaignId,
        mode: 'topic',
        count: 2,
        topic: 'тревога перед сном',
      });
      if (ids.length !== 2) throw new Error(`Expected 2 ids, got ${ids.length}`);

      const rows = await pool.query(
        `SELECT id, title, assistant_role, dialog, mood, broll_prompts, tts_tier, status
           FROM smm_scenario WHERE campaign_id = $1`,
        [campaignId],
      );
      if (rows.rows.length !== 2) throw new Error(`Expected 2 DB rows, got ${rows.rows.length}`);
      for (const row of rows.rows) {
        if (!row.title || row.title.length < 5) throw new Error(`bad title: ${row.title}`);
        if (!['psy', 'lawyer', 'coach'].includes(row.assistant_role)) {
          throw new Error(`bad assistant_role: ${row.assistant_role}`);
        }
        if (!Array.isArray(row.dialog) || row.dialog.length < 2) {
          throw new Error(`bad dialog: ${JSON.stringify(row.dialog).slice(0, 80)}`);
        }
        for (const turn of row.dialog) {
          if (!['hero', 'assistant'].includes(turn.speaker)) throw new Error(`bad speaker`);
          if (!turn.text || typeof turn.tStart !== 'number' || typeof turn.tEnd !== 'number') {
            throw new Error(`bad turn: ${JSON.stringify(turn)}`);
          }
        }
        if (!['dramatic', 'inspiring', 'calm', 'uplifting', 'tense', 'neutral'].includes(row.mood)) {
          throw new Error(`bad mood: ${row.mood}`);
        }
        if (row.status !== 'pending_review') throw new Error(`bad status: ${row.status}`);
        if (!['economy', 'premium'].includes(row.tts_tier)) throw new Error(`bad tier`);
      }
    } finally {
      await cleanup(TEST_USER);
    }
  },

  'scenarios: regenerate one scenario produces a different dialog': async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('  (skip)');
      return;
    }
    const TEST_USER = '70000099999';
    const campaignId = await makeCampaign(TEST_USER, 'topic', 1, 'долги');
    try {
      const svc = new ScenarioService(pg);
      const [id] = await svc.generate({ campaignId, mode: 'topic', count: 1, topic: 'долги' });
      const before = await pool.query(`SELECT dialog FROM smm_scenario WHERE id = $1`, [id]);
      const oldDialog = JSON.stringify(before.rows[0].dialog);

      await svc.regenerate(id, 'сделай эмоциональнее, начни с боли');

      const after = await pool.query(`SELECT dialog, status FROM smm_scenario WHERE id = $1`, [id]);
      const newDialog = JSON.stringify(after.rows[0].dialog);
      if (newDialog === oldDialog) throw new Error('dialog unchanged after regenerate');
      if (after.rows[0].status !== 'pending_review') {
        throw new Error(`status after regen = ${after.rows[0].status}`);
      }
    } finally {
      await cleanup(TEST_USER);
    }
  },
};
