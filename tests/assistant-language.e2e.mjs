/**
 * Отвечает ли ассистент на языке профиля. Запускается вручную:
 *   node tests/assistant-language.e2e.mjs
 *
 * В общий runner не заведён намеренно: каждый прогон это четыре настоящих хода
 * к модели, то есть расход ёмкости подписки.
 *
 * Две вещи, без которых прогон врёт:
 *  1. Реплика НЕЙТРАЛЬНАЯ ("ok"). На реплике по-немецки немецкий ответ ничего
 *     не доказывает: директива и без языка профиля велит отвечать на языке
 *     последнего сообщения.
 *  2. Реплики РАЗНЫЕ в каждом прогоне. Дедупликация ловит одинаковый текст в
 *     течение 12 секунд (DEDUP_COOLDOWN_MS) и отвечает заглушкой по-русски —
 *     выглядит в точности как «ассистент игнорирует язык профиля».
 *
 * Русский прогон в конце — контроль: без него набор не отличает «работает» от
 * «всегда отвечает по-русски». Он же возвращает тестовый аккаунт в исходное
 * состояние.
 */
const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const PHONE = process.env.TEST_PHONE || '70000000000';
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const ASSISTANT = '1'; // Миша — обычный путь через r.linkeon.io

const PROBES = { de: 'ok?', zh: 'ok :)', en: 'ok!', ru: 'ok.' };
const EXPECT = {
  de: /\b(ich|dein|dir|und|kann)\b/i,
  zh: /[一-鿿]/,
  en: /\b(the|you|your|and|can)\b/i,
  ru: /[Ѐ-ӿ]/,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  await fetch(`${BASE}/webhook/${SMS_WH}/sms/${PHONE}`);
  await sleep(1200);
  const code = await (await fetch(`${BASE}/webhook/debug/sms-code/${PHONE}`)).json();
  if (!code.code) throw new Error('нет debug-кода: ' + JSON.stringify(code));
  const r = await (await fetch(`${BASE}/webhook/${CHECK_WH}/check-code/${PHONE}/${code.code}`)).json();
  if (!r['access-token']) throw new Error('логин не прошёл: ' + JSON.stringify(r));
  return r['access-token'];
}

async function ask(token, message) {
  const res = await fetch(`${BASE}/webhook/soulmate/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, assistantId: ASSISTANT, fresh: true, freshTs: String(Date.now()) }),
    signal: AbortSignal.timeout(240000),
  });
  let full = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'end' && typeof ev.content === 'string') full = ev.content;
    } catch { /* не-JSON строка стрима */ }
  }
  return full.trim();
}

const token = await login();
let failed = 0;

for (const lang of ['de', 'zh', 'en', 'ru']) {
  await fetch(`${BASE}/webhook/profile-update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: lang }),
  });
  await sleep(500);
  const reply = await ask(token, PROBES[lang]);
  const ok = EXPECT[lang].test(reply);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} профиль=${lang}: ${reply.slice(0, 90).replace(/\s+/g, ' ')}`);
  await sleep(2000);
}

console.log(failed === 0 ? '\nВсе четыре прогона зелёные' : `\n${failed} прогонов красные`);
process.exit(failed === 0 ? 0 : 1);
