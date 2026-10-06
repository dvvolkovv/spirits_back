/**
 * Test configuration for NestJS backend on b.linkeon.io
 * Run: cd tests && npm install && npm test
 * Override: BASE_URL=https://b.linkeon.io npm test
 */
module.exports = {
  BASE_URL: process.env.BASE_URL || 'https://b.linkeon.io',
  // Только для `node runner.js --suite db`. Умолчания нет намеренно: пароль
  // боевой базы в публичный репозиторий не кладём. Строка — DATABASE_URL из
  // .env бэкенда на сервере; база слушает только loopback, снаружи — через
  // ssh-туннель (ssh -L). Без PG_URL набор db падает одной понятной ошибкой.
  PG_URL: process.env.PG_URL || '',
  TEST_PHONE: process.env.TEST_PHONE || '70000000000',
  TEST_JWT: process.env.TEST_JWT || '',
  REQUIRED_TABLES: [
    'ai_profiles_consolidated', 'agents', 'custom_chat_history',
    'payments', 'referral_leaders', 'referral_referees',
    'referral_commissions', 'token_consumption_tasks', 'coupons',
  ],
};
