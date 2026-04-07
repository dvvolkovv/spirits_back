/**
 * Test configuration for NestJS backend on b.linkeon.io
 * Run: cd tests && npm install && npm test
 * Override: BASE_URL=https://b.linkeon.io npm test
 */
module.exports = {
  BASE_URL: process.env.BASE_URL || 'https://b.linkeon.io',
  PG_URL: process.env.PG_URL || 'postgresql://linkeon:linkeon_pass_2026@82.202.197.230:5432/linkeon',
  TEST_PHONE: process.env.TEST_PHONE || '70000000000',
  TEST_JWT: process.env.TEST_JWT || '',
  REQUIRED_TABLES: [
    'ai_profiles_consolidated', 'agents', 'custom_chat_history',
    'payments', 'referral_leaders', 'referral_referees',
    'referral_commissions', 'token_consumption_tasks', 'coupons',
  ],
};
