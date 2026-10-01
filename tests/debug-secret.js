/**
 * Заголовок для debug-ручек бэкенда (/webhook/debug/sms-code, /debug/email-token,
 * /debug/add-tokens).
 *
 * С 01.10.2026 ручки открываются только заголовком X-Debug-Secret, равным
 * DEBUG_SECRET из .env бэкенда (src/auth/debug-access.ts); без него — 404.
 * Репозиторий публичный, поэтому секрета здесь нет: тесты берут его из
 * окружения. deploy.sh передаёт его смоуку сам; при ручном запуске — явно в
 * команду теста, без export и не печатая (для экспериментов — секрет test):
 *
 *   DEBUG_SECRET=$(ssh dv@85.192.61.231 "sed -n 's/^DEBUG_SECRET=//p' /home/dv/spirits_back/.env")
 *   DEBUG_SECRET="$DEBUG_SECRET" BASE_URL=https://test.linkeon.io node tests/smoke/smoke.js
 *
 * У прода (/home/dvolkov/spirits_back/.env) и test.linkeon.io секреты РАЗНЫЕ.
 */

const DEBUG_SECRET_HINT =
  'задай DEBUG_SECRET (лежит в .env сервера: /home/dvolkov/spirits_back/.env на проде, ' +
  '/home/dv/spirits_back/.env на test) — без него /webhook/debug/* отвечают 404';

function debugSecret() {
  const s = process.env.DEBUG_SECRET;
  if (!s) throw new Error(DEBUG_SECRET_HINT);
  return s;
}

/** Заголовки для запроса к debug-ручке; extra — прочие заголовки запроса. */
function debugHeaders(extra = {}) {
  return { ...extra, 'X-Debug-Secret': debugSecret() };
}

module.exports = { debugHeaders, debugSecret, DEBUG_SECRET_HINT };
