const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { SmmPricingService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'billing', 'smm-pricing.service'),
);

// Mock PgService shape — only `query` is used
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pg = { query: (text, params) => pool.query(text, params) };

module.exports = {
  'pricing: getTariff returns economy and premium': async () => {
    const svc = new SmmPricingService(pg);
    await svc.onModuleInit();
    const economy = svc.getTariff('economy');
    const premium = svc.getTariff('premium');
    if (economy.tokensCost !== 15000) {
      throw new Error(`Expected economy 15000, got ${economy.tokensCost}`);
    }
    if (premium.tokensCost !== 50000) {
      throw new Error(`Expected premium 50000, got ${premium.tokensCost}`);
    }
  },

  'pricing: throws on unknown tariff': async () => {
    const svc = new SmmPricingService(pg);
    await svc.onModuleInit();
    let thrown = null;
    try {
      svc.getTariff('vip');
    } catch (e) {
      thrown = e;
    }
    if (!thrown) throw new Error('Expected error on unknown tariff');
    if (!thrown.message.match(/unknown.+tariff/i)) {
      throw new Error(`Unexpected message: ${thrown.message}`);
    }
  },

  'pricing: refresh picks up DB changes': async () => {
    const svc = new SmmPricingService(pg);
    await svc.onModuleInit();
    // Bump economy price by +1 in DB
    await pool.query(
      `UPDATE smm_pricing SET tokens_cost = tokens_cost + 1 WHERE id = 'economy'`,
    );
    try {
      await svc.refresh();
      const after = svc.getTariff('economy').tokensCost;
      if (after !== 15001) {
        throw new Error(`Expected 15001 after refresh, got ${after}`);
      }
    } finally {
      // restore
      await pool.query(`UPDATE smm_pricing SET tokens_cost = 15000 WHERE id = 'economy'`);
    }
  },
};
