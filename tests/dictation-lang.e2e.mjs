/**
 * Живая проверка голосового ввода: слушает ли диктовка на языке профиля.
 * Запускается вручную после выката, в общий runner не заведена: каждый прогон
 * синтезирует речь (OpenAI, списывается с тестового аккаунта) и распознаёт её
 * в Яндексе.
 *
 * Что делает:
 *   1. Входит тестовым номером через debug-OTP.
 *   2. Для каждого случая выставляет язык профиля (POST /webhook/profile-update).
 *   3. Озвучивает известную фразу нашим же синтезом (POST /webhook/tts, mp3) и
 *      переводит её ffmpeg'ом в LPCM16 / 16 кГц / моно — то же, что шлёт ворклет
 *      фронта (public/pcm-recorder-worklet.js).
 *   4. Шлёт звук в /voice/stream кадрами по 100 мс в реальном темпе, печатает
 *      partial и final, сверяет final со сказанной фразой по словам.
 *   5. В конце возвращает исходный язык профиля.
 *
 * Случаи: en, de, es, fr, pt, ru — речь на языке профиля; «ru@en» — русская
 * речь при английском профиле (к нерусскому языку SpeechKit получает ещё
 * ru-RU); zh — ждём отказ lang_unsupported без звука.
 *
 * Окружение:
 *   BASE_URL       — по умолчанию https://test.linkeon.io
 *   VOICE_WS_URL   — адрес шлюза; по умолчанию wss://<BASE_URL>/voice/stream.
 *                    В nginx test.linkeon.io на 26.10.2026 НЕТ location /voice/:
 *                    путь уходит в статику под Basic Auth, и апгрейд до API не
 *                    доходит. На test запускать с ноды и ходить в API напрямую:
 *                    VOICE_WS_URL=ws://127.0.0.1:3001/voice/stream
 *   DEBUG_SECRET   — секрет debug-ручек этой среды (см. tests/debug-secret.js)
 *   TEST_BASIC_AUTH — user:pass Basic Auth стенда; уходит только в апгрейд
 *                    WebSocket (на /webhook/ у test Basic Auth выключен, а
 *                    Authorization там занят Bearer-токеном)
 *   TEST_PHONE     — по умолчанию 70000000000
 *   CASES          — через запятую, по умолчанию все: en,de,es,fr,pt,ru,ru@en,zh
 *
 * Пример (на ноде, из CI-клона с node_modules):
 *   DEBUG_SECRET="$(sed -n 's/^DEBUG_SECRET=//p' ~/spirits_back/.env)" \
 *   VOICE_WS_URL=ws://127.0.0.1:3001/voice/stream \
 *   node tests/dictation-lang.e2e.mjs
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import debugSecret from './debug-secret.js';

const BASE = (process.env.BASE_URL || 'https://test.linkeon.io').replace(/\/+$/, '');
const WS_URL = process.env.VOICE_WS_URL || `${BASE.replace(/^http/i, 'ws')}/voice/stream`;
const PHONE = process.env.TEST_PHONE || '70000000000';
const BASIC = process.env.TEST_BASIC_AUTH || '';
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';

const FRAME_BYTES = 3200; // 100 мс PCM16 на 16 кГц — как кадр ворклета
const FRAME_MS = 100;

/** Случай: язык профиля, фраза, что ждём. */
const ALL_CASES = {
  en: { profile: 'en', text: 'Please remind me to call my sister tomorrow morning.' },
  de: { profile: 'de', text: 'Bitte erinnere mich morgen früh daran, meine Schwester anzurufen.' },
  es: { profile: 'es', text: 'Por favor, recuérdame llamar a mi hermana mañana por la mañana.' },
  fr: { profile: 'fr', text: "Rappelle-moi d'appeler ma sœur demain matin, s'il te plaît." },
  pt: { profile: 'pt', text: 'Por favor, lembra-me de ligar à minha irmã amanhã de manhã.' },
  ru: { profile: 'ru', text: 'Пожалуйста, напомни мне завтра утром позвонить сестре.' },
  'ru@en': { profile: 'en', text: 'Пожалуйста, напомни мне завтра утром позвонить сестре.' },
  zh: { profile: 'zh', text: null, expectError: 'lang_unsupported' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function login() {
  await fetch(`${BASE}/webhook/${SMS_WH}/sms/${PHONE}`);
  await sleep(1200);
  const code = await (await fetch(`${BASE}/webhook/debug/sms-code/${PHONE}`, {
    headers: debugSecret.debugHeaders(),
  })).json();
  if (!code.code) throw new Error('нет debug-кода: ' + JSON.stringify(code));
  const r = await (await fetch(`${BASE}/webhook/${CHECK_WH}/check-code/${PHONE}/${code.code}`)).json();
  if (!r['access-token']) throw new Error('логин не прошёл: ' + JSON.stringify(r));
  return r['access-token'];
}

async function profileLanguage(token) {
  const res = await fetch(`${BASE}/webhook/profile`, { headers: bearer(token) });
  if (!res.ok) throw new Error(`GET /webhook/profile → ${res.status}`);
  const body = await res.json();
  const p = Array.isArray(body) ? body[0]?.profileJson : body?.profileJson;
  return p?.profile_data?.language ?? null;
}

async function setLanguage(token, language) {
  const res = await fetch(`${BASE}/webhook/profile-update`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  if (!res.ok) throw new Error(`profile-update language=${language} → ${res.status}`);
  const now = await profileLanguage(token);
  if (now !== language) throw new Error(`язык профиля не сменился: ждали ${language}, в профиле ${now}`);
}

async function synthesize(token, text) {
  const res = await fetch(`${BASE}/webhook/tts`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, format: 'mp3' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`POST /webhook/tts → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** mp3 → LPCM16 LE / 16 кГц / моно через ffmpeg (stdin → stdout). */
function toPcm16(input) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
      'pipe:1',
    ]);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => reject(new Error(`ffmpeg не запустился (${e.message}) — нужен ffmpeg в PATH`)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.trim()}`))));
    ff.stdin.end(input);
  });
}

/**
 * Один сеанс диктовки. Возвращает { error, partials, finals }.
 * pcm === null — звук не шлём, только ждём ответа шлюза (для отказа).
 */
function dictate(token, pcm) {
  return new Promise((resolve, reject) => {
    const headers = BASIC ? { Authorization: `Basic ${Buffer.from(BASIC).toString('base64')}` } : {};
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`, { headers });
    const result = { error: null, partials: [], finals: [] };
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(guard); resolve(result); } };
    const guard = setTimeout(() => { result.error = result.error || 'timeout'; try { ws.terminate(); } catch {} finish(); }, 60000);

    ws.on('unexpected-response', (_req, res) => {
      settled = true;
      clearTimeout(guard);
      reject(new Error(
        `апгрейд ${WS_URL} → HTTP ${res.statusCode}. ` +
        'Если это test.linkeon.io: в его nginx нет location /voice/ — запусти с ноды с VOICE_WS_URL=ws://127.0.0.1:3001/voice/stream',
      ));
    });
    ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(guard); reject(e); } });
    ws.on('close', finish);

    let streaming = false;
    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'partial') { result.partials.push(m.text); console.log(`    partial: ${m.text}`); }
      else if (m.type === 'final') { result.finals.push(m.text); console.log(`    final:   ${m.text}`); }
      else if (m.type === 'error') { result.error = m.message; console.log(`    error:   ${m.message}`); }
      else if (m.type === 'ready' && pcm && !streaming) {
        streaming = true;
        // Реальный темп, как у микрофона; в конце — секунда тишины, чтобы
        // SpeechKit закрыл фразу, затем stop.
        const audio = Buffer.concat([pcm, Buffer.alloc(FRAME_BYTES * 10)]);
        for (let i = 0; i < audio.length && ws.readyState === WebSocket.OPEN; i += FRAME_BYTES) {
          ws.send(audio.subarray(i, i + FRAME_BYTES));
          await sleep(FRAME_MS);
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      }
    });
  });
}

/** Доля слов фразы, которые нашлись в распознанном тексте. */
function overlap(expected, got) {
  const words = (s) => (s.toLowerCase().normalize('NFC').match(/\p{L}+/gu) || []);
  const want = words(expected);
  const have = new Set(words(got));
  return want.length ? want.filter((w) => have.has(w)).length / want.length : 0;
}

const selected = (process.env.CASES || Object.keys(ALL_CASES).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const c of selected) if (!ALL_CASES[c]) throw new Error(`неизвестный случай ${c}; есть: ${Object.keys(ALL_CASES).join(', ')}`);

console.log(`BASE=${BASE}\nWS=${WS_URL}\nслучаи: ${selected.join(', ')}\n`);
const token = await login();
const original = await profileLanguage(token);
console.log(`исходный язык профиля: ${original ?? '(не задан)'}\n`);

let failed = 0;
try {
  for (const name of selected) {
    const c = ALL_CASES[name];
    console.log(`== ${name}: профиль=${c.profile}${c.text ? `, фраза: «${c.text}»` : ''}`);
    try {
      await setLanguage(token, c.profile);
      const pcm = c.text ? await toPcm16(await synthesize(token, c.text)) : null;
      if (pcm) console.log(`    звук: ${(pcm.length / 32000).toFixed(1)} с PCM16/16k/mono`);
      const r = await dictate(token, pcm);
      let ok;
      if (c.expectError) {
        ok = r.error === c.expectError && r.finals.length === 0;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ждали ${c.expectError}, пришло ${r.error ?? 'без ошибки'}`);
      } else {
        const text = r.finals.join(' ');
        const score = overlap(c.text, text);
        ok = !r.error && score >= 0.5;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: совпало слов ${Math.round(score * 100)}%${r.error ? `, ошибка ${r.error}` : ''}`);
      }
      if (!ok) failed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${e.message}`);
    }
    console.log('');
    await sleep(500);
  }
} finally {
  // Сбросить язык в «не задан» ручка не умеет (profile-update отбрасывает
  // незнакомое значение), поэтому для такого аккаунта возвращаем русский.
  const back = original || 'ru';
  try {
    await setLanguage(token, back);
    console.log(`язык профиля возвращён: ${back}${original ? '' : ' (исходно не был задан — поставлен русский)'}`);
  } catch (e) {
    failed++;
    console.log(`НЕ УДАЛОСЬ вернуть язык профиля ${back}: ${e.message}`);
  }
}

console.log(failed === 0 ? '\nВсе случаи зелёные' : `\n${failed} случаев красные`);
process.exit(failed === 0 ? 0 : 1);
