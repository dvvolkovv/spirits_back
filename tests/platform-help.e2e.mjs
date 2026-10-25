/**
 * Живая проверка справки о Linkeon (linkeon_help) — после выката, на ПРОДЕ.
 * Спека: docs/superpowers/specs/2026-10-24-platform-help-design.md, «Проверка».
 *
 * На проде, а не на стенде: релейные инструменты точки продуктов со стенда ходят
 * в прод (в .env стенда нет BACKEND_URL), и проверка там дала бы ложный красный.
 * Каждый вопрос — в чистой сессии (fresh + freshTs): иначе ход уходит в
 * накопленную сессию, где старая история перевешивает свежую справку.
 *
 *   BASE_URL=https://my.linkeon.io TEST_PHONE=… DEBUG_SECRET=… OUT_DIR=~/kb-e2e \
 *   node tests/platform-help.e2e.mjs
 *
 * CASES=domain-ru,studio-en — только перечисленные.
 * Автоматически проверяется объективное: позвал ли ассистент справку (шаг
 * работы help), названы ли нужные подписи, нет ли внутренностей. Верность по
 * существу читает человек: ответы — в OUT_DIR/<время прогона>/<case>.md.
 * Проверки «⚠» — известный риск вне этого этапа, прогон они не валят.
 * Каждый ход — настоящий ход к модели: прогон тратит токены тестового аккаунта.
 * Админский номер прогон не трогает.
 */
import fs from 'node:fs';
import path from 'node:path';
import debugSecret from './debug-secret.js';

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`задай ${k}`);
  return v;
};
const BASE = need('BASE_URL').replace(/\/$/, '');
const PHONE = need('TEST_PHONE');
debugSecret.debugSecret(); // без DEBUG_SECRET — ошибка сразу, до платных ходов
const RUN_DIR = path.join(need('OUT_DIR'), new Date().toISOString().replace(/[:.]/g, '-'));
const ONLY = (process.env.CASES || '').split(',').map((s) => s.trim()).filter(Boolean);
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const UI = { activity: true, ask: false };
const TURN_TIMEOUT_MS = 700_000;
const CALL_TIMEOUT_MS = 30_000;
const TEST_LANGUAGE = 'ru';
const STOP = [
  ['IP-адрес', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
  ['релей', /рел[еэ][йяюе]|\brelay\b/i],
  ['sudo', /\bsudo\b/i],
  ['ручка', /\/webhook\//i],
  ['переменная окружения', /\b(?:[A-Z][A-Z0-9]*_)+(?:SECRET|KEY|TOKEN|URL)\b/],
  ['версия модели', /\b(?:opus|sonnet|haiku)[-\s]?\d/i],
  ['системный промпт', /системн(?:ый|ого|ом) промпт|system prompt/i],
];
const CUSTOM = 'custom';
const STORE = { 'x-linkeon-distribution': 'appstore' };

/**
 * pick — displayName ассистента, регулярка по описанию или CUSTOM (временный
 * свой ассистент). lang — язык аккаунта на время вопроса: от него зависят
 * подписи в справке. expect — подписи, которые ответ обязан назвать.
 */
const CASES = [
  { id: 'domain-ru', pick: 'Роман', lang: 'ru', q: 'Как привязать свой домен к моему сайту в Linkeon?', help: true, expect: ['Свой домен'] },
  { id: 'video-price-ru', pick: 'Кира', lang: 'ru', q: 'Сколько стоит ролик на минуту и где его сделать?', help: true, expect: ['Видео'] },
  { id: 'routine-ru', pick: 'Райя', lang: 'ru', q: 'Мне перестала приходить энергия дня. Что проверить?', help: true, expect: ['Уведомления на этом устройстве'] },
  { id: 'models-ru', pick: 'Роман', lang: 'ru', q: 'На каких нейросетях работает Linkeon и где хранятся мои данные?', help: true, expect: ['Claude'] },
  { id: 'notion-ru', pick: 'Роман', lang: 'ru', q: 'Как выгрузить этот чат в Notion одной кнопкой?', help: true, expect: [] },
  { id: 'meeting-ru', pick: 'Роман', lang: 'ru', q: 'Можешь прийти на мою встречу в Zoom завтра?', help: true, expect: ['Zoom'] },
  { id: 'payment-ru', pick: 'Роман', lang: 'ru', q: 'Я оплатил пакет, а токены не пришли. Что делать?', help: true, expect: ['Связаться с поддержкой'] },
  { id: 'product-edit-ru', pick: 'Кира', lang: 'ru', q: 'Как мне поменять текст на моём сайте, который сделан в Linkeon?', help: true, expect: [] },
  { id: 'bot-group-ru', pick: /юрист/i, lang: 'ru', q: 'Можно ли тебя добавить в мою группу в Телеграме?', help: true, expect: ['Telegram-боты'] },
  { id: 'masha-files-ru', pick: 'Маша', lang: 'ru', q: 'Какие файлы тебе можно прислать?', help: true, expect: [] },
  { id: 'custom-ru', pick: CUSTOM, lang: 'ru', q: 'Где в Linkeon подключить календарь?', help: true, expect: ['Календари'] },
  { id: 'conflict-ru', pick: 'Кира', lang: 'ru', q: 'Сделай мне видео через Kling — какие там сейчас тарифы?', help: true, expect: [] },
  { id: 'initiative-ru', pick: 'Кира', lang: 'ru', q: 'Нужен простой сайт-визитка для моей кофейни. Какие блоки в нём должны быть?', help: false, expect: [], initiative: ['Продукты', 'Студия'] },
  { id: 'store-ru', pick: 'Роман', lang: 'ru', q: 'Сколько стоит сделать картинку?', help: true, expect: [], headers: STORE, noTokens: 'soft' },
  { id: 'studio-en', pick: 'Роман', lang: 'en', q: 'Where can I create my own website on Linkeon?', help: true, expect: ['Studio', 'Products'] },
  { id: 'calendar-en', pick: 'Кира', lang: 'en', q: 'How do I connect my Google calendar here?', help: true, expect: ['Calendars'] },
  { id: 'privacy-en', pick: 'Роман', lang: 'en', q: 'Who can see my phone number on Linkeon?', help: true, expect: [] },
  { id: 'tokens-es', pick: 'Роман', lang: 'es', q: '¿En qué se gastan los tokens y dónde veo mi consumo por meses?', help: true, expect: [] },
  { id: 'call-es', pick: 'Роман', lang: 'es', q: '¿Puedo hablar contigo por voz?', help: true, expect: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let checks = 0;
const check = (name, ok, detail = '', soft = false) => {
  checks++;
  const mark = ok ? '✓' : soft ? '⚠' : '✗';
  console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok && !soft) failed++;
};

async function login() {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetch(`${BASE}/webhook/${SMS_WH}/sms/${PHONE}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      await sleep(1200);
      const codeRes = await fetch(`${BASE}/webhook/debug/sms-code/${PHONE}`, {
        headers: debugSecret.debugHeaders(),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!codeRes.ok) throw new Error(`debug-код: HTTP ${codeRes.status}`);
      const code = await codeRes.json();
      if (!code.code) throw new Error('debug-код не выдан');
      const r = await (await fetch(`${BASE}/webhook/${CHECK_WH}/check-code/${PHONE}/${code.code}`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })).json();
      if (!r['access-token']) throw new Error('вход не прошёл');
      return r['access-token'];
    } catch (e) {
      // Код могла перехватить параллельная проверка (smoke) — один повтор.
      if (attempt >= 2) throw e;
      await sleep(5000);
    }
  }
}

async function api(token, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status}`);
  return res.json();
}

async function setLanguage(token, language) {
  for (let attempt = 1; ; attempt++) {
    try {
      await api(token, 'POST', '/webhook/profile-update', { language });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000);
    }
  }
}

/** Ход в чистой сессии: текст ответа и коды шагов работы. */
async function say(token, assistantId, message, headers = {}) {
  const res = await fetch(`${BASE}/webhook/soulmate/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ message, assistantId: String(assistantId), fresh: true, freshTs: String(Date.now()), ui: UI }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let end = null;
  const kinds = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'activity') kinds.push(ev.kind);
      if (ev.type === 'end' && typeof ev.content === 'string') end = ev.content;
    } catch { /* не-JSON строка стрима */ }
  }
  if (end === null) throw new Error('в потоке нет события end');
  return { text: end.trim(), kinds };
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const token = await login();
  const me = (await api(token, 'GET', '/webhook/profile'))?.[0]?.profileJson;
  if (me?.isadmin) throw new Error('TEST_PHONE указывает на админа — прогон остановлен');
  const agents = await api(token, 'GET', '/webhook/agents?lang=ru');
  let langNow = me?.language || TEST_LANGUAGE;
  let custom = null;
  try {
    for (const c of CASES.filter((x) => !ONLY.length || ONLY.includes(x.id))) {
      let assistantId;
      if (c.pick === CUSTOM) {
        custom = custom || (await api(token, 'POST', '/webhook/custom-agents', {
          name: 'Проверка справки',
          systemPrompt: 'Ты помощник по планированию дня. Отвечай коротко и по делу.',
        }));
        assistantId = `custom:${custom.id}`;
      } else {
        const a = agents.find((x) => (typeof c.pick === 'string' ? x.displayName === c.pick : c.pick.test(x.description || '')));
        if (!a) {
          check(`${c.id}: ассистент найден`, false, String(c.pick));
          continue;
        }
        assistantId = a.id;
      }
      if (c.lang !== langNow) {
        await setLanguage(token, c.lang);
        langNow = c.lang;
      }
      let r;
      try {
        r = await say(token, assistantId, c.q, c.headers || {});
      } catch (e) {
        check(`${c.id}: ход прошёл`, false, e.message);
        continue;
      }
      fs.writeFileSync(
        path.join(RUN_DIR, `${c.id}.md`),
        `<!-- ${new Date().toISOString()} · ${BASE} · ${c.lang} · ассистент ${assistantId} · шаги: ${r.kinds.join(', ') || 'нет'} -->\n\n` +
          `**Человек:** ${c.q}\n\n**Ответ:**\n\n${r.text}\n`,
      );
      if (c.help) check(`${c.id}: позвал справку`, r.kinds.includes('help'), `шаги: ${r.kinds.join(', ') || 'нет'}`);
      for (const label of c.expect) check(`${c.id}: назвал «${label}»`, r.text.includes(label));
      if (c.initiative) check(`${c.id}: предложил функцию Linkeon`, c.initiative.some((l) => r.text.includes(l)));
      if (c.noTokens) {
        // ⚠: промпт релея и описания инструментов картинок называют цены всем клиентам (спека, «Замечено по ходу»).
        check(`${c.id}: ни слова о токенах и ценах (стор)`, !/токен|token|₽|\$/i.test(r.text), '', c.noTokens === 'soft');
      }
      const leak = STOP.filter(([, re]) => re.test(r.text)).map(([n]) => n);
      check(`${c.id}: без внутренностей`, leak.length === 0, leak.join(', '));
    }
  } finally {
    if (langNow !== TEST_LANGUAGE) await setLanguage(token, TEST_LANGUAGE);
    if (custom) await api(token, 'DELETE', `/webhook/custom-agents/${custom.id}`);
  }
  console.log(`\n${checks - failed}/${checks} проверок; ответы — ${RUN_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
