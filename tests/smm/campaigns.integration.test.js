const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const axios = require('axios');
const { Pool } = require('pg');
const config = require('../config');

const BASE_URL = process.env.SMM_API_BASE || config.BASE_URL;
const ADMIN_JWT = process.env.SMM_ADMIN_JWT || '';
const NON_ADMIN_JWT = process.env.SMM_NON_ADMIN_JWT || '';

const http = axios.create({
  baseURL: BASE_URL,
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  timeout: 15000,
  validateStatus: () => true,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

module.exports = {
  'campaigns POST without JWT → 401': async () => {
    const resp = await http.post('/webhook/smm/campaigns', {
      sourceMode: 'topic', requestedCount: 1,
    });
    if (resp.status !== 401) {
      throw new Error(`Expected 401, got ${resp.status} body=${JSON.stringify(resp.data)}`);
    }
  },

  'campaigns POST with non-admin JWT → 403': async () => {
    if (!NON_ADMIN_JWT) {
      console.log('  (skip: SMM_NON_ADMIN_JWT not set)');
      return;
    }
    const resp = await http.post(
      '/webhook/smm/campaigns',
      { sourceMode: 'topic', requestedCount: 1 },
      { headers: bearer(NON_ADMIN_JWT) },
    );
    if (resp.status !== 403) {
      throw new Error(`Expected 403, got ${resp.status} body=${JSON.stringify(resp.data)}`);
    }
  },

  'campaigns POST with admin JWT → 201 + DB row': async () => {
    if (!ADMIN_JWT) {
      throw new Error('SMM_ADMIN_JWT env var not set');
    }
    const resp = await http.post(
      '/webhook/smm/campaigns',
      { sourceMode: 'topic', requestedCount: 2, topic: 'тестовая тема' },
      { headers: bearer(ADMIN_JWT) },
    );
    if (resp.status !== 201 && resp.status !== 200) {
      throw new Error(`Expected 200/201, got ${resp.status} body=${JSON.stringify(resp.data)}`);
    }
    const id = resp.data.id;
    if (!id) throw new Error(`Missing id in response: ${JSON.stringify(resp.data)}`);
    try {
      const r = await pool.query(`SELECT topic, source_mode, requested_count FROM smm_campaign WHERE id = $1`, [id]);
      if (r.rows.length !== 1) throw new Error(`Campaign ${id} not in DB`);
      if (r.rows[0].topic !== 'тестовая тема') throw new Error(`Topic mismatch`);
      if (r.rows[0].source_mode !== 'topic') throw new Error(`Source mode mismatch`);
      if (r.rows[0].requested_count !== 2) throw new Error(`Count mismatch`);
    } finally {
      await pool.query(`DELETE FROM smm_campaign WHERE id = $1`, [id]);
    }
  },

  'campaigns POST with invalid requestedCount → 400': async () => {
    if (!ADMIN_JWT) {
      console.log('  (skip: SMM_ADMIN_JWT not set)');
      return;
    }
    const resp = await http.post(
      '/webhook/smm/campaigns',
      { sourceMode: 'topic', requestedCount: 999 },
      { headers: bearer(ADMIN_JWT) },
    );
    if (resp.status !== 400) {
      throw new Error(`Expected 400, got ${resp.status}`);
    }
  },

  'campaigns GET unknown id → 404': async () => {
    if (!ADMIN_JWT) {
      console.log('  (skip: SMM_ADMIN_JWT not set)');
      return;
    }
    const resp = await http.get(
      '/webhook/smm/campaigns/00000000-0000-0000-0000-000000000000',
      { headers: bearer(ADMIN_JWT) },
    );
    if (resp.status !== 404) {
      throw new Error(`Expected 404, got ${resp.status}`);
    }
  },
};
