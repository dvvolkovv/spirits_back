/**
 * Замок debug-ручек на живой среде (шаг смоука, см. smoke.js).
 *
 * Положительный путь (верный X-Debug-Secret → 200) зеленеет и на коде без
 * замка, поэтому отдельно проверяется отказ: без заголовка и с неверным
 * заголовком той же длины каждая из трёх ручек обязана ответить 404 с JSON-телом
 * { error: 'Not found' } (так отвечает замок, src/auth/auth.controller.ts
 * debugNotFound) или 404 самого Nest — если маршрута нет вовсе.
 *
 * Почему мало «статус 404»:
 *   - SPA-фолбэк nginx отдаёт на любой путь 200 с HTML — поэтому требуется JSON;
 *   - ручки без замка тоже умеют отвечать 404 — { error: 'No code' } или
 *     { error: 'no active token' }, когда отдавать нечего. Поэтому сверяется
 *     и тело. Шаг стоит в смоуке сразу после получения кода, когда код в Redis
 *     есть, — ручка без замка ответила бы 200 с кодом.
 *
 * add-tokens зовётся с суммой 0: даже если замок не сработал, баланс не меняется.
 */
const axios = require('axios');

const LOCK_BODY_ERROR = /^not found$/i; // 'Not found' замка или 'Not Found' Nest
const LEAK_FIELDS = ['code', 'token', 'email', 'balance_before', 'balance_after'];

/** Строка той же длины, что секрет, но отличная от него в каждом знаке. */
function wrongSecretOfSameLength(secret) {
  return Array.from(secret, (ch) => (ch === 'x' ? 'y' : 'x')).join('');
}

/**
 * Прогнать шесть запросов (3 ручки × {без заголовка, неверный заголовок}).
 * Возвращает список нарушений; пустой список — замок на месте.
 */
async function probeDebugLock({ baseUrl, secret, phone = '70000000000', email = 'smoke-lock@example.com', timeout = 8000 }) {
  if (!secret) return ['DEBUG_SECRET не задан — не из чего собрать неверный заголовок той же длины'];
  const wrong = wrongSecretOfSameLength(secret);

  const routes = [
    { name: 'sms-code', method: 'get', url: `${baseUrl}/webhook/debug/sms-code/${phone}` },
    { name: 'email-token', method: 'get', url: `${baseUrl}/webhook/debug/email-token/${encodeURIComponent(email)}` },
    { name: 'add-tokens', method: 'post', url: `${baseUrl}/webhook/debug/add-tokens/${phone}/0` },
  ];
  const variants = [
    { name: 'без заголовка', headers: {} },
    { name: 'неверный заголовок', headers: { 'X-Debug-Secret': wrong } },
  ];

  const problems = [];
  for (const route of routes) {
    for (const variant of variants) {
      const label = `${route.name} ${variant.name}`;
      let r;
      try {
        r = await axios.request({
          method: route.method,
          url: route.url,
          headers: variant.headers,
          timeout,
          validateStatus: () => true,
          // Тело сверяем сами: строку не превращать в объект «по возможности».
          transformResponse: [(d) => d],
        });
      } catch (e) {
        problems.push(`${label}: запрос не прошёл (${e.code || e.message})`);
        continue;
      }
      const ctype = String(r.headers['content-type'] || '');
      let body = null;
      try { body = JSON.parse(r.data); } catch { /* не JSON */ }
      const snippet = String(r.data || '').replace(/\s+/g, ' ').slice(0, 80);

      if (r.status !== 404) {
        problems.push(`${label}: HTTP ${r.status}, ждали 404 (${snippet})`);
      } else if (!ctype.includes('application/json') || !body || typeof body !== 'object') {
        problems.push(`${label}: 404 не JSON (${ctype || 'без content-type'}: ${snippet})`);
      } else if (!LOCK_BODY_ERROR.test(String(body.error || ''))) {
        problems.push(`${label}: 404 не от замка — ${snippet}`);
      } else {
        const leaked = LEAK_FIELDS.filter((f) => f in body);
        if (leaked.length) problems.push(`${label}: в ответе поля ${leaked.join(', ')}`);
      }
    }
  }
  return problems;
}

module.exports = { probeDebugLock, wrongSecretOfSameLength };

// Ручной прогон: DEBUG_SECRET=… BASE_URL=… node tests/smoke/debug-lock.js
if (require.main === module) {
  probeDebugLock({ baseUrl: process.env.BASE_URL || 'https://my.linkeon.io', secret: process.env.DEBUG_SECRET })
    .then((problems) => {
      if (problems.length) {
        problems.forEach((p) => console.log(`  ✗ ${p}`));
        process.exit(1);
      }
      console.log('  ✓ debug-ручки закрыты: 6 запросов → 404 JSON');
    })
    .catch((e) => { console.error(e); process.exit(2); });
}
