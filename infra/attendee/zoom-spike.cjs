/**
 * Спайк Zoom: один скрипт вместо кода в проекте.
 *
 * ЗАЧЕМ ОТДЕЛЬНО. Разводить провайдера `zoom` по бэкенду и фронту нет смысла,
 * пока не проверено главное: пустит ли Zoom бота и пройдёт ли звук в обе
 * стороны. С Meet эта дисциплина сэкономила неделю — DIY-бота довели до
 * рабочего состояния и отложили, потому что живой прогон показал предел.
 *
 * ЧТО ДЕЛАЕТ:
 *   1. поднимает вебсокет на 8140 (тот же порт, что открыт наружу nginx-ом);
 *   2. создаёт бота в Attendee с нашим адресом и ссылкой на встречу Zoom;
 *   3. каждые 5 секунд печатает состояние бота и статистику звука ОТ встречи,
 *      включая RMS — чтобы отличить «звук идёт» от «идёт тишина»;
 *   4. через TONE_AFTER_MS отправляет во встречу тон 440 Гц на три секунды.
 *
 * Пункт 4 отдельный не случайно: на Meet исходящий звук молчал три живые
 * встречи подряд (мост искал кнопку микрофона только среди `<button>`, а она
 * `div`), и заметили это лишь потому, что человек сказал «не слышу». Тон
 * снимает вопрос сразу: слышно во встрече — путь работает.
 *
 * ЗАПУСК на стенде (порт 8140 должен быть свободен — то есть ни одной живой
 * встречи Meet в этот момент):
 *
 *   cd ~/spirits_back && NODE_PATH=$PWD/node_modules \
 *     node ~/zoom-spike.cjs "https://us05web.zoom.us/j/123456789?pwd=xxxx"
 *
 * Zoom требует приложения в Marketplace: client_id и client_secret вписываются
 * в Attendee (проект → credentials, тип Zoom OAuth). Без них
 * `bot_controller.get_zoom_oauth_credentials()` бросает исключение, и бот
 * падает ещё до входа. Неопубликованное приложение пускает бота только во
 * встречи ТОГО ЖЕ аккаунта Zoom — для проверки этого достаточно.
 */

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.ATTENDEE_WS_PORT || 8140);
const PUBLIC_BASE = process.env.ATTENDEE_WS_PUBLIC_BASE || 'wss://test.linkeon.io';
const SAMPLE_RATE = 24_000;          // как в проде: родная частота Realtime
const TONE_AFTER_MS = 12_000;        // после входа боту нужно время на вход
const TONE_MS = 3_000;
const TONE_HZ = 440;

const meetingUrl = process.argv[2];
if (!meetingUrl) {
  console.error('нужна ссылка на встречу Zoom');
  process.exit(1);
}

const base = (process.env.ATTENDEE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const key = process.env.ATTENDEE_API_KEY;
if (!key) {
  console.error('нет ATTENDEE_API_KEY в окружении');
  process.exit(1);
}

const callId = `zoom-spike-${Date.now()}`;
const stats = { chunks: 0, bytes: 0, firstAt: 0, rmsMax: 0, rmsLast: 0, rate: 0 };
let sock = null;
let botId = null;

/** RMS куска: отличает живой звук от ровной тишины. */
function rms(buf) {
  let sum = 0;
  const n = buf.byteLength >> 1;
  if (!n) return 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

const wss = new WebSocketServer({ port: PORT });
wss.on('error', (e) => console.error('[ws] ошибка сервера', e.message));
wss.on('listening', () => {
  console.log(`[ws] слушаю :${PORT}, адрес для Attendee: ${PUBLIC_BASE}/attendee/${PORT}?callId=${callId}`);
  createBot();
});

wss.on('connection', (ws) => {
  sock = ws;
  console.log('[ws] Attendee подключился');
  ws.on('error', (e) => console.error('[ws] ошибка сокета', e.message));
  ws.on('close', () => { console.log('[ws] соединение закрыто'); sock = null; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.trigger !== 'realtime_audio.mixed' || !msg?.data?.chunk) {
      console.log('[ws] сообщение не про звук:', JSON.stringify(msg).slice(0, 160));
      return;
    }
    const buf = Buffer.from(msg.data.chunk, 'base64');
    if (!stats.chunks) {
      stats.firstAt = Date.now();
      stats.rate = msg.data.sample_rate;
      console.log(`[звук] первый кусок: ${buf.byteLength} байт, ${msg.data.sample_rate} Гц`);
    }
    stats.chunks++;
    stats.bytes += buf.byteLength;
    stats.rmsLast = rms(buf);
    if (stats.rmsLast > stats.rmsMax) stats.rmsMax = stats.rmsLast;
  });

  setTimeout(sendTone, TONE_AFTER_MS);
});

/** Тон во встречу: проверка исходящего пути, которую на Meet пришлось делать людьми. */
function sendTone() {
  if (!sock || sock.readyState !== sock.OPEN) {
    console.log('[тон] соединения нет — пропускаю');
    return;
  }
  const frame = 480;                 // 20 мс при 24 кГц
  const frames = Math.round(TONE_MS / 20);
  console.log(`[тон] отправляю ${TONE_HZ} Гц, ${TONE_MS / 1000}с`);
  let sent = 0;
  const timer = setInterval(() => {
    if (!sock || sock.readyState !== sock.OPEN || sent >= frames) {
      clearInterval(timer);
      if (sent >= frames) console.log(`[тон] отправлено кадров: ${sent}`);
      return;
    }
    const pcm = Buffer.alloc(frame * 2);
    for (let i = 0; i < frame; i++) {
      const t = (sent * frame + i) / SAMPLE_RATE;
      pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * TONE_HZ * t) * 0.3 * 32767), i * 2);
    }
    sock.send(JSON.stringify({
      trigger: 'realtime_audio.bot_output',
      data: { chunk: pcm.toString('base64'), sample_rate: SAMPLE_RATE },
    }));
    sent++;
  }, 20);
}

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
  });
  let data = null;
  try { data = await res.json(); } catch { /* тела может не быть */ }
  return { status: res.status, data };
}

async function createBot() {
  // Настройки — как в проде (см. attendee.client.ts), плюс zoom_settings.
  // Адаптер: native по умолчанию. Веб-адаптер (`sdk: 'web'`) тоже требует
  // credentials Marketplace, так что выбор между ними — не про доступ, а про
  // способ транскрипции; для нас важен только звук.
  const r = await api('/api/v1/bots', {
    method: 'POST',
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: 'Роман · ассистент (спайк)',
      metadata: { callId },
      websocket_settings: {
        audio: { url: `${PUBLIC_BASE}/attendee/${PORT}?callId=${callId}`, sample_rate: SAMPLE_RATE },
      },
      recording_settings: { format: 'none' },
      automatic_leave_settings: {
        only_participant_in_meeting_timeout_seconds: 300,
        silence_timeout_seconds: 1800,
        max_uptime_seconds: 1200,
      },
      ...(process.env.ZOOM_SDK === 'web' ? { zoom_settings: { sdk: 'web' } } : {}),
    }),
  });
  if (r.status < 200 || r.status >= 300) {
    console.error(`[bot] создать не удалось: HTTP ${r.status}`, JSON.stringify(r.data).slice(0, 400));
    process.exit(1);
  }
  botId = r.data.id;
  console.log(`[bot] создан ${botId}, состояние ${r.data.state}`);
}

// Опрос состояния: без вебхуков (их подпись — забота бэкенда, спайку не нужна).
let lastState = '';
setInterval(async () => {
  if (botId) {
    const r = await api(`/api/v1/bots/${botId}`);
    const st = r.data?.state ?? `HTTP ${r.status}`;
    if (st !== lastState) {
      lastState = st;
      console.log(`[bot] состояние: ${st}`);
      if (['ended', 'fatal_error', 'data_deleted'].includes(st)) {
        console.log('[bot] терминальное состояние — выхожу');
        summary();
        process.exit(0);
      }
    }
  }
  const since = stats.firstAt ? ((Date.now() - stats.firstAt) / 1000).toFixed(0) : '—';
  console.log(
    `[звук] кусков: ${stats.chunks}, байт: ${stats.bytes}, ${stats.rate || '—'} Гц, ` +
    `RMS сейчас ${stats.rmsLast.toFixed(4)} / макс ${stats.rmsMax.toFixed(4)}, секунд с первого куска: ${since}`,
  );
}, 5_000);

function summary() {
  console.log('=== ИТОГ ===');
  console.log(`кусков звука: ${stats.chunks}, частота: ${stats.rate || 'нет'}`);
  console.log(`RMS максимум: ${stats.rmsMax.toFixed(4)} — ${stats.rmsMax > 0.001 ? 'звук ЖИВОЙ' : 'ТИШИНА'}`);
}

process.on('SIGINT', async () => {
  console.log('\n[bot] убираю бота');
  if (botId) await api(`/api/v1/bots/${botId}/leave`, { method: 'POST' }).catch(() => {});
  summary();
  process.exit(0);
});
