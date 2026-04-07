/**
 * PostgreSQL Database Tests
 * Verifies schema integrity after migration
 */

const { Pool } = require('pg');
const config = require('./config');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.PG_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

async function query(sql, params) {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function cleanup() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Auto-cleanup after tests
process.on('exit', () => { if (pool) pool.end(); });

module.exports = {
  // ============================================================
  // CONNECTIVITY
  // ============================================================

  'PostgreSQL is reachable': async () => {
    const result = await query('SELECT 1 as ok');
    if (result.rows[0].ok !== 1) throw new Error('Unexpected result from SELECT 1');
  },

  'PostgreSQL version is 14+': async () => {
    const result = await query('SELECT current_setting(\'server_version_num\')::int AS v');
    const ver = result.rows[0].v;
    if (ver < 140000) throw new Error(`PostgreSQL version too old: ${ver}`);
  },

  // ============================================================
  // TABLE EXISTENCE
  // ============================================================

  'table ai_profiles_consolidated exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ai_profiles_consolidated'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  'table agents exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'agents'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  'table custom_chat_history exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'custom_chat_history'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  'table payments exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'payments'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  'table referral_leaders exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'referral_leaders'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  'table referral_referees exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'referral_referees'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  'table token_consumption_tasks exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'token_consumption_tasks'
    `);
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('Table not found');
  },

  // ============================================================
  // SCHEMA VALIDATION
  // ============================================================

  'ai_profiles_consolidated has required columns': async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_profiles_consolidated'
    `);
    const cols = result.rows.map(r => r.column_name);
    const required = ['user_id', 'preferred_agent', 'tokens', 'email', 'isadmin'];
    const missing = required.filter(c => !cols.includes(c));
    if (missing.length > 0) throw new Error(`Missing columns: ${missing.join(', ')}`);
  },

  'agents table has data (at least 1 agent)': async () => {
    const result = await query('SELECT COUNT(*) as cnt FROM agents');
    if (parseInt(result.rows[0].cnt) === 0) throw new Error('No agents in database');
  },

  'agents table has name column': async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agents'
    `);
    const cols = result.rows.map(r => r.column_name);
    if (!cols.includes('name')) throw new Error('agents.name column missing');
  },

  'payments table has required columns': async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments'
    `);
    const cols = result.rows.map(r => r.column_name);
    const required = ['payment_id', 'status'];
    const missing = required.filter(c => !cols.includes(c));
    if (missing.length > 0) throw new Error(`Missing columns: ${missing.join(', ')}`);
  },

  'referral_leaders has slug column': async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'referral_leaders'
    `);
    const cols = result.rows.map(r => r.column_name);
    if (!cols.includes('slug')) throw new Error('referral_leaders.slug column missing');
  },

  'token_consumption_tasks has task_status_enum type': async () => {
    const result = await query(`
      SELECT typname FROM pg_type WHERE typname = 'task_status_enum'
    `);
    if (result.rows.length === 0) throw new Error('ENUM type task_status_enum not found');
  },

  'consume_user_tokens function exists': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM information_schema.routines
      WHERE routine_schema = 'public' AND routine_name = 'consume_user_tokens'
    `);
    if (parseInt(result.rows[0].cnt) === 0) {
      throw new Error('Function consume_user_tokens not found');
    }
  },

  // ============================================================
  // DATA INTEGRITY
  // ============================================================

  'ai_profiles_consolidated has no null user_id': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM ai_profiles_consolidated WHERE user_id IS NULL
    `);
    if (parseInt(result.rows[0].cnt) > 0) throw new Error('Found rows with null user_id');
  },

  'custom_chat_history table is accessible': async () => {
    await query('SELECT 1 FROM custom_chat_history LIMIT 1');
  },

  'payments: no duplicate payment_ids': async () => {
    const result = await query(`
      SELECT payment_id, COUNT(*) as cnt FROM payments
      GROUP BY payment_id HAVING COUNT(*) > 1
      LIMIT 5
    `);
    if (result.rows.length > 0) {
      throw new Error(`Found duplicate payment_ids: ${result.rows.map(r => r.payment_id).join(', ')}`);
    }
  },

  // ============================================================
  // INDEXES (performance)
  // ============================================================

  'ai_profiles_consolidated has index on user_id': async () => {
    const result = await query(`
      SELECT COUNT(*) as cnt FROM pg_indexes
      WHERE tablename = 'ai_profiles_consolidated'
      AND indexdef LIKE '%user_id%'
    `);
    if (parseInt(result.rows[0].cnt) === 0) {
      throw new Error('No index on ai_profiles_consolidated.user_id (performance warning)');
    }
  },
};
